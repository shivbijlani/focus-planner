# Design specification (generated)

The pages in this folder are the **design thesis** for this repository: the level of detail is meant
to be enough to rebuild the system from scratch without reading the source.

They are **generated**, and this folder is the source of truth that the GitHub wiki mirrors.

## How it works

| Stage | Tool | Model involved? |
| --- | --- | --- |
| 1. Collect facts | [`scripts/spec/collect.mjs`](../../scripts/spec/collect.mjs) | No |
| 2. Write the prose | Copilot CLI, via [`scripts/spec/prompt.md`](../../scripts/spec/prompt.md) | Yes |
| 3. Verify against the code | [`scripts/spec/verify.mjs`](../../scripts/spec/verify.mjs) | No |
| 4. Open a PR | [`.github/workflows/spec-wiki.yml`](../../.github/workflows/spec-wiki.yml) | No |

Collection and verification are deterministic; only the prose is generated. That split is the point:
a spec written from the repo with nothing anchoring it drifts from the code immediately, and the
drift is invisible to a reader, because what is wrong is the spec's *relationship* to the code —
which is precisely what the reader does not have in front of them.

So `verify.mjs` fails the build when the spec:

- names a source file, module or issue number that does not exist (**invention**),
- omits a domain or a domain's principal module (**omission**),
- is too thin to rebuild from, or contains no concrete examples (**substance**).

## Editing

Prefer fixing the **generator** over editing a page by hand: the next run overwrites hand edits.
If a page is wrong, the usual cause is that `prompt.md` under-specifies it or `collect.mjs` does not
collect the fact it needed.

Changes arrive as a pull request, never a direct push — a machine may draft the design authority for
this system, but a human accepts it.

## Running it locally

```bash
node scripts/spec/collect.mjs --out spec-facts.json
node scripts/spec/verify.mjs --facts spec-facts.json --dir docs/spec
```

`spec-facts.json` is a build artifact and is git-ignored.
