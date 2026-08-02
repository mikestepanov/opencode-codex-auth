import { afterEach, describe, expect, it, vi } from "vitest"
import { FetchOrchestrator } from "../lib/fetch-orchestrator"
import { PluginFatalError } from "../lib/fatal-errors"
import { resetStubbedGlobals, stubGlobalForTest } from "./helpers/mock-policy"

afterEach(() => {
  resetStubbedGlobals()
})

describe("FetchOrchestrator retries", () => {
  it("refreshes and retries one exact token-expired response", async () => {
    const oldAuth = { access: "access-old", identityKey: "id1", accountId: "acc1" }
    const newAuth = { access: "access-new", identityKey: "id1", accountId: "acc1" }
    const acquireAuth = vi.fn(async () => oldAuth)
    const recoverTokenExpired = vi.fn(async () => newAuth)
    const setCooldown = vi.fn<(identityKey: string, cooldownUntil: number) => Promise<void>>(async () => {})
    const attempts: string[] = []
    stubGlobalForTest(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        attempts.push(request.headers.get("authorization") ?? "")
        return attempts.length === 1
          ? new Response(JSON.stringify({ error: { code: "token_expired" } }), { status: 401 })
          : new Response("OK", { status: 200 })
      })
    )

    const result = await new FetchOrchestrator({
      acquireAuth,
      recoverTokenExpired,
      setCooldown,
      maxAttempts: 2
    }).execute("https://api.openai.com/v1/responses", { method: "POST", body: "payload" })

    expect(result.status).toBe(200)
    expect(attempts).toEqual(["Bearer access-old", "Bearer access-new"])
    expect(recoverTokenExpired).toHaveBeenCalledTimes(1)
    expect(acquireAuth).toHaveBeenCalledTimes(1)
    expect(setCooldown).not.toHaveBeenCalled()
  })

  it("fails over after token refresh cannot recover", async () => {
    const auths = [
      { access: "access-old", identityKey: "id1", accountId: "acc1" },
      { access: "access-fallback", identityKey: "id2", accountId: "acc2" }
    ]
    let authIndex = 0
    const acquireAuth = vi.fn(async () => auths[authIndex++]!)
    const recoverTokenExpired = vi.fn(async () => undefined)
    const setCooldown = vi.fn<(identityKey: string, cooldownUntil: number) => Promise<void>>(async () => {})
    const attempts: string[] = []
    stubGlobalForTest(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        attempts.push(request.headers.get("authorization") ?? "")
        return attempts.length === 1
          ? new Response(JSON.stringify({ detail: { code: "token_expired" } }), { status: 401 })
          : new Response("OK", { status: 200 })
      })
    )

    const result = await new FetchOrchestrator({
      acquireAuth,
      recoverTokenExpired,
      setCooldown,
      now: () => 1_000,
      maxAttempts: 2
    }).execute("https://api.openai.com/v1/responses")

    expect(result.status).toBe(200)
    expect(attempts).toEqual(["Bearer access-old", "Bearer access-fallback"])
    expect(setCooldown).not.toHaveBeenCalled()
    expect(acquireAuth).toHaveBeenLastCalledWith({ sessionKey: null, avoidIdentityKeys: ["id1"] })
  })

  it("allows only one refresh and one failover after repeated token-expired responses", async () => {
    const auths = [
      { access: "access-old", identityKey: "id1" },
      { access: "access-fallback", identityKey: "id2" }
    ]
    let authIndex = 0
    const acquireAuth = vi.fn(async () => auths[Math.min(authIndex++, auths.length - 1)]!)
    const recoverTokenExpired = vi.fn(async () => ({ access: "access-refreshed", identityKey: "id1" }))
    const setCooldown = vi.fn<(identityKey: string, cooldownUntil: number) => Promise<void>>(async () => {})
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ error: { code: "token_expired" } }), { status: 401 })
    )
    stubGlobalForTest("fetch", fetchMock)

    const result = await new FetchOrchestrator({
      acquireAuth,
      recoverTokenExpired,
      setCooldown,
      maxAttempts: 3
    }).execute("https://api.openai.com/v1/responses")

    expect(result.status).toBe(401)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(recoverTokenExpired).toHaveBeenCalledTimes(1)
  })

  it("returns the second token-expired response when no fallback account exists", async () => {
    let acquireCount = 0
    const acquireAuth = vi.fn(async () => {
      acquireCount += 1
      if (acquireCount === 1) return { access: "access-old", identityKey: "id1" }
      throw new PluginFatalError({
        message: "No fallback account",
        status: 403,
        type: "no_enabled_accounts",
        param: "accounts"
      })
    })
    const recoverTokenExpired = vi.fn(async () => ({ access: "access-refreshed", identityKey: "id1" }))
    const setCooldown = vi.fn<(identityKey: string, cooldownUntil: number) => Promise<void>>(async () => {})
    const fetchMock = vi.fn(async () =>
      Response.json({ error: { code: "token_expired" } }, { status: 401, headers: { "x-attempt": "upstream" } })
    )
    stubGlobalForTest("fetch", fetchMock)

    const result = await new FetchOrchestrator({
      acquireAuth,
      recoverTokenExpired,
      setCooldown,
      maxAttempts: 3
    }).execute("https://api.openai.com/v1/responses")

    expect(result.status).toBe(401)
    expect(result.headers.get("x-attempt")).toBe("upstream")
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(recoverTokenExpired).toHaveBeenCalledTimes(1)
  })

  it("preserves token-expired response when fallback accounts are unavailable", async () => {
    let acquireCount = 0
    const acquireAuth = vi.fn(async () => {
      acquireCount += 1
      if (acquireCount === 1) return { access: "access-old", identityKey: "id1" }
      throw new PluginFatalError({
        message: "All fallback accounts are cooling down",
        status: 429,
        type: "all_accounts_cooling_down",
        param: "accounts"
      })
    })
    const recoverTokenExpired = vi.fn(async () => undefined)
    const setCooldown = vi.fn<(identityKey: string, cooldownUntil: number) => Promise<void>>(async () => {})
    const fetchMock = vi.fn(async () =>
      Response.json({ error: { code: "token_expired" } }, { status: 401, headers: { "x-upstream-error": "preserved" } })
    )
    stubGlobalForTest("fetch", fetchMock)

    const result = await new FetchOrchestrator({ acquireAuth, recoverTokenExpired, setCooldown }).execute(
      "https://api.openai.com/v1/responses"
    )

    expect(result.status).toBe(401)
    expect(result.headers.get("x-upstream-error")).toBe("preserved")
    await expect(result.json()).resolves.toEqual({ error: { code: "token_expired" } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("returns unrelated 401 responses without retrying", async () => {
    const acquireAuth = vi.fn(async () => ({ access: "access", identityKey: "id1" }))
    const recoverTokenExpired = vi.fn(async () => ({ access: "unused", identityKey: "id1" }))
    const setCooldown = vi.fn<(identityKey: string, cooldownUntil: number) => Promise<void>>(async () => {})
    const response = new Response(JSON.stringify({ error: { code: "permission_denied" } }), {
      status: 401,
      headers: { "x-test": "preserved" }
    })
    const fetchMock = vi.fn(async () => response)
    stubGlobalForTest("fetch", fetchMock)

    const result = await new FetchOrchestrator({ acquireAuth, recoverTokenExpired, setCooldown }).execute(
      "https://api.openai.com/v1/responses"
    )

    expect(result.status).toBe(401)
    expect(result.headers.get("x-test")).toBe("preserved")
    await expect(result.json()).resolves.toEqual({ error: { code: "permission_denied" } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(recoverTokenExpired).not.toHaveBeenCalled()
  })

  it("retries with different account after 429", async () => {
    const auths = [
      { access: "access1", identityKey: "id1", accountId: "acc1" },
      { access: "access2", identityKey: "id2", accountId: "acc2" }
    ]
    let authIdx = 0
    const acquireAuth = vi.fn(async () => {
      const next = auths[authIdx++]
      if (!next) throw new Error("missing auth")
      return next
    })
    const setCooldown = vi.fn<(identityKey: string, cooldownUntil: number) => Promise<void>>(async () => {})

    let fetchCount = 0
    stubGlobalForTest(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCount++
        const req = new Request(input, init)
        const auth = req.headers.get("authorization")

        if (fetchCount === 1) {
          expect(auth).toBe("Bearer access1")
          expect(req.headers.get("ChatGPT-Account-Id")).toBe("acc1")
          return new Response("Too Many Requests", {
            status: 429,
            headers: { "Retry-After": "10" }
          })
        }

        expect(auth).toBe("Bearer access2")
        expect(req.headers.get("ChatGPT-Account-Id")).toBe("acc2")
        return new Response("OK", { status: 200 })
      })
    )

    const orch = new FetchOrchestrator({
      acquireAuth,
      setCooldown,
      now: () => 1000,
      maxAttempts: 2
    })

    const res = await orch.execute("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ test: true })
    })

    expect(res.status).toBe(200)
    expect(fetchCount).toBe(2)
    expect(acquireAuth).toHaveBeenCalledTimes(2)
    expect(setCooldown).toHaveBeenCalledWith("id1", 11000) // 1000 + 10 * 1000
  })

  it("applies fallback cooldown when 429 has no retry-after header", async () => {
    const auths = [
      { access: "access1", identityKey: "id1", accountId: "acc1" },
      { access: "access2", identityKey: "id2", accountId: "acc2" }
    ]
    let authIdx = 0
    const acquireAuth = vi.fn(async () => auths[authIdx++])
    const setCooldown = vi.fn<(identityKey: string, cooldownUntil: number) => Promise<void>>(async () => {})

    let fetchCount = 0
    stubGlobalForTest(
      "fetch",
      vi.fn(async () => {
        fetchCount++
        if (fetchCount === 1) {
          return new Response("Too Many Requests", { status: 429 })
        }
        return new Response("OK", { status: 200 })
      })
    )

    const orch = new FetchOrchestrator({
      acquireAuth,
      setCooldown,
      now: () => 1000,
      maxAttempts: 2
    })

    const res = await orch.execute("https://api.openai.com/v1/chat/completions")
    expect(res.status).toBe(200)
    expect(fetchCount).toBe(2)
    expect(setCooldown).toHaveBeenCalledWith("id1", 6000)
  })

  it("continues retry flow when setCooldown throws", async () => {
    const auths = [
      { access: "access1", identityKey: "id1", accountId: "acc1" },
      { access: "access2", identityKey: "id2", accountId: "acc2" }
    ]
    let authIdx = 0
    const acquireAuth = vi.fn(async () => auths[authIdx++])
    const setCooldown = vi.fn<(identityKey: string, cooldownUntil: number) => Promise<void>>(async () => {
      throw new Error("disk write failed")
    })

    let fetchCount = 0
    stubGlobalForTest(
      "fetch",
      vi.fn(async () => {
        fetchCount += 1
        if (fetchCount === 1) {
          return new Response("Too Many Requests", { status: 429, headers: { "Retry-After": "1" } })
        }
        return new Response("OK", { status: 200 })
      })
    )

    const orch = new FetchOrchestrator({
      acquireAuth,
      setCooldown,
      now: () => 1_000,
      maxAttempts: 2
    })

    const res = await orch.execute("https://api.openai.com/v1/chat/completions")
    expect(res.status).toBe(200)
    expect(acquireAuth).toHaveBeenCalledTimes(2)
    expect(setCooldown).toHaveBeenCalledTimes(1)
  })

  it("stops after maxAttempts", async () => {
    const acquireAuth = vi.fn(async () => ({ access: "a", identityKey: "i" }))
    const setCooldown = vi.fn<(identityKey: string, cooldownUntil: number) => Promise<void>>(async () => {})

    stubGlobalForTest(
      "fetch",
      vi.fn(async () => {
        return new Response("RL", { status: 429, headers: { "Retry-After": "1" } })
      })
    )

    const orch = new FetchOrchestrator({
      acquireAuth,
      setCooldown,
      now: () => 1000,
      maxAttempts: 3
    })

    const res = await orch.execute("https://api.openai.com/v1/chat/completions")
    expect(res.status).toBe(429)
    expect(acquireAuth).toHaveBeenCalledTimes(3)
    const body = (await res.json()) as { error?: { type?: string } }
    expect(body.error?.type).toBe("all_accounts_rate_limited")
  })

  it("clamps maxAttempts to at least one attempt", async () => {
    const acquireAuth = vi.fn(async () => ({ access: "a", identityKey: "i" }))
    const setCooldown = vi.fn<(identityKey: string, cooldownUntil: number) => Promise<void>>(async () => {})
    const fetchMock = vi.fn(async () => new Response("RL", { status: 429 }))
    stubGlobalForTest("fetch", fetchMock)

    const orch = new FetchOrchestrator({
      acquireAuth,
      setCooldown,
      maxAttempts: 0
    })

    const res = await orch.execute("https://api.openai.com/v1/chat/completions")
    expect(res.status).toBe(429)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(acquireAuth).toHaveBeenCalledTimes(1)
  })

  it("falls back to default attempts when maxAttempts is NaN", async () => {
    const acquireAuth = vi.fn(async () => ({ access: "a", identityKey: "i" }))
    const setCooldown = vi.fn<(identityKey: string, cooldownUntil: number) => Promise<void>>(async () => {})
    const fetchMock = vi.fn(async () => new Response("RL", { status: 429 }))
    stubGlobalForTest("fetch", fetchMock)

    const orch = new FetchOrchestrator({
      acquireAuth,
      setCooldown,
      maxAttempts: Number.NaN
    })

    const res = await orch.execute("https://api.openai.com/v1/chat/completions")
    expect(res.status).toBe(429)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(acquireAuth).toHaveBeenCalledTimes(3)
  })

  it("falls back to default attempts when maxAttempts is infinite", async () => {
    const acquireAuth = vi.fn(async () => ({ access: "a", identityKey: "i" }))
    const setCooldown = vi.fn<(identityKey: string, cooldownUntil: number) => Promise<void>>(async () => {})
    const fetchMock = vi.fn(async () => {
      if (fetchMock.mock.calls.length > 10) {
        throw new Error("unexpected unbounded retry")
      }
      return new Response("RL", { status: 429 })
    })
    stubGlobalForTest("fetch", fetchMock)

    const orch = new FetchOrchestrator({
      acquireAuth,
      setCooldown,
      maxAttempts: Number.POSITIVE_INFINITY
    })

    const res = await orch.execute("https://api.openai.com/v1/chat/completions")
    expect(res.status).toBe(429)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(acquireAuth).toHaveBeenCalledTimes(3)
  })

  it("retries successfully when body is a ReadableStream", async () => {
    const acquireAuth = vi.fn(async () => ({ access: "a", identityKey: "i" }))
    const setCooldown = vi.fn<(identityKey: string, cooldownUntil: number) => Promise<void>>(async () => {})

    let fetchCount = 0
    stubGlobalForTest(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCount++
        const req = new Request(input, init)
        // Consume the body to ensure it's "used"
        await req.text()

        if (fetchCount === 1) {
          return new Response("RL", { status: 429 })
        }
        return new Response("OK", { status: 200 })
      })
    )

    const orch = new FetchOrchestrator({
      acquireAuth,
      setCooldown,
      maxAttempts: 2
    })

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("test stream"))
        controller.close()
      }
    })

    const res = await orch.execute("https://api.com", {
      method: "POST",
      body: stream,
      // @ts-ignore - duplex is required for stream body in some environments
      duplex: "half"
    })

    expect(res.status).toBe(200)
    expect(fetchCount).toBe(2)
  })

  it("uses a consistent 'now' timestamp for Retry-After calculations", async () => {
    const acquireAuth = vi.fn(async () => ({ access: "a", identityKey: "id1" }))
    const setCooldown = vi.fn<(identityKey: string, cooldownUntil: number) => Promise<void>>(async () => {})

    stubGlobalForTest(
      "fetch",
      vi.fn(async () => {
        return new Response("RL", {
          status: 429,
          headers: { "Retry-After": "Wed, 21 Oct 2015 07:28:00 GMT" }
        })
      })
    )

    let nowCalls = 0
    const nowStubs = [1000, 2000, 3000]
    const now = vi.fn(() => nowStubs[nowCalls++])

    const orch = new FetchOrchestrator({
      acquireAuth,
      setCooldown,
      now,
      maxAttempts: 1
    })

    await orch.execute("https://api.com")

    const expectedDateMs = new Date("Wed, 21 Oct 2015 07:28:00 GMT").getTime()
    expect(setCooldown).toHaveBeenCalledTimes(1)
    const args = setCooldown.mock.calls[0]
    expect(args?.[0]).toBe("id1")
    const cooldownUntil = args?.[1]
    expect(cooldownUntil).toBe(expectedDateMs)
  })
})
