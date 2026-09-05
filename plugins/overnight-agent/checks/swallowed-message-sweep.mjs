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
// 1. Decide whether the trailing region is one this sweep is responsible for. There are two
//    ways in, and the second one exists because the first one had a hole:
//
//    a. INVISIBLE. No `## ` heading after the agent's last anchor and no
//       `<!-- /overnight-agent turn-end -->` stamp. oa-state.ps1 cannot see a boundary here, so
//       nothing else is going to report it. This is what makes the #218 near-miss a
//       non-candidate on principle rather than by eye: its raw lowercase prose sits under a
//       `## 2026-07-28` heading.
//
//    b. ABSORBED (GH #501, added 2026-09-04). A bounded region -- stamp and headings present --
//       whose `<!-- from: me -->` block has been BASELINED OVER: the state store's
//       `processed_file_hash` already equals the journal's current hash, so `changed` is false
//       and the reopen machinery reads the row as quiet.
//
//       This branch exists because step 1a rested on a premise that turned out to be false:
//       "if a boundary exists the reopen machinery can already see the reply, so it is not
//       swallowed." On 2026-09-04 this sweep scanned 244 journals and reported
//       `no unanswered message found at the bottom of any journal` while task-245 held THREE of
//       Shiv's messages, dated 2026-09-03, under a turn-end stamp. It has both a stamp and `##`
//       headings, so 1a excluded it by design -- on the explicit assumption that the machinery
//       had it covered. The machinery had dropped it: the status was an AGENT-declared `done`,
//       and an `oa-state mark` 62 seconds after the messages landed cleared `changed` and
//       `reopened_closed`.
//
//       The two mechanisms had DISJOINT ASSUMPTIONS AND A SHARED GAP -- this sweep assumed the
//       reopen machinery handled bounded regions, and the reopen machinery discarded them on
//       `done`. #245 fell between them for over a day on a Today row. So the premise is now
//       CHECKED rather than assumed, against the same two files oa-state.ps1 reads.
//
//       It is narrowed the same way #501 narrows the main fix, and by the same authority:
//       SKILL.md's "Completion is the USER's action in the Focus Planner app". A row the USER
//       closed -- present on planner-completed.md, or on neither board -- is excluded. A row
//       still sitting on planner.md is open work, whatever the skill's status says, so an
//       unanswered message on it is reported.
//
//       An absorbed hit is `certain` by construction: it carries Shiv's own marker, and the
//       hash proves a re-snapshot has already run over it. No prose heuristic is involved.
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
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const planner = process.env.PLANNER_PATH || 'C:\\Users\\shiv\\OneDrive\\Apps\\Focus Planner';
const stateDir =
  process.env.OA_STATE_DIR ||
  join(process.env.LOCALAPPDATA || join(process.env.USERPROFILE || '', 'AppData', 'Local'),
       'overnight-agent', 'state');

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

// GH #501: the ABSORBED branch. A bounded trailing region still holding one of Shiv's own
// `<!-- from: me -->` messages, on a row that is still OPEN WORK, which a re-snapshot has
// already baselined over.
//
// `ctx` is what the caller knows about the task from OUTSIDE the journal, because none of it can
// be read from the file itself:
//   onBoard        the id has a row on planner.md            (open work)
//   userCompleted  the id has a row on planner-completed.md  (he closed it, in the app)
//   absorbed       the state store's processed_file_hash already equals this file's hash, so
//                  `changed` is false and the reopen machinery reads the row as quiet
//
// All three conditions are required, and each one removes a different kind of noise:
// without `absorbed` this would fire on every live conversation the moment Shiv replies (the
// machinery is handling those, loudly); without `onBoard`/`userCompleted` it would re-report
// every completed task he ever answered on.
function absorbedUserMessage(content, ctx) {
  if (!ctx || !ctx.absorbed) return null;
  if (ctx.userCompleted || !ctx.onBoard) return null;

  const sentinel = content.lastIndexOf('OVERNIGHT-AGENT do not edit');
  let self = -1;
  for (const m of content.matchAll(PROV)) {
    if (m[1].trim() === 'overnight-agent') self = m.index;
  }
  const anchor = Math.max(self, sentinel, content.lastIndexOf('<!-- oa-state'));
  if (anchor < 0) return null;

  // The region below the agent's last anchor, and specifically below the last turn-end stamp
  // when there is one -- that stamp is where `mark` said its turn finished, so anything under it
  // arrived afterwards.
  let from = anchor;
  // `\r?$` rather than `$`: these journals are written with CRLF on Windows, and a bare `$`
  // under the `m` flag will not match a line that ends `-->\r`. The shipped PowerShell reader
  // ($script:TurnEndRe) spells it the same way, for the same reason.
  for (const m of content.slice(anchor).matchAll(/^[ \t]*<!--[ \t]*\/overnight-agent[ \t]+turn-end[ \t]*-->[ \t]*\r?$/gm)) {
    from = anchor + m.index + m[0].length;
  }
  const region = content.slice(from);
  if (!region.trim()) return null;

  // The FIRST of his messages that no turn of this agent's has been written below -- not the
  // last. All three of #245's messages are unanswered, and quoting only the newest would report
  // the smallest part of the loss: the requirement ("3 lines, 2 transferred, 1 net new") and the
  // programme link are in the earlier two.
  //
  // So: find where this agent last spoke inside the region, then take everything of his after
  // that point. An agent turn below a message is what answering looks like on disk, which is
  // also the clearing condition -- once one is written, there is no `me` marker after it and
  // this returns null on its own.
  let lastAgent = -1;
  for (const m of region.matchAll(PROV)) {
    if (m[1].trim() === 'overnight-agent') lastAgent = m.index + m[0].length;
  }
  for (const m of region.matchAll(/^[ \t]*##[^\r\n]*Overnight Agent[^\r\n]*$/gm)) {
    lastAgent = Math.max(lastAgent, m.index + m[0].length);
  }
  let firstMine = -1;
  for (const m of region.matchAll(PROV)) {
    if (m[1].trim() === 'me' && m.index >= lastAgent) { firstMine = m.index; break; }
  }
  if (firstMine < 0) return null;

  const text = region.slice(firstMine).replace(PROV, '').split(/\r?\n/)
    .map((l) => l.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) return null;

  let heading = '';
  const before = region.slice(0, firstMine).split(/\r?\n/);
  for (let h = before.length - 1; h >= 0; h--) {
    if (/^[ \t]*#{1,6}\s/.test(before[h])) { heading = before[h].trim(); break; }
  }

  return {
    text,
    confidence: 'certain',
    absorbed: true,
    heading,
    afterSignoff: false,
    above: '(below the turn-end stamp; already baselined over by oa-state mark)',
  };
}

// A candidate is trailing prose, inside an invisible region, that the provenance markers or
// the house-style test say the agent did not write -- OR one of his messages in a BOUNDED
// region that a re-snapshot has already absorbed (#501).
function findSwallowed(content, ctx) {
  const absorbed = absorbedUserMessage(content, ctx);
  if (absorbed) return absorbed;
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

// Task #245's trailing region, verbatim in shape: three separate `## <date>` entries, each with
// its own `<!-- from: me -->` marker, carrying new requirements rather than a nudge.
const MESSAGES_245 = `
## 2026-09-03

<!-- from: me -->
Give me link to catch up doc

## 2026-09-03

<!-- from: me -->
Amy needs 3 lines. 2 can be transferred from my account. 1 net new. They have
https://www.xfinity.com/support/articles/comcast-broadband-opportunity-program

## 2026-09-03

<!-- from: me -->
What are options on xfinity, since they can bundle phone and internet`;

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

  // ---- GH #501: the bounded-but-absorbed class -----------------------------------------
  // task-245, reproduced: a turn-end stamp AND `## ` headings (so 1a excludes it), three
  // `<!-- from: me -->` messages beneath, on a row still in planner.md Today, already baselined
  // over by a `mark`. This is the case that scanned clean on 2026-09-04 while holding three of
  // Shiv's messages, and it is the reason this file grew a second way in.
  ['945', `${TURN}\n<!-- /overnight-agent turn-end -->\n${MESSAGES_245}`, true,
    'the #245 shape: bounded, from:me, on the live board, absorbed by a re-mark',
    { onBoard: true, userCompleted: false, absorbed: true }],

  // GUARD: the same journal BEFORE the re-snapshot. `changed` is still true, so the reopen
  // machinery is reporting it loudly right now and this sweep must not double-report.
  ['946', `${TURN}\n<!-- /overnight-agent turn-end -->\n${MESSAGES_245}`, false,
    'GUARD: not yet absorbed -- the reopen machinery still sees it',
    { onBoard: true, userCompleted: false, absorbed: false }],

  // GUARD: the #170 rule, unchanged. Identical journal, but Shiv completed the task in the app,
  // so the row is on planner-completed.md. Reported by the closed-reply path, not by this one.
  ['947', `${TURN}\n<!-- /overnight-agent turn-end -->\n${MESSAGES_245}`, false,
    'GUARD: a task the USER completed is not open work',
    { onBoard: false, userCompleted: true, absorbed: true }],

  // GUARD: answered. The agent opened a turn BELOW his messages, which is what answering looks
  // like on disk, so the finding must clear itself without anyone having to say so.
  ['948',
    `${TURN}\n<!-- /overnight-agent turn-end -->\n${MESSAGES_245}\n\n## 2026-09-05 Overnight Agent\n\n<!-- from: overnight-agent -->\nHere is the doc link, and the three lines are ordered.\n`,
    false, 'GUARD: an agent turn below the messages answers them',
    { onBoard: true, userCompleted: false, absorbed: true }],
];

function runFixtures() {
  const failures = [];
  for (const [id, content, expected, why, ctx] of FIXTURES) {
    const actual = findSwallowed(content, ctx) !== null;
    if (actual !== expected) failures.push({ id, expected, actual, why });
  }
  return failures;
}

// ---------------------------------------------------------------------------------------
// The board and the state store, read exactly as oa-state.ps1 reads them. This is what turns
// step 1b's premise from an assumption into a check (#501).
// ---------------------------------------------------------------------------------------

// The same row shape both boards use: `| <id> | ... |`, id in the first cell.
function boardIds(file) {
  const ids = new Set();
  if (!existsSync(file)) return ids;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*\|\s*(\d+)\s*\|/.exec(line);
    if (m) ids.add(m[1]);
  }
  return ids;
}

// `changed` is false when the stored hash already covers the file as it stands -- i.e. a `mark`
// or `resnapshot` has baselined over whatever is in it, including any unanswered message.
// A MISSING state file is NOT absorbed: an untracked task is one the machinery has never
// snapshotted, so nothing has been hidden and this branch has no business firing.
function isAbsorbed(id, content) {
  const p = join(stateDir, `task-${id}.json`);
  if (!existsSync(p)) return false;
  let st;
  // STRIP THE BOM. `Write-State` uses `Set-Content -Encoding UTF8`, which under Windows
  // PowerShell 5.1 emits a BOM, and `JSON.parse` rejects it outright. Without this the parse
  // throws for EVERY task, the catch returns false, and the whole #501 branch is dead code that
  // reports a clean sweep -- which is the exact failure mode this branch exists to fix, one
  // level down. Measured while writing it: 244/244 journals silently took the catch.
  try { st = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return false; }
  if (!st || !st.processed_file_hash) return false;
  return createHash('sha256').update(content, 'utf8').digest('hex') === st.processed_file_hash;
}

// ---------------------------------------------------------------------------------------
const fixtureFailures = runFixtures();

const onBoard = boardIds(join(planner, 'planner.md'));
const completed = boardIds(join(planner, 'planner-completed.md'));

const jdir = join(planner, 'journal');
const hits = [];
let total = 0;
for (const f of readdirSync(jdir)) {
  if (!/^task-\d+\.md$/.test(f)) continue;
  total += 1;
  const id = f.replace(/^task-|\.md$/g, '');
  const content = readFileSync(join(jdir, f), 'utf8');
  const hit = findSwallowed(content, {
    onBoard: onBoard.has(id),
    userCompleted: completed.has(id),
    absorbed: isAbsorbed(id, content),
  });
  if (hit) hits.push({ id, ...hit });
}

console.log(`journals scanned: ${total}`);
console.log(`board rows: ${onBoard.size} open, ${completed.size} completed`);
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
    h.absorbed
      ? "CERTAIN - his own <!-- from: me --> marker, already baselined over by oa-state mark (#501)"
      : h.confidence === 'certain'
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
