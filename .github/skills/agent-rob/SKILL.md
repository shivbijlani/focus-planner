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
is next, and give the human enough evidence to decide.

This is a **repository-local skill**. The Overnight Agent plugin refers to it
when working in the Focus Planner repository; it does not ship this skill to
plugin installations. If the repository skill is unavailable, do not claim to
have run the ROB.

## Where the states are recorded

The handoff states are stored as GitHub labels on the issue, so a decision made
in one pass is still verifiable in the next:

| State | Label | Authorizes |
| --- | --- | --- |
| Not started | *no handoff label* | Being proposed for triage |
| `human triaged` | `human-triaged` | Writing a plan for that issue |
| `human plan approved` | `human-plan-approved` | Implementing and testing the named plan |
| `human merge approved` | `human-merge-approved` | Merging and releasing the named change |
| `human close approved` | `human-close-approved` | Closing that specific issue |

**Unstarted means no handoff label.** An issue carrying none of the four labels
has not entered the ROB and is eligible for triage; the labels are the state,
and you do not need to reconstruct it from history. Each queue below is defined
by the label an item carries.

The label is the durable record; the approval reply is the authorization to
apply it. After the human approves a touch point, apply that state's label to
the issue and say so in the report, then remove the previous state's label so
an issue carries exactly one handoff label. Applying a label is the *only*
repository write this skill performs without a further approval, and only for
the state the human just approved.

A label the agent applied without a matching human approval is not consent, and
neither is a label of unknown origin. Check that the labelling event is
attributable to the human, or to an agent pass that recorded the approval it
acted on. If an issue's label and its discussion disagree, report the state as
unverified and do not advance it.

## Start each pass

Read the current planner, journals, relevant GitHub issues and pull requests,
release evidence, and any existing catch-up documents. Establish which items
actually belong to each queue from the handoff labels; do not infer
completion from a commit title, an open issue, or a planner row alone. Respect
the existing Overnight Agent priority and consent rules.

For every queue, name the signal that put an item there and where that signal
came from. If a source is unavailable or its evidence is stale relative to
another source, describe what could not be verified rather than treating
absence of evidence as a clear queue. Where the planner and GitHub disagree
about an item's state, prefer the labels and issue history, say which source
was stale, and do not rank items on evidence you have just called unreliable.

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

If a caller prohibits writing to the document store or its bindings, as in a
read-only trial, do not read or modify the binding at all. Write each touch
point's document as a clearly unbound local file instead, and state in the
document and the report that it is not bound to the item and that a reply to
it will not be seen or recorded as approval.

Each document is written for a reader with no prior context: status and the
exact decision first, then what the work is, why it matters, the evidence
behind every claim as links, and what happens on approval. Name and link
identifiers with their resource titles instead of bare numbers. Advertise only
an approval phrase the consent reader accepts. Do not answer a human's
document comments in a comment thread: amend the document to answer them.
Follow the skill's target-specific formatting rules.

## The four handoff queues

1. **Not started -> human triage.** Find issues carrying none of the four
   handoff labels. Skip anything already closed, merged or deployed — that work
   has left the backlog even if it was never labelled. Check the planner entry,
   journal and linked context so already active, deferred or blocked work is
   not proposed as new. Choose one item needing triage. Make the case for why
   it should be triaged *next*: value, timing, urgency, dependencies,
   supporting evidence, and what could change the ranking. Ask the human to
   triage it, defer it, or pick another. Do not plan or implement it on the
   strength of the recommendation. Write its triage catch-up doc and point the
   human at it. On approval, apply `human-triaged`.
2. **`human triaged` -> plan approval.** Consider all issues labelled
   `human-triaged` without an approved plan. Pick one and say why it is the
   best planning candidate. Check what is already done, then write a bounded
   plan with scope, intended result, assumptions, dependencies and verification
   in its own catch-up doc. Ask the human to approve or revise the specific
   plan. Do not implement until the human approves the current plan. On
   approval, apply `human-plan-approved`.
3. **Implemented -> merge approval.** An item is awaiting merge approval when
   an open, non-draft pull request implements it and it does not yet carry
   `human-merge-approved`. Pick one and prove the exact change is merge-ready:
   link the implementation, report relevant test and check results, identify
   failures or outstanding risks, and describe the intended release path.
   Passing checks alone are not merge-readiness; state what the change does,
   what could break, and what you verified beyond CI. An absent code review
   does **not** make an item ineligible — the human's merge approval *is* the
   review, and this proof is what they review. A merge conflict, a failing or
   unreported check, a draft pull request, or a change whose scope you cannot
   describe does make it ineligible; say so and pick another or report the
   queue empty. Record that proof in its own catch-up doc and ask for approval
   tied to that exact change. Do not merge or release based on triage or plan
   approval. Once the human explicitly approves the current change, apply
   `human-merge-approved`, merge and release only what was approved, then
   verify and report the production outcome.
4. **Released but open -> close approval.** Consider every open issue whose
   change has reached production, whether or not it carries a handoff label.
   Pick one and prove that its stated outcome is present in the released
   product. Require a deployment record tied to the merged commit and the
   production URL or behavior it affects; a comment asserting that work
   shipped is a claim to verify, not evidence. Inspect acceptance criteria,
   promised follow-ups and remaining risks, and resolve or explicitly surface
   each one before recommending closure. Record that proof in its own catch-up
   doc and ask the human to approve closing that specific issue. Do not close
   it because it was merged or released, or because its merge was approved.
   Close only after separate explicit human approval, apply
   `human-close-approved`, and record the evidence.

The four recommendations may concern different items in a single pass.
Select **at most one per queue**, not one across all queues. If a queue has no
eligible item, report that fact without manufacturing a candidate — an empty
queue produces no catch-up doc. If evidence does not distinguish the best
candidates, disclose the uncertainty and ask the human to choose rather than
inventing a ranking.

## Authority and stop conditions

`human triaged` authorizes planning, `human plan approved` authorizes
implementation and testing of the named plan, `human merge approved`
authorizes merging and releasing the named change, and `human close approved`
authorizes closing that issue. Each transition requires **its own** approval;
do not silently translate one approval into another, and do not treat a merge
approval as permission to close.

Before any action, check that the approval is attributable to the human,
current, unspent, and tied to the exact plan, pull request, or issue. Where
the Overnight Agent consent reader applies, use its fail-closed check and
advertise only approval phrases it accepts; for a merge, follow its
`merge <PR number>` convention. A label records a decision already made; it is
not itself the human's consent, and neither is an unattributed comment. If
approval, scope, readiness, release method, or closure criteria are ambiguous,
stop and request a focused decision. Report failed or unavailable tests and
production checks as incomplete, not as successful results.

## Report back

For each of the four queues, give the selected item's titled link (or say none
is eligible), why it is next, the evidence or blocker, a link to that touch
point's catch-up doc, and the exact human decision requested. The chat summary
points at the docs; it does not replace them. Keep planning, merge and closure
decisions separate. Do not publish to a wiki or create a new issue merely
because this skill was invoked.
