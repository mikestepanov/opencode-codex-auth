import crypto from "node:crypto"

import { isTokenExpiredResponse } from "./api-auth-error.js"
import { fetchQuotaSnapshotResultFromBackend } from "./codex-quota-fetch.js"
import { saveSnapshots } from "./codex-status-storage.js"
import type { AuthData } from "./fetch-orchestrator.js"
import { buildLegacyIdentityFingerprint, ensureIdentityKey } from "./identity.js"
import { defaultSnapshotsPath } from "./paths.js"
import { getOpenAIOAuthDomain, loadAuthStorage, saveAuthStorage } from "./storage.js"
import type { AccountRecord, CodexLimit, OpenAIAuthMode } from "./types.js"
import { recoverExpiredOpenAIAuth } from "./codex-native/reactive-refresh.js"

/**
 * A freshly fetched quota snapshot proves the account can serve traffic only
 * when every reported window still has capacity. An empty list means the probe
 * returned no usable window data, which is not evidence of recovery.
 */
export function limitsIndicateAvailability(limits: CodexLimit[]): boolean {
  return limits.length > 0 && limits.every((limit) => limit.leftPct > 0)
}

export type LiveQuotaStatusRecord = {
  account: string
  accountKey: string
  plan: string
  enabled: boolean
  cooldownUntil?: number
  status: "ok" | "disabled" | "missing_access" | "token_expired" | "no_quota_data" | "unavailable"
  httpStatus?: number
  limits: CodexLimit[]
}

function accountKey(account: AccountRecord): string {
  const source = account.identityKey?.trim() || buildLegacyIdentityFingerprint(account)
  return crypto.createHash("sha256").update(source).digest("hex").slice(0, 16)
}

function authFromAccount(account: AccountRecord): AuthData | undefined {
  const identityKey = ensureIdentityKey(account).identityKey
  if (!account.access) return undefined
  return {
    access: account.access,
    ...(identityKey ? { identityKey } : {}),
    ...(account.accountId ? { accountId: account.accountId } : {}),
    ...(account.email ? { email: account.email } : {}),
    ...(account.plan ? { plan: account.plan } : {})
  }
}

export async function collectLiveQuotaStatus(
  input: {
    authMode?: OpenAIAuthMode
    authPath?: string
    snapshotsPath?: string
    now?: number
    fetchImpl?: typeof fetch
    timeoutMs?: number
    recover?: typeof recoverExpiredOpenAIAuth
  } = {}
): Promise<LiveQuotaStatusRecord[]> {
  const authMode = input.authMode ?? "native"
  const now = input.now ?? Date.now()
  const snapshotsPath = input.snapshotsPath ?? defaultSnapshotsPath()
  const auth = await loadAuthStorage(input.authPath, { lockReads: false })
  const domain = getOpenAIOAuthDomain(auth, authMode)
  if (!domain) return []
  const recover = input.recover ?? recoverExpiredOpenAIAuth
  const records: LiveQuotaStatusRecord[] = []

  for (const account of domain.accounts) {
    const base = {
      account: account.email?.trim() || "account",
      accountKey: accountKey(account),
      plan: account.plan?.trim() || "unknown",
      enabled: account.enabled !== false,
      ...(typeof account.cooldownUntil === "number" ? { cooldownUntil: account.cooldownUntil } : {})
    }
    if (account.enabled === false) {
      records.push({ ...base, status: "disabled", limits: [] })
      continue
    }

    try {
      let selected = authFromAccount(account)
      if (!selected) {
        records.push({ ...base, status: "missing_access", limits: [] })
        continue
      }

      let result = await fetchQuotaSnapshotResultFromBackend({
        accessToken: selected.access,
        accountId: selected.accountId,
        fetchImpl: input.fetchImpl,
        timeoutMs: input.timeoutMs
      })
      if (result.response && (await isTokenExpiredResponse(result.response))) {
        if (!selected.identityKey) {
          records.push({ ...base, status: "token_expired", httpStatus: result.response.status, limits: [] })
          continue
        }
        const recovered = await recover({ authMode, failedAuth: selected, authPath: input.authPath })
        if (!recovered) {
          records.push({ ...base, status: "token_expired", httpStatus: result.response.status, limits: [] })
          continue
        }
        selected = recovered
        result = await fetchQuotaSnapshotResultFromBackend({
          accessToken: selected.access,
          accountId: selected.accountId,
          fetchImpl: input.fetchImpl,
          timeoutMs: input.timeoutMs
        })
      }

      if (result.snapshot) {
        const snapshot = result.snapshot
        const identityKey = account.identityKey?.trim()
        // Keep the persisted quota snapshot current for every probed account,
        // including cooling ones the request path never re-samples. A fresh
        // snapshot stops account selection from re-benching a recovered account
        // from stale exhausted data on its next acquire.
        if (identityKey) {
          await saveSnapshots(snapshotsPath, (current) => ({
            ...current,
            [identityKey]: snapshot
          }))
        }
        // Autoheal: a fresh probe that still reports spare capacity is
        // authoritative proof the account recovered, so drop any stale persisted
        // quota cooldown instead of benching it until an obsolete retry window.
        const tokenRefreshed = selected.access !== account.access
        let cooldownCleared = false
        if (
          identityKey &&
          typeof account.cooldownUntil === "number" &&
          account.cooldownUntil > now &&
          limitsIndicateAvailability(snapshot.limits)
        ) {
          await saveAuthStorage(input.authPath, (stored) => {
            const target = getOpenAIOAuthDomain(stored, authMode)?.accounts.find(
              (candidate) => candidate.identityKey === identityKey
            )
            if (target && target.enabled !== false && typeof target.cooldownUntil === "number") {
              delete target.cooldownUntil
            }
          })
          cooldownCleared = true
        }
        records.push({
          ...base,
          plan: selected.plan?.trim() || base.plan,
          ...(tokenRefreshed || cooldownCleared ? { cooldownUntil: undefined } : {}),
          status: "ok",
          limits: snapshot.limits
        })
      } else if (result.response && (await isTokenExpiredResponse(result.response))) {
        records.push({ ...base, status: "token_expired", httpStatus: result.response.status, limits: [] })
      } else if (result.response?.ok) {
        records.push({ ...base, status: "no_quota_data", httpStatus: result.response.status, limits: [] })
      } else if (result.response) {
        records.push({ ...base, status: "unavailable", httpStatus: result.response.status, limits: [] })
      } else {
        records.push({ ...base, status: result.error ? "unavailable" : "no_quota_data", limits: [] })
      }
    } catch {
      records.push({ ...base, status: "unavailable", limits: [] })
    }
  }

  return records
}
