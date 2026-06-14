// Pure helpers for rendering journal markdown as a chat thread.
// Kept dependency-free so they can be unit tested without React.

export function localISODate(d = new Date()) {
  const z = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`
}

export function formatChatDay(day) {
  if (!day) return null
  const d = new Date(`${day}T00:00:00`)
  if (isNaN(d)) return day
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export function trimBlankEnds(arr) {
  let start = 0
  let end = arr.length
  while (start < end && arr[start].trim() === '') start++
  while (end > start && arr[end - 1].trim() === '') end--
  return arr.slice(start, end)
}

// Parse a journal markdown file into a chat-style structure.
// Convention:
//   "# Task XX: Title"          -> thread title
//   "## YYYY-MM-DD [label]"     -> starts a new day (author resets to me)
//   "<!-- from: NAME -->"       -> switches author (NAME === me returns to me)
//   "<!-- ...AUTO... -->"       -> agent block (legacy auto-generated content)
// Content before the first day/agent marker is "pinned" (undated header notes).
// Multi-line HTML comments (e.g. <!-- dc-meta ... -->) are stripped entirely.
export function parseJournalChat(content) {
  const text = (content || '').replace(/^\uFEFF/, '')
  const lines = text.split(/\r?\n/)
  let title = ''
  const pinned = []
  const groups = []
  let started = false
  let curDay = null
  let curAuthor = 'me'
  let curAgent = null
  let inComment = false

  const dateRe = /^##\s+(\d{4}-\d{2}-\d{2})\b/
  const fromRe = /^<!--\s*from:\s*([^\s>]+)\s*-->/i
  const autoRe = /^<!--.*\bAUTO\b.*-->/i

  const pushLine = (line) => {
    let g = groups[groups.length - 1]
    if (!g || g.day !== curDay || g.author !== curAuthor || g.agent !== curAgent) {
      g = { day: curDay, author: curAuthor, agent: curAgent, lines: [] }
      groups.push(g)
    }
    g.lines.push(line)
  }

  for (const rawLine of lines) {
    let line = rawLine
    // Continue swallowing a multi-line HTML comment (e.g. <!-- dc-meta ... -->)
    if (inComment) {
      const end = line.indexOf('-->')
      if (end === -1) continue
      line = line.slice(end + 3)
      inComment = false
    }
    const trimmed = line.trim()

    if (!title) {
      const tm = trimmed.match(/^#\s+(.+)/)
      if (tm) { title = tm[1].trim(); continue }
    }
    const dm = trimmed.match(dateRe)
    if (dm) {
      curDay = dm[1]
      curAuthor = 'me'
      curAgent = null
      started = true
      continue
    }
    const fm = trimmed.match(fromRe)
    if (fm) {
      if (fm[1].toLowerCase() === 'me') { curAuthor = 'me'; curAgent = null }
      else { curAuthor = 'agent'; curAgent = fm[1] }
      started = true
      continue
    }
    if (autoRe.test(trimmed)) {
      curAuthor = 'agent'
      curAgent = curAgent || 'agent'
      started = true
      continue
    }

    // Remove complete inline comments; if a comment opens without closing,
    // keep any visible text before it and swallow the rest across lines.
    let visible = line.replace(/<!--[\s\S]*?-->/g, '')
    const open = visible.indexOf('<!--')
    if (open !== -1) { visible = visible.slice(0, open); inComment = true }

    const wasBlank = rawLine.trim() === ''
    if (!wasBlank && visible.trim() === '') continue // line was purely a comment
    const emit = wasBlank ? '' : visible
    if (!started) pinned.push(emit)
    else pushLine(emit)
  }

  return {
    title,
    pinned: trimBlankEnds(pinned),
    groups: groups
      .map((g) => ({ ...g, lines: trimBlankEnds(g.lines) }))
      .filter((g) => g.lines.length > 0),
  }
}

// Append a new "me" message to journal markdown, merging into today's bubble.
export function appendJournalMessage(content, text, today = localISODate()) {
  const body = (content || '').replace(/\s+$/, '')
  const lines = body.split(/\r?\n/)
  let lastDate = null
  let lastDateIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].trim().match(/^##\s+(\d{4}-\d{2}-\d{2})\b/)
    if (m) { lastDate = m[1]; lastDateIdx = i; break }
  }
  let endAuthor = 'me'
  for (let i = lastDateIdx < 0 ? 0 : lastDateIdx; i < lines.length; i++) {
    const t = lines[i].trim()
    const fm = t.match(/^<!--\s*from:\s*([^\s>]+)\s*-->/i)
    if (fm) endAuthor = fm[1].toLowerCase() === 'me' ? 'me' : 'agent'
    if (/^<!--.*\bAUTO\b.*-->/i.test(t)) endAuthor = 'agent'
  }
  let addition
  if (lastDate !== today) addition = `\n\n## ${today}\n\n${text}`
  else if (endAuthor === 'me') addition = `\n${text}`
  else addition = `\n\n<!-- from: me -->\n${text}`
  return `${body}${addition}\n`
}
