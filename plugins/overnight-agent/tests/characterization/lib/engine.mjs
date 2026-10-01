// Runs one case against one implementation and produces its normalised observation:
// per-step exit code + stdout (JSON parsed where it is JSON) + warnings + stderr messages, and
// the file-tree diff (created / modified / deleted, with normalised content).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { materialize, snapshot, logicalPath, sandboxPath, expandTokens } from './fixture.mjs';
import { sandboxDirs, resolveArgs, baseEnv } from './contract.mjs';
import { makeNormalizer, cleanStderr, tryParseJson, GUID_RE } from './normalize.mjs';

export function normalizeCase(c, defaults = {}) {
  const steps = c.steps || [{ tool: c.tool, command: c.command, args: c.args, body: c.body, stdin: c.stdin, noDefaults: c.noDefaults }];
  return { fixture: defaults.fixture || 'base', ...c, steps: steps.map((s) => ({ ...s, tool: s.tool ?? (s.files || s.append ? undefined : 'oa-state') })) };
}

function splitStdout(raw) {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const warnings = [];
  const rest = [];
  for (const l of lines) (/^WARNING: /.test(l) ? warnings : rest).push(l);
  return { warnings, body: rest.join('\n') };
}

function describeFile(buf, n, rel) {
  const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  let text = buf.toString('utf8');
  if (bom) text = text.slice(1);
  const entry = {};
  if (bom) entry.bom = true;
  if (/\.json$/i.test(rel)) {
    const parsed = tryParseJson(text);
    if (parsed !== undefined) { entry.json = n.value(parsed); return entry; }
  }
  if (/\.jsonl$/i.test(rel)) {
    const rows = text.split(/\r?\n/).filter((l) => l.trim()).map((l) => tryParseJson(l));
    if (rows.every((r) => r !== undefined)) { entry.jsonl = rows.map((r) => n.value(r)); return entry; }
  }
  entry.text = n.text(text);
  return entry;
}

export async function runCase(kase, { adapter, fixturesDir, skillDir, repoDir, stubsDir, keep = false, timeoutSeconds }) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'oa-char-')));
  const t0 = Date.now();
  const dirs = sandboxDirs(root);
  const keepGuids = new Set();
  let n;
  try {
    materialize({ fixturesDir, fixture: kase.fixture, root, t0, files: kase.files, mtimes: kase.mtimes });
    for (const d of [dirs.cwd, dirs.input, dirs.tmp]) fs.mkdirSync(d, { recursive: true });
    const before = snapshot(root);
    for (const text of [JSON.stringify(kase), ...[...before.values()].map((b) => b.toString('utf8'))]) {
      for (const g of text.match(GUID_RE) || []) keepGuids.add(g.toLowerCase());
    }
    n = makeNormalizer({ t0, pathTokens: [['<ROOT>', root], ['<SKILL>', skillDir], ['<REPO>', repoDir]], keepGuids });
    const env = { ...baseEnv(dirs, stubsDir), ...Object.fromEntries(Object.entries(kase.env || {}).map(([k, v]) => [k, v == null ? undefined : expandTokens(String(v).replace(/\{(root|data|journal|home|state|cwd|input)\}/g, (_, x) => dirs[x]), { t0, root })])) };
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
    const steps = [];
    let i = 0;
    for (const step of kase.steps) {
      i++;
      if (!step.tool) {
        // A file-mutation step: the user (or the app) editing the folder between commands.
        for (const [rel, content] of Object.entries(step.files || {})) {
          const p = sandboxPath(root, rel);
          if (content === null) fs.rmSync(p, { force: true, recursive: true });
          else { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, expandTokens(content, { t0, root }), 'utf8'); }
        }
        for (const [rel, content] of Object.entries(step.append || {})) {
          fs.appendFileSync(sandboxPath(root, rel), expandTokens(content, { t0, root }), 'utf8');
        }
        continue;
      }
      const caseArgs = { ...(step.args || {}) };
      if (step.body != null) {
        const bodyPath = path.join(dirs.input, `body-${i}.md`);
        fs.writeFileSync(bodyPath, expandTokens(step.body, { t0, root }), 'utf8');
        caseArgs.BodyFile = bodyPath;
      }
      const args = resolveArgs(step.tool, caseArgs, dirs, { noDefaults: step.noDefaults });
      const res = await adapter.run({ tool: step.tool, command: step.command || '', args, stdin: step.stdin }, {
        root, dirs, cwd: dirs.cwd, env, skillDir, repoDir, timeoutSeconds,
      });
      if (res.status === 'skip') return { status: 'skip', reason: res.reason };
      const { warnings, body } = splitStdout(res.stdout);
      const parsed = tryParseJson(body);
      const rec = { tool: step.tool };
      if (step.command) rec.command = step.command;
      if (step.args && Object.keys(step.args).length) rec.args = n.value(resolveArgs(step.tool, step.args, dirs, { noDefaults: true }));
      rec.exit = res.exit;
      if (step.record !== false) {
        if (parsed !== undefined) rec.json = n.value(parsed);
        else {
          const lines = n.text(body).split('\n').map((l) => l.trimEnd());
          while (lines.length && !lines[lines.length - 1]) lines.pop();
          while (lines.length && !lines[0]) lines.shift();
          rec.stdout = lines;
        }
        if (warnings.length) rec.warnings = warnings.map((w) => n.text(w));
        const err = cleanStderr(n.text(res.stderr.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')).split(/\r?\n/));
        if (err.length) rec.stderr = err;
      }
      steps.push(rec);
    }
    const after = snapshot(root);
    if (!steps.length) throw new Error(`case ${kase.id} ran no command step`);
    const files = {};
    const scoped = (rel) => rel.startsWith('data/') || rel.startsWith('lad/overnight-agent/') || rel.startsWith('cwd/');
    const keys = [...new Set([...before.keys(), ...after.keys()])].filter(scoped).sort();
    for (const rel of keys) {
      const a = before.get(rel); const b = after.get(rel);
      const name = n.text(logicalPath(rel));
      if (a && !b) { files[name] = { change: 'deleted' }; continue; }
      if (a && b && a.equals(b)) continue;
      files[name] = { change: a ? 'modified' : 'created', ...describeFile(b, n, rel) };
    }
    return { status: 'ran', result: { id: kase.id, steps, files }, root };
  } finally {
    if (!keep) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

export function stableStringify(v) {
  const sort = (x) => Array.isArray(x) ? x.map(sort) : (x && typeof x === 'object') ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])])) : x;
  return JSON.stringify(sort(v), null, 2) + '\n';
}

export function firstDifference(a, b, where = '$') {
  if (a === b) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return `${where}: expected ${JSON.stringify(a)?.slice(0, 200)} got ${JSON.stringify(b)?.slice(0, 200)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${where}: array vs object`;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const d = firstDifference(a[k], b[k], Array.isArray(a) ? `${where}[${k}]` : `${where}.${k}`);
    if (d) return d;
  }
  return null;
}
