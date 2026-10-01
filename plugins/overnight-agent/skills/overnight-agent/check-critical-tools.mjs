#!/usr/bin/env node
// PHASE 0: real reads, persistent outage transitions, and a single alert per transition/day.
//
// GH #768: this used to cold-start a fresh copy of each MCP server (mcp-probe.mjs) to test it.
// At a coordinator's start the PC is at its busiest -- the host is starting the coordinator's
// OWN copies of the same servers, plus the WebView and task sessions -- so a cold start took
// 56-90+s on a 4-core box. That measures machine load, not tool health, and escalating two slow
// cold-starts to `down` only moved the false alarm one run later.
//
// The coordinator already has live, connected tools for the critical servers (it calls them
// anyway for the inbox check and doc comments), so it makes the two real calls itself --
// `email_test_account` for the Agent email account, `list_tasks` (max 1) for the Google account
// (Tasks) setting -- and records the outcome with `--record name=ok` or
// `--record name=down:<error>`. This is the ONE path: there is no subprocess probe left to fall
// back to, and therefore no timeout/slow class. A tool the caller did not record for is treated
// as absent from the session, which is also `down`.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSettingRow } from '../../checks/settings-value.mjs';
import { acquireFileLock, releaseFileLock, withFileLock } from './file-lock.mjs';
import { gapForAlert, recordRunStart } from './run-ledger.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const plugin = path.resolve(here, '..', '..');
const firstExisting = (...paths) => paths.find((p) => {
  try { readFileSync(p); return true; } catch { return false; }
});
// Alert delivery (Telegram/email) is the one remaining subprocess call: a standalone script has
// no live MCP connection to reuse, unlike the health probe above which the coordinator now does
// itself. See `sendAlert` below.
const prober = firstExisting(path.join(here, 'mcp-probe.mjs'), path.join(plugin, 'checks', 'mcp-probe.mjs'));
// Sandbox mode (tests/e2e/run-sandbox.ps1): inert unless the variables are set. OVERNIGHT_AGENT_HOME
// replaces %LOCALAPPDATA%\overnight-agent; OA_SANDBOX_ROOT makes a path outside it a hard error
// and refuses every outgoing alert, because a sandbox run must never send anything.
const oaHome = process.env.OVERNIGHT_AGENT_HOME ||
  path.join(process.env.LOCALAPPDATA || tmpdir(), 'overnight-agent');
export function assertSandboxPath(target, what) {
  const rootEnv = process.env.OA_SANDBOX_ROOT;
  if (!rootEnv || !target) return;
  const root = path.resolve(rootEnv).replace(/[\\/]+$/, '');
  const full = path.resolve(target).replace(/[\\/]+$/, '');
  const fold = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  if (fold(full) !== fold(root) && !fold(full).startsWith(fold(root + path.sep))) {
    throw new Error(`oa_sandbox_violation: ${what} '${full}' is outside OA_SANDBOX_ROOT '${root}'`);
  }
}
const statePath = process.env.OA_CAPABILITIES_PATH ?? path.join(oaHome, 'capabilities.json');
const ledgerPath = process.env.OA_RUN_LEDGER_PATH ?? path.join(oaHome, 'run-ledger.jsonl');
const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';

function call(server, action, ...args) {
  if (!prober) throw new Error('mcp-probe.mjs not found');
  let raw;
  try {
    raw = execFileSync(process.execPath, [prober, server, action, ...args], {
      encoding: 'utf8', timeout: 95000, maxBuffer: 1024 * 1024, windowsHide: true,
    });
  } catch (e) {
    throw new Error(String(e.stderr ?? '').trim() || e.message);
  }
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

// Parses one `--record` argument: `name=ok` for a successful call, or `name=down:<error>` for a
// call the caller already made and failed (an MCP error) or a tool absent from the session (the
// caller reports its own host startup error). There is no third status: with no subprocess there
// is nothing left to time out.
export function parseRecord(value) {
  const eq = value.indexOf('=');
  if (eq < 1) throw new Error(`--record must be 'name=ok' or 'name=down:<error>', got '${value}'`);
  const name = value.slice(0, eq).trim();
  const rest = value.slice(eq + 1);
  if (rest === 'ok') return [name, { status: 'ok' }];
  const colon = rest.indexOf(':');
  const status = colon < 0 ? rest : rest.slice(0, colon);
  if (status !== 'down') throw new Error(`--record: unknown status '${status}' for '${name}'; use ok or down`);
  const error = (colon < 0 ? '' : rest.slice(colon + 1)).trim();
  if (!error) throw new Error(`--record: 'down' requires an error, e.g. --record ${name}=down:timed out`);
  return [name, { status: 'down', error }];
}

function headline(name, error, since) {
  return `⛔ CRITICAL TOOL DOWN: ${name}. ${error}. Since ${since}.`;
}

// Mutcheck (GH #768): a recorded `ok` stays `ok`, a recorded `down` (an MCP error the caller
// already hit) is `down`, and a tool absent from `results` (missing from the session entirely)
// is also `down`. There is no third, slow/unknown state: with no subprocess there is nothing to
// time out, so a down tool is declared -- and alerted on -- immediately, not on a second run.
export async function evaluate({ names, previous = {}, now = new Date(), results = {},
  notify = async () => false, tasks = [] }) {
  const outages = { ...previous.outages };
  const toolResults = {};
  const headlines = [];
  const day = now.toISOString().slice(0, 10);
  for (const name of names) {
    const recorded = results[name];
    const ok = recorded?.status === 'ok';
    const before = outages[name];
    if (!ok) {
      const error = recorded?.status === 'down' && recorded.error ? recorded.error : 'absent from session';
      const entry = before?.status === 'down' ? before : {
        firstSeenAt: now.toISOString(), lastAlertDate: null, status: 'down',
      };
      entry.error = error;
      outages[name] = entry;
      toolResults[name] = { status: 'down', error, firstSeenAt: entry.firstSeenAt };
      const text = headline(name, error, entry.firstSeenAt);
      headlines.push(text);
      if (entry.lastAlertDate !== day) {
        const kind = entry.lastAlertDate ? 'reminder' : 'outage';
        const unavailable = [...Object.entries(toolResults)
          .filter(([, value]) => value.status !== 'ok').map(([tool]) => tool), name];
        if (await notify(text, kind, name, [...new Set(unavailable)])) {
          entry.lastAlertDate = day;
        }
      }
    } else {
      toolResults[name] = { status: 'ok', checkedAt: now.toISOString() };
      if (before) {
        const text = `✅ CRITICAL TOOL RECOVERED: ${name}. Outage since ${before.firstSeenAt}.`;
        const unavailable = Object.entries(toolResults)
          .filter(([, value]) => value.status !== 'ok').map(([tool]) => tool);
        if (await notify(text, 'recovered', name, unavailable)) delete outages[name];
        else outages[name] = { ...before, status: 'recovered' };
      }
    }
  }
  const down = Object.entries(toolResults).filter(([, value]) => value.status === 'down').map(([name]) => name);
  const skipped = tasks.filter((task) => task.requires?.some((name) => down.includes(name)))
    .map((task) => ({ id: task.id, reason: `blocked: ${task.requires.find((name) => down.includes(name))} down` }));
  const wrapUp = headlines.join('\n');
  return {
    schema: 'oa-capabilities/1', checkedAt: now.toISOString(),
    status: down.length ? 'degraded' : 'completed',
    headline: headlines[0] ?? '', wrapUp, tools: toolResults, outages, skipped,
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

async function sendAlert(text, settings, unavailable) {
  if (process.env.OA_SANDBOX_ROOT) {
    console.error(`Critical alert suppressed (sandbox): ${text}`);
    return false;
  }
  // An alert is acknowledged only after a successful send, never after an attempted call.
  const dm = readSettingRow(settings, 'Critical alert Telegram DM');
  if (dm && !unavailable.includes('telegram')) {
    try {
      payload(call('telegram', 'call', 'message', JSON.stringify({
        action: 'send', chat_id: dm, text,
      })));
      return true;
    } catch (e) { console.error(`Telegram alert failed: ${e.message}`); }
  }
  const address = readSettingRow(settings, 'Critical alert email') ||
    readSettingRow(settings, 'Agent email account');
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) && !unavailable.includes('email')) {
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
  const stateDir = args.includes('--state-dir') ? option('--state-dir') : undefined;
  const file = args.includes('--state') ? option('--state') : statePath;
  const ledger = args.includes('--ledger') ? option('--ledger') : ledgerPath;
  const trigger = args.includes('--trigger') ? option('--trigger') : undefined;
  // GH #772: this is the ONE explicit flag that turns a run of this script into a coordinator
  // run. Omit it -- as any manual or diagnostic invocation does -- and the script is read-only:
  // it still evaluates tool health and updates capabilities.json, but never appends to the run
  // ledger, so a manual check can never fake a coordinator run into it.
  const runId = args.includes('--run') ? option('--run') : undefined;
  const now = args.includes('--now') ? new Date(option('--now')) : new Date();
  const taskFile = args.includes('--tasks') ? option('--tasks') : null;
  // One path in: the caller (the coordinator, which already made the real calls with its own
  // connected tools) reports each outcome as its own `--record name=ok` or
  // `--record name=down:<error>`. Repeatable; a critical tool the caller omits is absent from
  // the session and is treated as down.
  const records = args.flatMap((arg, i) => (arg === '--record' ? [args[i + 1]] : []));
  if (Number.isNaN(now.valueOf())) throw new Error('--now must be an ISO timestamp');
  if (args.includes('--run') && !runId) throw new Error('--run requires a runId');
  for (const [what, target] of [['capabilities', file], ['ledger', ledger], ['--settings', settingsPath],
    ['--mcp-config', configPath], ['--state-dir', stateDir], ['--tasks', taskFile]]) {
    assertSandboxPath(target, what);
  }
  mkdirSync(path.dirname(file), { recursive: true });
  mkdirSync(path.dirname(ledger), { recursive: true });
  // GH #778: capabilities.json has its OWN short lock, taken independently of `oa-state.ps1`'s
  // state lock, and the caller WAITS for it rather than being told to retry. It used to fail on
  // the first collision (`openSync(lock, 'wx')` with no retry), which turned two coordinator
  // steps landing in the same second into a hand-retried failure.
  const held = acquireFileLock(file);
  try {
    const prior = readState(file);
    // GH #772: no `--run` means no ledger line, full stop -- read the tool health below, but
    // never write a coordinator run that did not happen. gapForAlert on an empty entry falls
    // through to its own "surface any still-unalerted prior gap" branch, so a manual run can
    // still report a gap the last real coordinator run detected, without minting a new one.
    const run = runId ? withFileLock(ledger, () => recordRunStart(ledger, { now, trigger, runId })) : null;
    const runGap = gapForAlert(run ?? {}, prior.runGap);
    const stateScript = firstExisting(path.join(here, 'oa-state.ps1'));
    if (!stateScript) throw new Error('oa-state.ps1 not found');
    const command = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', stateScript, 'critical-tools'];
    if (settingsPath) command.push('-UserSettings', settingsPath);
    if (configPath) command.push('-McpConfig', configPath);
    if (stateDir) command.push('-StateDir', stateDir);
    const policy = JSON.parse(execFileSync(shell, command, { encoding: 'utf8', timeout: 60000 }));
    if (configPath) process.env.MCP_PROBE_CONFIG = configPath;
    const settings = settingsFrom(policy.settingsPath);
    const results = Object.fromEntries(records.map(parseRecord));
    const tasks = taskFile ? JSON.parse(readFileSync(taskFile, 'utf8')) : [];
    const output = await evaluate({
      names: policy.tools, previous: prior, tasks, now, results,
      notify: (text, _kind, _name, unavailable = []) => sendAlert(text, settings, unavailable),
    });
    if (runGap) {
      const unavailable = Object.entries(output.tools)
        .filter(([, result]) => result.status !== 'ok').map(([name]) => name);
      if (await sendAlert(runGap.headline, settings, unavailable)) {
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
    releaseFileLock(held);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`critical tools: ${e.message}`); process.exitCode = 1; });
}
