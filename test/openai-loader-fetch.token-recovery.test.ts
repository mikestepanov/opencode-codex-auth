import { afterEach, describe, expect, it, vi } from "vitest"

import { createOpenAIFetchHandler } from "../lib/codex-native/openai-loader-fetch"
import { createFetchOrchestratorState } from "../lib/fetch-orchestrator"
import { defaultAuthPath } from "../lib/paths"
import { createStickySessionState } from "../lib/rotation"
import { ensureOpenAIOAuthDomain, loadAuthStorage, saveAuthStorage } from "../lib/storage"
import { resetStubbedGlobals, stubGlobalForTest } from "./helpers/mock-policy"

const IDENTITY = "acc_123|user@example.com|plus"

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.OPENCODE_OPENAI_MULTI_RECOVERY_RANK
  resetStubbedGlobals()
})

describe("openai loader reactive token recovery", () => {
  it("refreshes a locally valid token after backend token_expired and retries the request", async () => {
    process.env.OPENCODE_OPENAI_MULTI_RECOVERY_RANK = "0"
    const authPath = defaultAuthPath()
    await saveAuthStorage(authPath, () => ({
      openai: {
        type: "oauth",
        accounts: [
          {
            identityKey: IDENTITY,
            accountId: "acc_123",
            email: "user@example.com",
            plan: "plus",
            authTypes: ["native"],
            enabled: true,
            access: "at_old",
            refresh: "rt_old",
            expires: Date.now() + 60 * 60 * 1000
          }
        ]
      }
    }))

    const backendAuth: string[] = []
    let refreshCalls = 0
    stubGlobalForTest(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init)
        if (request.url === "https://auth.openai.com/oauth/token") {
          refreshCalls += 1
          const body = await request.text()
          expect(body).toContain("refresh_token=rt_old")
          return Response.json({ access_token: "at_new", refresh_token: "rt_new", expires_in: 3600 })
        }
        if (request.url === "https://chatgpt.com/backend-api/codex/responses") {
          backendAuth.push(request.headers.get("authorization") ?? "")
          return backendAuth.length === 1
            ? Response.json({ error: { code: "token_expired" } }, { status: 401 })
            : Response.json({ ok: true }, { status: 200 })
        }
        return Response.json({}, { status: 200 })
      })
    )

    const handler = createOpenAIFetchHandler({
      authMode: "native",
      spoofMode: "native",
      remapDeveloperMessagesToUserEnabled: false,
      quietMode: true,
      pidOffsetEnabled: false,
      configuredRotationStrategy: "sticky",
      headerTransformDebug: false,
      compatInputSanitizerEnabled: false,
      requestSnapshots: {
        captureRequest: async () => {},
        captureResponse: async () => {}
      },
      sessionAffinityState: {
        orchestratorState: createFetchOrchestratorState(),
        stickySessionState: createStickySessionState(),
        hybridSessionState: createStickySessionState(),
        persistSessionAffinityState: () => {}
      },
      getCatalogModels: () => undefined,
      syncCatalogFromAuth: async () => undefined,
      setCooldown: async () => {},
      showToast: async () => {}
    })

    const response = await handler("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", session_id: "ses_token_recovery" },
      body: JSON.stringify({ model: "gpt-5.4-mini", input: "hello" })
    })

    expect(response.status).toBe(200)
    expect(backendAuth).toEqual(["Bearer at_old", "Bearer at_new"])
    expect(refreshCalls).toBe(1)
    const stored = await loadAuthStorage(authPath)
    const account = ensureOpenAIOAuthDomain(stored, "native").accounts.find(
      (candidate) => candidate.identityKey === IDENTITY
    )
    expect(account?.access).toBe("at_new")
    expect(account?.refresh).toBe("rt_new")
    expect(account?.enabled).toBe(true)
  })

  it("fails over without quota work when recovery has no token and fallback returns unrelated 401", async () => {
    process.env.OPENCODE_OPENAI_MULTI_RECOVERY_RANK = "0"
    const authPath = defaultAuthPath()
    const fallbackIdentity = "acc_456|fallback@example.com|plus"
    await saveAuthStorage(authPath, () => ({
      openai: {
        type: "oauth",
        strategy: "round_robin",
        activeIdentityKey: fallbackIdentity,
        accounts: [
          {
            identityKey: IDENTITY,
            accountId: "acc_123",
            email: "user@example.com",
            plan: "plus",
            authTypes: ["native"],
            enabled: true,
            access: "at_old",
            refresh: "rt_old",
            expires: Date.now() + 60 * 60 * 1000
          },
          {
            identityKey: fallbackIdentity,
            accountId: "acc_456",
            email: "fallback@example.com",
            plan: "plus",
            authTypes: ["native"],
            enabled: true,
            access: "at_fallback",
            refresh: "rt_fallback",
            expires: Date.now() + 60 * 60 * 1000
          }
        ]
      }
    }))

    const backendAuth: string[] = []
    let quotaCalls = 0
    let refreshCalls = 0
    let fastRecoveryTimers = false
    const realSetTimeout = globalThis.setTimeout
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (fastRecoveryTimers && delay === 250) {
        queueMicrotask(() => callback(...args))
        return 0
      }
      return realSetTimeout(callback, delay, ...args)
    }) as typeof setTimeout)
    stubGlobalForTest(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init)
        if (request.url === "https://auth.openai.com/oauth/token") {
          refreshCalls += 1
          fastRecoveryTimers = true
          return Response.json({ error: "invalid_grant" }, { status: 401 })
        }
        if (request.url === "https://chatgpt.com/backend-api/wham/usage") {
          quotaCalls += 1
          return Response.json({})
        }
        if (request.url === "https://chatgpt.com/backend-api/codex/responses") {
          const authorization = request.headers.get("authorization") ?? ""
          backendAuth.push(authorization)
          if (authorization === "Bearer at_old") {
            return Response.json({ error: { code: "token_expired" } }, { status: 401 })
          }
          return Response.json({ error: { code: "permission_denied" } }, { status: 401 })
        }
        return Response.json({}, { status: 200 })
      })
    )

    const handler = createOpenAIFetchHandler({
      authMode: "native",
      spoofMode: "native",
      remapDeveloperMessagesToUserEnabled: false,
      quietMode: true,
      pidOffsetEnabled: false,
      configuredRotationStrategy: "round_robin",
      headerTransformDebug: false,
      compatInputSanitizerEnabled: false,
      requestSnapshots: { captureRequest: async () => {}, captureResponse: async () => {} },
      sessionAffinityState: {
        orchestratorState: createFetchOrchestratorState(),
        stickySessionState: createStickySessionState(),
        hybridSessionState: createStickySessionState(),
        persistSessionAffinityState: () => {}
      },
      getCatalogModels: () => undefined,
      syncCatalogFromAuth: async () => undefined,
      setCooldown: async () => {},
      showToast: async () => {}
    })

    const response = await handler("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", session_id: "ses_token_failover" },
      body: JSON.stringify({ model: "gpt-5.4-mini", input: "hello" })
    })

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: { code: "permission_denied" } })
    expect(backendAuth).toEqual(["Bearer at_old", "Bearer at_fallback"])
    expect(refreshCalls).toBe(1)
    expect(quotaCalls).toBe(0)
  })
})
