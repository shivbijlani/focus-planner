---
name: agent-rob
description: >-
  Run Focus Planner's agent Rhythm of Business (ROB): choose one item for human
  triage, plan one human-triaged item, prove one implemented issue merge-ready,
  and prove one released issue ready to close, writing a catch-up doc for each
  human touch point. Use when asked to run the agent ROB, review the four
  handoff queues, or prepare their approval decisions.
argument-hint: 'Run the ROB, or name the handoff queue to review.'
user-invocable: true
---

# Focus Planner agent ROB

The Rhythm of Business (ROB) is a recurring review of four human/agent handoffs.
Select at most one candidate from each eligible queue, explain why that candidate
is next, and give the human enough evidence to decide. These labels describe an
operating model, not persisted state that the application already enforces.

This is a **repository-local skill**. The Overnight Agent plugin refers to it
when working in the Focus Planner repository; it does not ship this skill to
plugin installations. If the repository skill is unavailable, do not claim to
have run the ROB.

## Start each pass

Read the current planner, journals, relevant GitHub issues and pull requests,
release evidence, and any existing catch-up documents. Establish which items
actually belong to each queue; do not infer completion from a commit title,
an open issue, or a planner row alone. Respect the existing Overnight Agent
priority and consent rules. If a source is unavailable, describe what could
not be verified rather than treating absence of evidence as a clear queue.

## One catch-up doc per human touch point

Every human touch point this pass produces gets a catch-up doc, written with
the **`catchup-doc` skill** from the repository's Overnight Agent plugin. A
touch point is one selected item plus the one decision being requested for it:
the issue put up for human triage, the item whose plan needs approval, the
change whose merge needs approval, and the released issue whose closure needs
approval. Four selected items in a pass means four catch-up docs, each asking
its own question. Never bundle several decisions into one document, and never
ask for a decision that has no catch-up doc behind it.

**One document per item, not per visit.** Resolve the item's existing binding
first and amend that document in place. Create and bind a new document only
when the item has none. An item that returns at a later gate keeps the same
document: rewrite its status line and requested decision for the new touch
point rather than creating a second page, which would strand the human's
earlier comments and leave two pages competing to be current. Two touch points
in one pass therefore share a document only if they are the same item, which
should not happen — each queue selects a different item.

Each document is written for a reader with no prior context: status and the
exact decision first, then what the work is, why it matters, the evidence
behind every claim as links, and what happens on approval. Name and link
identifiers with their resource titles instead of bare numbers. Advertise only
an approval phrase the consent reader accepts. Do not answer a human's
document comments in a comment thread: amend the document to answer them.
Follow the skill's target-specific formatting rules.

## The four handoff queues

1. **Not started -> human triage.** Find work not yet on the journey. Check its
   planner entry, journal and linked context so already active, deferred,
   blocked or finished work is not proposed as new. Choose one item needing
   triage. Make the case for why it should be triaged *next*: value, timing,
   urgency, dependencies, supporting evidence, and what could change the
   ranking. Ask the human to triage it, defer it, or pick another. Do not plan
   or implement it on the strength of the recommendation. Write its triage
   catch-up doc and point the human at it.
2. **`human triaged` -> plan approval.** Consider all triaged items without an
   approved plan. Pick one and say why it is the best planning candidate.
   Check what is already done, then write a bounded plan with scope, intended
   result, assumptions, dependencies and verification in its own catch-up doc.
   Ask the human to approve or revise the specific plan. Do not implement until
   the human approves the current plan.
3. **Implemented -> merge approval.** Consider all implemented issues still
   awaiting merge approval. Pick one and prove the exact change is merge-ready:
   link the implementation and review, report relevant test and check results,
   identify failures or outstanding risks, and describe the intended release
   path. Record that proof in its own catch-up doc and ask for approval tied to
   that exact change. Do not merge or release based on triage or plan approval.
   Once the human explicitly approves the current change, merge and release only
   what was approved, then verify and report the production outcome.
4. **Released but open -> close approval.** Consider all released issues that
   remain open. Pick one and prove that its stated outcome is present in the
   released product. Link production evidence; inspect acceptance criteria,
   promised follow-ups and remaining risks. Record that proof in its own
   catch-up doc and ask the human to approve closing that specific issue. Do
   not close it because it was merged or released, or because its merge was
   approved. Close only after separate explicit human approval and record the
   evidence.

The four recommendations may concern different items in a single pass.
Select **at most one per queue**, not one across all queues. If a queue has no
eligible item, report that fact without manufacturing a candidate — an empty
queue produces no catch-up doc. If evidence does not distinguish the best
candidates, disclose the uncertainty and ask the human to choose rather than
inventing a ranking.

## Authority and stop conditions

`human triaged` authorizes planning, `human plan approved` authorizes
implementation and testing of the named plan, and `human merge approved`
authorizes merging and releasing the named change. Closing a released issue
requires **another human approval**; `human close approved` is not an
established stored state or consent mechanism here. Do not silently translate
one approval into another.

Before any action, check that the approval is attributable to the human,
current, unspent, and tied to the exact plan, pull request, or issue. Where
the Overnight Agent consent reader applies, use its fail-closed check and
advertise only approval phrases it accepts; for a merge, follow its
`merge <PR number>` convention. A comment or label is not automatically
machine-verifiable consent. If approval, scope, readiness, release method,
or closure criteria are ambiguous, stop and request a focused decision.
Report failed or unavailable tests and production checks as incomplete, not
as successful results.

## Report back

For each of the four queues, give the selected item's titled link (or say none
is eligible), why it is next, the evidence or blocker, a link to that touch
point's catch-up doc, and the exact human decision requested. The chat summary
points at the docs; it does not replace them. Keep planning, merge and closure
decisions separate. Do not publish to a wiki or create a new issue merely
because this skill was invoked.
