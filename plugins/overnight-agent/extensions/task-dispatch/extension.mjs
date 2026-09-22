import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { joinSession } from '@github/copilot-sdk/extension';
import { boundedToolCall, coordinatorStart, createDrain, createDispatchGuard, createNativeAdapter, createPlanner } from '../../checks/oa-dispatch.mjs';

const pathsSchema = {
  type: 'object', additionalProperties: false,
  properties: Object.fromEntries(['state_dir', 'journal_dir', 'planner_board', 'planner_completed',
    'snooze_store', 'user_settings'].map(key => [key, { type: 'string', minLength: 1 }])),
};
let drain, guard, initialization, runner, enrolled = false;
async function initialize(paths) {
  if (!initialization) initialization = (async () => {
    if (!session.workspacePath) throw new Error('Coordinator session workspace is required');
    const directory = path.join(session.workspacePath, 'files');
    const saved = path.join(directory, 'oa-drain.json');
    const existing = fs.existsSync(saved) ? JSON.parse(fs.readFileSync(saved, 'utf8')) : null;
    const settings = paths ?? existing?.paths ?? {};
    if (existing && paths && JSON.stringify(paths) !== JSON.stringify(existing.paths)) throw new Error('Planner paths cannot change within a drain run');
    enrolled = true;
    guard = createDispatchGuard({
      enrolled: () => enrolled, busy: () => Boolean(runner), cutoff: () => drain?.status().cutoff ?? new Date(0).toISOString(),
    });
    const invokeTool = (name, args) => {
      const invoke = () => boundedToolCall(() => session.rpc.tools.execute({ name, arguments: args }), drain.status().cutoff);
      return name === 'send_session_message' ? guard.send(args, invoke) : invoke();
    };
    drain = createDrain({
      directory, coordinatorSessionId: session.sessionId, startedAt: await coordinatorStart(session.workspacePath),
      paths: settings, planner: createPlanner({ paths: settings }),
      adapter: createNativeAdapter({ invokeTool, sessionRoot: path.dirname(session.workspacePath) }),
    });
    if (existing?.status === 'running' || existing?.status === 'ready' && existing.items.some(item => item.state === 'queued')) start();
  })();
  await initialization;
  if (paths && JSON.stringify(paths) !== JSON.stringify(drain.status().paths)) throw new Error('Planner paths cannot change within a drain run');
  return drain;
}
function start() {
  if (runner) return;
  const execution = drain.run();
  runner = execution;
  execution.then(async result => {
    if (runner === execution) runner = undefined;
    await session.log(`Overnight drain ${result.status}: ${result.items.filter(item => item.state === 'completed').length} completed; cutoff ${result.cutoff}${result.error ? `; ${result.error}` : ''}`,
      { level: result.status === 'error' ? 'error' : 'info' });
  }, async error => {
    if (runner === execution) runner = undefined;
    await session.log(`Overnight drain failed: ${error.message}`, { level: 'error' });
  }).catch(error => process.stderr.write(`Overnight drain reporting failed: ${error.message}\n`));
}

const session = await joinSession({
  hooks: {
    onPreToolUse: async input => guard?.before(input.toolName, input.toolArgs),
  },
  tools: [
    {
      name: 'oa_drain_status',
      description: 'Enroll this overnight coordinator and read its code-owned queue/deadline. Call before preparing task sessions. Native raw wakes and create-with-kickoff are blocked after enrollment. Deadline is the next :00/:30 boundary after the first prompt, not reset by tool calls.',
      parameters: { type: 'object', properties: { paths: pathsSchema }, additionalProperties: false },
      handler: async args => JSON.stringify((await initialize(args.paths)).status()),
    },
    {
      name: 'oa_drain',
      description: 'Prepare approved task briefs and start automatic N-wide queue draining. Code rechecks priority/pauses, sends instructions, observes completion, refills openings and stops at the stored half-hour deadline. It processes each task at most once in this run. Create/bind conversations idle first. Earlier runs do not reserve this run capacity. No five-minute completion assumption.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['tasks'],
        properties: {
          paths: pathsSchema,
          tasks: {
            type: 'array', maxItems: 200,
            items: {
              type: 'object', additionalProperties: false, required: ['task_id', 'dispatch_input', 'message'],
              properties: {
                task_id: { type: 'string', pattern: '^\\d+$' },
                dispatch_input: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Exact dispatch_input from the scan used to prepare this approved brief; changed input is rejected, never silently restamped.' },
                message: { type: 'string', minLength: 1, maxLength: 100000 },
                collect_wave: { type: 'boolean', default: false, description: 'Explicit human collect exception; requires recorded human input and never bypasses pauses or cutoff.' },
              },
            },
          },
        },
      },
      handler: async args => {
        const scheduler = await initialize(args.paths);
        await scheduler.prepare(args.tasks);
        start();
        return JSON.stringify(scheduler.status());
      },
    },
    {
      name: 'oa_drain_wait',
      description: 'Wait up to 20 seconds for the autonomous drain; waiting does not schedule work or extend its deadline. Repeat for progress if still running. The completion hook prevents ending a coordinator while its drain is active.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => {
        const scheduler = await initialize();
        if (runner) await Promise.race([runner, sleep(20000)]);
        return JSON.stringify(scheduler.status());
      },
    },
  ],
});

// Reload resumes the same run and cutoff, not a fresh allowance. Only previously enrolled
// coordinators activate this path; ordinary task sessions are not converted into coordinators.
if (session.workspacePath && fs.existsSync(path.join(session.workspacePath, 'files', 'oa-drain.json'))) {
  await initialize();
}
