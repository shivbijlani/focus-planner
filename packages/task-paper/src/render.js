// Render a paper model (see `paper.js`) as a single self-contained HTML document.
//
// SELF-CONTAINED ON PURPOSE: no external CSS, no fonts, no scripts, no network. These
// docs live next to the journals in OneDrive and get opened from a phone, often with
// no connection and always with no build step. A file that needs a server to look
// right is a file that will be read as broken.
//
// DETERMINISTIC ON PURPOSE: there is no "generated at <now>" stamp. #286 settles the
// regenerate-vs-maintain fork in favour of regenerating every run, and a clock in the
// output would make every doc rewrite on every run even when nothing changed --
// churning OneDrive and destroying the one signal that matters, which is whether the
// task actually moved. "Last updated" is therefore derived from the journal's own
// newest dated entry, which is both honest and stable.
//
// ⚠️ VALIDATING THESE DOCS: assert against the RAW HTML SOURCE, never `innerText`.
// Recorded on #286 after two false negatives: `innerText` omits content inside
// collapsed `<details>`, and collapse-by-default is the entire point of this format,
// so a naive text check reports most of a correct document as missing. Both failure
// modes report a correct document as broken, which is the dangerous direction. For
// the same reason no heading here uses `text-transform`, so authored text and
// rendered text stay byte-comparable.

import { escapeHtml, renderMarkdown, renderInline } from './markdown.js'
import { buildCommentScript, commentSectionHtml } from './comment.js'

const STYLE = `
:root {
  --ink: #1a1a1a; --muted: #5c6470; --line: #e3e6ea; --bg: #fbfbfc;
  --card: #ffffff; --accent: #2b6cb0; --ask-bg: #fff8e6; --ask-line: #e3b341;
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 1.25rem; background: var(--bg); color: var(--ink);
  font: 16px/1.62 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  -webkit-text-size-adjust: 100%;
}
main { max-width: 46rem; margin: 0 auto; }
header.paper-head { border-bottom: 2px solid var(--line); padding-bottom: .9rem; margin-bottom: 1.4rem; }
.eyebrow { margin: 0 0 .3rem; color: var(--muted); font-size: .8rem; letter-spacing: .04em; }
h1 { margin: 0 0 .55rem; font-size: 1.65rem; line-height: 1.25; }
.meta { margin: 0; color: var(--muted); font-size: .87rem; }
.badge {
  display: inline-block; padding: .12rem .5rem; border-radius: 999px;
  background: #eef2f7; color: #2d3748; font-size: .78rem; font-weight: 600;
}
.badge--done { background: #e6f4ea; color: #1e6b3a; }
.badge--blocked { background: #fdecea; color: #8a1c12; }
.badge--proposed { background: #fff4e5; color: #8a5300; }
section.ask {
  background: var(--ask-bg); border: 1px solid var(--ask-line);
  border-radius: 6px; padding: .85rem 1rem; margin: 0 0 1.4rem;
}
section.ask h2 { margin: 0 0 .35rem; font-size: 1rem; }
section.ask p:last-child { margin-bottom: 0; }
.lead { margin-bottom: 1.2rem; }
details {
  background: var(--card); border: 1px solid var(--line); border-radius: 6px;
  padding: .3rem .95rem; margin: 0 0 .7rem;
}
details[open] { padding-bottom: .8rem; }
summary {
  cursor: pointer; padding: .55rem 0; font-weight: 600; list-style: none;
  display: flex; align-items: baseline; gap: .5rem;
}
summary::-webkit-details-marker { display: none; }
summary::before { content: "\\25B8"; color: var(--muted); font-size: .8em; transition: none; }
details[open] > summary::before { content: "\\25BE"; }
summary .note { font-weight: 400; color: var(--muted); font-size: .82rem; }
h2 { font-size: 1.15rem; margin: 1.6rem 0 .5rem; }
h3 { font-size: 1rem; margin: 1.2rem 0 .4rem; }
h4, h5, h6 { font-size: .94rem; margin: 1rem 0 .35rem; }
p, ul, ol, table, pre, blockquote { margin: 0 0 .8rem; }
ul, ol { padding-left: 1.3rem; }
li { margin: .18rem 0; }
a { color: var(--accent); }
code {
  background: #f1f3f5; padding: .1rem .32rem; border-radius: 4px;
  font: .87em/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  overflow-wrap: anywhere;
}
pre {
  background: #f6f8fa; border: 1px solid var(--line); border-radius: 6px;
  padding: .7rem .85rem; overflow-x: auto;
}
pre code { background: none; padding: 0; }
blockquote {
  margin-left: 0; padding: .1rem 0 .1rem .9rem; border-left: 3px solid var(--line);
  color: var(--muted);
}
table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto; }
th, td { border: 1px solid var(--line); padding: .4rem .55rem; text-align: left; font-size: .92rem; }
th { background: #f6f8fa; }
.msg { background: #f6f8fa; border-radius: 6px; padding: .6rem .8rem; margin-bottom: .7rem; }
.msg:last-child { margin-bottom: 0; }
.msg .when { color: var(--muted); font-size: .8rem; display: block; margin-bottom: .25rem; }
.msg > :last-child { margin-bottom: 0; }
section.comment { margin: 2rem 0 0; }
section.comment h2 { margin-bottom: .3rem; }
section.comment textarea {
  width: 100%; margin: .5rem 0 .6rem; padding: .6rem .7rem; border: 1px solid var(--line);
  border-radius: 6px; background: var(--card); color: inherit; font: inherit; line-height: 1.5;
  resize: vertical; min-height: 5.5rem;
}
section.comment textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.comment-actions { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
.comment-actions button {
  font: inherit; font-size: .9rem; padding: .4rem .85rem; border-radius: 6px;
  border: 1px solid var(--accent); background: var(--accent); color: #fff; cursor: pointer;
}
.comment-actions button.secondary { background: var(--card); color: var(--accent); }
.comment-actions button:disabled { opacity: .55; cursor: default; }
.oa-status { font-size: .85rem; color: var(--muted); }
.oa-status--ok { color: #1e6b3a; }
.oa-status--warn { color: #8a5300; }
.turn { border-top: 1px solid var(--line); padding-top: .9rem; margin-top: .9rem; }
.turn:first-child { border-top: 0; margin-top: 0; padding-top: 0; }
.turn .when { color: var(--muted); font-size: .8rem; }
footer.paper-foot {
  margin-top: 2rem; padding-top: .9rem; border-top: 1px solid var(--line);
  color: var(--muted); font-size: .82rem;
}
@media (max-width: 34rem) { body { padding: .85rem; } h1 { font-size: 1.35rem; } }
@media print {
  body { background: #fff; }
  details { border: 0; padding: 0; }
  details > summary { list-style: none; }
  details:not([open]) > *:not(summary) { display: revert; }
  section.comment { display: none; }
}
`.trim()

/** Stable, readable anchor for a heading so a comment can cite a section. */
export function slugify(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'section'
}

function badgeClass(status) {
  if (!status) return ''
  const s = status.toLowerCase()
  if (s === 'done') return ' badge--done'
  if (s === 'blocked') return ' badge--blocked'
  if (s === 'proposed' || s === 'revise') return ' badge--proposed'
  return ''
}

/** `<details>` with a summary, open when `open` is true. */
function details(summary, bodyHtml, { open = false, note = '' } = {}) {
  const noteHtml = note ? ` <span class="note">${escapeHtml(note)}</span>` : ''
  return `<details${open ? ' open' : ''}>\n<summary>${escapeHtml(summary)}${noteHtml}</summary>\n${bodyHtml}\n</details>`
}

function turnHtml(turn) {
  const who = turn.kind === 'user' ? 'You' : 'Overnight Agent'
  const when = turn.day ? `${who} \u00B7 ${turn.day}` : who
  const head = turn.heading
    ? `<h3>${renderInline(turn.heading)}</h3>`
    : ''
  return [
    '<div class="turn">',
    `<span class="when">${escapeHtml(when)}</span>`,
    head,
    renderMarkdown(turn.body, { headingBase: 1 }),
    '</div>',
  ].join('\n')
}

/**
 * Render the paper. `journalHref` / `boardHref` are optional links back to the
 * sources, so every claim in the doc can be traced to the file it came from.
 *
 * `writerSource` is the verbatim text of `src/journalChat.js`. Passing it turns on the
 * comment channel (#286): the page gets a comment box that appends to this task's
 * journal using that exact code. Omitting it renders a read-only paper, which is what
 * every existing caller and test gets by default -- the feature is additive.
 */
export function renderPaper(paper, { journalHref = null, telegramHref = null, writerSource = null } = {}) {
  const idLabel = paper.taskId ? `Task #${paper.taskId}` : 'Task'
  const lastDay = lastDayOf(paper)

  const metaBits = []
  if (paper.status) {
    metaBits.push(
      `<span class="badge${badgeClass(paper.status)}">${escapeHtml(humanStatus(paper.status))}</span>`,
    )
  }
  if (lastDay) metaBits.push(`updated ${escapeHtml(lastDay)}`)
  if (journalHref) metaBits.push(`<a href="${escapeHtml(journalHref)}">journal</a>`)
  if (telegramHref) metaBits.push(`<a href="${escapeHtml(telegramHref)}">Telegram</a>`)

  const parts = []
  parts.push('<!doctype html>')
  parts.push('<html lang="en">')
  parts.push('<head>')
  parts.push('<meta charset="utf-8">')
  parts.push('<meta name="viewport" content="width=device-width, initial-scale=1">')
  parts.push(`<title>${escapeHtml(`${idLabel} \u2014 ${paper.title}`)}</title>`)
  parts.push(`<style>\n${STYLE}\n</style>`)
  parts.push('</head>')
  parts.push('<body>')
  parts.push('<main>')

  parts.push('<header class="paper-head">')
  parts.push(`<p class="eyebrow">Focus Planner \u00B7 ${escapeHtml(idLabel)}</p>`)
  parts.push(`<h1>${renderInline(paper.title)}</h1>`)
  if (metaBits.length) parts.push(`<p class="meta">${metaBits.join(' \u00B7 ')}</p>`)
  parts.push('</header>')

  // The ask goes ABOVE everything. In the journal it is the last line of the last
  // turn, which is precisely where it gets missed.
  if (paper.ask && paper.ask.text) {
    parts.push('<section class="ask">')
    parts.push('<h2>What I need from you</h2>')
    parts.push(renderMarkdown(paper.ask.text, { headingBase: 2 }))
    parts.push('</section>')
  }

  if (paper.current && paper.current.sections.length) {
    const [lead, ...rest] = paper.current.sections
    if (lead && !lead.heading) {
      parts.push(`<div class="lead">${renderMarkdown(lead.body, { headingBase: 1 })}</div>`)
    }
    const sections = lead && !lead.heading ? rest : paper.current.sections
    parts.push('<h2>Where it stands</h2>')
    for (const [n, section] of sections.entries()) {
      const body = renderMarkdown(section.body, { headingBase: 1 })
      // The first two sections carry the summary a skim-reader needs, so they are
      // open; the rest collapse. Collapse-by-default for everything would hide the
      // answer behind a click, which is the opposite of the goal.
      parts.push(
        `<div id="${escapeHtml(slugify(section.heading || `section-${n + 1}`))}">` +
          details(section.heading || `Section ${n + 1}`, body, { open: n < 2 }) +
          '</div>',
      )
    }
  } else if (!paper.current) {
    parts.push('<p><em>No agent turn has been written for this task yet.</em></p>')
  }

  if (paper.framing) {
    parts.push('<h2>Background</h2>')
    parts.push(
      details('How this task was framed', renderMarkdown(paper.framing, { headingBase: 1 }), {
        open: !paper.current,
      }),
    )
  }

  if (paper.userMessages.length) {
    const body = paper.userMessages
      .map(
        (m) =>
          `<div class="msg">\n<span class="when">${escapeHtml(m.day || 'undated')}</span>\n` +
          `${renderMarkdown(m.body, { headingBase: 1 })}\n</div>`,
      )
      .join('\n')
    parts.push('<h2>Your instructions</h2>')
    parts.push(
      details(
        'Everything you have said on this task',
        body,
        { open: true, note: countNote(paper.userMessages.length, 'message') },
      ),
    )
  }

  const hasAppendix = paper.appendix.sections.length || paper.appendix.priorTurns.length
  if (hasAppendix) {
    parts.push('<h2>Appendix</h2>')
    parts.push(
      '<p class="meta">History, corrections and run-by-run narration. Kept for verification, out of the way of the reading.</p>',
    )
    for (const section of paper.appendix.sections) {
      parts.push(
        details(section.heading, renderMarkdown(section.body, { headingBase: 1 }), {
          note: 'this run',
        }),
      )
    }
    if (paper.appendix.priorTurns.length) {
      parts.push(
        details(
          'Earlier turns, newest first',
          paper.appendix.priorTurns.map(turnHtml).join('\n'),
          { note: countNote(paper.appendix.priorTurns.length, 'entry', 'entries') },
        ),
      )
    }
  }

  const commentsOn = Boolean(writerSource && paper.taskId)
  if (commentsOn) parts.push(commentSectionHtml({ taskId: paper.taskId }))

  parts.push('<footer class="paper-foot">')
  parts.push(
    commentsOn
      ? `<p>Generated from the task journal, which stays the source of truth. This page is regenerated on every ` +
          `run, so <strong>a comment is saved into the journal rather than into this page</strong> \u2014 that is why ` +
          `it survives, and why the agent reads it exactly as it reads a reply in the journal or in Telegram.</p>`
      : `<p>Generated from the task journal, which stays the source of truth. This page is regenerated on every run, so edits made here are not read \u2014 ` +
          `<strong>to leave an instruction, reply in the journal or in Telegram</strong> and it will be picked up next run.</p>`,
  )
  parts.push(
    `<p>Built from ${escapeHtml(formatBytes(paper.counts.sourceBytes))} of journal \u00B7 ` +
      `${paper.counts.agentTurns} agent ${plural(paper.counts.agentTurns, 'turn')} \u00B7 ` +
      `${paper.counts.userMessages} from you.</p>`,
  )
  parts.push('</footer>')

  parts.push('</main>')
  if (commentsOn) parts.push(buildCommentScript(writerSource, { taskId: paper.taskId }))
  parts.push('</body>')
  parts.push('</html>')
  return parts.join('\n') + '\n'
}

function plural(n, word, pluralWord) {
  return n === 1 ? word : pluralWord || `${word}s`
}

function countNote(n, word, pluralWord) {
  return `${n} ${plural(n, word, pluralWord)}`
}

function humanStatus(status) {
  const map = {
    'in-progress': 'In progress',
    done: 'Done',
    blocked: 'Blocked',
    proposed: 'Awaiting your call',
    revise: 'Revising',
    approved: 'Approved',
    skip: 'Skipped',
  }
  return map[status.toLowerCase()] || status
}

function lastDayOf(paper) {
  // Prefer the date the turn states about itself. A journal only carries a `## <date>`
  // header when the USER writes one, so an agent turn appended under yesterday's
  // header would otherwise be reported under yesterday's date -- understating how
  // current the page is, which is the one thing this line exists to convey.
  const stated = paper.statusLine && /\b(\d{4}-\d{2}-\d{2})\b/.exec(paper.statusLine)
  if (stated) return stated[1]
  if (paper.current && paper.current.day) return paper.current.day
  for (const t of paper.appendix.priorTurns) if (t.day) return t.day
  return null
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
