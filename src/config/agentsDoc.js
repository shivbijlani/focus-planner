/**
 * Canonical "AGENTS.md" that the app scaffolds into every connected data
 * folder (local FSA / OneDrive / Google Drive / browser). This makes the folder
 * self-documenting: a user can point ANY agent at the folder and it will know
 * how to read and update the files — without needing this app's source.
 *
 * Keep this in sync with the renderer in src/journalChat.js. The version line is
 * used to refresh stale copies that were scaffolded by an older app build.
 */

export const AGENTS_DOC_VERSION = 2

export const AGENTS_FILE = 'AGENTS.md'

export const AGENTS_DOC = `# AGENTS.md

<!-- planner-agents-doc v${AGENTS_DOC_VERSION} — managed by the Planner app. Safe to edit; the app only rewrites this when its schema version increases. -->

This folder is the database for a **Markdown Planner** app. The files here are
plain Markdown, so you can read and edit them with any tool. This document is
the contract for how to update them correctly.

## Files

- \`planner.md\` — the active task list (sections: \`## Today\`, \`## Deferred\`, \`## Priorities\`).
- \`planner-completed.md\` — archive of finished tasks.
- \`journal/task-XX.md\` — a per-task journal, rendered in the app as a **chat thread**.

## Task tables (planner.md)

Each task is a row in a Markdown table:

\`\`\`markdown
| ID | 🎯 | Task | Priority | Added | Linked ID |
|----|----|------|----------|-------|-----------|
| 70 | 🟡 | Write the design doc | Sydney rollout | 2026-01-27 | |
\`\`\`

Priority icons: 🔴 urgent+important · 🟡 important · 🔵 urgent/delegate ·
⚪ low · ✅ done · 🐸 frog (do first) · 📖 learning.

## Journal chat schema (journal/task-XX.md)

Journals render as a chat thread — as if the user is messaging themselves. The
format **degrades gracefully**: plain Markdown always renders as a valid message
bubble, so if you know nothing else you can just append normal Markdown. The
markers below add dated grouping and agent attribution.

\`\`\`markdown
# Task 254: Add dance church events to the calendar   <- thread title (first line)

- TODO: pick a cleaner                                <- undated "earlier notes"

## 2026-06-13                                         <- starts a day group (the user)

Booked the cleaner for Saturday.                      <- a "me" bubble

<!-- from: research-agent -->                         <- following content is from an agent
Found the cleaning code: **W-S**.                     <- agent bubble (shown under a 🤖 banner)
- [ ] Spot-test the back-left corner first
\`\`\`

### Markers

| Marker | Meaning |
|--------|---------|
| \`# Task XX: Title\` | Thread title. First line of the file. |
| \`## YYYY-MM-DD\` | Starts a new day group. Same-day consecutive user notes merge into one bubble. |
| \`<!-- from: name -->\` | Following content is from AI agent \`name\` (renders left, under a 🤖 banner). |
| \`<!-- from: me -->\` | Switch attribution back to the user. |
| \`<!-- ...AUTO... -->\` or \`<!-- ...AGENT... -->\` | A sentinel comment containing \`AUTO\` or \`AGENT\` flags an auto-generated / agent-managed block (e.g. \`DANCE-CHURCH-AUTO\`, \`OVERNIGHT-AGENT\`). |
| \`<!-- ... -->\` (may span lines) | Hidden from the chat. Use for machine metadata. |

Content before the first \`##\`/agent marker is treated as undated "earlier
notes". A journal with no dated content renders as a single user bubble.

### Supported Markdown inside a message

Bold, italic, inline code, links, headings (\`##\`–\`######\`), bullet/numbered
lists, tables, blockquotes (\`>\`), horizontal rules (\`---\`), and task items
(\`- [ ]\`, \`- [x]\`, \`1. [ ]\`) plus \`TODO:\` / \`DONE:\` prefixes (shown as chips).

## How to append to a journal (rules for agents)

1. **Always append at the bottom.** Never rewrite or reorder earlier entries.
2. If today already has a \`## YYYY-MM-DD\` header and the last author was the
   user, just add your lines under it (they merge into the same bubble).
3. If today has no header yet, add a new \`\\n\\n## YYYY-MM-DD\\n\\n\` block.
4. If you are an automation/agent, precede your block with
   \`<!-- from: your-name -->\` so it renders as a distinct 🤖 message.
5. Put any machine-readable metadata inside an HTML comment so it stays hidden.
`

// Extract the "v<N>" version embedded in an existing AGENTS.md so we only
// rewrite copies produced by an older app build (never clobber user edits of
// the current version).
function readDocVersion(text) {
const m = (text || '').match(/planner-agents-doc v(\d+)/)
return m ? parseInt(m[1], 10) : 0
}

/**
 * Ensure AGENTS.md exists and is at least the current version.
 * `read` and `write` are the provider's own async file methods.
 * Best-effort: never throws (scaffolding must not block folder setup).
 */
export async function scaffoldAgentsDoc(read, write) {
let existing = ''
try {
  existing = await read(AGENTS_FILE)
} catch {
  existing = '' // missing file (some providers throw rather than return '')
}
if (existing && readDocVersion(existing) >= AGENTS_DOC_VERSION) return
try {
  await write(AGENTS_FILE, AGENTS_DOC)
} catch {
  /* ignore — folder is still usable without the doc */
}
}
