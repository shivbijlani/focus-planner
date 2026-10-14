#!/usr/bin/env node
// Differential fuzzing for the journal readers in oa-state-lib/collect/journal.mjs.
// One PowerShell host, one batched call per generated journal.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPsHost, asJson, diff } from './fn-diff.mjs';
import {
  ProvenanceRe,
  getSha256, getMemoised, getFenceMaskedText, getFenceMaskedTextCore, getLastIndexOfPattern,
  testIsRunLogBodyOnly, getNewestAgentTurn, getNewestAgentTurnCore, testAskTextIsOpen,
  getDeclaredAsk, getDeclaredAskCore, testHasOpenAsk, testAskTextIsBlocking, testHasBlockingAsk,
  getBlockingAskVerdict, getAgentEndIndex, testTrailingHasHuman, testTrailingHasUser,
  getAboveSentinelRegion, getNewestDatedHumanAbove, getAuthorSegments, getConsentFacts,
  testTrailingHasConsent, parseLegacyOaState, readJournalText, getJournalFacts,
} from '../../skills/overnight-agent/oa-state-lib/collect/journal.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const n = Number(arg('--n', '300'));
const seed = Number(arg('--seed', '8675309')) >>> 0;

function mulberry32(a) {
  return () => {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, xs) => xs[Math.floor(r() * xs.length)];
const maybe = (r, p) => r() < p;

function fixtureTexts() {
  const dir = path.join(repo, 'plugins', 'overnight-agent', 'tests', 'characterization', 'fixtures', 'base', 'data', 'journal');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^task-.*\.md$/i.test(f)).slice(0, 20)
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
}
const fixtures = fixtureTexts();

const authors = ['me', 'overnight-agent', 'dance-church', 'instagram-publisher-monitor', 'kranbox-backup'];
const asks = [
  '<!-- oa-ask: blocking -->',
  '<!-- oa-ask: offer -->',
  '<!-- oa-ask: none -->',
  '<!-- oa-ask: blocking -->\r',
  '',
];
const askLines = [
  '**Needs from you:** approve the PR.',
  '**Needs from you:** nothing. Both items above are optional; say the word and I\'ll pick it up.',
  '**Needs from you:** none - but tell me if you want a different option.',
  '**Your call:** reply below in plain English.',
  '**Needs from you:** no rush; optional when you have time.',
  '',
];
const prose = [
  'approve', 'yes', 'merge 12', 'merge it later', 'go ahead', 'ship it',
  'non-ASCII café — emoji 🐸 🌙 and Hebrew שלום',
  'Quoted mid-line marker: <!-- from: me --> should stay prose.',
  'DONE: finished one thing.',
  'TODO: another thing.',
];

function fence(r, unterminated = false) {
  const tick = pick(r, ['```', '~~~~']);
  const close = tick[0] === '`' ? '`'.repeat(tick.length + (maybe(r, 0.3) ? 1 : 0)) : '~'.repeat(tick.length + (maybe(r, 0.3) ? 2 : 0));
  const info = tick[0] === '`' && maybe(r, 0.25) ? ' js `not-a-fence`' : pick(r, ['', ' markdown', ' text']);
  const lines = [
    `${tick}${info}`,
    '<!-- from: me -->',
    '## 🌙 Overnight Agent quoted heading',
    '<!-- oa-ask: blocking -->',
    maybe(r, 0.5) ? 'nested-looking ``` inside' : '~~~ nested-looking',
    'approve yes merge 300',
  ];
  if (!unterminated) lines.push(close);
  return lines.join('\n');
}

function turn(r, author) {
  const heading = pick(r, [
    '## 2026-09-12',
    '## 2026-10-01',
    '## 🌙 Overnight Agent',
    '## 🌙 Overnight Agent — update',
    '## Notes',
  ]);
  const lines = [heading, `<!-- from: ${author} -->`];
  const ask = pick(r, asks);
  if (ask) lines.push(ask);
  for (let i = 0, c = 1 + Math.floor(r() * 4); i < c; i++) lines.push(pick(r, [...prose, ...askLines]));
  if (maybe(r, 0.35)) lines.push(fence(r, maybe(r, 0.25)));
  if (author === 'overnight-agent' && maybe(r, 0.5)) {
    lines.push('### Run log', '**2026-09-12 (overnight):**', '- Result: checked', '- Next: continue');
  }
  if (author === 'overnight-agent' && maybe(r, 0.45)) lines.push('<!-- /overnight-agent turn-end -->');
  return lines.join('\n');
}

function generatedJournal(i) {
  if (i % 37 === 0) return '';
  const r = mulberry32(seed + i * 1013904223);
  if (fixtures.length && maybe(r, 0.2)) {
    let t = pick(r, fixtures);
    if (maybe(r, 0.5)) t += '\n' + turn(r, pick(r, authors));
    if (maybe(r, 0.5)) t = t.replace(/\n/g, '\r\n');
    return t;
  }
  const lines = [`# Task ${i}: Generated fuzz ${i}`, '', '<!-- from: me -->', pick(r, prose)];
  if (maybe(r, 0.55)) {
    lines.push('', '## 2026-09-12', '<!-- from: me -->', pick(r, prose), pick(r, askLines));
  }
  if (maybe(r, 0.35)) lines.push('', fence(r, maybe(r, 0.35)));
  if (maybe(r, 0.75)) {
    lines.push('', '---', '<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->');
    for (let k = 0, c = 1 + Math.floor(r() * 4); k < c; k++) lines.push('', turn(r, pick(r, authors)));
  }
  if (maybe(r, 0.35)) lines.push('', '<!-- oa-state', '{"status":"approved","version":2,"updated":"2026-09-12T12:34:56-07:00"}', '-->');
  if (maybe(r, 0.45)) lines.push('', turn(r, 'me'));
  let text = lines.join('\n');
  if (maybe(r, 0.5)) text = text.replace(/\n/g, '\r\n');
  return text;
}

function nodeBatch(text, file) {
  const agentEndRaw = getAgentEndIndex(text);
  const safeEnd = agentEndRaw < 0 ? 0 : Math.min(agentEndRaw, text.length);
  const agentLeft = text.substring(0, safeEnd);
  const trailing = safeEnd < text.length ? text.substring(safeEnd) : '';
  const above = getAboveSentinelRegion(text);
  return {
    sha256: getSha256(text),
    memoisedEcho: getMemoised('journalDiffEcho', text, () => text),
    fenceMasked: getFenceMaskedText(text),
    fenceMaskedCore: getFenceMaskedTextCore(text),
    lastProv: getLastIndexOfPattern(text, ProvenanceRe),
    runLogBodyOnly: testIsRunLogBodyOnly(text),
    newestAgentTurn: getNewestAgentTurn(agentLeft),
    newestAgentTurnCore: getNewestAgentTurnCore(agentLeft),
    askTextOpen: testAskTextIsOpen(text),
    declaredAsk: getDeclaredAsk(agentLeft),
    declaredAskCore: getDeclaredAskCore(agentLeft),
    hasOpenAsk: testHasOpenAsk(agentLeft),
    askTextBlocking: testAskTextIsBlocking(text),
    hasBlockingAsk: testHasBlockingAsk(agentLeft),
    blockingAskVerdict: getBlockingAskVerdict(agentLeft),
    agentEndIndex: agentEndRaw,
    trailingHasHuman: testTrailingHasHuman(trailing),
    trailingHasUser: testTrailingHasUser(trailing),
    aboveSentinelRegion: above,
    newestDatedHumanAbove: getNewestDatedHumanAbove(above),
    authorSegments: getAuthorSegments(trailing),
    consentFacts: getConsentFacts(trailing),
    trailingHasConsent: testTrailingHasConsent(trailing),
    legacy: parseLegacyOaState(text),
    readJournalText: readJournalText(file),
    journalFacts: getJournalFacts(file),
  };
}

const psBatch = String.raw`
function Invoke-JournalReaderBatch([string]$Text, [string]$Path) {
  $agentEndRaw = Get-AgentEndIndex $Text
  $safeEnd = if ($agentEndRaw -lt 0) { 0 } else { [Math]::Min($agentEndRaw, $Text.Length) }
  $agentLeft = $Text.Substring(0, $safeEnd)
  $trailing = if ($safeEnd -lt $Text.Length) { $Text.Substring($safeEnd) } else { '' }
  $above = Get-AboveSentinelRegion $Text
  [ordered]@{
    sha256 = Get-Sha256 $Text
    memoisedEcho = Get-Memoised 'journalDiffEcho' $Text { $Text }
    fenceMasked = Get-FenceMaskedText $Text
    fenceMaskedCore = Get-FenceMaskedTextCore $Text
    lastProv = Get-LastIndexOfPattern $Text $script:ProvenanceRe
    runLogBodyOnly = Test-IsRunLogBodyOnly $Text
    newestAgentTurn = Get-NewestAgentTurn $agentLeft
    newestAgentTurnCore = Get-NewestAgentTurnCore $agentLeft
    askTextOpen = Test-AskTextIsOpen $Text
    declaredAsk = Get-DeclaredAsk $agentLeft
    declaredAskCore = Get-DeclaredAskCore $agentLeft
    hasOpenAsk = Test-HasOpenAsk $agentLeft
    askTextBlocking = Test-AskTextIsBlocking $Text
    hasBlockingAsk = Test-HasBlockingAsk $agentLeft
    blockingAskVerdict = Get-BlockingAskVerdict $agentLeft
    agentEndIndex = $agentEndRaw
    trailingHasHuman = Test-TrailingHasHuman $trailing
    trailingHasUser = Test-TrailingHasUser $trailing
    aboveSentinelRegion = $above
    newestDatedHumanAbove = Get-NewestDatedHumanAbove $above
    authorSegments = @(Get-AuthorSegments $trailing)
    consentFacts = Get-ConsentFacts $trailing
    trailingHasConsent = Test-TrailingHasConsent $trailing
    legacy = Parse-LegacyOaState $Text
    readJournalText = Read-JournalText $Path
    journalFacts = Get-JournalFacts $Path
  }
}
`;

const workRoot = path.join(here, '.journal-diff-work');
fs.rmSync(workRoot, { recursive: true, force: true });
fs.mkdirSync(workRoot, { recursive: true });

let ps;
try {
  ps = await createPsHost({ params: { JournalDir: workRoot, StateDir: path.join(workRoot, 'state') }, cwd: repo });
  await ps.eval(psBatch);
  for (let i = 0; i < n; i++) {
    const text = generatedJournal(i);
    const file = path.join(workRoot, `task-${i}.md`);
    const bom = ((seed + i) % 5) === 0;
    const bytes = Buffer.from(text, 'utf8');
    fs.writeFileSync(file, bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]) : bytes);
    const psValue = await ps.call('Invoke-JournalReaderBatch', [text, file]);
    const nodeValue = asJson(nodeBatch(text, file));
    const d = diff(psValue, nodeValue);
    if (d) {
      console.error(`journal-diff mismatch seed=${seed} i=${i}: ${d}`);
      console.error(`fixture: ${file}`);
      process.exitCode = 1;
      break;
    }
  }
  if (!process.exitCode) console.log(`journal-diff: ${n} inputs, seed=${seed}, 0 differences`);
} finally {
  if (ps) await ps.close();
  if (!process.exitCode) fs.rmSync(workRoot, { recursive: true, force: true });
}
