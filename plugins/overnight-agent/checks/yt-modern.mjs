// yt-modern.mjs — recover a transcript when YouTube serves the COMBINED panel variant.
//
// Two variants exist. On some videos "Show transcript" expands PAmodern_transcript_view, which
// carries the rows. On others it expands engagement-panel-searchable-transcript — a combined
// "In this video / Chapters / Transcript" panel whose Transcript tab renders NO rows — while
// PAmodern_transcript_view stays HIDDEN. This forces the row-bearing panel visible.
//
// Usage: node yt-modern.mjs <port> <videoId> [outFile]
const [, , port = '9228', videoId, outFile] = process.argv;
const url = `https://www.youtube.com/watch?v=${videoId}`;
const http = async (p, m = 'GET') => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: m });
  const t = await r.text(); try { return JSON.parse(t); } catch { return t; }
};
const created = await http(`/json/new?${encodeURIComponent(url)}`, 'PUT');
const targetId = created.id;
const ws = new WebSocket(created.webSocketDebuggerUrl);
let msgId = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++msgId; pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`${method} timed out`)); } }, 30000);
});
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
});
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ev = async (x) => {
  const o = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (o.exceptionDetails) throw new Error(JSON.stringify(o.exceptionDetails).slice(0, 400));
  return o.result.value;
};
const click = async (x, y) => {
  const b = { x, y, button: 'left', clickCount: 1, buttons: 1 };
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...b, buttons: 0 }); await sleep(70);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...b }); await sleep(70);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...b });
};
const wheel = (x, y, dy) => send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy, button: 'none', buttons: 0 });

const out = { videoId, step: 'start' };
try {
  await send('Page.enable'); await send('Runtime.enable');
  await sleep(14000);
  out.captions = await ev(`(() => { const pr = window.ytInitialPlayerResponse||{}; const c = pr.captions&&pr.captions.playerCaptionsTracklistRenderer; const vd = pr.videoDetails||{};
    return { signedInOk: !!vd.title, trackCount: (c&&c.captionTracks)?c.captionTracks.length:0 }; })()`);

  // Normal path first: expand description, trusted-click "Show transcript".
  await ev(`(() => { const e = document.querySelector('#description-inline-expander #expand, tp-yt-paper-button#expand'); if (e) e.click(); return !!e; })()`);
  await sleep(2500);
  const box = await ev(`(() => {
    const acc = []; const walk = (r, d) => { if (!r || d > 12) return;
      try { r.querySelectorAll('button, tp-yt-paper-button, yt-button-shape').forEach(e => acc.push(e)); } catch {}
      try { r.querySelectorAll('*').forEach(e => { if (e.shadowRoot) walk(e.shadowRoot, d+1); }); } catch {} };
    walk(document, 0);
    const lab = b => ((b.getAttribute('aria-label')||'') + ' ' + (b.textContent||'')).trim();
    const b = acc.find(x => /show transcript/i.test(lab(x))); if (!b) return null;
    b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }; })()`);
  if (box) { await sleep(600); await click(box.x, box.y); await sleep(5000); }

  // If the combined panel opened empty, force the row-bearing modern panel visible.
  out.forced = await ev(`(() => {
    const all = [...document.querySelectorAll('ytd-engagement-panel-section-list-renderer')];
    const modern = all.find(p => (p.getAttribute('target-id')||'') === 'PAmodern_transcript_view');
    const combo  = all.find(p => (p.getAttribute('target-id')||'') === 'engagement-panel-searchable-transcript'
                                 && !/HIDDEN/.test(p.getAttribute('visibility')||''));
    if (!modern) return { ok: false, why: 'no PAmodern_transcript_view in DOM' };
    const comboEmpty = !combo || (combo.innerText||'').trim().split('\\n').filter(Boolean).length <= 4;
    if (!comboEmpty) return { ok: false, why: 'combined panel already has rows' };
    if (combo) combo.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN');
    modern.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED');
    modern.removeAttribute('hidden');
    modern.style.display = '';
    return { ok: true, why: 'forced modern panel expanded' };
  })()`);

  const dump = async () => ev(`(() => {
    const p = [...document.querySelectorAll('ytd-engagement-panel-section-list-renderer')]
      .find(q => (q.getAttribute('target-id')||'') === 'PAmodern_transcript_view');
    if (!p) return null; const r = p.getBoundingClientRect();
    return { text: (p.innerText||'').trim(), x: Math.round(r.x + r.width/2) || 1100, y: Math.round(r.y + r.height/2) || 500 };
  })()`);
  let snap = await dump();
  const seen = new Set();
  const harvest = t => t && t.split('\n').map(s => s.trim()).filter(Boolean).forEach(s => seen.add(s));
  for (let i = 0; i < 12 && seen.size < 8; i++) { await sleep(1500); snap = await dump(); harvest(snap && snap.text); }
  if (snap) for (let i = 0; i < 80; i++) { await wheel(snap.x, snap.y, 800); await sleep(280); snap = await dump(); harvest(snap && snap.text); }

  // Parse "M:SS" / "N seconds" / text rows out of the panel innerText.
  const raw = [...seen];
  const lines = [];
  const all = (snap && snap.text ? snap.text : raw.join('\n')).split('\n').map(s => s.trim());
  for (let i = 0; i < all.length; i++) {
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(all[i])) {
      const ts = all[i]; let j = i + 1;
      if (j < all.length && /^\d+ (second|minute|hour)s?/.test(all[j])) j++;
      const body = [];
      while (j < all.length && !/^\d{1,2}:\d{2}(:\d{2})?$/.test(all[j])) { if (all[j]) body.push(all[j]); j++; }
      if (body.length) lines.push(`[${ts}] ${body.join(' ')}`);
      i = j - 1;
    }
  }
  out.uniqueRawLines = seen.size;
  out.lineCount = lines.length;
  out.transcript = lines.join('\n');
  out.step = 'ok';
} catch (e) { out.step = 'error'; out.error = String(e.message || e); }
finally { ws.close(); await http(`/json/close/${targetId}`); }

if (outFile) { const { writeFileSync } = await import('node:fs'); writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf8'); }
console.log(`step=${out.step} forced=${out.forced && out.forced.why} lines=${out.lineCount || 0} rawLines=${out.uniqueRawLines || 0}`);
if (out.transcript) console.log('--- first 400 ---\n' + out.transcript.slice(0, 400));
await new Promise(r => setTimeout(r, 250));
