# Reader-first wiki maintenance policy

The wiki explains the product to a person, not how to rebuild its source code. Its domains
remain visible through their purpose, user experience, boundaries, and failure modes. Module
counts, file inventories, commands, schemas, and function lists do not belong on the main
reading path. Necessary implementation reference is explicitly labelled and collapsed.
The architecture companion contains principles and diagrams, never implementation code.

## Approved navigation

The home page presents these seven reader-facing destinations:

- **Start here:** purpose, domain map, and how the pieces help a person.
- **Plan your day:** tasks, journals, and setting priorities.
- **Let the agent help:** permissions, how the agent chooses work, and how it keeps running.
- **Your data and devices:** storage, synchronization, and protecting edits and deletions.
- **Read and reply anywhere:** Telegram and task papers.
- **Help and known limits:** installation, credentials, diagnostics, and known gaps.
- **Optional reference:** maintenance, detailed formats, and code-free architecture.

Prioritization and long-running reliability are product topics, not hidden developer details.
Describe ranking separately from permission. Explain bounded runs, retained progress, task
isolation, independent supervision, safe stuck detection, recovery, and visible unresolved
failures. Distinguish evidence-backed behavior from a desired future capability.
Retain existing topic pages until a separate explicit decision authorizes their removal.

## One review per day, one review document

A daily check compares accepted documentation with changed project inputs. No relevant change
means no new review. An executable, persistent rolling 24-hour limit also covers manual runs,
retries, and duplicate triggers. Approval checks may run more frequently.

There is exactly one configured, existing Google Doc for reviews. Never title-search for or
create a replacement if it is inaccessible. Append a clearly identified revision with what
changed, why it matters, and immutable full-page previews. Preserve existing prose and human
comments. Freeze the pending review: subsequent changes wait until it is published.

The Google Doc is the discussion and approval surface; this versioned policy is the durable
instruction for unattended generation. The general writing skill describes the method, while
the project updater receives its document binding and approver identity through configuration.
Review comments proposing new requirements must be reconciled by a human/agent into a policy
change before generation; automation must not turn arbitrary comments into its own authority.

## Approval binds exact content

The human posts exactly **Approve wiki revision N**, where N is the visible revision number.
Approval must be newly authored by the configured approver after that review was presented.
An edited old comment, a different author, an approval of another revision, or a general
"looks good" is not authorization. Human replies may carry approval, but agent replies may not.

The revision identifies an immutable snapshot and a digest of every page. Check the review
text, approval, source baseline, policy, page coverage, readability, and links before publishing.
Never regenerate, reformat, or substitute pages after approval. New source-code changes may
wait, but changed accepted documentation or policy blocks publication rather than overwriting it.

Write the approved pages to the accepted repository first, then mirror those exact bytes to the
wiki and verify the remote result. Repository branch protections still apply. Permission errors,
missing credentials, unavailable review data, and publication failures must fail visibly. A
retry resumes the same approved revision; it never creates a new proposal or claims a failed
publication succeeded.

## Publication is not automatic approval

The daily process may propose changes, not approve them. No general merge automation or manual
wiki mirror may bypass the review gate. The approval to implement this maintenance process is
not approval of any future generated wiki revision.
