// (-PlanDispatch rows have no -CheckDispatch step: that flag requires -ForDispatch.)
// Builds cases/mc-gated-dispatch.json (run once; the output is committed). The ForDispatch steps
// need each row's exact `dispatch_input`, which is a hash of the journal and state, so it is
// computed here by running the PowerShell engine's own `scan` over the same files.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ps1 = path.resolve(here, '../../../skills/overnight-agent/oa-state.ps1');

const H = '# Task {id}: task {id}\n\nUser notes.\n\n---\n<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->\n\n';
const turn = (status, plan, ask = 'blocking', needs = 'approve the plan?') =>
  `## \u{1F319} Overnight Agent \u2014 2020-03-01\n\n<!-- from: overnight-agent -->\n<!-- oa-ask: ${ask} -->\n**Status:** ${status}\n\n${plan}\n**Needs from you:** ${needs}\n<!-- /overnight-agent turn-end -->\n`;
const gatedPlan = '### Proposed plan (v1)\n1. [gated] Order the Bosch 300 with installation, $899 charged to the card on file.\n';
const mixedPlan = '### Proposed plan (v1)\n1. [reversible] Compare three installers.\n2. [gated] Pay the $899 deposit.\n';
const reversiblePlan = '### Proposed plan (v1)\n1. [reversible] Research repair shops.\n2. [gate-allowed] Email myself the shortlist.\n';
const fencedPlan = 'Example of a classified plan:\n\n```\n1. [gated] Order the thing.\n```\n\nNothing to approve here.\n';

const tasks = {
  930: { note: 'the #810 c1 shape: [gated] purchase, UNATTRIBUTED approval below it', status: 'proposed', body: turn('Proposed', gatedPlan, 'blocking', 'approve the $899 order?') + '\napproved: yes, go ahead and place the order\n' },
  931: { note: '[gated] step with HIS approval (`<!-- from: me -->`)', status: 'proposed', body: turn('Proposed', gatedPlan, 'blocking', 'approve the $899 order?') + '\n## 2020-03-02\n\n<!-- from: me -->\napprove\n' },
  932: { note: 'reversible / gate-allowed plan only: untouched', status: 'proposed', body: turn('Proposed', reversiblePlan) },
  933: { note: 'mixed plan, reversible first, a later [gated] step, no consent: refused', status: 'proposed', body: turn('Proposed', mixedPlan) },
  934: { note: 'an older turn had a [gated] step; the newest turn has none: untouched', status: 'in-progress',
    body: turn('Proposed', gatedPlan, 'blocking', 'approve the $899 order?') + '\n## 2020-03-02\n\n<!-- from: me -->\napprove\n\n' + turn('In progress', 'Ordered it; waiting for the install date.\n', 'none', 'nothing.') + '\nthe installer says next week\n' },
  935: { note: '[gated] step approved by a SIBLING skill, not him: refused', status: 'proposed', body: turn('Proposed', gatedPlan, 'blocking', 'approve the $899 order?') + '\n<!-- from: dance-church -->\napprove\n' },
  936: { note: 'a [gated] line only inside a fenced example: not a plan step', status: 'in-progress', body: turn('In progress', fencedPlan, 'none', 'nothing.') + '\nlooks fine, go ahead\n' },
};

const files = {
  'data/planner.md': '## Today\n\n| ID | Task |\n|---|---|\n' + Object.keys(tasks).map((id) => `| ${id} | task ${id} |\n`).join(''),
  'data/planner-completed.md': '',
  'data/snooze.json': '{}',
  'data/user-settings.md': '',
  'data/agent-gate.md': '',
  'home/sessions.json': JSON.stringify({ sessions: Object.keys(tasks).map((id) => ({ id: `S-${id}`, activity: { status: 'idle' } })) }),
};
for (const [id, t] of Object.entries(tasks)) {
  files[`data/journal/task-${id}.md`] = H.replaceAll('{id}', id) + t.body;
  files[`state/task-${id}.json`] = {
    id, status: t.status, status_by: 'agent', version: 1, plan_id: `t${id}-v1`, processed_file_hash: '',
    has_agent_block: true, seeded: false, updated: '2020-03-01T12:00:00Z',
    session: { session_id: `S-${id}`, kind: 'chat', project: 'p', workspace: '', workspace_type: 'folder',
      created_at: '2020-03-01T00:00:00Z', last_woken_at: '', state: 'live', prior_session_id: '', replaced_at: '' },
  };
}

// Materialise and scan with the PowerShell engine to read each row's dispatch_input.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-gated-build-'));
const map = { data: 'data', home: 'home', state: 'state' };
for (const [rel, v] of Object.entries(files)) {
  const [top, ...rest] = rel.split('/');
  const p = path.join(root, map[top], ...rest);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v));
}
const r = spawnSync('pwsh', ['-NoProfile', '-File', ps1, 'scan', '-JournalDir', path.join(root, 'data', 'journal'),
  '-StateDir', path.join(root, 'state'), '-PlannerBoard', path.join(root, 'data', 'planner.md'),
  '-PlannerCompleted', path.join(root, 'data', 'planner-completed.md'), '-SnoozeStore', path.join(root, 'data', 'snooze.json'),
  '-GatePath', path.join(root, 'data', 'agent-gate.md'), '-UserSettings', path.join(root, 'data', 'user-settings.md'),
  '-SessionStateDir', path.join(root, 'home', 'session-state'), '-McpConfig', path.join(root, 'home', 'mcp.json')],
{ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if (r.status !== 0) throw new Error(r.stderr);
const rows = JSON.parse(r.stdout);
fs.rmSync(root, { recursive: true, force: true });
const row = (id) => rows.find((x) => `${x.id}` === `${id}`);

const check = (id, extra = {}) => ({ tool: 'oa-state', command: 'session', args: { Id: `${id}`, CheckDispatch: true, SessionsStatusFile: '{home}/sessions.json', ...extra } });
const dispatch = (id, extra = {}) => ({ tool: 'oa-state', command: 'session', args: { Id: `${id}`, ForDispatch: true, DispatchInput: row(id).dispatch_input, SessionsStatusFile: '{home}/sessions.json', ...extra } });

const cases = [
  { id: 'mc/gated-dispatch/scan-rows', note: 'eligibility and plan_review_due of every fixture row, so each refusal below is the floor and not some other gate', files, steps: [{ tool: 'oa-state', command: 'scan', args: { Compact: true } }] },
  { id: 'mc/gated-dispatch/unattributed-approval-refused', note: tasks[930].note, files, steps: [check(930), dispatch(930)] },
  { id: 'mc/gated-dispatch/his-approval-granted', note: tasks[931].note, files, steps: [check(931), dispatch(931)] },
  { id: 'mc/gated-dispatch/reversible-plan-untouched', note: tasks[932].note, files, steps: [dispatch(932, { PlanDispatch: true })] },
  { id: 'mc/gated-dispatch/mixed-plan-refused', note: tasks[933].note, files, steps: [dispatch(933, { PlanDispatch: true })] },
  { id: 'mc/gated-dispatch/older-gated-turn-untouched', note: tasks[934].note, files, steps: [check(934), dispatch(934)] },
  { id: 'mc/gated-dispatch/sibling-approval-refused', note: tasks[935].note, files, steps: [dispatch(935, { PlanDispatch: true })] },
  { id: 'mc/gated-dispatch/fenced-gated-line-untouched', note: tasks[936].note, files, steps: [check(936), dispatch(936)] },
];
const out = { fixture: 'base', covers: ['mutcheck-gated-dispatch'], cases };
fs.writeFileSync(path.resolve(here, '../cases/mc-gated-dispatch.json'), JSON.stringify(out, null, 2) + '\n');
console.log(Object.keys(tasks).map((id) => `${id}: eligible=${row(id).eligible} plan_review_due=${row(id).plan_review_due}`).join('\n'));
