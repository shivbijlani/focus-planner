// Re-exports the shared task-sorting logic, which now lives in
// packages/planner-shared-core (pilot for cross-repo package consumption,
// see issue #650). Kept as a thin shim so existing imports of
// `./taskSort.js` throughout this app continue to work unchanged, while
// this repo's own tests (taskSort.test.js) also exercise the shared
// implementation.
export * from '../packages/planner-shared-core/src/taskSort.js'
