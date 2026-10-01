import { join } from 'node:path';
import { joinSession } from '@github/copilot-sdk/extension';
import {
  appendGuardRecord, decideToolUse, readLedger,
} from './guard-policy.mjs';

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
