// skills-inventory.mjs — build the read-only `## Skills` view for the planner (task #357).
//
// WHY: #357 asks for skills to become first-class in the planner. Its own recommended first
// slice is "a read-only `## Skills` section listing your existing skills with a one-line
// purpose and their currently-linked tasks". The APP half of that needs a UI change; the
// DATA half needs nothing but a scan, so this produces the data today.
//
// It answers, from the filesystem rather than from opinion:
//   - which skills exist, and where the real folder lives (the OneDrive library is the
//     source of truth; `~/.copilot/skills` and `~/.agents/skills` hold junctions into it,
//     per the `new-skill-with-symlink` skill);
//   - which harnesses actually pick each one up — the two pickup dirs are NOT symmetric,
//     and a skill missing from one is invisible to that harness;
//   - which planner tasks reference each skill, i.e. the "tasks it is actively working on"
//     that #357 asks a skill row to show.
//
// Usage:  node skills-inventory.mjs [--out <file.md>]
// Pure read + one optional write. Re-runnable; no state.

import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.USERPROFILE || process.env.HOME;
const ONEDRIVE = process.env.OneDrive || path.join(HOME, 'OneDrive');
const PLANNER = process.env.PLANNER_PATH || path.join(ONEDRIVE, 'Apps', 'Focus Planner');

const LIBRARY = path.join(ONEDRIVE, 'skills');
const PICKUPS = [
  { label: 'copilot', dir: path.join(HOME, '.copilot', 'skills') },
  { label: 'agents', dir: path.join(HOME, '.agents', 'skills') },
];
const PLUGINS = path.join(HOME, '.copilot', 'installed-plugins');

function readDirSafe(d) {
  try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; }
}

// Pull `name` + `description` out of a SKILL.md YAML front-matter block. The description is
// often a folded (`>`) multi-line scalar, so continuation lines have to be joined.
function readSkillMeta(dir) {
  const f = path.join(dir, 'SKILL.md');
  let raw;
  try { raw = fs.readFileSync(f, 'utf8'); } catch { return null; }
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { name: path.basename(dir), description: '' };
  const lines = m[1].split(/\r?\n/);
  const meta = { name: path.basename(dir), description: '' };
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^(\w[\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2];
    if (val === '>' || val === '|' || val === '>-' || val === '|-') {
      const buf = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\w[\w-]*:/.test(lines[j])) break;
        buf.push(lines[j].trim());
        i = j;
      }
      val = buf.join(' ').trim();
    }
    if (key === 'name') meta.name = val.trim();
    if (key === 'description') meta.description = val.trim();
  }
  return meta;
}

// First sentence, trimmed to one readable line. YAML scalars may be quoted; strip that.
function oneLine(desc, max = 150) {
  if (!desc) return '';
  let d = desc.trim();
  const q = d[0];
  if ((q === '"' || q === "'") && d.length > 1) {
    d = d.slice(1);
    if (d.endsWith(q)) d = d.slice(0, -1);
  }
  const first = d.split(/(?<=\.)\s+/)[0] || d;
  const s = first.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ---------------------------------------------------------------- discover skills
const skills = new Map(); // slug -> record

function note(slug, dir, origin) {
  if (!skills.has(slug)) {
    skills.set(slug, { slug, dir, origin, meta: readSkillMeta(dir), pickups: new Set(), tasks: [] });
  }
  return skills.get(slug);
}

for (const e of readDirSafe(LIBRARY)) {
  if (!e.isDirectory()) continue;
  const dir = path.join(LIBRARY, e.name);
  if (!fs.existsSync(path.join(dir, 'SKILL.md'))) continue;
  note(e.name, dir, 'library');
}

for (const { label, dir } of PICKUPS) {
  for (const e of readDirSafe(dir)) {
    const p = path.join(dir, e.name);
    if (!fs.existsSync(path.join(p, 'SKILL.md'))) continue;
    let target = p;
    try {
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) target = fs.realpathSync(p);
      else target = fs.realpathSync(p); // junctions resolve through realpath too
    } catch { /* keep p */ }
    const slug = e.name;
    const rec = skills.get(slug) || note(slug, target, target.startsWith(LIBRARY) ? 'library' : `${label}-local`);
    rec.pickups.add(label);
  }
}

// Plugin-contributed skills live under installed-plugins/<plugin>/<pkg>/skills/<slug>.
for (const plug of readDirSafe(PLUGINS)) {
  if (!plug.isDirectory()) continue;
  const base = path.join(PLUGINS, plug.name);
  const stack = [base];
  while (stack.length) {
    const cur = stack.pop();
    for (const e of readDirSafe(cur)) {
      if (!e.isDirectory()) continue;
      const p = path.join(cur, e.name);
      if (fs.existsSync(path.join(p, 'SKILL.md'))) {
        const rec = note(e.name, p, `plugin:${plug.name}`);
        rec.pickups.add('plugin');
      } else if (p.split(path.sep).length - base.split(path.sep).length < 4) {
        stack.push(p);
      }
    }
  }
}

// ---------------------------------------------------------------- link skills to tasks
// A task "uses" a skill if its board row or its journal names the skill slug.
const board = fs.existsSync(path.join(PLANNER, 'planner.md'))
  ? fs.readFileSync(path.join(PLANNER, 'planner.md'), 'utf8')
  : '';
const titles = new Map();
for (const line of board.split(/\r?\n/)) {
  const m = line.match(/^\|\s*(\d+)[^|]*\|[^|]*\|\s*([^|]+?)\s*\|/);
  if (m) titles.set(m[1], m[2].trim());
}

const JOURNAL = path.join(PLANNER, 'journal');
for (const f of readDirSafe(JOURNAL)) {
  const m = f.name && f.name.match(/^task-(\d+)\.md$/);
  if (!m) continue;
  const id = m[1];
  if (!titles.has(id)) continue; // active board rows only
  let text = '';
  try { text = fs.readFileSync(path.join(JOURNAL, f.name), 'utf8'); } catch { continue; }
  // Strip the agent's own structural markers first. Every journal contains the
  // `OVERNIGHT-AGENT` sentinel and `from: overnight-agent` turn markers by construction,
  // so without this the `overnight-agent` skill "matches" all 122 active tasks and the
  // column becomes noise instead of signal.
  const body = text
    .replace(/<!--\s*OVERNIGHT-AGENT[^>]*-->/gi, '')
    .replace(/<!--\s*from:\s*overnight-agent\s*-->/gi, '')
    .replace(/^##\s*🌙\s*Overnight Agent.*$/gim, '');
  for (const rec of skills.values()) {
    // Match the slug as a word, so `youtube-to-md` does not match inside a URL slug soup.
    const re = new RegExp(`(^|[^\\w-])${rec.slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w-]|$)`, 'i');
    if (re.test(body)) rec.tasks.push(id);
  }
}

// ---------------------------------------------------------------- render
const all = [...skills.values()].sort((a, b) => a.slug.localeCompare(b.slug));
const out = [];
out.push('## Skills');
out.push('');
out.push(`*Generated ${new Date().toISOString().slice(0, 10)} by \`skills-inventory.mjs\` — read-only view for task #357.*`);
out.push('');
out.push('| Skill | Purpose | Source | Picked up by | Active tasks |');
out.push('| --- | --- | --- | --- | --- |');
for (const r of all) {
  const pickups = [...r.pickups].sort().join(', ') || '**none**';
  const tasks = r.tasks.length
    ? r.tasks.sort((a, b) => Number(a) - Number(b)).map((t) => `#${t}`).join(' ')
    : '—';
  const source = r.origin === 'library' ? 'OneDrive library' : r.origin;
  out.push(`| \`${r.slug}\` | ${oneLine(r.meta?.description) || '—'} | ${source} | ${pickups} | ${tasks} |`);
}
out.push('');

// Asymmetries worth surfacing: a skill in the library that a harness cannot see, and a
// library copy that nothing links to at all (which is a DRIFT hazard — editing it has no
// effect, because the live copy is being served from somewhere else).
const gaps = all.filter((r) => r.origin === 'library' && !(r.pickups.has('copilot') && r.pickups.has('agents')));
if (gaps.length) {
  out.push('### Pickup gaps');
  out.push('');
  out.push('Skills whose OneDrive-library folder is **not** linked into both harness pickup dirs, so at');
  out.push('least one harness cannot load them:');
  out.push('');
  for (const r of gaps) {
    const missing = ['copilot', 'agents'].filter((p) => !r.pickups.has(p));
    const where = missing.map((m) => (m === 'copilot' ? '`~/.copilot/skills`' : '`~/.agents/skills`')).join(' and ');
    const served = r.pickups.has('plugin')
      ? ' — but a **plugin** supplies a separate copy, so the library folder is an unlinked duplicate and edits to it do nothing'
      : '';
    out.push(`- \`${r.slug}\` — missing from ${where}${served}`);
  }
  out.push('');
}

const text = out.join('\n');
const argIdx = process.argv.indexOf('--out');
if (argIdx !== -1 && process.argv[argIdx + 1]) {
  fs.writeFileSync(process.argv[argIdx + 1], text, 'utf8');
  console.log(`wrote ${process.argv[argIdx + 1]} (${all.length} skills, ${gaps.length} pickup gaps)`);
} else {
  console.log(text);
}
