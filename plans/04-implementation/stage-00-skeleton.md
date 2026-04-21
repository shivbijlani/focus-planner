# Stage 0 — Skeleton

## Goal
A running project with a green test suite. No app code yet.

## Deliverable
- Vite + React app that renders "Hello planner"
- Vitest configured, one passing smoke test
- GitHub Action: install, lint, test, build on every push
- `README.md` with `npm install && npm test && npm run dev`

## Tests
- `smoke.test.ts`: `expect(1 + 1).toBe(2)` — proves the runner works.
- `build.test` (in CI only): `npm run build` exits 0.

## Done when
- CI badge green on main.
- Fresh clone → `npm install && npm test` → green with zero warnings.

## Risks retired
- Toolchain choice (Vite, Vitest, TS-or-JSDoc) is now locked.
- CI works before there's anything to break.

## Out of scope
- Any app code.
- Any lint rules beyond the defaults.
- Any deploy config (that's stage 7).
