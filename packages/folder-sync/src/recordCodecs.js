import { mdTableCodec } from './codecs/mdTable.js'

// Shared by the page and worker: both must stamp and merge the same files.
export const RECORD_CODECS = {
  'planner.md': mdTableCodec,
  'planner-completed.md': mdTableCodec,
  'focus-plan.md': mdTableCodec,
  'focus-plan-completed.md': mdTableCodec,
}
