import { join } from 'node:path';
import { joinSession } from '@github/copilot-sdk/extension';
import {
  appendGuardRecord, decideToolUse, readLedger,
} from './guard-policy.mjs';

const ledger = join(process.env.LOCALAPPDATA ?? process.env.HOME ?? '.', 'overnight-agent', 'run-ledger.jsonl');

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
