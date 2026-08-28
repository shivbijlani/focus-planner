// swallowed-message-sweep.mjs
//
// GUARDS: incidence, not exposure. "Is one of Shiv's messages sitting unanswered at the
// bottom of a journal RIGHT NOW?"
//
// WHY THIS EXISTS
// ---------------
// `raw-append-reopen-sweep` measures two things: how many journals COULD swallow a reply
// (exposure, 216 of 239) and whether the installed oa-state.ps1 handles each shape of reply
// (behaviour). Neither answers the only question that finds a victim.
//
// On 2026-08-27 01:50 a run characterised the raw-append blind spot and wrote:
//
//     confirmed no message of yours has ever been lost to it
//
// That was FALSE when it was written. Task #426580 had two questions appended at EOF at
// 16:59 on 2026-08-26 -- nine hours earlier -- and read `done - nothing new` on every run in
// between. The audit had measured capability and reported a conclusion about incidence.
// Nothing in it ever read the bottom of a journal.
//
//     Rule (user-settings.md, 2026-08-27 02:30): an exposure count is not an incidence
//     count, and a detector that measures capability must never be quoted as evidence that
//     the harm has not occurred.
//
// The incidence pass was then done BY HAND, once. Until the boundary fix (PR #198) merges
// AND is deployed to the installed plugin, every night carries fresh exposure with no alarm
// on it. This sweep is that hand pass, automated, so it runs every night.
//
// HOW IT DECIDES
// --------------
// 1. Only look at journals where the trailing region is INVISIBLE to oa-state.ps1 -- no `## `
//    heading after the agent's last anchor and no `<!-- /overnight-agent turn-end -->` stamp.
//    If a boundary exists the reopen machinery can already see the reply, so it is not
//    swallowed. This is what makes the #218 near-miss a non-candidate on principle rather
//    than by eye: its raw lowercase prose sits under a `## 2026-07-28` heading.
// 2. Walk up from EOF collecting the trailing block, stopping at a blank line or at a
//    COMPLETED structural line -- a bullet/heading/bold-lead whose text ends in sentence
//    punctuation. That qualifier is the whole trick, and both halves were measured:
//      * Stopping at ANY structural line strips a WRAPPED AGENT PARAGRAPH's own opener
//        (`**Needs from you:** one word — ...`), leaving only its plain continuation lines,
//        which then read as bare prose. Live corpus: 32 candidates, and every
//        `**Needs from you:**` / `- Next:` continuation among them was a false positive.
//      * Never stopping at structure is equally wrong: the real #426580 victim sits at the
//        end of a long bullet list whose earlier items are full of house style, so the whole
//        run gets rejected and the victim is missed.
//    A wrapped continuation follows a line that ends MID-SENTENCE (`...and I'll`, `...for`);
//    a genuine new block follows a line that is finished (`- Next: complete (...).`). Live
//    corpus: 7 candidates, and the real victim shape is kept.
// 3. Ask the provenance markers first, and only fall back to prose heuristics. The nearest
//    `<!-- from: X -->` above the block is authoritative:
//      * `me`              -> a user message the agent structurally cannot see. No heuristic
//                             needed, no false-positive risk. This is how the Focus Planner
//                             app writes a completion note, and it lands BELOW the agent's
//                             last turn, i.e. inside the invisible region.
//      * `overnight-agent` -> the block is the agent's own turn body IF nothing but
//                             whitespace separates the two. If there is intervening agent
//                             content, the block was appended AFTER the turn finished --
//                             which is exactly the #426580 victim's shape.
// 4. Otherwise reject any block carrying the agent's house style (**bold**, *italic*, `code`,
//    em dash, arrows, emoji, markdown links, run-log labels) or longer than MAX_BLOCK chars.
//    The agent writes like that constantly; Shiv, typing on a phone, does not.
// 5. Report what survives, with the heading above it, because a candidate is not a victim
//    until you have read the heading above it.
//
// The exit code is deliberately asymmetric with the sibling sweep: findings here mean a
// message may be sitting unread RIGHT NOW, which is the one failure in this family that
// loses data rather than costing a look.
//
// exit 1 = findings.
import { readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const planner = process.env.PLANNER_PATH || 'C:\\Users\\shiv\\OneDrive\\Apps\\Focus Planner';

const PROV = /^[ \t]*<!--[ \t]*from:[ \t]*([^>\r\n]*?)[ \t]*-->/gm;
const TURN_END = /^[ \t]*<!--[ \t]*\/overnight-agent[ \t]+turn-end[ \t]*-->[ \t]*$/m;

const MAX_BLOCK = 320;

// The agent's house style. Any one of these in the trailing block means the agent wrote it.
// Kept deliberately broad: a false negative here costs a lost message, but a false positive
// costs one glance, and the corpus shows the agent cannot write three lines without one.
// `<!--` is in here because the legacy `<!-- oa-state {...} -->` block and provenance
// markers are machine text, never something Shiv types. `*italic*` and the run-log labels
// (`Result:` / `Next:` / `Deliverable:` opening a line) are likewise pure agent house style.
const AGENT_STYLE =
  /\*\*|`|—|–|→|↳|⇒|<!--|-->|\*[^*]{1,400}\*|^(?:Result|Next|Deliverable|Status)\s*:|\[[^\]\r\n]+\]\([^)\r\n]+\)|https?:\/\/|\p{Extended_Pictographic}/mu;

// Lines that end an agent turn. Text directly below one of these is text written after the
// agent signed off -- the exact shape of the #426580 victim, whose questions were appended
// straight under `- Next: complete (pending your one-click send).`
const AGENT_TERMINATOR =
  /^[ \t]*(?:—\s*overnight-agent|-\s*(?:Next|Result|Deliverable)\s*:|\*\*(?:Needs from you|Next|Status)\b)/i;

const STRUCTURAL = /^[ \t]*(?:#{1,6}\s|[-*+]\s|>\s|\||<!--|<\/|\d+[.)]\s|```|---|===|\*\*)/;

// A structural line whose text is finished, with the punctuation as the LAST character.
// Requiring that is load-bearing: `**Needs from you:** ... most real users today?**` ends a
// sentence but closes emphasis after it, and the line below is still the same wrapped
// paragraph. A finished agent bullet (`- Next: complete (...).`) ends bare.
const COMPLETE_TAIL = /[.!?:)"'\]]\s*$/;

function isStructural(line) {
  return STRUCTURAL.test(line);
}

// True when this line ends the block below it: a heading always does; any other structural
// line does only when its sentence is finished.
function isBlockBoundary(line) {
  if (/^[ \t]*#{1,6}\s/.test(line)) return true;
  if (/^[ \t]*(?:```|---|===)/.test(line)) return true;
  return isStructural(line) && COMPLETE_TAIL.test(line);
}

// Mirrors the shipped boundary logic in oa-state.ps1's Get-AgentEndIndex.
function trailingRegionInvisible(content) {
  const sentinel = content.lastIndexOf('OVERNIGHT-AGENT do not edit');
  let self = -1;
  for (const m of content.matchAll(PROV)) {
    if (m[1].trim() === 'overnight-agent') self = m.index;
  }
  const marker = Math.max(self, sentinel, content.lastIndexOf('<!-- oa-state'));
  if (marker < 0) return false;

  // An explicit turn-end stamp is a boundary: not exposed.
  if (TURN_END.test(content.slice(marker))) return false;

  let next = content.indexOf('\n## ', marker);
  if (marker === sentinel && next >= 0) {
    // Skip the managed "Overnight Agent" heading -- that one is the agent's own.
    const he = content.indexOf('\n', next + 1);
    next = he < 0 ? -1 : content.indexOf('\n## ', he);
  }
  return next < 0;
}

// Returns { block, above, heading } or null.
function trailingProse(content) {
  const trimmed = content.replace(/\s+$/, '');
  if (!trimmed) return null;
  const lines = trimmed.split(/\r?\n/);

  const block = [];
  let i = lines.length - 1;
  for (; i >= 0; i--) {
    if (lines[i].trim() === '') break;
    if (isBlockBoundary(lines[i])) break;
    block.unshift(lines[i]);
  }
  if (block.length === 0) return null;

  const above = i >= 0 ? lines[i] : '';

  // Nearest `#`-heading above the block, so the caller can apply the #218 rule by eye.
  let heading = '';
  for (let h = i; h >= 0; h--) {
    if (/^[ \t]*#{1,6}\s/.test(lines[h])) {
      heading = lines[h].trim();
      break;
    }
  }
  // Offset of the block within the file, found from its first line so the value is correct
  // regardless of whether the journal uses LF or CRLF.
  return { block, above, heading, offset: trimmed.lastIndexOf(block[0]) };
}

// The app writes a completion note as `<!-- from: me -->` + `**Outcome:** ...` + prose. That
// single short bold line is the only thing allowed to sit between the marker and the block.
const OUTCOME_LINE = /^\*\*[^*\r\n]{1,40}\*\*[^\r\n]{0,80}$/;

// The nearest `<!-- from: X -->` marker above `offset`, as { author, end } or null.
function nearestProvenance(content, offset) {
  let found = null;
  for (const m of content.matchAll(PROV)) {
    if (m.index >= offset) break;
    found = { author: m[1].trim(), end: m.index + m[0].length };
  }
  return found;
}

// True when nothing of substance separates a provenance marker from the block it introduces,
// so the marker really is describing THIS block. Without this, the nearest `from: me` marker
// can be far above with whole agent turns in between -- live example task-438, whose trailing
// block is an agent run log sitting under a user marker from days earlier.
function markerIntroducesBlock(between) {
  const t = between.trim();
  return t === '' || OUTCOME_LINE.test(t);
}

// A candidate is trailing prose, inside an invisible region, that the provenance markers or
// the house-style test say the agent did not write.
function findSwallowed(content) {
  if (!trailingRegionInvisible(content)) return null;
  const t = trailingProse(content);
  if (!t) return null;

  const text = t.block.join('\n');
  const prov = nearestProvenance(content, t.offset);

  let confidence;
  if (prov && prov.author === 'me' && markerIntroducesBlock(content.slice(prov.end, t.offset))) {
    // Authoritative: Shiv's own marker, immediately above, below the agent's last anchor.
    confidence = 'certain';
  } else {
    if (prov && prov.author === 'overnight-agent' &&
        content.slice(prov.end, t.offset).trim() === '') {
      // Only whitespace between the agent's marker and this block => it IS the turn body.
      return null;
    }
    if (text.length > MAX_BLOCK) return null;
    if (AGENT_STYLE.test(text)) return null;
    confidence = 'probable';
  }

  return {
    text,
    confidence,
    heading: t.heading,
    // The strongest prose shape, and the one the known victim had: the block sits directly
    // under a finished agent line (a bullet or a sign-off) rather than under a blank line.
    afterSignoff: AGENT_TERMINATOR.test(t.above),
    above: t.above.trim(),
  };
}

// ---------------------------------------------------------------------------------------
// Behavioural fixtures. A check that cannot fail is decorative, so this asserts BOTH
// directions: it must fire on the real swallowed shape and stay silent on the shapes that
// are known-good. Cases 931/934/935 are the ones that keep it from crying wolf.
// ---------------------------------------------------------------------------------------
const TURN = `# Task 9xx: synthetic

Shiv's own notes.

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## Overnight Agent

**Status:** Done - plan v1 - 2026-08-26

<!-- from: overnight-agent -->

### Run log

**2026-08-26 (overnight):**
- Did the thing.
- Next: complete (pending your one-click send).`;

const FIXTURES = [
  // The authentic #426580 shape: two questions typed straight under the agent's sign-off,
  // no heading, no marker. Verbatim from the journal.
  ['930',
    `${TURN}\nWe're you able to use browser mcp and create the event in Google calendar?\nthere may be another fremont solscitice evenet ?\n`,
    true, 'the real #426580 shape: raw questions appended under the agent sign-off'],

  // GUARD: an untouched agent turn must be silent. This is the state of most journals every
  // night, so a false positive here would bury the sweep in noise.
  ['931', `${TURN}\n`, false,
    'GUARD: an untouched agent turn is not a swallowed message'],

  // GUARD: the app-written shape. It carries a `## <date>` heading, so oa-state can already
  // see it -- reporting it here would double-report what the reopen path already handles.
  ['932', `${TURN}\n\n## 2026-08-27\n\n<!-- from: me -->\napprove\n`, false,
    'GUARD: an app-written reply has a heading, so it is visible and not swallowed'],

  // The #218 near-miss: raw lowercase prose in Shiv's voice, but under a `## <date>`
  // heading. Visible, and it was answered. Must not be reported.
  ['933', `${TURN}\n\n## 2026-07-28\n\nWe called funkotronxl at progressive pest control\n`,
    false, 'GUARD: the #218 shape -- raw prose, but under a heading, so not swallowed'],

  // GUARD: a wrapped agent paragraph. The whole paragraph is collected, so its house-style
  // markers are visible and it is rejected. This is the class that made a naive cut return
  // 72 candidates instead of 19.
  ['934',
    `${TURN}\n\n**Needs from you:** one word — **\`aim it\`** (rotate the splash block, free), or\n\`non-draining\` if you accept manual winterising and I will source the exact model\nand price it out for you today.\n`,
    false, 'GUARD: a wrapped agent paragraph is not a user message'],

  // GUARD: a turn-end stamp is an explicit boundary (PR #198). Once that ships, trailing
  // text is visible to oa-state, so this sweep must fall silent rather than duplicate it.
  ['935',
    `${TURN}\n<!-- /overnight-agent turn-end -->\nsome text typed after the stamp\n`,
    false, 'GUARD: a turn-end stamp is a real boundary, so the reply is visible'],

  // The app's completion note: Shiv's own marker, written BELOW the agent's last turn and
  // therefore inside the invisible region. Detected with certainty, no heuristics involved.
  ['936',
    `${TURN}\n\n<!-- from: me -->\n**Outcome:** Done by me\n\nBought it at Costco in the end.\n`,
    true, "the app's completion note: a <!-- from: me --> block inside the agent's turn region"],

  // GUARD: the agent's own turn body follows its own marker with nothing but whitespace
  // between. Reporting this would flag every journal in the corpus. (The live task-412
  // shape: an agent reply separated from its marker by one blank line.)
  ['937',
    `# Task 9xx: synthetic\n\n---\n<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->\n\n## Overnight Agent\n\n<!-- from: overnight-agent -->\n\nGlad it worked out. The outcome is recorded and this task remains done.\n`,
    false, "GUARD: an agent reply directly under its own marker is the turn body, not a reply"],

  // GUARD: a stale `<!-- from: me -->` marker with whole agent turns beneath it must NOT make
  // the agent's own trailing run log read as a user message. (Live task-438 shape.)
  ['938',
    `${TURN}\n\n<!-- from: me -->\ngo ahead\n\n### Run log\n\n**2026-08-23 (overnight):**\n- Did more of the thing.\n- Nothing bought, nothing booked.\n`,
    false, 'GUARD: a distant from:me marker must not certify the agent\'s own trailing run log'],
];

function runFixtures() {
  const failures = [];
  for (const [id, content, expected, why] of FIXTURES) {
    const actual = findSwallowed(content) !== null;
    if (actual !== expected) failures.push({ id, expected, actual, why });
  }
  return failures;
}

// ---------------------------------------------------------------------------------------
const fixtureFailures = runFixtures();

const jdir = join(planner, 'journal');
const hits = [];
let total = 0;
for (const f of readdirSync(jdir)) {
  if (!/^task-\d+\.md$/.test(f)) continue;
  total += 1;
  const hit = findSwallowed(readFileSync(join(jdir, f), 'utf8'));
  if (hit) hits.push({ id: f.replace(/^task-|\.md$/g, ''), ...hit });
}

console.log(`journals scanned: ${total}`);
console.log(
  `fixtures: ${FIXTURES.length - fixtureFailures.length}/${FIXTURES.length} correct`,
);

if (fixtureFailures.length) {
  console.log('\nFINDINGS: the detector itself is wrong -- live results below are untrustworthy');
  for (const f of fixtureFailures) {
    console.log(`  case ${f.id}: expected swallowed=${f.expected}, got ${f.actual} -- ${f.why}`);
  }
}

if (hits.length === 0) {
  console.log('\nno unanswered message found at the bottom of any journal.');
  process.exit(fixtureFailures.length ? 1 : 0);
}

// Certain hits first (Shiv's own provenance marker), then the strongest prose shape.
const RANK = { certain: 2, probable: 0 };
hits.sort(
  (a, b) => RANK[b.confidence] + Number(b.afterSignoff) - (RANK[a.confidence] + Number(a.afterSignoff)),
);

console.log(`\nFINDINGS: ${hits.length} journal(s) may be holding an unanswered message`);
for (const h of hits) {
  const strength =
    h.confidence === 'certain'
      ? 'CERTAIN - carries Shiv\'s own <!-- from: me --> marker'
      : h.afterSignoff
        ? 'probable - directly under an agent sign-off'
        : 'probable - trailing prose';
  console.log(`\n  task-${h.id}  [${strength}]`);
  console.log(`    under heading : ${h.heading || '(none)'}`);
  console.log(`    line above    : ${h.above || '(blank)'}`);
  for (const line of h.text.split('\n')) console.log(`    > ${line}`);
}
console.log(
  '\nA candidate is not a victim until you have read the heading above it (#218 was a near-miss).',
);
process.exit(1);
