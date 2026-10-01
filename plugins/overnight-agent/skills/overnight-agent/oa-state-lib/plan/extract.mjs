// extract.mjs -- Cmd-Extract and the bounded journal read (#291). Read-only by construction.
import fs from 'node:fs';
import path from 'node:path';
import {
  getAgentEndIndex, getAuthorSegments, getFenceMaskedText, getNewestAgentTurn,
  testAskTextIsBlocking, testAskTextIsOpen, HumanAuthor, ProvenanceRe,
  ManagedHeadingRe, LegacyStateRe, NeedsFromYouRe, YourCallRe,
} from '../collect/journal.mjs';
import { joinPath, splitParent } from '../core/context.mjs';
import { fileNameWithoutExtension, readJournalText, testPath } from '../core/fsx.mjs';
import { netTrim, netTrimEnd, psIsMatch, psReplace, psSplit, rx, rxMatches } from '../core/net.mjs';
import { getBoardLinkFacts as getBoardLinkFactsFromBoard } from '../collect/board.mjs';

export function getUtf8ByteCount(s) {
  if (s === null || s === undefined || s === '') return 0;
  return Buffer.byteLength(String(s), 'utf8');
}

export function getUtf8Prefix(s, maxBytes) {
  const text = String(s ?? '');
  if (maxBytes <= 0 || text.length === 0) return '';
  if (getUtf8ByteCount(text) <= maxBytes) return text;
  let lo = 0; let hi = text.length; let guard = 0;
  while (lo < hi) {
    if (++guard > 64) break;
    let mid = Math.ceil((lo + hi) / 2.0);
    if (mid <= lo) mid = lo + 1;
    if (mid > hi) mid = hi;
    if (getUtf8ByteCount(text.substring(0, mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  let cut = Math.min(lo, text.length);
  if (cut > 0 && cut < text.length) {
    const ch = text.charCodeAt(cut - 1);
    if (ch >= 0xd800 && ch <= 0xdbff) cut--;
  }
  const nl = text.lastIndexOf('\n', Math.max(0, cut - 1));
  if (nl > 0) cut = nl + 1;
  return text.substring(0, cut);
}

export function getUtf8Suffix(s, maxBytes) {
  const text = String(s ?? '');
  if (maxBytes <= 0 || text.length === 0) return '';
  if (getUtf8ByteCount(text) <= maxBytes) return text;
  let lo = 0; let hi = text.length; let guard = 0;
  while (lo < hi) {
    if (++guard > 64) break;
    let mid = Math.floor((lo + hi) / 2.0);
    if (mid >= hi) mid = hi - 1;
    if (mid < lo) mid = lo;
    if (getUtf8ByteCount(text.substring(mid)) <= maxBytes) hi = mid;
    else lo = mid + 1;
  }
  let cut = Math.min(lo, text.length);
  if (cut < text.length && cut > 0) {
    const ch = text.charCodeAt(cut);
    if (ch >= 0xdc00 && ch <= 0xdfff) cut++;
  }
  const nl = text.indexOf('\n', Math.min(cut, Math.max(0, text.length - 1)));
  if (nl >= 0 && nl < text.length - 1) cut = nl + 1;
  return text.substring(Math.min(cut, text.length));
}

export function getBoundedSlice(text, maxBytes) {
  const s = String(text ?? '');
  const full = getUtf8ByteCount(s);
  if (maxBytes <= 0) return { Head: '', Tail: '', FullBytes: full, ElidedBytes: full, Truncated: full > 0 };
  if (full <= maxBytes) return { Head: s, Tail: '', FullBytes: full, ElidedBytes: 0, Truncated: false };
  const headBudget = Math.trunc(Math.floor(maxBytes * 0.6));
  const head = getUtf8Prefix(s, headBudget);
  const rest = s.substring(head.length);
  const tail = getUtf8Suffix(rest, maxBytes - getUtf8ByteCount(head));
  const elided = full - getUtf8ByteCount(head) - getUtf8ByteCount(tail);
  return { Head: head, Tail: tail, FullBytes: full, ElidedBytes: Math.max(0, elided), Truncated: true };
}

export function getJournalHeadIndex(content) {
  const s = String(content ?? '');
  if (s.length === 0) return 0;
  const scan = getFenceMaskedText(s);
  const idxs = [];
  const heading = rx(scan, '(?m)' + ManagedHeadingRe);
  if (heading) idxs.push(heading.index);
  for (const p of rxMatches(scan, ProvenanceRe)) {
    if (netTrim(p[1]) !== HumanAuthor) { idxs.push(p.index); break; }
  }
  const legacy = rx(scan, LegacyStateRe);
  if (legacy) idxs.push(legacy.index);
  const sentinel = scan.indexOf('OVERNIGHT-AGENT do not edit');
  if (sentinel >= 0) {
    const ls = scan.lastIndexOf('\n', Math.max(0, sentinel - 1));
    idxs.push(ls >= 0 ? ls + 1 : 0);
  }
  if (idxs.length === 0) return s.length;
  return Math.max(0, Math.min(...idxs));
}

export function getJournalUserMessages(content) {
  const s = String(content ?? '');
  if (s.length === 0) return [];
  const out = [];
  const segments = getAuthorSegments(s);
  for (const seg of (Array.isArray(segments) ? segments : [segments])) {
    if (seg.Author === HumanAuthor && netTrim(seg.Text).length > 0) out.push(seg.Text);
  }
  if (out.length > 1) out.reverse();
  return out;
}

export function getBoundedList(items, maxBytes) {
  const kept = [];
  let used = 0; let dropped = 0; let elided = 0;
  for (const it of Array.isArray(items) ? items : [items]) {
    const s = String(it ?? '');
    const b = getUtf8ByteCount(s);
    if (used + b <= maxBytes) { kept.push(s); used += b; continue; }
    const room = maxBytes - used;
    if (room > 256) {
      const p = getUtf8Prefix(s, room);
      if (p.length > 0) {
        kept.push(p);
        used += getUtf8ByteCount(p);
        elided += b - getUtf8ByteCount(p);
        continue;
      }
    }
    dropped++;
    elided += b;
  }
  return { Kept: kept, Dropped: dropped, ElidedBytes: elided, UsedBytes: used };
}

export function getJournalOpenAsks(agentLeft) {
  const turn = getNewestAgentTurn(agentLeft);
  const asks = [];
  if (!turn) return asks;
  for (const m of rxMatches(turn, YourCallRe)) {
    asks.push({ kind: 'Your call', text: netTrim(m[1]), blocking: true });
  }
  for (const m of rxMatches(turn, NeedsFromYouRe)) {
    const v = netTrim(m[1]);
    if (testAskTextIsOpen(v)) asks.push({ kind: 'Needs from you', text: v, blocking: testAskTextIsBlocking(v) });
  }
  return asks;
}

export function getJournalPointers(content, p) {
  const s = String(content ?? '');
  let status = null;
  for (const m of rxMatches(s, '(?im)^[ \\t]*\\*\\*[ \\t]*Status[ \\t]*:?[ \\t]*\\*\\*[ \\t]*:?(.*)$')) status = netTrim(m[1]);
  const linked = [];
  for (const m of rxMatches(s, '(?im)^[ \\t]*\\*\\*[ \\t]*Linked[ \\t]*:?[ \\t]*\\*\\*[ \\t]*:?(.*)$')) {
    for (const n of rxMatches(m[1], '#(\\d+)')) if (!linked.includes(n[1])) linked.push(n[1]);
  }
  const deliverables = [];
  const id = psReplace(fileNameWithoutExtension(p), '^task-', '');
  const dir = splitParent(p);
  if (dir && testPath(dir)) {
    const prefix = `task-${id}-`.toLowerCase();
    let files = [];
    try {
      files = fs.readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.toLowerCase().startsWith(prefix) && d.name.toLowerCase().endsWith('.md'))
        .map((d) => d.name)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'accent' }));
    } catch { files = []; }
    for (const name of files) {
      try { deliverables.push({ name, kb: Math.round((fs.statSync(joinPath(dir, name)).size / 1024) * 10) / 10 }); } catch {}
    }
  }
  return { Status: status, Linked: linked, Deliverables: deliverables };
}

export function getBoardRowId(line) {
  const s = String(line ?? '');
  if (!psIsMatch(s, '^\\s*\\|')) return null;
  const first = psSplit(netTrim(s).replace(/^\|+|\|+$/g, ''), '\\|')[0];
  const m = rx(netTrim(first ?? ''), '^(\\d+)');
  return m ? m[1] : null;
}

export function getBoardRowLinkedIds(line, linkedIndex = -1) {
  const clean = rxMatches(String(line ?? ''), '<!--.*?-->', { s: true }).reduce((acc, m) => acc.replace(m[0], ''), String(line ?? ''));
  const cells = psSplit(netTrim(clean).replace(/^\|+|\|+$/g, ''), '\\|').map((x) => netTrim(x));
  let last = cells.length - 1;
  while (last >= 0 && netTrim(cells[last]).length === 0) last--;
  if (last < 5) return [];
  const idx = linkedIndex >= 5 && linkedIndex <= last ? linkedIndex : last;
  const cell = cells[idx];
  if (psIsMatch(cell, '^\\d{4}-\\d{2}-\\d{2}')) return [];
  const ids = [];
  for (const m of rxMatches(cell, '(?<!\\d)\\d{1,6}(?!\\d)')) if (!ids.includes(m[0])) ids.push(m[0]);
  return ids;
}

export function getBoardMap(ctx) {
  const map = new Map();
  if (!testPath(ctx.p.PlannerBoard)) return map;
  const lines = psSplit(readJournalText(ctx.p.PlannerBoard), '\\r?\\n');
  let section = 'other';
  let pos = 0;
  let linkedIdx = -1;
  for (const line of lines) {
    if (psIsMatch(line, '^##\\s*Today\\b')) { section = 'today'; linkedIdx = -1; continue; }
    if (psIsMatch(line, '^##\\s*Deferred\\b')) { section = 'deferred'; linkedIdx = -1; continue; }
    if (psIsMatch(line, '^##\\s')) { section = 'other'; linkedIdx = -1; continue; }
    if (psIsMatch(line, '^\\s*\\|') && psIsMatch(line, '\\bLinked\\s*ID\\b')) {
      const hdr = psSplit(netTrim(line).replace(/^\|+|\|+$/g, ''), '\\|').map((x) => netTrim(x));
      for (let i = 0; i < hdr.length; i++) if (psIsMatch(hdr[i], '^Linked\\s*ID$')) { linkedIdx = i; break; }
    }
    const id = getBoardRowId(line);
    if (!id) continue;
    const cells = psSplit(netTrim(line).replace(/^\|+|\|+$/g, ''), '\\|').map((x) => netTrim(x));
    const wp = cells.length >= 4 && psIsMatch(cells[3], '^(P[0-9])$') ? rx(cells[3], '^(P[0-9])$')[1] : null;
    pos++;
    map.set(id, { section, urgency: cells.length >= 2 ? cells[1] : '', work_priority: wp, board_pos: pos, linked: getBoardRowLinkedIds(line, linkedIdx) });
  }
  return map;
}

export function getBoardLinkFacts(ctx, id) {
  const facts = { Read: false, RowFound: false, Ids: [], Note: '', Path: `${ctx.p.PlannerBoard}` };
  if (netTrim(`${ctx.p.PlannerBoard ?? ''}`).length === 0) { facts.Note = 'no planner board path configured'; return facts; }
  if (!testPath(ctx.p.PlannerBoard)) { facts.Note = `no board file at ${ctx.p.PlannerBoard}`; return facts; }
  let map;
  try { map = getBoardMap(ctx); } catch (e) { facts.Note = `board unreadable: ${e.message}`; return facts; }
  facts.Read = true;
  const row = map.get(`${id}`);
  if (!row) { facts.Note = `no board row for task ${id}`; return facts; }
  facts.RowFound = true;
  facts.Ids = [...(row.linked ?? [])];
  return facts;
}

export function getLinkedFacts(ctx, id, journalIds) {
  const board = getBoardLinkFactsFromBoard(ctx, id);
  let merged = [];
  for (const n of board.Ids ?? []) if (n && !merged.includes(n)) merged.push(n);
  for (const n of journalIds ?? []) if (n && !merged.includes(n)) merged.push(n);
  merged = merged.filter((x) => x !== `${id}`);
  return {
    Ids: merged,
    Board: [...(board.Ids ?? [])],
    Journal: [...(journalIds ?? [])],
    BoardRead: !!board.Read,
    BoardRow: !!board.RowFound,
    BoardNote: `${board.Note ?? ''}`,
    BoardPath: `${board.Path ?? ''}`,
  };
}

export function formatLinkedPointer(facts) {
  const journalNote = (facts.Journal ?? []).length ? `journal: #${facts.Journal.join(', #')}` : 'journal: no **Linked:** line';
  if ((facts.Ids ?? []).length) {
    const boardNote = (facts.Board ?? []).length ? `board: #${facts.Board.join(', #')}`
      : !facts.BoardRead ? `board: NOT READ (${facts.BoardNote})`
        : !facts.BoardRow ? `board: ${facts.BoardNote}` : 'board: no Linked ID';
    return `- linked: #${facts.Ids.join(', #')}  (${boardNote}; ${journalNote})`;
  }
  if (!facts.BoardRead) {
    return `- linked: (board not read -- ${facts.BoardNote}; ${journalNote}). NOT a finding of 'no parent': re-run with -PlannerBoard pointing at planner.md before concluding this task has no upstream.`;
  }
  const boardNote = !facts.BoardRow ? facts.BoardNote
    : (facts.Board ?? []).length ? `board row read, Linked ID #${facts.Board.join(', #')} is this task itself`
      : 'board row read, no Linked ID';
  return `- linked: (none -- ${boardNote}; ${journalNote})`;
}

const kb = (b) => Math.round((b / 1024) * 10) / 10;

export function cmdExtract(ctx) {
  const { Id } = ctx.p;
  if (!Id) throw new Error('extract requires -Id');
  const p = joinPath(ctx.p.JournalDir, `task-${Id}.md`);
  if (!testPath(p)) throw new Error(`extract: no journal at ${p}`);
  const content = readJournalText(p);
  const sourceBytes = getUtf8ByteCount(content);

  let agentEnd = getAgentEndIndex(content);
  const hasAgentBlock = agentEnd >= 0;
  if (agentEnd < 0) agentEnd = 0;
  const agentLeft = content.substring(0, Math.min(agentEnd, content.length));
  const trailing = agentEnd < content.length ? content.substring(agentEnd) : '';

  const headEnd = Math.min(getJournalHeadIndex(content), content.length);
  const head = content.substring(0, headEnd);
  const turn = getNewestAgentTurn(agentLeft);
  const ceiling = Math.max(4, ctx.p.BudgetKB) * 1024;
  const slices = {
    head: getBoundedSlice(head, Math.trunc(ceiling * 0.22)),
    turn: getBoundedSlice(turn, Math.trunc(ceiling * 0.33)),
    trailing: getBoundedSlice(trailing, Math.trunc(ceiling * 0.15)),
  };
  const userMsgs = getJournalUserMessages(content);
  const userList = getBoundedList(userMsgs, Math.trunc(ceiling * 0.30));
  const asks = getJournalOpenAsks(agentLeft);
  const ptr = getJournalPointers(content, p);
  const links = getLinkedFacts(ctx, Id, [...ptr.Linked]);

  let emitted = 0;
  for (const s of Object.values(slices)) emitted += getUtf8ByteCount(s.Head) + getUtf8ByteCount(s.Tail);
  emitted += userList.UsedBytes;
  const elided = sourceBytes - emitted;

  if (ctx.p.Verify) {
    const problems = [];
    for (const [key, slice] of Object.entries(slices)) {
      for (const frag of [slice.Head, slice.Tail]) {
        if (!frag) continue;
        if (content.indexOf(frag) < 0) problems.push(`region '${key}' emitted ${getUtf8ByteCount(frag)} bytes that are NOT a verbatim substring of the source`);
      }
    }
    if (emitted > ceiling) problems.push(`emitted ${emitted} bytes against a declared ceiling of ${ceiling}`);
    for (const frag of userList.Kept) {
      if (content.indexOf(frag) < 0) problems.push(`a user message fragment of ${getUtf8ByteCount(frag)} bytes is NOT a verbatim substring of the source`);
    }
    for (const a of asks) {
      if (a.text && content.indexOf(a.text) < 0) problems.push(`ask text '${a.text}' is not a verbatim substring of the source`);
    }
    const ok = problems.length === 0;
    ctx.emitJson({ verify: ok ? 'pass' : 'fail', id: Id, path: p, source_bytes: sourceBytes, emitted_bytes: emitted, ceiling_bytes: ceiling, verbatim: ok, problems }, { depth: 4 });
    if (!ok) ctx.exitCode = 1;
    return;
  }

  if (ctx.p.Json) {
    ctx.emitJson({
      id: Id,
      path: p,
      source_bytes: sourceBytes,
      emitted_bytes: emitted,
      elided_bytes: Math.max(0, elided),
      ceiling_bytes: ceiling,
      has_agent_block: hasAgentBlock,
      status: ptr.Status,
      linked: [...links.Ids],
      linked_board: [...links.Board],
      linked_journal: [...links.Journal],
      board_read: !!links.BoardRead,
      board_row_found: !!links.BoardRow,
      board_path: links.BoardPath,
      board_note: links.BoardNote,
      deliverables: [...ptr.Deliverables],
      open_asks: asks,
      user_messages: { newest_first: [...userList.Kept], shown: userList.Kept.length, total: userMsgs.length, dropped: userList.Dropped, elided_bytes: userList.ElidedBytes },
      head: { text: slices.head.Head + slices.head.Tail, truncated: slices.head.Truncated, elided_bytes: slices.head.ElidedBytes },
      latest_turn: { text: slices.turn.Head + slices.turn.Tail, truncated: slices.turn.Truncated, elided_bytes: slices.turn.ElidedBytes },
      trailing_user: { text: slices.trailing.Head + slices.trailing.Tail, truncated: slices.trailing.Truncated, elided_bytes: slices.trailing.ElidedBytes },
    }, { depth: 6 });
    return;
  }

  const nl = '\r\n';
  let out = '';
  const w = (line) => { out += `${line}${nl}`; };
  w(`# task-${Id} -- BOUNDED EXTRACT (read-only)`);
  w('');
  w(`source: ${p}`);
  w(`source ${kb(sourceBytes)} KB / emitted ${kb(emitted)} KB (ceiling ${kb(ceiling)} KB, ~${Math.round((emitted / 4 / 1000) * 10) / 10}K tokens)`);
  w('');
  w(`This is a BOUNDED extract, not the whole journal. Every line below is VERBATIM from the source; nothing is summarised. ${elided > 0 ? `${kb(elided)} KB was NOT shown -- open the file directly if you need it.` : 'Nothing was elided: this is the complete journal.'}`);
  const section = (title, slice, note) => {
    w('');
    w(`## ${title}`);
    if (note) w(`_${note}_`);
    const body = netTrim(slice.Head + slice.Tail);
    if (body.length === 0) { w('(empty)'); return; }
    w('');
    if (slice.Truncated) {
      w(netTrimEnd(slice.Head));
      w('');
      w(`> [... ${kb(slice.ElidedBytes)} KB elided from the middle of this section ...]`);
      w('');
      w(netTrimEnd(slice.Tail));
    } else {
      w(body);
    }
  };
  section('HEAD -- the user\'s framing', slices.head, 'Everything above the first machine turn: decisions, constraints, links.');
  w('');
  w('## OPEN ASKS (newest agent turn)');
  if (asks.length === 0) { w(''); w('(none)'); } else {
    w('');
    for (const a of asks) w(`- **${a.kind}:** ${a.text}${a.blocking ? '  `[blocking]`' : '  `[offer]`'}`);
  }
  w('');
  w('## USER MESSAGES (newest first)');
  w('_Attributed to the human. Later messages supersede earlier ones, so read top-down._');
  w('');
  if (userList.Kept.length === 0) w(userMsgs.length ? '(none fit in the budget)' : '(none positively attributed -- see HEAD and TRAILING)');
  else {
    let n = 0;
    for (const m of userList.Kept) {
      n++;
      w(`### message ${n} of ${userMsgs.length} (newest first)`);
      w('');
      w(netTrim(m));
      w('');
    }
    if (userList.Dropped > 0 || userList.ElidedBytes > 0) w(`> [... ${userList.Dropped} older user message(s) not shown, ${kb(userList.ElidedBytes)} KB ...]`);
  }
  section('LATEST AGENT TURN', slices.turn, 'The newest turn only. Earlier turns are deliberately not read.');
  section('TRAILING USER PROSE', slices.trailing, 'Below the turn-end stamp: the unanswered reply, if any.');
  w('');
  w('## POINTERS');
  w('');
  w(`- status: ${ptr.Status ? ptr.Status : '(none stated)'}`);
  w(formatLinkedPointer(links));
  if (ptr.Deliverables.length) {
    w('- deliverables next to this journal (not read here):');
    for (const d of ptr.Deliverables) w(`    - ${d.name} (${d.kb} KB)`);
  } else {
    w('- deliverables next to this journal: (none)');
  }
  w(`- not shown: ${kb(elided)} KB of ${kb(sourceBytes)} KB`);
  ctx.out(out);
}
