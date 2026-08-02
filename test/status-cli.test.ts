import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { runStatusCli } from "../lib/status-cli"
import { saveAuthStorage } from "../lib/storage"
import { resetStubbedGlobals, stubGlobalForTest } from "./helpers/mock-policy"

afterEach(() => {
  resetStubbedGlobals()
})

describe("status cli", () => {
  it("honors configured codex mode and emits secret-free JSON", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-status-cli-"))
    const configDir = path.join(root, "opencode")
    await fs.mkdir(configDir, { recursive: true })
    await fs.writeFile(path.join(configDir, "codex-config.jsonc"), '{"runtime":{"mode":"codex"}}\n')
    await saveAuthStorage(path.join(configDir, "codex-accounts.json"), () => ({
      openai: {
        type: "oauth",
        codex: {
          accounts: [
            {
              identityKey: "acc_secret|codex@example.com|pro",
              accountId: "acc_secret",
              email: "codex@example.com",
              plan: "pro",
              enabled: true,
              access: "at_secret",
              refresh: "rt_secret",
              expires: Date.now() + 3_600_000
            }
          ]
        },
        accounts: []
      }
    }))
    const previousXdg = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = root
    stubGlobalForTest("fetch", async () => Response.json({ rate_limit: { primary_window: { used_percent: 5 } } }))
    const out: string[] = []

    try {
      expect(await runStatusCli(["--json"], { out: (message) => out.push(message), err: () => {} })).toBe(0)
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previousXdg
    }

    const output = out.join("\n")
    expect(JSON.parse(output).accounts).toEqual([
      expect.objectContaining({ account: "codex@example.com", status: "ok" })
    ])
    expect(output).not.toContain("acc_secret")
    expect(output).not.toContain("at_secret")
    expect(output).not.toContain("rt_secret")
  })
})
