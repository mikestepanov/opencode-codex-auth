import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"

import { recoverExpiredOpenAIAuth } from "../lib/codex-native/reactive-refresh"
import { ensureOpenAIOAuthDomain, loadAuthStorage, saveAuthStorage } from "../lib/storage"
import type { AccountRecord } from "../lib/types"

const IDENTITY = "acc_123|user@example.com|plus"

async function seedAuth(authPath: string): Promise<void> {
  await saveAuthStorage(authPath, () => ({
    openai: {
      type: "oauth",
      accounts: [
        {
          identityKey: IDENTITY,
          accountId: "acc_123",
          email: "user@example.com",
          plan: "plus",
          enabled: true,
          access: "at_old",
          refresh: "rt_old",
          expires: 9_999
        }
      ]
    }
  }))
}

async function storedAccount(authPath: string): Promise<AccountRecord> {
  const stored = await loadAuthStorage(authPath)
  const domain = ensureOpenAIOAuthDomain(stored, "native")
  const account = domain.accounts.find((candidate) => candidate.identityKey === IDENTITY)
  if (!account) throw new Error("missing account")
  return account
}

describe("reactive token refresh convergence", () => {
  it("uses a peer-rotated generation without refreshing", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-reactive-refresh-"))
    const authPath = path.join(dir, "codex-accounts.json")
    await seedAuth(authPath)
    await saveAuthStorage(authPath, (auth) => {
      const account = ensureOpenAIOAuthDomain(auth, "native").accounts[0]
      if (account) {
        account.access = "at_peer"
        account.refresh = "rt_peer"
      }
    })
    const refresh = vi.fn()

    const recovered = await recoverExpiredOpenAIAuth({
      authMode: "native",
      failedAuth: { access: "at_old", identityKey: IDENTITY },
      authPath,
      recoveryDelayMs: 0,
      refresh
    })

    expect(recovered?.access).toBe("at_peer")
    expect(refresh).not.toHaveBeenCalled()
  })

  it("refreshes outside shared storage lock and atomically rotates tokens", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-reactive-refresh-"))
    const authPath = path.join(dir, "codex-accounts.json")
    await seedAuth(authPath)
    const refresh = vi.fn(async () => {
      await loadAuthStorage(authPath)
      return { access_token: "at_new", refresh_token: "rt_new", expires_in: 3600 }
    })

    const recovered = await recoverExpiredOpenAIAuth({
      authMode: "native",
      failedAuth: { access: "at_old", identityKey: IDENTITY },
      authPath,
      recoveryDelayMs: 0,
      now: () => 1_000,
      refresh
    })

    expect(recovered?.access).toBe("at_new")
    const account = await storedAccount(authPath)
    expect(account.access).toBe("at_new")
    expect(account.refresh).toBe("rt_new")
    expect(account.expires).toBe(3_601_000)
    expect(account.enabled).toBe(true)
  })

  it("persists a late refresh when no peer has taken over its expired lease", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-reactive-refresh-"))
    const authPath = path.join(dir, "codex-accounts.json")
    await seedAuth(authPath)
    let clock = 1_000

    const recovered = await recoverExpiredOpenAIAuth({
      authMode: "native",
      failedAuth: { access: "at_old", identityKey: IDENTITY },
      authPath,
      recoveryDelayMs: 0,
      now: () => clock,
      refresh: async () => {
        clock += 31_000
        return { access_token: "at_late", refresh_token: "rt_late", expires_in: 3600 }
      }
    })

    expect(recovered?.access).toBe("at_late")
    const account = await storedAccount(authPath)
    expect(account.access).toBe("at_late")
    expect(account.refresh).toBe("rt_late")
    expect(account.refreshLeaseUntil).toBeUndefined()
  })

  it("does not overwrite a peer generation that arrives during refresh", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-reactive-refresh-"))
    const authPath = path.join(dir, "codex-accounts.json")
    await seedAuth(authPath)

    const recovered = await recoverExpiredOpenAIAuth({
      authMode: "native",
      failedAuth: { access: "at_old", identityKey: IDENTITY },
      authPath,
      recoveryDelayMs: 0,
      refresh: async () => {
        await saveAuthStorage(authPath, (auth) => {
          const account = ensureOpenAIOAuthDomain(auth, "native").accounts[0]
          if (account) {
            account.access = "at_peer"
            account.refresh = "rt_peer"
          }
        })
        return { access_token: "at_stale", refresh_token: "rt_stale", expires_in: 3600 }
      }
    })

    expect(recovered?.access).toBe("at_peer")
    const account = await storedAccount(authPath)
    expect(account.access).toBe("at_peer")
    expect(account.refresh).toBe("rt_peer")
  })

  it("waits for peer convergence after invalid_grant without disabling the account", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-reactive-refresh-"))
    const authPath = path.join(dir, "codex-accounts.json")
    await seedAuth(authPath)
    let clock = 1_000
    let sleepCount = 0

    const recovered = await recoverExpiredOpenAIAuth({
      authMode: "native",
      failedAuth: { access: "at_old", identityKey: IDENTITY },
      authPath,
      recoveryDelayMs: 0,
      now: () => clock,
      convergenceWaitMs: 1_000,
      convergencePollMs: 100,
      sleep: async (ms) => {
        clock += ms
        sleepCount += 1
        if (sleepCount === 1) {
          await saveAuthStorage(authPath, (auth) => {
            const account = ensureOpenAIOAuthDomain(auth, "native").accounts[0]
            if (account) {
              account.access = "at_peer"
              account.refresh = "rt_peer"
            }
          })
        }
      },
      refresh: async () => {
        const error = new Error("Token refresh failed (invalid_grant)")
        ;(error as Error & { oauthCode?: string }).oauthCode = "invalid_grant"
        throw error
      }
    })

    expect(recovered?.access).toBe("at_peer")
    const account = await storedAccount(authPath)
    expect(account.enabled).toBe(true)
    expect(account.access).toBe("at_peer")
  })

  it("leaves the account enabled when invalid_grant has no converged peer generation", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-reactive-refresh-"))
    const authPath = path.join(dir, "codex-accounts.json")
    await seedAuth(authPath)

    const recovered = await recoverExpiredOpenAIAuth({
      authMode: "native",
      failedAuth: { access: "at_old", identityKey: IDENTITY },
      authPath,
      recoveryDelayMs: 0,
      convergenceWaitMs: 0,
      refresh: async () => {
        const error = new Error("Token refresh failed (invalid_grant)")
        ;(error as Error & { oauthCode?: string }).oauthCode = "invalid_grant"
        throw error
      }
    })

    expect(recovered).toBeUndefined()
    const account = await storedAccount(authPath)
    expect(account.enabled).toBe(true)
    expect(account.access).toBe("at_old")
    expect(account.refresh).toBe("rt_old")
    expect(account.refreshLeaseUntil).toBeUndefined()
  })

  it("uses a peer generation that arrives during deterministic host staggering", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-reactive-refresh-"))
    const authPath = path.join(dir, "codex-accounts.json")
    await seedAuth(authPath)
    let sleepCount = 0
    const refresh = vi.fn()

    const recovered = await recoverExpiredOpenAIAuth({
      authMode: "native",
      failedAuth: { access: "at_old", identityKey: IDENTITY },
      authPath,
      recoveryDelayMs: 500,
      convergencePollMs: 250,
      sleep: async () => {
        sleepCount += 1
        if (sleepCount === 1) {
          await saveAuthStorage(authPath, (auth) => {
            const account = ensureOpenAIOAuthDomain(auth, "native").accounts[0]
            if (account) {
              account.access = "at_peer"
              account.refresh = "rt_peer"
            }
          })
        }
      },
      refresh
    })

    expect(recovered?.access).toBe("at_peer")
    expect(refresh).not.toHaveBeenCalled()
  })

  it("waits for an existing refresh lease instead of refreshing concurrently", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-reactive-refresh-"))
    const authPath = path.join(dir, "codex-accounts.json")
    await seedAuth(authPath)
    await saveAuthStorage(authPath, (auth) => {
      const account = ensureOpenAIOAuthDomain(auth, "native").accounts[0]
      if (account) account.refreshLeaseUntil = 1_200
    })
    let clock = 1_000
    let sleepCount = 0
    const refresh = vi.fn()

    const recovered = await recoverExpiredOpenAIAuth({
      authMode: "native",
      failedAuth: { access: "at_old", identityKey: IDENTITY },
      authPath,
      recoveryDelayMs: 0,
      now: () => clock,
      convergenceWaitMs: 1_000,
      convergencePollMs: 100,
      sleep: async (ms) => {
        clock += ms
        sleepCount += 1
        if (sleepCount === 1) {
          await saveAuthStorage(authPath, (auth) => {
            const account = ensureOpenAIOAuthDomain(auth, "native").accounts[0]
            if (account) {
              account.access = "at_peer"
              account.refresh = "rt_peer"
              delete account.refreshLeaseUntil
            }
          })
        }
      },
      refresh
    })

    expect(recovered?.access).toBe("at_peer")
    expect(refresh).not.toHaveBeenCalled()
  })

  it("takes over after an abandoned refresh lease expires", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-reactive-refresh-"))
    const authPath = path.join(dir, "codex-accounts.json")
    await seedAuth(authPath)
    await saveAuthStorage(authPath, (auth) => {
      const account = ensureOpenAIOAuthDomain(auth, "native").accounts[0]
      if (account) account.refreshLeaseUntil = 1_200
    })
    let clock = 1_000
    const refresh = vi.fn(async () => ({ access_token: "at_takeover", refresh_token: "rt_takeover", expires_in: 3600 }))

    const recovered = await recoverExpiredOpenAIAuth({
      authMode: "native",
      failedAuth: { access: "at_old", identityKey: IDENTITY },
      authPath,
      recoveryDelayMs: 0,
      now: () => clock,
      convergenceWaitMs: 1_000,
      convergencePollMs: 100,
      sleep: async (ms) => {
        clock += ms
      },
      refresh
    })

    expect(recovered?.access).toBe("at_takeover")
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("does not wait beyond the convergence budget for a long refresh lease", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-reactive-refresh-"))
    const authPath = path.join(dir, "codex-accounts.json")
    await seedAuth(authPath)
    await saveAuthStorage(authPath, (auth) => {
      const account = ensureOpenAIOAuthDomain(auth, "native").accounts[0]
      if (account) account.refreshLeaseUntil = 121_000
    })
    let clock = 1_000
    let sleptMs = 0
    const refresh = vi.fn()

    const recovered = await recoverExpiredOpenAIAuth({
      authMode: "native",
      failedAuth: { access: "at_old", identityKey: IDENTITY },
      authPath,
      recoveryDelayMs: 0,
      now: () => clock,
      convergenceWaitMs: 500,
      convergencePollMs: 100,
      sleep: async (ms) => {
        clock += ms
        sleptMs += ms
      },
      refresh
    })

    expect(recovered).toBeUndefined()
    expect(sleptMs).toBe(500)
    expect(refresh).not.toHaveBeenCalled()
  })

  it("clears its refresh lease after an OAuth timeout", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-reactive-refresh-"))
    const authPath = path.join(dir, "codex-accounts.json")
    await seedAuth(authPath)

    const recovered = await recoverExpiredOpenAIAuth({
      authMode: "native",
      failedAuth: { access: "at_old", identityKey: IDENTITY },
      authPath,
      recoveryDelayMs: 0,
      convergenceWaitMs: 0,
      refresh: async () => {
        throw new Error("OAuth request timed out after 30000ms")
      }
    })

    expect(recovered).toBeUndefined()
    expect((await storedAccount(authPath)).refreshLeaseUntil).toBeUndefined()
  })

  it("surfaces unexpected refresh implementation failures", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-reactive-refresh-"))
    const authPath = path.join(dir, "codex-accounts.json")
    await seedAuth(authPath)

    await expect(
      recoverExpiredOpenAIAuth({
        authMode: "native",
        failedAuth: { access: "at_old", identityKey: IDENTITY },
        authPath,
        recoveryDelayMs: 0,
        refresh: async () => {
          throw new TypeError("implementation bug")
        }
      })
    ).rejects.toThrow("implementation bug")
    expect((await storedAccount(authPath)).refreshLeaseUntil).toBeUndefined()
  })
})
