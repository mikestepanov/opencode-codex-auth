import { collectLiveQuotaStatus } from "./live-quota-status.js"
import { getMode, loadConfigFile, resolveConfig } from "./config.js"

type StatusCliIo = {
  out: (message: string) => void
  err: (message: string) => void
}

const DEFAULT_IO: StatusCliIo = {
  out: (message) => process.stdout.write(`${message}\n`),
  err: (message) => process.stderr.write(`${message}\n`)
}

export async function runStatusCli(args: string[], io: StatusCliIo = DEFAULT_IO): Promise<number> {
  if (args.length !== 1 || args[0] !== "--json") {
    io.err("Usage: opencode-codex-auth status --json")
    return 1
  }
  const authMode = getMode(resolveConfig({ env: process.env, file: loadConfigFile({ env: process.env }) }))
  io.out(JSON.stringify({ schemaVersion: 1, accounts: await collectLiveQuotaStatus({ authMode }) }))
  return 0
}
