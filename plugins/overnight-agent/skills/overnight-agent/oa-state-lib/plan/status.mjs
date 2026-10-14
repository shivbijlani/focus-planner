// status.mjs -- the task-status vocabularies every reader shares (oa-state.ps1 #223 / #170 / #540 /
// #593). Defined once so a status added to one list cannot silently fall out of another.
import { toInt } from '../core/net.mjs';

// Statuses that are NOT workable without new input (`awaiting_reply` is a state, handled apart).
export const NonWorkableStatus = ['done', 'skip', 'proposed', 'blocked'];
// #170: CLOSED statuses -- a reply on one is seen, never a reopen.
export const ClosedStatus = ['done', 'skip'];
// #540: waiting-on-the-user statuses: NonWorkableStatus minus ClosedStatus.
export const PausedStatus = NonWorkableStatus.filter((s) => !ClosedStatus.some((c) => c.toLowerCase() === s.toLowerCase()));
// #593: how long a `doc -Observe` stays evidence that a channel is quiet (minutes).
export const DocObservationFreshMinutes = process.env.OA_DOC_FRESH_MINUTES ? toInt(process.env.OA_DOC_FRESH_MINUTES) : 180;
