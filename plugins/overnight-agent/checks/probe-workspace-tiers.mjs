#!/usr/bin/env node
/**
 * probe-workspace-tiers.mjs — measure candidate google-workspace configurations.
 *
 * GH #179 assumed the browser slots dominated the tool catalogue. Measured, they do not:
 * google-workspace is 91 tools / 151 KB (66%). This probes candidate --tools / --tool-tier
 * combinations so the cut is chosen on evidence, and verifies each candidate still exposes
 * the tools the Overnight Agent actually depends on.
 */
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';

const UVX = path.join(homedir(), '.local', 'bin', 'uvx.exe');

// Capabilities the agent genuinely uses. A candidate that drops one of these is disqualified,
// regardless of how much it saves.
const REQUIRED = [
  'list_tasks',            // SKILL.md PHASE 2 step 2 - Google Tasks candidates
  'manage_task',           // same, write side
  'get_doc_content',       // task #446 - PARs master doc
  'get_doc_as_markdown',
  'modify_doc_text',       // #446/#356 doc edits
  'find_and_replace_doc',
  'search_drive_files',    // deliverable lookup
  'get_drive_file_content',
  'get_events',            // daily-planner + dance-church skills
  'manage_event',
];

function listTools(args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const child = spawn(UVX, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '', stderr = '', settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* gone */ }
      resolve(v);
    };
    const timer = setTimeout(() => finish({ error: `timeout ${timeoutMs}ms`, stderr: stderr.slice(-300) }), timeoutMs);
    child.on('error', (e) => finish({ error: String(e) }));
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
        } else if (msg.id === 2) {
          const tools = msg.result?.tools ?? [];
          finish({
            count: tools.length,
            bytes: Buffer.byteLength(JSON.stringify(tools), 'utf8'),
            names: tools.map((t) => t.name),
          });
        }
      }
    });
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '1' } },
    }) + '\n');
  });
}

const SERVICES = ['tasks', 'docs', 'drive', 'calendar'];

const candidates = [
  { label: 'current: extended, all services', args: ['workspace-mcp', '--single-user', '--tool-tier', 'extended'] },
  { label: 'core, all services',              args: ['workspace-mcp', '--single-user', '--tool-tier', 'core'] },
  { label: 'extended, 4 services',            args: ['workspace-mcp', '--single-user', '--tool-tier', 'extended', '--tools', ...SERVICES] },
  { label: 'core, 4 services',                args: ['workspace-mcp', '--single-user', '--tool-tier', 'core', '--tools', ...SERVICES] },
];

const rows = [];
for (const c of candidates) {
  process.stderr.write(`  probing: ${c.label}\n`);
  const r = await listTools(c.args);
  rows.push({ ...c, ...r });
}

const base = rows[0];
console.log('\ngoogle-workspace candidate configurations\n');
console.log('  configuration                       tools    bytes     vs now   required-tools');
console.log('  ---------------------------------  ------  --------  --------  --------------');
for (const r of rows) {
  if (r.error) { console.log(`  ${r.label.padEnd(33)}  ERROR ${r.error}`); continue; }
  const have = new Set(r.names);
  const missing = REQUIRED.filter((t) => !have.has(t));
  const delta = base.bytes ? `-${(((base.bytes - r.bytes) / base.bytes) * 100).toFixed(0)}%` : '-';
  const verdict = missing.length ? `MISSING ${missing.length}` : 'all present';
  console.log(`  ${r.label.padEnd(33)}  ${String(r.count).padStart(6)}  ${String(r.bytes).padStart(8)}  ${delta.padStart(8)}  ${verdict}`);
  if (missing.length) console.log(`      missing: ${missing.join(', ')}`);
}
console.log('');
