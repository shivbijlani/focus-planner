/**
 * dead-deliverable-sweep.mjs
 *
 * WHAT IT CATCHES
 * ---------------
 * A journal turn that CLAIMS a local file exists -- "saved as X", "built X",
 * "Deliverable: X", "archived to X" -- when X is not on disk.
 *
 * WHY NOTHING ELSE SEES IT
 * ------------------------
 * Every other sweep reads the journals and reasons about their PROSE. None of
 * them leaves the text to ask the filesystem whether the artifact the prose
 * points at is actually there. So a deliverable can be written, linked, later
 * moved or deleted, and the journal keeps confidently pointing at it forever.
 * The reader (Shiv) has no way to tell a live link from a dead one without
 * clicking it.
 *
 * The worst shape of this is a claim of PRESERVATION: task-258 says the full
 * 456 KB history was "archived to journal/archive/... (nothing lost)" and then
 * replaced the journal body. If that archive is absent, the journal asserts
 * recoverability that does not exist.
 *
 * THE DISCRIMINATOR (and why a naive version is useless)
 * -----------------------------------------------------
 * Most missing-file references are CORRECT: a proposed plan says
 * "Deliverables if approved: task-460-tree-removal-quotes.md" and the file is
 * absent precisely because the plan has not been approved yet. Measured on the
 * live corpus, a naive "referenced file is missing" scan is 40 hits of which
 * ~8 are defects (20% precise). The gate that makes this shippable is TENSE:
 * only flag a reference the journal presents as ALREADY EXISTING.
 *
 * GATES (all four mutation-proven load-bearing by mutcheck-dead-deliverable.mjs)
 *   1. PLACEHOLDER  -- skip `task-<ID>.md`, globs, `{...}`: template text, not a path.
 *   2. CLAIM        -- flag only past-tense/possession phrasing; skip "if approved",
 *                      "I write", "I'll write", "on your answer", "→ write".
 *   3. ACKNOWLEDGED -- skip when the journal itself says it is gone ("no longer
 *                      exists", "both gone", "deleted", "moved to"). Documenting an
 *                      absence is not a defect; flagging it would punish honesty.
 *   4. RESOLVABLE   -- only check refs that resolve to a definite absolute path.
 *   5. QUOTED       -- skip a ref inside a quoted span: *"read and follow
 *                      `./guardrails.md`"* illustrates what another file might
 *                      say; it does not assert that the file exists.
 *
 * Exits 1 on findings, 0 when clean.
 */
import fs from 'node:fs';
import path from 'node:path';

const planner = process.env.PLANNER_PATH;
if (!planner) {
  console.error('PLANNER_PATH is not set');
  process.exit(2);
}
const journalDir = path.join(planner, 'journal');

const MD_LINK = /\[[^\]]*\]\((<[^>]*>|[^)\s]+)\)/g;
const TICK = /`([^`\n]+)`/g;

const EXT = /\.(md|json|ps1|mjs|js|csv|txt|html|htm|pdf|png|jpe?g|docx?|xlsx?)$/i;

// --- gate 1: placeholders ---------------------------------------------------
const isPlaceholder = (s) => /[<>{}*]/.test(s) || /\$\{/.test(s);

// --- gate 2: claim vs promise ----------------------------------------------
// Promise wins over claim when both appear: "Deliverables if approved: X".
const PROMISE = [
  /\bif approved\b/i,
  /\bdeliverables? if\b/i,
  /\bi(?:'| wi)?ll write\b/i,
  /\bi write\b/i,
  /\bwill (?:write|produce|create|generate|build|draft)\b/i,
  /\bon your (?:answer|word|go|approval)\b/i,
  /\bnext:.{0,40}\bwrite\b/i,
  /\b(?:then|→|->)\s*(?:i\s+)?write\b/i,
  /\bplan to\b/i,
  /\bproposed plan\b/i,
];
const CLAIM = [
  /\bsaved (?:as|at|to)\b/i,
  /\balso saved\b/i,
  /\bdeliverable:/i,
  /\barchived (?:the|to|it)\b/i,
  /\b(?:i )?(?:built|wrote|created|generated|produced|downloaded|updated|added)\b/i,
  /\bis (?:in|at)\b.*\bfolder\b/i,
  /\bre-?run anytime\b/i,
  /\bsimplified\b/i,
];

// --- gate 3: the journal admits it is gone ---------------------------------
const ACKNOWLEDGED = [
  /\bno longer exists?\b/i,
  /\b(?:both |all )?gone\b/i,
  /\bwas deleted\b/i,
  /\bdoes not exist\b/i,
  /\bmissing\b/i,
  /\bmoved to\b/i,
  /\bretire[d]?\b/i,
];

const expandVars = (s) =>
  s
    .replace(/%LOCALAPPDATA%/gi, process.env.LOCALAPPDATA || '')
    .replace(/%OneDrive%/gi, process.env.OneDrive || '')
    .replace(/%USERPROFILE%/gi, process.env.USERPROFILE || '')
    .replace(/^~/, process.env.USERPROFILE || '~');

// --- gate 4: resolvable to a definite absolute path -------------------------
const resolveRef = (raw) => {
  let s = raw.trim().replace(/^<|>$/g, '');
  try {
    s = decodeURIComponent(s);
  } catch {
    /* leave as-is */
  }
  s = expandVars(s);
  if (/^(https?|mailto|tel):/i.test(s)) return null;
  if (!EXT.test(s)) return null;
  if (/^[A-Za-z]:[\\/]/.test(s)) return s;
  if (/^(journal)[\\/]/i.test(s)) return path.join(planner, s);
  if (/^\.\.?[\\/]/.test(s)) return path.resolve(journalDir, s);
  if (/^task-\d+-/i.test(s)) return path.join(journalDir, s);
  return null;
};

const anyMatch = (res, text) => res.some((r) => r.test(text));

// --- gate 5: the reference is a QUOTED ILLUSTRATION, not a claim ------------
// task-399 L144 reads: A skill saying *"read and follow `./guardrails.md`"* ...
// The surrounding sentence is full of claim verbs ("generated", "checked"), but
// the path itself sits inside a quoted example of what some OTHER file might
// say. An illustration is never an assertion that the file exists, so a ref
// enclosed in quotes is skipped. Scoped to the quote spans only, so a claim
// that merely CONTAINS a quote elsewhere on the line is unaffected.
const QUOTE_SPAN = /"[^"]*"|\u201c[^\u201d]*\u201d|'[^']{3,}'/g;
const isQuotedIllustration = (line, raw) => {
  QUOTE_SPAN.lastIndex = 0;
  let q;
  while ((q = QUOTE_SPAN.exec(line))) {
    if (q[0].includes(raw)) return true;
  }
  return false;
};

const files = fs
  .readdirSync(journalDir)
  .filter((f) => /^task-\d+\.md$/.test(f))
  .sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')));

const findings = [];
let refsSeen = 0;
let claimRefs = 0;

for (const f of files) {
  const taskId = f.replace(/\D/g, '');
  const lines = fs.readFileSync(path.join(journalDir, f), 'utf8').split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const refs = new Set();
    let m;
    MD_LINK.lastIndex = 0;
    while ((m = MD_LINK.exec(line))) refs.add(m[1]);
    // gate 6: a markdown link's LABEL is not a path reference. `[`x.pdf`](real/path)`
    // must be judged on `real/path` only -- otherwise repairing the destination
    // leaves the sweep firing forever on the cosmetic label beside it.
    const lineNoLabels = line.replace(/\[[^\]]*\]\(([^)\s]*|<[^>]*>)\)/g, '(LINK)');
    TICK.lastIndex = 0;
    while ((m = TICK.exec(lineNoLabels))) refs.add(m[1]);
    if (!refs.size) continue;

    // Context = the line plus the previous line, so "Deliverable:\n  `x.md`"
    // and a promise sentence wrapped across two lines still gate correctly.
    const ctx = (i > 0 ? lines[i - 1] + ' ' : '') + line;

    for (const raw of refs) {
      if (isPlaceholder(raw)) continue;
      const abs = resolveRef(raw);
      if (!abs) continue;
      refsSeen++;

      if (anyMatch(PROMISE, ctx)) continue; // gate 2 (promise wins)
      if (!anyMatch(CLAIM, ctx)) continue; // gate 2 (needs a positive claim)
      claimRefs++;
      if (anyMatch(ACKNOWLEDGED, ctx)) continue; // gate 3
      if (isQuotedIllustration(line, raw)) continue; // gate 5

      if (!fs.existsSync(abs)) {
        findings.push({ taskId, line: i + 1, raw, abs, text: line.trim() });
      }
    }
  }
}

console.log(
  `journals: ${files.length}  resolvable local refs: ${refsSeen}  claimed-existing: ${claimRefs}  DEAD CLAIMS: ${findings.length}`
);

const seen = new Set();
for (const d of findings) {
  const key = `${d.taskId}::${d.abs}`;
  if (seen.has(key)) continue;
  seen.add(key);
  console.log(`\n#${d.taskId}  L${d.line}  ${d.raw}`);
  console.log(`   -> ${d.abs}`);
  console.log(`   ${d.text.slice(0, 180)}`);
}

process.exit(findings.length ? 1 : 0);
