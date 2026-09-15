import path from 'node:path';
import { joinSession } from '@github/copilot-sdk/extension';
import { createDispatcher } from '../../checks/oa-dispatch.mjs';

const paths = {
  type: 'object', additionalProperties: false,
  description: 'Optional planner paths, matching oa-state.ps1 overrides; omit for the standard installation.',
  properties: Object.fromEntries([
    'state_dir', 'journal_dir', 'planner_board', 'planner_completed', 'snooze_store', 'user_settings',
  ].map(key => [key, { type: 'string', minLength: 1 }])),
};

function dispatcher(args, invocation) {
  return createDispatcher({
    ownerSessionId: invocation.sessionId,
    paths: args.paths,
    sessionRoot: session.workspacePath ? path.dirname(session.workspacePath) : undefined,
    invokeTool: (name, arguments_, toolCallId) => session.rpc.tools.execute({
      name, arguments: arguments_, ...(toolCallId ? { toolCallId } : {}),
    }),
  });
}

const session = await joinSession({
  tools: [
    {
      name: 'oa_capacity',
      description: 'Read fresh app activity and reasoned Overnight Agent capacity, deduplicated by execution identity. Reconcile pending delivery evidence; never change task bindings, pauses or the concurrency setting. Unknown delivery has a deadline and explicit recovery guidance.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          paths,
          reconcile: { type: 'boolean', default: true, description: 'Set false for a strictly read-only audit; do not retire or garbage-collect delivery receipts.' },
        },
      },
      handler: async (args, invocation) => JSON.stringify(await dispatcher(args, invocation).capacity({ reconcile: args.reconcile })),
    },
    {
      name: 'oa_scan',
      description: 'Read the Today-first Overnight Agent worklist with fresh app-backed capacity membership per task. This replaces a bare oa-state scan in the normal run; eligibility and capacity are separate. State-only audit rows are explicitly ineligible.',
      parameters: { type: 'object', properties: { paths }, additionalProperties: false },
      handler: async (args, invocation) => JSON.stringify(await dispatcher(args, invocation).scan()),
    },
    {
      name: 'oa_dispatch',
      description: 'Dispatch approved work to a persisted task session exactly once through atomic capacity admission and the native app message tool. Use instead of raw send_session_message for scheduled task wakes. Create/bind new sessions idle first. Never retry an ambiguous send; inspect oa_capacity. collect_wave requires a recorded human journal reply or new human doc comment, and never bypasses a pause, busy target, duplicate wake or unknown activity.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['task_id', 'wake_key', 'message'],
        properties: {
          task_id: { type: 'string', pattern: '^\\d+$' },
          wake_key: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'The exact wake_key from this task in oa_scan. Re-read/re-plan if its input changed; never invent a key.' },
          message: { type: 'string', minLength: 1, description: 'The approved work brief, including continuation and linked-task context.' },
          collect_wave: { type: 'boolean', default: false },
          paths,
        },
      },
      handler: async (args, invocation) => JSON.stringify(await dispatcher(args, invocation).dispatch(args)),
    },
  ],
});
