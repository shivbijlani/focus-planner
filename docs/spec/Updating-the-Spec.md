# Updating the Spec

This page is for whoever edits `docs/spec` next.

## The wiki is a mirror, not a second source

The GitHub wiki is published *from* `docs/spec` on `main`; it is not an independent editable copy.
Publishing overwrites the wiki repository's content with exactly what is in `docs/spec` and deletes
any wiki page that has no matching source file. **Never edit a wiki page directly** — the next
publish silently discards the edit, and if the edited page's filename was ever removed from the page
set, the publish removes the page outright.

## The page set is defined by two places that must agree

The task's page table (mirrored in `Home.md`'s index) and the actual files in `docs/spec` must match
exactly. **Adding a page means adding it in both places**: `Home.md` is regenerated every run from
the page table, so a page that exists as a file but is missing from that table is never linked from
`Home.md` and becomes unreachable from the wiki's front page even though `verify.mjs` still checks
it. Conversely, a row with no matching file fails generation immediately.

## The pipeline: collect → generate → verify → publish

1. **Collect** (`scripts/spec/collect.mjs`) — deterministic, model-free. Walks the repository and
   emits `spec-facts.json`: every module's path/domain/lines/exports/imports/doc-comment, every test
   name, every open issue, workflow definitions, package scripts and dependencies. This is the only
   file spec authorship reads as ground truth.
2. **Generate** — an agent (this process) reads `spec-facts.json` and writes the `docs/spec/*.md`
   pages, tracing every factual claim back to the facts file or to source opened directly.
3. **Verify** (`scripts/spec/verify.mjs`) — deterministic, model-free. Fails the build on any of the
   findings below. Run locally with:
   ```bash
   node scripts/spec/collect.mjs > spec-facts.json
   node scripts/spec/verify.mjs --facts spec-facts.json --dir docs/spec
   ```
4. **Publish** — pushes the verified `docs/spec` content to the wiki (see §Publish paths below).

`scripts/spec/conflicts.mjs` and `scripts/spec/verifyParity.mjs` are two further deterministic checks
in the same family: the former detects contradictory open-issue requirements, the latter keeps the
spec branch's own CI verification job textually identical to `ci.yml`'s, so its status badge cannot
quietly stop meaning what it says.

## Every finding `verify.mjs` can emit

| Finding | Meaning | Fix |
| --- | --- | --- |
| `invented-path` | A page references a `src/`, `scripts/`, `packages/` or `plugins/` file with a code extension that is not in `spec-facts.json`'s module list. | Remove the invented reference, or correct the path to a real one. |
| `unknown-issue` | A page cites `#N` where `N` is not in the facts file's valid reference set (`Roadmap.md` is additionally restricted to *open* issues only — see below). | Remove the citation, or correct the number. |
| `uncovered-domain` | An entry in `domains` has no `Domain-<name>.md` page. | Add the missing page. |
| `uncovered-key-module` | A domain's principal module (by line count/export weight) is never named by path anywhere in the spec. | Name the module explicitly on its domain page. |
| `thin-page` | A page is under the 250-word floor. | Add substantive content — this floor exists to catch stub pages, not to be padded past. |
| `no-examples` | No page anywhere in the spec contains a fenced code block. | Add at least one real, sourced code/data sample. |

## Issue references: open-only for `Roadmap.md`

`Roadmap.md` is validated against **open issues only**, because it exists to describe current gaps
and direction — a closed issue or merged PR referenced there would misstate the system's present
state. Every other page may cite any number in the facts file's broader valid-reference set,
including closed issues and PRs, when citing historical rationale (a fixed bug, a past incident).
Because the issue-reference pattern matches any bare `#` followed by digits not preceded by a word
character or slash, a closed issue or a PR must be named in prose on any page that isn't allowed to
match it as a reference — e.g. "pull request 552" rather than "#552" — if it would otherwise be
misread as an open-issue citation on a page where that matters.

## Publish paths and `WIKI_TOKEN`

Two paths exist:

1. **The CI workflow** (`.github/workflows/spec-wiki.yml`) — runs collect/generate/verify on a
   rolling `spec/auto` branch/PR, then publishes to the wiki once verification passes. Because a
   bot-authored PR cannot trigger GitHub's cascading `pull_request`-triggered status checks, this
   workflow additionally publishes its verification result via the Statuses API directly, so the PR
   still shows a real pass/fail rather than appearing permanently unchecked.
2. **`scripts/spec/publish-wiki.ps1`** — a direct, no-PR publish path for pushing an already-verified
   `docs/spec` straight to the wiki.

Both paths require a `WIKI_TOKEN` secret with write access to the wiki repository; publishing is
skipped (not failed) when the secret is absent, so a fork or a token-less environment can still run
collect/generate/verify locally without a broken publish step.

## Traps

- **`docs/spec/README.md` is not a page.** It is provenance for humans browsing the folder and is
  excluded from both `verify.mjs`'s page set and the publish step (`rm -f wiki/README.md` runs
  before publish). Never add it to the page table or link it from `Home.md`.
- **Wiki links fail silently.** A relative link to a page name that does not yet exist renders as a
  normal "create this page" link rather than an error — a typo in a link is invisible until someone
  clicks it.
- **A brand-new wiki needs one-time UI initialization.** GitHub does not let an API/git push create
  the *first* page of a wiki that has never been visited in the UI; someone must create one page by
  hand through the web UI once before either publish path can push to it.
- **Do not restate the bar inside a page.** Sentences like "a competent engineer should be able to
  rebuild X from this page alone" are instructions to whoever is writing the spec, not content a
  reader needs — they read as filler and lower the page's information density.
- **Do not specify legacy or backward-compatibility paths as if they were the contract.** Where a
  compatibility shim, deprecated alias, or migration fallback is still live in the code, either omit
  it or name it once as scheduled for removal — never describe it as required behaviour for a
  rebuild.
