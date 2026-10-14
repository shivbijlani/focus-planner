import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withFileLock } from './file-lock.mjs';

export const AGENT_EMAIL_SERVER = 'google-workspace-agent-email';
const signature = '\u{1f916} on behalf of Shiv';
const email = /^[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+$/;

export function gmailSendArguments({ account, sender, to, subject, body, threadId }) {
  for (const [name, value] of Object.entries({ account, sender, to })) {
    if (!email.test(value ?? '')) throw new Error(`Agent email ${name}: valid address required`);
  }
  if (!subject?.trim() || !body?.trim()) throw new Error('Agent email: subject and HTML body required');
  return {
    user_google_email: account, from_email: sender, to, subject,
    body: `${body}\n<p>${signature}</p>`, body_format: 'html', include_signature: false,
    ...(threadId ? { thread_id: threadId } : {}),
  };
}

export function gmailSentId(result) {
  if (result?.error || result?.isError) throw new Error(`Gmail send failed: ${JSON.stringify(result)}`);
  const text = result?.content?.find((item) => item.type === 'text')?.text;
  let body = text;
  try { body = JSON.parse(text)?.result ?? text; } catch { /* Gmail normally returns text. */ }
  const match = typeof body === 'string' && body.match(/^Email sent(?: with [^\r\n!]+)?! Message ID: ([a-f0-9]+)$/);
  if (!match) throw new Error('Gmail send did not confirm a sent message ID');
  return match[1];
}

export function inboxReceipt(file, { account, messageId, handled = false }) {
  if (!email.test(account ?? '') || !/^[a-f0-9]+$/.test(messageId ?? '')) {
    throw new Error('Inbox receipt: backing Gmail account and exact message ID required');
  }
  const key = `${account.toLowerCase()}:${messageId}`;
  mkdirSync(path.dirname(file), { recursive: true });
  return withFileLock(file, () => {
    let receipts = { schema: 'oa-agent-inbox-receipts/1', handled: {} };
    try { receipts = JSON.parse(readFileSync(file, 'utf8')); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (receipts.schema !== 'oa-agent-inbox-receipts/1' || !receipts.handled ||
        typeof receipts.handled !== 'object' || Array.isArray(receipts.handled)) {
      throw new Error('Inbox receipts: invalid schema; do not treat as an empty ledger');
    }
    if (handled && !Object.hasOwn(receipts.handled, key)) {
      receipts.handled[key] = new Date().toISOString();
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(receipts, null, 2)}\n`);
      renameSync(temporary, file);
    }
    return { account, messageId, handled: Object.hasOwn(receipts.handled, key) };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, ...args] = process.argv.slice(2);
    if (!['handled', 'was-handled'].includes(action)) {
      throw new Error('Usage: agent-email.mjs handled|was-handled --account <Gmail> --message-id <id> [--file <receipts.json>]');
    }
    const option = (name) => args[args.indexOf(name) + 1];
    const home = process.env.OVERNIGHT_AGENT_HOME || path.join(process.env.LOCALAPPDATA || tmpdir(), 'overnight-agent');
    const file = args.includes('--file') ? option('--file') : path.join(home, 'agent-inbox-receipts.json');
    console.log(JSON.stringify(inboxReceipt(file, {
      account: args.includes('--account') ? option('--account') : '',
      messageId: args.includes('--message-id') ? option('--message-id') : '',
      handled: action === 'handled',
    })));
  } catch (error) { console.error(`Agent email: ${error.message}`); process.exitCode = 1; }
}
