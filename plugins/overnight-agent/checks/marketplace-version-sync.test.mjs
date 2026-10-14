import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkMarketplaceSync, MARKETPLACE_JSON, PLUGIN_JSON } from './marketplace-version-sync.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'marketplace-version-sync.mjs');
const root = join(here, '..', '..', '..');
const realMarketplace = readFileSync(join(root, MARKETPLACE_JSON), 'utf8');
const realPlugin = readFileSync(join(root, PLUGIN_JSON), 'utf8');

const catalog = (version, name = 'overnight-agent') =>
  JSON.stringify({ plugins: [{ name: 'other', version: '9.9.9' }, { name, ...(version ? { version } : {}) }] });
const plugin = (version) => JSON.stringify({ name: 'overnight-agent', version });

test('the repo as committed is in sync', () => {
  const r = checkMarketplaceSync(realMarketplace, realPlugin);
  assert.equal(r.ok, true, r.reason);
});

test('plugin.json declares no extensions and the plugin ships no extension directory', () => {
  const manifest = JSON.parse(realPlugin);
  assert.equal(Object.hasOwn(manifest, 'extensions'), false);
  assert.equal(existsSync(join(root, 'plugins', 'overnight-agent', 'extensions')), false);
});

test('equal versions pass', () => {
  assert.equal(checkMarketplaceSync(catalog('1.2.3'), plugin('1.2.3')).ok, true);
});

test('drift is caught in either direction', () => {
  const behind = checkMarketplaceSync(catalog('1.1.0'), plugin('1.56.0'));
  assert.equal(behind.ok, false);
  assert.match(behind.reason, /1\.1\.0.*1\.56\.0/);
  assert.equal(checkMarketplaceSync(catalog('2.0.0'), plugin('1.56.0')).ok, false);
});

test('a missing entry, missing version or bad JSON is a failure, not a pass', () => {
  assert.equal(checkMarketplaceSync(catalog('1.0.0', 'renamed'), plugin('1.0.0')).ok, false);
  assert.equal(checkMarketplaceSync(catalog(null), plugin('1.0.0')).ok, false);
  assert.equal(checkMarketplaceSync('{', plugin('1.0.0')).ok, false);
  assert.equal(checkMarketplaceSync(catalog('1.0.0'), '{}').ok, false);
});

test('mutation: the CLI exits 1 on a drifted tree and 0 on a synced one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mvs-'));
  try {
    mkdirSync(join(dir, dirname(MARKETPLACE_JSON)), { recursive: true });
    mkdirSync(join(dir, dirname(PLUGIN_JSON)), { recursive: true });
    const version = JSON.parse(realPlugin).version;
    writeFileSync(join(dir, PLUGIN_JSON), realPlugin);
    const run = () => spawnSync(process.execPath, [script], { env: { ...process.env, OA_PLUGIN_REPO: dir }, encoding: 'utf8' });

    writeFileSync(join(dir, MARKETPLACE_JSON), realMarketplace);
    assert.equal(run().status, 0);

    const drifted = JSON.parse(realMarketplace);
    drifted.plugins.find((p) => p.name === 'overnight-agent').version = '1.1.0';
    writeFileSync(join(dir, MARKETPLACE_JSON), JSON.stringify(drifted));
    const bad = run();
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /FLAGGED/);
    assert.match(bad.stdout, new RegExp(`1\\.1\\.0 but .* is ${version.replace(/\./g, '\\.')}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
