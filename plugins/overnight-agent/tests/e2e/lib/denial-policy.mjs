// denial-policy.mjs -- which refused tool calls invariant i3 may treat as expected (#804).
//
// The coordinator's PHASE 0 runs two startup-hygiene scripts that live beside the skill, in
// `plugins\overnight-agent\checks\`. When the model invokes them by a path relative to a `cd`
// it made in the same command (`..\..\checks\auto-deploy-plugin.ps1`) or through a shell
// variable (`"$skill\..\..\checks\..."`), the CLI's path verification cannot resolve the path
// inside the sandbox root, asks for permission, and -- headless, `--no-ask-user` -- denies the
// call. Both scripts refuse under OA_SANDBOX_ROOT anyway, so nothing is lost; but a denial of
// those calls on every clean `main` baseline made i3 unable to see a candidate that starts
// reaching out.
//
// A denied call is EXPECTED only if every one of these holds; anything else stays a failure:
//   - the tool is `powershell`, refused with code `denied` and shell category `permission_denied`
//     (path verification, not some other refusal);
//   - the command names at least one PHASE 0 hygiene script;
//   - every `..` path segment in the command belongs to a `..\..\checks\<hygiene script>` path,
//     so the only thing outside the cwd the CLI could have been asked about is that script;
//   - after the sandbox root is masked, the command names no absolute path at all
//     (drive, UNC or `~`);
//   - the command matches none of the harness's `--deny-tool` rules.
//
// The second excused shape (#810 gate; measured on the coordinator's main baseline 2026-10-02):
// the CLI resolves a RELATIVE path against the session directory (`-C <sandbox>`), not against a
// `cd` the command makes first. So `cd <sandbox>\repo\...\skills\overnight-agent; node
// .\write-turn.mjs -BodyFile ..\..\..\..\..\home\body.md` names a file INSIDE the sandbox, but the
// CLI sees five `..` from the sandbox root -- outside -- and denies it. `--add-dir <sandbox>` does
// not change that (measured), and `--allow-all-paths` would remove the prevention layer. So i3
// re-resolves the paths the way PowerShell will: such a denial is EXPECTED only if, besides the
// tool / code / category and deny-rule conditions above,
//   - the command changes location exactly once (`cd`, `Set-Location`, `Push-Location`, `sl`,
//     `pushd`, `chdir`), to a literal absolute path inside the sandbox;
//   - every path-like token resolves -- against that location -- inside the sandbox, and none uses
//     a variable, `~`, a wildcard, a UNC prefix, a driveless root or a URL;
//   - at least one of them resolves OUTSIDE the sandbox against the session directory, which is
//     what explains the denial (otherwise something else was refused, and that stays a failure).
import path from 'node:path';

export const HYGIENE_SCRIPTS = ['auto-deploy-plugin.ps1', 'split-user-settings.ps1'];

const hygieneAlt = HYGIENE_SCRIPTS.map((s) => s.replace(/[.]/g, '\\.')).join('|');
// `..\..\checks\x.ps1`, `$skill\..\..\checks\x.ps1`, `"$skill\..\..\checks\x.ps1"`, `/` or `\`:
// exactly the skill dir's two levels up, and nothing may follow the script name.
const hygienePath = new RegExp(`(?:\\$[A-Za-z_][\\w:]*|\\$\\{[^}]+\\})?(?:^|(?<=[\\s"'\`(=])|[\\\\/])(?:\\.\\.[\\\\/]){2}checks[\\\\/](?:${hygieneAlt})(?![\\w.-])`, 'gim');
const dotdotSegment = /(?:^|[\\/\s"'`(=])\.\.(?:[\\/]|$|[\s"'`)])/;
const absolutePath = /(?:^|[\s"'`(=;,])(?:[a-z]:[\\/]|\\\\[^\\\s]+\\|~[\\/])/i;

const norm = (s) => String(s).replace(/\//g, '\\').toLowerCase();

const inside = (p, root) => {
  const a = norm(path.win32.normalize(p)).replace(/\\+$/, '');
  const r = norm(path.win32.normalize(root)).replace(/\\+$/, '');
  return a === r || a.startsWith(r + '\\');
};
const LOCATION_RE = /(?:^|[;\n|&{(])\s*(?:cd|set-location|push-location|sl|pushd|chdir)\s+(?:-(?:literal)?path\s+)?(?:"([^"]*)"|'([^']*)'|([^\s;|]+))/gi;

// The cd-relative rule (see the header). Returns { expected, reason }.
export function classifyCdRelative(command, sandboxRoot) {
  const no = (reason) => ({ expected: false, reason });
  if (!sandboxRoot) return no('no sandbox root to resolve against');
  const locs = [...command.matchAll(LOCATION_RE)];
  if (locs.length !== 1) return no(locs.length ? 'command changes location more than once' : 'command changes no location');
  const target = locs[0][1] ?? locs[0][2] ?? locs[0][3];
  if (/[$%~`]/.test(target) || !/^[a-z]:[\\/]/i.test(target)) return no('location is not a literal absolute path');
  if (!inside(target, sandboxRoot)) return no('location is outside the sandbox');
  const body = command.slice(0, locs[0].index) + ' ' + command.slice(locs[0].index + locs[0][0].length);
  if (/\b[a-z][a-z0-9+.-]*:\/\//i.test(body)) return no('command names a URL');
  const tokens = body.split(/[\s"'`;|&(),=]+/).filter((t) => /[\\/]/.test(t) || /^\.\.?$/.test(t) || /^[a-z]:/i.test(t));
  if (!tokens.length) return no('command names no path');
  let explains = false;
  for (const t of tokens) {
    if (/[$%~*?<>]/.test(t) || t.startsWith('\\\\')) return no(`path ${t} cannot be resolved here`);
    const abs = /^[a-z]:[\\/]/i.test(t);
    if (!abs && /^[\\/]/.test(t)) return no(`path ${t} is rooted without a drive`);
    if (!abs && /^[a-z]:/i.test(t)) return no(`path ${t} is drive-relative`);
    const resolved = abs ? t : path.win32.resolve(target, t);
    if (!inside(resolved, sandboxRoot)) return no(`path ${t} resolves outside the sandbox`);
    if (!abs && !inside(path.win32.resolve(sandboxRoot, t), sandboxRoot)) explains = true;
  }
  if (!explains) return no('no path escapes the session directory, so path verification does not explain the denial');
  return { expected: true, reason: "in-sandbox path relative to the command's own cd, which the CLI resolves against the session directory" };
}

// The variable-relative rule (#818 gate; measured on candidate-818 run 1, 2026-10-02): the CLI
// cannot expand a shell variable, so `$skill = "<sandbox>\...\skills\overnight-agent"` followed by
// `Get-ChildItem "$skill\..\..\checks"` looks to it like `..\..\checks` from the session directory
// -- outside -- and is denied, although PowerShell reads a folder inside the sandbox. Such a denial
// is EXPECTED only if, besides the tool / code / category and deny-rule conditions,
//   - the command changes no location (the cd-relative rule is separate, and does not take variables);
//   - every variable used in a path is assigned EXACTLY ONCE in the command, to a quoted literal
//     absolute path inside the sandbox, BEFORE its first use, and is never reassigned or bound any
//     other way (Set-/New-Variable, foreach, param, [ref], -OutVariable and friends);
//   - no path uses a scoped or environment variable (`$env:`, `$script:`, ...), an automatic one,
//     `~`, `%VAR%`, a wildcard, a UNC prefix, a driveless root or a URL;
//   - every path, with its variables substituted, resolves inside the sandbox;
//   - at least one variable path, read the way the CLI reads it (the variable dropped, the rest
//     resolved against the session directory), escapes the sandbox -- what explains the denial.
const VAR_REF_RE = /\$(?:\{([^}]+)\}|([A-Za-z_][\w]*(?::[A-Za-z_][\w]*)?))/g;
const BINDING_RE = /\b(?:set-variable|new-variable|clear-variable|remove-variable|sv|nv)\b|\bparam\s*\(|\[ref\]|-(?:outvariable|ov|errorvariable|ev|pipelinevariable|pv|warningvariable|wv|informationvariable|iv)\b/i;

export function classifyVarRelative(command, sandboxRoot) {
  const no = (reason) => ({ expected: false, reason });
  if (!sandboxRoot) return no('no sandbox root to resolve against');
  if ([...command.matchAll(LOCATION_RE)].length) return no('command changes location');
  if (/\b[a-z][a-z0-9+.-]*:\/\//i.test(command)) return no('command names a URL');
  const tokens = command.split(/[\s"'`;|&(),=]+/).filter((t) => /[\\/]/.test(t));
  const varTokens = tokens.filter((t) => t.includes('$'));
  if (!varTokens.length) return no('no path uses a variable');
  if (BINDING_RE.test(command)) return no('command binds a variable some other way');
  const values = new Map();
  for (const t of varTokens) {
    for (const m of t.matchAll(VAR_REF_RE)) {
      const name = (m[1] ?? m[2]).toLowerCase();
      if (values.has(name)) continue;
      if (name.includes(':')) return no(`path ${t} uses the scoped or environment variable $${name}`);
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const assigns = [...command.matchAll(new RegExp(`\\$(?:\\{${esc}\\}|${esc}(?![\\w:]))\\s*(?:[-+*/%]|\\?\\?)?=(?!=)`, 'gi'))];
      if (assigns.length !== 1) return no(assigns.length ? `$${name} is assigned more than once` : `$${name} is never assigned in the command`);
      if (new RegExp(`\\bforeach\\s*\\(\\s*\\$${esc}\\b`, 'i').test(command)) return no(`$${name} is a loop variable`);
      const lit = new RegExp(`\\$(?:\\{${esc}\\}|${esc})\\s*=\\s*(?:"([^"\`$%]*)"|'([^']*)')`, 'i').exec(command.slice(assigns[0].index));
      if (!lit) return no(`$${name} is not assigned a quoted literal`);
      const value = lit[1] ?? lit[2];
      if (!/^[a-z]:[\\/]/i.test(value) || /[~*?%]/.test(value)) return no(`$${name} is not a literal absolute path`);
      if (!inside(value, sandboxRoot)) return no(`$${name} is assigned a path outside the sandbox`);
      const firstUse = command.search(new RegExp(`\\$(?:\\{${esc}\\}|${esc})(?![\\w:])(?!\\s*=(?!=))`, 'i'));
      if (firstUse >= 0 && firstUse < assigns[0].index) return no(`$${name} is used before it is assigned`);
      values.set(name, value);
    }
  }
  let explains = false;
  for (const t of tokens) {
    const sub = t.replace(VAR_REF_RE, (m, a, b) => values.get((a ?? b).toLowerCase()) ?? m);
    if (/[$%~*?<>]/.test(sub) || sub.startsWith('\\\\')) return no(`path ${t} cannot be resolved here`);
    const abs = /^[a-z]:[\\/]/i.test(sub);
    if (!abs && /^[\\/]/.test(sub)) return no(`path ${t} is rooted without a drive`);
    if (!abs && /^[a-z]:/i.test(sub)) return no(`path ${t} is drive-relative`);
    const resolved = abs ? path.win32.normalize(sub) : path.win32.resolve(sandboxRoot, sub);
    if (!inside(resolved, sandboxRoot)) return no(`path ${t} resolves outside the sandbox`);
    if (t.includes('$')) {
      const asCli = t.replace(VAR_REF_RE, '').replace(/^[\\/]+/, '');
      if (asCli && !inside(path.win32.resolve(sandboxRoot, asCli), sandboxRoot)) explains = true;
    }
  }
  if (!explains) return no('no variable path escapes the session directory, so path verification does not explain the denial');
  return { expected: true, reason: 'in-sandbox path through a variable assigned a literal in-sandbox path in the same command, which the CLI cannot expand' };
}

// `shell(git push)` -> matches a command containing `git push`; `web_fetch` -> the tool name.
export function denyRuleHit(name, command, denyRules) {
  for (const rule of denyRules || []) {
    const m = /^shell\((.+)\)$/i.exec(rule);
    if (m) {
      const words = m[1].trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      if (new RegExp(`(?:^|[^\\w-])${words.join('\\s+')}(?![\\w-])`, 'i').test(command || '')) return rule;
    } else if (String(name).toLowerCase() === rule.toLowerCase()) {
      return rule;
    }
  }
  return null;
}

// Returns { expected: boolean, reason: string }.
export function classifyDenial(call, { sandboxRoot, denyRules = [] } = {}) {
  const no = (reason) => ({ expected: false, reason });
  if (call.name !== 'powershell') return no(`tool ${call.name} is not powershell`);
  if (call.errorCode !== 'denied') return no(`error code ${call.errorCode ?? 'none'} is not "denied"`);
  if (call.errorCategory !== 'permission_denied') return no(`shell error category ${call.errorCategory ?? 'none'} is not "permission_denied"`);
  const command = typeof call.args?.command === 'string' ? call.args.command : '';
  if (!command) return no('no command');
  const rule = denyRuleHit(call.name, command, denyRules);
  if (rule) return no(`command matches deny rule ${rule}`);
  const lower = command.toLowerCase();
  // The variable-relative rule re-resolves EVERY path and excuses only a fully in-sandbox command
  // through variables assigned literal in-sandbox paths (#822). It is tried whenever the hygiene rule
  // does not excuse the call -- including when the command merely NAMES a hygiene script
  // (`Test-Path "$skill\..\..\checks\auto-deploy-plugin.ps1"` beside `Get-ChildItem "$skill\..\.."`,
  // measured on candidate-825). Before, naming the script routed the call to the hygiene rule alone,
  // whose `..` check rejected the in-sandbox probe. The cd-relative rule is deliberately NOT a
  // fallback here: a hygiene call after a `cd` stays judged by the hygiene rule alone.
  const fallback = (why) => {
    const v = classifyVarRelative(command, sandboxRoot);
    return v.expected ? v : no(`${why}, and ${v.reason}`);
  };
  if (!HYGIENE_SCRIPTS.some((s) => lower.includes(s))) {
    const cd = classifyCdRelative(command, sandboxRoot);
    if (cd.expected) return cd;
    const v = classifyVarRelative(command, sandboxRoot);
    return v.expected ? v : no(`command names no PHASE 0 hygiene script, ${cd.reason}, and ${v.reason}`);
  }
  let masked = norm(command);
  if (sandboxRoot) {
    const root = norm(sandboxRoot).replace(/\\+$/, '');
    masked = masked.split(root).join('<sandbox>');
  }
  if (absolutePath.test(masked)) return fallback('command names an absolute path outside the sandbox');
  const rest = masked.replace(hygienePath, '<hygiene>');
  if (dotdotSegment.test(rest)) return fallback('command has a ".." path that is not a PHASE 0 hygiene script');
  return { expected: true, reason: 'PHASE 0 hygiene script refused by path verification' };
}
