import path from 'node:path';
import { joinSession } from '@github/copilot-sdk/extension';
import { createDispatcher, createRunBudget } from '../../checks/oa-dispatch.mjs';

const paths = {
  type: 'object', additionalProperties: false,
  description: 'Optional planner path overrides, matching oa-state.ps1.',
  properties: Object.fromEntries([
    'state_dir', 'journal_dir', 'planner_board', 'planner_completed', 'snooze_store', 'user_settings',
  ].map(key => [key, { type: 'string', minLength: 1 }])),
};
let runBudget;

function dispatcher(args, invocation) {
  if (!session.workspacePath) throw new Error('Coordinator session workspace is required for the per-run counter.');
  // One scheduled overnight run has one coordinator session. Keep its counter across tool
  // calls and extension reloads; a new run has a different session workspace and starts at zero.
  runBudget ??= createRunBudget({
    directory: path.join(session.workspacePath, 'files'), coordinatorSessionId: invocation.sessionId,
  });
  return createDispatcher({
    runBudget, paths: args.paths,
    invokeTool: (name, arguments_) => session.rpc.tools.execute({ name, arguments: arguments_ }),
  });
}

const session = await joinSession({
  tools: [
    {
      name: 'oa_run_budget',
      description: 'Read the current overnight run counter: automatic start/continue attempts, human collect attempts, and remaining allowance. Running tasks from earlier runs do not count. Reading this tool never resets the counter.',
      parameters: { type: 'object', properties: { paths }, additionalProperties: false },
      handler: async (args, invocation) => JSON.stringify(await dispatcher(args, invocation).budget()),
    },
    {
      name: 'oa_dispatch',
      description: 'Send an approved start/continue instruction to a saved task session and count the attempt in this overnight run. A task already working may receive another nudge; earlier runs do not consume this run budget. Pauses and eligibility still apply. Failed/uncertain sends consume this run allowance only, with no automatic retry. Create/bind new sessions idle before calling this tool.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['task_id', 'message'],
        properties: {
          task_id: { type: 'string', pattern: '^\\d+$' },
          message: { type: 'string', minLength: 1, description: 'The approved work brief and continuation context.' },
          collect_wave: { type: 'boolean', default: false, description: 'Human-triggered extra request; requires a recorded human journal reply or new doc comment and never overrides a pause.' },
          paths,
        },
      },
      handler: async (args, invocation) => JSON.stringify(await dispatcher(args, invocation).dispatch(args)),
    },
  ],
});
