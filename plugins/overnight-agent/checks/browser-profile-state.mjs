/*
 * browser-profile-state.mjs -- per-task browser window state (GH #738).
 *
 * GH #738 replaced attach-only CDP slots with each Playwright MCP server
 * launching its own profile directly. Two things follow from that:
 *
 *   1. A profile can have only ONE owner at a time (proven 2026-09-28, test
 *      session 905cc615: launching an already-open profile fails with
 *      "Opening in existing browser session... profile is already in use").
 *      A task session must recognize that failure and STOP for this run --
 *      never retry-loop, and never fall back to a different profile, which
 *      settings rule 1 calls worse than failing.
 *   2. A relaunch restores NO previous tabs (no CDP session to reattach to,
 *      no saved window). So a task that wants its browser work to survive
 *      across runs must save the URLs it was working on itself, and reopen
 *      them in a fresh window on its next run. Real tab groups are
 *      extension-only (GH #383) and out of scope here.
 *
 * This file is the two small, pure/testable pieces of that: recognizing a
 * "profile in use" failure from whatever text the MCP surfaces, and reading
 * back/writing per-task window state as JSON. It does not launch, attach to,
 * or drive a browser -- that is the agent's job, using this as a helper.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Where one task's saved browser-window state lives. */
export function taskWindowStatePath(taskId, { home = process.env.LOCALAPPDATA &&
  join(process.env.LOCALAPPDATA, 'overnight-agent') } = {}) {
  if (!home) throw new Error('LOCALAPPDATA is required for the browser-window state home');
  if (!taskId || !String(taskId).trim()) throw new Error('taskId is required');
  const safe = String(taskId).trim().replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(home, 'browser-windows', `${safe}.json`);
}

/**
 * Recognize the "profile is already in use" failure Playwright MCP surfaces
 * (proven 2026-09-28, test session 905cc615: "Opening in existing browser
 * session... profile is already in use"). Pure text classification -- never
 * touches a process or a lock file itself, so it works on whatever error
 * string a caller already has in hand (an MCP tool error, or a launch
 * subprocess's stderr).
 *
 * Deliberately NARROW: it only recognizes the specific phrasing this failure
 * mode uses, so an unrelated launch failure (missing binary, bad profile
 * path, permission denied) is never misreported as "in use" and silently
 * retried or ignored -- that would be the fallback-to-a-guess mistake
 * settings rule 1 forbids, just moved into the classifier instead of the
 * launcher.
 */
export function classifyBrowserLaunchError(message) {
  const text = String(message ?? '');
  const inUse = /profile is already in use/i.test(text) ||
    /opening in existing browser session/i.test(text) ||
    /(?:browser|browsertype\.launchpersistentcontext).*already in use/i.test(text);
  if (inUse) {
    return {
      inUse: true,
      reason: 'profile-in-use',
      // The one required behaviour: STOP this run, never retry, never fall
      // back to a different profile/slot.
      action: 'stop-run',
      detail: 'profile in use (you, or another task) - stopping for this run',
    };
  }
  return { inUse: false, reason: 'other', action: null, detail: text.trim().slice(0, 300) || null };
}

const EMPTY_STATE = Object.freeze({ windows: [] });

async function readJsonFile(path) {
  try {
    return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeJsonFileAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temp, path);
}

/**
 * Read back the URLs a task saved last time it did browser work. Returns
 * `{ windows: [] }` (never throws) when nothing has been saved yet -- a task
 * that has never opened a browser is not an error, just a blank slate.
 */
export async function loadTaskWindowState(taskId, options = {}) {
  const path = taskWindowStatePath(taskId, options);
  const parsed = await readJsonFile(path);
  if (!parsed || !Array.isArray(parsed.windows)) return { ...EMPTY_STATE };
  return {
    windows: parsed.windows
      .filter(w => w && typeof w.slot === 'string' && Array.isArray(w.urls))
      .map(w => ({ slot: w.slot, urls: w.urls.filter(u => typeof u === 'string' && u), savedAt: w.savedAt ?? null })),
  };
}

/**
 * Save the URLs a task's browser window is open to, keyed by slot, so the
 * NEXT run can reopen them in a fresh window (GH #738: a relaunch restores no
 * tabs on its own). Call this at the end of a task's turn, once per slot the
 * task actually used -- an empty `urls` array clears that slot's saved
 * window rather than leaving a stale one.
 */
export async function saveTaskWindowState(taskId, slot, urls, options = {}) {
  if (!slot || !String(slot).trim()) throw new Error('slot is required');
  const path = taskWindowStatePath(taskId, options);
  const clock = options.clock ?? { now: () => Date.now() };
  const current = await loadTaskWindowState(taskId, options);
  const cleanUrls = Array.isArray(urls) ? urls.filter(u => typeof u === 'string' && u) : [];
  const entry = { slot, urls: cleanUrls, savedAt: new Date(clock.now()).toISOString() };
  const windows = current.windows.filter(w => w.slot !== slot);
  if (cleanUrls.length > 0) windows.push(entry);
  const next = { windows };
  await writeJsonFileAtomic(path, next);
  return next;
}

/** The saved URLs for one slot, or `[]` if the task never saved any for it. */
export async function loadTaskWindowUrls(taskId, slot, options = {}) {
  const state = await loadTaskWindowState(taskId, options);
  return state.windows.find(w => w.slot === slot)?.urls ?? [];
}
