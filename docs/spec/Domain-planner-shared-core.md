# Domain: planner-shared-core

`planner-shared-core` is the one place where the question "which task comes first, and which tasks travel together?" is answered. The board UI and any other surface that orders or moves tasks import these functions instead of reimplementing them, so every surface derives the same order from the same board. It has no dependencies and no I/O: it works on rows, link maps and priority maps that callers have already parsed. See [Prioritisation](Prioritisation) for how the order is expressed to the user and consumed by the overnight agent.

## Responsibility

Two jobs, both pure:

1. **Sorting.** Given the rows of a board section, the `Linked ID` map and the manager-priority list, produce the order the board displays.
2. **Move sets.** When a manager-priority task is moved between sections (for example Today to Tomorrow), compute which linked tasks move with it, and which tasks left behind would lose their link.

## Why a shared package

The alternative — each surface carrying its own copy of the sort — is rejected because the order is a product promise (a task that is "first" in one surface must be first in every surface that orders it). Two copies drift. Open issues #650, #672 and #673 describe the staged intent: prove that a packed package can be consumed by a second consumer (`taskSort.js` is the pilot), add alias support as an explicit opt-in rather than by growing positional arguments, and gate behaviour changes behind flag profiles with rollback checks. Those are direction, not shipped.

## The ordering rule

Rows are compared by these keys, in order; the first difference decides.

| Rank | Key | Rule |
| --- | --- | --- |
| 1 | Urgency | A row whose priority cell holds the red urgent icon (🔴) sorts above every non-red row. |
| 2 | Manager priority | The row's task id is resolved to a manager priority (see below); a lower list position wins; rows resolving to none sort last. |
| 3 | Chain depth | Among rows with the same manager priority, a row *deeper* in the link chain sorts first, so prerequisites precede the tasks that depend on them. A row not connected to a manager priority ranks below any connected one. |
| 4 | Eisenhower icon | Red, frog, yellow, blue, learning, grey, done — in that order. |

Ties after all four keys keep input order (the sort is stable), and each row stays paired with its raw markdown line so the caller can rewrite the file in the new order without reformatting it. Snoozed rows are not moved to the bottom of their section by this module, and snooze markers in raw lines are ignored during sorting.

**Manager priority resolution.** The `## Priorities` list is a numbered markdown list; list position is the rank. A task resolves by following its `Linked ID` chain until it reaches an id that is a priority. A direct priority beats an alias of it. The walk stops at a cycle or after 20 nodes and resolves to nothing; chains longer than five hops still resolve. An optional alias map lets a link to an external id count as the priority it stands for, at the depth it was found (no extra hop).

> [!NOTE]
> **Technical detail: public exports and call shapes.** Optional reference for rebuilders.

<details>
<summary><strong>Show exports, signatures and move-set rules</strong></summary>

| Path | Exports | Role |
| --- | --- | --- |
| `packages/planner-shared-core/src/taskSort.js` | `extractTaskId`, `getChainDepthToManagerPriority`, `isNeededForUrgentTask`, `parseManagerPriorities`, `resolveManagerPriority`, `sortTasksByPriority` | The ordering rule and its helpers. |
| `packages/planner-shared-core/src/taskMove.js` | `computeBrokenLinks`, `computeMoveSet` | Which tasks move with a root, and which links break. |
| `packages/planner-shared-core/src/index.js` | `computeBrokenLinks`, `computeMoveSet` | Package entry; also keeps every existing sorting export reachable at the package root. |

```text
parseManagerPriorities(lines)            -> { "<priority text>": 1, ... }   // "1. Text" lines, rank = order
resolveManagerPriority(id, links, prios, aliasesOrMaxDepth = {}, maxDepth = 20) -> { id, order } | null
getChainDepthToManagerPriority(...same)  -> hops to a priority | null
isNeededForUrgentTask(id, links, priorityByTask, maxDepth = 20) -> boolean
sortTasksByPriority(rows, rawLines, headers, links, prios, aliases = {}) -> { sortedRows, sortedRawLines }
computeMoveSet(rootId, prios, links, activeIds, aliases = {}) -> Set<id>
computeBrokenLinks(movingIds, links, nameLookup = {}, aliases = {}) -> [{ fromId, fromName, toId, resolvedToId? }]
```

The sixth argument of `sortTasksByPriority` is an alias map; a fourth numeric argument to the resolvers is a depth cap and a fifth is ignored.

`computeMoveSet` always contains the root. If the root is not itself a manager priority the set is just the root. Otherwise it adds every active id whose resolved manager priority *is* the root; chains that exceed the depth cap are excluded. Ids are compared as exact strings, deduplicated, input order preserved, and active ids may be an array or an id-keyed object.

`computeBrokenLinks` reports a link only when its source stays behind and its target moves (directly, or through an alias whose resolved id moves, in which case `resolvedToId` is included); links inside the move set or unrelated to it are omitted. Null inputs return an empty list; direct hits take precedence over alias hits; entry order and exact ids are preserved and frozen inputs are accepted.

`isNeededForUrgentTask` starts at the task's *link target* and returns true if any task on the chain has a red priority; it is false when the task itself is urgent but links to a non-urgent one, when no links exist, or when the chain cycles.

</details>

## Behavioural requirements

Derived from `packages/planner-shared-core/src/taskSort.test.js` and `taskMove.test.js`.

- Dependency chains order prerequisite-first inside one manager priority; manager-priority order still beats chain depth.
- Red urgent rows float above non-red rows; when manager priority and depth tie, the Eisenhower icon decides.
- A direct manager priority beats its alias, including at depth zero; aliases sort by manager rank before depth, with urgent rows still first and raw lines kept paired.
- External links resolve only when aliases are supplied, at their existing depth; aliases are not traversed recursively.
- Cycles never hang or crash and leave a stable order; the 20-node default cap applies to both call forms.
- Snoozed rows are not bottom-sorted within a section, and snooze markers in raw lines are ignored.
- Move sets keep root-first order, tolerate empty or undefined roots and aliases, and follow links rather than chaining aliases.
- Broken-link reporting covers only incoming links from tasks left behind, never links inside the move set.

## Failure modes

A cyclic or over-long `Linked ID` chain resolves to "no manager priority" rather than erroring, so a malformed board sorts those rows last instead of failing the render. A task with no parsable numeric id is never resolved and sorts after those that are. There is no validation that a priority text matches a task id: a priorities list that names ids that do not exist silently ranks nothing.
