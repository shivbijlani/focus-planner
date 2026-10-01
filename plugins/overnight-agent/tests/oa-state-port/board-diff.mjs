#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPsHost, asJson, diff } from './fn-diff.mjs';
import { buildContext } from '../../skills/overnight-agent/oa-state-lib/core/context.mjs';
import {
  testSnoozeActive, getSnoozeFromStore, getBoardRowId, getBoardRowLinkedIds,
  getSnoozeFromBoard, getSnoozeMap, getPrioritiesRank, getBoardMap, getBoardLinkFacts,
  getCompletedBoardIds, getUrgencyRank, getTodaySectionText, getTodaySectionHash,
  getSectionRank, getPriorityRank,
} from '../../skills/overnight-agent/oa-state-lib/collect/board.mjs';
import {
  readObservedComments, testObservationReadable, getDocMetaFromJournal, getDocChannelState,
} from '../../skills/overnight-agent/oa-state-lib/collect/doc.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}
const N = Number(arg('--n', '50'));
let seed = Number(arg('--seed', '123456789')) >>> 0;
function rnd() { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 2 ** 32; }
function pick(a) { return a[Math.floor(rnd() * a.length)]; }
function maybe(p) { return rnd() < p; }

function ctxFor(planner, completed, snooze, stateDir, journalDir) {
  const values = {
    PlannerBoard: planner, PlannerCompleted: completed, SnoozeStore: snooze,
    StateDir: stateDir, JournalDir: journalDir, Command: 'scan',
  };
  const ctx = buildContext(values, new Set(Object.keys(values)));
  ctx.warn = () => {};
  return ctx;
}

function normNl(s, crlf) { return crlf ? s.replace(/\n/g, '\r\n') : s; }

function boardFixture(iter, root) {
  const crlf = maybe(0.5);
  const bom = maybe(0.25) ? '\uFEFF' : '';
  const ids = [];
  const lines = [
    '# Planner',
    '',
    '## Today',
    '| ID | 🎯 | Task | Work Priority | Added | Linked ID |',
    '|---|---|---|---|---|---|',
  ];
  const rowCount = 3 + Math.floor(rnd() * 8);
  for (let i = 0; i < rowCount; i++) {
    const id = String(100 + iter * 20 + i);
    ids.push(id);
    const compound = maybe(0.35) ? `${id},[${500 + i}](https://example.test/${i})` : id;
    const urg = pick(['🔴', '🟡', '📖', '⚪', '🐸', '']);
    const wp = pick(['P0', 'P1', 'P2', '', 'px']);
    const linked = maybe(0.6) ? [...new Set([pick(['1', '22', '333', id]), maybe(0.5) ? `#${100 + iter}` : ''].filter(Boolean))].join(pick([', ', '; ', ' / ', ' '])) : '';
    const snooze = maybe(0.3) ? ` <!-- snooze:${pick(['1999-01-01', '2999-12-31', new Date().toISOString().slice(0, 10)])} -->` : '';
    lines.push(`| ${compound} | ${urg} | Task ${id}${maybe(0.15) ? ' says snooze:2099-01-01' : ''} | ${wp} | 2026-01-${String(1 + i).padStart(2, '0')} | ${linked} |${snooze}`);
  }
  lines.push('', '## Deferred');
  lines.push(maybe(0.5)
    ? '| ID | 🎯 | Task | Work Priority | Added | Wake | Linked ID |'
    : '| ID | 🎯 | Task | Work Priority | Added | Linked ID |');
  lines.push('|---|---|---|---|---|---|---|');
  for (let i = 0; i < rowCount; i++) {
    const id = String(300 + iter * 20 + i);
    ids.push(id);
    const hasWake = maybe(0.5);
    const link = maybe(0.5) ? `${pick(ids)}; #${pick(ids)}` : '';
    const cells = hasWake
      ? [id, pick(['🔴', '🟡', '📖', '⚪', '']), `Deferred ${id}`, pick(['P0', 'P1', 'P2', '']), '2026-02-01', pick(['', '2026-03-01']), link]
      : [id, pick(['🔴', '🟡', '📖', '⚪', '']), `Deferred ${id}`, pick(['P0', 'P1', 'P2', '']), '2026-02-01', link];
    lines.push(`| ${cells.join(' | ')} |${maybe(0.2) ? ' <!-- snooze:2999-01-01 -->' : ''}`);
  }
  lines.push('', '## Priorities');
  for (const [i, id] of ids.slice().sort(() => rnd() - 0.5).slice(0, 5).entries()) lines.push(`${i + 1}. ${id}`);
  const plannerText = bom + normNl(lines.join('\n') + '\n', crlf);
  const completedText = normNl(['# Completed', '', '| ID | Task |', '|---|---|', ...ids.filter(() => maybe(0.25)).map((id) => `| ${id} | Done |`)].join('\n') + '\n', crlf);
  const storeObj = maybe(0.33)
    ? { tasks: Object.fromEntries(ids.filter(() => maybe(0.2)).map((id) => [id, pick(['1999-01-01', '2999-12-31'])])) }
    : maybe(0.5)
      ? { snoozed: Object.fromEntries(ids.filter(() => maybe(0.2)).map((id) => [id, { until: pick(['1999-01-01', '2999-12-31']) }])) }
      : Object.fromEntries(ids.filter(() => maybe(0.2)).map((id) => [id, pick(['1999-01-01', '2999-12-31'])]));
  const planner = path.join(root, `planner-${iter}.md`);
  const completed = path.join(root, `completed-${iter}.md`);
  const snooze = path.join(root, `snooze-${iter}.json`);
  fs.writeFileSync(planner, plannerText, 'utf8');
  fs.writeFileSync(completed, completedText, 'utf8');
  if (maybe(0.15)) {
    // Missing store variant.
  } else if (maybe(0.15)) {
    fs.writeFileSync(snooze, '{ broken json', 'utf8');
  } else {
    fs.writeFileSync(snooze, JSON.stringify(storeObj), 'utf8');
  }
  return { planner, completed, snooze, lines, ids };
}

async function check(label, psValue, nodeValue) {
  const nodeJson = asJson(nodeValue);
  const psJson = Array.isArray(nodeJson)
    ? (psValue === null && nodeJson.length === 0 ? [] : (!Array.isArray(psValue) && nodeJson.length === 1 ? [psValue] : psValue))
    : psValue;
  const d = diff(psJson, nodeJson);
  if (d) throw new Error(`${label}: ${d}`);
}

async function main() {
  const root = path.join(here, `.scratch-board-${process.pid}-${Date.now()}`);
  fs.mkdirSync(root, { recursive: true });
  let ps = null;
  try {
    ps = await createPsHost({ params: {}, cwd: repo });
    const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;
    for (let i = 0; i < N; i++) {
      const f = boardFixture(i, root);
      const stateDir = path.join(root, 'state');
      const journalDir = path.join(root, 'journal');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.mkdirSync(journalDir, { recursive: true });
      const ctx = ctxFor(f.planner, f.completed, f.snooze, stateDir, journalDir);
      await ps.eval(`$PlannerBoard=${psq(f.planner)}; $PlannerCompleted=${psq(f.completed)}; $SnoozeStore=${psq(f.snooze)}; $StateDir=${psq(stateDir)}; $JournalDir=${psq(journalDir)}; $WarningPreference='Continue'`);
      if (fs.existsSync(f.snooze) && fs.readFileSync(f.snooze, 'utf8').startsWith('{ broken')) {
        await ps.eval('$WarningPreference = "SilentlyContinue"');
        let warned = '';
        const warnCtx = { ...ctx, warn: (m) => { warned = m; } };
        getSnoozeFromStore(warnCtx);
        if (!warned.includes('falling back to planner.md markers')) throw new Error('malformed snooze store did not warn/fallback');
      }
      for (const raw of ['', '1999-01-01', '2999-12-31', new Date().toISOString().slice(0, 10), 'not-a-date']) {
        await check(`Test-SnoozeActive ${i}`, await ps.call('Test-SnoozeActive', [raw]), testSnoozeActive(raw));
      }
      for (const line of f.lines) {
        await check(`Get-BoardRowId ${i}`, await ps.call('Get-BoardRowId', [line]), getBoardRowId(line));
        await check(`Get-BoardRowLinkedIds ${i}`, await ps.call('Get-BoardRowLinkedIds', [line, -1]), getBoardRowLinkedIds(line, -1));
      }
      await check(`Get-SnoozeFromStore ${i}`, await ps.call('Get-SnoozeFromStore'), getSnoozeFromStore(ctx));
      await check(`Get-SnoozeFromBoard ${i}`, await ps.call('Get-SnoozeFromBoard'), getSnoozeFromBoard(ctx));
      await check(`Get-SnoozeMap ${i}`, await ps.call('Get-SnoozeMap'), getSnoozeMap(ctx));
      await check(`Get-PrioritiesRank ${i}`, await ps.call('Get-PrioritiesRank', [f.lines]), getPrioritiesRank(f.lines));
      await check(`Get-BoardMap ${i}`, await ps.call('Get-BoardMap'), getBoardMap(ctx));
      for (const id of [pick(f.ids), '999999']) await check(`Get-BoardLinkFacts ${i}`, await ps.call('Get-BoardLinkFacts', [id]), getBoardLinkFacts(ctx, id));
      await check(`Get-CompletedBoardIds ${i}`, await ps.call('Get-CompletedBoardIds'), getCompletedBoardIds(ctx));
      for (const icon of ['🔴', '🟡', '📖', '⚪', '🐸', '', 'x🔴y']) await check(`Get-UrgencyRank ${i}`, await ps.call('Get-UrgencyRank', [icon]), getUrgencyRank(icon));
      await check(`Get-TodaySectionText ${i}`, await ps.call('Get-TodaySectionText'), getTodaySectionText(ctx));
      await check(`Get-TodaySectionHash ${i}`, await ps.call('Get-TodaySectionHash'), getTodaySectionHash(ctx));
      for (const sec of ['today', 'deferred', 'other', 'Today']) await check(`Get-SectionRank ${i}`, await ps.call('Get-SectionRank', [sec]), getSectionRank(sec));
      for (const wp of ['P0', 'P9', 'p1', '', null]) await check(`Get-PriorityRank ${i}`, await ps.call('Get-PriorityRank', [wp]), getPriorityRank(wp));

      const obsSamples = [
        'Found 2 comments\nComment ID: c1\nCreated: 2026-01-01T00:00:00Z\nReply ID: r1\nCreated: yesterday\n',
        JSON.stringify([{ id: 'a', created: '2026-01-01T00:00:00Z' }, { id: 'b' }]),
        JSON.stringify({ content: [{ text: 'Found 1 comment\\nComment ID: z\\nCreated: now' }], structuredContent: { result: 'Found 1 comment\\nComment ID: z\\nCreated: now' } }),
        'No comments found in document abc',
        'transport closed',
        '[]',
      ];
      for (const [j, sample] of obsSamples.entries()) {
        const p = path.join(root, `obs-${i}-${j}.json`);
        fs.writeFileSync(p, sample, 'utf8');
        await check(`Read-ObservedComments ${i}/${j}`, await ps.call('Read-ObservedComments', [p]), readObservedComments(p));
        await check(`Test-ObservationReadable ${i}/${j}`, await ps.call('Test-ObservationReadable', [sample]), testObservationReadable(sample));
      }
      const journal = [
        '# Task X',
        maybe(0.5) ? '<!-- tg-meta topic=1 -->' : '',
        maybe(0.5) ? '<!-- doc-meta docId=doc_ABC-123 docUrl=https://docs.example/doc -->' : '',
        '```',
        '<!-- doc-meta docId=fenced -->',
        '```',
      ].join('\n');
      const jp = path.join(root, `journal-${i}.md`);
      fs.writeFileSync(jp, journal, 'utf8');
      await check(`Get-DocMetaFromJournal ${i}`, await ps.call('Get-DocMetaFromJournal', [jp]), getDocMetaFromJournal(jp));
      for (const doc of [null, {}, { doc_id: 'd', observed_at: '' }, { doc_id: 'd', observed_at: 'bad' }, { doc_id: 'd', observed_at: new Date().toISOString() }]) {
        await check(`Get-DocChannelState ${i}`, await ps.call('Get-DocChannelState', [doc]), getDocChannelState(doc));
      }
    }
  } finally {
    if (ps) await ps.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(`board/doc differential: ${N} inputs, 0 differences`);
}

main().catch((e) => { console.error(e.stack || e.message); process.exitCode = 1; });
