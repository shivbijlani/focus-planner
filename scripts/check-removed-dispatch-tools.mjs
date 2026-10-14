#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'overnight-agent');
const removed = [
  'oa_drain',
  'oa_drain_status',
  'oa_drain_wait',
  'oa-drain',
  'scheduler extension',
];

function violations(text) {
  return removed.filter((name) => text.toLowerCase().includes(name));
}

function scan(dir) {
  const failures = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      failures.push(...scan(path));
    } else if (entry.isFile()) {
      const found = violations(`${relative(root, path)}\n${readFileSync(path, 'utf8')}`);
      if (found.length) failures.push(`${relative(root, path)}: ${found.join(', ')}`);
    }
  }
  return failures;
}

for (const name of removed) {
  if (!violations(`Use ${name} to dispatch`).includes(name)) {
    throw new Error(`guard does not detect removed instruction: ${name}`);
  }
}

const failures = scan(root);
if (failures.length) {
  console.error(`Removed dispatch instructions found:\n${failures.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log('Shipped overnight-agent plugin uses only direct dispatch.');
}
