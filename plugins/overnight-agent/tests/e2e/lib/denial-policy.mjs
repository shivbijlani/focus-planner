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

export const HYGIENE_SCRIPTS = ['auto-deploy-plugin.ps1', 'split-user-settings.ps1'];

const hygieneAlt = HYGIENE_SCRIPTS.map((s) => s.replace(/[.]/g, '\\.')).join('|');
// `..\..\checks\x.ps1`, `$skill\..\..\checks\x.ps1`, `"$skill\..\..\checks\x.ps1"`, `/` or `\`:
// exactly the skill dir's two levels up, and nothing may follow the script name.
const hygienePath = new RegExp(`(?:\\$[A-Za-z_][\\w:]*|\\$\\{[^}]+\\})?(?:^|(?<=[\\s"'\`(=])|[\\\\/])(?:\\.\\.[\\\\/]){2}checks[\\\\/](?:${hygieneAlt})(?![\\w.-])`, 'gim');
const dotdotSegment = /(?:^|[\\/\s"'`(=])\.\.(?:[\\/]|$|[\s"'`)])/;
const absolutePath = /(?:^|[\s"'`(=;,])(?:[a-z]:[\\/]|\\\\[^\\\s]+\\|~[\\/])/i;

const norm = (s) => String(s).replace(/\//g, '\\').toLowerCase();

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
  if (!HYGIENE_SCRIPTS.some((s) => lower.includes(s))) return no('command names no PHASE 0 hygiene script');
  let masked = norm(command);
  if (sandboxRoot) {
    const root = norm(sandboxRoot).replace(/\\+$/, '');
    masked = masked.split(root).join('<sandbox>');
  }
  if (absolutePath.test(masked)) return no('command names an absolute path outside the sandbox');
  const rest = masked.replace(hygienePath, '<hygiene>');
  if (dotdotSegment.test(rest)) return no('command has a ".." path that is not a PHASE 0 hygiene script');
  return { expected: true, reason: 'PHASE 0 hygiene script refused by path verification' };
}
