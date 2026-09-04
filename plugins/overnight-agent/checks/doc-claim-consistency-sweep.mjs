// doc-claim-consistency-sweep.mjs — does an agent-authored document agree with its own numbers?
//
// WHY THIS FILE EXISTS (GH #492)
// ------------------------------
// A task sub-session wrote an appendix recommending a travel routing and described its cost as:
//
//     "Business days Kiley spends: exactly 5 (Mon 16 -> Fri 20). That is her allowance with
//      nothing unpaid"
//
// The SAME document states, in its own fixed-points table:
//
//     | Kiley's leave | 4 days paid, then unpaid; planning around 5 business days |
//
// Five spent against four paid is one unpaid day. The recommendation advertised as costing
// nothing cost a day of his partner's pay, and the false premise was load-bearing for the
// advice -- the closing line argued for that option precisely BECAUSE it spent no leave. It
// then propagated to the notification email, which is the surface read cold on a phone.
//
// EVERY GUARD PASSED
// ------------------
// write-turn.ps1 G7/G9/G10/G11 (provenance, length, doc URL, ask), catchup-doc-sweep, the
// never-comment invariant, 63 sweeps / 9 findings -- all clean, because every one of them
// checks that a turn is WELL-FORMED. Nothing asks whether a claim agrees with the numbers
// sitting in the same file. That is a category this repo did not measure at all.
//
// It is the #471 family (a confident claim with nothing behind it) with the evidence one step
// closer: #471 asserts state never queried, this asserts state that was queried, is present,
// and is contradicted.
//
// WHY IT HAPPENS MECHANICALLY, AND WHY IT WILL RECUR
// -------------------------------------------------
// The appendix was drafted standalone BEFORE the table it contradicts existed. When the two
// were folded together nothing forced them to reconcile. The deliverable was internally
// consistent; the merged document was not. So the defect lives at the SEAM between material
// authored at different times -- and a catch-up doc grows a new seam every time a turn amends
// it. This is a property of how the agent writes, not a one-off slip.
//
// WHAT IT REPORTS
// ---------------
//   ALLOWANCE_EXCEEDED   an absolute no-cost claim ("nothing unpaid", "no extra leave") in a
//                        paragraph that also asserts a spend of M, where the document declares
//                        an allowance of N and M > N. This is the live 2026-09-02 defect.
//   TABLE_CONTRADICTION  an absolute no-cost claim naming a table row whose own cost cell is
//                        a non-zero number.
//
// SCOPE IS DELIBERATELY NARROW. The issue asks for prose/table cross-checking in general; the
// general form is a research project and the narrow form catches the real instance today. Its
// own words: "A cheap check that fires on the real case beats a general one that never ships."
// So this refuses to guess. It fires only where the document states a number, the prose states
// a conflicting number, and the prose additionally makes an ABSOLUTE claim -- the combination
// that made the travel error actionable rather than merely vague.
//
// Both rules require an explicit absolute claim. A sentence that is merely optimistic, or that
// cites a row without asserting a cost, is not a finding: an advisory that fires on ordinary
// prose is one you stop reading (#433), and this one has to survive contact with 400 journals.
//
//   node doc-claim-consistency-sweep.mjs [--json] [--file <path>]
//
// Exit 0 = clean, 1 = findings, 2 = bad invocation. Dependency-free.

import fs from 'node:fs';
import path from 'node:path';

const PLANNER = process.env.PLANNER_PATH;
if (!PLANNER) {
  console.error('PLANNER_PATH is not set. Run via run-sweeps.ps1, which exports it.');
  process.exit(2);
}
const JDIR = path.join(PLANNER, 'journal');

const asJson = process.argv.includes('--json');
const fileArgIdx = process.argv.indexOf('--file');
const singleFile = fileArgIdx !== -1 ? process.argv[fileArgIdx + 1] : null;

// --- the vocabulary -------------------------------------------------------------------------
//
// An ABSOLUTE claim: prose asserting a cost of exactly zero. Deliberately a closed list of
// phrasings rather than a general "sounds free" heuristic -- the whole point is that a finding
// here is unambiguous enough to act on without re-reading the document.
const ABSOLUTE_CLAIM = [
  /\bnothing\s+unpaid\b/i,
  /\bno\s+unpaid\b/i,
  /\bzero\s+unpaid\b/i,
  /\bno\s+extra\s+(?:leave|days?|cost|charge)\b/i,
  /\bwithout\s+(?:spending|using|costing)\b/i,
  /\bcosts?\s+(?:her|him|them|you|us)?\s*nothing\b/i,
  /\bat\s+no\s+(?:cost|charge)\b/i,
  /\bno\s+(?:additional|further)\s+(?:leave|days?|cost)\b/i,
];

// A declared ALLOWANCE: "4 days paid", "4 paid days", "4 days of paid leave".
const ALLOWANCE = [
  /(\d+)\s+days?\s+paid\b/i,
  /(\d+)\s+paid\s+days?\b/i,
  /(\d+)\s+days?\s+of\s+paid\b/i,
];

// An asserted SPEND. Requires a spending verb, so a PLAN ("planning around 5 business days")
// is not mistaken for a claim about what is actually spent -- that distinction is the whole
// difference between the table's own note and the sentence that contradicted it.
const SPEND = [
  /\bspends?\s*:?\s*(?:exactly\s+)?(\d+)/i,
  /\bspending\s+(?:exactly\s+)?(\d+)/i,
  /\buses?\s+(?:exactly\s+)?(\d+)\s+(?:business\s+)?days?\b/i,
  /\btakes?\s+(?:exactly\s+)?(\d+)\s+(?:business\s+)?days?\b/i,
];

const firstMatch = (patterns, text) => {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return { value: Number(m[1]), match: m[0] };
  }
  return null;
};

const hasAbsoluteClaim = (text) => ABSOLUTE_CLAIM.find((re) => re.test(text)) || null;

// The QUANTITY a claim is about: "nothing unpaid" is a claim about unpaid days, not about fares.
// TABLE_CONTRADICTION requires this to match the column it contradicts, because a row can carry
// several numbers and only one of them is what the sentence is denying. Measured on the live
// corpus: without it, "it takes option 3 to zero unpaid days" in a run-log bullet was matched
// against an unrelated outings table's `Cost` column via a bare date row key ("Wed 25") -- a
// confident finding about two things that have nothing to do with each other, which is precisely
// the defect this sweep exists to catch, produced by the sweep itself.
const CLAIM_NOUN = /\b(unpaid|leave|cost|charge|fee|extra|days?)\b/gi;
const claimNouns = (text) => {
  const found = new Set();
  for (const m of String(text).matchAll(CLAIM_NOUN)) found.add(m[1].toLowerCase().replace(/s$/, ''));
  return found;
};

// Sentence-sized units. A paragraph is too coarse for the row-key rule: a run-log bullet list
// parses as ONE paragraph, so an absolute claim in one bullet would pair with a row key
// mentioned in a different bullet about a different subject.
//
// But splitting on newlines alone is wrong in the opposite direction. Markdown prose is
// hard-wrapped, so a single sentence routinely spans two lines -- and the issue's own example
// wraps between "Option 4 is the one I would take" and "with nothing unpaid", which would put
// the row key and the claim in different units and silently never fire. So wrapped lines are
// REJOINED and only genuine block boundaries (list markers, headings, table rows) start a new
// unit.
const BLOCK_START = /^\s*(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|\|)/;
const sentences = (text) => {
  const units = [];
  let cur = '';
  for (const line of String(text).split(/\r?\n/)) {
    if (BLOCK_START.test(line)) {
      if (cur.trim()) units.push(cur.trim());
      cur = line;
    } else {
      cur += (cur ? ' ' : '') + line;
    }
  }
  if (cur.trim()) units.push(cur.trim());
  return units
    .flatMap((u) => u.split(/(?<=[.!?])\s+/))
    .map((s) => s.trim())
    .filter(Boolean);
};

// --- markdown table parsing -----------------------------------------------------------------
//
// Only well-formed pipe tables with a header separator are read. A malformed table is skipped
// rather than guessed at: inventing a cell value would produce a confident wrong finding, which
// is the exact failure this sweep exists to catch.
function parseTables(lines) {
  const tables = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\|/.test(lines[i])) continue;
    const sep = lines[i + 1];
    if (!sep || !/^\s*\|[\s:|-]+\|\s*$/.test(sep) || !/-/.test(sep)) continue;
    const cells = (row) =>
      row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
    const header = cells(lines[i]);
    const rows = [];
    let j = i + 2;
    for (; j < lines.length && /^\s*\|/.test(lines[j]); j++) rows.push({ line: j, cells: cells(lines[j]) });
    tables.push({ line: i, header, rows });
    i = j;
  }
  return tables;
}

// A cost column: one whose header names a quantity a no-cost claim would be about.
const COST_COL = /\b(unpaid|extra|cost|leave|charge|fee)\b/i;

// Strip markdown emphasis so `**5**` reads as 5.
const plain = (s) => String(s).replace(/[*_`]/g, '').trim();

function findingsForFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split(/\r?\n/);
  const out = [];

  // A document-level fact: the allowance is stated once, usually in a fixed-points table, and
  // the contradicting sentence can sit anywhere below it.
  const allowance = firstMatch(ALLOWANCE, raw);

  // Paragraphs, so a claim and the spend it misdescribes have to be adjacent to be paired.
  // Pairing across a whole document would manufacture contradictions between unrelated
  // sections, and a sweep whose findings need a human to re-derive is not a control.
  const paras = [];
  let cur = { start: 0, text: [] };
  lines.forEach((ln, idx) => {
    if (ln.trim() === '') {
      if (cur.text.length) paras.push({ start: cur.start, text: cur.text.join('\n') });
      cur = { start: idx + 1, text: [] };
    } else {
      if (!cur.text.length) cur.start = idx;
      cur.text.push(ln);
    }
  });
  if (cur.text.length) paras.push({ start: cur.start, text: cur.text.join('\n') });

  for (const p of paras) {
    const claim = hasAbsoluteClaim(p.text);
    if (!claim) continue;
    const spend = firstMatch(SPEND, p.text);
    if (!spend || !allowance) continue;
    if (spend.value > allowance.value) {
      out.push({
        kind: 'ALLOWANCE_EXCEEDED',
        file,
        line: p.start + 1,
        claim: claim.source,
        detail:
          `prose asserts a spend of ${spend.value} ("${spend.match.trim()}") while the document ` +
          `declares an allowance of ${allowance.value} ("${allowance.match.trim()}"), ` +
          `yet claims it costs nothing`,
        excerpt: p.text.split('\n')[0].slice(0, 120),
      });
    }
  }

  // TABLE_CONTRADICTION: an absolute claim naming a row key whose own cost cell is non-zero.
  //
  // EVERY cost-ish column is considered, not just the first. A table like
  // `| Option | Leave | Unpaid |` has two, and picking the first by findIndex measured the claim
  // "nothing unpaid" against the `Leave` column -- so the rule silently never fired on the exact
  // shape the issue describes. A guard that cannot fire is worse than no guard, because the zero
  // it reports is indistinguishable from a clean corpus.
  const tables = parseTables(lines);
  for (const t of tables) {
    const costIdxs = t.header
      .map((h, i) => (COST_COL.test(plain(h)) ? i : -1))
      .filter((i) => i !== -1);
    if (!costIdxs.length) continue;
    for (const costIdx of costIdxs) {
      const colNouns = claimNouns(plain(t.header[costIdx]));
      for (const r of t.rows) {
        const key = plain(r.cells[0]);
        if (!key || key.length < 3) continue;
        const cellRaw = plain(r.cells[costIdx] ?? '');
        const num = /(\d+(?:\.\d+)?)/.exec(cellRaw);
        if (!num || Number(num[1]) === 0) continue;
        const keyRe = new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        for (const p of paras) {
          if (p.start === t.line) continue;
          // Same SENTENCE, not merely the same paragraph, and the claim must be about the same
          // quantity the column measures. Both narrowings are load-bearing on the live corpus.
          for (const s of sentences(p.text)) {
            const claim = hasAbsoluteClaim(s);
            if (!claim) continue;
            if (!keyRe.test(s)) continue;
            const shared = [...claimNouns(s)].some((n) => colNouns.has(n));
            if (!shared) continue;
            out.push({
              kind: 'TABLE_CONTRADICTION',
              file,
              line: p.start + 1,
              claim: claim.source,
              detail:
                `prose makes an absolute no-cost claim about "${key}", but the table on line ` +
                `${t.line + 1} scores that row's ${plain(t.header[costIdx])} as ${cellRaw}`,
              excerpt: s.slice(0, 120),
            });
          }
        }
      }
    }
  }
  return out;
}

// --- corpus ---------------------------------------------------------------------------------
// Agent-authored deliverables. Backups are excluded: they are frozen copies of a file that is
// either already flagged or already fixed, so counting them would report one defect many times
// and make the number move for reasons unrelated to the documents in use.
function corpus() {
  if (singleFile) return [singleFile];
  if (!fs.existsSync(JDIR)) return [];
  return fs
    .readdirSync(JDIR)
    .filter((f) => f.endsWith('.md') && !/\.bak/i.test(f))
    .map((f) => path.join(JDIR, f));
}

const files = corpus();
const findings = [];
for (const f of files) {
  try {
    findings.push(...findingsForFile(f));
  } catch (err) {
    console.error(`could not read ${f}: ${err.message}`);
  }
}

if (asJson) {
  console.log(JSON.stringify({ scanned: files.length, findings }, null, 2));
  process.exit(findings.length ? 1 : 0);
}

console.log(`Documents contradicting their own numbers: ${findings.length}`);
console.log(`  (scanned ${files.length} agent-authored markdown files in ${JDIR})\n`);

for (const f of findings) {
  console.log(`${path.basename(f.file)}:${f.line}  ${f.kind}`);
  console.log(`     ${f.detail}`);
  console.log(`     near: ${f.excerpt}`);
  console.log('');
}

if (findings.length) {
  console.log('A claim contradicted by a number in the same document is worse than an');
  console.log('unsupported one: the evidence was present and was read past. Fix the prose or');
  console.log('the table, and do not leave the two disagreeing.');
}

process.exit(findings.length ? 1 : 0);
