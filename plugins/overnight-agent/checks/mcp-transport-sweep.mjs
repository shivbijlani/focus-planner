#!/usr/bin/env node
/**
 * mcp-transport-sweep.mjs -- every configured MCP server declares a transport the harness
 * actually loads (GH #570).
 *
 * THE DEFECT THIS EXISTS FOR
 *
 * `google-workspace` is the channel Shiv's catch-up-doc comments arrive on. It was configured,
 * enabled, healthy, and callable -- `mcp-probe.mjs google-workspace list` returned 36 tools in
 * 7 seconds -- and it was in NO agent session's toolset for weeks. Three of his comments sat
 * unread while every probe reported the capability AVAILABLE.
 *
 * The cause was one word:
 *
 *     "google-workspace": { "type": "local",  ... }   <- never loaded
 *     "email":            { "type": "stdio",  ... }   <- loaded
 *
 * `local` is not a transport the harness recognises. It is not rejected either: the server is
 * skipped, and a skipped server is byte-identical to a server nobody configured. #570 was filed
 * against this exact config and quotes that line verbatim -- then concludes "config is healthy
 * and enabled", because nothing on the machine disagreed. A wrong value that produces silence
 * survives being looked straight at.
 *
 * WHY A SWEEP AND NOT A UNIT TEST
 *
 * The subject is a file on Shiv's machine, not in the repo. A test can only assert against a
 * fixture; the fixture is not what breaks. This runs where the config lives and reports the
 * real one -- the same reason `check-agent-inbox.ps1` is a sweep.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not prove a server loads. A recognised transport can still fail on a bad command, a
 * missing binary or an expired credential -- `mcp-probe.mjs` is the instrument for that, and it
 * is why the two are complementary rather than redundant. This closes exactly one hole: a
 * server excluded before any of that is attempted, for a reason no output mentions.
 *
 * The recognised set is deliberately a literal, not a regex or a heuristic. It is the same
 * discipline as `mutcheck-phase07-ownership`: a matcher that tries to be clever about what
 * "looks like" a transport would re-admit the class of bug it exists to catch.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Transports the harness loads. Sourced from the servers observed live in a session toolset:
 * stdio (email, telegram, edge-cdp-*) and http (canva). `sse` is the documented remote form and
 * is accepted rather than flagged, because flagging a working server trains the reader to
 * ignore the output -- the failure mode of every guard that cries wolf.
 */
export const RECOGNISED = ['stdio', 'http', 'sse'];

export function defaultConfigPath() {
  return process.env.OA_MCP_CONFIG
    || path.join(os.homedir(), '.copilot', 'mcp-config.json');
}

/**
 * Pure core: config object in, findings out. Kept separate from IO so the mutation check can
 * drive it without writing files.
 */
export function evaluate(cfg) {
  const servers = (cfg && (cfg.mcpServers || cfg.servers)) || {};
  const disabled = new Set(
    (cfg && (cfg.disabledMcpServers || cfg.disabledServers)) || []
  );

  const findings = [];
  const ok = [];

  for (const name of Object.keys(servers)) {
    if (disabled.has(name)) continue;

    const type = servers[name] && servers[name].type;

    if (type === undefined || type === null || type === '') {
      // An absent type is not the #570 bug -- harnesses commonly default it to stdio -- but it
      // is the same ambiguity, so it is reported at a lower key rather than passed silently.
      findings.push({ server: name, type: null, kind: 'missing' });
      continue;
    }

    if (!RECOGNISED.includes(type)) {
      findings.push({ server: name, type, kind: 'unrecognised' });
      continue;
    }

    ok.push({ server: name, type });
  }

  return { ok, findings, recognised: RECOGNISED };
}

function main() {
  const p = defaultConfigPath();

  if (!fs.existsSync(p)) {
    // No config is not a failure: this sweep runs on machines that may not have one. Saying so
    // is the point -- an absent subject must never read as a clean pass.
    console.log(`[mcp-transport] no MCP config at ${p} -- nothing to check`);
    process.exit(0);
  }

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`[mcp-transport] FAIL: ${p} is not valid JSON -- ${e.message}`);
    console.error('  Every server in it is unloadable, including the doc-comment channel.');
    process.exit(1);
  }

  const { ok, findings } = evaluate(cfg);

  for (const s of ok) console.log(`  ok    ${s.server} (${s.type})`);

  if (findings.length === 0) {
    console.log(`[mcp-transport] ${ok.length} server(s), all declaring a loadable transport.`);
    process.exit(0);
  }

  console.error('');
  for (const f of findings) {
    if (f.kind === 'missing') {
      console.error(`  WARN  ${f.server} declares no transport type`);
    } else {
      console.error(`  FAIL  ${f.server} declares type "${f.type}"`);
    }
  }

  console.error('');
  console.error(`[mcp-transport] recognised transports: ${RECOGNISED.join(', ')}`);
  console.error('  A server with an unrecognised transport is SKIPPED, not rejected. It will');
  console.error('  probe healthy and appear in no session toolset -- which is how #570 kept');
  console.error('  three of Shiv\'s doc comments unread while every check reported AVAILABLE.');
  console.error(`  Config: ${p}`);

  const hard = findings.filter((f) => f.kind === 'unrecognised').length;
  process.exit(hard > 0 ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`
  || import.meta.url.endsWith(path.basename(process.argv[1] || ''))) {
  main();
}
