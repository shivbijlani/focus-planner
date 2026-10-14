import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyBrowserLaunchError, loadTaskWindowState, loadTaskWindowUrls,
  saveTaskWindowState, taskWindowStatePath,
} from './browser-profile-state.mjs';

async function home(t) {
  const dir = await mkdtemp(join(tmpdir(), 'oa-browser-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('taskWindowStatePath requires a taskId and a home, and sanitizes the filename', async t => {
  const home1 = await home(t);
  assert.equal(taskWindowStatePath('task-42', { home: home1 }), join(home1, 'browser-windows', 'task-42.json'));
  assert.equal(taskWindowStatePath('weird/task:42', { home: home1 }), join(home1, 'browser-windows', 'weird_task_42.json'));
  assert.throws(() => taskWindowStatePath('', { home: home1 }), /taskId is required/);
  assert.throws(() => taskWindowStatePath('t', { home: null }), /LOCALAPPDATA is required/);
});

test('classifyBrowserLaunchError recognizes the proven "profile is already in use" failure', () => {
  const proven = classifyBrowserLaunchError(
    "Error: Opening in existing browser session, browser is already in use for edge-cdp-1, profile is already in use");
  assert.equal(proven.inUse, true);
  assert.equal(proven.reason, 'profile-in-use');
  assert.equal(proven.action, 'stop-run');

  const alsoRecognized = classifyBrowserLaunchError('BrowserType.launchPersistentContext: profile already in use');
  assert.equal(alsoRecognized.inUse, true);
});

test('classifyBrowserLaunchError never misreports an unrelated failure as "in use"', () => {
  for (const msg of [
    'spawn ENOENT: msedge.exe not found',
    'Permission denied opening user-data-dir',
    'Target closed',
    '',
    undefined,
  ]) {
    const result = classifyBrowserLaunchError(msg);
    assert.equal(result.inUse, false, `misclassified: ${msg}`);
    assert.equal(result.action, null, `unexpected stop-run action for: ${msg}`);
  }
});

test('a task with no saved window state gets an empty, never-throwing result', async t => {
  const dir = await home(t);
  const state = await loadTaskWindowState('task-1', { home: dir });
  assert.deepEqual(state, { windows: [] });
  const urls = await loadTaskWindowUrls('task-1', 'edge-cdp-1', { home: dir });
  assert.deepEqual(urls, []);
});

test('saving and reloading a task window round-trips the URLs, keyed by slot', async t => {
  const dir = await home(t);
  const clock = { now: () => Date.parse('2026-09-28T20:00:00.000Z') };
  await saveTaskWindowState('task-2', 'edge-cdp-1', ['https://example.com/a', 'https://example.com/b'], { home: dir, clock });

  const state = await loadTaskWindowState('task-2', { home: dir });
  assert.equal(state.windows.length, 1);
  assert.equal(state.windows[0].slot, 'edge-cdp-1');
  assert.deepEqual(state.windows[0].urls, ['https://example.com/a', 'https://example.com/b']);
  assert.equal(state.windows[0].savedAt, '2026-09-28T20:00:00.000Z');

  const urls = await loadTaskWindowUrls('task-2', 'edge-cdp-1', { home: dir });
  assert.deepEqual(urls, ['https://example.com/a', 'https://example.com/b']);
});

test('saving a second slot for the same task keeps both, independently', async t => {
  const dir = await home(t);
  await saveTaskWindowState('task-3', 'edge-cdp-1', ['https://a.example'], { home: dir });
  await saveTaskWindowState('task-3', 'edge-cdp-bijlanis', ['https://b.example'], { home: dir });
  const state = await loadTaskWindowState('task-3', { home: dir });
  assert.equal(state.windows.length, 2);
  assert.deepEqual((await loadTaskWindowUrls('task-3', 'edge-cdp-1', { home: dir })), ['https://a.example']);
  assert.deepEqual((await loadTaskWindowUrls('task-3', 'edge-cdp-bijlanis', { home: dir })), ['https://b.example']);
});

test('saving an empty URL list for a slot clears that slot rather than leaving a stale window', async t => {
  const dir = await home(t);
  await saveTaskWindowState('task-4', 'edge-cdp-1', ['https://a.example'], { home: dir });
  await saveTaskWindowState('task-4', 'edge-cdp-1', [], { home: dir });
  const state = await loadTaskWindowState('task-4', { home: dir });
  assert.deepEqual(state.windows, []);
});

test('re-saving the same slot replaces its URLs rather than accumulating them', async t => {
  const dir = await home(t);
  await saveTaskWindowState('task-5', 'edge-cdp-1', ['https://old.example'], { home: dir });
  await saveTaskWindowState('task-5', 'edge-cdp-1', ['https://new.example'], { home: dir });
  const urls = await loadTaskWindowUrls('task-5', 'edge-cdp-1', { home: dir });
  assert.deepEqual(urls, ['https://new.example']);
});

test('a corrupt or non-object state file is treated as empty, never thrown', async t => {
  const dir = await home(t);
  const path = taskWindowStatePath('task-6', { home: dir });
  await import('node:fs/promises').then(fs => fs.mkdir(join(dir, 'browser-windows'), { recursive: true }));
  await import('node:fs/promises').then(fs => fs.writeFile(path, 'not json', 'utf8'));
  await assert.rejects(() => loadTaskWindowState('task-6', { home: dir }));

  const path2 = taskWindowStatePath('task-7', { home: dir });
  await import('node:fs/promises').then(fs => fs.writeFile(path2, JSON.stringify({ windows: 'nope' }), 'utf8'));
  const state = await loadTaskWindowState('task-7', { home: dir });
  assert.deepEqual(state, { windows: [] });
});

test('saveTaskWindowState requires a slot', async t => {
  const dir = await home(t);
  await assert.rejects(() => saveTaskWindowState('task-8', '', ['x'], { home: dir }), /slot is required/);
});
