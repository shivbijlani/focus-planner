import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gmailSendArguments, gmailSentId, inboxReceipt } from '../skills/overnight-agent/agent-email.mjs';

const args = gmailSendArguments({
  account: 'backing@example.test', sender: 'ai@example.test', to: 'self@example.test',
  subject: 'Alert', body: '<p>Details &amp; links.</p>', threadId: 'a1',
});
assert.equal(args.user_google_email, 'backing@example.test');
assert.equal(args.from_email, 'ai@example.test');
assert.equal(args.body_format, 'html');
assert.equal(args.include_signature, false);
assert.equal(args.thread_id, 'a1');
assert.match(args.body, /<p>🤖 on behalf of Shiv<\/p>$/);
assert.throws(() => gmailSendArguments({ ...args, account: 'bad' }), /valid address/);
const result = (text) => ({ content: [{ type: 'text', text }] });
assert.equal(gmailSentId(result('Email sent! Message ID: a123')), 'a123');
assert.equal(gmailSentId(result(JSON.stringify({ result: 'Email sent! Message ID: a123' }))), 'a123');
assert.throws(() => gmailSentId(result('permission denied')), /did not confirm/);
assert.throws(() => gmailSentId({ isError: true }), /send failed/);

const temp = mkdtempSync(path.join(tmpdir(), 'oa-agent-email-'));
try {
  const file = path.join(temp, 'receipts.json');
  const input = { account: 'backing@example.test', messageId: 'a123' };
  assert.equal(inboxReceipt(file, input).handled, false);
  assert.equal(inboxReceipt(file, { ...input, handled: true }).handled, true);
  const bytes = readFileSync(file, 'utf8');
  assert.equal(inboxReceipt(file, { ...input, handled: true }).handled, true);
  assert.equal(readFileSync(file, 'utf8'), bytes);
  assert.equal(inboxReceipt(file, { ...input, account: 'other@example.test' }).handled, false);
  assert.equal(inboxReceipt(file, { ...input, messageId: 'b456' }).handled, false);
  writeFileSync(file, '{broken');
  assert.throws(() => inboxReceipt(file, input));
  writeFileSync(file, '{"schema":"wrong","handled":{}}');
  assert.throws(() => inboxReceipt(file, input), /invalid schema/);
  console.log('PASS Gmail identity, explicit signature/HTML, sent-ID confirmation, account-scoped idempotent receipts and fail-closed ledger');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
