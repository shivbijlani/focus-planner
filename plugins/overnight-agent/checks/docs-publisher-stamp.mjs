import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { docsPublisherPath } from '../skills/overnight-agent/oa-state-lib/collect/native-docs.mjs';
import { assertSandboxPath } from '../skills/overnight-agent/oa-state-lib/core/context.mjs';

export async function checkPublisherStamps(root) {
  assertSandboxPath(root, 'Docs stamp root');
  const publisher = docsPublisherPath();
  const { readStatus } = await import(pathToFileURL(path.resolve(path.dirname(publisher), '..', 'src', 'index.js')));
  const { validateIndexText, validateDocText, validateResponseText } =
    await import(pathToFileURL(path.resolve(path.dirname(publisher), '..', '..', 'docs-core', 'src', 'index.js')));
  let indexText;
  try { indexText = await fs.readFile(path.join(root, 'docs', 'index.json'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { enabled: false, documents: 0 }; throw error; }
  const index = validateIndexText(indexText);
  if (!index) throw new Error('docs_stamp_invalid: docs/index.json is empty');
  for (const task of Object.keys(index.tasks)) await readStatus({ root, task });
  for (const [id, entry] of Object.entries(index.docs)) {
    const folder = path.join(root, 'docs', id);
    const response = validateResponseText(await fs.readFile(path.join(folder, 'response.json'), 'utf8'));
    const current = await fs.readFile(path.join(folder, 'doc.md'), 'utf8');
    validateDocText(current, { docId: id, entry, response });
    const snapshot = await fs.readFile(path.join(folder, 'history', `r${String(entry.rev).padStart(4, '0')}.md`), 'utf8');
    if (current !== snapshot) throw new Error(`docs_stamp_external_edit: ${id}/doc.md differs from its publisher snapshot`);
    for (const file of await fs.readdir(path.join(folder, 'history'))) {
      const match = /^r(\d{4,})\.md$/.exec(file);
      if (match) validateDocText(await fs.readFile(path.join(folder, 'history', file), 'utf8'), { docId: id, expectedRev: Number(match[1]) });
    }
  }
  return { enabled: true, documents: Object.keys(index.docs).length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.PLANNER_PATH) throw new Error('PLANNER_PATH is required');
  checkPublisherStamps(process.env.PLANNER_PATH).then((result) => console.log(JSON.stringify(result)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
