# Feature Request: Multiple Focus Plan Folders + Virtual Combined View

## Summary
Support multiple folder-scoped `focus-plan.md` files in a single planner root and add a virtual `Combined View` folder in the sidebar.

The combined view is not backed by a real markdown file. It is a UI-only projection that renders tasks from every discovered focus plan and routes all actions to the correct underlying source file.

## User Problem
Today, planner behavior is optimized around a single root `focus-plan.md` and root `journal/` + `focus-plan-completed.md` files. Users who split work into multiple folders (for teams, projects, or contexts) cannot get one place to scan all active focus plans.

## Proposed User Experience
1. Sidebar includes a virtual folder named `Combined View`.
2. Inside that folder, users can open a virtual file `focus-plans.md`.
3. The combined screen shows one card per discovered `focus-plan.md` (root and nested folders).
4. Each card displays the same rich interactive task table users already use.
5. Every action updates the source folder files directly:
   - Move Today/Deferred updates that plan's `focus-plan.md`.
   - Move to Completed writes to that plan's `focus-plan-completed.md`.
   - Journal creation/reads use that plan's `journal/` folder.
6. The combined screen includes an `Open Source File` action for quick drill-in.

## Scope
In scope:
- Virtual combined view entry in sidebar.
- Discovery of all `focus-plan.md` files in the selected planner folder tree.
- Path-aware actions from focus plan UI for journals/completed/tasks.

Out of scope (follow-up candidates):
- Fully merged single-table sort/rank across all plans.
- Cross-plan ID deduping guarantees.
- Dedicated aggregated completed view.
- Per-plan filtering/grouping controls.

## Acceptance Criteria
- Selecting `Combined View/focus-plans.md` does not require a physical file.
- At least two folder-scoped focus plans can be viewed in one combined screen.
- Context-menu actions performed in a plan card update only that plan's files.
- Completed-task archival writes to sibling `focus-plan-completed.md` of the source plan.
- Journal actions read/write from sibling `journal/` of the source plan.
- Existing single-plan behavior remains unchanged when using root `focus-plan.md`.

## Risks
- Existing task IDs may overlap across plans; actions are line-based and folder-scoped, not globally unique.
- Very large numbers of plans could increase initial combined-view load time.
- Current per-plan task ordering remains local to each plan card (not globally merged).

## Notes for Review
This feature intentionally starts with a low-risk architecture:
- Keep existing `FocusPlanView` behavior and add path-awareness.
- Build combined UX as a virtual composition of existing plan cards.
- Avoid introducing any synthetic persisted markdown format.
