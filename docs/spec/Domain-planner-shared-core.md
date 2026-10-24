# Domain: planner-shared-core

`planner-shared-core` is the one place where the rules for **ordering tasks** and **planning a task move** are written down as pure functions. The public planner app and an enterprise sibling app both consume it, so the board shows the same order in both. It does no file or network access and holds no state: it takes parsed rows and link maps in and returns an ordering or a plan out. See [Prioritisation](Prioritisation) for how that ordering relates to what the Overnight Agent works on, and [Domain-app](Domain-app) for the board that calls it.

## Why a separate package

Two apps need identical ordering. Copying the sort into each lets them drift, and a task would then sit in a different position depending on which app showed it. The package is deliberately the lowest-risk code to share first: it has no I/O and no host dependency, so it proves the packaging and distribution mechanism before anything business-critical is extracted. The README labels it a pilot, and issue #650 records the findings on that mechanism. Further extraction (search, board operations) is intentionally not done yet.

## Behaviour

**Manager priorities.** The `## Priorities` list on the board is a numbered list. The first item has rank 1, the next rank 2, and so on; non-numbered lines are ignored. Each item names a task ID or a priority label.

**Resolving a task to a manager priority.** Starting at the task, the resolver checks whether the task is itself a manager priority; if not, it follows the task's `Linked ID` to its parent and repeats. The first manager priority reached wins and gives the task its rank. The walk is bounded to 20 nodes and stops silently on a cycle or a missing link, returning "no manager priority". The depth of a task is the number of hops taken to reach it.

**Aliases.** An optional alias map translates an external ID (for example an ID from another system) to a canonical manager-priority ID. An alias resolves **at the current node** and is not another hop: if `a` links to `external` and the alias map says `external` is `p`, then `a` resolves to `p` at depth 1. Aliases are never followed recursively. A direct manager priority always beats an alias. Without an alias map, external links do not resolve.

**Sorting a section.** Rows are ordered by this key, first difference wins:

| Order | Key | Rationale |
| --- | --- | --- |
| 1 | 🔴 urgent rows before all others | Urgency is never outranked by importance of the parent. |
| 2 | Manager-priority rank, ascending; rows with none last | The manager's stated order of business decides before anything else. |
| 3 | Chain depth, **deepest first** | A prerequisite (further from the priority) is done before the thing that depends on it. |
| 4 | Icon: 🔴, 🐸, 🟡, 🔵, 📖, ⚪, ✅ | The Eisenhower-style icon breaks remaining ties. |

Rows whose key is equal keep their original order, and each sorted row stays paired with its raw source line so the board can rewrite the file without reordering mismatches. Snooze markers do not affect sorting — a snoozed row is not pushed to the bottom of its section. Cyclic links never crash the sort.

**Needed for an urgent task.** `isNeededForUrgentTask` answers whether a task links, directly or through a chain, to a 🔴 task. A task that is itself urgent but links only to non-urgent tasks is not "needed"; tasks without links are not; cycles terminate with false.

**Planning a move.** Moving a task between sections can carry its dependents with it. `computeMoveSet(rootId, priorities, links, activeIds, aliases)` returns an insertion-ordered set, root first, containing the root plus every other **active** task that resolves to the root as its manager priority. A root that is not a manager priority moves alone; an empty root returns an empty set. IDs are compared as exact strings (`030` is not `30`) and inputs are never mutated, including frozen ones.

`computeBrokenLinks(movingIds, links, nameLookup, aliases)` lists the links that a move would sever: links **from tasks left behind** to tasks in the moving set, in the input link order, as `{ fromId, fromName, toId }`. Links entirely inside the move set and unrelated links are omitted. A target reached through an alias adds `resolvedToId` while `toId` keeps the raw value; a direct hit omits `resolvedToId` even if an alias also matches. Missing names become the empty string. Null inputs yield an empty list. The functions only plan; renumbering, file writes and journal changes are the caller's business.

## Public exports

> [!NOTE]
> **Technical detail: package surface.** Optional implementation detail; the section above states the behaviour.

<details>
<summary><strong>Show modules and exports</strong></summary>

| Path | Exports | Role |
| --- | --- | --- |
| `packages/planner-shared-core/src/index.js` | `computeBrokenLinks`, `computeMoveSet` | Package root, re-exporting the sorting and moving helpers. |
| `packages/planner-shared-core/src/taskSort.js` | `extractTaskId`, `getChainDepthToManagerPriority`, `isNeededForUrgentTask`, `parseManagerPriorities`, `resolveManagerPriority`, `sortTasksByPriority` | Manager-priority parsing, chain resolution and the sort key. |
| `packages/planner-shared-core/src/taskMove.js` | `computeBrokenLinks`, `computeMoveSet` | Move planning; depends only on `taskSort.js`. |

`extractTaskId` accepts a row whose `ID` cell is a plain digit string or an object carrying an `id` such as `[42]`, and returns the digits or null.

</details>

## Requirements from tests

- An external link resolves at its existing depth with no extra hop; it does not resolve at all unless aliases are supplied; cycles are guarded and aliases are not traversed recursively.
- The 20-node cap holds for chains and for the move set; chains longer than 5 hops still resolve.
- Direct manager priority beats alias, including at depth zero.
- Aliased rows sort by manager rank before depth, urgent rows stay first, raw lines stay paired.
- Dependency chains sort prerequisite-first within one manager priority; manager order stays ahead of depth; red items float above non-red; Eisenhower priority breaks ties; snooze does not bottom-sort and snooze markers in raw rows are ignored; cyclic links keep a stable order.
- `computeMoveSet` keeps the root first and de-duplicates, handles empty/undefined roots, keeps a root absent from active IDs, excludes unresolved chains at the depth cap, and follows links rather than chaining aliases.
- `computeBrokenLinks` cases B1–B5: only incoming links from left-behind tasks; none within the move set; none unrelated; frozen inputs and exact IDs preserved; raw and resolved targets only for alias hits. Entry order is preserved and direct hits take precedence.
- The package root exports every sorting function unchanged alongside the move helpers.

## Failure modes and gaps

- A chain that exceeds 20 nodes, or contains a cycle, silently yields "no manager priority" and the task sorts as unprioritised; nothing warns.
- Issue #672 tracks an explicit opt-in alias capability that avoids drift in positional arguments, and #673 tracks gating flag profiles with packed-package compatibility and rollback checks. Neither is complete; today alias support rides on an optional trailing argument.
- Only sorting and moving are extracted. Board search and board operations remain in the app and are not shared.
