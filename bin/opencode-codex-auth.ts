#!/usr/bin/env node

import { runInstallerCli } from "../lib/installer-cli.js"
import { runStatusCli } from "../lib/status-cli.js"

const args = process.argv.slice(2)
const run = args[0] === "status" ? runStatusCli(args.slice(1)) : runInstallerCli(args)

run
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  })
