// A start/continue quota for ONE coordinator run, not a count of running task sessions.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const pathFlags = {
  state_dir: 'StateDir', journal_dir: 'JournalDir', planner_board: 'PlannerBoard',
  planner_completed: 'PlannerCompleted', snooze_store: 'SnoozeStore', user_settings: 'UserSettings',
};

export function createRunBudget({ directory, coordinatorSessionId }) {
  if (!directory || !coordinatorSessionId) throw new Error('A coordinator run directory and session ID are required.');
  const file = path.join(directory, 'oa-run-budget.json');
  let tail = Promise.resolve();

  function read() {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return { version: 1, coordinator_session_id: coordinatorSessionId, requests: [] };
      throw error;
    }
    let data;
    try { data = JSON.parse(raw); }
    catch (error) { throw new Error(`run_budget_invalid: ${error.message}`); }
    if (data.version !== 1 || data.coordinator_session_id !== coordinatorSessionId ||
        !Array.isArray(data.requests) || data.requests.some(item =>
          !/^\d+$/.test(item?.task_id ?? '') || !['priority', 'collect'].includes(item?.wave))) {
      throw new Error('run_budget_invalid: refusing to reset an unreadable or different run counter');
    }
    return data;
  }

  return {
    serial(operation) {
      // Serialize tool calls within this run. The original promise still delivers failures
      // to the caller; they must not poison subsequent budget reads.
      const result = tail.then(operation);
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
    view(limit, source) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid per-run limit from oa-state.');
      const requests = read().requests;
      const priority = requests.filter(item => item.wave === 'priority').length;
      return {
        scope: 'per_run', coordinator_session_id: coordinatorSessionId,
        limit, limit_source: source,
        attempted_this_run: priority,
        collect_attempted_this_run: requests.length - priority,
        remaining_this_run: Math.max(0, limit - priority),
        requests,
      };
    },
    record(taskId, collectWave) {
      const data = read();
      data.requests.push({ task_id: taskId, wave: collectWave ? 'collect' : 'priority' });
      fs.mkdirSync(directory, { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, JSON.stringify(data));
        fs.renameSync(temporary, file);
      } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      }
    },
  };
}

export function createDispatcher({ invokeTool, runBudget, paths = {}, scriptPath, psExe } = {}) {
  if (typeof invokeTool !== 'function' || !runBudget) throw new Error('Native message delivery and a shared run budget are required.');
  const subject = scriptPath || [
    path.join(HERE, '..', 'skills', 'overnight-agent', 'oa-state.ps1'), path.join(HERE, 'oa-state.ps1'),
  ].find(candidate => fs.existsSync(candidate));
  if (!subject) throw new Error('oa-state.ps1 is missing from this plugin.');
  const executable = psExe || (process.platform === 'win32' ? 'powershell' : 'pwsh');
  const flags = Object.entries(paths).flatMap(([key, value]) => {
    if (!pathFlags[key] || typeof value !== 'string' || !value) throw new Error(`Invalid path option: ${key}`);
    return [`-${pathFlags[key]}`, value];
  });

  async function runState(args) {
    let result;
    try {
      result = await exec(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', subject, ...args, ...flags], { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 120000 });
    } catch (error) {
      throw new Error(`oa-state failed: ${(error.stderr || error.message).trim()}`);
    }
    try { return JSON.parse(result.stdout.replace(/^\uFEFF/, '')); }
    catch { throw new Error(`oa-state produced invalid JSON: ${result.stdout.slice(0, 1000)}`); }
  }

  return {
    budget() {
      return runBudget.serial(async () => {
        const settings = await runState(['session', '-RunLimit']);
        return runBudget.view(settings.dispatch_limit, settings.limit_source);
      });
    },
    dispatch({ task_id, message, collect_wave = false }) {
      return runBudget.serial(async () => {
        if (!/^\d+$/.test(String(task_id)) || typeof message !== 'string' || !message.trim() ||
            typeof collect_wave !== 'boolean') throw new Error('A numeric task_id and approved work brief are required.');
        const args = ['session', '-Id', String(task_id), ...(collect_wave ? ['-Force'] : [])];
        const checked = await runState([...args, '-CheckDispatch']);
        if (!checked.dispatch_eligible) throw new Error('Task was not approved for dispatch; nothing sent.');
        const budget = runBudget.view(checked.dispatch_limit, checked.limit_source);
        if (!collect_wave && budget.remaining_this_run === 0) {
          throw new Error(`run_budget_exhausted: ${budget.attempted_this_run}/${budget.limit} automatic attempts used in this run`);
        }

        // Count BEFORE trying to start. A failed/lost response uses this run's allowance,
        // but never reserves capacity in the next run. There is no automatic retry here.
        runBudget.record(String(task_id), collect_wave);
        const started = await runState([...args, '-ForDispatch']);
        if (!started.dispatch_authorised || !started.session_id) throw new Error('Wake was not recorded; attempt counted but nothing sent.');
        try {
          const result = await invokeTool('send_session_message', {
            session_id: started.session_id, message, delivery_mode: 'immediate',
          });
          if (typeof result === 'string' ? !result.trim() : result?.resultType !== 'success') {
            throw new Error(result?.error || result?.textResultForLlm || 'Unsuccessful native message result');
          }
        } catch (error) {
          throw new Error(`dispatch_not_confirmed: ${error.message}. Attempt counted in this run; the next run starts with a fresh budget.`);
        }
        return {
          task_id: String(task_id), session_id: started.session_id, accepted: true,
          ...runBudget.view(checked.dispatch_limit, checked.limit_source),
        };
      });
    },
  };
}
