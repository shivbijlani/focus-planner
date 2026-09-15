# Reader-first wiki source

These pages explain the planner's behavior and design principles. Optional implementation detail
is collapsed; the architecture companion uses principles and diagrams rather than code.

Daily maintenance proposes a frozen revision in one persistent catch-up Doc, then publishes only
the exact human-approved snapshot. See the [maintenance runbook](../wiki-maintenance.md) for
deployment and [Keeping the wiki current](Updating-the-Spec.md) for the reading-level overview.
This folder is the accepted source, but committing pages alone does not publish them. This file is not a
spec page — it is not indexed from `Home.md` and is excluded from `verify.mjs`'s checks and from the
wiki publish step.
