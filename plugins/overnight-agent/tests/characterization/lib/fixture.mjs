// Fixture materialisation: copy a fixture into a fresh sandbox, expanding clock/path tokens.
//
// Fixture layout (every part optional):
//   <fixture>/data/     the planner data folder   -> <ROOT>/data
//   <fixture>/home/     the OA home (%LOCALAPPDATA%\overnight-agent) -> <ROOT>/lad/overnight-agent
//   <fixture>/state/    the host state dir (task-<id>.json)          -> <ROOT>/lad/overnight-agent/state
//   <fixture>/fixture.json   { "extends": "<other fixture>", "mtimes": { "<sandbox rel path>": "-2h" } }
//
// Tokens (expanded in every UTF-8 text file that contains `{{`, and in case `files` overlays):
//   {{NOW}} {{NOW-30m}} {{NOW+2d}}   local ISO-8601 with offset   (units: s m h d)
//   {{UTC}} {{UTC-20m}}              UTC ISO-8601 with `Z`
//   {{DATE}} {{DATE-1d}}             local yyyy-MM-dd
//   {{STAMP-5m}}                     local yyyyMMdd-HHmm (write-turn backup stamp shape)
//   {{ROOT}} / {{ROOT_JSON}}         the sandbox root, native separators / JSON-escaped
// All clock tokens are relative to the case clock T0, which is also what the normaliser folds
// generated timestamps back against -- so a golden reads the same on every day it is run.
import fs from 'node:fs';
import path from 'node:path';

export const LAYOUT = { data: 'data', home: path.join('lad', 'overnight-agent'), state: path.join('lad', 'overnight-agent', 'state') };

const pad = (n, w = 2) => String(n).padStart(w, '0');
function offsetOf(d) {
  const m = -d.getTimezoneOffset();
  return (m >= 0 ? '+' : '-') + pad(Math.floor(Math.abs(m) / 60)) + ':' + pad(Math.abs(m) % 60);
}
export function localIso(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${offsetOf(d)}`;
}
const UNIT = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
function shift(t0, spec) {
  if (!spec) return t0;
  const m = /^([+-])(\d+)([smhd])$/.exec(spec);
  if (!m) throw new Error(`bad clock offset '${spec}'`);
  return t0 + (m[1] === '-' ? -1 : 1) * Number(m[2]) * UNIT[m[3]];
}

export function expandTokens(text, { t0, root }) {
  return text.replace(/\{\{(NOW|UTC|DATE|STAMP|ROOT_JSON|ROOT)([+-]\d+[smhd])?\}\}/g, (_, kind, off) => {
    if (kind === 'ROOT') return root;
    if (kind === 'ROOT_JSON') return JSON.stringify(root).slice(1, -1);
    const d = new Date(shift(t0, off));
    if (kind === 'NOW') return localIso(d);
    if (kind === 'UTC') return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
    if (kind === 'DATE') return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  });
}

function copyTree(src, dst, ctx) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) { copyTree(s, d, ctx); continue; }
    if (ent.name === '.gitkeep') continue;
    const buf = fs.readFileSync(s);
    const txt = buf.toString('utf8');
    if (txt.includes('{{') && Buffer.from(txt, 'utf8').equals(buf)) fs.writeFileSync(d, expandTokens(txt, ctx), 'utf8');
    else fs.writeFileSync(d, buf);
  }
}

function fixtureChain(fixturesDir, name, seen = new Set()) {
  if (seen.has(name)) throw new Error(`fixture cycle at ${name}`);
  seen.add(name);
  const dir = path.join(fixturesDir, name);
  if (!fs.existsSync(dir)) throw new Error(`fixture not found: ${name}`);
  const metaPath = path.join(dir, 'fixture.json');
  const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {};
  const parents = meta.extends ? fixtureChain(fixturesDir, meta.extends, seen) : [];
  return [...parents, { dir, meta }];
}

// Map a case-relative path (`data/...`, `home/...`, `state/...`, `input/...`) to the sandbox.
export function sandboxPath(root, rel) {
  const parts = rel.replace(/\\/g, '/').split('/');
  const head = parts.shift();
  const base = LAYOUT[head] ?? head;
  return path.join(root, base, ...parts);
}

export function materialize({ fixturesDir, fixture, root, t0, files, mtimes }) {
  const ctx = { t0, root };
  const allMtimes = {};
  for (const { dir, meta } of fixtureChain(fixturesDir, fixture)) {
    copyTree(path.join(dir, 'data'), path.join(root, LAYOUT.data), ctx);
    copyTree(path.join(dir, 'home'), path.join(root, LAYOUT.home), ctx);
    copyTree(path.join(dir, 'state'), path.join(root, LAYOUT.state), ctx);
    Object.assign(allMtimes, meta.mtimes || {});
  }
  for (const d of Object.values(LAYOUT)) fs.mkdirSync(path.join(root, d), { recursive: true });
  for (const [rel, content] of Object.entries(files || {})) {
    const p = sandboxPath(root, rel);
    if (content === null) { fs.rmSync(p, { recursive: true, force: true }); continue; }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (typeof content === 'object' && content.dir) { fs.mkdirSync(p, { recursive: true }); continue; }
    const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    fs.writeFileSync(p, expandTokens(text, ctx), 'utf8');
  }
  Object.assign(allMtimes, mtimes || {});
  for (const [rel, off] of Object.entries(allMtimes)) {
    const p = sandboxPath(root, rel);
    if (!fs.existsSync(p)) continue;
    const when = new Date(shift(t0, off));
    fs.utimesSync(p, when, when);
  }
}

// Snapshot every file under the sandbox except the scratch `input/` and `cwd/` areas.
export function snapshot(root) {
  const out = new Map();
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(p); continue; }
      const rel = path.relative(root, p).split(path.sep).join('/');
      if (rel.startsWith('input/')) continue;
      out.set(rel, fs.readFileSync(p));
    }
  };
  walk(root);
  return out;
}

// Presentational: the sandbox layout folded back to the fixture's logical names.
export function logicalPath(rel) {
  const home = LAYOUT.home.split(path.sep).join('/');
  if (rel.startsWith(home + '/state/')) return 'state/' + rel.slice(home.length + 7);
  if (rel.startsWith(home + '/')) return 'home/' + rel.slice(home.length + 1);
  return rel;
}
