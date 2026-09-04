// lib-gh-write-file.mjs — the temp-file writer that `gh api -F body=@file` needs.
//
// WHY THIS IS A DEFAULT AND NOT A REQUIRED ARGUMENT (GH #462, trap 1)
// ------------------------------------------------------------------
// `updateIssueBody` shipped with `run` defaulted and `writeFile` NOT defaulted. Omitting it threw
// `TypeError: writeFile is not a function` from inside the library, after the pre-read had already
// run. Loud, so nothing was lost — the cost is different and worse:
//
//   guarded path   : mkdtempSync + writeFileSync + return the path, at every call site
//   unguarded path : gh issue edit --body-file <one line>
//
// A guard that is more work than the thing it replaces gets routed around, which is GH #456's own
// argument turned on GH #456's fix. Defaulting it makes the safe call the SHORT call.
//
// It stays injectable. Tests need to observe what would have been written without touching a disk
// or a network, and every guard in this directory depends on being able to substitute the effect.
//
// WHY A FILE AT ALL, RATHER THAN AN ARGUMENT
// ------------------------------------------
// Issue bodies and catch-up comments are tens of kilobytes of markdown containing backticks,
// quotes and newlines. Passing that as a command-line argument is a quoting bug waiting for the
// first body that contains the wrong character, and on Windows it also meets the command-line
// length limit. `-F body=@<file>` has neither problem.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Write `body` to a fresh temp file and return its path.
 *
 * A NEW directory per call, not one reused path: two writes in a single run must not be able to
 * read each other's bytes, and a stale file from a previous call silently becoming the payload of
 * the next one is exactly the class of "the write succeeded, with the wrong content" failure that
 * the surrounding libraries exist to prevent.
 *
 * Written UTF-8 with no BOM. `gh` sends the bytes verbatim, and a BOM would arrive as three stray
 * characters at the top of every issue body — above the provenance marker, which is anchored to
 * the first non-empty line and would then stop matching.
 */
export function defaultWriteFile(body) {
  const dir = mkdtempSync(join(tmpdir(), 'gh-body-'))
  const file = join(dir, 'body.md')
  writeFileSync(file, String(body ?? ''), { encoding: 'utf8' })
  return file
}
