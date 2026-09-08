#!/usr/bin/env node
/**
 * doc-figure-drift-sweep.mjs -- a number in a catch-up doc that has quietly stopped being true.
 *
 * WHY THIS FILE EXISTS (GH #594)
 * ------------------------------
 * `doc-claim-consistency-sweep.mjs` is the only thing that reads prose looking for claims that do
 * not hold, and its corpus is `PLANNER_PATH/journal/*.md` -- local disk. Since #421/#423 the
 * primary surface for a task is a GOOGLE DOC, which is not in that directory, so no sweep has
 * ever read one's body. That sweep's own comment says otherwise:
 *
 *     // Non-journal deliverables and catch-up docs keep FULL scope: they are living surfaces
 *     // rewritten in place, so every claim in them is current and fixable
 *
 * True when catch-up docs were markdown on disk; it now describes a scope the code does not have.
 *
 * MEASURED ON THE #468 DOC, 2026-09-07 18:50 PT -- the reason this is not hypothetical
 * ------------------------------------------------------------------------------------
 * The doc for the task whose entire thesis is "the doc is the surface" said `81 of 89` in FOUR
 * separate places. Live at the same moment: `89 of 125`. Both halves wrong, and wrong in the
 * pessimistic direction -- it understated coverage and understated the board. Worse, the stale
 * NUMERATOR (81) had been overtaken by the live numerator (89), which happened to equal the
 * stale DENOMINATOR, so the sentence still parsed as plausible. Nothing flagged it, because
 * nothing had ever opened the document.
 *
 * WHY EXTENDING THE EXISTING SWEEP WAS THE WRONG SHAPE
 * ----------------------------------------------------
 * #594 proposed teaching `doc-claim-consistency-sweep` to read Google Docs. Two reasons not to:
 * its vocabulary is a closed list of ZERO-COST phrasings (`costs nothing`, `no extra`) and a
 * drifted count is not an absolute claim, so extending the corpus alone changes nothing -- the
 * issue says this itself. And that file opens with "SCOPE IS DELIBERATELY NARROW", a contract
 * worth keeping intact rather than widening until it means nothing. Different corpus, different
 * vocabulary, different failure -- so: a different sweep.
 *
 * THE TWO FINDING CLASSES, AND THE ONE THAT WAS DELIBERATELY NOT BUILT
 * --------------------------------------------------------------------
 *   RESTATED  the same live figure written in more than one place. Purely structural: needs no
 *             live value and cannot be wrong about one. This is the CAUSE, and #594 names the
 *             cheaper structural fix itself -- "a live figure should appear once, and other
 *             references should point at it rather than restate it". Four restatements meant
 *             four chances to drift and, on the day it was found, a near-miss where correcting
 *             the two obvious ones would have left two stale and the document contradicting
 *             itself, which is #492.
 *
 *   STALE     an ANCHORED figure whose value differs from the live one. Anchored means its
 *             surrounding text names a quantity this sweep has been given a live value for.
 *             It refuses to guess what an unlabelled `N of M` counts, because the caller cannot
 *             act on a finding that might be about a different question.
 *
 *   UNANCHORED (rejected) -- flagging every live figure that names no denominator. #594 argues
 *             correctly that such a figure is unverifiable, but a check that fires on ordinary
 *             prose is one you stop reading (#433, whose 800-char nudge fired on every real
 *             turn), and an unanchored figure that matters is almost always restated too, so
 *             RESTATED already reaches it. Left out on purpose, not overlooked.
 *
 * WHY HISTORY IS NOT DRIFT
 * ------------------------
 * The same document says `83 of 88` inside "it WOULD HAVE refused turns on 83 of 88 rows THE
 * NIGHT IT WAS ARMED". That figure is correct forever: it records a past measurement, and
 * "correcting" it would destroy the record. So a figure is excluded when its immediate
 * neighbourhood carries a past-tense or pinned-moment marker.
 *
 * Note what is NOT such a marker: `up from 5`. It appears beside three of the four live
 * restatements, and reading it as history would have suppressed exactly the findings this sweep
 * exists to raise -- the phrase dates the COMPARISON, not the figure. That distinction is the
 * whole reason the marker list is closed and narrow rather than a general "sounds past" test.
 *
 *   node doc-figure-drift-sweep.mjs [--json] [--file <path>] [--limit=N] [--live n:m]
 *
 * Exit 0 = clean, 1 = findings, 2 = bad invocation. Dependency-free.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_LIMIT = 5;
const TERMINAL = new Set(['done', 'skip']);

/**
 * A figure is HISTORY when its own neighbourhood pins it to a past moment. Closed list, and
 * narrow on purpose: every entry here is a licence to ignore a wrong number, so a loose one
 * silences the sweep rather than merely quietening it.
 *
 * `up from`, `from N a few days ago` and `rose to` are deliberately ABSENT -- they date the
 * comparison, not the figure, and sit beside live figures constantly.
 */
export const HISTORY_MARKERS = [
  /\bwould\s+have\b/i,
  /\bthe\s+night\s+it\s+was\s+armed\b/i,
  /\bat\s+the\s+time\b/i,
  /\bwhen\s+(?:this|the)\s+page\s+was\s+(?:first\s+)?written\b/i,
  /\bused\s+to\s+be\b/i,
  /\bback\s+then\b/i,
  /\bhad\s+been\b/i,
  /\bas\s+of\s+\d/i,
];

// How far to look for each kind of context. History is judged from a TIGHT window: a marker two
// sentences away is about something else, and borrowing it would excuse a live figure. Anchors
// get a wider one because a table row puts the label in a different cell from the number.
const HISTORY_BEFORE = 70;
const HISTORY_AFTER = 70;
const ANCHOR_BEFORE = 220;
const ANCHOR_AFTER = 70;

const windowAround = (body, index, len, before, after) =>
  body.slice(Math.max(0, index - before), Math.min(body.length, index + len + after));

/**
 * PURE. No I/O, no clock, no network -- so the mutation check runs it on the Linux CI runner
 * with no state store and no Google. Same discipline as ensure-catchup-doc.mjs's `decide()` and
 * observe-bound-docs.mjs's `selectStale()`: the part with the interesting failure modes is the
 * part that must be testable without the effects.
 *
 * Returns every `N of M` in the body, each tagged with whether it reads as history.
 */
export function extractFigures(body) {
  const text = String(body || '');
  const out = [];
  // The digit class must not END on a separator. `[\d,]*` happily eats the comma in "81 of 89,
  // up from 5", producing the figure "89," -- which then hashes differently from the identical
  // "89" elsewhere, so a figure restated four times reports as 3 + 1 and the RESTATED finding
  // undercounts the exact thing it exists to count. Found by running this against a real doc.
  const re = /(\d(?:[\d,]*\d)?)\s+of\s+(\d(?:[\d,]*\d)?)/g;
  let m;
  while ((m = re.exec(text))) {
    const hist = windowAround(text, m.index, m[0].length, HISTORY_BEFORE, HISTORY_AFTER);
    out.push({
      text: `${m[1]} of ${m[2]}`,
      n: Number(String(m[1]).replace(/,/g, '')),
      m: Number(String(m[2]).replace(/,/g, '')),
      index: m.index,
      context: windowAround(text, m.index, m[0].length, ANCHOR_BEFORE, ANCHOR_AFTER),
      historical: HISTORY_MARKERS.some((rx) => rx.test(hist)),
    });
  }
  return out;
}

/**
 * PURE. `live` is a map of quantity name -> { n, m, anchors: [RegExp], label }.
 *
 * A figure is matched to a live quantity only when its context matches one of that quantity's
 * anchors. Unmatched figures are never reported as STALE: this sweep would rather miss a wrong
 * number than assert that a number about something else is wrong, because the second kind of
 * finding is the kind that gets a check switched off.
 */
export function findDrift(figures, live = {}) {
  const findings = [];
  const liveFigures = figures.filter((f) => !f.historical);

  // --- STALE ---------------------------------------------------------------------------------
  for (const f of liveFigures) {
    for (const [key, q] of Object.entries(live)) {
      if (!q || !Array.isArray(q.anchors)) continue;
      if (!q.anchors.some((rx) => rx.test(f.context))) continue;
      if (f.n === q.n && f.m === q.m) break;
      findings.push({
        kind: 'STALE',
        quantity: key,
        label: q.label || key,
        said: f.text,
        actual: `${q.n} of ${q.m}`,
        index: f.index,
      });
      break;
    }
  }

  // --- RESTATED ------------------------------------------------------------------------------
  // Grouped by the figure's own text, so two DIFFERENT figures that happen to sit near the same
  // anchor are not confused for a restatement of each other.
  const byText = new Map();
  for (const f of liveFigures) {
    if (!byText.has(f.text)) byText.set(f.text, []);
    byText.get(f.text).push(f.index);
  }
  for (const [text, at] of byText) {
    if (at.length < 2) continue;
    findings.push({ kind: 'RESTATED', said: text, count: at.length, at });
  }

  return findings;
}

/** PURE. The live coverage quantity, derived from state rows. */
export function coverageFrom(rows) {
  const open = rows.filter((r) => r && !TERMINAL.has(String(r.status || '')));
  return { n: open.filter((r) => r.docId).length, m: open.length };
}

// ---------------------------------------------------------------------------------------------
// Everything below is effects. Nothing above imports it.
// ---------------------------------------------------------------------------------------------

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (!isMain) {
  // Imported by the mutation check for the pure functions alone. Do not touch the state store.
} else {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const fileIdx = argv.indexOf('--file');
  const singleFile = fileIdx !== -1 ? argv[fileIdx + 1] : null;
  const limArg = argv.find((a) => a.startsWith('--limit='));
  const LIMIT = limArg ? Number(limArg.split('=')[1]) : DEFAULT_LIMIT;
  const liveArg = argv.find((a) => a.startsWith('--live='));

  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const PROBE = path.join(HERE, 'mcp-probe.mjs');
  const EMAIL = process.env.OA_GOOGLE_EMAIL || 'shiv@bijlanis.com';
  const STATE_DIR =
    process.env.OA_STATE_DIR ||
    (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'overnight-agent', 'state') : '');

  // The BOM is not optional paranoia: every task-*.json in the live store is written UTF-8 WITH
  // a BOM, so a bare JSON.parse throws on all 266 of them. Swallowed by the catch, that reported
  // `0 of 1` -- a sweep that had read nothing, reporting a number, in the exact shape (#346,
  // #502) where a check that cannot look is indistinguishable from one that looked.
  const readJson = (file) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
      return null;
    }
  };

  // THE UNIVERSE IS THE BOARD, not the state directory. `task-*.json` includes rows that have
  // fallen off the planner, so counting files answers a different question than the doc's
  // sentence asks -- and publishing that as the live value would commit the denominator error
  // #594 is itself about. Same universe as observe-bound-docs.mjs, deliberately.
  const stateRows = () => {
    const planner = process.env.PLANNER_PATH;
    if (!planner || !STATE_DIR) return [];
    const boardFile = path.join(planner, 'planner.md');
    if (!fs.existsSync(boardFile)) return [];
    const board = fs.readFileSync(boardFile, 'utf8');
    const rows = [];
    for (const m of board.matchAll(/^\|\s*(\d+)[,\s|]/gm)) {
      const st = readJson(path.join(STATE_DIR, `task-${m[1]}.json`));
      if (!st) continue;
      const doc = st.doc || {};
      rows.push({ id: m[1], status: String(st.status || ''), docId: doc.doc_id || '' });
    }
    return rows;
  };

  const rows = stateRows();
  let cov = coverageFrom(rows);
  if (liveArg) {
    const [n, m] = liveArg.split('=')[1].split(':').map(Number);
    if (Number.isFinite(n) && Number.isFinite(m)) cov = { n, m };
  }

  // A live value derived from nothing is worse than no live value: `0 of 0` would mark every
  // correct figure in every document STALE, which is how a check earns its way onto an ignore
  // list in one run. With no readable board the STALE class is DISABLED and said so; RESTATED
  // still runs, because it never needed a live value in the first place.
  const LIVE = {};
  const covKnown = rows.length > 0 || Boolean(liveArg);
  if (covKnown) {
    LIVE.coverage = {
      ...cov,
      label: 'bound catch-up docs of open board rows',
      anchors: [/\bbound\s+now\b/i, /\bdoc\s+coverage\b/i, /\blive\s+rows\b/i, /\bcatch-up\s+doc\b/i],
    };
  }

  /** Fetch a doc body as markdown, out-of-band through the capability probe. */
  const fetchDoc = (docId) => {
    const args = JSON.stringify({ document_id: docId, user_google_email: EMAIL });
    const r = spawnSync(process.execPath, [PROBE, 'google-workspace', 'call', 'get_doc_as_markdown', args], {
      encoding: 'utf8',
      timeout: Number(process.env.MCP_PROBE_TIMEOUT_MS) || 90000,
    });
    const raw = `${r.stdout || ''}${r.stderr || ''}`;
    const at = raw.indexOf('{');
    if (at === -1) return null;
    try {
      const parsed = JSON.parse(raw.slice(at));
      return parsed?.content?.[0]?.text ?? null;
    } catch {
      return null;
    }
  };

  const report = [];
  let unreadable = 0;

  if (singleFile) {
    const body = fs.readFileSync(singleFile, 'utf8');
    report.push({ subject: singleFile, findings: findDrift(extractFigures(body), LIVE) });
  } else {
    const bound = rows.filter((r) => r.docId && !TERMINAL.has(r.status)).sort((a, b) => Number(a.id) - Number(b.id));
    for (const t of bound.slice(0, Math.max(0, LIMIT))) {
      const body = fetchDoc(t.docId);
      if (body == null) {
        // A document that could not be read is NOT a clean document. Counting it as clean is the
        // #346/#502 shape this repo keeps paying for: a check that cannot look returns the same
        // bytes as one that looked and found nothing.
        unreadable++;
        report.push({ subject: `task ${t.id} doc ${t.docId}`, unreadable: true, findings: [] });
        continue;
      }
      report.push({ subject: `task ${t.id} doc ${t.docId}`, findings: findDrift(extractFigures(body), LIVE) });
    }
  }

  const total = report.reduce((a, r) => a + r.findings.length, 0);

  if (asJson) {
    console.log(JSON.stringify({ live: covKnown ? LIVE.coverage : null, unreadable, findings: total, report }, null, 2));
  } else {
    console.log('doc-figure-drift-sweep (#594)');
    console.log(
      covKnown
        ? `  live coverage  ${cov.n} of ${cov.m}  (${LIVE.coverage.label})`
        : '  live coverage  UNKNOWN -- no readable board, STALE disabled (RESTATED still runs)'
    );
    for (const r of report) {
      if (r.unreadable) {
        console.log(`  ${r.subject}: UNREADABLE -- not counted as clean`);
        continue;
      }
      if (!r.findings.length) {
        console.log(`  ${r.subject}: clean`);
        continue;
      }
      console.log(`  ${r.subject}:`);
      for (const f of r.findings) {
        if (f.kind === 'STALE') {
          console.log(`    STALE     "${f.said}" -- live is "${f.actual}" (${f.label})`);
        } else {
          console.log(`    RESTATED  "${f.said}" appears ${f.count} times (offsets ${f.at.join(', ')})`);
        }
      }
    }
    console.log('');
    console.log(`${total} finding(s)${unreadable ? `, ${unreadable} unreadable` : ''}.`);
  }

  process.exit(total > 0 || unreadable > 0 ? 1 : 0);
}
