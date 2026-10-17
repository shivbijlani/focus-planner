# Domain: planner-shared-core

`planner-shared-core` is a small package of **pure, host-agnostic planner logic** that two deployments of the product are meant to consume as one implementation: how tasks are ordered by priority, and how a group of tasks that must move together is computed. It is a deliberate pilot: the smallest, lowest-risk module chosen to prove that a shared package can be consumed by more than one app before anything business-critical is extracted (#650). Product-level ordering rules are in [Prioritisation](Prioritisation); the board that feeds it is in [Data-Formats](Data-Formats).

## Responsibility

- Order the rows of a board section so the most important work comes first.
- Resolve which numbered **manager priority** a task ultimately serves, by following its `Linked ID` chain.
- Say whether a task is needed by an urgent task.
- Plan a move: given a root task, find every task that travels with it, and every link that the move would break.

The package performs **no I/O**, reads no files and depends on no host. It plans; the caller applies.

## The sort key

A board section is sorted by these keys, in order, with stable ordering when everything ties:

1. **Urgent first.** Rows with the 🔴 icon precede all others.
2. **Manager-priority rank.** Rows resolving to a higher-ranked entry of the `## Priorities` list come first; a row serving none sorts last.
3. **Chain depth.** Within the same manager priority, the row *deepest* in the dependency chain comes first, so prerequisites precede the work that needs them.
4. **Urgency icon.** Then the Eisenhower icon order: 🔴, 🐸, 🟡, 🔵, 📖, ⚪, ✅.

Snooze markers and snoozed rows do not change the sort position inside a section. Raw source lines stay paired with their parsed rows through sorting, so a caller can rewrite the file in the new order without re-serialising.

## Design decisions and rejected alternatives

| Decision | Rejected alternative | Why |
| --- | --- | --- |
| Manager rank outranks dependency depth. | Sorting purely by dependency depth. | The user's stated priorities are the product's purpose; dependency order only breaks ties among tasks serving the same priority. |
| Links are **followed, aliases are not**. An alias is resolved at the node where it is met, as a stopping check, not as another hop. | Treating aliases as extra graph edges. | An alias maps an external id to a canonical priority; walking it as an edge would change depths and make results depend on alias-map shape. Direct priorities beat aliases. |
| A 20-node cap with cycle detection; unresolved chains simply do not match. | Raising an error on a cycle or deep chain. | A user-edited board can contain a cycle. A planner must still render and sort. |
| Move planning compares **exact string ids** (`'030'` is not `'30'`) and never mutates its inputs. | Numeric comparison. | Ids are labels in a markdown table; numeric coercion would merge distinct tasks. |
| The package only *plans* moves: no renumbering, no task creation, no file changes. | Performing the move inside the package. | Applying a move touches storage, which is a host concern. |
| Aliases are an explicit opt-in capability. | Letting a positional argument change meaning. | Positional-argument drift is the compatibility hazard; further gating is open work (#672, #673). |

## Behavioural requirements

**Priority resolution**

- An external link resolves at its existing depth, without an extra hop; it resolves only when aliases are supplied.
- Cycles are guarded and aliases are not followed recursively.
- The default cap is 20 nodes.
- A direct manager priority beats its alias; aliases work at depth zero.
- Aliases sort by manager rank before depth, keeping urgent rows first.
- Manager priority resolves across chains longer than five hops.

**Sorting**

- Dependency chains sort prerequisite-first within the same manager priority.
- Manager priority order stays ahead of dependency depth.
- Red urgent items float above non-red items.
- When manager priority and depth match, the Eisenhower priority decides.
- Snoozed rows are not bottom-sorted within a section; snooze markers in raw rows are ignored by the sort.
- Cyclic links do not crash, and a stable order is preserved among ties.

**Urgent-need check**

- A task linking directly or indirectly to an urgent task is needed; one with no urgent task in its chain, or with no links, is not. An urgent task that links to a non-urgent one is not needed. Cycles terminate.

**Move planning**

- The move set starts with the root and keeps insertion order; an empty root yields an empty set; a root absent from the priorities moves alone.
- Only active tasks that resolve to the root join it; unresolved chains at the depth cap are excluded.
- Broken links are incoming links from tasks left behind: links inside the move set and unrelated links are omitted; alias hits report both the raw and the resolved target; direct hits take precedence; null inputs return nothing; frozen inputs are accepted and preserved.

The app's own `src/taskSort.js` re-exports the six sorting functions from this package without adapters, and the app runs the same sorting tests against it.

## Failure modes

| Failure | Behaviour |
| --- | --- |
| Link cycle or chain longer than the cap | The task is treated as serving no priority; sorting continues. |
| Missing id on a row | The row gets no manager rank and sorts after ranked rows. |
| Alias map absent | Aliases are simply not consulted. |

## What is unbuilt

The package is a pilot, not the finished shared core. The wider direction (one product consuming one shared core in two deployments, a Node journal-write path, a provider registry) is staged and mostly unstarted: see [Roadmap](Roadmap) and issues #650, #672, #673, #755.

> [!NOTE]
> **Technical detail: modules and exports.** Optional reference for implementers.

<details>
<summary><strong>Show modules and exports</strong></summary>

| Module | Exports | Role |
| --- | --- | --- |
| `packages/planner-shared-core/src/taskSort.js` | `parseManagerPriorities`, `resolveManagerPriority`, `getChainDepthToManagerPriority`, `isNeededForUrgentTask`, `extractTaskId`, `sortTasksByPriority` | Priority parsing, chain resolution, sorting. `parseManagerPriorities` reads the numbered lines of the `## Priorities` list into a name-to-rank map. |
| `packages/planner-shared-core/src/taskMove.js` | `computeMoveSet`, `computeBrokenLinks` | Move planning. `computeBrokenLinks` returns `{ fromId, fromName, toId }` entries, plus `resolvedToId` on alias hits. |
| `packages/planner-shared-core/src/index.js` | `computeBrokenLinks`, `computeMoveSet` | Package entry, which also re-exports every sorting function. |

</details>

See [Technical Architecture](Technical-Architecture) for how the shared core fits the module graph.
