// mutcheck-self-attested-gate.mjs
//
// Mutation check for self-attested-gate-sweep.mjs.
//
// A checker that cannot fail proves nothing. This file does two jobs:
//
//   1. BEHAVIOUR — the sweep must flag the shape that was missed live (#448: a gate on a
//      local file copy the ask itself certifies is backed up and changes nothing), and must
//      stay quiet on every shape that is a legitimate gate or ordinary prose.
//
//   2. LOAD-BEARING — each guard is then individually disabled, and the check asserts the
//      verdict CHANGES. A guard that can be removed without changing any verdict is dead
//      code pretending to be a safety property. Two sweeps in this suite have already
//      shipped with exactly that (see run-sweeps.ps1 and the owned-target-gate note about a
//      suppressor that never fired and was deleted).
//
// Run:  node mutcheck-self-attested-gate.mjs
// exit 1 = a defect in the sweep.

import { judge } from './self-attested-gate-sweep.mjs';

let pass = 0;
const fails = [];

function check(name, cond, why) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fails.push({ name, why }); console.log(`  FAIL  ${name} -- ${why}`); }
}

// ---------------------------------------------------------------------------------------
// THE FIX: the exact shape that went undetected on 2026-08-27
// ---------------------------------------------------------------------------------------
console.log('\nTHE FIX: a gate on work the ask itself certifies is reversible');

const askDirect =
  'One word, and here is what each one means with no context loaded: **`deploy it`** — copy ' +
  'the fixed script into the plugin that actually runs on this machine. What it costs: ' +
  'nothing visible; it is a file copy with a backup, and I measured that it changes no ' +
  'current verdict.';

check(
  'direct ask: attestation and token in the same turn',
  judge(askDirect) !== null,
  'a local, backed-up file copy gated behind one word is the defect this sweep exists for',
);

// #448's LIVE ask was a pointer; the justification was five turns up. This is the norm for
// anything that waits more than one night, so it is the case that actually matters.
const journal448 =
  'earlier noise\n\n' + askDirect + '\n\n' +
  '**Needs from you:** nothing new — the pending **`deploy it`** decision from the 02:54 entry above.\n\n' +
  '**Needs from you:** nothing new. The **`deploy it`** decision from the entries above still stands.\n\n' +
  '**Needs from you:** nothing new. The **`deploy it`** decision above still stands, word for word.';
const askCarried = 'nothing new. The **`deploy it`** decision above still stands, word for word.';

check(
  'carried-forward ask: attestation resolved from an earlier turn',
  judge(askCarried, journal448) !== null,
  'an ask re-stated as a pointer must still be judged, or every waiting ask is invisible',
);

check(
  'the back-walk skips intermediate pointers to reach the real justification',
  (judge(askCarried, journal448) || {}).via === 'carried-forward:deploy it',
  'stopping at the nearest earlier mention finds another pointer and gives up -- the bug this had on first write',
);

// ---------------------------------------------------------------------------------------
// THE DEAFNESS TESTS: legitimate gates and ordinary prose must stay quiet
// ---------------------------------------------------------------------------------------
console.log('\nTHE DEAFNESS TESTS: everything that is NOT this defect must stay quiet');

check(
  'no attestation -> quiet',
  judge('One word — **`deploy it`** and I will push the change to the shared server.') === null,
  'without the agent certifying reversibility there is no evidence, and this would flood',
);

check(
  'external token -> quiet even when the prose claims safety',
  judge('One word — **`merge`**. It is easily reversible and backed up.') === null,
  'merging is gated by SKILL.md regardless of how safe the agent believes it is',
);

check(
  'send is gated regardless of attestation',
  judge('One word — **`send`** — the draft is reversible and nothing is published.') === null,
  'sending mail is an external side effect; attestation must not unlock it',
);

check(
  'no gate phrasing -> quiet (narration, not an ask)',
  judge('I deployed it. It was a file copy with a backup and it changes nothing.') === null,
  'past-tense narration is the work being done correctly, not a gate',
);

check(
  'no command token -> quiet',
  judge('One word from you and I will proceed; it is easily reversible.') === null,
  'without a concrete token there is nothing identifiable being gated',
);

check(
  'a backticked filename is not a command token',
  judge('One word and I will act. It is reversible. See `planner.md` and `--dry-run`.') === null,
  'inline code is everywhere in these journals; treating it as a token would flood',
);

check(
  'carry-forward resolution requires carry-forward phrasing',
  judge('One word — **`deploy it`** please.', journal448) === null,
  'without it the sweep would mine unrelated history for any token it sees',
);

check(
  'mixed ask is still flagged (reversible half should already be done)',
  judge('One word — **`merge 189`** when you have looked. The `clean the rest` offer, which is reversible, still stands.') !== null,
  'SKILL.md: do the reversible half now and gate only the rest',
);

// ---------------------------------------------------------------------------------------
// LOAD-BEARING: disable each guard, assert the verdict changes
// ---------------------------------------------------------------------------------------
console.log('\nLOAD-BEARING: each guard must change a verdict when removed');

// Rather than editing the module, drive the guards through inputs that isolate each one.
// If a guard were absent, the paired input would flip.
check(
  'ATTEST is load-bearing',
  judge(askDirect) !== null && judge(askDirect.replace(/it is a file copy with a backup, and I measured that it changes no current verdict/, 'it will take a moment')
    .replace(/nothing visible/, 'some work')) === null,
  'removing only the attestation must silence it; if not, ATTEST is not doing the work',
);

check(
  'EXTERNAL_TOKEN suppressor is load-bearing',
  judge('One word — **`deploy it`**. It is a file copy with a backup.') !== null &&
  judge('One word — **`send it`**. It is a file copy with a backup.') === null,
  'swapping only the token from a local action to an external one must silence it',
);

check(
  'GATES is load-bearing',
  judge('One word — **`deploy it`**. It is a file copy with a backup.') !== null &&
  judge('Yesterday **`deploy it`** happened. It was a file copy with a backup.') === null,
  'removing only the gating phrasing must silence it',
);

console.log('');
if (fails.length) {
  console.log(`FAILED - ${fails.length} of ${pass + fails.length} assertions.`);
  process.exit(1);
}
console.log(`ALL GREEN - ${pass} assertions passed.`);
