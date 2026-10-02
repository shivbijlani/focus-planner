// lock.mjs -- the two locks oa-state takes, as lock FILES (an exclusive create) because Node
// cannot take a Windows named mutex.
//
//   the state lock   every command that reads/modifies/writes the state store (all but
//                    critical-tools and decisions). Keyed like oa-state.ps1's mutex. A holder that
//                    died is detected by its PID and reclaimed at once (the OS releases a mutex
//                    the same way); otherwise the caller WAITS (#778) up to the lock wait.
//   the ledger lock  `<run-ledger>.lock`, shared with oa-state.ps1 and check-critical-tools.mjs
//                    (file-lock.mjs): reclaimed past the stale age, since its writes take ms.
import fs from 'node:fs';
import path from 'node:path';

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function holderAlive(lockPath) {
  let pid = NaN;
  try { pid = Number(String(fs.readFileSync(lockPath, 'utf8')).trim()); } catch { return true; }
  if (!Number.isInteger(pid) || pid <= 0) return true;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export function acquireLock(lockPath, timeoutMs, { timeoutMessage, staleMs = null, reclaimDeadHolder = false, mkdir = false } = {}) {
  if (mkdir) {
    const dir = path.dirname(lockPath);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, String(process.pid));
      return { lockPath, fd };
    } catch (e) {
      if (e.code !== 'EEXIST' && e.code !== 'EPERM' && e.code !== 'EBUSY') throw e;
      let reclaim = false;
      if (reclaimDeadHolder && !holderAlive(lockPath)) reclaim = true;
      if (!reclaim && staleMs !== null) {
        try { reclaim = Date.now() - fs.statSync(lockPath).mtimeMs > staleMs; } catch { reclaim = false; }
      }
      if (reclaim) {
        try { fs.rmSync(lockPath, { force: true }); continue; } catch { /* raced; wait */ }
      }
      if (Date.now() >= deadline) throw new Error(timeoutMessage);
      pause(50);
    }
  }
}

export function releaseLock(lock) {
  if (!lock) return;
  try { fs.closeSync(lock.fd); } catch { /* already closed */ }
  try { fs.rmSync(lock.lockPath, { force: true }); } catch { /* gone */ }
}
