# Updating the Spec

This spec is generated, not hand-authored, and this page is the maintenance guide for whoever edits
the generator next.

## The wiki is a mirror; `docs/spec` on `main` is the source of truth

The GitHub wiki is populated by copying `docs/spec/*.md` verbatim; it is never edited directly. The
publish step mirrors by deletion-then-copy — every `.md` already in the wiki is deleted before the
current `docs/spec` pages are copied in — so **a page removed from `docs/spec` disappears from the
wiki on the next publish**, and a page edited only in the wiki UI is silently overwritten on the next
scheduled run. There is exactly one place to make a durable change: this folder, on `main`.

## Adding a page

A page is reachable from the wiki only if it is linked from `Home.md`. `Home.md` is itself regenerated
every run, so a link added to it by hand does not survive the next regeneration. **Adding a page
therefore means adding a row to the page-set table the generator's prompt is built from** (the same
table this task was given), not only adding a `Home.md` link — an unlisted page is silently dropped
from the index on the very next run that touches `Home.md`.

## The pipeline: collect → generate → verify → publish

| Stage | Tool | Model involved? |
| --- | --- | --- |
| 1. Collect facts | `scripts/spec/collect.mjs` | No |
| 2. Write the prose | Copilot CLI, driven by `scripts/spec/prompt.md` | Yes |
| 3. Verify against the code | `scripts/spec/verify.mjs` | No |
| 4. Flag contradictions | `scripts/spec/conflicts.mjs` | No |
| 5. Open/update a PR, then publish | `.github/workflows/spec-wiki.yml` | No |

Collection and verification are deterministic; only the prose-writing step involves a model. This
split exists because handing a model the repo and asking for a spec produces fluent prose that drifts
from the code immediately, in a way a reader cannot detect — what's wrong is the spec's *relationship*
to the code, which the reader does not have in front of them to compare against. `collect.mjs`
extracts ground truth (module graph, exports, tests, workflows, open issues) into `spec-facts.json`;
the model writes prose from that file; `verify.mjs` then fails the build if the prose references
anything `collect.mjs` didn't observe, or omits required coverage.

**Running the mechanical halves locally:**

```bash
node scripts/spec/collect.mjs --out spec-facts.json
node scripts/spec/verify.mjs --facts spec-facts.json --dir docs/spec
```

Both are deterministic and require no model or network access beyond `collect.mjs`'s use of `GH_TOKEN`
to read open issues.

## What `verify.mjs` can report

| Finding | Meaning |
| --- | --- |
| `invented-path` | A `src/`, `scripts/`, `packages/` or `plugins/`-rooted path ending in `.js`/`.jsx`/`.ts`/`.tsx`/`.mjs` appears in the spec but is not in `collect.mjs`'s module or test-file lists. Paths with other extensions (`.ps1`, `.md`, `.json`) are not checked this way — they can be cited freely, but should still be real. |
| `unknown-issue` | A `#NNN` reference does not resolve against the allowed issue set for that page (see below). |
| `uncovered-domain` | A string in `facts.domains` never appears anywhere across the spec. |
| `uncovered-key-module` | A domain's single largest module (by line count) is never named anywhere across the spec. |
| `thin-page` | A page falls under the minimum word count. |
| `no-examples` | No fenced code block appears anywhere across the whole spec. |

A clean run prints one line and exits 0; any finding prints every occurrence (capped per kind) and
exits 1, failing the workflow's `generate` job before a PR with broken references can be opened.

## Issue references: open-only on `Roadmap.md`, open-or-closed-or-PR elsewhere

Every other page accepts a broad set (open issues, closed issues, and PRs) because a closed issue is
still valid *rationale* — "this was fixed because of issue #NNN" is a true, useful sentence about a
closed issue. `Roadmap.md` is the one page that describes **currently open** gaps, so it is checked
against the open-issue set only: a closed issue cited there as if it were still a live gap is a
`unknown-issue` finding. **When a maintenance note or historical rationale needs to reference a closed
issue or a pull request on `Roadmap.md`, name it in words** ("the now-closed consent-marker issue")
rather than as a bare `#NNN` — the verifier's pattern is deliberately how the two cases are
distinguished, and hiding a closed reference from the pattern is the correct way to cite it there, not
a workaround.

## Publishing: two paths, one requirement

`publish-wiki` runs whenever the workflow fires on its schedule, or on a manual `workflow_dispatch`
with `publish_wiki: true` — both are gated on the same `WIKI_TOKEN` secret. `GITHUB_TOKEN` cannot push
to `owner/repo.wiki.git` (a separate repository outside its scope), so a personal-access-token secret
named `WIKI_TOKEN` is required; the publish job is **skipped, not failed,** when it is absent, so the
generate-and-verify loop still works with zero extra setup for anyone who hasn't configured the wiki
yet.

## Traps

- **`README.md` is not a spec page.** It documents the pipeline for humans browsing `docs/spec` on
  GitHub and is deliberately excluded from both `verify.mjs`'s page set and the wiki mirror (the
  publish step removes it explicitly after copying). Do not add it to the page-set table.
- **A wiki link to a page that doesn't exist fails silently.** GitHub's wiki renders a broken
  `[[link]]` or relative markdown link as "create this page" rather than an error — there is no build
  failure to notice. The only reliable check is `verify.mjs`'s coverage/reference rules plus visually
  confirming the published wiki.
- **A brand-new wiki needs one-time UI initialization.** `git clone` of `owner/repo.wiki.git` 404s
  until at least one page has been created through the GitHub web UI; the publish job's clone step
  fails loudly (not silently) when this hasn't been done.
- **Do not restate the bar inside a page.** Sentences like "a competent engineer should be able to
  rebuild this from this page alone" are instructions to the generator, not content for a reader — they
  add no information and do not appear in a finished page.
- **Do not specify legacy or backward-compatibility paths as required behaviour.** Where a
  compatibility shim is still live in the code, either omit it or name it in a short aside as scheduled
  for removal (see #207, #8) — never as part of the contract a rebuilder should implement.
