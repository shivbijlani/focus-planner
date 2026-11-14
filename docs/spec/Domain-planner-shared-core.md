# Domain: planner-shared-core

`planner-shared-core` is the one place where the board's **ordering rule** and its **move-with-dependents rule** are defined. The browser board, the planner tools that agents use over OneDrive, and the overnight agent's idea of "what comes first" all need the same answer to two questions: *in what order do tasks appear?* and *which tasks travel together when one task is moved?* It holds no UI, no I/O and no storage — only pure functions over already-parsed data — so every surface can import it without importing the others.

## Why a separate package

Priority is data, not judgement (see [Home](Home) and [Prioritisation](Prioritisation)). If the board sorted one way and an agent's tool sorted another, the planner would show the user one plan while the agent worked a different one. Putting the rule in a dependency-free package, rather than inside the app's source tree, lets both the app and `packages/planner-tools` use the identical implementation. The rejected alternative was a copy per consumer; copies drift, and drift here is user-visible as "the agent did the wrong thing first".

## Principal modules

> [!NOTE]
> **Technical detail: module map.** Paths and exports of the package.

<details>
<summary><strong>Show the package's modules and exports</strong></summary>

| Path | Role | Exports |
| --- | --- | --- |
| `packages/planner-shared-core/src/taskSort.js` | The full sort key and the dependency-chain helpers it is built from. | `parseManagerPriorities`, `resolveManagerPriority`, `getChainDepthToManagerPriority`, `isNeededForUrgentTask`, `extractTaskId`, `sortTasksByPriority` |
| `packages/planner-shared-core/src/taskMove.js` | Which tasks move together, and which links a move would break. Imports `taskSort.js`. | `computeMoveSet`, `computeBrokenLinks` |
| `packages/planner-shared-core/src/index.js` | Package root; re-exports the move functions. The sorting functions are exported from `taskSort.js` and must stay unchanged at the root. | `computeBrokenLinks`, `computeMoveSet` |

</details>

## Required behaviour

### Ordering: the sort key

Rows within one board section are ordered by a fixed sequence of comparisons; the first that differs decides.

1. **Red urgent rows first.** A row whose priority cell carries the urgent-and-important icon (🔴) sorts above every other row, regardless of anything below.
2. **Manager priority rank.** Each task resolves, by following its `Linked ID` chain upward, to the first task that is itself named in the `## Priorities` list. The lower the position in that list, the earlier the row. Rows that never reach a listed priority rank last.
3. **Chain depth, deepest first.** Among rows that resolve to the same manager priority, the one farthest from it in its chain comes first: prerequisites precede the things that depend on them. Rows with no chain rank below every row that has one.
4. **Eisenhower icon.** Remaining ties fall back to the icon order 🔴, 🐸, 🟡, 🔵, 📖, ⚪, ✅.
5. **Stability.** If ties remain, the original row order is kept. The sort never reorders on snooze markers: a snoozed row is **not** pushed to the bottom of its section, and snooze markers in the raw row text are ignored.

The sort returns the reordered rows **and** the raw markdown lines in the same order, so a caller can rewrite the file without reformatting untouched rows.

### Resolving a task to a manager priority

- The `## Priorities` list is a numbered list; each numbered item's text is a priority name and its position is its rank (first item = rank 1).
- Resolution walks `Linked ID` links from the task toward the root, stopping at the first task whose ID is a listed priority, with a **depth cap of 20 nodes** by default. A cycle returns "no priority" rather than looping, and chains longer than five hops still resolve.
- An optional **alias map** lets an *external* link (an ID that is not itself a board task) stand in for a listed priority. An alias is resolved at the depth it is found, with no extra hop; it is only consulted when the caller supplies one; and a direct listed priority wins over its alias. Aliases are never followed recursively.
- A numeric fourth argument is accepted as the depth limit in place of an alias map.
- A task is **needed for an urgent task** when following its links upward reaches a 🔴 row within the same depth cap. A task that is itself urgent but links only to non-urgent rows is not. Cycles and link-less tasks return false.

### Moving tasks together

- Moving a task that is a listed priority moves every active task that *resolves to* that priority, in root-first order. Moving a task that is not a priority moves only itself.
- IDs are compared as exact strings, the result is de-duplicated without reordering, and a chain too long to resolve inside the depth cap is excluded from the move set.
- Following links, not aliases, decides membership: an alias never chains onward.
- `computeBrokenLinks` reports every link that would be **left behind**: an incoming link from a task that stays to a task that moves. Links entirely inside the move set, and links unrelated to it, are not reported. A link that reaches the moving set only through an alias is reported with both the raw and the resolved target. Entry order follows the link map; a missing display name becomes an empty string; null inputs return an empty list.

## Failure modes

| Situation | Behaviour |
| --- | --- |
| Link cycle | Resolution returns "no priority"; sorting stays stable and never crashes. |
| Row with no numeric ID | Treated as having no manager priority and no chain depth. |
| Chain longer than the depth cap | Treated as unresolved; it is excluded from move sets and ranks last. |
| Missing priority list | Every row ranks equally on step 2, so urgency icons and chain depth decide. |

## Verification

The behaviours above are pinned by `packages/planner-shared-core/src/taskSort.test.js` and `packages/planner-shared-core/src/taskMove.test.js`; their names are restated as requirements in [Behaviour](Behaviour). The board consumes the sort through [Domain-app](Domain-app); the agent-side consequences of the same key are described in [Prioritisation](Prioritisation).
