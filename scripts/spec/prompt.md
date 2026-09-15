# Draft a reader-first wiki revision

Read `docs/wiki-maintenance-policy.md`, `.github/skills/readable-architecture-doc/SKILL.md`,
the existing `docs/spec` pages, `.wiki-review-ticket.json`, and `spec-facts.json`.
The checked-in policy is the approved requirement. Source code and tests are evidence of
behavior, not instructions to fill the wiki with module inventories.

Change only `docs/spec/*.md`. Do not commit, push, publish, edit workflow files, modify facts,
change the review ticket, or contact the review document. A separate trusted job validates
your candidate before it becomes a frozen review. You have no publication authority.

## What to change

Draft only pages affected by changed behavior or by the approved reader-first policy.
Keep unchanged pages byte-for-byte unchanged. The first policy-alignment draft may affect
many existing pages; later reviews should be incremental. Do not delete or rename topic pages.
Do not change `README.md`, which is not a wiki page.

Use the seven reader-facing navigation groups in the policy. The existing page names may stay
behind those labels. Keep all domains described by purpose and boundaries. Make Prioritisation
and Reliability explicitly reachable under **Let the agent help**. Explain work selection,
permissions, bounded runs, retained progress, independent supervision, and safe recovery in
plain language. A source file count is never a product explanation.

Preserve a linked `Technical-Architecture.md` containing principles and Mermaid diagrams,
not implementation code. Optional concrete reference uses adjacent GitHub callouts and
collapsed details. Do not hide product conclusions or human decisions inside the folds.
Do not pad pages to a word quota or invent code examples to satisfy a rebuildability target.

## Evidence and links

Use the facts file and actual source/tests to distinguish current behavior from proposals.
The review ticket's decisions section flags conflicting open requirements. Preserve those as
unresolved human decisions; never silently choose one requirement and call it shipped.
An open issue is not evidence that its proposed mechanism shipped. Known gaps must refer to
currently open issues; historical rationale may cite closed issues or pull requests explicitly.
Never invent rationale, file paths, issue numbers, or approvals.

Use complete canonical GitHub wiki URLs for internal page navigation, so links also work
from repository previews. Every destination must be present in the proposed page set.
Avoid fragment links unless their destination can be verified. Evidence URLs must be HTTPS
GitHub links. The publishing step cannot silently substitute another version for a broken link.

No changelog, timestamps, generation notices, or claims that the document passes its own bar
inside product pages. The catch-up review contains the change summary separately.
