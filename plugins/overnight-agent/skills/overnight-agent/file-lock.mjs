// A short, file-scoped lock shared by the two runtimes that write the small PHASE 0 files
// (GH #778).
//
// WHY THIS IS NOT THE STATE LOCK. PHASE 0 runs its steps at once by design: `oa-state.ps1 scan`
// alongside the capability record, Google Tasks and the Telegram sync-down. The scan holds the
// state mutex for its whole 60-90 s, so anything else that took that mutex queued behind a
// traversal of a store it never reads -- and with a 10 s fail-fast that surfaced as
// `state_lock_timeout` and cost the model a retry turn. capabilities.json and run-ledger.jsonl
// are small, independent files: they get their OWN lock, held for milliseconds.
//
// WHY A LOCK FILE AND NOT A NAMED MUTEX. The ledger has writers in both runtimes -- PowerShell
// (`oa-state.ps1 decisions`) and Node (this package) -- and Node cannot take a Windows named
// mutex. An exclusive create (`wx` here, `FileMode.CreateNew` there) is the one primitive both
// can agree on, so `<target>.lock` is the shared convention.
import { closeSync, openSync, rmSync, statSync, writeSync } from 'node:fs';

export const DEFAULT_TIMEOUT_MS = 180_000;
// Past this age the lock belongs to a writer that was killed mid-write: no honest hold of a
// file this small lasts minutes. Reclaiming beats wedging the ledger until someone notices.
export const DEFAULT_STALE_MS = 300_000;
const POLL_MS = 50;

// Synchronous sleep, so a caller in the middle of a synchronous read/modify/write does not have
// to become async to wait its turn.
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function acquireFileLock(target, {
  timeoutMs = DEFAULT_TIMEOUT_MS, staleMs = DEFAULT_STALE_MS, now = Date.now, sleep = pause,
} = {}) {
  const lock = `${target}.lock`;
  const deadline = now() + timeoutMs;
  for (;;) {
    try {
      const handle = openSync(lock, 'wx');
      writeSync(handle, String(process.pid));
      return { lock, handle };
    } catch (error) {
      if (error.code !== 'EEXIST') throw new Error(`lock unavailable for ${lock}: ${error.message}`);
      let age = null;
      try { age = now() - statSync(lock).mtimeMs; } catch { age = null; }
      if (age !== null && age > staleMs) {
        rmSync(lock, { force: true });
        continue;
      }
      // WAIT, then fail only once the holder has outlasted every legitimate hold. A timeout here
      // means stuck, not busy -- which is the only case worth reporting to the caller.
      if (now() >= deadline) {
        throw new Error(`lock timeout: waited ${Math.round(timeoutMs / 1000)}s for ${lock}`);
      }
      sleep(POLL_MS);
    }
  }
}

export function releaseFileLock(held) {
  if (!held) return;
  try { closeSync(held.handle); } catch { /* already closed */ }
  rmSync(held.lock, { force: true });
}

export function withFileLock(target, fn, options) {
  const held = acquireFileLock(target, options);
  try { return fn(); } finally { releaseFileLock(held); }
}
