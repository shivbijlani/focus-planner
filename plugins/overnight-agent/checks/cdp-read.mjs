// cdp-read.mjs — read a page via RAW CDP, bypassing Playwright's initializeServer.
//
// WHY: the Playwright MCP attaches by enumerating every page in the profile, so ONE
// wedged tab times out the whole slot (30 s) and the slot looks dead even though
// check-browser-slots reports it healthy. Raw CDP talks to a single target, so a
// wedged sibling tab is irrelevant.
//
// Usage: node cdp-read.mjs <port> <url> [waitMs]
// Prints the rendered innerText of the new tab, then closes it.
const [, , port = '9228', url = 'about:blank', waitMs = '9000'] = process.argv;

const http = async (path, method = 'GET') => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return t; }
};

// Create a brand-new target. A fresh tab is never wedged (frozen lifecycle only
// affects occluded, already-open tabs).
const created = await http(`/json/new?${encodeURIComponent(url)}`, 'PUT');
const targetId = created.id;
const wsUrl = created.webSocketDebuggerUrl;
if (!wsUrl) { console.error('no ws url; got:', JSON.stringify(created).slice(0, 300)); process.exit(1); }

const ws = new WebSocket(wsUrl);
let msgId = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++msgId;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`${method} timed out`)); } }, 25000);
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

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await new Promise((r) => setTimeout(r, Number(waitMs)));

  const out = await send('Runtime.evaluate', {
    expression: `(() => {
      const t = document.body ? document.body.innerText : '';
      return JSON.stringify({ url: location.href, title: document.title, len: t.length, text: t.slice(0, 12000) });
    })()`,
    returnByValue: true,
    awaitPromise: false,
  });
  const payload = JSON.parse(out.result.value);
  console.log('URL   :', payload.url);
  console.log('TITLE :', payload.title);
  console.log('LEN   :', payload.len);
  console.log('----- TEXT -----');
  console.log(payload.text);
} finally {
  ws.close();
  await http(`/json/close/${targetId}`);   // leave Shiv's tabs untouched
}
