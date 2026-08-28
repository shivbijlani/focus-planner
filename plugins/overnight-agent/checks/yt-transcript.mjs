// yt-transcript.mjs — grab a YouTube transcript via RAW CDP using TRUSTED input events.
//
// WHY: YouTube's transcript panel lazy-loads its rows only in response to a real user
// gesture. A synthetic element.click() from Runtime.evaluate flips no rows in — the panel
// stays ENGAGEMENT_PANEL_VISIBILITY_HIDDEN with just its "Transcript" header. Dispatching
// Input.dispatchMouseEvent produces a trusted event, which does work.
//
// Usage: node yt-transcript.mjs <port> <videoId> [outFile]
const [, , port = '9228', videoId, outFile] = process.argv;
if (!videoId) { console.error('usage: node yt-transcript.mjs <port> <videoId> [outFile]'); process.exit(1); }
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

// Click at viewport coords with a TRUSTED event.
const trustedClick = async (x, y) => {
  const base = { x, y, button: 'left', clickCount: 1, buttons: 1 };
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base, buttons: 0 });
  await sleep(60);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await sleep(60);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
};

// Scroll the transcript panel with a TRUSTED wheel event so virtualised rows render.
const wheel = async (x, y, dy) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy, button: 'none', buttons: 0 });
};

let result = { step: 'start' };
try {
  await send('Page.enable');
  await send('Runtime.enable');
  await sleep(15000);

  const meta = await evaluate(`(() => {
    const pr = window.ytInitialPlayerResponse || {};
    const vd = pr.videoDetails || {};
    const mf = (pr.microformat && pr.microformat.playerMicroformatRenderer) || {};
    return { title: vd.title, channel: vd.author, lengthSeconds: vd.lengthSeconds,
             viewCount: vd.viewCount, publishDate: mf.publishDate || mf.uploadDate || null,
             description: (vd.shortDescription || '') };
  })()`);
  result.meta = meta;

  // DIAGNOSIS FIRST. A bare lines=0 is ambiguous three ways and that ambiguity is what
  // produced a wrong "this video has no captions" note in a task journal:
  //   signed-out slot      -> empty videoDetails + 0 tracks (the bot-check wall)
  //   genuinely captionless-> real videoDetails + 0 tracks
  //   declared-but-withheld-> real videoDetails + >0 tracks, yet timedtext 200s with an
  //                           EMPTY body and the panel renders no rows.
  // Only the middle case means "nothing to get"; the last means "Whisper is the only path".
  result.captions = await evaluate(`(() => {
    const pr = window.ytInitialPlayerResponse || {};
    const c = pr.captions && pr.captions.playerCaptionsTracklistRenderer;
    const vd = pr.videoDetails || {};
    return {
      signedInOk: !!vd.title,
      playabilityStatus: pr.playabilityStatus && pr.playabilityStatus.status,
      trackCount: (c && c.captionTracks) ? c.captionTracks.length : 0,
      tracks: (c && c.captionTracks) ? c.captionTracks.map(t => ({ lang: t.languageCode, kind: t.kind || null })) : []
    };
  })()`);
  if (!result.captions.signedInOk) {
    result.diagnosis = 'SIGNED-OUT SLOT (empty videoDetails) - this is NOT evidence about captions; use a signed-in slot.';
  } else if (result.captions.trackCount === 0) {
    result.diagnosis = 'NO CAPTION TRACK declared for this video.';
  } else {
    result.diagnosis = `${result.captions.trackCount} caption track(s) DECLARED - if lines=0 below, the text is withheld, not absent (audio->Whisper is the only path).`;
  }

  // Expand the description so the "Show transcript" button exists, then locate its box.
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
  if (!box) { result.step = 'no-button'; throw new Error('no Show transcript button'); }
  result.button = box;

  await sleep(600);
  await trustedClick(box.x, box.y);
  await sleep(4000);

  // Force virtualised rows to render by wheeling inside the panel, collecting as we go.
  const collect = async () => evaluate(`(() => {
    const p = [...document.querySelectorAll('ytd-engagement-panel-section-list-renderer')]
      .find((q) => /transcript/i.test(q.getAttribute('target-id') || '') && !/HIDDEN/.test(q.getAttribute('visibility') || ''));
    if (!p) return null;
    const r = p.getBoundingClientRect();
    const segs = [...p.querySelectorAll('ytd-transcript-segment-renderer, [class*="segment"]')];
    const lines = segs.map((s) => (s.innerText || '').replace(/\\s+/g, ' ').trim()).filter(Boolean);
    return { box: { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) },
             text: (p.innerText || '').trim(), lines };
  })()`);

  let snap = await collect();
  if (!snap) { result.step = 'panel-not-visible'; throw new Error('panel did not open'); }

  const seen = new Set();
  const push = (arr) => arr.forEach((l) => seen.add(l));
  push(snap.lines);
  let stagnant = 0;
  for (let i = 0; i < 120 && stagnant < 6; i++) {
    await wheel(snap.box.x, snap.box.y, 900);
    await sleep(260);
    const before = seen.size;
    snap = await collect();
    if (!snap) break;
    push(snap.lines);
    stagnant = seen.size === before ? stagnant + 1 : 0;
  }

  result.step = 'ok';
  result.panelText = snap ? snap.text : '';

  // The modern panel's rows are: "M:SS" / "N seconds" / text. Element selectors miss the
  // new row names, so parse the panel's innerText instead - it always carries every row.
  const parsed = [];
  const raw = (result.panelText || '').split('\n').map((s) => s.trim());
  for (let i = 0; i < raw.length; i++) {
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(raw[i])) {
      const ts = raw[i];
      let j = i + 1;
      if (j < raw.length && /^\d+ (second|minute|hour)s?(,| |$)/.test(raw[j])) j++;
      const body = [];
      while (j < raw.length && !/^\d{1,2}:\d{2}(:\d{2})?$/.test(raw[j])) { if (raw[j]) body.push(raw[j]); j++; }
      if (body.length) parsed.push(`[${ts}] ${body.join(' ')}`);
      i = j - 1;
    }
  }
  result.lineCount = parsed.length || seen.size;
  result.transcript = parsed.length ? parsed.join('\n') : [...seen].join('\n');
} catch (e) {
  result.error = String(e.message || e);
} finally {
  ws.close();
  await http(`/json/close/${targetId}`);
}

if (outFile) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8');
  console.log(`step=${result.step} lines=${result.lineCount || 0} -> ${outFile}`);
  if (result.diagnosis) console.log(`captions: ${result.diagnosis}`);
} else {
  console.log(JSON.stringify(result, null, 2).slice(0, 4000));
}
await new Promise((r) => setTimeout(r, 250));
