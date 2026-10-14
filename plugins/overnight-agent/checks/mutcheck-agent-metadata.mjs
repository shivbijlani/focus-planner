// mutcheck-agent-metadata.mjs -- proves the per-device agent metadata publisher's rules are
// load-bearing (item 5; docs/spec/Domain-agent-metadata.md).
//
// Each arm breaks ONE rule in a copy of oa-state-lib/act/agent-metadata.mjs and runs the contract test that pins it
// (tests/agent-metadata/publish.test.mjs, pointed at the copy through AGENT_METADATA_SKILL_DIR).
// The unmutated copy must pass every targeted test; each mutant must fail its test. A mutation
// whose target text is missing fails the check too, so an arm can never silently stop biting.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.resolve(HERE, '..', 'skills', 'overnight-agent');
const TEST = path.resolve(HERE, '..', 'tests', 'agent-metadata', 'publish.test.mjs');
const SOURCE = fs.readFileSync(path.join(SKILL, 'oa-state-lib', 'act', 'agent-metadata.mjs'), 'utf8').replace(/\r\n/g, '\n');

const ARMS = [
  ['keep-capture-when-row-gone', 'if (cap) captures[id] = cap;', '', /ORIGINAL row/],
  ['recapture-every-publish', 'if (!cap || wokeSinceCapture || revalidate.has(id)) {', 'if (true) {', /title edit does not move/],
  ['no-wake-revalidation', 'wokenMs > Date.parse(cap.capturedAt)', 'false', /wake after the capture/],
  ['revalidate-ignored', '|| revalidate.has(id)) {', ') {', /-Revalidate recaptures/],
  ['ghapp-any-session', "return app[1].toLowerCase() === String(sessionId).toLowerCase() ? url : null;", 'return url;', /every link vector/],
  ['https-userinfo-allowed', ' || u.username || u.password) return null;', ') return null;', /every link vector/],
  ['emoji-kept', ".replace(EMOJI_RE, '')", '', /every fingerprint vector/],
  ['comments-kept', "String(cell ?? '').replace(COMMENT_RE, '').normalize('NFKC').replace(EMOJI_RE, '')", "String(cell ?? '').normalize('NFKC').replace(EMOJI_RE, '')", /every fingerprint vector/],
  ['us-date-unparsed', 'm = /^(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})$/.exec(s);', 'm = null;', /every fingerprint vector/],
  ['absent-session-published', 'if (!seen) { captures[id] = cap;', 'if (!seen) { cap.url = null; } else if (false) { captures[id] = cap;', /never for an absent one/],
  ['non-atomic-write', "fs.writeFileSync(tmp, text, 'utf8');\n      rename(tmp, target);", "fs.writeFileSync(target, text, 'utf8');", /atomic write/],
  ['revision-from-ledger-only', 'Math.max(ledger.revision || 0, prevRevision) + 1', '(ledger.revision || 0) + 1', /revision always grows/],
  ['unreadable-state-drops', 'if (previous?.tasks?.[id]) {', 'if (false) {', /unreadable state file/],
  ['board-optional', 'if (!fs.existsSync(boardPath)) {', 'if (false) {', /refusals/],
  ['dead-binding-published', "String(sess.state ?? '') !== 'live'", 'false', /released and dead/],
  ['auto-explicit-store-ignored', "if (explicit?.has?.('StateDir') || explicit?.has?.('PlannerBoard')) return null;", '', /pointed at another store/],
  ['auto-kill-switch-ignored', "/^off$/i.test(process.env.OA_AGENT_METADATA || '')", 'false', /pointed at another store/],
  ['heartbeat-rewrites-fresh', "if (fresh) return { ok: true, path: rel, written: false, reason: 'fresh'", "if (false) return { ok: true, path: rel, written: false, reason: 'fresh'", /throttled heartbeat/],
  ['throttle-hides-a-change', 'if (!changed && fresh) return', 'if (fresh) return', /throttle window/],
  ['task-cap-dropped', 'ids.slice(0, CAPS.tasks)', 'ids', /caps/],
];

function copySkill(dir, agentMetadata) {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['write-turn.mjs', 'oa-state.mjs']) fs.copyFileSync(path.join(SKILL, f), path.join(dir, f));
  fs.cpSync(path.join(SKILL, 'oa-state-lib'), path.join(dir, 'oa-state-lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'oa-state-lib', 'act', 'agent-metadata.mjs'), agentMetadata);
}

function runTests(dir, pattern) {
  const r = spawnSync(process.execPath, ['--test', '--test-name-pattern', pattern.source, TEST], {
    encoding: 'utf8',
    env: { ...process.env, AGENT_METADATA_SKILL_DIR: dir },
  });
  return { ok: r.status === 0, out: r.stdout + r.stderr };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mutcheck-agent-metadata-'));
const failures = [];
try {
  const all = new RegExp(ARMS.map(([, , , re]) => re.source).join('|'));
  const base = path.join(root, 'base');
  copySkill(base, SOURCE);
  const b = runTests(base, all);
  if (!b.ok) failures.push(`baseline: the unmutated copy fails the targeted tests\n${b.out}`);
  else console.log(`baseline: unmutated copy passes the targeted tests`);

  for (const [name, find, replacement, re] of ARMS) {
    const hits = SOURCE.split(find).length - 1;
    if (hits !== 1) { failures.push(`${name}: mutation target found ${hits} times (expected exactly 1)`); continue; }
    const dir = path.join(root, name);
    copySkill(dir, SOURCE.replace(find, replacement));
    const r = runTests(dir, re);
    if (r.ok) failures.push(`${name}: SURVIVED -- the test matching ${re} still passes with the rule broken`);
    else console.log(`${name}: killed`);
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`mutcheck-agent-metadata: ${ARMS.length} of ${ARMS.length} mutations killed`);
