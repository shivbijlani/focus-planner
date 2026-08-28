// yt-probe.mjs — inspect a YouTube watch page's caption tracks + transcript-panel tab structure.
// Usage: node yt-probe.mjs <port> <videoId>
const [, , port = '9228', videoId] = process.argv;
if (!videoId) { console.error('usage: node yt-probe.mjs <port> <videoId>'); process.exit(1); }
const url = `https://www.youtube.com/watch?v=${videoId}`;

const http = async (p, m = 'GET') => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: m });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return t; }
};

const created = await http(`/json/new?${encodeURIComponent(url)}`, 'PUT');
const targetId = created.id;
const ws = new WebSocket(created.webSocketDebuggerUrl);
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = async (expression) => {
  const out = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (out.exceptionDetails) throw new Error(JSON.stringify(out.exceptionDetails).slice(0, 400));
  return out.result.value;
};
const trustedClick = async (x, y) => {
  const base = { x, y, button: 'left', clickCount: 1, buttons: 1 };
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base, buttons: 0 });
  await sleep(60);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await sleep(60);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
};

const out = {};
try {
  await send('Page.enable');
  await send('Runtime.enable');
  await sleep(14000);

  out.captions = await evaluate(`(() => {
    const pr = window.ytInitialPlayerResponse || {};
    const c = pr.captions && pr.captions.playerCaptionsTracklistRenderer;
    const vd = pr.videoDetails || {};
    return {
      hasVideoDetails: !!vd.title,
      title: vd.title || null,
      trackCount: c && c.captionTracks ? c.captionTracks.length : 0,
      tracks: c && c.captionTracks ? c.captionTracks.map(t => ({ lang: t.languageCode, kind: t.kind || null, name: t.name && t.name.simpleText })) : [],
      translationLanguages: c && c.translationLanguages ? c.translationLanguages.length : 0,
      playabilityStatus: pr.playabilityStatus && pr.playabilityStatus.status
    };
  })()`);

  // Expand description, find + trusted-click "Show transcript".
  await evaluate(`(() => { const e = document.querySelector('#description-inline-expander #expand, tp-yt-paper-button#expand'); if (e) e.click(); return !!e; })()`);
  await sleep(2500);
  const box = await evaluate(`(() => {
    const acc = [];
    const walk = (root, d) => {
      if (!root || d > 12) return;
      try { root.querySelectorAll('button, tp-yt-paper-button, yt-button-shape').forEach((e) => acc.push(e)); } catch {}
      try { root.querySelectorAll('*').forEach((e) => { if (e.shadowRoot) walk(e.shadowRoot, d + 1); }); } catch {}
    };
    walk(document, 0);
    const lab = (b) => ((b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')).trim();
    const btn = acc.find((b) => /show transcript/i.test(lab(b)));
    if (!btn) return null;
    btn.scrollIntoView({ block: 'center' });
    const r = btn.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), label: lab(btn) };
  })()`);
  out.showTranscriptButton = box;
  if (box) { await sleep(600); await trustedClick(box.x, box.y); await sleep(4500); }

  // Describe every engagement panel + any tab-like chips inside them.
  out.panels = await evaluate(`(() => {
    const ps = [...document.querySelectorAll('ytd-engagement-panel-section-list-renderer')];
    return ps.map(p => ({
      targetId: p.getAttribute('target-id'),
      visibility: p.getAttribute('visibility'),
      textHead: (p.innerText || '').trim().slice(0, 200)
    }));
  })()`);

  out.tabs = await evaluate(`(() => {
    const res = [];
    const cands = [...document.querySelectorAll('tp-yt-paper-tab, yt-chip-cloud-chip-renderer, [role="tab"], .yt-tab-shape, tp-yt-paper-button')];
    cands.forEach(e => {
      const t = (e.innerText || '').replace(/\\s+/g,' ').trim();
      if (!t || t.length > 40) return;
      const r = e.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;
      res.push({ tag: e.tagName.toLowerCase(), text: t, selected: e.getAttribute('aria-selected') || e.getAttribute('selected'),
                 x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) });
    });
    return res.slice(0, 40);
  })()`);
} catch (e) {
  out.error = String(e.message || e);
} finally {
  ws.close();
  await http(`/json/close/${targetId}`);
}
console.log(JSON.stringify(out, null, 2).slice(0, 6000));
await new Promise((r) => setTimeout(r, 250));
