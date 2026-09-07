#!/usr/bin/env node
/**
 * mutcheck-doc-probe-ratelimit.mjs -- proves the #586 fix is load-bearing, and that the tests
 * guarding it would notice if it were undone.
 *
 * WHY THIS ONE NEEDS A MUTATION CHECK MORE THAN MOST
 *
 * #586 is a bug whose entire signature was that two different situations produced one
 * indistinguishable output: a probe that ran and found the message, and a probe that was rate
 * limited and gave up, both returned a bare `true`. Nothing in the logs changed when #424's
 * "verified, never assumed" guarantee stopped being kept.
 *
 * A test suite can inherit exactly that weakness. "The link was not reposted" passes on the
 * BROKEN code -- it is what the broken code did. So a green suite is not evidence the fix is
 * present, and the only way to find out is to remove the fix and check that something goes red.
 *
 * Each arm below reverts one part of the fix in the way someone would plausibly revert it (M1
 * and M3 are verbatim the pre-fix source) and asserts the suite then FAILS. An arm that stays
 * green means the tests were never watching that behaviour.
 *
 * THE ABSENCE ARM
 *
 * Every arm here works by finding an anchor in the source and replacing it. If the fix is
 * DELETED outright, no anchor matches, every mutation becomes a no-op, the suite passes each
 * time -- and a check without this arm reports success at the exact moment the subject stops
 * existing. So a missing anchor is a FAILURE, never a skip. Absence of the thing under test is
 * a finding, not a quiet pass.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const BRIDGE = join(REPO, 'packages', 'telegram-bridge', 'src', 'bridge.js');
const SUITE = join('packages', 'telegram-bridge', 'src', 'docLink.test.js');
const VITEST = join(REPO, 'node_modules', 'vitest', 'vitest.mjs');

/**
 * JURISDICTION -- and why this is not the fail-open it resembles.
 *
 * sync-oa-home rule 4 copies EVERY `mutcheck-*` to the flat OA home, because
 * `run-sweeps.ps1 -IncludeMutchecks` discovers guards by globbing that home rather than the
 * repo. This guard is the first whose subject is the repo's own source tree and its installed
 * test runner, and neither of those can be deployed there. Rule 5 names the consequence
 * exactly: "a guard whose subject is absent does not skip -- it dies with exit 1."
 *
 * So it has to tell two situations apart, and it must not use the subject's absence to do it,
 * since that is the thing being asserted. The discriminator is the LAYOUT this file is sitting
 * in, which is independent of whether the subject survived:
 *
 *   in `plugins/overnight-agent/checks` -> a repo checkout. The subject MUST be here, and a
 *                                          missing bridge.js is a hard failure.
 *   anywhere else                       -> the flat home. This check has no jurisdiction and
 *                                          says so out loud, rather than reporting a pass it
 *                                          did not earn.
 */
const IN_REPO = /[\\/]plugins[\\/]overnight-agent[\\/]checks$/.test(HERE);

let pass = 0;
let fail = 0;

function check(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    console.error(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

function runSuite() {
  const res = spawnSync(process.execPath, [VITEST, 'run', SUITE, '--reporter=basic'], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, CI: '1' },
  });
  return res.status === 0;
}

/**
 * The arms. `find` is the post-fix source; `replace` is what it looked like before, or the
 * shortcut someone would reach for. Both are matched literally -- a regex that tried to be
 * clever about whitespace would drift out of sync with the file it is asserting about.
 */
const ARMS = [
  {
    id: 'M1',
    what: 'the probe calls Telegram directly again, outside the #172 retry',
    why: 'verbatim the pre-#586 source: a 429 falls into the generic catch and is answered "present" without ever waiting.',
    find:
      "      await withRateLimitRetry(`doc link probe task #${taskId}`, () =>\n" +
      "        client.editMessageText({ chatId, messageId, text, parseMode: 'HTML', disablePreview: false }),\n" +
      '      )',
    replace:
      "      await client.editMessageText({ chatId, messageId, text, parseMode: 'HTML', disablePreview: false })",
  },
  {
    id: 'M2',
    what: 'an exhausted rate limit counts as a successful verification',
    why: 'the single-character version of the whole bug: the guess is recorded as evidence, so the run cannot report that verification did not happen and the probe queue reorders on the strength of it.',
    find: '        return { present: true, verified: false }\n      }\n      logger(`doc link probe for task',
    replace: '        return { present: true, verified: true }\n      }\n      logger(`doc link probe for task',
  },
  {
    id: 'M3',
    what: 'the notice edit calls Telegram directly again',
    why: 'the stacking path. A 429 is read as a failed edit, so a second notice is composed and sent -- and the send waits out the limit the edit refused to, making the duplicate the message that lands.',
    find:
      "      await withRateLimitRetry(`edit notice task #${taskId}`, () =>\n" +
      "        client.editMessageText({ chatId, messageId, text, parseMode: 'HTML' }),\n" +
      '      )',
    replace: "      await client.editMessageText({ chatId, messageId, text, parseMode: 'HTML' })",
  },
  {
    id: 'M4',
    what: 'the probe budget stops going oldest-first',
    why: 'a budget without an ordering is a starvation bug: the same head of the list is probed every run and the tail is never verified at all, which is the failure the budget exists to avoid rather than cause.',
    find:
      '    candidates.sort(\n' +
      '      (a, b) => (state.tasks[a].docLinkVerifiedAt || 0) - (state.tasks[b].docLinkVerifiedAt || 0),\n' +
      '    )',
    replace: '    // sort removed',
  },
  {
    id: 'M5',
    what: 'a deferred probe is reported as an unverified one',
    why: 'collapses two unlike states into one output, which is structurally the same defect #586 describes. It also cries wolf: routine scheduling would read as a failed guarantee, and the real signal would be discarded as noise within a week.',
    find: '        out.linkProbeDeferred = true',
    replace: '        out.linkUnverified = true',
  },
];

console.log('mutcheck-doc-probe-ratelimit (#586)');

if (!IN_REPO) {
  console.log(
    '\n  NOT APPLICABLE -- this guard mutates repo source and runs the repo test suite, so it\n' +
      '  only means anything inside a checkout. It is here because sync-oa-home rule 4 delivers\n' +
      '  every mutcheck to the flat home; there is no repo here to assert about. Run it from\n' +
      '  plugins/overnight-agent/checks in the repo, where CI does.',
  );
  process.exit(0);
}

if (!existsSync(BRIDGE) || !existsSync(VITEST)) {
  // Reached only INSIDE a checkout, where both must exist. A missing subject is the loudest
  // finding this file can produce -- it means the code under guard, or the runner that proves
  // it, is gone. Exiting 0 here would be the #346 shape in the guard itself.
  console.error(
    `\n  FAIL missing subject -- ${!existsSync(BRIDGE) ? BRIDGE : VITEST} does not exist.\n` +
      '  This is a repo checkout, so it should. Either the #586 fix was deleted along with the\n' +
      '  file that holds it, or dependencies were never installed (npm ci).',
  );
  process.exit(1);
}

const original = readFileSync(BRIDGE, 'utf8');
// Anchors are written with \n above; the working tree may well hold \r\n (it does on Windows,
// and CI checks out on Linux). Normalising the ANCHORS to whatever the file actually uses keeps
// this check honest on both, where hardcoding either would make the ABSENCE arm fire on the
// wrong platform and read as "the fix was deleted" when nothing had changed at all.
const EOL = original.includes('\r\n') ? '\r\n' : '\n';
for (const arm of ARMS) {
  arm.find = arm.find.split('\n').join(EOL);
  arm.replace = arm.replace.split('\n').join(EOL);
}

let restored = true;

function restore() {
  if (!restored) {
    writeFileSync(BRIDGE, original, 'utf8');
    restored = true;
  }
}
process.on('exit', restore);
process.on('SIGINT', () => {
  restore();
  process.exit(130);
});

console.log('mutcheck-doc-probe-ratelimit (#586)');

try {
  console.log('\nBASELINE');
  check('the suite passes on the real source', runSuite(), 'the fix or its tests are already broken');

  console.log('\nABSENCE -- is the subject even here?');
  for (const arm of ARMS) {
    const seen = original.split(arm.find).length - 1;
    check(
      `${arm.id} anchor is present exactly once`,
      seen === 1,
      seen === 0
        ? `NOT FOUND in bridge.js. Either the #586 fix was removed, or it was rewritten and this arm is now asserting about code that does not exist. Both are findings: ${arm.what}`
        : `found ${seen} times, so a mutation would hit more than one site and the arm no longer isolates one behaviour`,
    );
  }

  console.log('\nMUTATIONS -- each must turn the suite red');
  for (const arm of ARMS) {
    if (original.split(arm.find).length - 1 !== 1) {
      check(`${arm.id} ${arm.what}`, false, 'skipped: anchor missing (see ABSENCE above)');
      continue;
    }
    restored = false;
    writeFileSync(BRIDGE, original.split(arm.find).join(arm.replace), 'utf8');
    const stillGreen = runSuite();
    restore();
    check(
      `${arm.id} ${arm.what}`,
      !stillGreen,
      `the suite still PASSED with this reverted, so nothing is watching it. ${arm.why}`,
    );
  }

  console.log('\nRESTORED');
  check('the suite passes again after every arm', runSuite(), 'a mutation was not cleaned up');
} finally {
  restore();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
