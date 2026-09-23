# @shivbijlani/planner-shared-core

Pilot package extracted from [focus-planner](https://github.com/shivbijlani/focus-planner)
to validate cross-repo shared-package consumption (see
[issue #650](https://github.com/shivbijlani/focus-planner/issues/650)).

Contains `taskSort.js`: pure, host-agnostic task-sorting/priority-resolution
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
other modules (`boardSearch.js`, `moveTask.js`, `focusPlanOps.js`, etc.).
