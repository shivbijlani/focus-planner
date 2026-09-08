# Domain: overnight-agent

`overnight-agent` is the repository's largest collected domain: `spec-facts.json` records **166**
JavaScript modules in `plugins/overnight-agent/checks/`. That count is real, but it is not the
whole runtime surface. The plugin also ships PowerShell and markdown assets that `spec-facts.json`
does not index because `scripts/spec/collect.mjs` only walks JS/TS extensions. Direct inspection
shows a second layer under `plugins/overnight-agent/skills/overnight-agent/` (33 files: 30 `.ps1`,
2 `.md`, 1 `.json`) plus `plugins/overnight-agent/skills/catchup-doc/` (`SKILL.md` and
`resolve-ids.ps1`).

This page stays at the domain-map level: what the overnight agent is, how the check suite is
organized, and what the skill-side control files do. For the behavioural doctrine behind ordering,
exhaustion, consent, and self-healing, see [Prioritisation](Prioritisation) and
[Reliability](Reliability).

## What this domain is

`plugins/overnight-agent/skills/overnight-agent/SKILL.md` defines an unattended planner loop. It
reads external settings, checks inbox/doc-comment surfaces, scans planner state, dispatches
approved work into per-task sessions, proposes new plans for eligible work, generates task papers,
and mirrors results to Telegram. `plugins/overnight-agent/skills/overnight-agent/oa-state.ps1`
implements the machine-readable state layer behind that loop: board ordering, reopen detection,
doc bindings, session bindings, consent, gates, timers, and journal snapshots.

The check suite exists because the agent runs while nobody watches it. The doc comments in
`plugins/overnight-agent/checks/mutcheck-doc-comments.mjs`,
`plugins/overnight-agent/checks/mutcheck-zero-writer.mjs`,
`plugins/overnight-agent/checks/mutcheck-repo-drift.mjs`,
`plugins/overnight-agent/checks/swallowed-message-sweep.mjs`, and
`plugins/overnight-agent/checks/repo-drift-sweep.mjs` all make the same argument in different
forms: a guard that only ever prints green, or that grades a hand-copied model of the real code,
is indistinguishable from dead code.

## The check architecture

Three families carry most of the domain.

- **`mutcheck-*.mjs`** mutates the *real shipped source* and proves each guard is load-bearing.
  `plugins/overnight-agent/checks/mutcheck-zero-writer.mjs` says that a safeguard that itself
  fails silently is worse than nothing, so it compares exact finding kinds rather than mere
  fired/not-fired status. `plugins/overnight-agent/checks/mutcheck-repo-drift.mjs` builds a
  synthetic OA home and repo archive, then disables individual drift guards and requires the
  verdict to change.
- **`*-sweep.mjs`** runs the nightly corpus scan over live artifacts: journals, state, installed
  plugin files, workflows, Telegram delivery, or repo/archive copies. `plugins/overnight-agent/checks/swallowed-message-sweep.mjs`
  is representative: it does not ask whether a class of bug is *possible*; it asks whether one of
  Shiv's messages sits unanswered at the bottom of a journal *right now*.
- **`lib-*.mjs`** centralizes parsing and classification that multiple sweeps depend on. The doc
  comments insist on shared libraries so sibling sweeps stop re-implementing the same fragile
  model. `plugins/overnight-agent/checks/lib-doc-comments.mjs` splits "reading" from "consent"
  with opposite failure defaults; `plugins/overnight-agent/checks/lib-live-ask.mjs` and
  `plugins/overnight-agent/checks/lib-live-status.mjs` answer "what is live now?" from the newest
  relevant turn rather than the last regex match anywhere; `plugins/overnight-agent/checks/lib-telegram-delivery.mjs`
  imports the shipped Telegram formatter instead of hand-modeling truncation; `plugins/overnight-agent/checks/lib-postmortem.mjs`
  extracts conservative recurrence signals for postmortem review.

A small slice from the real source shows the pattern:

> [!NOTE]
> **Technical detail: concrete example** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

```js
// plugins/overnight-agent/checks/mutcheck-repo-drift.mjs
// ... build synthetic fixtures, run the REAL sweep as a child process ...
// Then disable each guard in turn and assert that exactly its own case breaks.

// plugins/overnight-agent/checks/repo-drift-sweep.mjs
// So this sweep asks one question every night: is every file the live suite
// actually depends on present in git, and identical to what is running?
```


</details>
## Collected module families in `spec-facts.json`

The table below groups the **174 collected JS modules** by file family. Counts come from
`spec-facts.json`; examples are verbatim paths from that file.

> [!NOTE]
> **Technical detail: concrete reference.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

| Family | Count | What it covers | Representative paths |
| --- | ---: | --- | --- |
| `mutcheck-*` | 49 | Mutation-tested proof that a guard's individual arms matter. | `plugins/overnight-agent/checks/mutcheck-basename-collision.mjs`; `plugins/overnight-agent/checks/mutcheck-phase07-ownership.mjs`; `plugins/overnight-agent/checks/mutcheck-mcp-transport.mjs` |
| `*-sweep` | 50 | Live corpus scans for current failures and regressions. | `plugins/overnight-agent/checks/armed-trigger-sweep.mjs`; `plugins/overnight-agent/checks/basename-collision-sweep.mjs`; `plugins/overnight-agent/checks/mcp-transport-sweep.mjs` |
| `lib-*` | 13 | Shared readers/classifiers used by several checks. | `plugins/overnight-agent/checks/lib-doc-comments.mjs`; `plugins/overnight-agent/checks/lib-external-artifacts.mjs`; `plugins/overnight-agent/checks/lib-external-surfaces.mjs` |
| `verify-*` | 3 | One-shot verification scripts aimed at a named change or surface. | `plugins/overnight-agent/checks/verify-186.mjs`; `plugins/overnight-agent/checks/verify-deployed-paths.mjs`; `plugins/overnight-agent/checks/verify-settings-form.mjs` |
| `*-scope` | 9 | Scope readers that bound a question before a sweep answers it. | `plugins/overnight-agent/checks/block-newer-scope.mjs`; `plugins/overnight-agent/checks/block-truncation-scope.mjs`; `plugins/overnight-agent/checks/multi-block-slice-scope.mjs` |
| `digest-*` | 6 | Telegram / digest auditing and replay analysis. | `plugins/overnight-agent/checks/digest-audit.mjs`; `plugins/overnight-agent/checks/digest-demoted.mjs`; `plugins/overnight-agent/checks/digest-invisible.mjs` |
| `board-*` | 3 | Planner-board integrity and external-ticket measurement. | `plugins/overnight-agent/checks/board-external-ticket-measure.mjs`; `plugins/overnight-agent/checks/board-gaps.mjs`; `plugins/overnight-agent/checks/board-integrity.mjs` |
| `ynab-*` | 4 | One-off YNAB-oriented probes/checks. | `plugins/overnight-agent/checks/ynab-234-check.mjs`; `plugins/overnight-agent/checks/ynab-236-lookup.mjs`; `plugins/overnight-agent/checks/ynab-236-wide.mjs` |
| `yt-*` | 4 | YouTube-oriented probes/readers. | `plugins/overnight-agent/checks/yt-captions.mjs`; `plugins/overnight-agent/checks/yt-modern.mjs`; `plugins/overnight-agent/checks/yt-probe.mjs` |
| `*-probe` | 2 | Narrow environment or repair probes. | `plugins/overnight-agent/checks/mcp-probe.mjs`; `plugins/overnight-agent/checks/probe-workspace-tiers.mjs` |
| `pr-closing-keyword` | 1 | CI-facing PR-body guard. | `plugins/overnight-agent/checks/pr-closing-keyword.mjs` |
| Other one-offs | 30 | Indexers, auditors, replay tools, and narrow incident checks that do not fit one prefix. | `plugins/overnight-agent/checks/artifact-index.mjs`; `plugins/overnight-agent/checks/body-header-drift.mjs`; `plugins/overnight-agent/checks/ensure-catchup-doc.mjs` |

</details>

The mix matters more than any single filename. The architecture keeps nightly diagnosis modular:
a sweep asks one operational question, a mutcheck proves the sweep can still detect it, and a lib
keeps sibling readers from drifting apart.

## Skill-side files outside `spec-facts.json`

These files are runtime-critical even though the fact collector does not index them.

> [!NOTE]
> **Technical detail: concrete reference.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

| Path | Role |
| --- | --- |
| `plugins/overnight-agent/skills/overnight-agent/SKILL.md` | Main operating contract. The phase headings in the file are literal: `PHASE 0`, `PHASE 0.7`, `PHASE 1`, `PHASE 1.5`, `PHASE 2`, `PHASE 2.5`, `PHASE 3`. |
| `plugins/overnight-agent/skills/overnight-agent/oa-state.ps1` | Core state-machine CLI and journal/board/session reader. |
| `plugins/overnight-agent/skills/overnight-agent/user-settings.md` | Shareable template for the external settings file; the skill warns that updates overwrite the bundled template. |
| `plugins/overnight-agent/skills/catchup-doc/SKILL.md` | The companion write-up skill the overnight agent points at when a task uses a catch-up document. |
| `plugins/overnight-agent/skills/catchup-doc/resolve-ids.ps1` | ID-to-title link resolver used by the catch-up-doc workflow. |

</details>

`SKILL.md` is operational, not aspirational. It tells the agent to resolve an **external**
`user-settings.md`, to run `oa-state.ps1 scan` before judging tasks, and to keep task work in a
per-task session rather than in the run session. `plugins/overnight-agent/skills/catchup-doc/SKILL.md`
adds the reporting side: one zero-context paper, titled links for IDs, and document updates in
place rather than comment-thread back-and-forth. It names the one tool that can actually rewrite a
bound Google Doc — `manage_doc_tab` with `action: "populate_from_markdown"` — and records why the
obvious tool cannot: `import_to_google_doc` always creates a new document (its parameter list has
no `document_id`), so using it on a later pass would silently orphan the existing binding. Two traps
are called out by name: `manage_doc_tab` sits at tool tier `complete` while the agent session runs
`--tool-tier extended`, so it is invisible unless a short-lived `workspace-mcp` is spawned at the
higher tier; and the rewrite path's markdown writer has no GFM table support, so a table that
imported cleanly on the create path does not survive a later `populate_from_markdown` rewrite.
PHASE 0.7 in `SKILL.md` only **reads** catch-up doc comments — creation and binding are owned one
level up by `plugins/overnight-agent/checks/ensure-catchup-doc.mjs`, which runs on its own schedule
and applies `if doc does not exist then create doc else continue` before any task wakes. That split
replaced a version of PHASE 0.7 that told the reader to skip unbound tasks and then, unreachably,
instructed it to create the doc for them — the contradiction behind issue #548, closed by moving
ownership out of the phase entirely.

`oa-state.ps1` is large, but its command surface is explicit near the top:

> [!NOTE]
> **Technical detail: concrete example** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

```powershell
seed   [-Force]
scan
get    -Id <id>
consent -Id <id> [-Action <kind>] [-Repo <name>]
gate
extract -Id <id> [-BudgetKB <n>] [-Json] [-Verify]
mark   -Id <id> [-Status s] [-Version n] [-PlanId p] [-Poll <cadence>] [-Recheck <cadence>]
session [-Id <id>] [-InFlight] [-SessionId <sid>] [-SessionDead] [-SessionWoken] [-SessionRelease]
doc    -Id <id> ...
resnapshot
```


</details>
Its function map matches those commands. `Get-UserSettingsPath`, `Resolve-GateSettings`, and
`Resolve-PacingSettings` read tunables; `Get-NewestAgentTurn`, `Get-AgentEndIndex`,
`Test-TrailingHasUser`, and `Get-ConsentFacts` parse journals; `Get-BoardMap`,
`Get-PrioritiesRank`, `Get-UrgencyRank`, `Get-TodayGateVerdict`, and `Cmd-Scan` compute ordering
and eligibility; `Cmd-Doc`, `Cmd-Session`, `Cmd-Extract`, and `Cmd-Mark` handle durable state.

`user-settings.md` is equally concrete. Its `## Overnight Agent behaviour` table exposes `Today gate
backstop`, `Today gate strict`, and `Overnight Agent concurrency`; its settings table also names
`Planner board`, `Completed board`, `Journals folder`, `Agent state store`, `Dev drive (repos)`,
`Google account (Tasks)`, and Telegram settings. The template is explicit that the real settings
live outside the plugin and that the bundled copy is overwritten on update.

The PowerShell-side mutchecks parallel the JS ones. Files such as
`plugins/overnight-agent/skills/overnight-agent/mutcheck-priority-order.ps1`,
`plugins/overnight-agent/skills/overnight-agent/mutcheck-pacing-concurrency.ps1`,
`plugins/overnight-agent/skills/overnight-agent/mutcheck-today-served.ps1`, and
`plugins/overnight-agent/skills/overnight-agent/mutcheck-awaiting-reply.ps1` all build isolated
synthetic boards/settings/state, run the *real* `oa-state.ps1`, and prove that specific gates or
comparators are load-bearing.

## A check that runs in CI, not only in the overnight loop

`plugins/overnight-agent/checks/pr-closing-keyword.mjs` is the clearest example of a check that the
repository runs in GitHub Actions as well as in local reasoning. Its doc comment says the
authoritative check is not a regex; it asks GitHub what **it** parsed via
`closingIssuesReferences`, then treats the local grammar as an offline floor. `.github/workflows/pr-closing-keyword.yml`
wires that into PR events that can change without a new commit (`edited`, `labeled`, `unlabeled`):

> [!NOTE]
> **Technical detail: concrete example** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

```yaml
- name: This PR body must not carry a closing reference
  env:
    PR_BODY: ${{ github.event.pull_request.body }}
    PR_LABELS: ${{ join(github.event.pull_request.labels.*.name, ',') }}
    PR_NUMBER: ${{ github.event.pull_request.number }}
    GH_REPO: ${{ github.repository }}
  run: node ./plugins/overnight-agent/checks/pr-closing-keyword.mjs --from-env
```


</details>
That placement is representative. The overnight-agent domain is not just an unattended planner
skill; it is also the repository's largest body of executable skepticism about that skill.
