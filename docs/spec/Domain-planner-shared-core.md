# Domain: planner-shared-core

`planner-shared-core` is a small, dependency-free package that holds the planner's **task-ordering and task-move rules** as pure functions. It exists so that one definition of "which task comes first" and "which tasks travel together" can be consumed by more than one product build instead of being copied into each.

## Responsibility

The package answers three questions, using only data passed in (no file access, no clock, no storage):

1. **How does a task relate to a manager priority?** A task is ranked by the first manager priority it reaches by following its `Linked ID` chain. Following the chain stops at a depth cap (20 hops by default), and a cycle or a chain that never reaches a manager priority resolves to "none".
2. **In what order are tasks listed?** Within a section, tasks sort by manager-priority rank first, then by how many hops separate the task from that priority (prerequisites before dependants), with urgent (🔴) rows floating above non-urgent ones and the Eisenhower urgency icon as the final tie-break. See [Prioritisation](Prioritisation) for the board-wide sort key this implements.
3. **What moves together, and what breaks?** When a manager priority is moved between sections, the move set is that priority plus every active task that resolves to it; the broken-link report lists links from tasks left behind into the moving set.

The design choice behind the package is that ordering is **data-driven and deterministic**: the same board always sorts the same way, on every surface, so the board UI and any other consumer never disagree about order. The rejected alternative is each product keeping its own copy of the sort, which drifts silently (the motivation recorded in the shared-code pilot, #650).

## Principal modules

> [!NOTE]
> **Technical detail: module and export table.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show modules and exports</strong></summary>

| Path | Exports | Role |
| --- | --- | --- |
| `packages/planner-shared-core/src/taskSort.js` | `extractTaskId`, `getChainDepthToManagerPriority`, `isNeededForUrgentTask`, `parseManagerPriorities`, `resolveManagerPriority`, `sortTasksByPriority` | Priority parsing, chain resolution and the sort. |
| `packages/planner-shared-core/src/taskMove.js` | `computeBrokenLinks`, `computeMoveSet` | Move-set and broken-link computation, built on `resolveManagerPriority`. |
| `packages/planner-shared-core/src/index.js` | `computeBrokenLinks`, `computeMoveSet` | Package entry that re-exposes the move helpers beside the sorting exports. |

The app keeps its own `src/taskSort.js` (and `src/taskSort.test.js`) alongside this package; extracting the app's copy onto the package is the pilot tracked by #650.

</details>

## Behavioural requirements

Derived from `packages/planner-shared-core/src/taskSort.test.js` and `taskMove.test.js`.

- **Manager priorities** come from a numbered list; the Nth item has order N.
- **Order precedence:** manager-priority rank outranks dependency depth; depth orders prerequisites first within one rank; red urgent items still float above non-red; Eisenhower priority breaks remaining ties; remaining ties keep input order (stable).
- **Snooze does not affect order:** snoozed rows are not sunk within their section, and snooze markers in raw task rows are ignored by the sort.
- **Cycles never crash** and never loop; chains longer than five hops still resolve (the cap is 20 by default, and a numeric fourth argument overrides it).
- **Aliases (external links)** resolve only when an alias map is supplied; a direct manager priority beats its alias; an alias hit costs no extra hop; aliases are not traversed recursively; aliased rows sort by manager rank before depth while raw lines stay paired with their rows.
- **`isNeededForUrgentTask`:** true when the task links, directly or indirectly, to an 🔴 task; false when no task on the chain is urgent, when the task itself is urgent but links to non-urgent, for tasks with no links, and it terminates on cycles.
- **Move set:** root-first order is preserved; an empty or undefined root yields an empty set; a root that is not a manager priority moves alone; IDs compare as exact strings and duplicates collapse without reordering; unresolved chains at the depth cap are excluded; links are followed rather than chained through aliases.
- **Broken links:** only incoming links from tasks *left behind* are reported (B1); links inside the move set (B2) and unrelated links (B3) are omitted; frozen input arrays are accepted and exact IDs preserved (B4); a link that reaches the move set only through an alias reports both raw and resolved target (B5); null inputs return no links; direct hits take precedence over alias hits; entry order is preserved and names default to empty.
- **Export stability:** adding the move helpers keeps every existing sorting export unchanged at the package root.

## Known gaps and direction

The package is a pilot, not yet the app's only copy. Open work: an explicit, opt-in alias capability that does not rely on positional-argument overloading (#672), and gated flag profiles with packed-package compatibility and rollback checks (#673). The current signature accepts either a numeric depth limit or an alias map in the same positional slot; that overload is the "positional-argument drift" #672 is meant to retire, so a rebuild should expose aliases as an explicit option instead. The broader plan for sharing code between two deployments is mapped in #755.

## Failure modes

A resolver that does not guard cycles hangs the board; one that lacks the depth cap lets a pathological link chain consume unbounded time. A consumer that supplies aliases positionally to a version that does not know them silently loses alias ordering — the failure the pilot report on #650 observed in two consumer tests.
