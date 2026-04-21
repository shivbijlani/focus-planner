# Stage 1 — Adapter contract + InMemoryAdapter

## Goal
Lock the `StorageAdapter` interface by implementing the simplest possible
version of it, plus the shared test suite every future adapter must pass.

## Deliverable
- `src/storage/StorageAdapter.ts` — interface only, no implementation
- `src/storage/InMemoryAdapter.ts` — a `Map<string, string>`-backed adapter
- `src/storage/conformance.ts` — exported test function any adapter can be fed
- `src/storage/InMemoryAdapter.test.ts` — calls the conformance suite

## Interface (from 01-mvp/architecture.md)
```ts
interface StorageAdapter {
  listFiles(dir?: string): Promise<string[]>
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  exists(path: string): Promise<boolean>
}
```

## Conformance tests (the contract)
The suite must cover:
1. `readFile` on a nonexistent path throws `NotFoundError`.
2. `writeFile` then `readFile` returns the exact same string (UTF-8, emoji, CRLF preserved).
3. `exists` returns false before write, true after.
4. `writeFile` on existing path overwrites.
5. `listFiles()` returns paths relative to root.
6. `listFiles("journal")` returns only children of `journal/`.
7. `listFiles()` on empty root returns `[]`, not throws.
8. Paths use `/` as separator on every platform.
9. Writing `journal/task-1.md` when `journal/` doesn't exist succeeds (dirs auto-created).
10. Round-trip: write 100 files, list, read each, all match.

## Done when
- Conformance suite passes against `InMemoryAdapter`.
- Suite is exported so stages 2, and any future adapter, can import it.

## Risks retired
- Interface shape. Anything missing shows up now, not in stage 6.
- Error class hierarchy (`NotFoundError`, `PermissionError`).

## Out of scope
- Real filesystem. Watchers. Any async I/O beyond `Promise.resolve`.
