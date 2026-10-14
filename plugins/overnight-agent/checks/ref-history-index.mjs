#!/usr/bin/env node
/*
 * Resolve whether live file contents occurred anywhere in one ref's history.
 *
 * The caller sends:
 *   { "paths": [{ "repoPath": "plugins/overnight-agent/...", "installedFile": "..." }] }
 *
 * This intentionally performs one history walk for the whole plugin, then one
 * batch-check and one batch content read. Adding files therefore adds input rows,
 * not git history processes.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';

const repo = process.env.OA_REPO;
const ref = process.env.OA_REF || 'origin/main';
const scope = process.env.OA_HISTORY_SCOPE || 'plugins/overnight-agent';

if (!repo) throw new Error('OA_REPO is required');

const input = JSON.parse(readFileSync(0, 'utf8').replace(/^\uFEFF/, ''));
const requested = new Map(
  (input.paths || []).map((row) => [row.repoPath.replaceAll('\\', '/'), row.installedFile]),
);

function git(args, options = {}) {
  if (process.env.OA_HISTORY_GIT_TRACE) {
    appendFileSync(process.env.OA_HISTORY_GIT_TRACE, `${args[0]}\n`);
  }
  return execFileSync('git', args, {
    cwd: repo,
    maxBuffer: 256 * 1024 * 1024,
    ...options,
  });
}

function normHash(bytes) {
  const text = bytes.toString('utf8').replace(/\r\n/g, '\n');
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// PERFORMANCE GUARD: this is the sole history walk, outside every path loop.
const historyWalkArgs = ['log', '--format=C %H', '--name-only', '--no-renames', ref, '--', scope];
const log = git(historyWalkArgs, {
  encoding: 'utf8',
});

const commitsByPath = new Map();
let commit = null;
for (const raw of log.split(/\r?\n/)) {
  if (raw.startsWith('C ')) {
    commit = raw.slice(2).trim();
    continue;
  }
  const path = raw.trim().replaceAll('\\', '/');
  if (!commit || !requested.has(path)) continue;
  if (!commitsByPath.has(path)) commitsByPath.set(path, []);
  commitsByPath.get(path).push(commit);
}

const queries = [];
for (const path of requested.keys()) {
  for (const sha of commitsByPath.get(path) || []) queries.push(`${sha}:${path}`);
}
const tipQueries = [...requested.keys()].map((path) => `${ref}:${path}`);
queries.push(...tipQueries);

const oidByQuery = new Map();
if (queries.length) {
  const checked = git(['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
    input: queries.join('\n') + '\n',
    encoding: 'utf8',
  });
  checked.split(/\r?\n/).filter(Boolean).forEach((line, index) => {
    const match = /^([0-9a-f]{40,64}) blob$/.exec(line);
    oidByQuery.set(queries[index], match ? match[1] : null);
  });
}

const hashByOid = new Map();
const bodyByOid = new Map();
const uniqueOids = [...new Set([...oidByQuery.values()].filter(Boolean))];
if (uniqueOids.length) {
  const raw = git(['cat-file', '--batch'], {
    input: Buffer.from(uniqueOids.join('\n') + '\n', 'utf8'),
  });
  let offset = 0;
  while (offset < raw.length) {
    const newline = raw.indexOf(0x0a, offset);
    if (newline < 0) throw new Error('truncated cat-file batch header');
    const header = raw.subarray(offset, newline).toString('utf8');
    const match = /^([0-9a-f]{40,64}) blob (\d+)$/.exec(header);
    if (!match) throw new Error(`unexpected cat-file batch header: ${header}`);
    const size = Number(match[2]);
    const start = newline + 1;
    const end = start + size;
    if (end >= raw.length) throw new Error(`truncated cat-file batch body for ${match[1]}`);
    const body = raw.subarray(start, end);
    hashByOid.set(match[1], normHash(body));
    bodyByOid.set(match[1], body);
    offset = end + 1;
  }
}

const matches = {};
const onTip = {};
const tipContent = {};
for (const [path, installedFile] of requested) {
  // A REQUESTED PATH MAY NOT EXIST ON DISK YET (#668 follow-up).
  //
  // Callers batch two questions here: "are these live bytes a historical version?"
  // (`matches`) and "what does the ref tip hold?" (`tipContent`, used by the far-end
  // verifier). An ADDED file has no live bytes at the moment the batch is built, but its
  // tip content is exactly what the verifier needs -- so it must be requestable without
  // a live copy.
  //
  // Reading it unconditionally threw ENOENT and took the whole deploy down with it.
  // A missing file simply matches no historical version, which is the truthful answer:
  // there are no live bytes to be a version OF.
  let wanted = null;
  try {
    wanted = normHash(readFileSync(installedFile));
  } catch {
    matches[path] = false;
    continue;
  }
  matches[path] = (commitsByPath.get(path) || []).some((sha) => {
    const oid = oidByQuery.get(`${sha}:${path}`);
    return oid && hashByOid.get(oid) === wanted;
  });
}

for (const query of tipQueries) {
  const path = query.slice(ref.length + 1);
  const oid = oidByQuery.get(query);
  onTip[path] = Boolean(oid);
  if (oid) tipContent[path] = bodyByOid.get(oid).toString('base64');
}

process.stdout.write(`${JSON.stringify({ matches, onTip, tipContent })}\n`);
