# Updating the Spec

**The wiki is a mirror. Do not edit it.** Every page here is generated from `docs/spec` on `main`
and republished over the top; the publish step deletes every wiki page that is not present in
`docs/spec`, so a page written by hand in the wiki UI survives exactly until the next publish. To
change what this wiki says, change `docs/spec` on `main`.

This page is for whoever — human or agent — does that next.

## Where each thing lives

| Concern | Lives in |
| --- | --- |
| The prose you are reading | `docs/spec/*.md` on `main` |
| **Which pages exist** | the *Pages to write* table in `scripts/spec/prompt.md` |
| The facts the prose must match | `scripts/spec/collect.mjs` output (`spec-facts.json`, gitignored) |
| The gate that enforces the match | `scripts/spec/verify.mjs` |
| The conflicting-requirement report | `scripts/spec/conflicts.mjs` output (`spec-decisions.json`, gitignored) |
| Regeneration and publication | `.github/workflows/spec-wiki.yml` |

## The trap: adding a page needs two edits, not one

`Home.md` carries the index linking every other page — and `Home.md` is itself regenerated, from
the page list in `prompt.md`. So a new page that is only linked from `Home.md` is **silently
dropped from the index on the next regeneration** and becomes unreachable: nothing fails, nothing
warns, the page simply stops being linked from anywhere.

Adding a page therefore means:

1. Write `docs/spec/<Page>.md`.
2. **Add a row for it to the *Pages to write* table in `prompt.md`**, so the generator knows it
   exists, indexes it, and keeps it current.
3. Add the `Home.md` link too, for the period before the next regeneration.

Renaming a page is the same problem with an extra step: the old wiki page disappears on the next
publish, and any `[Old-Name](Old-Name)` link elsewhere becomes a dead link that renders as an
invitation to create the page.

## The pipeline

Mechanism and policy are deliberately split — everything except the prose is reproducible and
diffable, and only the prose is generated:

```
collect.mjs   (no model)   → spec-facts.json: module graph, exports, tests, workflows, open issues
     ↓
model          writes docs/spec/*.md from those facts, following prompt.md
     ↓
verify.mjs    (no model)   → fails on invention, omission, or thinness
     ↓
conflicts.mjs (no model)   → spec-decisions.json: open issues that demand opposite things
     ↓
pull request → review → main
     ↓
publish job    mirrors docs/spec/*.md into the wiki
```

Run the mechanical halves locally before opening a pull request:

```powershell
node scripts/spec/collect.mjs --out spec-facts.json
node scripts/spec/verify.mjs --facts spec-facts.json --dir docs/spec
node scripts/spec/conflicts.mjs --facts spec-facts.json --out spec-decisions.json --md spec-decisions.md
```

## What `conflicts.mjs` reports

`verify.mjs` asks "does the prose reference things that exist?". It cannot catch the case where two
**open issues demand opposite things** — both exist, so both references are valid, and whichever the
model read last ships as design authority.

`conflicts.mjs` reads the same facts and reports requirement pairs that cannot both hold:

| Rule | Fires when |
| --- | --- |
| `polarity` | one issue requires a behaviour, another forbids the same behaviour |
| `value` | two issues give different values for the same setting (durations/cadences) |
| `lifecycle` | one issue wants a thing added, another wants the same thing removed |

It is **tuned for precision, not recall**, and that choice is the whole design. At four runs a day a
detector that cries wolf is muted inside a week, and then its silence reads as a verdict. So every
rule demands a specific shared target before it will pair two statements, a sentence that cites the
other issue by number is treated as commentary rather than contradiction, and every finding carries
the verbatim sentences it came from so a wrong one is visible in a single line. Measured against the
live corpus of 70 open issues it reports **0** conflicts.

It exits 0 even when it finds something: a disagreement between two issues is information for a
human, not a broken build, and a job that goes red four times a day is one nobody reads.

## What `verify.mjs` rejects

| Finding | Meaning |
| --- | --- |
| `invented-path` | The prose names a `src/`, `scripts/`, `packages/` or `plugins/` file that does not exist. |
| `unknown-issue` | A `#NNN` reference that is not an open issue. |
| `uncovered-domain` | A domain of the codebase no page mentions. |
| `uncovered-key-module` | A domain's largest module is named nowhere. |
| `thin-page` | Under 250 words — too short to carry an architecture and its rationale. |
| `no-examples` | No fenced code block anywhere in the spec. |

Two properties of that gate are worth knowing before you fight it:

- **Issue references are checked against *open* issues**, because the collector gathers open issues
  only. A closed issue or a pull request cited as `#NNN` therefore fails. Do not wrap it in
  parentheses to hide it from the pattern — that evades the check rather than satisfying it, and it
  also leaves the reader unable to tell which namespace the number is in. Name it in words:
  *"merged pull request 232"*, *"GitHub issue 310"*.
- **The gate is not a style critic.** It proves the prose refers to things that exist and covers
  every domain. Whether the design rationale is *right* is what review is for.

## Publishing

Two paths, both writing to the same place:

- **Automated** — `.github/workflows/spec-wiki.yml`, **every 6 hours** or on manual dispatch. It
  regenerates, verifies, flags conflicting requirements, opens or updates a pull request, and
  publishes what is on `main`. Publication needs a `WIKI_TOKEN` secret, because Actions'
  `GITHUB_TOKEN` cannot push to a wiki repository; without it the publish job is skipped rather than
  failed.

  It maintains **one rolling pull request** on the fixed `spec/auto` branch, updated in place, rather
  than opening a new PR per run. That pairing is deliberate and load-bearing: at the old weekly
  cadence a branch per run was harmless, but at 6h it would open 28 pull requests a week, each
  superseding the last. Raising the frequency without the rolling branch is a regression, not a
  tuning choice.
- **Manual** — a wiki is a plain git repository with no pull-request gate, so anyone with a
  `repo`-scoped token can push to it directly:

```powershell
git clone "https://x-access-token:$(gh auth token)@github.com/<owner>/<repo>.wiki.git" wiki
# copy docs/spec/*.md into wiki/ — excluding README.md — and delete pages no longer in the source
git -C wiki add -A
git -C wiki commit -m "docs(spec): publish from docs/spec @ main"
git -C wiki push
```

Whichever you use, publish **from `main`**, not from a branch. Anything published that is not also
in `docs/spec` on `main` is reverted by the next run — silently, while reporting success.

## Things that will catch you out

1. **`docs/spec/README.md` is not a page.** It is provenance for humans browsing the folder;
   `verify.mjs` excludes it and the publish must too, or the wiki gains a stray `README` page.
2. **Wiki links are relative and extensionless** — `[Architecture](Architecture)`. A broken one
   renders as an invitation to create that page rather than as an error, so it fails silently.
   Check links after publishing, not just before.
3. **A new wiki must be initialised once in the web UI.** GitHub does not create the underlying
   repository until a first page is saved, and there is no API for it — `ls-remote`, `clone` and
   `push` all return an identical `Repository not found` until then. That failure has a second
   cause worth ruling out: a token without `repo` scope returns the same message.
4. **Do not restate the bar inside a page.** "A competent engineer should be able to rebuild this
   from this page alone" is an instruction to the author, not content for a reader.
5. **Specify the system going forward.** Compatibility shims, deprecated aliases and legacy readers
   are not part of the contract; see #207.

## Before you publish

- `verify.mjs` exits 0.
- Every page you added or renamed has a row in `prompt.md`.
- Every `#NNN` you cited is an open issue; everything else is named in words.
- After publishing: re-read the wiki, and follow the links.
