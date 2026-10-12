import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assertSandboxPath } from '../core/context.mjs';

export function docsPublisherPath() {
  const configured = process.env.FOCUS_PLANNER_REPO;
  const candidates = configured ? [configured] : [process.cwd(), path.dirname(fileURLToPath(import.meta.url))];
  for (let directory of candidates) {
    for (;;) {
      const entry = path.join(directory, 'packages', 'docs-publisher', 'bin', 'fp-docs.js');
      if (fs.existsSync(entry)) {
        assertSandboxPath(entry, 'Docs publisher');
        return entry;
      }
      if (configured) break;
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  throw new Error('docs_publisher_missing: set FOCUS_PLANNER_REPO to the matching Focus Planner repository containing packages/docs-publisher');
}

export function nativeDocsStatus(root, task) {
  assertSandboxPath(root, 'Docs planner root');
  try { fs.statSync(path.join(root, 'docs', 'index.json')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const result = spawnSync(process.execPath, [docsPublisherPath(), 'status', '--task', String(task), '--json'], {
    env: { ...process.env, PLANNER_PATH: root }, encoding: 'utf8', timeout: 30000,
    maxBuffer: 4 * 1024 * 1024, windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`docs_read_failed: task ${task}: ${result.error?.message || result.stderr.trim() || `publisher exited ${result.status}`}`);
  }
  const status = JSON.parse(result.stdout);
  if (status.task !== Number(task) || !Array.isArray(status.docs) || status.enabled !== true) {
    throw new Error(`docs_read_failed: task ${task}: invalid publisher status`);
  }
  return status;
}
