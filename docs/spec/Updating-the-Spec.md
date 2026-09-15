# Keeping the wiki readable and current

The wiki explains what the planner does for you, why it behaves that way, and what can go wrong.
Daily maintenance proposes changes; it does not publish new wording without your approval.

## One review, one place

The same catch-up Google Doc is the review surface each time. A daily check can create at most
one new revision in any rolling 24 hours. It creates nothing when there is no meaningful change.
While a revision awaits your decision, it stays frozen rather than being replaced by tomorrow's
draft. Each review contains before-and-after excerpts and links to the complete proposed pages.

Read the revision and post its exact approval phrase, **Approve wiki revision N**, as a new
comment or reply from the configured human account. Approval of a layout or maintenance process
is not approval of future wording. Other feedback is not treated as permission to publish.

## Publish what was approved

An approval check runs hourly. It verifies the review and its fixed page snapshot, writes those
pages to the accepted repository source, and publishes identical content to the wiki. It checks
the remote result before recording success. Failed publication retries the same revision, without
asking a model to rewrite it. Missing credentials are failures, not silent successful skips.

Do not edit the wiki directly: the accepted repository pages and approval history are authoritative.
Unexpected source changes, altered review text, and withdrawn approval block publication. Existing
topic pages are not automatically deleted. Feedback that changes the proposal must be reconciled
deliberately rather than applying an old approval to new text.

## Keep the reading path simple

The navigation groups are Start here, Plan your day, Let the agent help, Your data and devices,
Read and reply anywhere, Help and known limits, and Optional reference. Domains remain visible
through their purpose and boundaries, not through counts of modules or lists of source files.
Concrete implementation examples belong in labelled, collapsed technical notes.

The [Technical Architecture](https://github.com/shivbijlani/focus-planner/wiki/Technical-Architecture)
companion explains principles and diagrams without implementation code.

> [!NOTE]
> **Technical detail: operating the review cycle.** Setup, credentials, recovery, and verification
> are optional operational reference rather than part of the product explanation.

<details>
<summary><strong>Show maintenance setup and recovery</strong></summary>

The [maintenance runbook](https://github.com/shivbijlani/focus-planner/blob/main/docs/wiki-maintenance.md)
describes deployment variables, the single state branch, guarded source acceptance, and recovery.
The [checked-in policy](https://github.com/shivbijlani/focus-planner/blob/main/docs/wiki-maintenance-policy.md)
is the approved writing and review contract. The former six-hour rolling PR and ad-hoc publisher
are replaced by this single approval-gated workflow.

Candidate verification checks referenced files and issue numbers, domain coverage, readable
navigation, linked headings, and technical-note formatting. It imposes no word-count or code-example
quota. Known gaps must cite currently open issues; historical evidence may cite closed issues
or pull requests with honest framing. These checks complement human review; they do not prove
every narrative claim.

</details>
