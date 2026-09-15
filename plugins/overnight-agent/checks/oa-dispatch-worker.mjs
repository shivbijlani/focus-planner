// Separate processes are essential here: an in-process promise mutex would pass a weaker test.
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createDispatcher } from './oa-dispatch.mjs';

const [configPath, owner, taskId] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
let first = true;
const dispatcher = createDispatcher({
  ownerSessionId: `coordinator-${owner}`, paths: config.paths,
  sessionRoot: config.sessionRoot, scriptPath: config.subject,
  invokeTool: async (name, args) => {
    if (name === 'get_sessions_status') {
      const sessions = fs.readdirSync(config.paths.state_dir).filter(n => /^task-.+\.json$/.test(n)).map(n => {
        const task = JSON.parse(fs.readFileSync(path.join(config.paths.state_dir, n), 'utf8').replace(/^\uFEFF/, ''));
        return { id: task.session.session_id, activity: { status: 'idle' }, is_running: false };
      });
      if (first) {
        first = false;
        fs.writeFileSync(path.join(config.root, `ready-${owner}`), '');
        const deadline = Date.now() + 10000;
        while (!fs.existsSync(path.join(config.root, `ready-${owner === 'a' ? 'b' : 'a'}`))) {
          if (Date.now() > deadline) throw new Error('Other coordinator did not reach the snapshot barrier.');
          await setTimeout(10);
        }
      }
      return JSON.stringify({ sessions });
    }
    if (name === 'send_session_message') {
      fs.appendFileSync(path.join(config.root, 'sent.jsonl'), JSON.stringify(args) + '\n');
      return 'Accepted';
    }
    throw new Error(`Unexpected native tool ${name}`);
  },
});
try {
  console.log(JSON.stringify(await dispatcher.dispatch({ task_id: taskId, message: 'Approved fixture work' })));
} catch (error) {
  console.log(JSON.stringify({ accepted: false, error: error.message }));
}
