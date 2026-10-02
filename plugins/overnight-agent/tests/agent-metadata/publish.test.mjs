// node --test: the per-device agent metadata publisher (`write-turn.mjs publish-metadata`, item 5).
//
// The contract is docs/spec/Domain-agent-metadata.md. The publisher has no PowerShell twin, so it
// is pinned here (like the sent-messages ledger) rather than by recorded goldens. Every fingerprint,
// device-key and link vector in vectors.json runs here and in the app reader's suite.
//
// AGENT_METADATA_SKILL_DIR points the suite at another copy of the skill folder; the mutation check
// (checks/mutcheck-agent-metadata.mjs) uses it to prove each rule below is load-bearing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = process.env.AGENT_METADATA_SKILL_DIR || path.resolve(HERE, '..', '..', 'skills', 'overnight-agent');
const WT = path.join(SKILL, 'write-turn.mjs');
const M = await import(pathToFileURL(path.join(SKILL, 'agent-metadata.mjs')).href);
const V = JSON.parse(fs.readFileSync(path.join(HERE, 'vectors.json'), 'utf8'));

const SID = '8864eba8-24dc-468a-a7c7-cb5efd2b6085';
const SID2 = 'a1b2c3d4-0000-4000-8000-000000000002';
const V1 = 'sha256:9945c3c23d25ea6448ffaeb4ca719b074eb20db11e3920c9b3ae2a7c42c21815';
const V10 = 'sha256:709b3190ed8f9a81a6e3fc6b9ea69cde73ef519b85cd276d11b9fb6653359905';

function board(rows) {
  const today = rows.map((r) => `| ${r.id} | 🟡 | ${r.title} | - | ${r.added ?? '2026-09-02'} |  |`).join('\n');
  return `# Focus Plan\n\n## Today\n\n| ID | 🎯 | Task | Work Priority | Added | Linked ID |\n|----|----|------|------|------|------|\n${today}\n\n## Deferred\n\n| ID | 🎯 | Task | Work Priority | Added | Wake | Linked ID |\n|----|----|------|------|------|------|------|\n`;
}

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-pub-'));
  const sb = { root, home: path.join(root, 'home'), planner: path.join(root, 'planner') };
  sb.state = path.join(sb.home, 'state');
  sb.meta = path.join(sb.planner, 'agent-metadata');
  fs.mkdirSync(sb.state, { recursive: true });
  fs.mkdirSync(sb.planner, { recursive: true });
  sb.setBoard = (rows) => fs.writeFileSync(path.join(sb.planner, 'planner.md'), board(rows));
  sb.bind = (id, session) => {
    const p = path.join(sb.state, `task-${id}.json`);
    if (session === null) { fs.writeFileSync(p, JSON.stringify({ id: String(id), session: null })); return; }
    fs.writeFileSync(p, `\uFEFF${JSON.stringify({ id: String(id), status: 'approved', session: { session_id: SID, kind: 'chat', state: 'live', created_at: '2026-09-04T18:00:00-07:00', last_woken_at: '', ...session } })}`);
  };
  sb.list = (items) => { const p = path.join(root, 'list.txt'); fs.writeFileSync(p, `Found ${items.length} item(s):\n${JSON.stringify(items)}`); return p; };
  sb.files = () => (fs.existsSync(sb.meta) ? fs.readdirSync(sb.meta).sort() : []);
  sb.own = () => {
    const f = sb.files().filter((n) => M.FILE_NAME_RE.test(n) && !n.startsWith('ffff'));
    assert.equal(f.length, 1, `exactly one device file, got ${sb.files().join(', ')}`);
    return JSON.parse(fs.readFileSync(path.join(sb.meta, f[0]), 'utf8'));
  };
  return sb;
}

function publish(sb, args = [], env = {}) {
  const r = spawnSync(process.execPath, [WT, 'publish-metadata', '-PlannerDir', sb.planner, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WRITE_TURN_OA_HOME: sb.home, WRITE_TURN_HOST: 'TEST-PC', ...env },
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* not json */ }
  return { code: r.status, out: r.stdout, err: r.stderr, json };
}

// --- vectors ----------------------------------------------------------------------------------

test('every fingerprint vector', () => {
  for (const v of V.fingerprints) {
    assert.equal(M.fingerprint(v.id, v.added, v.title), v.fingerprint, v.name);
    if (v.text) assert.equal(M.fingerprintText(v.id, v.added, v.title), v.text, `${v.name} (canonical text)`);
  }
});

test('every device key vector', () => {
  for (const v of V.deviceKeys) assert.equal(M.deviceKey(v.id), v.key, v.id);
});

test('every link vector', () => {
  for (const v of V.urls) assert.equal(M.safeUrl(v.url, v.sessionId) !== null, v.safe, v.url);
});

test('the board is read by header name, as the app splits cells', () => {
  const text = `## Deferred\n\n| ID | 🎯 | Task | Work Priority | Added | Wake | Linked ID |\n|---|---|---|---|---|---|---|\n| 7 | 🟡 | Seven <!-- snooze:2026-12-01 --> | - | 2026-09-02 |  |  |\n\n## Other\n\n| Task | ID | Added |\n|---|---|---|\n| Reordered | 0008 | 9/2/2026 |\n| Dup | 8 | 2026-01-01 |\n`;
  const rows = M.readBoardRows(text);
  assert.equal(rows.get('7').fingerprint, M.fingerprint('7', '2026-09-02', 'Seven'));
  assert.equal(rows.get('8').fingerprint, M.fingerprint('8', '2026-09-02', 'Reordered'), 'first row for a duplicate id wins');
});

// --- the command ------------------------------------------------------------------------------

test('publishes one file for this device with the binding-time fingerprint and the observed link', () => {
  const sb = sandbox();
  sb.setBoard([{ id: 468, title: 'Work GitHub issues' }, { id: 469, title: 'Other' }]);
  sb.bind(468, {});
  const r = publish(sb, ['-SessionsListFile', sb.list([{ id: SID, app_url: `ghapp://sessions/${SID}` }])]);
  assert.equal(r.code, 0, r.err);
  const f = sb.own();
  assert.equal(f.schema, 'fp-agent-task-metadata@1');
  assert.equal(f.device.name, 'TEST-PC');
  assert.equal(f.device.key, M.deviceKey(f.device.id));
  assert.equal(sb.files()[0], `${f.device.key}.json`);
  assert.deepEqual(Object.keys(f), ['schema', 'device', 'planner', 'revision', 'publishedAt', 'lastSeenAt', 'heartbeatMinutes', 'truncated', 'tasks']);
  assert.deepEqual(f.planner, { board: 'planner.md' });
  assert.equal(f.revision, 1);
  assert.equal(f.heartbeatMinutes, 30);
  assert.deepEqual(Object.keys(f.tasks), ['468']);
  assert.equal(f.tasks['468'].fingerprint, V1);
  assert.deepEqual(f.tasks['468'].bindings, [{
    source: 'copilot-app', sessionId: SID, status: 'live', boundAt: '2026-09-05T01:00:00.000Z',
    verifiedAt: f.lastSeenAt, url: `ghapp://sessions/${SID}`,
  }]);
  assert.equal(r.json.path, `agent-metadata/${f.device.key}.json`);
  assert.equal(r.json.tasks, 1);
  const device = JSON.parse(fs.readFileSync(path.join(sb.home, 'device.json'), 'utf8'));
  assert.equal(device.schema, 'fp-agent-device@1');
  assert.equal(device.id, f.device.id);
});

test('the file and the receipt carry no absolute path, workspace, project or state detail', () => {
  const sb = sandbox();
  sb.setBoard([{ id: 468, title: 'Work GitHub issues' }]);
  sb.bind(468, { workspace: 'C:\\Users\\someone\\secret-worktree', project: 'secret-project', kind: 'code' });
  const r = publish(sb);
  assert.equal(r.code, 0, r.err);
  const text = fs.readFileSync(path.join(sb.meta, sb.files()[0]), 'utf8') + r.out;
  for (const leak of ['secret-worktree', 'secret-project', sb.root, sb.home, '\\\\', 'workspace', 'project', 'approved']) {
    assert.equal(text.includes(leak), false, `leaked ${leak}`);
  }
  assert.doesNotMatch(text, /[A-Za-z]:\\/);
});

test('a later title edit does not move the fingerprint: the app hides the link', () => {
  const sb = sandbox();
  sb.setBoard([{ id: 468, title: 'Work GitHub issues' }]);
  sb.bind(468, {});
  assert.equal(publish(sb).code, 0);
  sb.setBoard([{ id: 468, title: 'Work GitLab issues' }]);
  const r = publish(sb);
  assert.equal(r.code, 0, r.err);
  assert.equal(sb.own().tasks['468'].fingerprint, V1);
  assert.notEqual(M.fingerprint('468', '2026-09-02', 'Work GitLab issues'), V1);
});

test('a wake after the capture revalidates against the current row', () => {
  const sb = sandbox();
  sb.setBoard([{ id: 468, title: 'Work GitHub issues' }]);
  sb.bind(468, {});
  publish(sb);
  sb.setBoard([{ id: 468, title: 'Work GitLab issues' }]);
  sb.bind(468, { last_woken_at: new Date(Date.now() + 60000).toISOString() });
  assert.equal(publish(sb).code, 0);
  assert.equal(sb.own().tasks['468'].fingerprint, V10);
  // and a wake that is older than the capture does not
  sb.setBoard([{ id: 468, title: 'Work GitHub issues' }]);
  sb.bind(468, { last_woken_at: '2026-01-01T00:00:00Z' });
  publish(sb);
  assert.equal(sb.own().tasks['468'].fingerprint, V10);
});

test('-Revalidate recaptures only the named task', () => {
  const sb = sandbox();
  sb.setBoard([{ id: 468, title: 'Work GitHub issues' }, { id: 7, title: 'Seven' }]);
  sb.bind(468, {});
  fs.writeFileSync(path.join(sb.state, 'task-7.json'), JSON.stringify({ id: '7', session: { session_id: SID2, state: 'live' } }));
  publish(sb);
  sb.setBoard([{ id: 468, title: 'Work GitLab issues' }, { id: 7, title: 'Seven edited' }]);
  assert.equal(publish(sb, ['-Revalidate', '468']).code, 0);
  const f = sb.own();
  assert.equal(f.tasks['468'].fingerprint, V10);
  assert.equal(f.tasks['7'].fingerprint, M.fingerprint('7', '2026-09-02', 'Seven'));
});

test('a deleted row recreated under the same ID is compared with the ORIGINAL row', () => {
  const sb = sandbox();
  sb.setBoard([{ id: 468, title: 'Work GitHub issues' }]);
  sb.bind(468, {});
  publish(sb);
  sb.setBoard([]);
  const gone = publish(sb);
  assert.deepEqual(gone.json.skipped, [{ id: '468', reason: 'no_board_row' }]);
  assert.deepEqual(sb.own().tasks, {});
  sb.setBoard([{ id: 468, title: 'Buy a new bike' }]);
  publish(sb);
  assert.equal(sb.own().tasks['468'].fingerprint, V1, 'the new row must not inherit the old session');
});

test('a new session is a new binding and is captured fresh', () => {
  const sb = sandbox();
  sb.setBoard([{ id: 468, title: 'Work GitHub issues' }]);
  sb.bind(468, {});
  publish(sb);
  sb.setBoard([{ id: 468, title: 'Work GitLab issues' }]);
  sb.bind(468, { session_id: SID2 });
  publish(sb);
  const t = sb.own().tasks['468'];
  assert.equal(t.fingerprint, V10);
  assert.equal(t.bindings[0].sessionId, SID2);
});

test('released and dead bindings disappear at the next publish', () => {
  const sb = sandbox();
  sb.setBoard([{ id: 468, title: 'Work GitHub issues' }, { id: 7, title: 'Seven' }]);
  sb.bind(468, {});
  fs.writeFileSync(path.join(sb.state, 'task-7.json'), JSON.stringify({ id: '7', session: { session_id: SID2, state: 'live' } }));
  publish(sb);
  assert.deepEqual(Object.keys(sb.own().tasks), ['7', '468']);
  sb.bind(468, { state: 'dead' });
  sb.bind(7, null);
  const r = publish(sb);
  assert.deepEqual(sb.own().tasks, {});
  assert.deepEqual(r.json.skipped.map((s) => s.reason), ['no_live_session', 'no_live_session']);
  const ledger = JSON.parse(fs.readFileSync(path.join(sb.home, 'agent-metadata-publisher.json'), 'utf8'));
  assert.deepEqual(ledger.captures, {});
});

test('links: only when the host lists the session, never synthesised, never unsafe', () => {
  const sb = sandbox();
  sb.setBoard([{ id: 468, title: 'Work GitHub issues' }]);
  sb.bind(468, {});
  publish(sb);
  assert.equal('url' in sb.own().tasks['468'].bindings[0], false, 'no list, never observed: no url');
  assert.equal(sb.own().tasks['468'].bindings[0].verifiedAt, null);
  publish(sb, ['-SessionsListFile', sb.list([{ id: SID, app_url: `ghapp://sessions/${SID}` }])]);
  publish(sb);
  assert.equal(sb.own().tasks['468'].bindings[0].url, `ghapp://sessions/${SID}`, 'no list: the last observed link is kept');
  const absent = publish(sb, ['-SessionsListFile', sb.list([{ id: 'someone-else', app_url: 'ghapp://sessions/someone-else' }])]);
  assert.deepEqual(sb.own().tasks, {}, 'listed by the host without this session: the session is gone');
  assert.equal(absent.json.skipped[0].reason, 'session_not_in_host_list');
  for (const bad of ['ghapp://sessions/someone-else', 'javascript:alert(1)', 'http://x.test/']) {
    publish(sb, ['-SessionsListFile', sb.list([{ id: SID, app_url: bad }])]);
    assert.equal('url' in sb.own().tasks['468'].bindings[0], false, bad);
  }
});

test('revision always grows; publishedAt moves only when tasks change; lastSeenAt every time', async () => {
  const sb = sandbox();
  sb.setBoard([{ id: 468, title: 'Work GitHub issues' }]);
  sb.bind(468, {});
  publish(sb);
  const a = sb.own();
  await new Promise((r) => setTimeout(r, 20));
  const r = publish(sb);
  const b = sb.own();
  assert.equal(r.json.changed, false);
  assert.equal(b.revision, a.revision + 1);
  assert.equal(b.publishedAt, a.publishedAt);
  assert.ok(b.lastSeenAt > a.lastSeenAt);
  fs.rmSync(path.join(sb.home, 'agent-metadata-publisher.json'));
  publish(sb);
  assert.equal(sb.own().revision, b.revision + 1, 'a lost ledger still never reuses a revision');
});

test('never touches another file in agent-metadata/, and warns about a foreign writer', () => {
  const sb = sandbox();
  sb.setBoard([{ id: 468, title: 'Work GitHub issues' }]);
  sb.bind(468, {});
  publish(sb);
  const own = sb.files()[0];
  const others = { [`${own.slice(0, -5)} (1).json`]: 'conflict copy', 'ffffffffffffffffffffffffffffffff.json': '{"other":"device"}', 'notes.txt': 'x' };
  for (const [n, t] of Object.entries(others)) fs.writeFileSync(path.join(sb.meta, n), t);
  const f = JSON.parse(fs.readFileSync(path.join(sb.meta, own), 'utf8'));
  fs.writeFileSync(path.join(sb.meta, own), JSON.stringify({ ...f, revision: 99 }));
  const r = publish(sb);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json.warnings, ['foreign_writer_suspected']);
  assert.equal(sb.own().revision, 100);
  for (const [n, t] of Object.entries(others)) assert.equal(fs.readFileSync(path.join(sb.meta, n), 'utf8'), t, n);
  assert.equal(sb.files().some((n) => n.endsWith('.tmp')), false, 'no temp file left behind');
});

test('an unreadable state file keeps what was published for it', () => {
  const sb = sandbox();
  sb.setBoard([{ id: 468, title: 'Work GitHub issues' }]);
  sb.bind(468, {});
  publish(sb);
  fs.writeFileSync(path.join(sb.state, 'task-468.json'), '{ half a fi');
  const r = publish(sb);
  assert.equal(r.code, 0, r.err);
  assert.equal(sb.own().tasks['468'].fingerprint, V1);
  assert.deepEqual(r.json.skipped, [{ id: '468', reason: 'state_unreadable' }]);
});

test('caps: at most 500 tasks, lowest IDs first, flagged truncated', () => {
  const sb = sandbox();
  const rows = [];
  for (let i = 1; i <= 503; i++) {
    rows.push({ id: i, title: `T${i}` });
    fs.writeFileSync(path.join(sb.state, `task-${i}.json`), JSON.stringify({ id: String(i), session: { session_id: `s-${i}`, state: 'live' } }));
  }
  sb.setBoard(rows);
  assert.equal(publish(sb).code, 0);
  const f = sb.own();
  assert.equal(Object.keys(f.tasks).length, 500);
  assert.equal(f.truncated, true);
  assert.ok(f.tasks['500'] && !f.tasks['501']);
});

test('refusals: no board, corrupt identity, bad arguments, outside the sandbox -- nothing written', () => {
  let sb = sandbox();
  sb.bind(468, {});
  let r = publish(sb);
  assert.equal(r.code, 1);
  assert.match(r.err, /planner_board_missing/);
  assert.deepEqual(sb.files(), []);

  sb = sandbox();
  sb.setBoard([{ id: 468, title: 'Work GitHub issues' }]);
  fs.mkdirSync(sb.home, { recursive: true });
  fs.writeFileSync(path.join(sb.home, 'device.json'), 'garbage');
  r = publish(sb);
  assert.equal(r.code, 1);
  assert.match(r.err, /device_identity_corrupt/);
  assert.deepEqual(sb.files(), []);

  sb = sandbox();
  sb.setBoard([]);
  for (const args of [['-Bogus', '1'], ['-HeartbeatMinutes', '0'], ['-HeartbeatMinutes', 'x'], ['-Revalidate', 'abc'], ['-SessionsListFile']]) {
    r = publish(sb, args);
    assert.equal(r.code, 3, `${args.join(' ')} -> ${r.code} ${r.err}`);
  }
  r = publish(sb, [], { OA_SANDBOX_ROOT: path.join(sb.root, 'elsewhere') });
  assert.equal(r.code, 3);
  assert.match(r.err, /oa_sandbox_violation/);
  assert.deepEqual(sb.files(), []);
  assert.equal(fs.existsSync(path.join(sb.home, 'device.json')), false);
});

test('-DryRun prints the would-be file and writes nothing', () => {
  const sb = sandbox();
  sb.setBoard([{ id: 468, title: 'Work GitHub issues' }]);
  sb.bind(468, {});
  const r = publish(sb, ['-DryRun']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.written, false);
  assert.equal(r.json.file.tasks['468'].fingerprint, V1);
  assert.deepEqual(sb.files(), []);
  assert.equal(fs.existsSync(path.join(sb.home, 'device.json')), false);
  assert.equal(fs.existsSync(path.join(sb.home, 'agent-metadata-publisher.json')), false);
});

test('an atomic write that keeps failing leaves the previous file intact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-atomic-'));
  const target = path.join(dir, 'x.json');
  fs.writeFileSync(target, 'old');
  let calls = 0;
  assert.throws(() => M.writeAtomic(target, 'new', { attempts: 3, rename: () => { calls++; throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } }));
  assert.equal(calls, 3);
  assert.equal(fs.readFileSync(target, 'utf8'), 'old');
  assert.deepEqual(fs.readdirSync(dir), ['x.json']);
  M.writeAtomic(target, 'new', { rename: (a, b) => { if (++calls === 4) throw new Error('once'); fs.renameSync(a, b); } });
  assert.equal(fs.readFileSync(target, 'utf8'), 'new');
});
