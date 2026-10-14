#!/usr/bin/env node
// Regenerates the journals, state files and fixture.json of fixtures/base from the definitions
// below. The COMMITTED files under fixtures/base are the source of truth for the goldens; this
// script only exists so a fixture journal can be edited without hand-computing the
// `processed_file_hash` its state file must carry. The board, gate, settings and home files of
// fixtures/base are plain hand-written files and are not touched here.
//
//   node tools/build-base-fixture.mjs
//
// Hash rule (oa-state.ps1 Get-Sha256): sha256 over UTF-8 of the text with CRLF folded to LF,
// lowercase hex. `processed_file_hash` is the hash of the journal AS THE AGENT LAST LEFT IT, i.e.
// without whatever the user appended afterwards (the `trailing` part below).
//
// Dates in journals are FIXED and far in the past (2020) so they never fall inside the
// normaliser's clock window; anything that must be relative to "now" lives in state/home files
// as a {{NOW-..}} token instead (journals must stay token-free, or their hashes would drift).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'fixtures', 'base');
const MOON = '\u{1F319}';
const SENTINEL = '---\n<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->\n';
const END = '<!-- /overnight-agent turn-end -->';
export const hash = (t) => crypto.createHash('sha256').update(t.replace(/\r\n/g, '\n'), 'utf8').digest('hex');

function head(id, title, notes) {
  return `# Task ${id}: ${title}\n\n${notes}\n\n`;
}
function turn({ date = '2020-03-01', ask, status = 'In progress - plan v1', body, needs, yourCall, next, stamp = true, terminator = true, docMeta }) {
  let t = `## ${MOON} Overnight Agent \u2014 ${date}\n\n`;
  if (stamp) t += '<!-- from: overnight-agent -->\n';
  if (ask) t += `<!-- oa-ask: ${ask} -->\n`;
  if (docMeta) t += `${docMeta}\n`;
  t += `**Status:** ${status}\n\n${body}\n`;
  if (needs !== undefined) t += `\n**Needs from you:** ${needs}\n`;
  if (yourCall !== undefined) t += `\n**Your call:** ${yourCall}\n`;
  if (next !== undefined) t += `\n**Next:** ${next}\n`;
  if (terminator) t += `${END}\n`;
  return t;
}
const me = (date, text) => `\n## ${date}\n\n<!-- from: me -->\n${text}\n`;

// Common state for a task the agent has worked. Timestamps that only need to be "long ago" are
// fixed; ones compared against the clock are tokens.
function st(id, agentLeft, extra = {}) {
  return {
    id: String(id),
    status: 'in-progress',
    version: 1,
    plan_id: `t${id}-v1`,
    processed_file_hash: hash(agentLeft),
    has_agent_block: true,
    seeded: false,
    updated: '2020-03-01T12:00:00Z',
    status_by: 'agent',
    unanswered_user_message_at: null,
    last_turn_at: '2020-03-01T12:00:00Z',
    last_turn_by: 'sess-coordinator',
    ...extra,
  };
}

const DOC_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdEF';
const DOC_URL = `https://docs.google.com/document/d/${DOC_ID}/edit`;
const SID_LIVE = '11111111-2222-4333-8444-555555555555';
const SID_DEAD = '66666666-7777-4888-9999-000000000000';
const SID_OLD = '12121212-3434-4565-8787-909090909090';

const T = [];
function task(id, agentLeft, trailing = '', state, opts = {}) { T.push({ id, agentLeft, trailing, state, ...opts }); }

// 101 -- a fresh, marked user reply below the agent's turn: reopened, eligible, Today.
{
  const a = head(101, 'Renew passport', 'Prefer the expedited option; budget is fine.') + SENTINEL + '\n' +
    turn({ ask: 'none', body: 'Drafted the DS-82 form and booked a photo slot.', needs: 'none' });
  task(101, a, me('2020-03-02', 'Thanks \u2014 can you also check the photo size rules?'),
    st(101, a, { last_turn_at: '{{NOW-1h}}', updated: '{{NOW-1h}}' }));
}
// 102 -- declared BLOCKING ask, no reply: parked awaiting the user.
{
  const a = head(102, 'Pick a venue', 'Two venues shortlisted.') + SENTINEL + '\n' +
    turn({ ask: 'blocking', status: 'Proposed - plan v2', body: 'Both venues hold the date.', needs: 'pick **A** (Hall) or **B** (Garden) \u2014 I cannot book until you choose.' });
  task(102, a, '', st(102, a, { status: 'proposed', version: 2, plan_id: 't102-v2' }));
}
// 103 -- declared OFFER, although the prose reads like a blocking ask: the declaration wins.
{
  const a = head(103, 'Summarise the lease', 'Lease PDF is in the drive.') + SENTINEL + '\n' +
    turn({ ask: 'offer', body: 'Summary written to the doc.', needs: 'pick whether you want it emailed too' });
  task(103, a, '', st(103, a));
}
// 104 -- UNDECLARED ask (no oa-ask stamp): blocking is inferred from the prose.
{
  const a = head(104, 'Budget the trip', 'Flights are the big unknown.') + SENTINEL + '\n' +
    turn({ body: 'Priced three itineraries.', yourCall: 'reply below with the budget cap you want me to hold to' });
  task(104, a, '', st(104, a));
}
// 105 -- offer-only turn: optional, whenever-you-like wording under a declared offer.
{
  const a = head(105, 'Tidy the photo library', 'Duplicates mostly.') + SENTINEL + '\n' +
    turn({ ask: 'offer', body: 'Removed 212 exact duplicates.', needs: 'none', next: 'optional \u2014 if you would like, reply `yes` and I will also sort by year' });
  task(105, a, '', st(105, a));
}
// 106 -- closed by the USER (on the completed board), then a reply lands: reopened_closed.
{
  const a = head(106, 'File the insurance claim', 'Claim number in the email.') + SENTINEL + '\n' +
    turn({ ask: 'none', status: 'Done - plan v1', body: 'Claim filed and acknowledged.', needs: 'none' });
  task(106, a, me('2020-03-03', 'thanks, one more thought on this'), st(106, a, { status: 'done' }));
}
// 107 -- `done` declared by the AGENT while the row is still on the live board: reopens normally.
{
  const a = head(107, 'Order printer ink', 'Model is in the notes.') + SENTINEL + '\n' +
    turn({ ask: 'none', status: 'Done - plan v1', body: 'Ordered; arrives Friday.', needs: 'none' });
  task(107, a, me('2020-03-03', 'did it ship yet?'), st(107, a, { status: 'done', status_by: 'agent' }));
}
// 108 -- PAUSED by the user (blocked, status_by user). The trailing message IS the pause, and the
// journal was last written before paused_at (see fixture.json mtimes), so it is not a resume.
{
  const a = head(108, 'Migrate the NAS', 'Big job; do it in phases.') + SENTINEL + '\n' +
    turn({ ask: 'none', body: 'Phase 1 inventory done.', needs: 'none' });
  const trailing = me('2020-03-04', 'we need to pause this work for now, i need to reboot');
  task(108, a, trailing, st(108, a + trailing, {
    status: 'blocked', status_by: 'user', paused_at: '{{NOW-2h}}', unanswered_user_message_at: '{{NOW-3h}}',
    session: {
      session_id: SID_OLD, kind: 'chat', project: '', workspace: '', workspace_type: 'folder',
      created_at: '{{NOW-2d}}', last_woken_at: '{{NOW-4h}}', state: 'live', prior_session_id: '', prior_session_ids: [], replaced_at: null,
    },
  }), { mtime: '-3h' });
}
// 109 -- a valid, human-authored `merge 12` below the turn: consent_ok.
{
  const a = head(109, 'Land the docs PR', 'PR #12 in example/docs-site.') + SENTINEL + '\n' +
    turn({ ask: 'blocking', status: 'Proposed - plan v1', body: 'PR #12 is green.', needs: 'reply `merge 12` to land it' });
  task(109, a, me('2020-03-05', 'Looks good \u2014 merge 12'), st(109, a, { status: 'proposed' }));
}
// 110 -- a QUOTED marker: `<!-- from: me -->` only inside a fence / blockquote. Not the human.
{
  const a = head(110, 'Explain the bridge format', 'For the README.') + SENTINEL + '\n' +
    turn({ ask: 'blocking', status: 'Proposed - plan v1', body: 'Draft ready.', needs: 'approve the wording' });
  const trailing = '\n## 2020-03-05\n\nThis is what the bridge writes:\n\n```\n<!-- from: me -->\napprove\n```\n\n> <!-- from: me -->\n> yes, go ahead\n';
  task(110, a, trailing, st(110, a, { status: 'proposed' }));
}
// 111 -- the human asks a question; an UNSTAMPED agent turn below it says "approved": the heading
// ends the human's ownership, so the affirmative is not attributable to him (#272).
{
  const a = head(111, 'Reap stale sessions', 'Watchdog question.') + SENTINEL + '\n' +
    turn({ ask: 'blocking', status: 'Proposed - plan v1', body: 'Reaper is ready.', needs: 'approve the reaper' });
  const trailing = me('2020-03-06', 'should the watchdog agent be doing reaps?') +
    '\n## 2020-03-06 follow-up\n\nYes \u2014 approved, go ahead and merge 44.\n';
  task(111, a, trailing, st(111, a, { status: 'proposed' }));
}
// 112 -- bound to a catch-up doc (journal stamp + state binding with a watermark).
{
  const a = head(112, 'Quarterly taxes', 'Estimates for Q1.') + SENTINEL + '\n' +
    turn({ ask: 'offer', body: `Numbers are in the catch-up doc: ${DOC_URL}`, needs: 'none', docMeta: `<!-- doc-meta docId=${DOC_ID} docUrl=${DOC_URL} -->` });
  task(112, a, '', st(112, a, {
    doc: { doc_id: DOC_ID, doc_url: DOC_URL, bound_at: '2020-03-01T12:00:00Z', seen_ids: ['AAAAc1'], pending_ids: [], observed_at: '{{NOW-30m}}' },
  }));
}
// 113 -- brand new: no agent block and no state. Proposable.
task(113, head(113, 'Plan the vegetable garden', 'Ideas: tomatoes, beans, a herb bed by the door.\n\n- TODO: measure the beds'), '', null);
// 114 -- only a SIBLING skill has written below the turn (with an affirmative): not a reopen,
// and not consent.
{
  const a = head(114, 'Dance classes', 'Tuesdays preferred.') + SENTINEL + '\n' +
    turn({ ask: 'none', body: 'Listed the next four classes.', needs: 'none' });
  task(114, a, '\n## 2020-03-07\n\n<!-- from: dance-church -->\nAdded 2 classes to the calendar. yes, approved.\n', st(114, a));
}
// 115 -- a dated human message ABOVE the sentinel, newer than the last turn (#569).
{
  const a = head(115, 'Switch phone plan', 'Current plan renews in April.\n\n## 2020-03-10\n\n<!-- from: me -->\nActually, let us switch to the cheaper plan.') + SENTINEL + '\n' +
    turn({ date: '2020-03-05', ask: 'none', body: 'Compared three carriers.', needs: 'none' });
  task(115, a, '', st(115, a, { last_turn_at: '2020-03-05T12:00:00Z', updated: '2020-03-05T12:00:00Z' }));
}
// 116 -- snoozed through snooze.json (2099), with an overdue poll the snooze suppresses.
// 117 -- a poll that is overdue (and an EXPIRED board snooze marker).
// 118 -- blocked on a prerequisite with an overdue recheck.
// 119 -- snoozed by a board marker only.
{
  const a = head(116, 'Renew car registration', 'Due in the summer.') + SENTINEL + '\n' + turn({ ask: 'none', body: 'Reminder set.', needs: 'none' });
  task(116, a, '', st(116, a, { poll: { cadence: 'daily', interval_minutes: 1440, last_polled: '2020-03-01T12:00:00Z', next_due: '2020-03-02T12:00:00Z' } }));
}
{
  const a = head(117, 'Back up the video folder', 'Check the drop folder daily.') + SENTINEL + '\n' + turn({ ask: 'none', body: 'Uploaded 3 videos.', needs: 'none' });
  task(117, a, '', st(117, a, { poll: { cadence: 'daily', interval_minutes: 1440, last_polled: '2020-03-01T12:00:00Z', next_due: '2020-03-02T12:00:00Z' } }));
}
{
  const a = head(118, 'Ship the release', 'Waiting on CI.') + SENTINEL + '\n' + turn({ ask: 'none', status: 'Blocked - plan v1', body: 'CI is red on an unrelated flake.', needs: 'none' });
  task(118, a, '', st(118, a, { status: 'blocked', recheck: { cadence: '12h', interval_minutes: 720, kind: 'ci', last_rechecked: '2020-03-01T12:00:00Z', next_due: '2020-03-02T00:00:00Z' } }));
}
{
  const a = head(119, 'Garage sale', 'After the move.') + SENTINEL + '\n' + turn({ ask: 'none', body: 'Listed the items.', needs: 'none' });
  task(119, a, '', st(119, a));
}
// 121 -- a code task with a LIVE session bound to an existing worktree.
// 122 -- a bound session recorded DEAD (replace).
{
  const a = head(121, 'Fix the flaky sync test', 'Repo: example/sync-lib.') + SENTINEL + '\n' + turn({ ask: 'none', body: 'Reproduced the flake.', needs: 'none' });
  task(121, a, '', st(121, a, {
    session: {
      session_id: SID_LIVE, kind: 'code', project: 'example/sync-lib', workspace: '{{ROOT_JSON}}/lad/overnight-agent/worktrees/wt-121',
      workspace_type: 'worktree', created_at: '{{NOW-1d}}', last_woken_at: '{{NOW-3h}}', state: 'live', prior_session_id: '', prior_session_ids: [], replaced_at: null,
    },
  }));
}
{
  const a = head(122, 'Write the migration guide', 'Audience: plugin authors.') + SENTINEL + '\n' + turn({ ask: 'none', body: 'Outline drafted.', needs: 'none' });
  task(122, a, '', st(122, a, {
    session: {
      session_id: SID_DEAD, kind: 'chat', project: '', workspace: '', workspace_type: 'folder',
      created_at: '{{NOW-2d}}', last_woken_at: '{{NOW-1d}}', state: 'dead', prior_session_id: '', prior_session_ids: [], replaced_at: null,
    },
  }));
}
// 123 -- the LEGACY shape: an unstamped block carrying the old in-journal oa-state JSON, and no
// state file yet (first sight). An unmarked user message sits below it.
{
  const a = head(123, 'Old legacy task', 'From before provenance stamps.') + SENTINEL + '\n' +
    '## Overnight Agent\n\n**Status:** In progress - plan v3\n\n<!-- oa-state\n{"status":"in-progress","version":3,"plan_id":"t123-v3"}\n-->\n\n### Run log\n**2020-02-01 (overnight):**\n- did a thing\n';
  task(123, a, '\n## 2020-02-02\n\nRaw text with no provenance marker at all.\n', null);
}
// 124 -- a CRLF journal (OneDrive round-trip) whose trailing reply is UNMARKED prose: reopen fails
// open (counts as the user) while consent fails closed.
{
  const a = (head(124, 'Sort the tax receipts', 'Scans are in the inbox folder.') + SENTINEL + '\n' +
    turn({ ask: 'none', body: 'Filed 40 receipts.', needs: 'none' })).replace(/\n/g, '\r\n');
  task(124, a, '\r\nok, go ahead with the rest\r\n', st(124, a));
}

function writeFile(rel, text) {
  const p = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, 'utf8');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  fs.rmSync(path.join(OUT, 'data', 'journal'), { recursive: true, force: true });
  fs.rmSync(path.join(OUT, 'state'), { recursive: true, force: true });
  const mtimes = {};
  for (const t of T) {
    writeFile(`data/journal/task-${t.id}.md`, t.agentLeft + t.trailing);
    if (t.state) writeFile(`state/task-${t.id}.json`, JSON.stringify(t.state, null, 2) + '\n');
    if (t.mtime) mtimes[`data/journal/task-${t.id}.md`] = t.mtime;
  }
  writeFile('fixture.json', JSON.stringify({
    description: 'The shared synthetic planner folder + host state. Journals/state regenerate with tools/build-base-fixture.mjs.',
    mtimes,
  }, null, 2) + '\n');
  console.log(`wrote ${T.length} journals to ${OUT}`);
}
