#!/usr/bin/env node
// analyze-events.mjs -- turn a sandbox run's events.jsonl into the facts the assertions use.
//
//   node analyze-events.mjs --events <events.jsonl> --sandbox <root> --skill <skillDir>
//        --live <path> [--live <path> ...] --out <analysis.json>
//
// Output: every tool call (name, arguments, success, error, excerpt), plus
//   livePathHits   tool-call ARGUMENTS naming a live path (after the sandbox root is masked out,
//                  because the sandbox itself lives under the real %TEMP%)
//   tripwireHits   tool results carrying `oa_sandbox_violation` -- a script refused a live path
//   deniedCalls    calls the CLI refused by --deny-tool or path verification
//   provenance     whether oa-state.ps1 / write-turn.ps1 ran from the sandbox copy only
//   finalMessage   the coordinator's last assistant message (its wrap-up)
// Only arguments are scanned for live paths: results legitimately quote source files that
// contain literal paths (write-turn.ps1's historical default), which would be false alarms.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const many = (k) => args.flatMap((a, i) => (a === k ? [args[i + 1]] : []));
const eventsFile = opt('--events');
const sandbox = opt('--sandbox');
const skillDir = opt('--skill');
const live = many('--live').filter(Boolean);
const out = opt('--out');

const norm = (s) => String(s).replace(/\\\\/g, '\\').replace(/\//g, '\\').toLowerCase();
const sandboxN = norm(path.resolve(sandbox)).replace(/\\+$/, '');
const skillN = norm(path.resolve(skillDir)).replace(/\\+$/, '');
const liveN = [...new Set(live.map((p) => norm(path.resolve(p)).replace(/\\+$/, '')))];

let events = [];
try {
  events = readFileSync(eventsFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}

const calls = new Map();
const order = [];
let finalMessage = '';
const skillEvents = [];
for (const ev of events) {
  const d = ev.data || {};
  if (ev.type === 'tool.execution_start') {
    const c = { id: d.toolCallId, name: d.toolName, args: d.arguments ?? {}, start: ev.timestamp,
      success: null, error: null, excerpt: '' };
    calls.set(d.toolCallId, c); order.push(d.toolCallId);
  } else if (ev.type === 'tool.execution_complete') {
    const c = calls.get(d.toolCallId) || { id: d.toolCallId, name: d.toolName || '?', args: {}, start: null };
    if (!calls.has(d.toolCallId)) { calls.set(d.toolCallId, c); order.push(d.toolCallId); }
    c.end = ev.timestamp;
    c.success = d.success !== false;
    const content = typeof d.result?.content === 'string' ? d.result.content : JSON.stringify(d.result ?? '');
    c.error = d.error ? (typeof d.error === 'string' ? d.error : JSON.stringify(d.error)) : null;
    c.resultText = content;
    c.excerpt = content.slice(0, 600);
  } else if (ev.type === 'assistant.message' && typeof d.content === 'string' && d.content.trim()) {
    finalMessage = d.content;
  } else if (/skill/i.test(ev.type)) {
    skillEvents.push({ type: ev.type, data: JSON.stringify(d).slice(0, 800) });
  }
}

const list = order.map((id) => calls.get(id));
const livePathHits = [];
const tripwireHits = [];
const deniedCalls = [];
const stateInvocations = [];
const foreignInvocations = [];
for (const c of list) {
  const a = norm(JSON.stringify(c.args)).split(sandboxN).join('<sandbox>');
  for (const root of liveN) {
    if (a.includes(root)) { livePathHits.push(`${c.name}: ${root}`); break; }
  }
  if (/c:\\users\\[^\\]+\\onedrive\\apps\\focus planner/.test(a) || a.includes('\\installed-plugins\\')) {
    livePathHits.push(`${c.name}: literal live planner/plugin path`);
  }
  const text = `${c.resultText ?? ''}\n${c.error ?? ''}`;
  if (/oa_sandbox_violation/.test(text)) tripwireHits.push(`${c.name}: ${(text.match(/oa_sandbox_violation[^\n]*/) || [''])[0].slice(0, 300)}`);
  if (c.success === false && /(denied|not permitted|permission|not allowed|refused by policy)/i.test(text)) {
    deniedCalls.push(`${c.name}: ${String(c.error || c.excerpt).slice(0, 200)}`);
  }
  // Provenance. The sandbox root is masked to `<sandbox>` first, so what remains is either the
  // sandbox copy (`<sandbox>\repo\plugins\...` or, with cwd = the sandbox, a relative
  // `repo\plugins\...`) or a FOREIGN copy (any other absolute path to the scripts).
  const masked = norm(JSON.stringify(c.args)).split(sandboxN).join('<sandbox>');
  const skillRel = skillN.startsWith(sandboxN) ? skillN.slice(sandboxN.length).replace(/^\\+/, '') : null;
  let fromSandbox = false;
  if (/(oa-state|write-turn)\.ps1/.test(masked)) {
    if (masked.includes(`<sandbox>\\${skillRel}`) || (skillRel && masked.includes(skillRel))) fromSandbox = true;
    for (const m of masked.matchAll(/[a-z]:\\[^"'\s<>]*?\\(oa-state|write-turn)\.ps1/g)) foreignInvocations.push(m[0]);
    if (masked.includes('installed-plugins')) foreignInvocations.push('installed-plugins');
  }
  if (fromSandbox) stateInvocations.push(c.id);
}

const provenance = {
  ok: stateInvocations.length > 0 && foreignInvocations.length === 0,
  detail: `${stateInvocations.length} call(s) to the sandbox skill scripts; ${foreignInvocations.length} to any other copy` +
    (foreignInvocations.length ? `: ${[...new Set(foreignInvocations)].slice(0, 3).join(', ')}` : ''),
  stateInvocations: stateInvocations.length,
  foreignInvocations: [...new Set(foreignInvocations)],
};

const result = {
  schema: 'oa-e2e-analysis/1',
  events: events.length,
  toolCalls: list.map(({ resultText, ...c }) => c),
  toolCounts: list.reduce((m, c) => { m[c.name] = (m[c.name] || 0) + 1; return m; }, {}),
  livePathHits, tripwireHits, deniedCalls, provenance, skillEvents, finalMessage,
};
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ toolCalls: list.length, livePathHits: livePathHits.length,
  tripwireHits: tripwireHits.length, deniedCalls: deniedCalls.length, provenance: provenance.ok }));
