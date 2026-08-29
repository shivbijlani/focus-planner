# Task: write the design specification for this repository

You are writing the **design thesis** for this system. Output goes to `docs/spec/*.md`, which is
published as the project wiki.

## The bar

**A competent engineer who has never seen this repository must be able to rebuild the system from
your spec alone**, without reading the source. That is the acceptance test for every sentence you
write. If a page tells someone *what exists* but not *what it must do and why*, it has failed.

## Your ground truth

`spec-facts.json` in the repository root. It was extracted mechanically from the code and contains:

- `modules[]` — every source file with `path`, `domain`, `lines`, `exports`, `imports`,
  `components`, and `doc` (the file's leading comment, which in this repo is a deliberate rationale
  note — it is the highest-signal design material available, so mine it hard).
- `testFiles[]` — every test name, grouped by suite. **Test names are the behavioural
  specification**: they state in English what the system must do. Convert them into requirements.
- `issues[]` — open GitHub issues: known gaps, defects and intended direction.
- `workflows[]` — CI/CD definitions.
- `packageScripts`, `dependencies`, `devDependencies`, `domains`, `counts`.

**Read this file first.** Every factual claim you make must be traceable to it (or to source you
open yourself). You may open any file in the repo to go deeper — prefer doing so over guessing.

## Hard rules

1. **Never invent.** Do not name a file, export, module or issue number that is not in the facts.
   A build step checks this and fails on any invented reference.
2. **Cover every domain** in `domains`, and name each domain's principal modules by path.
3. **Show, don't assert.** Include real signatures, real data-format samples, and fenced code
   blocks. A rebuilder cannot infer a file format from adjectives.
4. **Explain the why.** For each significant design decision, state the alternative that was
   rejected and the reason. Where a `doc` comment or an issue gives that reasoning, use it —
   it is primary evidence and it is what makes this a thesis rather than an inventory.
5. **Be honest about gaps.** Open issues describe things that are broken or missing. A spec that
   presents the system as finished is wrong. Say what is unbuilt, and what the intended fix is.
6. **No filler.** Do not pad. Every paragraph must carry information a rebuilder needs.

## Pages to write

Write these files into `docs/spec/`. Use exactly these names (the wiki keys off them):

| File | Contents |
| --- | --- |
| `Home.md` | The thesis: what this system is, the problem it solves, its core design principles, and an index linking every other page. |
| `Architecture.md` | The domains, how they compose, the module graph in prose, process/runtime boundaries, and the data-flow from user action to persisted state. |
| `Data-Formats.md` | Every persisted format — the planner board, task journals, agent state, bridge state — with **annotated real samples** and the invariants each must satisfy. This is the page a rebuilder needs most and can least infer. |
| `Domain-<name>.md` | One page per entry in `domains`. Its responsibility, principal modules, public exports, behavioural requirements derived from its tests, and its failure modes. |
| `Behaviour.md` | The system's required behaviour as testable statements, derived from `testFiles`. Group by area. This is the acceptance suite a rebuilt implementation must satisfy. |
| `Rebuilding.md` | A build-order guide: what to construct first, dependencies between parts, and how to verify each stage. Written for someone starting from an empty directory. |
| `Roadmap.md` | Known gaps and direction, grouped by priority label, derived from `issues`. Reference issues by number. |

## Style

- Lead with the conclusion; put rationale after it.
- Prefer tables for enumerable facts and prose for reasoning.
- Use present tense and active voice.
- Link between pages with relative wiki links, e.g. `[Architecture](Architecture)`.
- Do not include a changelog, a generation timestamp, or any note that this was machine-written —
  the commit history already carries that, and it is noise in a spec.

Begin by reading `spec-facts.json`, then write the pages.
