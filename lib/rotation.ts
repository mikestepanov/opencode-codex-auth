import type { AccountRecord, RotationStrategy } from "./types.js"

const DEFAULT_SESSION_ASSIGNMENT_MAX = 200

export type StickySessionState = {
  bySessionKey: Map<string, string>
  cursor: number
  maxEntries?: number
}

export function createStickySessionState(maxEntries = DEFAULT_SESSION_ASSIGNMENT_MAX): StickySessionState {
  return {
    bySessionKey: new Map<string, string>(),
    cursor: 0,
    maxEntries
  }
}

export type SelectAccountInput = {
  accounts: AccountRecord[]
  strategy?: RotationStrategy
  activeIdentityKey?: string
  now: number
  stickyPidOffset?: boolean
  pid?: number
  stickySessionKey?: string | null
  stickySessionState?: StickySessionState
  preferredIdentityKeys?: string[]
  avoidNewIdentityKeys?: Set<string>
  onDebug?: (event: RotationDebugEvent) => void
}

export type RotationDebugEvent = {
  strategy: RotationStrategy
  decision:
    | "none-eligible"
    | "sticky-session-reuse"
    | "sticky-session-assign"
    | "sticky-preferred"
    | "sticky-fallback-first"
    | "sticky-active"
    | "sticky-pid-offset"
    | "hybrid-session-reuse"
    | "hybrid-session-assign"
    | "hybrid-preferred"
    | "hybrid-active"
    | "hybrid-lru"
    | "round-robin-next"
    | "round-robin-pid-offset"
    | "round-robin-preferred"
  selectedIdentityKey?: string
  activeIdentityKey?: string
  sessionKey?: string
  totalCount: number
  disabledCount: number
  cooldownCount: number
  refreshLeaseCount: number
  eligibleCount: number
  extra?: Record<string, unknown>
}

type RotationHealthCounts = {
  totalCount: number
  disabledCount: number
  cooldownCount: number
  refreshLeaseCount: number
  eligibleCount: number
}

function isEligible(account: AccountRecord, now: number): boolean {
  if (account.enabled === false) return false
  if (typeof account.cooldownUntil === "number" && account.cooldownUntil > now) {
    return false
  }
  if (typeof account.refreshLeaseUntil === "number" && account.refreshLeaseUntil > now) {
    return false
  }
  return true
}

function computeRotationHealthCounts(accounts: AccountRecord[], now: number): RotationHealthCounts {
  let disabledCount = 0
  let cooldownCount = 0
  let refreshLeaseCount = 0
  let eligibleCount = 0

  for (const account of accounts) {
    const disabled = account.enabled === false
    const cooling = typeof account.cooldownUntil === "number" && account.cooldownUntil > now
    const leased = typeof account.refreshLeaseUntil === "number" && account.refreshLeaseUntil > now

    if (disabled) {
      disabledCount += 1
      continue
    }
    if (cooling) {
      cooldownCount += 1
      continue
    }
    if (leased) {
      refreshLeaseCount += 1
      continue
    }

    eligibleCount += 1
  }

  return {
    totalCount: accounts.length,
    disabledCount,
    cooldownCount,
    refreshLeaseCount,
    eligibleCount
  }
}

function emitRotationDebug(
  input: SelectAccountInput,
  event: Omit<
    RotationDebugEvent,
    "totalCount" | "disabledCount" | "cooldownCount" | "refreshLeaseCount" | "eligibleCount"
  > & {
    eligibleCount?: number
  }
): void {
  if (!input.onDebug) return
  const counts = computeRotationHealthCounts(input.accounts, input.now)
  input.onDebug({
    ...event,
    totalCount: counts.totalCount,
    disabledCount: counts.disabledCount,
    cooldownCount: counts.cooldownCount,
    refreshLeaseCount: counts.refreshLeaseCount,
    eligibleCount: event.eligibleCount ?? counts.eligibleCount
  })
}

function toNonNegativeInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(Math.abs(value)))
}

function resolveOffsetIndex(input: SelectAccountInput, eligibleLength: number): number {
  if (eligibleLength <= 1) return 0
  if (input.stickyPidOffset !== true) return 0

  const pid = toNonNegativeInt(input.pid ?? process.pid)
  return pid % eligibleLength
}

function resolveAssignedSessionAccount(
  input: SelectAccountInput,
  eligible: AccountRecord[],
  strategy: "sticky" | "hybrid"
): AccountRecord | undefined {
  const state = input.stickySessionState
  const sessionKey = input.stickySessionKey?.trim()
  if (!state || !sessionKey) return undefined

  const assignedIdentityKey = state.bySessionKey.get(sessionKey)
  if (!assignedIdentityKey) return undefined

  const assigned = eligible.find((acc) => acc.identityKey === assignedIdentityKey)
  if (!assigned) {
    state.bySessionKey.delete(sessionKey)
    return undefined
  }

  emitRotationDebug(input, {
    strategy,
    decision: strategy === "sticky" ? "sticky-session-reuse" : "hybrid-session-reuse",
    selectedIdentityKey: assigned.identityKey,
    activeIdentityKey: input.activeIdentityKey,
    sessionKey,
    eligibleCount: eligible.length
  })
  return assigned
}

function assignSessionAccount(
  input: SelectAccountInput,
  selected: AccountRecord | undefined,
  strategy: "sticky" | "hybrid",
  eligibleCount: number,
  extra?: Record<string, unknown>
): void {
  const state = input.stickySessionState
  const sessionKey = input.stickySessionKey?.trim()
  if (!state || !sessionKey || !selected?.identityKey) return

  state.bySessionKey.set(sessionKey, selected.identityKey)
  const maxEntries = Math.max(1, Math.floor(state.maxEntries ?? DEFAULT_SESSION_ASSIGNMENT_MAX))
  while (state.bySessionKey.size > maxEntries) {
    const oldest = state.bySessionKey.keys().next().value
    if (!oldest) break
    state.bySessionKey.delete(oldest)
  }

  emitRotationDebug(input, {
    strategy,
    decision: strategy === "sticky" ? "sticky-session-assign" : "hybrid-session-assign",
    selectedIdentityKey: selected.identityKey,
    activeIdentityKey: input.activeIdentityKey,
    sessionKey,
    eligibleCount,
    ...(extra ? { extra } : {})
  })
}

function resolveStickySessionAccount(input: SelectAccountInput, eligible: AccountRecord[]): AccountRecord | undefined {
  const reused = resolveAssignedSessionAccount(input, eligible, "sticky")
  if (reused) return reused

  if (eligible.length === 0) return undefined
  const state = input.stickySessionState
  if (!state) return undefined
  const index = state.cursor % eligible.length
  state.cursor = (state.cursor + 1) % eligible.length
  const selected = eligible[index]
  if (!selected) return undefined
  assignSessionAccount(input, selected, "sticky", eligible.length, { sessionCursor: state.cursor })
  return selected
}

function resolveHybridSessionAccount(input: SelectAccountInput, eligible: AccountRecord[]): AccountRecord | undefined {
  const reused = resolveAssignedSessionAccount(input, eligible, "hybrid")
  if (reused) return reused

  const ordered = [...eligible].sort((left, right) => {
    const leftLastUsed = left.lastUsed ?? 0
    const rightLastUsed = right.lastUsed ?? 0
    if (leftLastUsed !== rightLastUsed) return leftLastUsed - rightLastUsed
    return (left.identityKey ?? "").localeCompare(right.identityKey ?? "")
  })
  if (ordered.length === 0) return undefined

  const state = input.stickySessionState
  if (!state) return undefined
  const index = state.cursor % ordered.length
  state.cursor = (state.cursor + 1) % ordered.length
  const selected = ordered[index]
  if (!selected) return undefined
  assignSessionAccount(input, selected, "hybrid", eligible.length, { sessionCursor: state.cursor })
  return selected
}

export function selectAccount(input: SelectAccountInput): AccountRecord | undefined {
  const { accounts, now, activeIdentityKey } = input
  const strategy: RotationStrategy = input.strategy ?? "sticky"
  const hasStickySessionKey = Boolean(input.stickySessionKey?.trim())

  const eligible = accounts.filter((acc) => isEligible(acc, now))
  if (eligible.length === 0) {
    emitRotationDebug(input, {
      strategy,
      decision: "none-eligible",
      activeIdentityKey,
      eligibleCount: 0
    })
    return undefined
  }

  const assigned =
    strategy === "sticky" || strategy === "hybrid"
      ? resolveAssignedSessionAccount(input, eligible, strategy)
      : undefined
  if (assigned) return assigned

  const avoidNewIdentityKeys = input.avoidNewIdentityKeys ?? new Set<string>()
  const newEligible = eligible.filter(
    (account) => !account.identityKey || !avoidNewIdentityKeys.has(account.identityKey)
  )
  if (newEligible.length === 0) {
    emitRotationDebug(input, {
      strategy,
      decision: "none-eligible",
      activeIdentityKey,
      eligibleCount: 0,
      extra: { avoidedForNewAssignment: eligible.length }
    })
    return undefined
  }

  const preferred = input.preferredIdentityKeys
    ?.map((identityKey) => newEligible.find((account) => account.identityKey === identityKey))
    .find((account): account is AccountRecord => account !== undefined)
  if (preferred) {
    if (strategy === "sticky" || strategy === "hybrid") {
      assignSessionAccount(input, preferred, strategy, newEligible.length)
    }
    emitRotationDebug(input, {
      strategy,
      decision:
        strategy === "sticky"
          ? "sticky-preferred"
          : strategy === "hybrid"
            ? "hybrid-preferred"
            : "round-robin-preferred",
      selectedIdentityKey: preferred.identityKey,
      activeIdentityKey,
      eligibleCount: newEligible.length
    })
    return preferred
  }

  const activeIndex =
    activeIdentityKey == null ? -1 : newEligible.findIndex((acc) => acc.identityKey === activeIdentityKey)

  if (strategy === "sticky") {
    const stickySessionAccount =
      input.stickyPidOffset === true && hasStickySessionKey
        ? resolveStickySessionAccount(input, newEligible)
        : undefined
    if (stickySessionAccount) return stickySessionAccount
    if (activeIndex >= 0) {
      const selected = newEligible[activeIndex]
      assignSessionAccount(input, selected, "sticky", newEligible.length)
      emitRotationDebug(input, {
        strategy,
        decision: "sticky-active",
        selectedIdentityKey: selected?.identityKey,
        activeIdentityKey,
        eligibleCount: newEligible.length
      })
      return selected
    }
    if (input.stickyPidOffset !== true) {
      const selected = newEligible[0]
      assignSessionAccount(input, selected, "sticky", newEligible.length)
      emitRotationDebug(input, {
        strategy,
        decision: "sticky-fallback-first",
        selectedIdentityKey: selected?.identityKey,
        activeIdentityKey,
        eligibleCount: newEligible.length
      })
      return selected
    }
    const offsetIndex = resolveOffsetIndex(input, newEligible.length)
    const selected = newEligible[offsetIndex]
    assignSessionAccount(input, selected, "sticky", newEligible.length, { offsetIndex })
    emitRotationDebug(input, {
      strategy,
      decision: "sticky-pid-offset",
      selectedIdentityKey: selected?.identityKey,
      activeIdentityKey,
      eligibleCount: newEligible.length,
      extra: { offsetIndex }
    })
    return selected
  }

  if (strategy === "hybrid") {
    if (input.stickyPidOffset === true && hasStickySessionKey) {
      const sessionAccount = resolveHybridSessionAccount(input, newEligible)
      if (sessionAccount) return sessionAccount
    }
    if (activeIndex >= 0) {
      const selected = newEligible[activeIndex]
      assignSessionAccount(input, selected, "hybrid", newEligible.length)
      emitRotationDebug(input, {
        strategy,
        decision: "hybrid-active",
        selectedIdentityKey: selected?.identityKey,
        activeIdentityKey,
        eligibleCount: newEligible.length
      })
      return selected
    }
    let selected = newEligible[0]
    let selectedLastUsed = selected.lastUsed ?? 0
    for (let i = 1; i < newEligible.length; i++) {
      const candidate = newEligible[i]
      const candidateLastUsed = candidate.lastUsed ?? 0
      if (
        candidateLastUsed < selectedLastUsed ||
        (candidateLastUsed === selectedLastUsed && (candidate.identityKey ?? "") < (selected.identityKey ?? ""))
      ) {
        selected = candidate
        selectedLastUsed = candidateLastUsed
      }
    }
    assignSessionAccount(input, selected, "hybrid", newEligible.length, { lastUsed: selected.lastUsed ?? 0 })
    emitRotationDebug(input, {
      strategy,
      decision: "hybrid-lru",
      selectedIdentityKey: selected.identityKey,
      activeIdentityKey,
      eligibleCount: newEligible.length,
      extra: { lastUsed: selected.lastUsed ?? 0 }
    })
    return selected
  }

  if (activeIndex < 0) {
    const offsetIndex = resolveOffsetIndex(input, newEligible.length)
    const selected = newEligible[offsetIndex]
    emitRotationDebug(input, {
      strategy,
      decision: "round-robin-pid-offset",
      selectedIdentityKey: selected?.identityKey,
      activeIdentityKey,
      eligibleCount: newEligible.length,
      extra: { offsetIndex }
    })
    return selected
  }
  const selected = newEligible[(activeIndex + 1) % newEligible.length]
  emitRotationDebug(input, {
    strategy,
    decision: "round-robin-next",
    selectedIdentityKey: selected?.identityKey,
    activeIdentityKey,
    eligibleCount: newEligible.length,
    extra: { activeIndex }
  })
  return selected
}
