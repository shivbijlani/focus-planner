// Keep the deadline attached to the response body too, not just its headers.
// A stalled cloud request must fail visibly rather than hold the sync lane forever.
export function fetchWithTimeout(input, init = {}) {
  const deadline = AbortSignal.timeout(30_000)
  const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline
  return globalThis.fetch(input, { ...init, signal })
}
