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
6. **Specify the system going forward, not its compatibility shims.** This spec is what someone
   would build *now*. Backward-compatibility paths, deprecated aliases, migration fallbacks and
   legacy readers are **not** required behaviour and must not be written as though a rebuilder
   should implement them. Where such a path is still live in the code, either omit it or confine it
   to a short aside that names it as scheduled for removal (#207, #8) — never as part of the
   contract. Prefer stating the single forward mechanism plainly.
7. **No filler.** Do not pad. Every paragraph must carry information a rebuilder needs.

## Pages to write

Write these files into `docs/spec/`. Use exactly these names (the wiki keys off them). **This
table is the page set: a page that is not listed here is not indexed from `Home.md`, and since
`Home.md` is regenerated every run, an unlisted page silently becomes unreachable.** Adding a page
to the spec therefore means adding a row here, not only a link in `Home.md`.

| File | Contents |
| --- | --- |
| `Home.md` | The thesis: what this system is, the problem it solves, its core design principles, and an index linking every other page. |
| `Architecture.md` | The domains, how they compose, the module graph in prose, process/runtime boundaries, and the data-flow from user action to persisted state. |
| `Data-Formats.md` | Every persisted format — the planner board, task journals, agent state, bridge state — with **annotated real samples** and the invariants each must satisfy. This is the page a rebuilder needs most and can least infer. |
| `Domain-<name>.md` | One page per entry in `domains`. Its responsibility, principal modules, public exports, behavioural requirements derived from its tests, and its failure modes. |
| `Prioritisation.md` | Prioritisation as a product behaviour: how priority is expressed on the board (section, urgency icon, `Work Priority`, the `## Priorities` list, row order, id — the full sort key, in order), how the user changes it (the board, a journal reply, snoozing, `agent-gate.md`, `user-settings.md`), and how the Overnight Agent's `scan` turns it into an ordered worklist with a binding `eligible` flag. Must cover the Today→Deferred gate and **what releases it** — the exhaustion declaration, the four things that cancel it, and `today_release_reason` — the liveness mechanisms (`awaiting_reply` parking, poll/recheck timers, the staleness backstop, snooze precedence), and the recurring failure class this design guards against: *the agent authoring the signal its own gate reads*. On `awaiting_reply` specifically, must state that the ask is **declared, not inferred** (issue #560): `write-turn.ps1` requires `-Ask blocking|offer|none` and stamps it into the turn, `HasBlockingAsk` prefers that declaration over any reading of the prose, the regex reading survives only as a documented **fallback** for turns written before the flag (in which fallback the dismissive-`none`/`nothing` boundary still applies, pinned by arms L1/L2/Q/R of `mutcheck-awaiting-reply.ps1`), and `scan` emits `ask_source: declared|inferred` plus `ask_declared` so the fallback's share is measurable. Must note the parking expression is duplicated in `Cmd-Scan` and `Test-SessionHoldsCapacity` and kept textually identical, so both readers move together (the #545 emitted-vs-gated failure shape), and that `has_open_ask` is unchanged in the non-regressing direction — a declaration only ever adds visibility. In the failure-class section, must distinguish the earlier **narrowing** (the dismissive-ask boundary, which left the agent still authoring the text its gate read) from the **closure** (a declared ask), and state the general rule it illustrates: an agent-authored signal is acceptable when it is authored *deliberately and structurally*, as `-Exhausted` and `-Ask` are, rather than recovered from narrative written for a human reader. Must also cover **pacing** — how much of the ordered worklist a run takes on: the `Overnight Agent concurrency` tunable in `user-settings.md` (default 1; one item in flight is isolation, not concurrency), the estimate-before-starting-another rule against the next scheduled run, and that "done" means verified and published rather than code written — noting that pacing is run-loop guidance in `SKILL.md` tracked by issue #391, not yet a mechanism. Must also cover **dispatch precedence**: that a run separates *collect* (agent inbox, folded Telegram replies, `scan`) from *execute*, that collect hands off rather than performing work, and that dispatch runs in two waves — the priority wave first, then the collect wave — where a collect-phase wake **trumps** by being dispatched in addition to the priority selection. State that this is the single sanctioned exception to the default concurrency of 1, justified by provenance (a user action may widen the run; the agent's own judgement may not), that it does not compound or raise the setting, and that it changes *when* a task is woken rather than *where* its work happens (issues #405 and #404). Ground it in `plugins/overnight-agent/skills/overnight-agent/oa-state.ps1` and the `mutcheck-*.ps1` checks, which are the executable statement of the intended behaviour. |
| `Behaviour.md` | The system's required behaviour as testable statements, derived from `testFiles`. Group by area. This is the acceptance suite a rebuilt implementation must satisfy. |
| `Rebuilding.md` | A build-order guide: what to construct first, dependencies between parts, and how to verify each stage. Written for someone starting from an empty directory. |
| `Updating-the-Spec.md` | The maintenance guide for this spec itself, written for whoever edits it next. Must cover: the wiki is a mirror of `docs/spec` on `main` and must never be edited directly (the publish deletes any page not in the source); that adding a page needs a row in *this* table as well as a `Home.md` link, because `Home.md` is regenerated from this table and an unlisted page is silently dropped from the index; the collect → generate → verify → publish pipeline and how to run the mechanical halves locally; every finding `verify.mjs` can emit and what each means; that issue refs are validated against *open* issues, so closed issues and pull requests must be named in words rather than hidden from the pattern; both publish paths and the `WIKI_TOKEN` requirement; and the traps — `README.md` is not a page, wiki links fail silently as "create this page", a new wiki needs one-time UI initialisation, do not restate the bar, do not specify legacy paths. |
| `Roadmap.md` | Known gaps and direction, grouped by priority label, derived from `issues`. Reference issues by number. |
| `Reliability.md` | How the autonomous overnight agent is kept running unattended on one machine and heals itself: out-of-band supervision dispatched by the OS, liveness-gated stuck detection and orphan repair, silent auto-restart as the remedy, deploy propagation ("merged isn't running"), byte-level encoding safety, journal write safety, MCP process reaping, browser-slot health, the mutation-tested sweep harness, and the `user-settings.md` reconcile loop. Mine the `doc` comments of the `overnight-agent` and `scripts` domains and the reliability issues; cite scripts by name. Treat mechanisms described in issues as shipped. |

## Style

- Lead with the conclusion; put rationale after it.
- Prefer tables for enumerable facts and prose for reasoning.
- Use present tense and active voice.
- Link between pages with relative wiki links, e.g. `[Architecture](Architecture)`.
- Do not include a changelog, a generation timestamp, or any note that this was machine-written —
  the commit history already carries that, and it is noise in a spec.
- **Do not restate the bar inside the page.** "This page assumes no prior context", "a competent
  engineer should be able to rebuild X from this page alone", and similar are *these instructions*,
  addressed to you — they are the acceptance test for the writing, not content for a reader, who
  simply wants the system described. Meeting the bar is shown by the page being complete, never by
  claiming it. Describing what a page *contains* ("this page is the format contract") is fine; what
  a page *achieves* is not.

Begin by reading `spec-facts.json`, then write the pages.
