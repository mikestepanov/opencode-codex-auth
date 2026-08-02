import { parseJwtClaims } from "../claims.js"
import type { AuthData } from "../fetch-orchestrator.js"
import { ensureIdentityKey, normalizeEmail, normalizePlan } from "../identity.js"
import { ensureOpenAIOAuthDomain, loadAuthStorage, saveAuthStorage } from "../storage.js"
import type { AccountRecord, OpenAIAuthMode } from "../types.js"
import { extractAccountId, OAUTH_HTTP_TIMEOUT_MS, refreshAccessToken } from "./oauth-utils.js"

const DEFAULT_CONVERGENCE_WAIT_MS = 35_000
const DEFAULT_CONVERGENCE_POLL_MS = 250
const DEFAULT_RECOVERY_SLOT_MS = 30_000
const REACTIVE_REFRESH_LEASE_MS = Math.max(30_000, OAUTH_HTTP_TIMEOUT_MS + 5_000)

function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback
}

function defaultRecoveryDelayMs(): number {
  const rank = parseNonNegativeInteger(process.env.OPENCODE_OPENAI_MULTI_RECOVERY_RANK, 0)
  const slotMs = parseNonNegativeInteger(process.env.OPENCODE_OPENAI_MULTI_RECOVERY_SLOT_MS, DEFAULT_RECOVERY_SLOT_MS)
  return rank * slotMs
}

function isExpectedRefreshFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    ("status" in error ||
      "oauthCode" in error ||
      error.name === "AbortError" ||
      error.message.includes("timed out") ||
      error.message.includes("fetch") ||
      error.message.includes("network"))
  )
}

function authFromAccount(account: AccountRecord): AuthData | undefined {
  const identityKey = ensureIdentityKey(account).identityKey
  if (!identityKey || !account.access || account.enabled === false) return undefined
  return {
    access: account.access,
    ...(account.accountId ? { accountId: account.accountId } : {}),
    identityKey,
    ...(account.email ? { email: account.email } : {}),
    ...(account.plan ? { plan: account.plan } : {})
  }
}

export async function recoverExpiredOpenAIAuth(input: {
  authMode: OpenAIAuthMode
  failedAuth: AuthData
  authPath?: string
  now?: () => number
  refresh?: typeof refreshAccessToken
  sleep?: (ms: number) => Promise<void>
  convergenceWaitMs?: number
  convergencePollMs?: number
  recoveryDelayMs?: number
}): Promise<AuthData | undefined> {
  const identityKey = input.failedAuth.identityKey?.trim()
  if (!identityKey) return undefined

  const now = input.now ?? Date.now
  const refresh = input.refresh ?? refreshAccessToken
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const waitMs = Math.max(0, input.convergenceWaitMs ?? DEFAULT_CONVERGENCE_WAIT_MS)
  const pollMs = Math.max(10, input.convergencePollMs ?? DEFAULT_CONVERGENCE_POLL_MS)
  const recoveryDelayMs = Math.max(0, input.recoveryDelayMs ?? defaultRecoveryDelayMs())
  const loadConvergedAuth = async (): Promise<AuthData | undefined> => {
    const auth = await loadAuthStorage(input.authPath, { lockReads: false })
    const domain = ensureOpenAIOAuthDomain(auth, input.authMode)
    const account = domain.accounts.find((candidate) => candidate.identityKey === identityKey)
    return account?.access && account.access !== input.failedAuth.access ? authFromAccount(account) : undefined
  }
  const awaitConvergedAuth = async (maxWaitMs = waitMs): Promise<AuthData | undefined> => {
    const maxPolls = Math.ceil(maxWaitMs / pollMs)
    for (let poll = 0; poll <= maxPolls; poll += 1) {
      const converged = await loadConvergedAuth()
      if (converged) return converged
      if (poll === maxPolls) return undefined
      await sleep(pollMs)
    }
    return undefined
  }

  const delayPolls = Math.ceil(recoveryDelayMs / pollMs)
  for (let poll = 0; poll < delayPolls; poll += 1) {
    await sleep(Math.min(pollMs, recoveryDelayMs - poll * pollMs))
    const converged = await loadConvergedAuth()
    if (converged) return converged
  }

  const claimRefresh = async (): Promise<{
    claim?: { access: string; refresh: string; leaseUntil: number }
    latest?: AuthData
    existingLeaseUntil?: number
  }> => {
    let claim: { access: string; refresh: string; leaseUntil: number } | undefined
    let latest: AuthData | undefined
    let existingLeaseUntil: number | undefined
    await saveAuthStorage(input.authPath, (auth) => {
      const domain = ensureOpenAIOAuthDomain(auth, input.authMode)
      const account = domain.accounts.find((candidate) => candidate.identityKey === identityKey)
      if (!account || account.enabled === false || !account.access || !account.refresh) return
      if (account.access !== input.failedAuth.access) {
        latest = authFromAccount(account)
        return
      }
      const currentNow = now()
      if (typeof account.refreshLeaseUntil === "number" && account.refreshLeaseUntil > currentNow) {
        existingLeaseUntil = account.refreshLeaseUntil
        return
      }
      const leaseUntil = currentNow + REACTIVE_REFRESH_LEASE_MS
      account.refreshLeaseUntil = leaseUntil
      claim = { access: account.access, refresh: account.refresh, leaseUntil }
    })
    return { claim, latest, existingLeaseUntil }
  }

  let claimed = await claimRefresh()
  if (claimed.latest) return claimed.latest
  if (!claimed.claim && claimed.existingLeaseUntil) {
    const leaseWaitMs = Math.min(waitMs, Math.max(0, claimed.existingLeaseUntil - now()) + pollMs)
    const leasePolls = Math.ceil(leaseWaitMs / pollMs)
    for (let poll = 0; poll < leasePolls; poll += 1) {
      await sleep(Math.min(pollMs, leaseWaitMs - poll * pollMs))
      const converged = await loadConvergedAuth()
      if (converged) return converged
    }
    claimed = await claimRefresh()
    if (claimed.latest) return claimed.latest
    if (!claimed.claim) return awaitConvergedAuth(Math.max(0, waitMs - leaseWaitMs))
  }
  if (!claimed.claim) return awaitConvergedAuth()
  const claim = claimed.claim
  const activeClaim = claim

  let tokens: Awaited<ReturnType<typeof refreshAccessToken>>
  try {
    tokens = await refresh(activeClaim.refresh)
  } catch (error) {
    await saveAuthStorage(input.authPath, (auth) => {
      const account = ensureOpenAIOAuthDomain(auth, input.authMode).accounts.find(
        (candidate) => candidate.identityKey === identityKey
      )
      if (
        account?.access === activeClaim.access &&
        account.refresh === activeClaim.refresh &&
        account.refreshLeaseUntil === activeClaim.leaseUntil
      ) {
        delete account.refreshLeaseUntil
      }
    })
    if (!isExpectedRefreshFailure(error)) throw error
    return awaitConvergedAuth()
  }

  const refreshedExpires = now() + (tokens.expires_in ?? 3600) * 1000
  const refreshedAccountId = extractAccountId(tokens)
  const claims = parseJwtClaims(tokens.id_token ?? tokens.access_token)
  let latest: AuthData | undefined
  await saveAuthStorage(input.authPath, (auth) => {
    const domain = ensureOpenAIOAuthDomain(auth, input.authMode)
    const account = domain.accounts.find((candidate) => candidate.identityKey === identityKey)
    if (!account || account.enabled === false) return
    if (account.access !== activeClaim.access || account.refresh !== activeClaim.refresh) {
      latest = authFromAccount(account)
      if (account.refreshLeaseUntil === activeClaim.leaseUntil) delete account.refreshLeaseUntil
      return
    }
    if (account.refreshLeaseUntil !== activeClaim.leaseUntil) return

    account.access = tokens.access_token
    account.refresh = tokens.refresh_token
    account.expires = refreshedExpires
    account.accountId = refreshedAccountId || account.accountId
    if (claims?.email) account.email = normalizeEmail(claims.email)
    if (claims?.plan) account.plan = normalizePlan(claims.plan)
    ensureIdentityKey(account)
    delete account.refreshLeaseUntil
    delete account.cooldownUntil
    if (account.identityKey) domain.activeIdentityKey = account.identityKey
    latest = authFromAccount(account)
  })

  return latest ?? (await awaitConvergedAuth())
}
