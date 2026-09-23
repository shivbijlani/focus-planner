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
    const planner = createPlanner({ paths: settings });
    // Pin the buffer at enrollment. Reload must not move an existing run's launch deadline.
    const timing = existing ? {
      start_buffer_minutes: existing.start_buffer_minutes,
      start_buffer_source: existing.start_buffer_source,
    } : await planner.settings();
    if (timing.start_buffer_error) throw new Error(timing.start_buffer_error);
    if (!Number.isSafeInteger(timing.start_buffer_minutes) ||
        !['default', 'settings'].includes(timing.start_buffer_source)) {
      throw new Error('drain_buffer_invalid: helper/run state lacks validated start-buffer settings; use the current plugin in a fresh run');
    }
    drain = createDrain({
      directory, coordinatorSessionId: session.sessionId, startedAt: await coordinatorStart(session.workspacePath),
      paths: settings, planner,
      startBufferMinutes: timing.start_buffer_minutes, startBufferSource: timing.start_buffer_source,
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
      description: 'Enroll this overnight coordinator and read its queue/deadline. Before preparing sessions, resolve Overnight Agent start buffer (default 5m) from user-settings. No new start at/after the next :00/:30 minus that buffer. Status includes next_run_at, start_buffer_minutes/source and cutoff; reload never extends it.',
      parameters: { type: 'object', properties: { paths: pathsSchema }, additionalProperties: false },
      handler: async args => JSON.stringify((await initialize(args.paths)).status()),
    },
    {
      name: 'oa_drain',
      description: 'Prepare approved briefs and start automatic N-wide draining. Code selects, checks, sends, observes and refills until next half-hour minus the configured start buffer (default5m). The buffer stops new starts, not already-running tasks. Each task is attempted once/run. Create/bind idle first. Earlier runs do not reserve this run capacity; elapsed time never proves completion.',
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
