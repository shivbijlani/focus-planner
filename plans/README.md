# Planner App — Rebuild Plans

These documents are enough for a capable LLM to rebuild the app from scratch.
Read in order.

1. `01-mvp/architecture.md` — what to build first; non-negotiable shape
2. `02-features/capabilities.md` — what the user can do (UI-agnostic)
3. `02-features/file-formats.md` — on-disk contract (part of the spec)
4. `02-features/ui-example.md` — one reasonable UI (illustrative, not prescriptive)
5. `03-future/architecture.md` — how to grow it without rewriting
6. `03-future/features.md` — future capabilities (UI-agnostic)
7. `03-future/ui-example.md` — future UI & packaging ideas (illustrative)
8. `04-implementation/README.md` — staged TDD build order (riskiest unknowns first)

Principles:
- Static site. No backend. Ever.
- UI is dumb. Logic lives in a worker behind a typed RPC.
- Storage is an adapter. V1 ships one adapter; future phases add more.
- Markdown files are the database. Human-readable, human-editable, portable.
