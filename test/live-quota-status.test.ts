import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"

import { collectLiveQuotaStatus, limitsIndicateAvailability } from "../lib/live-quota-status"
import { ensureOpenAIOAuthDomain, loadAuthStorage, saveAuthStorage } from "../lib/storage"

const IDENTITY = "acc_123|user@example.com|pro"

async function seedAccount(authPath: string): Promise<void> {
  await saveAuthStorage(authPath, () => ({
    openai: {
      type: "oauth",
      accounts: [
        {
          identityKey: IDENTITY,
          accountId: "acc_123",
          email: "user@example.com",
          plan: "pro",
          authTypes: ["native"],
          enabled: true,
          access: "at_old",
          refresh: "rt_old",
          expires: Date.now() + 3_600_000,
          cooldownUntil: Date.now() + 86_400_000
        }
      ]
    }
  }))
}

describe("live quota status", () => {
  it("recovers an exact token_expired response for a cooling account and retries once", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-live-status-"))
    const authPath = path.join(dir, "codex-accounts.json")
    const snapshotsPath = path.join(dir, "codex-snapshots.json")
    await seedAccount(authPath)
    const requests: string[] = []
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization") ?? ""
      requests.push(authorization)
      return authorization === "Bearer at_old"
        ? Response.json({ error: { code: "token_expired" } }, { status: 401 })
        : Response.json({ rate_limit: { primary_window: { used_percent: 25, reset_at: 1_800_000_000 } } })
    })

    const records = await collectLiveQuotaStatus({
      authPath,
      snapshotsPath,
      fetchImpl: fetchImpl as typeof fetch,
      recover: async ({ failedAuth }) => {
        await saveAuthStorage(authPath, (auth) => {
          const account = ensureOpenAIOAuthDomain(auth, "native").accounts[0]
          if (account) {
            account.access = "at_new"
            account.refresh = "rt_new"
            delete account.cooldownUntil
          }
        })
        return { ...failedAuth, access: "at_new" }
      }
    })

    expect(requests).toEqual(["Bearer at_old", "Bearer at_new"])
    expect(records).toEqual([expect.objectContaining({ account: "user@example.com", enabled: true, status: "ok" })])
    expect(records[0]?.limits).toEqual([{ name: "requests", leftPct: 75, resetsAt: 1_800_000_000_000 }])
    const stored = await loadAuthStorage(authPath)
    expect(ensureOpenAIOAuthDomain(stored, "native").accounts[0]?.cooldownUntil).toBeUndefined()
  })

  it("does not recover unrelated authentication failures or expose credentials", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-live-status-"))
    const authPath = path.join(dir, "codex-accounts.json")
    await seedAccount(authPath)
    const recover = vi.fn()

    const records = await collectLiveQuotaStatus({
      authPath,
      fetchImpl: vi.fn(async () => Response.json({ error: { code: "permission_denied" } }, { status: 401 })),
      recover
    })

    expect(recover).not.toHaveBeenCalled()
    expect(records[0]).toEqual(expect.objectContaining({ status: "unavailable", httpStatus: 401 }))
    const serialized = JSON.stringify(records)
    expect(serialized).not.toContain("at_old")
    expect(serialized).not.toContain("rt_old")
    expect(serialized).not.toContain("acc_123")
  })

  it("isolates account failures and classifies a rejected retry", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-live-status-"))
    const authPath = path.join(dir, "codex-accounts.json")
    await seedAccount(authPath)
    await saveAuthStorage(authPath, (auth) => {
      ensureOpenAIOAuthDomain(auth, "native").accounts.push({
        identityKey: "acc_456|healthy@example.com|pro",
        accountId: "acc_456",
        email: "healthy@example.com",
        plan: "pro",
        enabled: true,
        access: "at_healthy",
        refresh: "rt_healthy",
        expires: Date.now() + 3_600_000
      })
    })

    const records = await collectLiveQuotaStatus({
      authPath,
      snapshotsPath: path.join(dir, "codex-snapshots.json"),
      fetchImpl: vi.fn(async (_input, init) => {
        const authorization = new Headers(init?.headers).get("authorization")
        if (authorization === "Bearer at_healthy") {
          return Response.json({ rate_limit: { primary_window: { used_percent: 10 } } })
        }
        return Response.json({ error: { code: "token_expired" } }, { status: 401 })
      }),
      recover: async () => ({ access: "at_still_bad", identityKey: IDENTITY })
    })

    expect(records).toEqual([
      expect.objectContaining({ account: "user@example.com", status: "token_expired" }),
      expect.objectContaining({ account: "healthy@example.com", status: "ok" })
    ])
  })

  it("returns no records when the configured auth domain is absent", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-live-status-"))
    expect(await collectLiveQuotaStatus({ authPath: path.join(dir, "missing.json") })).toEqual([])
  })

  it("probes incomplete account identity without attempting unsafe recovery", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-live-status-"))
    const authPath = path.join(dir, "codex-accounts.json")
    await saveAuthStorage(authPath, () => ({
      openai: {
        type: "oauth",
        accounts: [{ email: "partial@example.com", enabled: true, access: "at_partial", refresh: "rt_partial" }]
      }
    }))
    const recover = vi.fn()

    const records = await collectLiveQuotaStatus({
      authPath,
      fetchImpl: vi.fn(async () => Response.json({ error: { code: "token_expired" } }, { status: 401 })),
      recover
    })

    expect(records).toEqual([expect.objectContaining({ account: "partial@example.com", status: "token_expired" })])
    expect(recover).not.toHaveBeenCalled()
  })

  it("clears a stale quota cooldown when a fresh probe still has capacity", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-live-status-"))
    const authPath = path.join(dir, "codex-accounts.json")
    const snapshotsPath = path.join(dir, "codex-snapshots.json")
    const cooldownUntil = Date.now() + 86_400_000
    await saveAuthStorage(authPath, () => ({
      openai: {
        type: "oauth",
        accounts: [
          {
            identityKey: IDENTITY,
            accountId: "acc_123",
            email: "user@example.com",
            plan: "pro",
            authTypes: ["native"],
            enabled: true,
            access: "at_live",
            refresh: "rt_live",
            expires: Date.now() + 3_600_000,
            cooldownUntil
          }
        ]
      }
    }))

    const records = await collectLiveQuotaStatus({
      authPath,
      snapshotsPath,
      fetchImpl: vi.fn(async () =>
        Response.json({ rate_limit: { primary_window: { used_percent: 20, reset_at: 1_900_000_000 } } })
      )
    })

    expect(records[0]).toEqual(expect.objectContaining({ account: "user@example.com", status: "ok" }))
    expect(records[0]?.cooldownUntil).toBeUndefined()
    const stored = await loadAuthStorage(authPath)
    expect(ensureOpenAIOAuthDomain(stored, "native").accounts[0]?.cooldownUntil).toBeUndefined()
    const persisted = JSON.parse(await fs.readFile(snapshotsPath, "utf8"))
    expect(persisted[IDENTITY]?.limits?.[0]?.leftPct).toBe(80)
  })

  it("keeps the cooldown when a fresh probe is still exhausted", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-live-status-"))
    const authPath = path.join(dir, "codex-accounts.json")
    const snapshotsPath = path.join(dir, "codex-snapshots.json")
    const cooldownUntil = Date.now() + 86_400_000
    await saveAuthStorage(authPath, () => ({
      openai: {
        type: "oauth",
        accounts: [
          {
            identityKey: IDENTITY,
            accountId: "acc_123",
            email: "user@example.com",
            plan: "pro",
            authTypes: ["native"],
            enabled: true,
            access: "at_live",
            refresh: "rt_live",
            expires: Date.now() + 3_600_000,
            cooldownUntil
          }
        ]
      }
    }))

    const records = await collectLiveQuotaStatus({
      authPath,
      snapshotsPath,
      fetchImpl: vi.fn(async () =>
        Response.json({ rate_limit: { primary_window: { used_percent: 100, reset_at: 1_900_000_000 } } })
      )
    })

    expect(records[0]?.status).toBe("ok")
    expect(records[0]?.cooldownUntil).toBe(cooldownUntil)
    const stored = await loadAuthStorage(authPath)
    expect(ensureOpenAIOAuthDomain(stored, "native").accounts[0]?.cooldownUntil).toBe(cooldownUntil)
  })

  it("treats availability as every window retaining capacity", () => {
    expect(limitsIndicateAvailability([])).toBe(false)
    expect(limitsIndicateAvailability([{ name: "requests", leftPct: 1 }])).toBe(true)
    expect(limitsIndicateAvailability([{ name: "requests", leftPct: 0 }])).toBe(false)
    expect(
      limitsIndicateAvailability([
        { name: "5h", leftPct: 50 },
        { name: "weekly", leftPct: 0 }
      ])
    ).toBe(false)
  })
})
