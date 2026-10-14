# Docs deployment seams

The shared Docs reader and docs-core format remain unchanged across deployments.
Configure the host and storage boundary rather than forking the reader.

## Host and boot

`#planner/docs-bootstrap` exports `bootStorage({ host, profile, signal })`.
Vite resolves it through `VITE_DOCS_BOOTSTRAP_MODULE`; the default is
`src/docs-app/storageBoot.js`. It complements `#planner/host-provider`,
`#planner/deployment-profile`, and `#planner/storage-bootstrap`.

Successful boot returns:

```js
{
  hasSources: true,
  activeId: 'source-identity',
  draftScope: { accountId: 'tenant/account', sourceId: 'source-identity' },
  warnings: [] // optional visible, nonfatal warnings
}
```

Boot must finish initializing the shared storage bridge before returning. Reject
or throw on failure; a missing draft scope also fails closed. Honor `signal` when
performing asynchronous initialization so an obsolete session cannot activate
storage for a new session.

The default consumer boot intentionally restores browser storage when there is
no usable configured source. A failed selected-source restore produces a visible
warning. Set `profile.docs.allowBrowserFallback = false` to disable this behavior.
Every non-`consumer-web` profile disables fallback automatically and rejects failed
restore/sync initialization. Managed hosts must supply `host.docsAccountId` or
`host.identity.id`, or use a custom boot returning their scope. Do not treat
browser storage as recovery for a failed managed restore.

`DocsApp` reads `useHost()` from `#planner/host-provider`. Hosts must update
`host.docsSessionKey` on **either account or source changes**; changes to
`host.identity` also reset the session. Alternatively pass a changing
`sessionKey` prop. The previous subtree unmounts immediately, clearing in-memory
drafts, loaded documents, selection, and sheets before the new boot completes.
`DocsApp` also accepts a `bootStorage` prop for hosts already initialized by a
parent shell. The function receives the same arguments as the alias.

Account IDs must include any tenant/cache partition needed to uniquely identify
the authenticated account. Source IDs must identify the actual source, not a
display name shared by different sources. The consumer default is the
`consumer-browser` account and active saved source ID (or `browser-local`).
Hosts with multiple authenticated accounts must supply their actual account ID.

## Draft persistence

`loadDrafts(docId, scope)`, `saveDrafts(docId, drafts, scope)`, and
`draftCount(docId, scope)` require nonempty string `accountId` and `sourceId`.
The v2 key encodes both identities and the doc ID without delimiter ambiguity.
Read/parse/write/delete errors throw and are displayed in the reader/library;
an unreadable draft record is never overwritten by an empty recovery value.
Failed writes retain drafts in the current session with a persistent warning.

Legacy `fp-docs-drafts:<docId>` entries have no trustworthy account/source
attribution. They are **not automatically migrated, displayed as comments, or
deleted**, even for consumer sources. The reader reports their presence without
revealing their content. This conservative policy avoids assigning a previous
account's drafts to the current account; retain the old records for explicit
owner-led recovery.

## Embedding and standalone layout

Import `src/docs-app/docs.css` for embedded Docs. Rules and custom properties
are scoped to `.docs-app` using CSS `@scope`, supported by current Edge/Chromium
and other modern browsers. The reader retains its intentional light paper theme;
its host's light/dark color scheme, body styling, links, controls, and layout are
not reset. Standalone `main.jsx` additionally imports `standalone.css` for the
full-page body margin/background reset. Embedded hosts must not import that
standalone entry/reset. Planner navigation defaults to Vite's base URL.

## Standalone publisher and consumer policy

`@focus/docs-publisher` depends only on `@focus/docs-core` and Node built-ins.
The repository links both with npm workspaces. For installation elsewhere,
provide both packages (for example their `npm pack` tarballs); there is no plugin
tree requirement.

Library `publish(options)` and `acknowledgeReview(options)` accept optional
`assertWritable({ root, task })`. If supplied, it is awaited **inside** the
exclusive `.fp-docs.lock` before any staged/history/response/index write.
Throw/reject to refuse a write. Library callers own their deployment policy and
must supply this guard when policy requires it. Existing `io` adapters continue
to apply to document reads/writes; lock files deliberately use the local filesystem.
Locking uses exclusive file creation, waits up to five seconds, reclaims only a
provably dead PID, and never age-reclaims live holders. Refusals are errors, not
successful empty results.

`@focus/docs-publisher/cli` exports:

```js
await main(argv, { assertPath, assertWritable })
```

`assertPath(absolutePath, label)` is awaited for `PLANNER_PATH` and all draft,
linked-draft, and disposition-file paths. `assertWritable({ root, task })` is
awaited before publish/ack inputs and again inside the publisher lock. Both
functions are required, including for read commands; only `--help` needs no
policy. The executable can instead load them from the absolute module path in
`FP_DOCS_GUARD_MODULE`. Missing/invalid guards fail closed. A deployment needing
logical-text IO should use its own launcher and the library's `io` contract.

The personal consumer launcher is `node scripts\fp-docs.js ...`, injecting the
existing `assertSandboxPath` and `assertDocsTaskWritable` implementations. Native
agent discovery and docs-publish instructions use that launcher. Sandbox escape,
closed/snoozed/paused tasks, served-lane restrictions, and foreign session
ownership remain enforced; package extraction does not bypass them.

## Focused checks

```powershell
npm test -- src\docs-app packages\docs-core packages\docs-publisher
$env:PLAYWRIGHT_CHANNEL = 'msedge' # optional installed Edge instead of bundled Chromium
npx playwright test --config playwright.docs-seams.config.js
npx playwright test docs-app.spec.js --workers 2
npm run build
```

`playwright.personal.config.js` runs the existing Docs flows on the actual
published `https://plannermd.com` build using fresh, isolated Edge contexts and
synthetic browser-local data. It does not attach to the user's open profile or
test their authenticated cloud source. Production baseline checks do not prove
unpublished PR changes are deployed.
