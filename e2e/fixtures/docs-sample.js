export const SAMPLE_TASK_ID = 845
export const SAMPLE_PRIMARY_ID = 'd-sample845'
export const SAMPLE_LINKED_ID = 'd-support845'
export const SAMPLE_TITLE = 'Task 845: Sample catch-up task'
export const SAMPLE_JOURNAL = [
  '# Task 845: Sample catch-up task',
  '<!-- tg-meta username=focusplanner_sample -->',
  '',
  Array.from({ length: 1500 }, (_, i) => `context${i}`).join(' '),
  '',
].join('\n')

const publishedAt = '2026-10-01T12:00:00Z'
const index = {
  version: 1,
  tasks: { [SAMPLE_TASK_ID]: SAMPLE_PRIMARY_ID },
  docs: {
    [SAMPLE_PRIMARY_ID]: {
      title: SAMPLE_TITLE,
      task: SAMPLE_TASK_ID,
      primary: true,
      rev: 1,
      updatedAt: publishedAt,
      telegramUrl: 'https://t.me/focusplanner_sample',
      links: [SAMPLE_LINKED_ID],
    },
    [SAMPLE_LINKED_ID]: {
      title: 'Supporting sample notes',
      primary: false,
      rev: 1,
      updatedAt: publishedAt,
      links: [],
    },
  },
}

export const SAMPLE_DOC_FILES = {
  'docs/index.json': JSON.stringify(index, null, 2),
  [`docs/${SAMPLE_PRIMARY_ID}/doc.md`]: [
    `<!-- docs v1 id=${SAMPLE_PRIMARY_ID} rev=1 published=${publishedAt} by=fp-docs -->`,
    `# ${SAMPLE_TITLE}`,
    '',
    '<!-- @b1 -->',
    '**Status: Sample reader is ready.**',
    '',
    '<!-- @b2 -->',
    '## Catch-up',
    '',
    'This seeded task has a long journal and a primary catch-up document.',
    '',
    '<!-- @b3 -->',
    `Read the [supporting sample notes](doc:${SAMPLE_LINKED_ID}) for linked context.`,
    '',
  ].join('\n'),
  [`docs/${SAMPLE_PRIMARY_ID}/response.json`]: JSON.stringify({
    version: 1,
    rev: 1,
    revisions: [{ rev: 1, at: publishedAt, summary: 'Initial sample' }],
    dispositions: {},
  }, null, 2),
  [`docs/${SAMPLE_LINKED_ID}/doc.md`]: [
    `<!-- docs v1 id=${SAMPLE_LINKED_ID} rev=1 published=${publishedAt} by=fp-docs -->`,
    '# Supporting sample notes',
    '',
    '<!-- @b1 -->',
    'This linked sample document demonstrates in-app navigation.',
    '',
  ].join('\n'),
  [`docs/${SAMPLE_LINKED_ID}/response.json`]: JSON.stringify({
    version: 1,
    rev: 1,
    revisions: [{ rev: 1, at: publishedAt, summary: 'Initial sample' }],
    dispositions: {},
  }, null, 2),
  [`journal/task-${SAMPLE_TASK_ID}.md`]: SAMPLE_JOURNAL,
}
