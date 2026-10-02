// seed.mjs -- Cmd-Seed (oa-state.ps1: Cmd-Seed).
import fs from 'node:fs';
import path from 'node:path';
import { joinPath } from '../core/context.mjs';
import { fileNameWithoutExtension, isFile } from '../core/fsx.mjs';
import { get, psStr, setMember } from '../core/net.mjs';
import { ensureStateDir, nowIso, readState, writeState } from '../collect/state.mjs';
import { getJournalFacts } from '../collect/journal.mjs';

export function listTaskJournals(ctx) {
  let names = [];
  try { names = fs.readdirSync(ctx.p.JournalDir); } catch { return []; }
  return names
    .filter((name) => /^task-.*\.md$/i.test(name))
    .map((name) => ({ name, full: joinPath(ctx.p.JournalDir, name), base: fileNameWithoutExtension(name) }))
    .filter((f) => /^task-\d+$/i.test(f.base) && isFile(f.full))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'accent' }));
}

export function cmdSeed(ctx) {
  ensureStateDir(ctx);
  let n = 0;
  for (const f of listTaskJournals(ctx)) {
    const facts = getJournalFacts(f.full);
    if (readState(ctx, get(facts, 'Id')) && !ctx.p.Force) continue;
    const legacy = get(facts, 'Legacy');
    const state = {
      id: get(facts, 'Id'),
      status: legacy ? psStr(get(legacy, 'status')) : get(facts, 'HasAgentBlock') ? 'unknown' : 'none',
      version: legacy && get(legacy, 'version') ? Number(psStr(get(legacy, 'version'))) : 0,
      plan_id: legacy ? psStr(get(legacy, 'plan_id')) : '',
      processed_file_hash: get(facts, 'AgentLeftHash'),
      has_agent_block: get(facts, 'HasAgentBlock'),
      seeded: true,
      updated: nowIso(),
    };
    writeState(ctx, state);
    n++;
  }
  ctx.out(`seeded ${n} task state file(s) into ${ctx.p.StateDir}`);
}
