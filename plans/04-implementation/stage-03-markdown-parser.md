# Stage 3 — Markdown parser

## Goal
Pure functions that parse and serialize every file format described in
`02-features/file-formats.md`, with byte-perfect round-tripping.

## Deliverable
- `src/core/parse/focusPlan.ts` — parse/serialize the table
- `src/core/parse/completed.ts` — parse/serialize the archive
- `src/core/parse/journal.ts` — parse/serialize journal bullets
- All three have `.test.ts` companions

## Tests (parser)
- Each sample from `02-features/file-formats.md` parses without throwing.
- Each sample round-trips byte-identically: `serialize(parse(x)) === x`.
- Unknown priority icons are preserved, not normalized.
- Empty sections preserved.
- Manager priority column accepts any free text, not a whitelist.
- Journal: `TODO:` and `DONE:` prefixes detected; other bullets are notes; order preserved.
- Journal: no GFM `[ ]`/`[x]` checkboxes emitted on serialize (even if some slip in on parse — normalize or preserve? **Decision: preserve on parse, never emit on serialize from app actions.**)

## Tests (robustness)
- Malformed table row → skip, keep rest. Emit a warning object in the result.
- Trailing newline: preserve whatever was there.
- Mixed line endings: preserve per-file.

## Done when
- 100% of file-formats.md examples round-trip.
- No parser touches `fetch`, `window`, or any adapter. Pure in/out.

## Risks retired
- Lossy parsing (the thing that would silently corrupt the user's files).

## Out of scope
- Adapter integration. Task-level operations (that's core worker).
