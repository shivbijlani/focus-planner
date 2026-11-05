# @shivbijlani/planner-shared-core

Pilot package extracted from [focus-planner](https://github.com/shivbijlani/focus-planner)
to validate cross-repo shared-package consumption (see
[issue #650](https://github.com/shivbijlani/focus-planner/issues/650)).

Contains `taskSort.js` and `taskMove.js`: pure, host-agnostic task-sorting,
priority-resolution, and alias-aware move-planning
logic used by both the public Focus Planner app (Repo A, this repo) and the
enterprise `focus-planner-ado-codeapp` (Repo B). No I/O, no host dependencies —
chosen as the lowest-risk candidate to prove the mechanism before extracting
anything business-critical.

## Usage

```js
import { sortTasksByPriority, isNeededForUrgentTask } from '@shivbijlani/planner-shared-core'
```

## Status

This is a pilot/proof-of-concept package. See the write-up in issue #650 for
findings on the packaging/distribution mechanism before expanding this to
other modules (`boardSearch.js`, `focusPlanOps.js`, etc.).

## API compatibility

The package root exports all eight functions:

```js
parseManagerPriorities(lines)
resolveManagerPriority(taskId, linkedIdMap, managerPriorities, aliasMapOrMaxDepth = {}, maybeMaxDepth = 20)
getChainDepthToManagerPriority(taskId, linkedIdMap, managerPriorities, aliasMapOrMaxDepth = {}, maybeMaxDepth = 20)
isNeededForUrgentTask(taskId, linkedIdMap, taskPriorityLookup, maxDepth = 20)
extractTaskId(row)
sortTasksByPriority(rows, rawLines, headers, linkedIdMap, managerPriorities, aliasMap = {})
computeMoveSet(rootId, priorities, links, activeIds, aliases = {})
computeBrokenLinks(movingIds, links, nameLookup = {}, aliases = {})
```

For the two manager-priority lookups, a numeric fourth argument retains the
legacy depth limit (the fifth argument is ignored). An object fourth argument
maps external IDs to canonical manager-priority IDs; the optional fifth argument
sets the depth limit. Existing enterprise alias-map callers need no adapter.

Direct priorities take precedence over aliases. An alias resolves at the
current node, not as another graph hop: `a -> external`, with alias
`external -> p`, resolves to priority `p` at depth 1. Aliases are not recursively
followed. The default limit checks 20 nodes (depths 0 through 19), with the same
cycle guards as the legacy numeric-depth form.

Sorting accepts aliases as its sixth argument and preserves urgent-first,
manager-rank-before-depth ordering and stable row/raw-line pairing. Legacy
unused date arguments in the sixth position remain ignored.

## Task moves

`computeMoveSet` returns an insertion-ordered `Set<string>`, with the root first.
An empty or null root returns an empty set. A root absent from `priorities`
moves alone; otherwise, each other active ID is included only when the existing
`resolveManagerPriority` resolver resolves it to that root. `activeIds` can be
an array or an object (whose keys supply iteration order). No inactive IDs are
added except the root itself. Cycles and the default 20-node depth cap silently
exclude unresolved tasks, exactly as sorting does. Aliases use the same
single-hop stopping check and direct-priority precedence as the resolver;
they are not additional edges to walk.

`computeBrokenLinks` accepts a set or array of moving IDs and returns incoming
links from tasks left behind, in `Object.entries(links)` order:
`{ fromId, fromName, toId }`. Missing or falsy names become `''`. A raw target
in the move set is a direct hit. Otherwise, a single alias target in the move
set is an alias hit and adds `resolvedToId`, while `toId` retains the raw link
value. Direct hits omit `resolvedToId`, even when an alias also matches.
Null moving IDs or links return `[]`.

Both helpers compare exact string IDs (`'030'` is not `'30'`) and leave all
inputs unchanged, including frozen arrays, objects, and alias maps. They only
plan moves: no app wiring, ID renumbering, task creation, I/O, or journal/file
format changes are performed. `taskMove.js` depends only on `./taskSort.js`.
