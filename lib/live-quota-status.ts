import crypto from "node:crypto"

import { isTokenExpiredResponse } from "./api-auth-error.js"
import { fetchQuotaSnapshotResultFromBackend } from "./codex-quota-fetch.js"
import type { AuthData } from "./fetch-orchestrator.js"
import { buildLegacyIdentityFingerprint, ensureIdentityKey } from "./identity.js"
import { getOpenAIOAuthDomain, loadAuthStorage } from "./storage.js"
import type { AccountRecord, CodexLimit, OpenAIAuthMode } from "./types.js"
import { recoverExpiredOpenAIAuth } from "./codex-native/reactive-refresh.js"

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
    fetchImpl?: typeof fetch
    timeoutMs?: number
    recover?: typeof recoverExpiredOpenAIAuth
  } = {}
): Promise<LiveQuotaStatusRecord[]> {
  const authMode = input.authMode ?? "native"
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
        records.push({
          ...base,
          plan: selected.plan?.trim() || base.plan,
          ...(selected.access !== account.access ? { cooldownUntil: undefined } : {}),
          status: "ok",
          limits: result.snapshot.limits
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
