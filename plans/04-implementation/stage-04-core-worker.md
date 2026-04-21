# Stage 4 — Core worker + RPC

## Goal
Wire the adapter + parsers into a single worker module with a typed RPC API.
Exercise it from a headless test, no UI.

## Deliverable
- `src/core/worker.ts` — the worker entry, exposes an API via Comlink
- `src/core/api.ts` — the typed surface (what UI will call)
- `src/core/worker.test.ts` — drives the worker from the main thread in Vitest

## API (minimum for V1)
```ts
interface PlannerApi {
  openFolder(adapter: StorageAdapter): Promise<void>
  getTodayTasks(): Promise<Task[]>
  getTomorrowTasks(): Promise<Task[]>
  getCompleted(week?: string): Promise<Task[]>
  deferTask(id: string, to: 'today' | 'tomorrow'): Promise<void>
  completeTask(id: string): Promise<void>
  editTask(id: string, patch: Partial<Task>): Promise<void>
  getJournal(taskId: string): Promise<Journal | null>
  setTodoDone(taskId: string, todoIndex: number, done: boolean): Promise<void>
}
```

## Tests
- `openFolder(InMemoryAdapter with fixtures)` → `getTodayTasks()` returns the seeded rows.
- `deferTask('42', 'tomorrow')` → next `getTodayTasks()` no longer includes 42, `getTomorrowTasks()` does.
- `completeTask('42')` → removed from focus-plan.md, appears in completed.md under current week.
- `setTodoDone('42', 0, true)` → journal file on disk has `DONE:` where it had `TODO:`.
- Every mutation: read file back via adapter, parse, assert state.
- Every mutation: re-call `getTodayTasks` (cold, forces re-read) — state matches.

## Structured-clone safety
- `worker.test.ts` must run the worker in a real Worker at least once to catch non-cloneable values slipping into the API.

## Done when
- Full task lifecycle (add → defer → complete) testable end-to-end with zero UI.

## Risks retired
- Comlink boundary corner cases.
- Core accidentally importing DOM or adapter-specific types.

## Out of scope
- Any React. Any styling. Any folder picker UX.
