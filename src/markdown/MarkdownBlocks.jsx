import { renderJournalLines } from './markdownRender.jsx'

/** Component form of renderJournalLines (the journal's renderer, shared with Docs). */
export function MarkdownBlocks({ lines, onNavigate = () => {}, onToggle, ctx, options }) {
  return <>{renderJournalLines(lines || [], onNavigate, onToggle, ctx, options)}</>
}
