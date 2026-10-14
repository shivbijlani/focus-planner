#!/usr/bin/env node
import process from 'node:process'
import { main } from '../packages/docs-publisher/bin/fp-docs.js'
import { assertSandboxPath } from '../plugins/overnight-agent/skills/overnight-agent/oa-state-lib/core/context.mjs'
import { assertDocsTaskWritable } from '../plugins/overnight-agent/skills/overnight-agent/oa-state-lib/act/native-docs-guard.mjs'

main(process.argv.slice(2), {
  assertPath: assertSandboxPath,
  assertWritable: assertDocsTaskWritable,
}).then((code) => { process.exitCode = code }).catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
