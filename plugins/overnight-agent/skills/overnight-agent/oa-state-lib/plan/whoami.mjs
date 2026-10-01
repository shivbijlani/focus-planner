// whoami.mjs -- identify whether the current Copilot session is a bound task session (#727).
import fs from 'node:fs';
import { joinPath } from '../core/context.mjs';
import { readAllText, isDir, isFile } from '../core/fsx.mjs';
import { fromJson } from '../core/psjson.mjs';
import { get, psStr } from '../core/net.mjs';
import { getSessionState, getTaskRoleLine } from '../collect/sessions.mjs';

export function cmdWhoami(ctx) {
  const sid = ctx.p.SessionId ? ctx.p.SessionId : (process.env.COPILOT_AGENT_SESSION_ID || '');
  const hits = [];
  if (sid && isDir(ctx.p.StateDir)) {
    const files = fs.readdirSync(ctx.p.StateDir)
      .filter((name) => /^task-.*\.json$/i.test(name) && isFile(joinPath(ctx.p.StateDir, name)))
      .sort((a, b) => a.localeCompare(b, 'en-US', { sensitivity: 'accent' }));
    for (const name of files) {
      let obj;
      try { obj = fromJson(readAllText(joinPath(ctx.p.StateDir, name))); } catch { continue; }
      const s = getSessionState(obj);
      if (!s) continue;
      let match = null;
      if (psStr(get(s, 'session_id')) === sid) match = 'session_id';
      else if (psStr(get(s, 'prior_session_id')) === sid) match = 'prior_session_id';
      if (match) hits.push({ id: psStr(get(obj, 'id')), match, state: psStr(get(s, 'state')) });
    }
  }
  const role = !sid ? 'unknown' : hits.length ? 'task' : 'coordinator';
  const taskId = hits.length ? hits[0].id : null;
  ctx.emitJson({
    session_id: sid ? sid : null,
    session_id_source: ctx.p.SessionId ? 'parameter' : sid ? 'COPILOT_AGENT_SESSION_ID' : null,
    role,
    task_id: taskId,
    tasks: hits,
    role_line: taskId ? getTaskRoleLine(taskId) : null,
  }, { depth: 4 });
}
