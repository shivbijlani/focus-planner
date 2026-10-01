#!/usr/bin/env node
// Overnight Agent characterization (golden) harness.
//
//   node run.mjs --impl ps|node [--update] [--filter <regex>] [--jobs N] [--repeat N] [--keep]
//   node run.mjs --list [--filter <regex>]          # cases and per-command counts
//   node run.mjs --shadow [--data <planner folder>] [--state <state dir>] [--sample N]
//
// See README.md in this folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCase, normalizeCase, stableStringify, firstDifference } from './lib/engine.mjs';
import { runShadow } from './lib/shadow.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..', '..');
const SKILL = path.join(REPO, 'plugins', 'overnight-agent', 'skills', 'overnight-agent');
const PATHS = {
  fixturesDir: path.join(HERE, 'fixtures'),
  goldenDir: path.join(HERE, 'golden'),
  casesDir: path.join(HERE, 'cases'),
  stubsDir: path.join(HERE, 'stubs'),
  skillDir: fs.realpathSync.native(SKILL),
  repoDir: fs.realpathSync.native(REPO),
};

function parseArgs(argv) {
  const o = { impl: null, update: false, filter: null, jobs: Math.max(1, Math.min(8, os.cpus().length)), repeat: 1, keep: false, list: false, shadow: false, prune: false, sample: 25 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    switch (a) {
      case '--impl': o.impl = val(); break;
      case '--update': o.update = true; break;
      case '--prune': o.prune = true; break;
      case '--filter': o.filter = new RegExp(val()); break;
      case '--jobs': o.jobs = Number(val()); break;
      case '--repeat': o.repeat = Number(val()); break;
      case '--keep': o.keep = true; break;
      case '--list': o.list = true; break;
      case '--coverage': o.coverage = true; break;
      case '--any-tz': o.anyTz = true; break;
      case '--shadow': o.shadow = true; break;
      case '--data': o.data = val(); break;
      case '--state': o.state = val(); break;
      case '--out': o.out = val(); break;
      case '--sample': o.sample = Number(val()); break;
      case '-h': case '--help': o.help = true; break;
      default: throw new Error(`unknown argument ${a}`);
    }
  }
  return o;
}

export function loadCases(casesDir = PATHS.casesDir) {
  const all = [];
  for (const f of fs.readdirSync(casesDir).filter((x) => x.endsWith('.json')).sort()) {
    const doc = JSON.parse(fs.readFileSync(path.join(casesDir, f), 'utf8'));
    const list = Array.isArray(doc) ? doc : doc.cases;
    const defaults = Array.isArray(doc) ? {} : { fixture: doc.fixture, covers: doc.covers };
    for (const c of list) {
      const k = normalizeCase(c, defaults);
      k.source = f;
      k.covers = [...new Set([...(defaults.covers || []), ...(c.covers || [])])];
      all.push(k);
    }
  }
  const seen = new Set();
  for (const c of all) {
    if (!c.id) throw new Error(`a case in ${c.source} has no id`);
    if (seen.has(c.id)) throw new Error(`duplicate case id ${c.id}`);
    seen.add(c.id);
  }
  return all;
}

const goldenPath = (id) => path.join(PATHS.goldenDir, id.replace(/[^A-Za-z0-9._-]+/g, '__') + '.json');

async function pool(items, jobs, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await fn(items[i], i); }
  }));
  return results;
}

function coverageTable(cases) {
  const by = {};
  for (const c of cases) for (const m of c.covers) (by[m] ||= []).push(c);
  const rows = Object.keys(by).sort().map((m) => {
    const list = by[m];
    const notes = list.map((c) => `\`${c.id}\``).join('<br>');
    return `| \`${m}\` | ${list.length} | ${notes} |`;
  });
  return ['| Mutcheck | Cases | Case ids |', '|---|---|---|', ...rows].join('\n');
}

function writeCoverage(cases) {
  const readme = path.join(HERE, 'README.md');
  const text = fs.readFileSync(readme, 'utf8');
  const table = coverageTable(cases);
  const next = text.replace(/<!-- COVERAGE:BEGIN -->[\s\S]*<!-- COVERAGE:END -->/, `<!-- COVERAGE:BEGIN -->\n${table}\n<!-- COVERAGE:END -->`);
  fs.writeFileSync(readme, next);
  console.log(table);
}

function listCases(cases) {
  const byCmd = {};
  const byCover = {};
  for (const c of cases) {
    for (const s of c.steps.filter((s) => s.tool)) {
      const key = s.tool === 'oa-state' ? `oa-state ${s.command}` : 'write-turn';
      byCmd[key] = (byCmd[key] || 0) + 1;
    }
    for (const m of c.covers) byCover[m] = (byCover[m] || 0) + 1;
  }
  for (const c of cases) console.log(`${c.id}  [${c.source}]`);
  console.log(`\n${cases.length} case(s). Command invocations (steps):`);
  for (const [k, v] of Object.entries(byCmd).sort()) console.log(`  ${k.padEnd(28)} ${v}`);
  console.log(`\nmutchecks covered: ${Object.keys(byCover).length}`);
  for (const [k, v] of Object.entries(byCover).sort()) console.log(`  ${k.padEnd(40)} ${v}`);
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  checkTimeZone(o);
  if (o.help) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 8).join('\n')); return 0; }
  if (o.shadow) return runShadow({ ...o, ...PATHS, loadAdapter });
  let cases = loadCases();
  if (o.filter) cases = cases.filter((c) => o.filter.test(c.id));
  if (o.list) { listCases(cases); return 0; }
  if (o.coverage) { writeCoverage(loadCases()); return 0; }
  if (!o.impl) throw new Error('--impl ps|node is required');
  if (o.update && o.impl !== 'ps') throw new Error('--update is only allowed with --impl ps: goldens record the CURRENT (PowerShell) behaviour');
  const adapter = await loadAdapter(o.impl);
  console.log(`characterization: ${cases.length} case(s), impl=${adapter.name} (${adapter.describe()}), jobs=${o.jobs}, repeat=${o.repeat}`);
  const started = Date.now();
  const counts = { pass: 0, fail: 0, skip: 0, updated: 0, new: 0, nondeterministic: 0 };
  const failures = [];
  await pool(cases, o.jobs, async (kase) => {
    const runs = [];
    for (let r = 0; r < o.repeat; r++) {
      let res;
      try { res = await runCase(kase, { adapter, ...PATHS, keep: o.keep }); }
      catch (e) { res = { status: 'error', reason: e.stack || String(e) }; }
      runs.push(res);
      if (res.status !== 'ran') break;
    }
    const first = runs[0];
    if (first.status === 'skip') { counts.skip++; console.log(`SKIP  ${kase.id} -- ${first.reason}`); return; }
    if (first.status === 'error') { counts.fail++; failures.push(kase.id); console.log(`ERROR ${kase.id}\n${first.reason}`); return; }
    const text = stableStringify(first.result);
    for (const r of runs.slice(1)) {
      const t = stableStringify(r.result);
      if (t !== text) {
        counts.nondeterministic++; counts.fail++; failures.push(kase.id);
        console.log(`NONDETERMINISTIC ${kase.id}: ${firstDifference(first.result, r.result)}`);
        return;
      }
    }
    const gp = goldenPath(kase.id);
    const golden = fs.existsSync(gp) ? fs.readFileSync(gp, 'utf8') : null;
    if (o.update) {
      if (golden !== text) { fs.mkdirSync(PATHS.goldenDir, { recursive: true }); fs.writeFileSync(gp, text); counts[golden ? 'updated' : 'new']++; console.log(`${golden ? 'UPDATE' : 'NEW   '} ${kase.id}`); }
      counts.pass++;
      return;
    }
    if (golden === null) { counts.fail++; failures.push(kase.id); console.log(`MISSING GOLDEN ${kase.id} (run --impl ps --update)`); return; }
    if (golden === text) { counts.pass++; return; }
    counts.fail++; failures.push(kase.id);
    console.log(`FAIL  ${kase.id}: ${firstDifference(JSON.parse(golden), JSON.parse(text))}`);
    if (o.keep) console.log(`      sandbox kept at ${first.root}`);
  });
  if (o.update && o.prune && !o.filter) {
    const live = new Set(cases.map((c) => path.basename(goldenPath(c.id))));
    for (const f of fs.readdirSync(PATHS.goldenDir)) if (f.endsWith('.json') && !live.has(f)) { fs.rmSync(path.join(PATHS.goldenDir, f)); console.log(`PRUNE ${f}`); }
  }
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\npass ${counts.pass}  fail ${counts.fail}  skip ${counts.skip}` + (o.update ? `  (new ${counts.new}, updated ${counts.updated})` : '') + (counts.nondeterministic ? `  nondeterministic ${counts.nondeterministic}` : '') + `  in ${secs}s`);
  if (failures.length) console.log(`failed: ${failures.join(', ')}`);
  return counts.fail ? 1 : 0;
}

async function loadAdapter(name) {
  if (!['ps', 'node'].includes(name)) throw new Error(`unknown --impl '${name}' (ps|node)`);
  return (await import(`./adapters/${name}.mjs`)).default;
}

// The goldens were recorded in one time zone, and some observables are rendered in LOCAL time
// (PowerShell turns an ISO string from JSON into a local [datetime]; fixed 2020 timestamps print as
// `-08:00`). So the zone is part of the environment contract, like the clock: it is checked, never
// normalised away. CI pins it with `tzutil /s "Pacific Standard Time"`; elsewhere set the zone or
// export TZ (honoured by .NET and node on Linux/macOS).
const GOLDEN_TZ = 'America/Los_Angeles';
function checkTimeZone(o) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (tz === GOLDEN_TZ || o.anyTz || o.list || o.coverage || o.shadow) return;
  throw new Error(`goldens are recorded in ${GOLDEN_TZ} but this machine is ${tz}. ` +
    'Windows: tzutil /s "Pacific Standard Time"  |  Linux/macOS: TZ=America/Los_Angeles  |  or pass --any-tz to run anyway');
}

main().then((code) => { process.exitCode = code; }, (e) => { console.error(e.stack || String(e)); process.exitCode = 2; });
