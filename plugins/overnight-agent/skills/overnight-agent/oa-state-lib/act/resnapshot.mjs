// resnapshot.mjs -- Cmd-Resnapshot.
import { get, has, psTruthy, setMember } from '../core/net.mjs';
import { getJournalFacts } from '../collect/journal.mjs';
import { nowIso, readState, writeState } from '../collect/state.mjs';
import { listTaskJournals } from './seed.mjs';

export function cmdResnapshot(ctx) {
  let updated = 0;
  let skipped = 0;
  let untracked = 0;
  for (const f of listTaskJournals(ctx)) {
    const facts = getJournalFacts(f.full);
    const st = readState(ctx, get(facts, 'Id'));
    if (!st) { untracked++; continue; }
    if (get(facts, 'FullHash') === get(st, 'processed_file_hash')) continue;
    if (get(facts, 'HasTrailingUser')) {
      if (get(facts, 'HasTrailingHuman') && !(has(st, 'unanswered_user_message_at') && psTruthy(get(st, 'unanswered_user_message_at')))) {
        setMember(st, 'unanswered_user_message_at', nowIso());
        st.updated = nowIso();
        writeState(ctx, st);
      }
      skipped++;
      continue;
    }
    st.processed_file_hash = get(facts, 'FullHash');
    st.has_agent_block = get(facts, 'HasAgentBlock');
    st.updated = nowIso();
    writeState(ctx, st);
    updated++;
  }
  ctx.emitJson({ rebaselined: updated, left_for_review: skipped, untracked }, { depth: 4 });
}
