// ps1-encoding-sweep.mjs -- a BOM-less .ps1 containing non-ASCII is silently mangled under
// Windows PowerShell 5.1, and the damage lands BEFORE any code runs.
//
// PowerShell 5.1 decodes a script file with no BOM as the ANSI codepage, so a literal in the
// *script source* is corrupted on the way in. PowerShell 7 decodes the same bytes as UTF-8.
// Measured on the live box with one identical line saved both ways:
//
//   no BOM   -> 35 35 32 195 176 197 184 197 146 226 132 162   (mangled; C3 B0 C5 B8)
//   with BOM -> 35 35 32 240 159 140 153 32 116 101 115 116     (correct)
//
// This is HAZARD 4 (user-settings.md) applied one layer down. HAZARD 4 says to read *journals*
// with an explicit UTF-8 decoder. Here the corrupted artefact is the *script file itself*, where
// there is no decoder to pin -- only the BOM.
//
// Why it is worth a sweep rather than a paragraph: on 2026-08-30 it produced a FALSE TEST
// FAILURE. A new mutation check built its fixtures from a here-string containing `## <moon>`;
// under 5.1 the fixtures arrived corrupted, failed write-turn.ps1's own heading guard, and the
// check reported `got 0` on its positive assertions. It read exactly like "the fix does not
// work". The fix worked; the fixtures were destroyed on the way in. Adding the BOM turned 6
// failures into 15/15 green with no change to the code under test. The postmortem closed with
// "this is unaudited across the repo ... worth a sweep" -- this is that sweep.
//
// SEVERITY IS THE POINT. Not every occurrence is equal, and reporting them as if they were is
// how a real defect gets lost in 60 lines of cosmetic noise:
//
//   LOAD-BEARING  non-ASCII inside a string literal on a line that also compares/matches
//                 (-eq, -match, -replace, -split, [regex], Select-String ...). Under 5.1 the
//                 comparison runs against mojibake, so the logic silently changes. This is the
//                 class that breaks guards.
//   LITERAL       non-ASCII inside a string literal that is not obviously a comparison, e.g. an
//                 emoji in console output. Prints as mojibake under 5.1; cosmetic, but it is one
//                 edit away from becoming LOAD-BEARING.
//   COMMENT-ONLY  non-ASCII only in comments. Harmless today, still a trap: the next person to
//                 move that character into a literal inherits a silent bug.
//
// All three are findings, because the fix is identical and free (save with a BOM) and the
// severity only decides how loudly to say it.
//
// Scope: the repo's own tracked .ps1 files. The deploy targets (installed-plugins, the OA home)
// are byte-exact copies of these, so fixing the source fixes every target; and scanning the OA
// home directly would drown in its historical backups/ tree, which is deliberately frozen.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

// ROOT RESOLUTION -- and this is not incidental plumbing, it is the one thing this sweep
// got wrong on its first live run.
//
// Sweeps execute from the FLAT OA home (%LOCALAPPDATA%\overnight-agent), not from the repo
// tree they were authored in. So deriving the root as `<this file>/../../..` -- correct when
// the file sits in plugins/overnight-agent/checks -- resolves to C:\Users\<name> once the
// file is deployed. Measured: 40 .ps1 scanned in the repo, **1,004** from the flat home,
// including 2 LOAD-BEARING hits inside third-party tooling that is not ours to re-save.
// A detector that reports 131 findings about other people's files is one that gets switched
// off in a week, which is the same failure repo-drift-sweep's header warns about.
//
// Resolved the way repo-drift-sweep already does it: explicit env wins, then the copy locates
// itself, then the known checkout is probed. Deliberately NOT "walk up until a .git turns up" --
// from the flat home that finds nothing.
//
// SELF-LOCATION (#461) -- added after the hardcoded list was measured scanning the WRONG TREE.
// The list below names `V:\repos\focus-planner`, the main checkout. Every per-task session now
// runs in a WORKTREE, so from a worktree this sweep scanned the main checkout instead and
// reported "clean" about files it had never opened -- the exact class of defect this repo keeps
// filing. Measured in one instant: the default invocation scanned 80 files and found 0 problems;
// pointed at the actual worktree it scanned 81 and found 1. Because every task session is a
// worktree, the default was not occasionally wrong, it was ALWAYS wrong.
//
// The fix is structural rather than another absolute path: if this file sits at
// `<root>/plugins/overnight-agent/checks/`, then `<root>` is the repo that owns THIS COPY, which
// is true in the main checkout and in every worktree, present and future, with nothing to keep
// up to date. It is validated by requiring `<root>/package.json`, so a coincidentally-shaped
// directory cannot win.
//
// It cannot fire from the flat OA home -- the file sits directly in the home there, not under
// plugins/overnight-agent/checks -- so the deployed case still falls through to the list below
// and keeps the behaviour the 1,004-file measurement above pinned down.
function firstExisting(paths) {
  for (const p of paths) { if (p && fs.existsSync(p)) return p; }
  return null;
}

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
function selfLocatedRepo(dir) {
  const parts = dir.split(/[\\/]/);
  const tail = parts.slice(-3).join('/').toLowerCase();
  if (tail !== 'plugins/overnight-agent/checks') return null;
  const root = path.resolve(dir, '..', '..', '..');
  return fs.existsSync(path.join(root, 'package.json')) ? root : null;
}

const CHECKS_REPO = process.env.OA_CHECKS_REPO || firstExisting([
  'V:\\repos\\focus-planner\\plugins\\overnight-agent\\checks',
  'V:\\repos\\focus-planner.worktrees\\oa-version-the-checks\\plugins\\overnight-agent\\checks',
]);

// PS1_SWEEP_ROOT stays the explicit override (the mutation check drives the sweep with it).
// Then the self-located root, so a worktree scans ITSELF. Then the repo the checks archive
// belongs to; if none resolves, say so and exit 0 rather than scanning an arbitrary directory --
// a sweep that cannot find its subject must report that, not invent a corpus.
const REPO = process.env.PS1_SWEEP_ROOT
  || (process.env.OA_CHECKS_REPO ? path.resolve(process.env.OA_CHECKS_REPO, '..', '..', '..') : null)
  || selfLocatedRepo(HERE)
  || (CHECKS_REPO ? path.resolve(CHECKS_REPO, '..', '..', '..') : null);

if (!REPO || !fs.existsSync(REPO)) {
  console.log('ps1-encoding-sweep: no repo root found (set PS1_SWEEP_ROOT or OA_CHECKS_REPO) - nothing scanned.');
  process.exit(0);
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.ps1')) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

function hasBom(buf) {
  return buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
}

// Quoted spans on one line. Naive but deliberately so: it tracks single/double quotes and
// stops at an unquoted '#'. It cannot see here-strings (@' ... '@), which is stated rather
// than hidden -- a here-string body is reported as COMMENT-ONLY at worst, never as a false
// LOAD-BEARING, so the blind spot can only under-report severity, never invent it.
function quotedSpans(line) {
  const spans = [];
  let quote = null;
  let start = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) { spans.push([start, i]); quote = null; start = -1; }
    } else if (c === '"' || c === "'") {
      quote = c; start = i;
    } else if (c === '#') {
      break; // rest of the line is a comment
    }
  }
  if (quote && start >= 0) spans.push([start, line.length]); // unterminated: treat as literal
  return spans;
}

const rxCompare = /(-match|-imatch|-cmatch|-notmatch|-eq|-ieq|-ceq|-ne|-like|-notlike|-replace|-split|-contains|-notcontains|-in|-notin|\[regex\]|Select-String)/i;

function isNonAscii(ch) { return ch.codePointAt(0) > 127; }

function classify(text) {
  const lines = text.split(/\r?\n/);
  let comment = 0;
  const literal = [];
  const loadBearing = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let found = false;
    for (const ch of line) { if (isNonAscii(ch)) { found = true; break; } }
    if (!found) continue;

    const spans = quotedSpans(line);
    let inLiteral = false;
    for (let c = 0; c < line.length; c++) {
      if (!isNonAscii(line[c])) continue;
      if (spans.some(([s, e]) => c > s && c < e)) { inLiteral = true; break; }
    }

    if (!inLiteral) { comment += 1; continue; }
    const entry = { line: i + 1, text: line.trim().slice(0, 140) };
    if (rxCompare.test(line)) loadBearing.push(entry); else literal.push(entry);
  }
  return { comment, literal, loadBearing };
}

const files = walk(REPO);
const findings = [];

for (const f of files) {
  let buf;
  try { buf = fs.readFileSync(f); } catch { continue; }
  if (hasBom(buf)) continue;

  const text = buf.toString('utf8');
  let nonAscii = false;
  for (const ch of text) { if (isNonAscii(ch)) { nonAscii = true; break; } }
  if (!nonAscii) continue;

  const c = classify(text);
  const severity = c.loadBearing.length ? 'LOAD-BEARING' : (c.literal.length ? 'LITERAL' : 'COMMENT-ONLY');
  findings.push({ file: path.relative(REPO, f).replace(/\\/g, '/'), severity, ...c });
}

const order = { 'LOAD-BEARING': 0, LITERAL: 1, 'COMMENT-ONLY': 2 };
findings.sort((a, b) => order[a.severity] - order[b.severity] || a.file.localeCompare(b.file));

const loadBearing = findings.filter((f) => f.severity === 'LOAD-BEARING');

// The tree being scanned is REPORTED, not merely resolved (#461). A sweep whose subject is
// invisible can report "clean" about a tree it never opened, and nobody reading the output can
// tell. Printing the root makes a wrong root a one-line diff instead of an investigation.
console.log(`repo scanned                              : ${REPO}`);
console.log(`.ps1 files scanned                        : ${files.length}`);
console.log(`BOM-less files containing non-ASCII       : ${findings.length}`);
console.log(`  of those, LOAD-BEARING (logic at risk)  : ${loadBearing.length}`);
console.log(`  of those, LITERAL (mojibake output)     : ${findings.filter((f) => f.severity === 'LITERAL').length}`);
console.log(`  of those, COMMENT-ONLY (latent trap)    : ${findings.filter((f) => f.severity === 'COMMENT-ONLY').length}`);

if (!findings.length) {
  console.log('\nclean - every .ps1 carrying non-ASCII is saved UTF-8 with BOM.');
  process.exit(0);
}

console.log('\nFINDINGS: a BOM-less .ps1 with non-ASCII is mangled by PowerShell 5.1 before it runs.\n');
for (const f of findings) {
  console.log(`  [${f.severity}] ${f.file}`);
  console.log(`      comment-only lines: ${f.comment}   string literals: ${f.literal.length + f.loadBearing.length}`);
  for (const e of f.loadBearing) console.log(`      !! L${e.line}: ${e.text}`);
  for (const e of f.literal.slice(0, 3)) console.log(`       . L${e.line}: ${e.text}`);
  if (f.literal.length > 3) console.log(`       . ... and ${f.literal.length - 3} more literal line(s)`);
}

console.log('\nFix: re-save each file as UTF-8 **with** BOM. The bytes of the code do not change;');
console.log('only the 3-byte prefix that tells PowerShell 5.1 how to decode the rest.');
if (loadBearing.length) {
  console.log('\n\u26a0 LOAD-BEARING findings change behaviour under 5.1, not just output. Fix those first.');
}
process.exit(1);
