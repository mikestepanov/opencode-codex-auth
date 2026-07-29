import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { loadAccountRoutingPolicy, resolveAccountRouting } from "../lib/account-routing"
import type { AccountRecord } from "../lib/types"

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe("account routing", () => {
  it("uses device and exact worktree policy before global defaults", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-routing-"))
    temporaryDirectories.push(directory)
    const routingPath = path.join(directory, "routing.jsonc")
    fs.writeFileSync(
      routingPath,
      JSON.stringify({
        accounts: {
          primary: { email: "primary@example.com" },
          reserve: { identityKey: "acc-reserve|reserve@example.com|plus" }
        },
        accountOrder: ["primary", "reserve"],
        drainAccounts: ["primary"],
        devices: {
          razer: {
            accountOrder: ["primary", "reserve"],
            routes: [
              {
                worktree: "/workspace/nixelo",
                accountOrder: ["reserve", "primary"],
                drainAccounts: ["reserve"]
              }
            ]
          }
        }
      })
    )

    const policy = loadAccountRoutingPolicy({
      worktree: "/workspace/nixelo",
      hostname: "RAZER.example.test",
      env: { OPENCODE_OPENAI_MULTI_ACCOUNT_ROUTING_PATH: routingPath }
    })
    const accounts: AccountRecord[] = [
      { identityKey: "acc-primary|primary@example.com|plus", email: "primary@example.com" },
      { identityKey: "acc-reserve|reserve@example.com|plus", email: "reserve@example.com" }
    ]

    expect(resolveAccountRouting(policy, accounts)).toEqual({
      preferredIdentityKeys: ["acc-reserve|reserve@example.com|plus", "acc-primary|primary@example.com|plus"],
      avoidNewIdentityKeys: new Set(["acc-reserve|reserve@example.com|plus"])
    })
  })

  it("uses the global account order when no worktree route matches", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-routing-"))
    temporaryDirectories.push(directory)
    const routingPath = path.join(directory, "routing.jsonc")
    fs.writeFileSync(
      routingPath,
      JSON.stringify({
        accounts: {
          primary: { email: "primary@example.com" },
          reserve: { email: "reserve@example.com" }
        },
        accountOrder: ["primary", "reserve"],
        devices: {
          razer: {
            accountOrder: ["reserve", "primary"],
            routes: [{ worktree: "/workspace/other", accountOrder: ["primary", "reserve"] }]
          }
        }
      })
    )

    const policy = loadAccountRoutingPolicy({
      worktree: "/workspace/nixelo",
      hostname: "omen",
      env: { OPENCODE_OPENAI_MULTI_ACCOUNT_ROUTING_PATH: routingPath }
    })
    expect(
      resolveAccountRouting(policy, [
        { identityKey: "a", email: "primary@example.com" },
        { identityKey: "b", email: "reserve@example.com" }
      ])?.preferredIdentityKeys
    ).toEqual(["a", "b"])
  })

  it("ignores ambiguous email selectors", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-routing-"))
    temporaryDirectories.push(directory)
    const routingPath = path.join(directory, "routing.jsonc")
    fs.writeFileSync(
      routingPath,
      JSON.stringify({
        accounts: { shared: { email: "shared@example.com" } },
        accountOrder: ["shared"]
      })
    )

    const policy = loadAccountRoutingPolicy({
      worktree: "/workspace/nixelo",
      hostname: "razer",
      env: { OPENCODE_OPENAI_MULTI_ACCOUNT_ROUTING_PATH: routingPath }
    })
    expect(
      resolveAccountRouting(policy, [
        { identityKey: "a", email: "shared@example.com" },
        { identityKey: "b", email: "shared@example.com" }
      ])?.preferredIdentityKeys
    ).toEqual([])
  })

  it("uses device defaults when no device route matches", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-routing-"))
    temporaryDirectories.push(directory)
    const routingPath = path.join(directory, "routing.jsonc")
    fs.writeFileSync(
      routingPath,
      JSON.stringify({
        accounts: {
          primary: { email: "primary@example.com" },
          reserve: { email: "reserve@example.com" }
        },
        accountOrder: ["primary", "reserve"],
        devices: {
          razer: {
            accountOrder: ["reserve", "primary"],
            drainAccounts: ["primary"]
          }
        }
      })
    )

    const policy = loadAccountRoutingPolicy({
      worktree: "/workspace/nixelo",
      hostname: "razer",
      env: { OPENCODE_OPENAI_MULTI_ACCOUNT_ROUTING_PATH: routingPath }
    })
    expect(
      resolveAccountRouting(policy, [
        { identityKey: "a", email: "primary@example.com" },
        { identityKey: "b", email: "reserve@example.com" }
      ])
    ).toEqual({
      preferredIdentityKeys: ["b", "a"],
      avoidNewIdentityKeys: new Set(["a"])
    })
  })
})
