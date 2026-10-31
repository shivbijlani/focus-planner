# Domain: planner-shared-core

`planner-shared-core` is the one place where the rule "which task comes first, and which tasks must travel together when one moves" is written down as code. It is a small, pure package: it takes already-parsed board data in and returns an ordering or a set of task ids. It reads no files, calls no network and knows nothing about React, the server or the agent. See [Prioritisation](Prioritisation) for the product behaviour these functions implement and [Domain-app](Domain-app) for the board that consumes them.

## Why it exists as a package

The same ordering rule has to hold in more than one product. The public Focus Planner app uses it, and a separate enterprise sibling product consumes the same rules. The first design alternative, copying the sort into each repository, was rejected because two copies of a ranking rule drift silently and the same task list then renders in a different order in each product. The chosen design extracts the pure functions into a package that both consume. Issue #650 states the experiment explicitly: this is a **pilot** to prove that a shared package can be consumed across repositories before anything business-critical (board search, board mutation helpers) is extracted. The sort and move planning were chosen because they are pure and low-risk.

The app does not carry its own sort: `src/taskSort.js` re-exports the package, so there is a single implementation in the app.

## Required behaviour

**Manager priorities.** A numbered list under the board's priorities section is read in order; each entry's rank is its position (first entry is rank 1). Non-list lines are ignored.

**Resolving a task to a manager priority.** A task resolves to a manager priority by walking its `Linked ID` parent chain until it reaches a task whose id is itself a manager priority.

- A direct manager priority always beats an alias for the same node.
- An optional alias map translates an external id (for example, an id from another system) into a canonical manager-priority id. The alias is applied *at the node being examined*; it is not another hop. `a → external` with alias `external → p` resolves to `p` at depth 1.
- Aliases are never followed recursively.
- The walk examines at most 20 nodes (depths 0–19) and returns "no priority" on a cycle or when the cap is reached. Chains longer than five hops resolve correctly.
- A caller may lower or raise the depth cap.

**Dependency depth.** The same walk reports how many hops separate a task from its manager priority, or "none".

**Urgent dependency.** A task is "needed for an urgent task" when any task along its own link chain (starting from the task it links *to*, not itself) carries the 🔴 icon. A task that is itself urgent but links only to non-urgent work is not "needed". Cycles terminate and yield false; a task with no link yields false.

**Sorting.** Rows are ordered by this key, each tier breaking ties from the one before:

1. 🔴 urgent rows first.
2. Manager-priority rank (rows with no manager priority sort after all ranked rows).
3. Dependency depth, **deepest first**, so a prerequisite is listed before the task that needs it; rows with no chain sort after rows with one.
4. Eisenhower icon order: 🔴, 🐸, 🟡, 🔵, 📖, ⚪, ✅.

The sort is stable for remaining ties, survives cyclic links without throwing, never reads snooze markers (snoozed rows are **not** bottom-sorted; snooze is a scheduling concern, not a display one), and returns each parsed row paired with its raw markdown line so a caller can rewrite the file in the new order without re-serialising.

**Move planning.** Moving a manager-priority task between Today and Deferred must carry its dependents with it, and the user must be warned about links the move would sever.

- `computeMoveSet` returns the root id first, followed by every *active* task whose resolution reaches that root, in the order the active ids were supplied. A root that is not itself a manager priority moves alone. Empty or missing roots yield an empty set. Ids are compared as exact strings (`030` is not `30`). Cycles and the depth cap exclude unresolved tasks, exactly as sorting does. Aliases follow the resolver's rules (single hop, direct precedence) and are not extra edges.
- `computeBrokenLinks` returns the incoming links from tasks *left behind* that point into the move set, in link-table order, as `{ fromId, fromName, toId }` with a blank name when unknown. Links within the move set and unrelated links are omitted. A target reached only through an alias additionally carries `resolvedToId`; a direct hit never does. Null inputs yield an empty list.
- Neither helper mutates its inputs (frozen arrays and objects are accepted) and neither performs a move: they only plan.

> [!NOTE]
> **Technical detail: modules and exports.** Optional reference; the sections above state the behaviour.

<details>
<summary><strong>Show modules, exports and signatures</strong></summary>

| Path | Exports | Role |
| --- | --- | --- |
| `packages/planner-shared-core/src/taskSort.js` | `parseManagerPriorities`, `resolveManagerPriority`, `getChainDepthToManagerPriority`, `isNeededForUrgentTask`, `extractTaskId`, `sortTasksByPriority` | Ordering and priority resolution. |
| `packages/planner-shared-core/src/taskMove.js` | `computeMoveSet`, `computeBrokenLinks` | Move planning; imports only `taskSort.js`. |
| `packages/planner-shared-core/src/index.js` | re-exports all eight functions | Package root. |

```js
parseManagerPriorities(lines)                       // { "<name or id>": rank }
resolveManagerPriority(taskId, linkedIdMap, managerPriorities, aliasMap = {}, maxDepth = 20) // { id, order } | null
getChainDepthToManagerPriority(taskId, linkedIdMap, managerPriorities, aliasMap = {}, maxDepth = 20) // number | null
isNeededForUrgentTask(taskId, linkedIdMap, taskPriorityLookup, maxDepth = 20)
extractTaskId(row)                                  // digits from row.ID (string or { id }) | null
sortTasksByPriority(rows, rawLines, headers, linkedIdMap, managerPriorities, aliasMap = {})
  // -> { sortedRows, sortedRawLines }
computeMoveSet(rootId, priorities, links, activeIds, aliases = {})   // Set<string>, root first
computeBrokenLinks(movingIds, links, nameLookup = {}, aliases = {})  // [{ fromId, fromName, toId, resolvedToId? }]
```

The priority column is the header containing 🎯. The package root, `taskSort.js` and `taskMove.js` currently also accept a numeric fourth argument as the depth cap and ignore a stray non-object sixth argument to the sort. Those are caller-compatibility shims for the enterprise sibling; a rebuild takes the aliases-then-depth form only.

</details>

## Tests as requirements

The two test files `packages/planner-shared-core/src/taskSort.test.js` and `packages/planner-shared-core/src/taskMove.test.js` pin: external links resolve at their existing depth without an extra hop; aliases are not followed recursively; the default 20-node cap holds; manager rank outranks depth; urgent rows float above non-urgent rows; dependency chains order prerequisite-first; the Eisenhower fallback applies when rank and depth tie; snoozed rows are not bottom-sorted; cycles do not crash; broken-link reports B1–B5 (only incoming links from left-behind tasks, none inside the move set, none unrelated, frozen inputs accepted, alias hits carry `resolvedToId`); and the package root keeps every sorting export.

## Gaps and direction

Issue #650 records the pilot findings on packaging and distribution. Issues #672 and #673 describe the next step: an explicit **opt-in** alias capability that does not rely on positional-argument conventions, and flag profiles gated by packed-package compatibility and rollback checks. Until they land, alias behaviour is selected by argument position, which is the weakest part of the API. Issue #755 maps the remaining shared-product work into incremental slices.

## Failure modes

| Failure | Behaviour |
| --- | --- |
| Cyclic `Linked ID` chain | Resolution returns "no priority"; the sort stays stable. |
| Chain deeper than the cap | Treated as unresolved, not as an error. |
| Alias points at an id with no priority | Ignored; the walk continues along the link. |
