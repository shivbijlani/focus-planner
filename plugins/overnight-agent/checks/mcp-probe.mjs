#!/usr/bin/env node
/**
 * mcp-probe.mjs — speak MCP (JSON-RPC over stdio) to a configured server directly.
 *
 * Why this exists: the Copilot session does not always load every server listed in
 * ~/.copilot/mcp-config.json. When the `email` server is missing from the agent's tool
 * list, PHASE 0's inbox check silently reads as "0 unread" — which is exactly the
 * failure mode user-settings.md warns about (emailed instructions get dropped and
 * nobody notices). This gives the run a transport-independent way to reach the server.
 *
 * Usage:
 *   node mcp-probe.mjs <serverName> list
 *   node mcp-probe.mjs <serverName> call <toolName> '<jsonArgs>'
 *   node mcp-probe.mjs <serverName> calls '[{"name":"t1","arguments":{}},{"name":"t2"}]'
 *
 * `calls` runs several tools inside ONE server session and prints one JSON array,
 * element i being `{ result }` or `{ error }` for step i. That is not only cheaper
 * than N spawns (one handshake, one IMAP connect): it is the only way a health probe
 * can prove the SAME connection the payload call used. Two separate sessions can
 * disagree — a probe that passes on connection A says nothing about connection B —
 * which is the ambiguity GH #346 is about, reintroduced one layer down.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const CONFIG = path.join(homedir(), '.copilot', 'mcp-config.json');

function loadServer(name) {
  const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
  const s = cfg.mcpServers?.[name];
  if (!s) throw new Error(`server '${name}' not in ${CONFIG}`);
  if (s.type !== 'stdio' && s.type !== 'local') {
    throw new Error(`server '${name}' is type '${s.type}'; this probe only speaks stdio`);
  }
  return s;
}

function runSession(server, steps, timeoutMs = Number(process.env.MCP_PROBE_TIMEOUT_MS) || 90000) {
  return new Promise((resolve, reject) => {
    const child = spawn(server.command, server.args ?? [], {
      env: { ...process.env, ...(server.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let buf = '';
    let stderr = '';
    const pending = new Map();
    let nextId = 1;
    const results = [];

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timeout after ${timeoutMs}ms; stderr:\n${stderr.slice(-2000)}`));
    }, timeoutMs);

    const send = (method, params) => {
      const id = nextId++;
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      child.stdin.write(msg + '\n');
      return new Promise((res) => pending.set(id, res));
    };

    const notify = (method, params) => {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    };

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
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      }
    });

    child.on('error', (e) => { clearTimeout(timer); reject(e); });

    (async () => {
      await send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'overnight-agent-probe', version: '1.0.0' },
      });
      notify('notifications/initialized', {});
      for (const step of steps) {
        results.push(await send(step.method, step.params));
      }
      clearTimeout(timer);
      child.kill();
      resolve({ results, stderr });
    })().catch((e) => { clearTimeout(timer); child.kill(); reject(e); });
  });
}

const [, , serverName, action, toolName, toolArgs] = process.argv;
if (!serverName || !action) {
  console.error('usage: mcp-probe.mjs <server> list | call <tool> <jsonArgs> | calls <jsonSteps>');
  process.exit(2);
}

const server = loadServer(serverName);

// `calls` takes its step list from argv[4] (there is no separate tool name), so the
// positional destructuring above lands the JSON in `toolName`, not `toolArgs`.
const callSteps =
  action === 'calls'
    ? JSON.parse(toolName || '[]').map((s) => ({
        method: 'tools/call',
        params: { name: s.name, arguments: s.arguments ?? {} },
      }))
    : [];

const steps =
  action === 'list'
    ? [{ method: 'tools/list', params: {} }]
    : action === 'calls'
      ? callSteps
      : [{ method: 'tools/call', params: { name: toolName, arguments: JSON.parse(toolArgs || '{}') } }];

runSession(server, steps)
  .then(({ results }) => {
    if (action === 'calls') {
      // One array, one element per step, in order. A step that errored is reported as
      // `{ error }` rather than dropped: a short array would silently renumber the
      // steps after it, so the caller could attribute one call's answer to another.
      const out = results.map((r) => (r.error ? { error: r.error } : { result: r.result }));
      console.log(JSON.stringify(out, null, 2));
      return;
    }
    for (const r of results) {
      if (r.error) { console.log(JSON.stringify({ error: r.error }, null, 2)); continue; }
      if (action === 'list') {
        console.log(JSON.stringify((r.result?.tools ?? []).map((t) => t.name), null, 2));
      } else {
        console.log(JSON.stringify(r.result, null, 2));
      }
    }
  })
  .catch((e) => { console.error('PROBE FAILED:', e.message); process.exit(1); });
