#!/usr/bin/env node
/**
 * measure-tool-catalogue.mjs — measure what the model actually pays for, per MCP server.
 *
 * GH #179: "~120 tool schemas advertised per turn, most of them duplicate browser slots
 * or an unused integration." That issue's numbers were counted by eye from a tool list.
 * This measures them: it speaks MCP to every stdio/local server in ~/.copilot/mcp-config.json,
 * calls tools/list, and reports tool COUNT and serialized SCHEMA BYTES per server.
 *
 * Bytes are the honest unit. A count of 24 says nothing about cost when one server's
 * descriptions are three lines and another's are thirty.
 *
 * Usage:  node measure-tool-catalogue.mjs [--json]
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const CONFIG = path.join(homedir(), '.copilot', 'mcp-config.json');
const SETTINGS = path.join(homedir(), '.copilot', 'settings.json');

function readJson(p, fallback) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; }
}

function listTools(name, server, timeoutMs = 90000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(server.command, server.args ?? [], {
        env: { ...process.env, ...(server.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      return resolve({ name, error: String(e) });
    }

    let buf = '';
    let stderr = '';
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      resolve(v);
    };

    const timer = setTimeout(
      () => finish({ name, error: `timeout ${timeoutMs}ms`, stderr: stderr.slice(-400) }),
      timeoutMs,
    );

    child.on('error', (e) => finish({ name, error: String(e) }));
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }

        if (msg.id === 1) {
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
        } else if (msg.id === 2) {
          const tools = msg.result?.tools ?? [];
          finish({
            name,
            count: tools.length,
            bytes: Buffer.byteLength(JSON.stringify(tools), 'utf8'),
            tools: tools.map((t) => ({
              name: t.name,
              bytes: Buffer.byteLength(JSON.stringify(t), 'utf8'),
            })),
          });
        }
      }
    });

    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'measure-tool-catalogue', version: '1.0.0' },
      },
    }) + '\n');
  });
}

const cfg = readJson(CONFIG, { mcpServers: {} });
const settings = readJson(SETTINGS, {});
const disabled = new Set(settings.disabledMcpServers ?? []);

const entries = Object.entries(cfg.mcpServers ?? {});
const reachable = entries.filter(([n, s]) =>
  !disabled.has(n) && (s.type === 'stdio' || s.type === 'local'));
const unreachable = entries.filter(([n, s]) =>
  !disabled.has(n) && s.type !== 'stdio' && s.type !== 'local');

const results = [];
for (const [name, server] of reachable) {
  process.stderr.write(`  probing ${name}...\n`);
  results.push(await listTools(name, server));
}

const ok = results.filter((r) => !r.error).sort((a, b) => b.bytes - a.bytes);
const failed = results.filter((r) => r.error);

// Identify duplicate tool surfaces: servers whose tool-NAME set is identical.
const sig = new Map();
for (const r of ok) {
  const key = r.tools.map((t) => t.name).sort().join('|');
  if (!sig.has(key)) sig.set(key, []);
  sig.get(key).push(r);
}
const dupes = [...sig.values()].filter((g) => g.length > 1);

const totalCount = ok.reduce((a, r) => a + r.count, 0);
const totalBytes = ok.reduce((a, r) => a + r.bytes, 0);

// Savings if each duplicate surface collapses to ONE (issue #179, option 1).
let dupCount = 0;
let dupBytes = 0;
for (const g of dupes) {
  for (const r of g.slice(1)) { dupCount += r.count; dupBytes += r.bytes; }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({
    measuredAt: new Date().toISOString(),
    servers: ok, failed,
    unreachable: unreachable.map(([n, s]) => ({ name: n, type: s.type })),
    disabled: [...disabled],
    totalCount, totalBytes,
    duplicateSurfaces: dupes.map((g) => ({
      tools: g[0].count,
      servers: g.map((r) => r.name),
      redundantCount: g.slice(1).reduce((a, r) => a + r.count, 0),
      redundantBytes: g.slice(1).reduce((a, r) => a + r.bytes, 0),
    })),
    collapsibleCount: dupCount, collapsibleBytes: dupBytes,
  }, null, 2));
} else {
  console.log('\nMCP tool catalogue — measured, not counted by eye\n');
  console.log('  server                     tools     schema bytes');
  console.log('  ------------------------  ------  ---------------');
  for (const r of ok) {
    console.log(`  ${r.name.padEnd(24)}  ${String(r.count).padStart(6)}  ${r.bytes.toLocaleString().padStart(15)}`);
  }
  console.log('  ------------------------  ------  ---------------');
  console.log(`  ${'TOTAL (stdio/local)'.padEnd(24)}  ${String(totalCount).padStart(6)}  ${totalBytes.toLocaleString().padStart(15)}`);

  if (unreachable.length) {
    console.log(`\n  not measurable over stdio (http servers, still advertised): ${unreachable.map(([n]) => n).join(', ')}`);
  }
  if (failed.length) {
    console.log('\n  FAILED to probe:');
    for (const f of failed) console.log(`    ${f.name}: ${f.error}`);
  }
  if (dupes.length) {
    console.log('\n  Duplicate tool surfaces (identical tool-name sets):');
    for (const g of dupes) {
      console.log(`    ${g.length} x ${g[0].count} tools -> ${g.map((r) => r.name).join(', ')}`);
    }
    const pct = totalBytes ? ((dupBytes / totalBytes) * 100).toFixed(1) : '0';
    console.log(`\n  Collapsing each duplicate surface to one would remove ${dupCount} tools / ${dupBytes.toLocaleString()} bytes (${pct}% of measured catalogue).`);
  }
  console.log('');
}
