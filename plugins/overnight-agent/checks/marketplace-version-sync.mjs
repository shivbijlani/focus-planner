#!/usr/bin/env node
/**
 * marketplace-version-sync.mjs -- the catalog entry must match plugin.json (GH #707).
 *
 * `.github/plugin/marketplace.json` carries its own `version` for overnight-agent. It sat at
 * 1.1.0 from #87 while plugin.json climbed past 1.55.0, because nothing compared the two.
 * The version-bump gate only forces plugin.json to move; this makes the catalog move with it.
 *
 * Deterministic: reads the two files in the working tree, no git, no network.
 * Exit 0 when equal, 1 on drift or when either version cannot be read.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_NAME = 'overnight-agent';
export const MARKETPLACE_JSON = '.github/plugin/marketplace.json';
export const PLUGIN_JSON = 'plugins/overnight-agent/plugin.json';

/** Pure comparison. Takes raw file text so tests need no filesystem. */
export function checkMarketplaceSync(marketplaceText, pluginText) {
  let marketplace;
  let plugin;
  try {
    marketplace = JSON.parse(marketplaceText);
  } catch (err) {
    return { ok: false, reason: `${MARKETPLACE_JSON} is not valid JSON: ${err.message}` };
  }
  try {
    plugin = JSON.parse(pluginText);
  } catch (err) {
    return { ok: false, reason: `${PLUGIN_JSON} is not valid JSON: ${err.message}` };
  }
  const pluginVersion = typeof plugin?.version === 'string' ? plugin.version : null;
  if (!pluginVersion) return { ok: false, reason: `${PLUGIN_JSON} has no string "version"` };

  const entries = Array.isArray(marketplace?.plugins) ? marketplace.plugins : [];
  const entry = entries.find((p) => p?.name === PLUGIN_NAME);
  if (!entry) return { ok: false, pluginVersion, reason: `${MARKETPLACE_JSON} has no "${PLUGIN_NAME}" entry` };
  const catalogVersion = typeof entry.version === 'string' ? entry.version : null;
  if (!catalogVersion) {
    return { ok: false, pluginVersion, reason: `${MARKETPLACE_JSON} "${PLUGIN_NAME}" entry has no string "version"` };
  }
  if (catalogVersion !== pluginVersion) {
    return {
      ok: false, pluginVersion, catalogVersion,
      reason: `${MARKETPLACE_JSON} lists ${PLUGIN_NAME} ${catalogVersion} but ${PLUGIN_JSON} is ${pluginVersion}`,
    };
  }
  return { ok: true, pluginVersion, catalogVersion };
}

function repoRoot() {
  if (process.env.OA_PLUGIN_REPO) return process.env.OA_PLUGIN_REPO;
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

function main() {
  const root = repoRoot();
  let marketplaceText;
  let pluginText;
  try {
    marketplaceText = fs.readFileSync(path.join(root, MARKETPLACE_JSON), 'utf8');
    pluginText = fs.readFileSync(path.join(root, PLUGIN_JSON), 'utf8');
  } catch (err) {
    console.log(`marketplace-version-sync: CANNOT MEASURE - ${err.message}`);
    process.exit(1);
  }
  const result = checkMarketplaceSync(marketplaceText, pluginText);
  if (result.ok) {
    console.log(`OK - ${MARKETPLACE_JSON} and ${PLUGIN_JSON} both list ${PLUGIN_NAME} ${result.pluginVersion}.`);
    process.exit(0);
  }
  console.log(`FLAGGED - ${result.reason}.`);
  console.log('');
  console.log('  Installed users compare against the catalog version, so a stale catalog entry');
  console.log('  hides every update from them.');
  console.log(`  Fix: when you bump "version" in ${PLUGIN_JSON}, set the "${PLUGIN_NAME}" entry's`);
  console.log(`  "version" in ${MARKETPLACE_JSON} to the same value in the same commit.`);
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
