// yt-captions.mjs — fetch a YouTube caption track DIRECTLY from the signed-in page context.
//
// WHY: the transcript PANEL lazy-loads and can render empty even with a trusted gesture.
// But ytInitialPlayerResponse exposes captionTracks[].baseUrl, and fetching that URL from
// inside the watch page (so it carries the page's cookies + origin) returns the timedtext
// XML/JSON directly. This is faster and far more reliable than scraping the panel.
//
// Usage: node yt-captions.mjs <port> <videoId> [outFile]
const [, , port = '9228', videoId, outFile] = process.argv;
if (!videoId) { console.error('usage: node yt-captions.mjs <port> <videoId> [outFile]'); process.exit(1); }
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
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`${method} timed out`)); } }, 45000);
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
  if (out.exceptionDetails) throw new Error(JSON.stringify(out.exceptionDetails).slice(0, 500));
  return out.result.value;
};

const result = { step: 'start', videoId };
try {
  await send('Page.enable');
  await send('Runtime.enable');
  await sleep(14000);

  result.meta = await evaluate(`(() => {
    const pr = window.ytInitialPlayerResponse || {};
    const vd = pr.videoDetails || {};
    const mf = (pr.microformat && pr.microformat.playerMicroformatRenderer) || {};
    return { title: vd.title, channel: vd.author, lengthSeconds: vd.lengthSeconds,
             viewCount: vd.viewCount, publishDate: mf.publishDate || mf.uploadDate || null };
  })()`);

  // Try each caption track, and each of several format params, from INSIDE the page.
  const fetched = await evaluate(`(async () => {
    const pr = window.ytInitialPlayerResponse || {};
    const c = pr.captions && pr.captions.playerCaptionsTracklistRenderer;
    const tracks = (c && c.captionTracks) || [];
    if (!tracks.length) return { ok: false, reason: 'no-caption-tracks' };
    const attempts = [];
    for (const t of tracks) {
      for (const fmt of ['json3', 'srv3', '']) {
        const u = t.baseUrl + (fmt ? '&fmt=' + fmt : '');
        try {
          const r = await fetch(u, { credentials: 'include' });
          const body = await r.text();
          attempts.push({ lang: t.languageCode, kind: t.kind || null, fmt: fmt || 'default',
                          status: r.status, len: body.length,
                          body: body.length ? body.slice(0, 400000) : '' });
          if (r.ok && body.length > 50) return { ok: true, lang: t.languageCode, kind: t.kind || null, fmt: fmt || 'default', body, attempts: attempts.map(({body, ...a}) => a) };
        } catch (e) {
          attempts.push({ lang: t.languageCode, fmt: fmt || 'default', error: String(e).slice(0, 200) });
        }
      }
    }
    return { ok: false, reason: 'all-attempts-empty', attempts: attempts.map(({body, ...a}) => a) };
  })()`);

  result.attempts = fetched.attempts;
  if (!fetched.ok) { result.step = 'no-captions'; result.reason = fetched.reason; }
  else {
    result.step = 'ok';
    result.lang = fetched.lang; result.kind = fetched.kind; result.fmt = fetched.fmt;
    const body = fetched.body;
    const lines = [];
    const fmtTs = (s) => {
      const t = Math.max(0, Math.floor(s));
      const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
      return (h ? String(h) + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(sec).padStart(2, '0');
    };
    const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                           .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d));
    if (body.trim().startsWith('{')) {
      const j = JSON.parse(body);
      for (const ev of (j.events || [])) {
        if (!ev.segs) continue;
        const text = ev.segs.map((s) => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
        if (text) lines.push(`[${fmtTs((ev.tStartMs || 0) / 1000)}] ${text}`);
      }
    } else {
      const isTtml = body.includes('<p ');
      const re = /<(?:text|p)[^>]*?(?:start|begin|t)="([\d.:]+)"[^>]*>([\s\S]*?)<\/(?:text|p)>/g;
      let m;
      while ((m = re.exec(body))) {
        const raw = m[1];
        const start = raw.includes(':')
          ? raw.split(':').reduce((a, v) => a * 60 + parseFloat(v), 0)
          : (isTtml ? parseFloat(raw) / 1000 : parseFloat(raw));
        const text = decode(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
        if (text) lines.push(`[${fmtTs(start)}] ${text}`);
      }
    }
    result.lineCount = lines.length;
    result.transcript = lines.join('\n');
  }
} catch (e) {
  result.step = 'error';
  result.error = String(e.message || e);
} finally {
  ws.close();
  await http(`/json/close/${targetId}`);
}

if (outFile) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8');
  console.log(`step=${result.step} lines=${result.lineCount || 0} lang=${result.lang || '-'} fmt=${result.fmt || '-'} -> ${outFile}`);
} else {
  console.log(JSON.stringify(result, null, 2).slice(0, 5000));
}
await new Promise((r) => setTimeout(r, 250));
