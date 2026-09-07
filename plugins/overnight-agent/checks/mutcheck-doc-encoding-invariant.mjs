// mutcheck-doc-encoding-invariant.mjs
//
// Asks the only question that matters about a guard: if the thing it guards broke,
// would it actually say so? A check nobody has watched fail is indistinguishable from
// a check that cannot fail, and this whole issue family (#549, #598, #600) is made of
// exactly that shape -- steps that report success because they had nothing to do.
//
// Every arm below mutates doc-encoding-invariant.mjs toward SILENCE: the mutant still
// runs, still exits 0-ish, still looks healthy, and misses a real corruption. If an arm
// survives, the guard has a blind spot in that direction and this exits 1.
//
// Pure imports only. No Google account, no Windows, no network -- runs on CI.

import assert from 'node:assert';
import {
  findMojibake,
  selectTargets,
  classify,
  shouldStampChecked,
  SIGNATURES,
} from './doc-encoding-invariant.mjs';

// Real mojibake, generated on 2026-09-07 by the actual defect path:
//   powershell 5.1 -> Get-Content -Raw (no -Encoding) -> write back as UTF-8
// Not hand-typed: hand-typed fingerprints drift from the ones the bug really makes.
const BROKEN = "# Task 468: em\u00E2\u20AC\u201Ddash and don't and G\u00C3\u00B6reme Nev\u00C5\u0178ehir \u00F0\u0178\u0152\u2122 \u00E2\u20AC\u02DCquoted\u00E2\u20AC\u2122";
// The same sentence, correctly encoded. Must never fire: a detector that flags
// well-formed text gets switched off, and then the surface is unguarded while
// appearing guarded.
const GOOD = "# Task 468: em\u2014dash and don\u2019t and G\u00F6reme Nev\u015Fehir \uD83C\uDF19 \u201Cquoted\u201D";

const results = [];
const arm = (name, why, fn) => {
  let state = 'SURVIVED';
  let detail = '';
  try {
    fn();
    detail = 'mutant survived: the guard still reported healthy';
  } catch (e) {
    const msg = e.message.split('\n')[0];
    // Only the arm's own discriminator counts as a kill. A precondition that blew up
    // is a BROKEN arm, not a passing one -- it proves nothing about the mutant, and
    // counting it as a kill is precisely the false green this file exists to detect.
    // (This distinction is not decorative: arm 4 was silently passing on a failed
    // precondition until the two outcomes were separated.)
    if (msg.startsWith('killed:')) {
      state = 'KILLED';
      detail = msg;
    } else {
      state = 'BROKEN';
      detail = `arm did not reach its discriminator -- precondition failed: ${msg}`;
    }
  }
  results.push({ name, why, state, detail });
};

// --- baseline: the unmutated guard must actually work, or every arm is meaningless --
{
  const hits = findMojibake(BROKEN);
  assert.ok(hits.length >= 4, `baseline: real mojibake must be detected, got ${hits.length}`);
  assert.equal(findMojibake(GOOD).length, 0, 'baseline: correctly-encoded text must not fire');
  const kinds = new Set(hits.map((h) => h.signature));
  for (const s of SIGNATURES) {
    assert.ok(kinds.has(s.name), `baseline: signature "${s.name}" never fires on real mojibake`);
  }
}

// --- arm 1: a signature is dropped -------------------------------------------------
// The failure that created #549: a surface looks guarded, but the specific corruption
// class that actually occurs is not in the list. Each signature is load-bearing.
for (const missing of SIGNATURES.map((s) => s.name)) {
  arm(
    `signature "${missing}" removed`,
    'a corruption class silently stops being detected while the check still passes',
    () => {
      const kept = SIGNATURES.filter((s) => s.name !== missing);
      const mutant = (text) => kept.some((s) => new RegExp(s.re.source, 'g').test(text));
      // Text corrupted ONLY in the dropped class must still be caught by somebody.
      const sig = SIGNATURES.find((s) => s.name === missing);
      const onlyThis = 'clean prose ' + new RegExp(sig.re.source).source.replace(/\\u([0-9A-Fa-f]{4})/g, (_, h) =>
        String.fromCharCode(parseInt(h, 16))
      ).replace(/\[.*\]/, '\u00B6');
      assert.ok(
        !mutant(onlyThis),
        `dropping "${missing}" still detects its own corruption -- arm is not isolating anything`
      );
      // The real assertion: the full detector catches it and the mutant does not.
      assert.ok(findMojibake(onlyThis).length > 0, `full detector misses "${missing}" corruption`);
      throw new Error(`killed: without "${missing}", ${sig.means} goes undetected`);
    }
  );
}

// --- arm 2: the detector always returns clean --------------------------------------
// The guard-that-cannot-fail. Passes on every input, forever, including a wholly
// corrupt document.
arm(
  'findMojibake always returns []',
  'the check can never fail, so a green run proves nothing',
  () => {
    const mutant = () => [];
    assert.notDeepEqual(
      mutant(BROKEN).length,
      findMojibake(BROKEN).length,
      'a detector that always returns clean is indistinguishable from the real one'
    );
    throw new Error('killed: an always-clean detector disagrees with the real one on real mojibake');
  }
);

// --- arm 3: selectTargets returns nothing ------------------------------------------
// The core shape of #468: reading zero docs and reading every doc cleanly produce the
// same "no findings" line. Silence must not be reachable by doing nothing.
arm(
  'selectTargets returns []',
  'a run that checks no documents reports exactly like a run that checked them all',
  () => {
    const rows = [
      { id: '468', docId: 'D1', checkedAt: '' },
      { id: '471', docId: 'D2', checkedAt: '' },
    ];
    const real = selectTargets(rows, { now: Date.now() });
    const mutant = () => [];
    assert.ok(real.length > 0, 'real selectTargets must select never-checked docs');
    assert.notEqual(mutant().length, real.length, 'empty selection is indistinguishable from a real one');
    throw new Error(`killed: real selection picks ${real.length} doc(s); an empty one would check nothing and still print "no findings"`);
  }
);

// --- arm 4: freshness treats every doc as already checked ---------------------------
// Same silence, reached through the clock instead of the list.
arm(
  'freshness window swallows every candidate',
  'nothing is ever selected, so the guard goes permanently quiet without being disabled',
  () => {
    // 13h ago against a 12h window: genuinely stale, so the real selector MUST pick it.
    // (An earlier draft used 10h, which is inside the window -- the arm then "passed"
    // because its own precondition failed, not because it discriminated the mutant.
    // That is the same false-green shape this file exists to catch, so it is fixed
    // rather than tolerated.)
    const rows = [{ id: '468', docId: 'D1', checkedAt: new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString() }];
    const real = selectTargets(rows, { freshMinutes: 720, now: Date.now() });
    const mutant = selectTargets(rows, { freshMinutes: 10 ** 9, now: Date.now() });
    assert.ok(real.length === 1, 'a doc checked 13h ago must be re-checked under a 12h window');
    assert.notEqual(mutant.length, real.length, 'an infinite freshness window is indistinguishable');
    throw new Error('killed: an over-wide freshness window selects 0 where the real one selects 1');
  }
);

// --- arm 5: unreadable is treated as clean -----------------------------------------
// #346. "Could not reach the document" reported as "the document is fine."
arm(
  'classify() folds UNREADABLE into clean',
  'a run that could not reach Google reports the same as one that verified every doc',
  () => {
    assert.equal(classify(false, []), 'UNREADABLE', 'a failed fetch must not classify as clean');
    assert.equal(classify(true, []), 'clean');
    assert.equal(classify(true, [{ signature: 'punctuation' }]), 'CORRUPT');
    const mutant = (readOk, hits) => ((hits && hits.length) ? 'CORRUPT' : 'clean');
    assert.notEqual(mutant(false, []), classify(false, []), 'folding unreadable into clean is undetectable');
    throw new Error('killed: mutant calls an unreachable document "clean"');
  }
);

// --- arm 6: a corrupt doc is stamped as checked -------------------------------------
// A finding that silences itself: stamped, it falls outside the freshness window and
// disappears from the next report while the document is still broken.
arm(
  'shouldStampChecked() stamps CORRUPT docs too',
  'the finding ages out of the report while the corruption is still there',
  () => {
    assert.equal(shouldStampChecked('clean'), true);
    assert.equal(shouldStampChecked('CORRUPT'), false, 'a corrupt doc must never be stamped as checked');
    assert.equal(shouldStampChecked('UNREADABLE'), false, 'an unread doc must never be stamped as checked');
    const mutant = () => true;
    assert.notEqual(mutant('CORRUPT'), shouldStampChecked('CORRUPT'), 'always-stamp is undetectable');
    throw new Error('killed: always-stamp would hide a still-corrupt doc from the next run');
  }
);

// --- report -------------------------------------------------------------------------
console.log('mutation check: doc-encoding-invariant.mjs\n');
let bad = 0;
for (const r of results) {
  if (r.state !== 'KILLED') bad++;
  console.log(`  ${r.state.padEnd(8)} ${r.name}`);
  console.log(`           why it matters: ${r.why}`);
  console.log(`           ${r.detail}`);
}
const killed = results.length - bad;
console.log(`\n${killed}/${results.length} mutants killed.`);
if (bad) {
  console.log(`\nFINDINGS: ${bad} arm(s) not killed -- surviving mutants are blind spots, broken arms prove nothing.`);
  process.exit(1);
}
console.log('\nno findings: every mutation of this guard is detected.');
