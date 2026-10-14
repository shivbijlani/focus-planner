// doc.mjs -- Cmd-Doc (durable task -> catch-up-doc binding).
import fs from 'node:fs';
import { joinPath } from '../core/context.mjs';
import { testPath } from '../core/fsx.mjs';
import { asArray, get, has, psEq, psStr, psTruthy, setMember } from '../core/net.mjs';
import { addDocMetaStamp, getDocMetaFromJournal, getDocState, newDocObject, readObservedComments, testObservationReadable } from '../collect/doc.mjs';
import { nowIso, readState, writeState } from '../collect/state.mjs';

function psPipelineArrayValue(arr) {
  const a = asArray(arr);
  if (a.length === 0) return null;
  if (a.length === 1) return a[0];
  return a;
}


function uniquePsStrings(values) {
  const out = [];
  for (const v of values) {
    if (!out.some((x) => psEq(x, v))) out.push(v);
  }
  return out;
}

export function cmdDoc(ctx) {
  if (!ctx.p.Id) throw new Error('doc requires -Id');
  const journalPath = joinPath(ctx.p.JournalDir, `task-${ctx.p.Id}.md`);
  if (!testPath(journalPath)) throw new Error(`no journal at ${journalPath}`);
  let st = readState(ctx, ctx.p.Id);
  if (!st) st = { id: ctx.p.Id, status: 'unknown', version: 0, plan_id: '', processed_file_hash: '', has_agent_block: false, seeded: false, updated: null };
  const resolved = getDocState(st, journalPath);
  let doc = resolved.doc;

  if (ctx.p.Unbind) {
    setMember(st, 'doc', null);
    st.updated = nowIso();
    writeState(ctx, st);
    ctx.emitJson({ id: ctx.p.Id, bound: false, unbound: true }, { depth: 5 });
    return;
  }

  if (ctx.p.DocId) {
    if (doc && psStr(get(doc, 'doc_id')) && psStr(get(doc, 'doc_id')) !== ctx.p.DocId && !ctx.p.Force) {
      throw new Error(`doc_bind_conflict: task ${ctx.p.Id} is already bound to doc ${psStr(get(doc, 'doc_id'))} (source: ${resolved.source}); refusing to rebind to ${ctx.p.DocId}. A doc id that 404s is an error to report, not a cue to create a second doc. Use -Force only if the first doc is genuinely gone.`);
    }
    if (!doc || psStr(get(doc, 'doc_id')) !== ctx.p.DocId) {
      doc = newDocObject(ctx.p.DocId, ctx.p.DocUrl, nowIso(), [], [], '');
    } else if (ctx.p.DocUrl) {
      doc = newDocObject(get(doc, 'doc_id'), ctx.p.DocUrl, psStr(get(doc, 'bound_at')), asArray(get(doc, 'seen_ids')), asArray(get(doc, 'pending_ids')), psStr(get(doc, 'observed_at')));
    }
    addDocMetaStamp(journalPath, get(doc, 'doc_id'), psStr(get(doc, 'doc_url')));
  }

  let observationUnreadable = false;
  if (ctx.p.Observe) {
    if (!doc) throw new Error(`task ${ctx.p.Id} has no bound doc; bind one with -DocId first`);
    if (!testPath(ctx.p.Observe)) throw new Error(`no such observation file: ${ctx.p.Observe}`);
    const obsText = fs.readFileSync(ctx.p.Observe, 'utf8').replace(/^\uFEFF/, '');
    if (!testObservationReadable(obsText)) {
      observationUnreadable = true;
    } else {
      const obs = readObservedComments(ctx.p.Observe);
      const seen = asArray(get(doc, 'seen_ids'));
      const newly = [];
      for (const c of obs) if (!seen.some((x) => psEq(x, get(c, 'id')))) newly.push(get(c, 'id'));
      doc = newDocObject(get(doc, 'doc_id'), psStr(get(doc, 'doc_url')), psStr(get(doc, 'bound_at')), seen, newly, nowIso());
    }
  }

  if (ctx.p.Ack) {
    if (!doc) throw new Error(`task ${ctx.p.Id} has no bound doc; nothing to acknowledge`);
    const seen = uniquePsStrings([...asArray(get(doc, 'seen_ids')), ...asArray(get(doc, 'pending_ids'))]);
    doc = newDocObject(get(doc, 'doc_id'), psStr(get(doc, 'doc_url')), psStr(get(doc, 'bound_at')), seen, [], psStr(get(doc, 'observed_at')));
  }

  if (doc && (ctx.p.DocId || ctx.p.Observe || ctx.p.Ack || resolved.healed)) {
    setMember(st, 'doc', doc);
    st.updated = nowIso();
    writeState(ctx, st);
  }

  const journalStamp = getDocMetaFromJournal(journalPath);
  const stampId = journalStamp ? psStr(get(journalStamp, 'doc_id')) : '';
  const stamped = !!(stampId && doc && psStr(get(doc, 'doc_id')) && stampId === psStr(get(doc, 'doc_id')));
  ctx.emitJson({
    id: ctx.p.Id,
    bound: !!(doc && psStr(get(doc, 'doc_id'))),
    doc_id: doc ? psStr(get(doc, 'doc_id')) : null,
    doc_url: doc && psStr(get(doc, 'doc_url')) ? psStr(get(doc, 'doc_url')) : null,
    source: resolved.source,
    healed: !!resolved.healed,
    journal_stamped: stamped,
    journal_stamp_mismatch_id: stampId && !stamped ? stampId : null,
    new_comments: observationUnreadable ? null : doc ? asArray(get(doc, 'pending_ids')).length : 0,
    new_comment_ids: observationUnreadable ? null : doc ? psPipelineArrayValue(get(doc, 'pending_ids')) : null,
    observation: observationUnreadable ? 'unreadable' : ctx.p.Observe ? 'read' : null,
    seen_comments: doc ? asArray(get(doc, 'seen_ids')).length : 0,
    observed_at: doc && psStr(get(doc, 'observed_at')) ? psStr(get(doc, 'observed_at')) : null,
  }, { depth: 5 });
}

