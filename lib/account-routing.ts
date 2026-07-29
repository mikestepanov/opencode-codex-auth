import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { AccountRecord } from "./types.js"

export const ACCOUNT_ROUTING_FILE = "codex-account-routing.jsonc"

export type AccountSelector = {
  identityKey?: string
  email?: string
}

export type AccountRoutingPolicy = {
  preferredAccounts: AccountSelector[]
  drainAccounts: AccountSelector[]
}

type AccountRoutingFile = {
  accounts?: Record<string, AccountSelector>
  routes?: Array<{
    worktree?: string
    preferredAccounts?: string[]
    drainAccounts?: string[]
  }>
}

function stripJsonComments(raw: string): string {
  let out = ""
  let inString = false
  let escaped = false
  let inLineComment = false
  let inBlockComment = false

  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]
    const next = raw[i + 1]

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false
        out += char
      }
      continue
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false
        i += 1
      }
      continue
    }
    if (inString) {
      out += char
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      continue
    }
    if (char === "/" && next === "/") {
      inLineComment = true
      i += 1
      continue
    }
    if (char === "/" && next === "*") {
      inBlockComment = true
      i += 1
      continue
    }
    out += char
  }

  return out
}

function defaultRoutingPath(env: Record<string, string | undefined>): string {
  const explicit = env.OPENCODE_OPENAI_MULTI_ACCOUNT_ROUTING_PATH?.trim()
  if (explicit && path.isAbsolute(explicit)) return explicit
  const xdgRoot = env.XDG_CONFIG_HOME?.trim()
  const configRoot = xdgRoot && path.isAbsolute(xdgRoot) ? xdgRoot : path.join(os.homedir(), ".config")
  return path.join(configRoot, "opencode", ACCOUNT_ROUTING_FILE)
}

function normalizeWorktree(value: string): string {
  const expanded =
    value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value
  return path.resolve(expanded)
}

function parseSelector(value: unknown): AccountSelector | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const identityKey = typeof record.identityKey === "string" ? record.identityKey.trim() : ""
  const email = typeof record.email === "string" ? record.email.trim().toLowerCase() : ""
  if (identityKey) return { identityKey }
  if (email) return { email }
  return undefined
}

function resolveAliases(value: unknown, accounts: Record<string, AccountSelector>): AccountSelector[] {
  if (!Array.isArray(value)) return []
  const resolved: AccountSelector[] = []
  for (const raw of value) {
    if (typeof raw !== "string") continue
    const selector = accounts[raw.trim()]
    if (selector) resolved.push(selector)
  }
  return resolved
}

export function loadAccountRoutingPolicy(input: {
  worktree: string
  env?: Record<string, string | undefined>
  warn?: (message: string) => void
}): AccountRoutingPolicy | undefined {
  const env = input.env ?? process.env
  const filePath = defaultRoutingPath(env)
  let parsed: AccountRoutingFile
  try {
    parsed = JSON.parse(stripJsonComments(fs.readFileSync(filePath, "utf8"))) as AccountRoutingFile
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      input.warn?.(`[opencode-codex-auth] Ignoring invalid account routing file ${filePath}.`)
    }
    return undefined
  }

  const accounts = Object.fromEntries(
    Object.entries(parsed.accounts ?? {}).flatMap(([alias, value]) => {
      const selector = parseSelector(value)
      return alias.trim() && selector ? [[alias.trim(), selector]] : []
    })
  )
  const worktree = normalizeWorktree(input.worktree)
  const route = Array.isArray(parsed.routes)
    ? parsed.routes.find((candidate) =>
        typeof candidate.worktree === "string" && candidate.worktree.trim()
          ? normalizeWorktree(candidate.worktree) === worktree
          : false
      )
    : undefined
  if (!route) return undefined

  return {
    preferredAccounts: resolveAliases(route.preferredAccounts, accounts),
    drainAccounts: resolveAliases(route.drainAccounts, accounts)
  }
}

function selectorMatches(selector: AccountSelector, account: AccountRecord): boolean {
  if (selector.identityKey) return account.identityKey === selector.identityKey
  if (selector.email) return account.email?.trim().toLowerCase() === selector.email
  return false
}

export function resolveAccountRouting(
  policy: AccountRoutingPolicy | undefined,
  accounts: AccountRecord[]
): { preferredIdentityKeys: string[]; avoidNewIdentityKeys: Set<string> } | undefined {
  if (!policy) return undefined

  const resolve = (selectors: AccountSelector[]): string[] => {
    const keys: string[] = []
    for (const selector of selectors) {
      const matches = accounts.filter((account) => account.identityKey && selectorMatches(selector, account))
      if (matches.length !== 1) continue
      const identityKey = matches[0]?.identityKey
      if (identityKey && !keys.includes(identityKey)) keys.push(identityKey)
    }
    return keys
  }

  return {
    preferredIdentityKeys: resolve(policy.preferredAccounts),
    avoidNewIdentityKeys: new Set(resolve(policy.drainAccounts))
  }
}
