#!/usr/bin/env node
// Differential test: write-turn.mjs's .NET->JS regex translation (netRe) against .NET itself.
//
// write-turn.mjs keeps write-turn.ps1's patterns VERBATIM and translates them, so the guards'
// verdicts can only drift through the translator. This generates random lines from the
// vocabulary the guards care about (markers, headings, ask words, CR/LF, Unicode word and space
// characters, digits that are not ASCII) and compares every match -- index, length and groups --
// between netRe() in Node and [regex] in pwsh, with PowerShell's -match options (IgnoreCase) or
// [regex]::Matches' (none), exactly as each guard uses them.
//
//   node regex-diff.mjs [--n 400] [--seed 1]      exit 0 identical, 1 a difference, 2 harness error
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WT = path.resolve(HERE, '..', '..', 'skills', 'overnight-agent', 'write-turn.mjs');
const { netRe } = await import(pathToFileURL(WT).href);

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const N = arg('--n', 400);
let seed = arg('--seed', 1);
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length)];

const MOON = '\u{1F319}';
// [pattern as written in write-turn.ps1, how it is applied: 'ci' (-match) | 'cs' ([regex])]
const PATTERNS = [
  ['^[ \\t]*```', 'ci'],
  ['^[ \\t]*##[ \\t]+\\S', 'ci'],
  ['^[ \\t]*###', 'ci'],
  ['^[ \\t]*<!--[ \\t]*from:[ \\t]*overnight-agent[ \\t]*-->', 'ci'],
  ['^[ \\t]*<!--[ \\t]*from:[ \\t]*overnight-agent[ \\t]*-->[ \\t\\r]*$', 'ci'],
  ['^[ \\t]*<!--[ \\t]*from:[ \\t]*[^>\\r\\n]*?[ \\t]*-->', 'ci'],
  ['(?im)^[ \\t]*<!--[ \\t]*oa-ask[ \\t]*:[ \\t]*([a-z]+)[ \\t]*-->[ \\t\\r]*$', 'ci'],
  ['(?m)^[ \\t]*##[ \\t][^\\r\\n]*', 'cs'],
  ['(?m)^[ \\t]*<!--[ \\t]*from:[ \\t]*me[ \\t]*-->[ \\t]*$', 'cs'],
  ['^[ \\t]*##[^\\r\\n]*(' + MOON + '|Overnight Agent)', 'ci'],
  ['<!--\\s*doc-meta\\s+docId=(?<id>[A-Za-z0-9_\\-]+)(?:\\s+docUrl=(?<url>\\S+))?\\s*-->', 'cs'],
  ['~\\\\-\\d', 'ci'],
  ['(?<![\\\\`])\\\\-\\d{2,}', 'ci'],
  ['\\*\\*\\*\\*', 'ci'],
  ['~\\*\\*,\\d', 'ci'],
  ["[A-Za-z]''[A-Za-z]", 'ci'],
  ['^\\s*\\*{0,2}Needs from you\\b[^:]*:\\*{0,2}\\s*\\S', 'ci'],
  ['^\\s*\\*{0,2}Next:\\*{0,2}\\s*\\S', 'ci'],
  ['^\\s*\\*{0,2}Your call:\\*{0,2}\\s*\\S', 'ci'],
  ['(?:^|\\s)Reply\\s+`[^`]+`', 'ci'],
  ['(?i)-GatePath\\b', 'cs'],
  ['(?i)agent-gate\\.md|Do not gate these|Always ask\\b', 'ci'],
  ['(?i)\\b(add|paste|put|append|copy|write|edit|insert)\\b|once that line exists', 'ci'],
  ['^\\s*\\*{0,2}(?:Needs from you|Your call)\\b[^:]*:\\*{0,2}\\s*(\\S.*)$', 'ci'],
  ['^\\s*[*_`]*\\s*(none|nothing|no|nil|n/a)\\b', 'ci'],
  ['\\?', 'ci'],
  ['^\\s*[*_]{0,2}next(?:\\s+up|\\s+steps?|\\s+step)?[*_]{0,2}\\s*:', 'ci'],
  ['\\b(?:pick(?:ing)?\\s+up|start(?:ing)?(?:\\s+on)?|work(?:ing)?(?:\\s+on)?|recommend(?:ing)?|tackle|tackling|take\\s+on|move\\s+on\\s+to|queue(?:ing)?)\\s+(?:gh\\s*)?#\\d+', 'ci'],
  ['(?i)\\b(?:pr|pull\\s+request)\\s*#(\\d+)', 'cs'],
  ['#(\\d+)', 'cs'],
  ['(?im)^[ \\t]*(?:\\*{0,2}(?:Needs from you|Your call|Next)\\b[^\\r\\n]*?|)\\breply\\s+(?:\\*\\*([^*\\r\\n]{1,40})\\*\\*|`([^`\\r\\n]{1,40})`)', 'cs'],
  ['(?i)(Needs from you|Your call|Next)\\b', 'ci'],
  ['(?i)^[ \\t]*reply\\b', 'ci'],
  ['(?i)(?<![\\w-])(approved?|approve it|yes|yep|yeah|go ahead|go for it|go|lgtm|ship it|do it|vibe it|send it|make it so|proceed|merge[ \\t]+#?\\d+)(?![\\w-])', 'cs'],
  ['^[ \\t]*\\*\\*Status:\\*\\*[ \\t]*Proposed\\b', 'ci'],
  ['^[ \\t]*1\\.[ \\t]+', 'ci'],
  ['^[ \\t]*1\\.[ \\t]+\\[gated\\][ \\t]+', 'ci'],
  ['^[ \\t]*[1-9][0-9]*\\.[ \\t]+', 'ci'],
  ['^[ \\t]*[1-9][0-9]*\\.[ \\t]+\\[(reversible|gate-allowed|gated)\\][ \\t]+', 'ci'],
  ['bak-(\\d{8})-(\\d{4})\\.md$', 'cs'],
  ['<!-- OVERNIGHT-AGENT do not edit this line', 'ci'],
  ['^[ \\t]*##[ \\t]+', 'ci'],
];

const TOKENS = [' ', ' ', '  ', '\t', '\n', '\r\n', '\r', 'a', 'Z', '_', '-', '0', '7', '12', '640', '#', '*', '**', '`', '~', '\\',
  "'", "''", ':', '?', '.', ',', '!', '/', '[', ']', '<!--', '-->', '<!-- ', ' -->', '##', '###', '## ', '```', MOON, '\u00e9',
  '\u017f', '\u212a', '\u0663', '\u00a0', '\u0085', '\ufeff', '\u200d', '\u2028', '\u0130', 'from:', 'from: ', 'overnight-agent',
  'Overnight Agent', 'OVERNIGHT AGENT', 'me', 'oa-ask', 'offer', 'none', 'blocking', 'Needs from you', 'NEEDS FROM YOU', 'Your call',
  'Next', 'next steps', 'Next up', 'reply', 'Reply', 'yes', 'approve', 'approved', 'go', 'goes', 'merge', 'merge #12', 'prune',
  'lgtm', 'ship it', 'Status:', '**Status:**', 'Proposed', '1.', '2.', '10.', '[gated]', '[reversible]', 'agent-gate.md',
  'Always ask', 'add', 'paste', 'once that line exists', '-GatePath', 'pick up', 'working on', 'PR', 'PR #', 'pull request',
  'gh', 'doc-meta', 'docId=', 'docUrl=', 'abc_DEF-1', 'https://x/y', 'nothing', 'n/a', 'no', 'bak-', '20260901', '1200',
  '.md', 'task-1.bak-20260901-1200.md', '$150', '\\-275', '~\\-275', '****', '~**,035**', "don''t", 'OVERNIGHT-AGENT do not edit this line',
  '<!-- OVERNIGHT-AGENT do not edit this line', 'k', 'K', 's', 'i', 'I'];

// Positive examples, mutated at random (insert / delete / replace / case flip / CRLF noise) so
// each pattern is exercised on both sides of its boundary rather than only on soup.
const SEEDS = [
  '<!-- from: overnight-agent -->', '  <!--from:overnight-agent-->  \r', '<!-- from: me -->', '<!-- from: Some Agent -->',
  '<!-- oa-ask: offer -->', '<!-- OA-ASK : None -->\r', `## ${MOON} Overnight Agent — 2026-09-01`, '## Overnight Agent reply',
  '<!-- doc-meta docId=ABC_def-12 docUrl=https://docs.google.com/document/d/ABC_def-12/edit -->', '<!--doc-meta docId=x-->',
  '**Needs from you:** reply `go` to continue', 'Needs from you (today): reply **prune**', '**Next:** pick up #640',
  '**Your call:** should I merge?', 'Your call: none. Two things?', 'Reply `merge 12`', 'next steps: work on gh#55',
  'Next up: land PR #640 then pick up #641', 'I am working on #12 and recommending #13', 'reply **yes please**',
  '**Status:** Proposed', '1. [gated] merge the PR', '2. [reversible] tidy', '10. do it', 'merge #42', 'go ahead', 'ship it!',
  'please add this line to agent-gate.md', 'Always ask before X; once that line exists I proceed', 'verified with -GatePath tmp',
  'task-468.bak-20260901-2359.md', '~\\-275 and \\-520', "don''t", '~**,035**', '****',
  '<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->', '```md', '### Run log',
];
const MUT = ['', ' ', '\t', '\r', '\n', '\r\n', '*', '`', '#', ':', '-', '_', '\u00a0', '\u0085', '\u200d', '\u0663', '\u017f', '\u212a', 'é', MOON, 'x', 'X', '1', '?'];
function mutate(s) {
  let out = s;
  const k = Math.floor(rnd() * 4);
  for (let j = 0; j < k; j++) {
    const at = Math.floor(rnd() * (out.length + 1));
    const op = rnd();
    if (op < 0.35) out = out.slice(0, at) + pick(MUT) + out.slice(at);
    else if (op < 0.6) out = out.slice(0, at) + out.slice(at + 1);
    else if (op < 0.8) out = out.slice(0, at) + pick(MUT) + out.slice(at + 1);
    else out = rnd() < 0.5 ? out.toUpperCase() : out.toLowerCase();
  }
  if (rnd() < 0.3) out = pick(TOKENS) + out;
  if (rnd() < 0.3) out = out + pick(TOKENS);
  if (rnd() < 0.2) out = out + pick(['\n', '\r\n']) + pick(SEEDS);
  return out;
}

function sample() {
  if (rnd() < 0.6) return mutate(pick(SEEDS));
  const n = Math.floor(rnd() * 14);
  let s = '';
  for (let k = 0; k < n; k++) s += pick(TOKENS);
  return s;
}

function jsMatches(pat, mode, s) {
  return netRe(pat, { i: mode === 'ci' }).matches(s).slice(0, 51)
    .map((m) => [m.index, m[0].length, ...m.slice(1).map((g) => (g === undefined ? null : g))]);
}

const cases = [];
for (const [pat, mode] of PATTERNS) for (let k = 0; k < N; k++) cases.push({ p: pat, ci: mode === 'ci', s: sample() });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-rxdiff-'));
const inFile = path.join(tmp, 'in.json');
const outFile = path.join(tmp, 'out.json');
fs.writeFileSync(inFile, JSON.stringify(cases));
// Each match as a JSON array built by hand, so ConvertTo-Json's array unrolling cannot blur it.
const ps = `
$ErrorActionPreference = 'Stop'
$cases = [IO.File]::ReadAllText('${inFile.replace(/'/g, "''")}') | ConvertFrom-Json
$sb = New-Object System.Text.StringBuilder
[void]$sb.Append('[')
$first = $true
foreach ($c in $cases) {
  if (-not $first) { [void]$sb.Append(',') }; $first = $false
  $opts = if ($c.ci) { [Text.RegularExpressions.RegexOptions]::IgnoreCase } else { [Text.RegularExpressions.RegexOptions]::None }
  $parts = New-Object System.Collections.Generic.List[string]
  foreach ($m in [regex]::Matches([string]$c.s, [string]$c.p, $opts)) {
    $cells = New-Object System.Collections.Generic.List[string]
    $cells.Add([string]$m.Index); $cells.Add([string]$m.Length)
    for ($g = 1; $g -lt $m.Groups.Count; $g++) {
      if ($m.Groups[$g].Success) { $cells.Add((ConvertTo-Json -InputObject $m.Groups[$g].Value -Compress)) } else { $cells.Add('null') }
    }
    $parts.Add('[' + ($cells -join ',') + ']')
    if ($parts.Count -gt 50) { break }
  }
  [void]$sb.Append('[' + ($parts -join ',') + ']')
}
[void]$sb.Append(']')
[IO.File]::WriteAllText('${outFile.replace(/'/g, "''")}', $sb.ToString(), [Text.UTF8Encoding]::new($false))
`;
const r = spawnSync(process.env.CHAR_PWSH || 'pwsh', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', maxBuffer: 1 << 26 });
if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(2); }
const net = JSON.parse(fs.readFileSync(outFile, 'utf8'));
fs.rmSync(tmp, { recursive: true, force: true });

let diffs = 0;
const hits = new Map();
for (let k = 0; k < cases.length; k++) {
  const js = jsMatches(cases[k].p, cases[k].ci ? 'ci' : 'cs', cases[k].s);
  const a = JSON.stringify(js);
  const b = JSON.stringify(net[k]);
  if (js.length) hits.set(cases[k].p, (hits.get(cases[k].p) || 0) + 1);
  if (a !== b) {
    diffs++;
    if (diffs <= 15) console.log(`DIFF ${JSON.stringify(cases[k].p)} on ${JSON.stringify(cases[k].s)}\n  node ${a}\n  .NET ${b}`);
  }
}
const never = PATTERNS.map(([p]) => p).filter((p) => !hits.get(p));
console.log(`regex-diff: ${cases.length} comparisons over ${PATTERNS.length} patterns, ${diffs} difference(s)` +
  (never.length ? `; never matched a sample: ${never.map((p) => JSON.stringify(p)).join(', ')}` : ''));
process.exit(diffs ? 1 : 0);
