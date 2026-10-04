// args.mjs -- oa-state.ps1's parameter block, bound the way `pwsh -File oa-state.ps1 ...` binds it.
//
// Case-insensitive names, unique prefixes, `-Name:value`, a switch never takes a separate value,
// only `Command` is positional (it is the only parameter with an explicit Position), ValidateSet
// is case-insensitive and keeps the caller's spelling, [int] parameters convert the way .NET
// does. GNU `--Name` / `--name=value` are accepted too, since the characterization adapter and
// Node callers use them. Binder failures carry PowerShell's own message so the goldens' normalised
// `<PS-PARAM-...:Name>` tokens are reproduced exactly.
import { lowerInvariant, roundHalfEven } from './net.mjs';

export const COMMANDS = ['seed', 'scan', 'get', 'mark', 'resnapshot', 'consent', 'gate', 'extract', 'doc', 'session', 'whoami', 'critical-tools', 'decisions'];
export const ACTIONS = ['merge_pr', 'open_pr', 'push_main', 'delete_branch', 'send_email_self', 'send_email_reply',
  'send_email_new_thread', 'send_email_many', 'post_public', 'spend_money', 'delete_data', 'deploy', 'publish_release'];

const S = 'string';
const I = 'int';
const W = 'switch';
const A = 'string[]';
export const PARAMS = [
  { name: 'Command', type: S, pos: 0, set: COMMANDS },
  { name: 'Id', type: S }, { name: 'Status', type: S },
  { name: 'StatusBy', type: S, set: ['user', 'agent'] },
  { name: 'TurnBy', type: S }, { name: 'Version', type: I }, { name: 'PlanId', type: S }, { name: 'Force', type: W },
  { name: 'BudgetKB', type: I }, { name: 'Json', type: W }, { name: 'Verify', type: W },
  { name: 'Compact', type: W }, { name: 'ScanOutFile', type: S },
  { name: 'RunId', type: S }, { name: 'ScanFile', type: S }, { name: 'Outcomes', type: S }, { name: 'RunLedger', type: S },
  { name: 'RetainDays', type: I }, { name: 'MaxDecisionRows', type: I }, { name: 'DecisionNow', type: S },
  { name: 'LockWaitSeconds', type: I },
  { name: 'Action', type: S, set: ACTIONS }, { name: 'Repo', type: S },
  { name: 'Poll', type: S }, { name: 'PollDone', type: W }, { name: 'PollClear', type: W },
  { name: 'DocId', type: S }, { name: 'DocUrl', type: S }, { name: 'Observe', type: S }, { name: 'Ack', type: W }, { name: 'Unbind', type: W },
  { name: 'DocComments', type: S },
  { name: 'Recheck', type: S }, { name: 'RecheckKind', type: S }, { name: 'RecheckDone', type: W }, { name: 'RecheckClear', type: W },
  { name: 'SessionId', type: S }, { name: 'SessionKind', type: S, set: ['code', 'chat'] },
  { name: 'SessionProject', type: S }, { name: 'SessionWorkspace', type: S },
  { name: 'WorkspaceType', type: S, set: ['worktree', 'branch', 'folder'] },
  { name: 'RunWorkspace', type: S }, { name: 'SessionDead', type: W }, { name: 'CheckDispatch', type: W },
  { name: 'ForDispatch', type: W }, { name: 'DispatchInput', type: S },
  { name: 'SessionsStatusFile', type: S }, { name: 'RequiresTools', type: A }, { name: 'CapabilitiesPath', type: S },
  { name: 'SessionRelease', type: W }, { name: 'WorkspaceGone', type: S },
  { name: 'JournalDir', type: S }, { name: 'StateDir', type: S }, { name: 'SessionStateDir', type: S },
  { name: 'PlannerBoard', type: S }, { name: 'PlannerCompleted', type: S }, { name: 'SnoozeStore', type: S }, { name: 'GatePath', type: S },
  { name: 'TodayServedMinutes', type: I }, { name: 'TodayGateStrict', type: W }, { name: 'ExhaustionTtlMinutes', type: I },
  { name: 'TodayGateBackstopHours', type: I }, { name: 'UserSettings', type: S }, { name: 'McpConfig', type: S },
  { name: 'Exhausted', type: S }, { name: 'ExhaustedNote', type: S }, { name: 'ExhaustionClear', type: W },
  // [CmdletBinding()] common parameters: accepted, and inert in this script.
  { name: 'Verbose', type: W, common: true, aliases: ['vb'] },
  { name: 'Debug', type: W, common: true, aliases: ['db'] },
  { name: 'ErrorAction', type: S, common: true, aliases: ['ea'] },
  { name: 'WarningAction', type: S, common: true, aliases: ['wa'] },
  { name: 'InformationAction', type: S, common: true, aliases: ['infa'] },
  { name: 'ProgressAction', type: S, common: true, aliases: ['proga'] },
  { name: 'ErrorVariable', type: S, common: true, aliases: ['ev'] },
  { name: 'WarningVariable', type: S, common: true, aliases: ['wv'] },
  { name: 'InformationVariable', type: S, common: true, aliases: ['iv'] },
  { name: 'OutVariable', type: S, common: true, aliases: ['ov'] },
  { name: 'OutBuffer', type: S, common: true, aliases: ['ob'] },
  { name: 'PipelineVariable', type: S, common: true, aliases: ['pv'] },
];

export const DEFAULTS = {
  Command: 'scan', BudgetKB: 24, RetainDays: 7, MaxDecisionRows: 50, LockWaitSeconds: 0,
  TodayServedMinutes: -1, ExhaustionTtlMinutes: 30, TodayGateBackstopHours: -1,
};

const TYPE_NAME = { string: 'System.String', int: 'System.Int32', 'string[]': 'System.String[]', switch: 'System.Management.Automation.SwitchParameter' };

export class BindError extends Error {}

function resolveParam(raw) {
  const lname = lowerInvariant(raw);
  const exact = PARAMS.find((p) => lowerInvariant(p.name) === lname || (p.aliases || []).includes(lname));
  if (exact) return exact;
  const pre = PARAMS.filter((p) => lowerInvariant(p.name).startsWith(lname));
  if (pre.length === 1) return pre[0];
  if (pre.length > 1) {
    throw new BindError(`Parameter cannot be processed because the parameter name '${raw}' is ambiguous. Possible matches include: ${pre.map((p) => '-' + p.name).join(' ')}.`);
  }
  throw new BindError(`A parameter cannot be found that matches parameter name '${raw}'.`);
}

function convertInt(p, value) {
  const s = String(value).trim();
  let n = null;
  if (/^[+-]?\d+$/.test(s)) n = Number(s);
  else if (/^[+-]?0x[0-9a-f]+$/i.test(s)) n = (s.startsWith('-') ? -1 : 1) * parseInt(s.replace(/^[+-]/, ''), 16);
  else if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) n = roundHalfEven(Number(s));
  if (n === null || !Number.isFinite(n) || n > 2147483647 || n < -2147483648) {
    throw new BindError(`Cannot process argument transformation on parameter '${p.name}'. Cannot convert value "${value}" to type "System.Int32". Error: "The input string '${value}' was not in a correct format."`);
  }
  return n;
}

function validate(p, value) {
  if (!p.set) return value;
  if (!p.set.some((x) => lowerInvariant(x) === lowerInvariant(value))) {
    throw new BindError(`Cannot validate argument on parameter '${p.name}'. The argument "${value}" does not belong to the set "${p.set.join(',')}" specified by the ValidateSet attribute. Supply an argument that is in the set and then try the command again.`);
  }
  return value;
}

// Returns { values, explicit } where `explicit` is the set of parameter names actually bound
// ($PSBoundParameters), and `values` has every parameter (bound or defaulted).
export function bindArgs(argv) {
  const bound = {};
  const positional = [];
  const isName = (a) => /^--?[A-Za-z_?]/.test(a);
  const once = (p) => {
    if (Object.prototype.hasOwnProperty.call(bound, p.name)) {
      throw new BindError(`Cannot bind parameter because parameter '${p.name}' is specified more than once. To provide multiple values to parameters that can accept multiple values, use the array syntax. For example, "-parameter value1,value2,value3".`);
    }
  };
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (!isName(a)) { positional.push(a); continue; }
    let body = a.replace(/^--?/, '');
    let inline;
    const colon = /^([^:=]+)[:=]([\s\S]*)$/.exec(body);
    if (colon) { body = colon[1]; inline = colon[2]; }
    const p = resolveParam(body);
    if (p.type === W) {
      once(p);
      bound[p.name] = inline === undefined ? true : !/^(\$?false|0)$/i.test(inline.trim());
      continue;
    }
    let value = inline;
    if (value === undefined) {
      const next = argv[k + 1];
      if (next === undefined || isName(next)) {
        throw new BindError(`Missing an argument for parameter '${p.name}'. Specify a parameter of type '${TYPE_NAME[p.type]}' and try again.`);
      }
      value = next;
      k++;
    }
    if (p.type === A) { (bound[p.name] ||= []).push(...String(value).split(',')); continue; }
    once(p);
    bound[p.name] = p.type === I ? convertInt(p, value) : validate(p, value);
  }
  for (const v of positional) {
    const p = PARAMS.find((x) => x.pos === 0);
    if (Object.prototype.hasOwnProperty.call(bound, p.name)) throw new BindError(`A positional parameter cannot be found that accepts argument '${v}'.`);
    bound[p.name] = validate(p, v);
  }
  const values = {};
  for (const p of PARAMS) {
    if (p.common) continue;
    if (Object.prototype.hasOwnProperty.call(bound, p.name)) values[p.name] = bound[p.name];
    else if (p.type === W) values[p.name] = false;
    else if (Object.prototype.hasOwnProperty.call(DEFAULTS, p.name)) values[p.name] = DEFAULTS[p.name];
    else if (p.type === I) values[p.name] = 0;
    else if (p.type === A) values[p.name] = null;
    else values[p.name] = '';
  }
  values.Command = lowerInvariant(values.Command) === values.Command ? values.Command : values.Command;
  return { values, explicit: new Set(Object.keys(bound)) };
}
