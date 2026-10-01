// critical-tools.mjs -- Cmd-CriticalTools: the MCP servers PHASE 0 must find, from the
// `Critical tools` settings row (default: email, google-workspace). Takes NO state lock (#778).
import { readAllText, testPath, getContentRaw } from '../core/fsx.mjs';
import { fromJson } from '../core/psjson.mjs';
import { netTrim, lowerInvariant } from '../core/net.mjs';
import { getSettingRow } from '../collect/settings.mjs';

export function cmdCriticalTools(ctx) {
  let names = ['email', 'google-workspace'];
  const settingsPath = ctx.userSettingsPath();
  if (settingsPath && testPath(settingsPath)) {
    const row = getSettingRow(getContentRaw(settingsPath), 'Critical tools');
    if (row !== null) {
      names = row.split(',').map((x) => netTrim(x));
      if (!names.length || names.some((x) => !x)) throw new Error('Critical tools: empty tool name refused');
    }
  }
  const mcp = ctx.p.McpConfig;
  if (!testPath(mcp)) throw new Error(`Cannot find path '${mcp}' because it does not exist.`);
  const config = fromJson(readAllText(mcp));
  const servers = config && typeof config === 'object' ? config.mcpServers : null;
  const configured = servers && typeof servers === 'object' && !Array.isArray(servers) ? Object.keys(servers) : [];
  for (const name of names) {
    if (!configured.some((c) => lowerInvariant(c) === lowerInvariant(name))) throw new Error(`Critical tools: unknown MCP server '${name}' in ${mcp}`);
  }
  ctx.emitJson({ tools: [...new Set(names)], settingsPath }, { depth: 3 });
}
