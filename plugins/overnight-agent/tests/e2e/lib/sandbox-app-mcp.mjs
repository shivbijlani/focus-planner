#!/usr/bin/env node
// sandbox-app-mcp.mjs -- a stand-in for the Copilot app's session tools, for tests/e2e only.
//
// A headless `copilot -p` run has no app host, so the native tools the coordinator dispatches
// with (create_session, send_session_message, get_sessions_status, ...) do not exist there.
// This stdio MCP server provides the same tool names so PHASE 1 can run end to end, and it
// RECORDS every call to <SANDBOX_APP_DIR>/dispatch-log.jsonl -- which is what the harness
// asserts on. It never talks to the real app.
//
// SANDBOX_APP_MODE:
//   record  (default) sessions are bookkeeping only; a send is recorded and reported delivered,
//           and the session reads as idle immediately afterwards. No task work happens.
//   execute a send also starts a headless child `copilot -p <brief>` in the session's own
//           sandbox folder, with this process's (sandboxed) environment. The child reads as busy
//           until it exits. Children are tracked in sessions.json so the harness can stop them.
//
// Protocol: MCP over stdio, newline-delimited JSON-RPC 2.0. No dependencies.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const dir = process.env.SANDBOX_APP_DIR;
if (!dir) { console.error('SANDBOX_APP_DIR is required'); process.exit(2); }
mkdirSync(dir, { recursive: true });
const mode = process.env.SANDBOX_APP_MODE || 'record';
const projectId = process.env.SANDBOX_APP_PROJECT_ID;
const taskChats = process.env.SANDBOX_APP_TASK_CHATS;
const logFile = path.join(dir, 'dispatch-log.jsonl');
const sessionsFile = path.join(dir, 'sessions.json');
const maxChildren = Number(process.env.SANDBOX_APP_MAX_CHILDREN || 4);

function loadSessions() {
  try { return JSON.parse(readFileSync(sessionsFile, 'utf8')); } catch { return []; }
}
function saveSessions(list) { writeFileSync(sessionsFile, `${JSON.stringify(list, null, 2)}\n`); }
function record(tool, args, result, error) {
  appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), tool, args, result, error })}\n`);
}
function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function activity(s) {
  return { status: s.pid && alive(s.pid) ? 'busy' : 'idle' };
}
function view(s) {
  return {
    id: s.id, project_session_id: s.id, name: s.name, project_id: s.project_id, path: s.path,
    workspace_type: 'folder', created_at: s.created_at, activity: activity(s),
  };
}

function startChild(s, message) {
  const children = path.join(dir, 'children');
  mkdirSync(children, { recursive: true });
  const running = loadSessions().filter((x) => x.pid && alive(x.pid)).length;
  if (running >= maxChildren) throw new Error(`sandbox: child limit ${maxChildren} reached`);
  const n = (s.sends || 0) + 1;
  const stem = path.join(children, `${s.id}-${n}`);
  const args = ['-C', s.path, '-p', message, '--session-id', s.id, '--allow-all-tools', '--no-ask-user',
    '--disable-builtin-mcps', '--no-custom-instructions', '--no-auto-update', '--output-format', 'json',
    '--share', `${stem}.md`, '--max-ai-credits', process.env.SANDBOX_APP_CHILD_CREDITS || '200'];
  if (process.env.SANDBOX_APP_PLUGIN_DIR) args.push('--plugin-dir', process.env.SANDBOX_APP_PLUGIN_DIR);
  if (process.env.SANDBOX_APP_MODEL) args.push('--model', process.env.SANDBOX_APP_MODEL);
  for (const d of (process.env.SANDBOX_APP_DENY || '').split('\n').filter(Boolean)) args.push('--deny-tool', d);
  const out = openSync(`${stem}.jsonl`, 'a');
  const err = openSync(`${stem}.err.log`, 'a');
  const child = spawn(process.env.SANDBOX_APP_COPILOT || 'copilot', args, {
    cwd: s.path, env: process.env, stdio: ['ignore', out, err], windowsHide: true, detached: false,
  });
  child.unref();
  return child.pid;
}

const tools = [
  {
    name: 'ping',
    description: 'Zero-argument health check for the sandbox app host. Returns {ok:true}.',
    inputSchema: { type: 'object', properties: {} },
    run: () => ({ ok: true, mode }),
  },
  {
    name: 'list_projects',
    description: 'List configured projects (id, name, path, kind).',
    inputSchema: { type: 'object', properties: {} },
    run: () => [{ id: projectId, name: 'task-chats', kind: 'folder', path: taskChats }],
  },
  {
    name: 'create_session',
    description: 'Create a new session inside a project. Pass project_id explicitly. For a folder project the session works in that folder. Omit kickoff to create it idle.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' }, name: { type: 'string' }, workspace_type: { type: 'string' },
        base_branch: { type: 'string' }, execution_location: { type: 'string' },
        kickoff: { type: 'object', properties: { prompt: { type: 'string' } } },
        detached: { type: 'boolean' }, coordinate_with_creator: { type: 'boolean' }, notify_on_idle: { type: 'string' },
      },
    },
    run: (a) => {
      if (!a.project_id) throw new Error('sandbox: project_id is required (the coordinator has no project of its own)');
      if (a.project_id !== projectId) throw new Error(`sandbox: unknown project ${a.project_id}`);
      const s = { id: randomUUID(), name: a.name || 'task session', project_id: projectId, path: taskChats,
        created_at: new Date().toISOString(), sends: 0 };
      const list = loadSessions(); list.push(s); saveSessions(list);
      if (a.kickoff?.prompt) {
        s.sends = 1; s.kickoff = true;
        if (mode === 'execute') s.pid = startChild(s, a.kickoff.prompt);
        saveSessions(loadSessions().map((x) => (x.id === s.id ? s : x)));
      }
      return view(s);
    },
  },
  {
    name: 'send_session_message',
    description: 'Send a message to another project session; delivered as a user turn in the target session.',
    inputSchema: {
      type: 'object', required: ['session_id', 'message'],
      properties: { session_id: { type: 'string' }, message: { type: 'string' },
        delivery_mode: { type: 'string' }, mode: { type: 'string' } },
    },
    run: (a) => {
      const list = loadSessions();
      const s = list.find((x) => x.id === a.session_id);
      if (!s) throw new Error(`sandbox: session ${a.session_id} not found`);
      if (s.pid && alive(s.pid)) throw new Error(`sandbox: session ${s.id} is busy`);
      if (mode === 'execute') s.pid = startChild(s, a.message);
      s.sends = (s.sends || 0) + 1;
      saveSessions(list);
      return { delivered: true, session_id: s.id, mode };
    },
  },
  {
    name: 'get_sessions_status',
    description: 'Live status snapshot of all sessions: id, name, activity.status (busy|idle).',
    inputSchema: { type: 'object', properties: {} },
    run: () => ({ sessions: loadSessions().map(view) }),
  },
  {
    name: 'get_session',
    description: 'Detailed metadata for one session, including activity.status.',
    inputSchema: { type: 'object', required: ['project_session_id'], properties: { project_session_id: { type: 'string' } } },
    run: (a) => {
      const s = loadSessions().find((x) => x.id === a.project_session_id);
      if (!s) throw new Error(`sandbox: session ${a.project_session_id} not found`);
      return view(s);
    },
  },
  {
    name: 'list_sessions_and_chats',
    description: 'List all sessions with ids, names and paths.',
    inputSchema: { type: 'object', properties: {} },
    run: () => loadSessions().map(view),
  },
];

function reply(id, result) { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`); }
function fail(id, code, message) { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`); }

function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return reply(id, { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} },
      serverInfo: { name: 'sandbox-app', version: '1.0.0' } });
  }
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') {
    return reply(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  }
  if (method === 'tools/call') {
    const tool = tools.find((t) => t.name === params?.name);
    const args = params?.arguments || {};
    if (!tool) return fail(id, -32602, `unknown tool ${params?.name}`);
    try {
      const result = tool.run(args);
      if (tool.name !== 'ping') record(tool.name, args, result, null);
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
    } catch (e) {
      record(tool.name, args, null, e.message);
      return reply(id, { content: [{ type: 'text', text: e.message }], isError: true });
    }
  }
  if (id !== undefined && id !== null) return fail(id, -32601, `method not found: ${method}`);
  return undefined;
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch (e) { console.error(`sandbox-app: ${e.message}`); }
  }
});
if (!existsSync(sessionsFile)) saveSessions([]);
