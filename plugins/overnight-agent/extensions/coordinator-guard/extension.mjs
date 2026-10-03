import { join } from 'node:path';
import { joinSession } from '@github/copilot-sdk/extension';
import {
  appendGuardRecord, decideToolUse, readLedger,
} from './guard-policy.mjs';

// Coordinator-only pre-tool policy. While this session has a coordinatorRun ledger entry, the
// hook enforces the run cutoff, one send per target session, and the #804 authorship boundary:
// file-write tools may not target the planner folder. Task work must be dispatched to the bound
// task session, and planner journals/state are written only through write-turn/oa-state. Shell
// commands that write planner files remain a residual gap; the hook cannot parse them reliably.

// OVERNIGHT_AGENT_HOME is the e2e sandbox's override (tests/e2e); unset, the path is unchanged.
const ledger = process.env.OVERNIGHT_AGENT_HOME
  ? join(process.env.OVERNIGHT_AGENT_HOME, 'run-ledger.jsonl')
  : join(process.env.LOCALAPPDATA ?? process.env.HOME ?? '.', 'overnight-agent', 'run-ledger.jsonl');

await joinSession({
  tools: [],
  hooks: {
    onPreToolUse: async (input, invocation) => {
      const verdict = decideToolUse({
        entries: readLedger(ledger),
        sessionId: invocation.sessionId,
        toolName: input.toolName,
        toolArgs: input.toolArgs,
        now: input.timestamp,
      });
      if (!verdict.active) return;
      appendGuardRecord(ledger, verdict.record);
      if (verdict.decision === 'deny') {
        return { permissionDecision: 'deny', permissionDecisionReason: verdict.reason };
      }
    },
  },
});
