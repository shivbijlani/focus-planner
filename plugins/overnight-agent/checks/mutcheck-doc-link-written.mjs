#!/usr/bin/env node
/**
 * mutcheck-doc-link-written.mjs -- proves the #588 gate is load-bearing, and that the tests
 * guarding it would notice if it were undone.
 *
 * WHY THIS ONE NEEDS A MUTATION CHECK
 *
 * #588 is another instance of the family defect: two different situations producing one
 * indistinguishable output. A catch-up doc that is BOUND and a catch-up doc that has been
 * WRITTEN were treated as the same event, so a task bound during a run had its link pushed in
 * that same run -- pointing at Google's "this has not been written yet" placeholder. Under
 * #424 the link is the wake's entire message, so from a phone a stub link and a genuinely
 * quiet task look identical.
 *
 * A test suite inherits that weakness by default. "A link was posted" passes on the BROKEN
 * code -- posting is what the broken code did, just too early. So a green suite is not
 * evidence the gate is present; the only way to find out is to remove it and watch for red.
 *
 * THE ABSENCE ARM
 *
 * Every arm works by finding a literal anchor and replacing it. Delete the gate outright and
 * no anchor matches, every mutation is a no-op, the suite passes each time -- so a check
 * without this arm reports success at the exact moment its subject stops existing. A missing
 * anchor is a FAILURE, never a skip.
 *
 * TWO SUBJECTS
 *
 * The gate spans a decision (bridge.js) and the predicate it decides on (deepLink.js). Both
 * are mutated, because a correct predicate behind a bypassed gate and a permissive predicate
 * behind a correct gate produce the same wrong behaviour, and a check that only watched one
 * of them would call the other's removal a pass.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const BRIDGE = join(REPO, 'packages', 'telegram-bridge', 'src', 'bridge.js');
const DEEPLINK = join(REPO, 'packages', 'telegram-bridge', 'src', 'deepLink.js');
const SUITE = join('packages', 'telegram-bridge', 'src', 'docLink.test.js');
const VITEST = join(REPO, 'node_modules', 'vitest', 'vitest.mjs');

/**
 * JURISDICTION -- and why this is not the fail-open it resembles.
 *
 * sync-oa-home rule 4 copies EVERY `mutcheck-*` to the flat OA home, since
 * `run-sweeps.ps1 -IncludeMutchecks` discovers guards by globbing that home. This guard's
 * subject is the repo's own source and its installed test runner, neither of which can be
 * deployed there. Rule 5: "a guard whose subject is absent does not skip -- it dies with
 * exit 1."
 *
 * So it must tell two situations apart WITHOUT using the subject's absence to do it -- absence
 * is the thing being asserted, and keying on it would be the fail-open. The discriminator is
 * the LAYOUT this file sits in, which survives the subject being deleted.
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
 * The arms. `find` is the post-fix source; `replace` is the pre-fix source, or the shortcut
 * someone would plausibly reach for. Matched literally -- a regex trying to be clever about
 * whitespace would drift out of step with the file it asserts about.
 */
const ARMS = [
  {
    id: 'M1',
    file: BRIDGE,
    what: 'the gate is removed and the link posts on the binding again',
    why: 'verbatim the pre-#588 behaviour: bind and write are one event again, so a task bound this run gets its link this run, pointing at a placeholder nobody has written.',
    find: '      if (!alreadyLinked && !docHasBeenWritten(content, docMeta.docId)) {',
    replace: '      if (false) {',
  },
  {
    id: 'M2',
    file: BRIDGE,
    what: 'the deferral stops being counted',
    why: 'a link withheld silently and a link never due are the same silence from outside. Without the counter a stalled rollout -- tasks bound weeks ago that no wake reached -- is invisible in the run summary, which is the #346 shape rebuilt inside the fix for it.',
    find: '        out.linkDeferredUnwritten = true',
    replace: '        out.linkDeferredUnwritten = false',
  },
  {
    id: 'M3',
    file: BRIDGE,
    what: 'the gate stops being scoped to the first post',
    why: 'drops the forward-only promise: a link already in the topic would start being withheld, so messages he has already seen change behaviour retroactively instead of the build being corrected going forward.',
    find: '      if (!alreadyLinked && !docHasBeenWritten(content, docMeta.docId)) {',
    replace: '      if (!docHasBeenWritten(content, docMeta.docId)) {',
  },
  {
    id: 'M4',
    file: DEEPLINK,
    what: 'the binding marker itself counts as evidence the doc was written',
    why: 'the load-bearing half of the signal. The marker names the doc BY DEFINITION, so counting it makes every bound task look written and restores the original bug exactly -- while leaving a predicate that still looks like it is checking something.',
    find: "  const withoutMarkers = content.replace(new RegExp(DOC_META_RE.source, 'gi'), '')\n  return withoutMarkers.includes(id)",
    replace: '  return content.includes(id)',
  },
];

if (!IN_REPO) {
  console.log('mutcheck-doc-link-written (#588)');
  console.log(
    '\n  NOT APPLICABLE -- this guard mutates repo source and runs the repo test suite, so it\n' +
      '  only means anything inside a checkout. It is here because sync-oa-home rule 4 delivers\n' +
      '  every mutcheck to the flat home; there is no repo here to assert about. Run it from\n' +
      '  plugins/overnight-agent/checks in the repo, where CI does.',
  );
  process.exit(0);
}

for (const f of [BRIDGE, DEEPLINK, VITEST]) {
  if (!existsSync(f)) {
    // Reached only INSIDE a checkout, where all three must exist. A missing subject is the
    // loudest finding this file can produce; exiting 0 would be the fail-silent shape in the
    // guard itself.
    console.error(
      `\n  FAIL missing subject -- ${f} does not exist.\n` +
        '  This is a repo checkout, so it should. Either the #588 gate was deleted along with\n' +
        '  the file holding it, or dependencies were never installed (npm ci).',
    );
    process.exit(1);
  }
}

const originals = new Map([
  [BRIDGE, readFileSync(BRIDGE, 'utf8')],
  [DEEPLINK, readFileSync(DEEPLINK, 'utf8')],
]);

// Anchors are authored with \n; the working tree may hold \r\n (it does on Windows, and CI
// checks out on Linux). Normalising the ANCHORS to what each file actually uses keeps the
// check honest on both -- hardcoding either would make the ABSENCE arm fire on the wrong
// platform and read as "the gate was deleted" when nothing had changed.
for (const arm of ARMS) {
  const eol = originals.get(arm.file).includes('\r\n') ? '\r\n' : '\n';
  arm.find = arm.find.split('\n').join(eol);
  arm.replace = arm.replace.split('\n').join(eol);
}

let dirty = new Set();

function restore() {
  for (const f of dirty) writeFileSync(f, originals.get(f), 'utf8');
  dirty = new Set();
}
process.on('exit', restore);
process.on('SIGINT', () => {
  restore();
  process.exit(130);
});

console.log('mutcheck-doc-link-written (#588)');

try {
  console.log('\nBASELINE');
  check('the suite passes on the real source', runSuite(), 'the gate or its tests are already broken');

  console.log('\nABSENCE -- is the subject even here?');
  for (const arm of ARMS) {
    const seen = originals.get(arm.file).split(arm.find).length - 1;
    check(
      `${arm.id} anchor is present exactly once`,
      seen === 1,
      seen === 0
        ? `NOT FOUND. Either the #588 gate was removed, or it was rewritten and this arm now asserts about code that does not exist. Both are findings: ${arm.what}`
        : `found ${seen} times, so a mutation would hit more than one site and the arm no longer isolates one behaviour`,
    );
  }

  console.log('\nMUTATIONS -- each must turn the suite red');
  for (const arm of ARMS) {
    const src = originals.get(arm.file);
    if (src.split(arm.find).length - 1 !== 1) {
      check(`${arm.id} ${arm.what}`, false, 'skipped: anchor missing (see ABSENCE above)');
      continue;
    }
    dirty.add(arm.file);
    writeFileSync(arm.file, src.split(arm.find).join(arm.replace), 'utf8');
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
