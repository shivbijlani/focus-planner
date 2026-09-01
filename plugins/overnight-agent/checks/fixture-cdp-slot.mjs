// fixture-cdp-slot.mjs -- a stand-in CDP endpoint for mutcheck-browser-slot-probe.ps1.
//
// Speaks just enough of the DevTools protocol to reproduce the GH #197 split:
// the HTTP surface (served by the browser process) always answers, while the
// WebSocket surface (served by the renderer) either completes work or never
// answers at all. That split IS the bug -- a wedged slot passes every HTTP
// probe -- so the fixture has to be able to lie in exactly that way.
//
// Usage: node fixture-cdp-slot.mjs <port> <healthy|wedged|freshonly>
//
//   healthy    every target answers Runtime.evaluate
//   wedged     existing page targets accept the socket and never reply;
//              a target created via /json/new DOES reply (this is real Chrome
//              behaviour -- a new target is never in the frozen lifecycle
//              state -- and it is what makes a fresh-tab probe useless)
//   freshonly  alias for wedged, named for readability at the call site
import http from 'node:http';
import crypto from 'node:crypto';

const port = Number(process.argv[2] || 0);
const mode = process.argv[3] || 'healthy';
const wedged = mode === 'wedged' || mode === 'freshonly';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const BUILD = '152.0.4191.53';

// Targets that existed before the probe ran. In `wedged` mode these are frozen.
const targets = new Map();
targets.set('PREEXISTING1', { id: 'PREEXISTING1', type: 'page', url: 'https://example.test/a', title: 'a', fresh: false });

const wsUrl = (id) => `ws://127.0.0.1:${port}/devtools/page/${id}`;
const listJson = () => [...targets.values()].map((t) => ({
  id: t.id, type: t.type, url: t.url, title: t.title,
  webSocketDebuggerUrl: wsUrl(t.id),
}));

const server = http.createServer((req, res) => {
  const path = req.url.split('?')[0];
  const send = (obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };
  if (path === '/json/version') {
    return send({ Browser: `Edg/${BUILD}`, 'Protocol-Version': '1.3' });
  }
  if (path === '/json/list' || path === '/json') return send(listJson());
  if (path === '/json/new') {
    // A brand-new target is never frozen -- that is the whole point.
    const id = 'FRESH' + crypto.randomBytes(4).toString('hex').toUpperCase();
    targets.set(id, { id, type: 'page', url: 'about:blank', title: '', fresh: true });
    return send({ id, type: 'page', url: 'about:blank', title: '', webSocketDebuggerUrl: wsUrl(id) });
  }
  if (path.startsWith('/json/close/')) {
    targets.delete(path.split('/').pop());
    return res.end('Target is closing');
  }
  res.writeHead(404); res.end('{}');
});

const frame = (str) => {
  const b = Buffer.from(str, 'utf8');
  let header;
  if (b.length < 126) header = Buffer.from([0x81, b.length]);
  else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(b.length, 2); }
  return Buffer.concat([header, b]);
};

const decode = (buf) => {
  if (buf.length < 2) return null;
  const len = buf[1] & 0x7f;
  let off = 2, plen = len;
  if (len === 126) { plen = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { plen = Number(buf.readBigUInt64BE(2)); off = 10; }
  const masked = (buf[1] & 0x80) !== 0;
  let mask = null;
  if (masked) { mask = buf.slice(off, off + 4); off += 4; }
  const data = buf.slice(off, off + plen);
  if (!masked) return data.toString('utf8');
  const out = Buffer.alloc(plen);
  for (let i = 0; i < plen; i++) out[i] = data[i] ^ mask[i % 4];
  return out.toString('utf8');
};

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  const id = req.url.split('/').pop();
  const t = targets.get(id);
  const frozen = wedged && t && !t.fresh;

  socket.on('error', () => {});
  socket.on('data', (buf) => {
    let msg;
    try { msg = JSON.parse(decode(buf)); } catch { return; }
    if (!msg || !msg.id) return;

    // Fidelity that matters: a frozen renderer is NOT dead. Synchronous JS
    // still evaluates and returns promptly -- it is timers and rAF that stop
    // firing, so only a promise the renderer must resolve goes unanswered.
    // Modelling it as "answers nothing" would let a probe that evaluates
    // `1+1` look like it works, which is the mistake M3 is written to catch.
    const awaitsPromise = msg.method === 'Runtime.evaluate' && msg.params && msg.params.awaitPromise === true;
    if (frozen && awaitsPromise) return;

    if (msg.method === 'Runtime.evaluate') {
      return socket.write(frame(JSON.stringify({
        id: msg.id, result: { result: { type: 'string', value: 'oa-live' } },
      })));
    }
    socket.write(frame(JSON.stringify({ id: msg.id, result: {} })));
  });
});

server.listen(port, '127.0.0.1', () => console.log('listening ' + port + ' ' + mode));
