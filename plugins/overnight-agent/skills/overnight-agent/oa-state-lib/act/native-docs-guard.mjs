import path from 'node:path';
import { bindArgs } from '../core/args.mjs';
import { buildContext, assertSandboxPath } from '../core/context.mjs';
import { getJournalFacts } from '../collect/journal.mjs';
import { readState } from '../collect/state.mjs';
import { getCompletedBoardIds, getBoardMap, getSnoozeMap } from '../collect/board.mjs';
import { getSessionLineage, getSessionState } from '../collect/sessions.mjs';
import { testUserPaused } from '../plan/pause.mjs';
import { testUserClosed } from '../plan/workable.mjs';
import { assertLaneServed } from '../plan/lanes.mjs';

export function assertDocsTaskWritable({ root, task }) {
  const args = ['get', '-Id', String(task), '-JournalDir', path.join(root, 'journal'),
    '-PlannerBoard', path.join(root, 'planner.md'), '-PlannerCompleted', path.join(root, 'planner-completed.md'),
    '-SnoozeStore', path.join(root, 'snooze.json'), '-GatePath', path.join(root, 'agent-gate.md')];
  const bound = bindArgs(args);
  const ctx = buildContext(bound.values, bound.explicit);
  for (const key of ['StateDir', 'JournalDir', 'PlannerBoard', 'PlannerCompleted', 'SnoozeStore', 'GatePath']) {
    assertSandboxPath(ctx.p[key], key);
  }
  const id = String(task);
  assertLaneServed(ctx, id);
  const facts = getJournalFacts(path.join(root, 'journal', `task-${id}.md`));
  const state = readState(ctx, id);
  if (getSnoozeMap(ctx)[id]) throw new Error(`docs_task_snoozed: task ${id} is snoozed`);
  if (testUserPaused(state, facts)) throw new Error(`docs_task_paused: task ${id} was paused by the user`);
  if (getCompletedBoardIds(ctx)[id] || testUserClosed({
    status: state?.status, status_by: state?.status_by, on_board: !!getBoardMap(ctx)[id],
  })) throw new Error(`docs_task_closed: task ${id} is user-closed; reopen its row first`);
  const session = getSessionState(state);
  const caller = process.env.COPILOT_AGENT_SESSION_ID;
  if (session && ![session.session_id, ...getSessionLineage(session)].includes(caller)) {
    throw new Error(`docs_task_owned: only task ${id}'s bound session may acknowledge or publish; coordinator and unknown callers must dispatch`);
  }
}
