// Validation for the NON-secret `mcp-secrets.json` pointer file.
//
// The pointer file lives on each machine in the web app's OneDrive working
// folder (NOT in the repo, NOT in Credential Manager). It lists which secrets a
// machine needs — the credential target, the env var it feeds, and which MCP
// server + real command consumes it — plus non-secret public ids. It NEVER
// contains secret values; the values live in Windows Credential Manager.
//
// See mcp-secrets.example.json for the shape and README.md for the rationale.

/**
 * @typedef {Object} McpSecretEntry
 * @property {string} server   MCP server key in mcp-config.json's mcpServers.
 * @property {string} target   Windows Credential Manager target name.
 * @property {string} envVar   Env var the launcher injects the secret into.
 * @property {string} command  The real MCP executable the launcher execs.
 * @property {string[]} [args] Args passed to the real MCP executable.
 */

/**
 * @typedef {Object} McpSecrets
 * @property {number} version
 * @property {McpSecretEntry[]} secrets
 * @property {Record<string,string>} [ids] Non-secret public identifiers.
 */

const CRED_TARGET_RE = /^[^\r\n\t]+$/;

/**
 * Validate a parsed pointer-file object. Returns a list of human-readable
 * problems; an empty list means the object is valid.
 * @param {unknown} obj
 * @returns {string[]}
 */
export function collectMcpSecretsErrors(obj) {
  const errors = [];
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return ['root must be an object'];
  }
  const o = /** @type {Record<string, unknown>} */ (obj);

  if (typeof o.version !== 'number' || !Number.isInteger(o.version) || o.version < 1) {
    errors.push('version must be a positive integer');
  }

  if (!Array.isArray(o.secrets)) {
    errors.push('secrets must be an array');
  } else {
    const seenTargets = new Set();
    const seenServers = new Set();
    o.secrets.forEach((entry, i) => {
      const where = `secrets[${i}]`;
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        errors.push(`${where} must be an object`);
        return;
      }
      const e = /** @type {Record<string, unknown>} */ (entry);
      for (const key of ['server', 'target', 'envVar', 'command']) {
        if (typeof e[key] !== 'string' || e[key].trim() === '') {
          errors.push(`${where}.${key} must be a non-empty string`);
        }
      }
      if (typeof e.target === 'string' && !CRED_TARGET_RE.test(e.target)) {
        errors.push(`${where}.target must not contain tabs or newlines`);
      }
      if (typeof e.envVar === 'string' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(e.envVar)) {
        errors.push(`${where}.envVar must be a valid environment variable name`);
      }
      if (e.args !== undefined) {
        if (!Array.isArray(e.args) || e.args.some((a) => typeof a !== 'string')) {
          errors.push(`${where}.args must be an array of strings`);
        }
      }
      if (typeof e.server === 'string') {
        if (seenServers.has(e.server)) errors.push(`${where}.server is duplicated: ${e.server}`);
        seenServers.add(e.server);
      }
      if (typeof e.target === 'string') {
        if (seenTargets.has(e.target)) errors.push(`${where}.target is duplicated: ${e.target}`);
        seenTargets.add(e.target);
      }
    });
  }

  if (o.ids !== undefined) {
    if (o.ids === null || typeof o.ids !== 'object' || Array.isArray(o.ids)) {
      errors.push('ids must be an object when present');
    } else {
      for (const [k, v] of Object.entries(o.ids)) {
        if (typeof v !== 'string') errors.push(`ids.${k} must be a string`);
      }
    }
  }

  return errors;
}

/**
 * @param {unknown} obj
 * @returns {obj is McpSecrets}
 */
export function isValidMcpSecrets(obj) {
  return collectMcpSecretsErrors(obj).length === 0;
}

/**
 * Parse and validate pointer-file JSON text. Throws on invalid JSON or shape.
 * @param {string} text
 * @returns {McpSecrets}
 */
export function parseMcpSecrets(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    throw new Error(`mcp-secrets.json is not valid JSON: ${err.message}`);
  }
  const errors = collectMcpSecretsErrors(obj);
  if (errors.length > 0) {
    throw new Error(`mcp-secrets.json is invalid:\n- ${errors.join('\n- ')}`);
  }
  return /** @type {McpSecrets} */ (obj);
}
