# Updating the Spec

This page is the maintenance guide for this specification itself.

## The wiki is a mirror, never edit it directly

`docs/spec/*.md` on `main` is the single source of truth. The wiki is published *from* it by the
`publish-wiki` job (see the pipeline below), which clones `owner/repo.wiki.git`, deletes every
existing `.md` page in it, and copies `docs/spec/*.md` over — a mirror, not a merge. Any edit made
directly in the wiki UI is destroyed the next time the pipeline runs (every 6 hours, on schedule). If
you need to change the spec, change `docs/spec` on `main` and let it publish; never edit a wiki page in
place.

## Adding a page requires two edits, not one

The page set is the table in `scripts/spec/prompt.md` (mirrored in this repository's original task
instructions). `Home.md` is **regenerated on every run** from that same table, so a new page linked
only from `Home.md`'s prose, without a corresponding row in the table, is silently unreachable the next
time the pipeline runs and overwrites `Home.md`. Adding a page therefore means:

1. Add a row to the page table (in `scripts/spec/prompt.md`, and correspondingly in whatever generates
   the next `Home.md`).
2. Add a link to it from `Home.md`'s index.

Skipping step 1 is the single most common way a page silently disappears — it isn't deleted, it's just
never linked again after the next regeneration.

## The pipeline

`.github/workflows/spec-wiki.yml` runs four stages, split deliberately between mechanism (no model) and
policy (model-generated prose):

1. **Collect** (`node scripts/spec/collect.mjs --out spec-facts.json`) — extracts ground-truth facts
   with no model involved: the module graph, exports, tests, workflows, and open issues. Purely
   mechanical and reproducible.
2. **Generate** — a Copilot CLI run (`copilot --yolo -p "$(cat scripts/spec/prompt.md)"`) writes the
   prose pages from those facts.
3. **Verify** (`node scripts/spec/verify.mjs --facts spec-facts.json --dir docs/spec`) — fails the
   build if the generated prose references anything that doesn't exist, or omits a domain.
4. **Publish** — a rolling pull request onto a fixed `spec/auto` branch (never a direct push — the spec
   is design authority, so a machine may draft it but a human must accept it), followed by an optional
   wiki mirror of whatever lands on `main`.

### Running the mechanical halves locally

```
node scripts/spec/collect.mjs --out spec-facts.json
node scripts/spec/verify.mjs --facts spec-facts.json --dir docs/spec
```

Both run with no model and no network access beyond `gh` for issue collection, so they can be run
locally before pushing a manual edit to `docs/spec`.

## Every finding `verify.mjs` can emit

| Finding | Meaning |
| --- | --- |
| `invented-path` | A page names a file path (matching `(?:src\|scripts\|packages\|plugins)/....(?:jsx\|tsx\|mjs\|ts\|js)`) that is not in `spec-facts.json`'s modules, test files, or workflow files. Fix by removing the invented reference or regenerating the fact set if the file genuinely now exists. |
| `unknown-issue` | A page cites `#NNN` for a number that resolves to nothing. On `Roadmap.md` specifically, this also fires for a number that resolves only to a **closed** issue or a pull request — Roadmap enumerates currently-open gaps, so citing a closed issue there as a live gap is stale, not merely a typo. |
| `uncovered-domain` | An entry in `facts.domains` does not appear as literal text anywhere across all pages combined. Every domain must be named somewhere. |
| `uncovered-key-module` | The single largest-by-lines module path in some domain is not named anywhere. This exists because a domain can be "covered" by one passing mention while its actual substance is absent — naming the biggest module is a cheap proxy for real coverage. |
| `thin-page` | A page has fewer than 250 words. The floor is not a target, only the rough point below which a page cannot carry an architecture, a data format, and its rationale together. |
| `no-examples` | No fenced code block (```) appears anywhere across all pages. A spec that never shows a concrete format or signature cannot be rebuilt from. |

A run that produces zero findings prints a confirmation and exits 0; any finding at all fails the build.

## Issue references are validated against *open* issues on Roadmap, more broadly elsewhere

`Roadmap.md` accepts only currently-open issue numbers, because it exists to enumerate the system's
current gaps — a closed issue cited there as a live gap is simply wrong. Every other page accepts the
broader set (open issues, closed issues, and pull requests unioned together), because elsewhere an
issue reference is typically rationale or history ("issue #226 measured this cost"), and a closed issue
or a merged PR is entirely legitimate evidence for that. Concretely: **name a closed issue or a pull
request in words** ("the now-closed #226 measured...") anywhere outside Roadmap rather than relying on
the bare `#NNN` pattern to be silently accepted — it will be, but the intent should still be readable
without checking the issue's current state. `verify.mjs` also prints an unconditional, non-blocking
report of every reference on a non-Roadmap page that resolves to a closed issue or a PR, specifically so
a human reviewer can check the framing is still honest — the tool cannot infer intent from a bare
number, only a person can.

## Both publish paths and the `WIKI_TOKEN` requirement

`GITHUB_TOKEN` cannot push to `owner/repo.wiki.git` — the wiki is a separate repository outside that
token's scope. The `publish-wiki` job therefore requires a personal access token in `secrets.WIKI_TOKEN`
with repo scope; when that secret is absent, the job logs a notice and exits 0 rather than failing, so
the generate-and-review loop still works with zero extra setup — only the wiki mirror is skipped, and
`docs/spec` on `main` remains the source of truth regardless. The rolling-PR path (generate → verify →
open/update `spec/auto`) runs unconditionally on every 6-hourly schedule tick or manual dispatch; the
wiki-publish path runs whenever the schedule fires, or on manual dispatch with `publish_wiki: true`, and
always publishes what is already committed to `main` — never the unreviewed content of `spec/auto`.

The rolling pull request onto `spec/auto` cannot itself acquire an ordinary CI check, because it is
authored by `github-actions[bot]` with `GITHUB_TOKEN`, and GitHub refuses to let a token-authored event
cascade into a triggered workflow run — `ci.yml`'s `pull_request` run for that branch is created and
then parked at `action_required` with zero duration, so no check-run ever reaches the head commit. The
fix is a separate `verify-spec-branch` job, triggered by the same `schedule` event (which is not
gated), that re-runs the same test/build/lint commands against the exact pushed SHA and writes the
result to that commit via the statuses API — a channel `GITHUB_TOKEN` can reach that ordinary
check-runs cannot. `scripts/spec/verifyParity.mjs` (run by the unit suite) holds that job's command set
identical to `ci.yml`'s, specifically so the two cannot drift apart into a green badge that verifies
less than it claims to.

## Traps

- **`README.md` is not a page.** It is provenance documentation for a human browsing `docs/spec` in the
  repository, deliberately excluded from both `verify.mjs`'s page set and the wiki-publish mirror. Do
  not add content to it expecting it to appear on the wiki, and do not delete it thinking it's one of
  the 18 generated pages.
- **A wiki link fails silently as "create this page."** A relative link like `[Architecture](Architecture)`
  to a page name that doesn't exist does not error visibly in GitHub's wiki rendering — it renders as a
  normal-looking link that, when clicked, offers to create a new empty page. This is indistinguishable
  from a working link until someone clicks it, so a typo'd or removed page name is easy to ship
  unnoticed.
- **A brand-new wiki needs one-time UI initialisation.** `git clone` against
  `owner/repo.wiki.git` 404s until the wiki has been initialised with at least one page created through
  the GitHub UI. The publish job cannot do this itself — it will error with a clear message if the wiki
  has never been touched, and someone must create one page by hand first.
- **Do not restate the bar inside a page.** Sentences like "a rebuilder should be able to work from this
  page alone" are instructions to whoever (or whatever) is writing the spec, not content a reader of the
  finished spec needs — they carry no information about the system and are the kind of filler this
  spec's own rules exist to prevent.
- **Do not specify legacy/compatibility paths as required behaviour.** Where a backward-compatibility
  shim is still live in the code (see the deliberate omissions and asides throughout this page set,
  e.g. legacy `<!-- snooze:… -->` board comments, unsuffixed FSA handles, `fp-storage-provider`), name it
  only as an aside tracked for removal, never as part of the forward contract a rebuilder should
  implement — see issues #207 and #8.
