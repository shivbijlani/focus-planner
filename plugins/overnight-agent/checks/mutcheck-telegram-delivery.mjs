// mutcheck-telegram-delivery.mjs
//
// Proves the three delivery sweeps grade the SHIPPED bridge rather than a local
// model of it — the exact property they each claimed in prose and violated in
// code until 2026-08-29.
//
// WHY THE MUTATION TARGET IS THE BRIDGE, NOT THE SWEEP
// ---------------------------------------------------
// The defect being pinned is not "the matcher is wrong". It is "the detector is
// wired to the wrong artifact". A mutation inside the sweep cannot detect that:
// a sweep with its own private copy of the truncation logic passes its own tests
// perfectly while measuring code nobody ships. So the mutants here are applied to
// a COPY OF bridge.js, and the assertion is that the sweeps notice. A sweep that
// stays green while the bridge is sabotaged is, by definition, not reading it.
//
// That is what makes this different from the suite's usual mutcheck: it tests the
// WIRING, and the wiring is what broke.
//
// Two of the four mutants restore real regressions:
//   * `truncate-not-split` restores the pre-#211 behaviour, i.e. the bug that
//     deleted 33 asks on the surface Shiv actually reads.
//   * `drop-ask-on-overflow` restores the first cut of #211, which trimmed the
//     ask block from the front and so deleted the very `Needs from you:` marker
//     that made it an ask.
//
// The fourth mutant is applied to the sweeps' own shared library, and it pins the
// mistake made while WRITING this fix: comparing raw markdown against delivered
// HTML makes the FORMATTER look like data loss (`mdToTelegramHtml` renders
// `[label](./x.md)` as bare `label`), which flagged 41 open-board tasks that were
// each delivered whole in a single message. A false positive that says "write
// less" is worse than silence, so the like-with-like comparison is guarded too.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

// Locate the SHIPPED bridge src. Order matters, and the fallback is second on
// purpose: when this runs from the deployed OA home the repo-relative walk is
// meaningless (the home is flat), while run-sweeps.ps1 always exports BRIDGE_SRC
// derived from the same pin the live mirror uses. Failing loudly beats skipping:
// a mutation check that quietly no-ops reports a clean sweep of a suite it never
// ran, which is the exact defect recorded against the '.mjs'-only mutcheck glob.
function resolveBridgeSrc() {
  const env = process.env.BRIDGE_SRC;
  if (env) {
    try { return fileURLToPath(env); } catch { /* not a URL - fall through */ }
    if (fs.existsSync(env)) return env;
  }
  const repoRelative = path.resolve(HERE, '..', '..', '..', 'packages', 'telegram-bridge', 'src');
  if (fs.existsSync(path.join(repoRelative, 'bridge.js'))) return repoRelative;
  console.error(
    'cannot locate the shipped telegram-bridge src.\n' +
    'Set BRIDGE_SRC (run-sweeps.ps1 does this automatically) or run from the repo checkout.');
  process.exit(2);
}

const BRIDGE_SRC_DIR = resolveBridgeSrc();

const SWEEPS = {
  ask: path.join(HERE, 'telegram-ask-truncation-sweep.mjs'),
  liveness: path.join(HERE, 'truncated-ask-liveness.mjs'),
  scope: path.join(HERE, 'truncation-openboard-scope.mjs'),
};

let pass = 0;
let fail = 0;

function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
}

// ---------------------------------------------------------------- fixtures --
const ASK = '**Needs from you:** one word — `go` or `stop`.';
// An ask whose marker is NOT immediately followed by a colon. #284 reads exactly
// like this, and the first version of askDelivered() flagged it as undelivered
// while the bridge was delivering it perfectly in a single message.
const ASK_EMDASH = '**Needs from you — one line:** `A` or `B`.';

const filler = (n, tag) =>
  Array.from({ length: n }, (_, i) => `- ${tag} line ${i} with enough prose to take up real room in a message.`).join('\n');

function journal(id, body) {
  return `# Task ${id}\n\nUser notes.\n\n---\n<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->\n\n## 🌙 Overnight Agent\n\n**Status:** In-progress · 2026-08-29\n\n${body}\n`;
}

// A: short, one message, plain ask.
const A = journal(1001, `Short turn.\n\n${ASK}`);
// B: over one message, ask at the very end -> the bridge must SPLIT and keep it.
const B = journal(1002, `${filler(90, 'B')}\n\n${ASK}`);
// C: short turn carrying a MARKDOWN-WRAPPED url, a bare url and a PR number,
//    delivered whole in ONE message. This is the false-positive fixture, and the
//    markdown-wrapped url is the load-bearing part: `mdToTelegramHtml` renders
//    `[label](https://…)` as bare `label`, dropping the href for EVERY reader,
//    split or not. Compared raw-against-rendered it looks like data loss; that is
//    precisely the mistake that produced 41 bogus findings on the live corpus.
const C = journal(1003, `See [the listing](https://example.com/listing) and https://example.com/a — also PR #123.\n\n${ASK}`);
// D: far past the 3-message cap -> the bridge trims the BODY but must still carry
//    the ask onto the final part.
const D = journal(1004, `${filler(400, 'D')}\n\n${ASK}`);
// E: ask marker without a following colon.
const E = journal(1005, `Short turn.\n\n${ASK_EMDASH}`);
// F: longer than one message, with actionable tokens deliberately placed BELOW
//    the first message boundary. Under the real bridge they arrive in part 2; if
//    delivery is ever capped at one message they are silently dropped, which is
//    the loss the scope sweep exists to see.
const F = journal(1006, `${filler(80, 'F')}\n\nDeep tokens: PR #456 and https://example.com/deep-link\n\n${ASK}`);

const FIXTURES = { 1001: A, 1002: B, 1003: C, 1004: D, 1005: E, 1006: F };

function makePlanner(tmp) {
  const jdir = path.join(tmp, 'journal');
  fs.mkdirSync(jdir, { recursive: true });
  for (const [id, body] of Object.entries(FIXTURES)) {
    fs.writeFileSync(path.join(jdir, `task-${id}.md`), body, 'utf8');
  }
  const rows = Object.keys(FIXTURES).map((id) => `| ${id} | 🔴 | fixture ${id} | - | 2026-08-29 | |`).join('\n');
  fs.writeFileSync(
    path.join(tmp, 'planner.md'),
    `## Today\n\n| ID | 🎯 | Task | Work Priority | Added | Linked ID |\n|---|---|---|---|---|---|\n${rows}\n`,
    'utf8',
  );
  fs.writeFileSync(path.join(tmp, 'planner-completed.md'), '## Completed\n', 'utf8');
  return tmp;
}

// Copy the shipped bridge src so a mutant never touches the real tree.
function copyBridge(dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(BRIDGE_SRC_DIR)) {
    if (!f.endsWith('.js') || f.endsWith('.test.js')) continue;
    fs.copyFileSync(path.join(BRIDGE_SRC_DIR, f), path.join(dest, f));
  }
  return dest;
}

function fileUrl(p) {
  return `file:///${p.replace(/\\/g, '/')}`;
}

function runSweep(which, planner, bridgeDir, libOverrideDir) {
  const env = { ...process.env, PLANNER_PATH: planner, BRIDGE_SRC: fileUrl(bridgeDir) };
  const script = libOverrideDir ? path.join(libOverrideDir, path.basename(SWEEPS[which])) : SWEEPS[which];
  try {
    const out = execFileSync('node', [script], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status === undefined ? -1 : e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

function patch(file, from, to) {
  const src = fs.readFileSync(file, 'utf8');
  if (!src.includes(from)) throw new Error(`mutation anchor not found in ${path.basename(file)}: ${from.slice(0, 60)}`);
  fs.writeFileSync(file, src.replace(from, to), 'utf8');
}

// Rewrite one whole line, matched by a substring. Line-ending agnostic: the
// shipped bridge.js is CRLF and a multi-line anchor silently fails to match.
function patchLine(file, contains, replacement) {
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split(/\r?\n/);
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const i = lines.findIndex((l) => l.includes(contains));
  if (i < 0) throw new Error(`mutation anchor not found in ${path.basename(file)}: ${contains}`);
  lines[i] = replacement;
  fs.writeFileSync(file, lines.join(eol), 'utf8');
}

// ------------------------------------------------------------------ baseline --
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mutcheck-delivery-'));
const planner = makePlanner(path.join(tmpRoot, 'planner'));
fs.mkdirSync(planner, { recursive: true });
makePlanner(planner);

console.log('baseline (real shipped bridge) -- every sweep must be GREEN:');
const baseAsk = runSweep('ask', planner, BRIDGE_SRC_DIR);
const baseLive = runSweep('liveness', planner, BRIDGE_SRC_DIR);
const baseScope = runSweep('scope', planner, BRIDGE_SRC_DIR);

check('ask sweep green on shipped bridge', baseAsk.code === 0, baseAsk.out.trim().split('\n').slice(-3).join(' | '));
check('liveness green on shipped bridge', baseLive.code === 0, baseLive.out.trim().split('\n').slice(-3).join(' | '));
check('openboard-scope green on shipped bridge', baseScope.code === 0, baseScope.out.trim().split('\n').slice(-3).join(' | '));
// The baseline must actually EXERCISE the split, or "green" proves nothing.
check('baseline really splits a long turn (>1 msg observed)',
  /SPLITS into >1 msg\s*:\s*[1-9]/.test(baseAsk.out), baseAsk.out.trim());
check('em-dash ask (#284 shape) is NOT reported as undelivered',
  /ASK IS NEVER DELIVERED\s*:\s*0/.test(baseAsk.out), baseAsk.out.trim());
check('single-message turn with links reports NO content loss',
  /losing actionable content with it\s*:\s*0/.test(baseScope.out), baseScope.out.trim());

// ------------------------------------------------------------------- mutants --
const MUTANTS = [
  {
    name: 'truncate-not-split (restores the pre-#211 bug)',
    apply: (dir) => patchLine(
      path.join(dir, 'bridge.js'),
      'const total = chunks.length',
      '  chunks = chunks.slice(0, 1); const total = chunks.length',
    ),
    killedBy: 'ask',
    why: 'the ask lives at the END of a turn, so keeping only the first chunk deletes it',
  },
  {
    name: 'drop-ask-on-overflow (restores #211\u2019s first cut)',
    apply: (dir) => patchLine(
      path.join(dir, 'bridge.js'),
      'chunks = [...headKeep, ...askKeep]',
      '    chunks = [...headKeep, ...askKeep].slice(0, Math.max(1, headKeep.length))',
    ),
    killedBy: 'ask',
    why: 'past MAX_PARTS the ask is dropped instead of carried onto the final part',
  },
  {
    name: 'max-parts-1 (silently caps delivery at one message)',
    apply: (dir) => patchLine(path.join(dir, 'bridge.js'), 'const MAX_PARTS = 3', 'const MAX_PARTS = 1'),
    killedBy: 'scope',
    why: 'actionable tokens below the first message never reach the reader',
  },
];

for (const m of MUTANTS) {
  const dir = copyBridge(path.join(tmpRoot, `bridge-${m.name.replace(/[^a-z0-9]+/gi, '-')}`));
  m.apply(dir);
  const r = runSweep(m.killedBy, planner, dir);
  check(`mutant killed: ${m.name}`, r.code === 1, `${m.why} -- got exit ${r.code}: ${r.out.trim().split('\n').slice(0, 6).join(' | ')}`);
}

// ------------------------------- invariant: like-with-like comparison holds --
// Pins the mistake made while WRITING this fix: comparing raw markdown against
// delivered HTML makes the FORMATTER look like data loss and produced 41 bogus
// findings on the live corpus.
//
// Measured on the shipped formatter, the two link kinds behave differently:
//     [label](https://example.com/x)  ->  <a href="https://example.com/x">label</a>   (href SURVIVES)
//     [label](./task-1-brief.md)      ->  label                                       (href is GONE)
//
// So a relative deliverable link's path is never delivered to ANY reader, split
// or not. That is a rendering property, not truncation, and counting it as loss
// is what went wrong. The invariant that makes it impossible to count:
//
//     for a single-message delivery, sourceText MUST be a substring of text
//
// which holds only because both sides go through the same md -> HTML -> text
// pipeline. It is asserted directly rather than via a sweep exit code, because
// with today's signal set (merge/PR/issue/url — all of which survive rendering)
// no sweep-visible token distinguishes the two. It becomes load-bearing the
// moment anyone adds a signal the formatter rewrites, which is exactly when a
// silent regression would otherwise creep back in.
{
  const probe = path.join(tmpRoot, 'invariant-probe.mjs');
  const relLinkTurn = 'See [the brief](./task-1-brief.md) and PR #123.\n\n**Needs from you:** `go`.';
  const write = (libPath, out) => fs.writeFileSync(probe, `
import { loadShippedDelivery, deliveryFor } from ${JSON.stringify(fileUrl(libPath))}
const shipped = await loadShippedDelivery(${JSON.stringify(fileUrl(BRIDGE_SRC_DIR))})
const d = deliveryFor(shipped, '1', '', ${JSON.stringify(relLinkTurn)})
if (d.parts.length !== 1) { console.log('NOT-SINGLE-PART'); process.exit(3) }
console.log(d.text.includes(d.sourceText) ? 'INVARIANT-HOLDS' : 'INVARIANT-BROKEN')
`, 'utf8');

  const realLib = path.join(HERE, 'lib-telegram-delivery.mjs');
  write(realLib);
  let r = execFileSync('node', [probe], { encoding: 'utf8' }).trim();
  check('invariant: single-message delivery contains its whole rendered source', r === 'INVARIANT-HOLDS', r);

  const mutLib = path.join(tmpRoot, 'lib-raw-mutant.mjs');
  fs.copyFileSync(realLib, mutLib);
  patchLine(mutLib, 'sourceText: deliveredText(shipped.mdToTelegramHtml(turn)),', '    sourceText: String(turn),');
  write(mutLib);
  r = execFileSync('node', [probe], { encoding: 'utf8' }).trim();
  check('mutant killed: compare-raw-markdown breaks that invariant', r === 'INVARIANT-BROKEN', r);
}

// The same lib, unmutated, run from a copied FLAT directory. This is not busywork:
// it is the shape the sweeps actually execute in. `sync-oa-home.ps1` deploys the
// OA home FLAT and BY BASENAME ("top level only; subdirs are data or vendored"),
// so a shared module in a `lib/` subdirectory would never be deployed at all and
// all three sweeps would die with ERR_MODULE_NOT_FOUND the first night after
// merge — green in the repo, crashed in production, which is precisely the
// "merged does not mean running" failure this suite exists to catch. The first
// draft of this fix did exactly that; the repo's own convention (flat
// `lib-*.mjs` siblings, used by 20+ checks) is what makes it deployable.
{
  const libDir = path.join(tmpRoot, 'sweeps-flat');
  fs.mkdirSync(libDir, { recursive: true });
  for (const f of Object.values(SWEEPS)) fs.copyFileSync(f, path.join(libDir, path.basename(f)));
  fs.copyFileSync(path.join(HERE, 'lib-telegram-delivery.mjs'), path.join(libDir, 'lib-telegram-delivery.mjs'));
  for (const which of ['ask', 'liveness', 'scope']) {
    const r = runSweep(which, planner, BRIDGE_SRC_DIR, libDir);
    check(`deploy shape: ${which} sweep runs from a FLAT dir (as the OA home is)`, r.code === 0,
      `got exit ${r.code}: ${r.out.trim().split('\n').slice(0, 3).join(' | ')}`);
  }
}

try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
