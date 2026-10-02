// get.mjs -- Cmd-Get: print one task's persisted state JSON.
import { readState } from '../collect/state.mjs';

export function cmdGet(ctx) {
  if (!ctx.p.Id) throw new Error('get requires -Id');
  const st = readState(ctx, ctx.p.Id);
  if (!st) { ctx.out('{}'); return; }
  ctx.emitJson(st, { depth: 6 });
}
