# Implementation Plan

Build order. Each stage is a self-contained PR with its own test suite. No stage
is "done" until its tests are green and the stage can be demoed end-to-end.

## Ordering principle

**Retire the biggest unknown first.** A stage's position is set by how much it
would hurt to discover it doesn't work in stage 6 instead of stage 2.

## Stages

| # | Stage | Risk retired | Shippable demo |
|---|---|---|---|
| 0 | [Skeleton](./stage-00-skeleton.md) | Toolchain, CI, test runner | `npm test` green |
| 1 | [Adapter contract + InMemory](./stage-01-adapter-contract.md) | Interface shape | Conformance suite green on InMemory |
| 2 | [FSA adapter](./stage-02-fsa-adapter.md) | **FSA permission + handle persistence** — biggest unknown | Pick folder, read a file, reload, still works |
| 3 | [Markdown parser](./stage-03-markdown-parser.md) | Format round-tripping | Parse → serialize → byte-identical |
| 4 | [Core worker + RPC](./stage-04-core-worker.md) | Comlink boundary, structured-clone safety | UI-less script drives worker end to end |
| 5 | [UI shell](./stage-05-ui-shell.md) | Folder picker → real data on screen | Open folder, see focus plan |
| 6 | [Mutations](./stage-06-mutations.md) | Writes round-trip to disk | Defer, complete, edit, toggle todo |
| 7 | [Deploy](./stage-07-deploy.md) | GH Pages base path, first-load UX | Public URL works in incognito |

## Rules for every stage

- **Tests first.** Write the failing test, then the code.
- **No stage depends on a later stage.** Each is demoable alone.
- **Conformance suite is shared.** Every adapter (now and future) passes the
  same tests from stage 1.
- **No UI work before stage 5.** The core must be exercisable by a test script
  with no DOM.
- **Stop at stage boundaries.** Don't bleed work forward to "save time". The
  seams exist to catch mistakes.

## What the LLM gets at each stage

At the start of a stage, the LLM sees:
- `plans/01-mvp/architecture.md`
- `plans/02-features/capabilities.md`
- `plans/02-features/file-formats.md`
- This stage's markdown file
- Previous stages' code (already merged)

Nothing else. If a stage can't be completed with just that context, the stage
is too big — split it.
