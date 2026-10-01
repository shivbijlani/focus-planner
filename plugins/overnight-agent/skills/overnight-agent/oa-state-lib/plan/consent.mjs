// consent.mjs -- Cmd-Consent, the fail-closed consent reader (#227/#297/#442).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getFenceMaskedText, getJournalFacts } from '../collect/journal.mjs';
import { getDocMetaFromJournal as getDocMetaFromJournalFromDoc } from '../collect/doc.mjs';
import { readAgentGate, getGateVerdict } from './gate.mjs';
import { joinPath } from '../core/context.mjs';
import { readJournalText, testPath } from '../core/fsx.mjs';
import { fromJson } from '../core/psjson.mjs';
import { rx } from '../core/net.mjs';

export const DocMetaRe = '<!--\\s*doc-meta\\s+docId=(?<id>[A-Za-z0-9_\\-]+)(?:\\s+docUrl=(?<url>\\S+))?\\s*-->';

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(here, '..', '..');

export function getDocMetaFromJournal(p, content = null) {
  let text = content;
  if (text === null || text === undefined || text === '') text = readJournalText(p);
  if (!text) return null;
  const m = rx(getFenceMaskedText(text), DocMetaRe);
  if (!m) return null;
  return { doc_id: m.groups?.id ?? m[1], doc_url: m.groups?.url !== undefined ? m.groups.url : '' };
}

export function getDocCommentConsent(ctx, dumpPath, docId) {
  const candidates = [
    path.join(skillRoot, 'doc-consent.mjs'),
    path.resolve(skillRoot, '..', '..', 'checks', 'doc-consent.mjs'),
  ];
  let script = null;
  for (const c of candidates) {
    const full = path.resolve(c);
    if (testPath(full)) { script = full; break; }
  }
  if (!script) return { consent_ok: false, reason: 'doc-consent-script-missing' };

  const ledgers = [];
  const backfills = [
    path.join(skillRoot, 'doc-comment-ledger-backfill.json'),
    path.resolve(skillRoot, '..', '..', 'checks', 'doc-comment-ledger-backfill.json'),
  ];
  for (const b of backfills) {
    const full = path.resolve(b);
    if (testPath(full)) { ledgers.push(full); break; }
  }
  const live = joinPath(ctx.p.StateDir, 'doc-comment-ledger.json');
  if (testPath(live)) ledgers.push(live);

  try {
    const r = spawnSync(process.execPath, [script, dumpPath, `${docId ?? ''}`, ...ledgers], { encoding: 'utf8', windowsHide: true });
    if (r.error) return { consent_ok: false, reason: 'doc-consent-not-runnable' };
    const text = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    if (!text) return { consent_ok: false, reason: 'doc-consent-no-output' };
    try { return fromJson(text); } catch { return { consent_ok: false, reason: 'doc-consent-unparseable' }; }
  } catch {
    return { consent_ok: false, reason: 'doc-consent-not-runnable' };
  }
}

export function addGateFallthrough(ctx, out, gate) {
  out.action = `${ctx.p.Action}`;
  out.repo = ctx.p.Repo ? `${ctx.p.Repo}` : null;
  out.gate_state = gate ? `${gate.state}` : 'not-consulted';
  out.gate_list = null;
  out.gate_rule = null;
  out.gate_path = gate ? `${gate.path}` : null;
}

export function cmdConsent(ctx) {
  const { Id, Action, Repo, DocComments } = ctx.p;
  if (!Id) throw new Error('consent requires -Id');
  const p = joinPath(ctx.p.JournalDir, `task-${Id}.md`);

  let gate = null;
  let verdict = null;
  if (Action) {
    gate = readAgentGate(ctx.p.GatePath);
    verdict = getGateVerdict(gate, Action, Repo);
    if (verdict.decision !== 'none') {
      let trailingHasUser = false;
      if (testPath(p)) trailingHasUser = !!getJournalFacts(p).HasTrailingUser;
      const humanSpoke = verdict.decision === 'allow' && trailingHasUser;
      ctx.emitJson({
        id: Id,
        consent_ok: verdict.decision === 'allow' && !humanSpoke,
        reason: verdict.decision === 'floor' ? 'gate-floor-blocks' : humanSpoke ? 'gate-allowed-human-spoke' : 'gate-allowed',
        action: `${Action}`,
        repo: Repo ? `${Repo}` : null,
        gate_state: `${gate.state}`,
        gate_list: `${verdict.list}`,
        gate_rule: `${verdict.rule}`,
        gate_path: `${gate.path}`,
        trailing_has_user: trailingHasUser,
        path: p,
      }, { depth: 4 });
      return;
    }
  }

  if (!testPath(p)) {
    const out = { id: Id, consent_ok: false, reason: 'journal-not-found', path: p };
    if (Action) addGateFallthrough(ctx, out, gate);
    ctx.emitJson(out, { depth: 4 });
    return;
  }

  const facts = getJournalFacts(p);
  const c = facts.Consent;
  let docConsent = null;
  if (DocComments && !c.consent_ok) {
    const meta = getDocMetaFromJournalFromDoc(p);
    docConsent = getDocCommentConsent(ctx, DocComments, meta ? meta.doc_id : '');
  }

  const out = {
    id: facts.Id,
    consent_ok: !!c.consent_ok,
    reason: `${c.reason}`,
    human_segments: Number(c.human_segments),
    affirmative_phrase: c.affirmative_phrase,
    affirmative_author: c.affirmative_author,
    affirmative_unattributed: !!c.affirmative_unattributed,
    affirmative_answered: !!c.affirmative_answered,
    trailing_has_user: !!facts.HasTrailingUser,
    path: facts.Path,
  };
  if (DocComments) {
    const ok = !!(docConsent && docConsent.consent_ok);
    out.doc_consent_ok = ok;
    out.doc_consent_reason = docConsent ? `${docConsent.reason}` : 'doc-consent-not-consulted';
    out.doc_comments_path = `${DocComments}`;
    if (ok) {
      out.consent_ok = true;
      out.reason = 'doc-comment-affirmative';
      out.affirmative_phrase = docConsent.affirmative_phrase;
      out.affirmative_author = docConsent.affirmative_author;
    }
  }
  if (Action) addGateFallthrough(ctx, out, gate);
  ctx.emitJson(out, { depth: 4 });
}
