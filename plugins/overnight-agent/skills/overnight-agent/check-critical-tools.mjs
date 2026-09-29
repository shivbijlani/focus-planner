#!/usr/bin/env node
// PHASE 0: real reads, persistent outage transitions, and a single alert per transition/day.
import { execFileSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSettingRow } from '../../checks/settings-value.mjs';
import { gapForAlert, recordRunStart } from './run-ledger.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const plugin = path.resolve(here, '..', '..');
const firstExisting = (...paths) => paths.find((p) => {
  try { readFileSync(p); return true; } catch { return false; }
});
const prober = firstExisting(path.join(here, 'mcp-probe.mjs'), path.join(plugin, 'checks', 'mcp-probe.mjs'));
const statePath = process.env.OA_CAPABILITIES_PATH ??
  path.join(process.env.LOCALAPPDATA || tmpdir(), 'overnight-agent', 'capabilities.json');
const ledgerPath = process.env.OA_RUN_LEDGER_PATH ??
  path.join(process.env.LOCALAPPDATA || tmpdir(), 'overnight-agent', 'run-ledger.jsonl');
const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';

function call(server, action, ...args) {
  if (!prober) throw new Error('mcp-probe.mjs not found');
  const raw = execFileSync(process.execPath, [prober, server, action, ...args], {
    encoding: 'utf8', timeout: 45000, maxBuffer: 1024 * 1024, windowsHide: true,
  });
  const result = JSON.parse(raw);
  if (result.error || result.isError) throw new Error(JSON.stringify(result.error ?? result));
  return result;
}

function payload(result) {
  if (result.error || result.isError) throw new Error(`MCP tool error: ${JSON.stringify(result.error ?? result)}`);
  const text = result.content?.find((c) => c.type === 'text')?.text;
  if (!text) throw new Error('tool returned no text payload');
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error(`tool returned non-JSON payload: ${text.slice(0, 200)}`); }
  if (parsed.error || parsed.success === false) throw new Error(JSON.stringify(parsed));
  return parsed;
}

function successfulCall(result) {
  if (result.error || result.isError) {
    throw new Error(`MCP tool error: ${JSON.stringify(result.error ?? result)}`);
  }
  return result;
}

export async function probeTool(name, settings, deps = { call }) {
  if (name === 'email') {
    const accounts = payload(deps.call(name, 'call', 'email_list_accounts', '{}'));
    const account = accounts.find((a) => a.email === readSettingRow(settings, 'Agent email account')) ??
      (accounts.length === 1 ? accounts[0] : null);
    if (!account?.id) throw new Error('email account not uniquely identified');
    const health = payload(deps.call(name, 'call', 'email_test_account',
      JSON.stringify({ accountId: account.id })));
    if (health.success !== true) throw new Error('email_test_account did not report success=true');
    return;
  }
  if (name === 'google-workspace') {
    const address = readSettingRow(settings, 'Google account (Tasks)');
    if (!address || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      throw new Error('Google account (Tasks) must name the consented account for the real-call probe');
    }
    successfulCall(deps.call(name, 'call', 'list_tasks', JSON.stringify({
      user_google_email: address, task_list_id: '@default', max_results: 1,
    })));
    return;
  }
  // Never treat tools/list itself as proof of a working server. A generic zero-argument,
  // read-shaped tool is the only safe automatic probe for an arbitrary configured server.
  const tools = deps.call(name, 'describe');
  const read = tools.find((t) => /^(list|get|search|status|health|test)_/i.test(t.name) &&
    !t.inputSchema?.required?.length);
  if (!read) throw new Error(`no safe zero-argument read probe for '${name}'`);
  successfulCall(deps.call(name, 'call', read.name, '{}'));
}

function headline(name, error, since) {
  return `⛔ CRITICAL TOOL DOWN: ${name}. ${error}. Since ${since}.`;
}

export async function evaluate({ names, settings = '', previous = {}, now = new Date(), probe = probeTool,
  notify = async () => false, tasks = [] }) {
  const outages = { ...previous.outages };
  const results = {};
  const lines = [];
  const day = now.toISOString().slice(0, 10);
  for (const name of names) {
    let error = null;
    try { await probe(name, settings); } catch (e) { error = e.message; }
    const before = outages[name];
    if (error) {
      const entry = before?.status === 'down' ? before : {
        firstSeenAt: now.toISOString(), lastAlertDate: null, status: 'down',
      };
      entry.error = error;
      outages[name] = entry;
      results[name] = { status: 'down', error, firstSeenAt: entry.firstSeenAt };
      lines.push(headline(name, error, entry.firstSeenAt));
      if (entry.lastAlertDate !== day) {
        const kind = entry.lastAlertDate ? 'reminder' : 'outage';
        if (await notify(headline(name, error, entry.firstSeenAt), kind, name)) {
          entry.lastAlertDate = day;
        }
      }
    } else {
      results[name] = { status: 'ok', checkedAt: now.toISOString() };
      if (before) {
        const text = `✅ CRITICAL TOOL RECOVERED: ${name}. Outage since ${before.firstSeenAt}.`;
        if (await notify(text, 'recovered', name)) delete outages[name];
        else outages[name] = { ...before, status: 'recovered' };
      }
    }
  }
  const down = Object.entries(results).filter(([, value]) => value.status === 'down').map(([name]) => name);
  const skipped = tasks.filter((task) => task.requires?.some((name) => down.includes(name)))
    .map((task) => ({ id: task.id, reason: `blocked: ${task.requires.find((name) => down.includes(name))} down` }));
  return {
    schema: 'oa-capabilities/1', checkedAt: now.toISOString(),
    status: down.length ? 'degraded' : 'completed',
    headline: lines[0] ?? '', wrapUp: lines.join('\n'), tools: results, outages, skipped,
  };
}

function readState(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed.schema !== 'oa-capabilities/1') throw new Error(`unexpected schema ${parsed.schema}`);
    return parsed;
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
}

function store(file, data) {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(temporary, file);
}

function settingsFrom(pathname) {
  if (!pathname) return '';
  return readFileSync(pathname, 'utf8');
}

async function sendAlert(text, settings, down) {
  // An alert is acknowledged only after a successful send, never after an attempted call.
  const dm = readSettingRow(settings, 'Critical alert Telegram DM');
  if (dm && !down.includes('telegram')) {
    try {
      payload(call('telegram', 'call', 'message', JSON.stringify({
        action: 'send', chat_id: dm, text,
      })));
      return true;
    } catch (e) { console.error(`Telegram alert failed: ${e.message}`); }
  }
  const address = readSettingRow(settings, 'Critical alert email') ||
    readSettingRow(settings, 'Agent email account');
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) && !down.includes('email')) {
    try {
      const accounts = payload(call('email', 'call', 'email_list_accounts', '{}'));
      const account = accounts.find((a) =>
        a.email === readSettingRow(settings, 'Agent email account')) ??
        (accounts.length === 1 ? accounts[0] : null);
      if (!account?.id) throw new Error('email account not uniquely identified');
      payload(call('email', 'call', 'email_send', JSON.stringify({
        accountId: account.id, to: [{ email: address }], subject: text.slice(0, 120),
        body: { text },
      })));
      return true;
    } catch (e) { console.error(`Email alert failed: ${e.message}`); }
  }
  console.error('Critical alert undelivered: configure Critical alert Telegram DM or a working Critical alert email');
  return false;
}

export async function main(args = process.argv.slice(2)) {
  const option = (key) => args[args.indexOf(key) + 1];
  const settingsPath = args.includes('--settings') ? option('--settings') : undefined;
  const configPath = args.includes('--mcp-config') ? option('--mcp-config') : undefined;
  const file = args.includes('--state') ? option('--state') : statePath;
  const ledger = args.includes('--ledger') ? option('--ledger') : ledgerPath;
  const trigger = args.includes('--trigger') ? option('--trigger') : undefined;
  const runId = args.includes('--run-id') ? option('--run-id') : undefined;
  const now = args.includes('--now') ? new Date(option('--now')) : new Date();
  const taskFile = args.includes('--tasks') ? option('--tasks') : null;
  if (Number.isNaN(now.valueOf())) throw new Error('--now must be an ISO timestamp');
  mkdirSync(path.dirname(file), { recursive: true });
  mkdirSync(path.dirname(ledger), { recursive: true });
  const lock = `${file}.lock`;
  let handle;
  try { handle = openSync(lock, 'wx'); } catch (e) { throw new Error(`capabilities lock unavailable: ${e.message}`); }
  try {
    const prior = readState(file);
    const run = recordRunStart(ledger, { now, trigger, runId });
    const runGap = gapForAlert(run, prior.runGap);
    const stateScript = firstExisting(path.join(here, 'oa-state.ps1'));
    if (!stateScript) throw new Error('oa-state.ps1 not found');
    const command = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', stateScript, 'critical-tools'];
    if (settingsPath) command.push('-UserSettings', settingsPath);
    if (configPath) command.push('-McpConfig', configPath);
    const policy = JSON.parse(execFileSync(shell, command, { encoding: 'utf8', timeout: 20000 }));
    if (configPath) process.env.MCP_PROBE_CONFIG = configPath;
    const settings = settingsFrom(policy.settingsPath);
    const tasks = taskFile ? JSON.parse(readFileSync(taskFile, 'utf8')) : [];
    const down = [];
    const output = await evaluate({
      names: policy.tools, settings, previous: prior, tasks, now,
      probe: async (name) => {
        try { await probeTool(name, settings); } catch (e) { down.push(name); throw e; }
      },
      notify: (text) => sendAlert(text, settings, down),
    });
    if (runGap) {
      if (await sendAlert(runGap.headline, settings, down)) {
        runGap.alertedAt = now.toISOString();
      }
      output.status = 'degraded';
      output.headline = [runGap.headline, output.headline].filter(Boolean).join('\n');
      output.wrapUp = [runGap.headline, output.wrapUp].filter(Boolean).join('\n');
    }
    output.run = run;
    output.runGap = runGap ?? prior.runGap ?? null;
    store(file, output);
    console.log(JSON.stringify(output));
    process.exitCode = output.status === 'degraded' ? 2 : 0;
  } finally {
    closeSync(handle);
    unlinkSync(lock);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`critical tools: ${e.message}`); process.exitCode = 1; });
}
