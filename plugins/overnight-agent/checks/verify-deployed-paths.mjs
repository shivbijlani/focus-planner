#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const input = JSON.parse(readFileSync(0, 'utf8').replace(/^\uFEFF/, ''));
const written = input.written || [];
const removed = input.removed || [];
const residual = [];

function normHash(bytes) {
  const normalized = bytes.toString('utf8').replace(/\r\n/g, '\n').replace(/\s+$/, '') + '\n';
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

if (written.length) {
  written.forEach((row) => {
    if (!row.expectedBase64) throw new Error(`missing expected content for ${row.repoPath}`);
    const expected = Buffer.from(row.expectedBase64, 'base64');
    if (!existsSync(row.installedFile) ||
        normHash(readFileSync(row.installedFile)) !== normHash(expected)) {
      residual.push(`MISSING ${row.rel}`);
    }
  });
}

for (const row of removed) {
  if (existsSync(row.installedFile)) residual.push(`MISSING ${row.rel}`);
}

process.stdout.write(`${JSON.stringify({ residual })}\n`);
