// Same exclusive-file/PID protocol as the consumer agent lock; no plugin dependency.
import fs from 'node:fs'
import process from 'node:process'

function holderAlive(lockPath) {
  let pid
  try { pid = Number(fs.readFileSync(lockPath, 'utf8').trim()) }
  catch { return true }
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return true
  try { process.kill(pid, 0); return true }
  catch (error) { return error.code !== 'ESRCH' }
}

export function acquireLock(lockPath, timeoutMs, { timeoutMessage, reclaimDeadHolder = false } = {}) {
  const deadline = Date.now() + Math.max(1000, timeoutMs)
  for (;;) {
    let fd
    try {
      fd = fs.openSync(lockPath, 'wx')
      fs.writeSync(fd, String(process.pid))
      return { lockPath, fd }
    } catch (error) {
      if (fd !== undefined) {
        fs.closeSync(fd)
        fs.unlinkSync(lockPath)
        throw error
      }
      if (!['EEXIST', 'EPERM', 'EBUSY'].includes(error.code)) throw error
      if (reclaimDeadHolder && !holderAlive(lockPath)) {
        try { fs.unlinkSync(lockPath); continue }
        catch (removeError) { if (removeError.code !== 'ENOENT') throw removeError }
      }
      if (Date.now() >= deadline) throw new Error(timeoutMessage)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
  }
}

export function releaseLock({ fd, lockPath }) {
  try { fs.closeSync(fd) }
  finally { fs.unlinkSync(lockPath) }
}
