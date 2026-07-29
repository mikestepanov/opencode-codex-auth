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
  it("loads the exact worktree route and resolves host-local aliases", () => {
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
        routes: [
          {
            worktree: "/workspace/nixelo",
            preferredAccounts: ["primary", "reserve"],
            drainAccounts: ["reserve"]
          }
        ]
      })
    )

    const policy = loadAccountRoutingPolicy({
      worktree: "/workspace/nixelo",
      env: { OPENCODE_OPENAI_MULTI_ACCOUNT_ROUTING_PATH: routingPath }
    })
    const accounts: AccountRecord[] = [
      { identityKey: "acc-primary|primary@example.com|plus", email: "primary@example.com" },
      { identityKey: "acc-reserve|reserve@example.com|plus", email: "reserve@example.com" }
    ]

    expect(resolveAccountRouting(policy, accounts)).toEqual({
      preferredIdentityKeys: ["acc-primary|primary@example.com|plus", "acc-reserve|reserve@example.com|plus"],
      avoidNewIdentityKeys: new Set(["acc-reserve|reserve@example.com|plus"])
    })
  })

  it("ignores routes for another worktree and ambiguous email selectors", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-routing-"))
    temporaryDirectories.push(directory)
    const routingPath = path.join(directory, "routing.jsonc")
    fs.writeFileSync(
      routingPath,
      JSON.stringify({
        accounts: { shared: { email: "shared@example.com" } },
        routes: [{ worktree: "/workspace/other", preferredAccounts: ["shared"] }]
      })
    )

    expect(
      loadAccountRoutingPolicy({
        worktree: "/workspace/nixelo",
        env: { OPENCODE_OPENAI_MULTI_ACCOUNT_ROUTING_PATH: routingPath }
      })
    ).toBeUndefined()

    const policy = loadAccountRoutingPolicy({
      worktree: "/workspace/other",
      env: { OPENCODE_OPENAI_MULTI_ACCOUNT_ROUTING_PATH: routingPath }
    })
    expect(
      resolveAccountRouting(policy, [
        { identityKey: "a", email: "shared@example.com" },
        { identityKey: "b", email: "shared@example.com" }
      ])?.preferredIdentityKeys
    ).toEqual([])
  })
})
