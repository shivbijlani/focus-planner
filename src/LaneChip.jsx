// The lane chip on a board row (docs/spec/Domain-lanes.md, "Row chip"). Rendered only when the
// planner folder has a valid agent-lanes.json and the row has a lane (or a lane problem).
//   served   -> "ado"
//   waiting  -> "⏳ ado", tooltip names the assigned PC and when it was last seen, or says none is
//   problem  -> "⚠ lane", tooltip names the conflicting / invalid names
import { laneChipTitle } from './lanes/laneText.js'

export default function LaneChip({ view }) {
  if (!view || view.status === 'none') return null
  const label = view.status === 'problem' ? '⚠ lane' : view.status === 'waiting' ? `⏳ ${view.lane}` : view.lane
  return (
    <span className={`lane-chip lane-chip-${view.status}`} title={laneChipTitle(view)} data-testid="lane-chip">
      {label}
    </span>
  )
}
