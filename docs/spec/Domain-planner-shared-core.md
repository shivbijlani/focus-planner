# Domain: planner-shared-core

`planner-shared-core` is the smallest domain and the one with the strictest contract: the **single
implementation of how tasks are ordered and how a group of tasks moves together**. The board UI and
anything else that needs "what comes first" import it rather than reimplement it, so every surface
derives the same order from the same board. This is the same principle that governs the rest of the
system (see [Home](Home)): one parser or sorter per rule, never one per surface.

## Responsibility

Three product behaviours live here.

1. **Reading the priority list.** The manager's ranked priorities are a numbered list on the
   board's `Priorities` section; the list position is the rank (1 is most important). Only numbered
   lines count; everything else in that section is ignored.
2. **Sorting a section.** Rows are ordered by, in this precedence: urgent (🔴) rows first; then the
   rank of the manager priority the task reaches by following its `Linked ID` chain; then, within the
   same rank, tasks deeper in the chain first so that **prerequisites come before the work that
   depends on them**; then the urgency-icon order (🔴, 🐸, 🟡, 🔵, 📖, ⚪, ✅); then the original
   order, because the sort is stable. Snoozed rows are not moved to the bottom of their section and
   snooze markers on raw rows are ignored when sorting.
3. **Moving a task with its dependants.** Moving a manager-priority task also moves every active
   task whose chain resolves to it; moving it also reports which links would **break** — incoming
   links from tasks left behind — so the user is warned before a dependency chain is split.

Resolution is bounded and safe: a chain is followed at most 20 steps by default, a cycle yields "no
manager priority" rather than looping, and chains longer than five hops still resolve. An optional
alias map lets an external link (a task that links to a name rather than an id) resolve to the
manager priority at its existing depth, without an extra hop; aliases are never followed
recursively.

**Why a shared package and not app code.** The sort and the move set are pure functions of plain
data. Keeping them dependency-free and in their own package lets the board and the agent-side tools
exercise the identical rules, and keeps the long-standing "did the order drift between surfaces"
class of bug out of the UI. The alternative — each surface sorting its own copy — was rejected
because ordering is what the user is trusting the plan for.

## Principal modules

> [!NOTE]
> **Technical detail: module paths and exports.** Optional reference; behaviour is described in the sections around it.

<details>
<summary><strong>Show principal modules and their exports</strong></summary>

| Path | Exports | Role |
| --- | --- | --- |
| `packages/planner-shared-core/src/taskSort.js` | `extractTaskId`, `getChainDepthToManagerPriority`, `isNeededForUrgentTask`, `parseManagerPriorities`, `resolveManagerPriority`, `sortTasksByPriority` | Priority parsing, chain resolution, "needed for an urgent task", and the section sort |
| `packages/planner-shared-core/src/taskMove.js` | `computeBrokenLinks`, `computeMoveSet` | The set of tasks that moves with a root, and the links that move would break |
| `packages/planner-shared-core/src/index.js` | `computeBrokenLinks`, `computeMoveSet` | Package entry point; the sorting exports stay importable from the package root unchanged |

</details>

> [!NOTE]
> **Technical detail: function contracts.** Optional; the behaviour is stated in the sections above.

<details>
<summary><strong>Show the function-level contract</strong></summary>

- `parseManagerPriorities(lines)` returns a map from priority text to rank; a line counts if it
  matches `N. text`, and rank is assigned in order of appearance starting at 1.
- `resolveManagerPriority(taskId, linkedIdMap, managerPriorities, aliases?)` walks
  `linkedIdMap[current]` until it finds a key of `managerPriorities` (or an alias whose target is
  one) and returns `{ id, order }`, or `null` on a missing link, a cycle, or the depth cap. A direct
  manager priority beats its alias.
- `getChainDepthToManagerPriority` returns the number of hops (0 when the task is itself a manager
  priority) or `null`; tasks with no chain rank below every task that has one.
- `isNeededForUrgentTask(taskId, linkedIdMap, taskPriorityLookup)` is true when any task reached by
  following links *from* the task carries 🔴; an urgent task that links to non-urgent work is not
  "needed for" anything.
- `extractTaskId(row)` accepts a plain numeric id or a linked-id object and returns the digits or
  `null`.
- `sortTasksByPriority(rows, rawLines, headers, linkedIdMap, managerPriorities, aliasMap)` returns
  `{ sortedRows, sortedRawLines }`, keeping each raw line paired with its parsed row.
- `computeMoveSet(rootId, priorities, links, activeIds, aliases)` returns a `Set` that always
  contains the root; it contains dependants only when the root is itself a manager priority, and
  compares ids as exact strings.
- `computeBrokenLinks(movingIds, links, nameLookup, aliases)` returns
  `{ fromId, fromName, toId, resolvedToId? }` entries for links from tasks that stay behind into the
  moving set; `resolvedToId` appears only when the hit came through an alias, and links inside the
  move set or unrelated to it are never reported.

</details>

## Behavioural requirements

From `packages/planner-shared-core/src/taskSort.test.js` and `taskMove.test.js`:

- Dependency chains sort prerequisite-first within the same manager priority, but manager priority
  order always outranks dependency depth.
- Red urgent rows float above non-red rows; when manager priority and depth tie, the urgency icon
  decides.
- Snoozed rows are not bottom-sorted, and cyclic links neither crash the sort nor disturb a stable
  order when ties remain.
- Resolution works across chains longer than five hops, honours the default 20-node cap, and
  honours an explicit numeric depth limit.
- Aliases sort by manager rank before depth, keep urgent rows first and keep raw lines paired.
- `isNeededForUrgentTask` is true for a direct or indirect link to an urgent task, false when no
  task in the chain is urgent, false for tasks with no links, and terminates on cycles.
- The move set preserves root-first order, deduplicates without reordering, tolerates empty roots, and
  excludes chains that do not resolve within the depth cap.
- Broken-link reporting lists only incoming links from tasks left behind, omits links inside the move
  set and unrelated links, accepts frozen arrays, and returns nothing for null inputs.

## Failure modes

An unresolved chain silently sorts last rather than erroring, so a mistyped `Linked ID` shows up as a
task that never rises; the sort has no way to flag it. Both functions trust that the caller supplies
parsed rows and a link map consistent with the board — they do not parse markdown themselves. For the
overnight agent's own ordering, which adds a section gate and a binding `eligible` flag on top of
this order, see [Prioritisation](Prioritisation).
