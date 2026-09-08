---
name: readable-architecture-doc
description: >-
  Writes readable specifications and architecture reports for any repository. Use for readable
  specs, design theses, architecture documents, technical reports, repo overviews, or whenever
  technical depth should be collapsible and visually distinct. Produces plain-language conclusions,
  optional technical details, and a code-free architecture companion with Mermaid diagrams.
argument-hint: 'Repository, feature, or system to document.'
user-invocable: true
---

# Readable architecture document

Write a repository specification that a non-technical reader can follow from top to bottom without
losing the architectural depth an engineer needs. The primary document explains behavior and
rationale. Optional implementation detail is collapsed and visually distinct. Deeper architecture
lives in a linked companion document with diagrams and principles, never implementation code.

This is a development skill. It writes documentation for repositories; it is not packaged into or
distributed with the application being documented.

## When to use

- The user asks for a spec, design thesis, architecture report, system overview, or repository
  documentation.
- The document must serve technical and non-technical readers without forcing either audience
  through the other's level of detail.
- Technical details should be collapsible, colorized like notes, or moved to a linked deep dive.
- An existing spec has become an implementation inventory instead of an explanation of product
  behavior and design intent.

## 1. Establish the evidence

Read the repository's contribution guidance, existing documentation, tests, configuration, and
principal modules. Treat tests as behavioral evidence and source comments as design-rationale
evidence. Use issues and pull requests only when their current state and framing are clear.

Do not infer a requirement from a filename or invent missing rationale. When evidence is
incomplete, name the uncertainty rather than smoothing it into authoritative prose.

## 2. Write the main reading path

Lead every page or major section with:

1. What the system does for a person.
2. Why that behavior matters.
3. The principle or tradeoff behind it.
4. What can go wrong, described in observable terms.

Use present tense and plain language. Define unavoidable domain terms on first use. Do not use code,
module paths, commands, schemas, or signatures as the explanation; those are supporting evidence,
not the narrative.

## 3. Collapse concrete technical detail

Put implementation detail behind this exact portable Markdown structure. The alert and collapsible
block are adjacent rather than nested because GitHub renders nested alert markers as literal text:

```markdown
> [!NOTE]
> **Technical detail: descriptive label.** Optional depth; the surrounding section states the
> product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

The concrete example, schema, signature, module path, or operational detail.

</details>
```

Choose the alert by meaning:

| Alert | Use |
| --- | --- |
| `NOTE` | Neutral implementation context |
| `TIP` | A useful extension or operating technique |
| `IMPORTANT` | An invariant a rebuilder must preserve |
| `WARNING` | A failure mode or unsafe alternative |

Keep the alert label specific enough that a reader can decide whether to open the following block.
Do not hide the product conclusion or decision inside the collapsed region.

## 4. Link to a code-free architecture companion

When the main document needs deeper explanation, create or update a linked
`Technical-Architecture.md` companion. It may contain:

- architectural ideas and boundaries;
- principles and rejected alternatives;
- Mermaid diagrams showing components, authority, lifecycle, or data flow;
- operational invariants and failure models.

It must not contain implementation code, signatures, copyable commands, or data samples. Mermaid
fences are allowed because they render diagrams rather than executable implementation. Link back to
the relevant product-facing page, and link to the companion from the main index with:

```markdown
[Technical Architecture](Technical-Architecture)
```

## 5. Check the rendered artifact

Inspect the final Markdown, not merely the command that produced it.

- A reader can understand the conclusion without opening any `<details>` block.
- Every technical block has a descriptive summary and an adjacent GitHub alert.
- The target renderer turns alerts into styled callouts rather than literal marker text.
- Collapsible blocks are collapsed initially and expand without losing formatting.
- The architecture companion contains no fenced blocks except `mermaid`.
- Every linked deep-dive page is reachable from the document index.
- Claims about behavior and verification link to evidence when links are available.

If the target Markdown renderer does not support GitHub alerts, replace the alert with its closest
styled callout component while preserving the `<details>` boundary, and state the compatibility
choice in the delivery note.
