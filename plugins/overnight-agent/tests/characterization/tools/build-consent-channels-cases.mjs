// Builds cases/mc-consent-channels.json (run once; the output is committed).
//
// Step 5 of item 4 (#124): WHERE HE CAN APPROVE, per the spec's Decisions.
//   - A catch-up-doc comment counts as his only when it has no agent signature AND its id is not
//     in the sent-messages ledger write-turn keeps (`<OA home>/sent-messages.jsonl`). A ledger
//     that exists but cannot be read in full refuses.
//   - Each channel's rule lives in an `## Approvals` section of agent-gate.md, with defaults
//     (app: editor; google-doc: no-signature + not-in-sent-ledger). `off` switches a channel off;
//     any rule this engine cannot enforce switches it off too. Teams/mail have no reader here.
// Every existing consent golden is unchanged: no ledger and no `## Approvals` section is the default.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '..', 'cases', 'mc-consent-channels.json');

const turn = (plan = '**Status:** working.\n') =>
  '## \u{1F319} Overnight Agent \u2014 2020-03-01\n\n<!-- from: overnight-agent -->\n<!-- oa-ask: offer -->\n' + plan + '\n<!-- /overnight-agent turn-end -->\n';
const journal = (id, tail = '', plan) =>
  `# Task ${id}: consent channels\n<!-- doc-meta docId=DOC123 docUrl=https://docs.google.com/document/d/DOC123/edit -->\n\n## 2020-03-01\n\n<!-- from: me -->\nframing only, nothing approved here\n\n---\n<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->\n\n` + turn(plan) + tail;
const hisApproval = '\n## 2020-03-02\n\n<!-- from: me -->\napprove\n';
const dump = 'Found 1 comments in document DOC123:\n\nComment ID: AAAA1\nAuthor: Shiv Bijlani\nCreated: 2026-09-09T15:33:45.386Z\nQuoted text: Pending\nContent: Yes approved\n';
const sent = (rows) => rows.map((r) => JSON.stringify({ v: 1, at: '2026-09-09T08:00:00-07:00', task_id: '960', by: 'session-x', host: 'char-host', ...r })).join('\n') + '\n';
const approvals = (...lines) => `<!-- planner-agent-gate v1 -->\n# Agent gate\n\n## Do not gate (reversible)\n- Reading files\n\n## Always ask (safety floor)\n- Spending money\n\n## Approvals\n${lines.map((l) => `- ${l}`).join('\n')}\n`;

const consent = (id, files, docComments = true) => ({
  tool: 'oa-state', command: 'consent', args: docComments ? { Id: id, DocComments: '{input}\\approved.txt' } : { Id: id },
  files: { 'input/approved.txt': dump, ...files },
});
const noReply = { 'data/journal/task-960.md': journal('960') };
const replied = { 'data/journal/task-960.md': journal('960', hisApproval) };

const cases = [
  { id: 'mc/consent-channels/ledger-hit-refuses', note: 'his-looking doc comment AAAA1 is in the sent ledger as google-doc: the agent sent it, so it is not consent',
    ...consent('960', { ...noReply, 'home/sent-messages.jsonl': sent([{ channel: 'google-doc', message_id: 'AAAA1' }]) }) },
  { id: 'mc/consent-channels/ledger-other-channel-grants', note: 'the same id recorded on a DIFFERENT channel (teams) does not make the doc comment the agent\'s',
    ...consent('960', { ...noReply, 'home/sent-messages.jsonl': sent([{ channel: 'teams', message_id: 'AAAA1' }]) }) },
  { id: 'mc/consent-channels/ledger-other-id-grants', note: 'a different google-doc id in the ledger leaves his comment his',
    ...consent('960', { ...noReply, 'home/sent-messages.jsonl': sent([{ channel: 'google-doc', message_id: 'BBBB2' }]) }) },
  { id: 'mc/consent-channels/ledger-malformed-refuses', note: 'a ledger line that cannot be parsed might be the very comment: refuse',
    ...consent('960', { ...noReply, 'home/sent-messages.jsonl': sent([{ channel: 'teams', message_id: 'T1' }]) + '{not json\n' }) },
  { id: 'mc/consent-channels/ledger-not-consulted-when-journal-approves', note: 'his journal approval still wins first; the doc (and its ledger) is not consulted',
    ...consent('960', { ...replied, 'home/sent-messages.jsonl': sent([{ channel: 'google-doc', message_id: 'AAAA1' }]) }) },
  { id: 'mc/consent-channels/approvals-defaults-explicit', note: 'the documented defaults written out: same as no section (doc comment grants)',
    ...consent('960', { ...noReply, 'data/agent-gate.md': approvals('app: editor', 'telegram: sender-id', 'teams: no-signature + not-in-sent-ledger', 'mail: no-signature + not-in-sent-ledger', 'google-doc: no-signature + not-in-sent-ledger') }) },
  { id: 'mc/consent-channels/approvals-doc-off', note: 'google-doc: off -- his doc comment can never approve; the doc is not even read',
    ...consent('960', { ...noReply, 'data/agent-gate.md': approvals('google-doc: off') }) },
  { id: 'mc/consent-channels/approvals-app-off', note: 'app: off -- his journal approve does not count (no doc dump passed)',
    ...consent('960', { ...replied, 'data/agent-gate.md': approvals('app: off') }, false) },
  { id: 'mc/consent-channels/approvals-app-off-doc-grants', note: 'app: off with the doc channel on: the doc comment is consulted and grants',
    ...consent('960', { ...replied, 'data/agent-gate.md': approvals('app: off') }) },
  { id: 'mc/consent-channels/approvals-weaker-rule-refuses', note: 'google-doc: no-signature (dropping the ledger) is a rule this engine will not run: the channel is off',
    ...consent('960', { ...noReply, 'data/agent-gate.md': approvals('google-doc: no-signature') }) },
  { id: 'mc/consent-channels/approvals-unknown-app-rule-refuses', note: 'app: anything-but-editor is unrecognised: off, fail closed',
    ...consent('960', { ...replied, 'data/agent-gate.md': approvals('app: telegram-only') }, false) },
  { id: 'mc/consent-channels/approvals-second-line-cannot-reopen', note: 'google-doc: off then google-doc: <default> -- once off, a later line cannot re-open it',
    ...consent('960', { ...noReply, 'data/agent-gate.md': approvals('google-doc: off', 'google-doc: no-signature + not-in-sent-ledger') }) },
  { id: 'mc/consent-channels/approvals-section-ends-at-heading', note: 'a google-doc: off line under a LATER heading is not in the Approvals section',
    ...consent('960', { ...noReply, 'data/agent-gate.md': approvals('app: editor') + '\n## Notes\n- google-doc: off\n' }) },
];

const doc = {
  fixture: 'base',
  covers: ['mc-consent-channels', 'mutcheck-doc-consent'],
  note: 'Item 4 step 5 (#124): the consent reader consults the sent-messages ledger and the per-channel ## Approvals rules. Recorded from oa-state.ps1.',
  cases,
};
fs.writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
console.log(`wrote ${cases.length} cases -> ${out}`);
