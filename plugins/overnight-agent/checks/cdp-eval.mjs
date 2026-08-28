// cdp-eval.mjs — run JS in a page via RAW CDP, bypassing Playwright's initializeServer.
//
// WHY: cdp-read.mjs can only read, and the Playwright MCP cannot attach to a slot at all
// when one of its tabs is wedged (it enumerates every page and times out at 30 s). This
// is the same raw-CDP escape hatch, extended to *interact*: it evaluates an arbitrary
// expression and can keep the tab open across calls so a multi-step UI flow (read →
// click → confirm) is possible without Playwright.
//
// Usage:
//   node cdp-eval.mjs <port> --url <url> [--wait ms] --file <js> [--keep]
//   node cdp-eval.mjs <port> --target <targetId> [--wait ms] --file <js> [--keep]
//   node cdp-eval.mjs <port> --close <targetId>
//
// The JS file must contain a single expression (an IIFE is fine). Its value is returned
// by value, so return JSON-serialisable data.
const argv = process.argv.slice(2);
const port = argv[0];
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const has = (n) => argv.includes(`--${n}`);

const http = async (path, method = 'GET') => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return t; }
};

const closeId = flag('close');
if (closeId) { await http(`/json/close/${closeId}`); console.log('closed', closeId); process.exit(0); }

const url = flag('url');
const target = flag('target');
const waitMs = Number(flag('wait', '8000'));
const file = flag('file');
if (!file) { console.error('--file <js> is required'); process.exit(1); }
const { readFileSync } = await import('node:fs');
const expression = readFileSync(file, 'utf8');

let targetId, wsUrl;
if (target) {
  const list = await http('/json/list');
  const t = list.find((x) => x.id === target);
  if (!t) { console.error('no such target', target); process.exit(1); }
  targetId = t.id; wsUrl = t.webSocketDebuggerUrl;
} else {
  // A brand-new target is never wedged (frozen lifecycle only hits occluded open tabs).
  const created = await http(`/json/new?${encodeURIComponent(url || 'about:blank')}`, 'PUT');
  targetId = created.id; wsUrl = created.webSocketDebuggerUrl;
}
if (!wsUrl) { console.error('no ws url'); process.exit(1); }

const ws = new WebSocket(wsUrl);
let msgId = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++msgId;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`${method} timed out`)); } }, 30000);
});
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  }
});
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

let failed = false;
try {
  await send('Page.enable');
  await send('Runtime.enable');
  if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
  const out = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (out.exceptionDetails) {
    failed = true;
    console.error('EXCEPTION:', JSON.stringify(out.exceptionDetails).slice(0, 800));
  } else {
    const v = out.result.value;
    console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  }
} catch (e) {
  failed = true;
  console.error('ERROR:', e.message);
} finally {
  ws.close();
  if (has('keep')) console.log(`\n[target] ${targetId}`);
  else await http(`/json/close/${targetId}`);
}
// Let the WebSocket finish tearing down before exiting. Calling process.exit() while
// the socket is mid-close trips libuv's `!(handle->flags & UV_HANDLE_CLOSING)` assertion
// and returns a garbage exit code, which makes success/failure undetectable by a caller.
process.exitCode = failed ? 1 : 0;
await new Promise((r) => setTimeout(r, 250));
