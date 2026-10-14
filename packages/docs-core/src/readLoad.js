// The catch-up threshold measure (plans/docs-app-design.md §3.1): visible journal words,
// i.e. the journal with `<!-- … -->` comments and markers stripped — what a reader has
// to wade through. Shared by the agent and the app so they never disagree.

import { visibleLines } from './grammar.js'

export const DEFAULT_CATCHUP_THRESHOLD = 1500

export function journalReadLoad(content, threshold = DEFAULT_CATCHUP_THRESHOLD) {
  let words = 0
  for (const line of visibleLines(content)) {
    const m = line.match(/\S+/g)
    if (m) words += m.length
  }
  return { words, threshold, reached: words >= threshold, minutes: Math.round(words / 250) }
}
