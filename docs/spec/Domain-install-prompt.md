# Domain: install-prompt

## Responsibility

Cross-platform "install this as an app" UX (a PWA install prompt), because browsers do
not agree on how installability is surfaced: Chromium exposes a native
`beforeinstallprompt` event the app can trigger from its own button, while iOS Safari
exposes no such event at all and requires walking the user through the manual
Share-sheet → "Add to Home Screen" flow. This domain owns detecting which situation the
current visitor is in and rendering the right UI for it.

## Principal modules

| Module | Role |
| --- | --- |
| `packages/install-prompt/src/useInstallPrompt.js` | The hook: platform/browser detection (`detectPlatform`), visit-count and dismissal tracking (localStorage-backed, so a rejected prompt doesn't nag every session), and capturing the native install event when available. |
| `packages/install-prompt/src/InstallModal.jsx` | The full install dialog — native one-click install on Chromium, step-by-step Share-sheet instructions (using `ShareIcon.jsx`'s exact glyph) on iOS Safari. |
| `packages/install-prompt/src/InstallButton.jsx` / `InstallNudge.jsx` / `InstallSuccessToast.jsx` | Smaller UI pieces: an explicit install button, a soft in-context nudge after enough visits, and a confirmation toast after a successful install. |
| `packages/install-prompt/src/InstallSettingsSection.jsx` | Surfaces install status/actions inside the app's settings screen. |
| `packages/install-prompt/src/ShareIcon.jsx` | The iOS Share glyph (square with an up-arrow), matched exactly to what users see in Safari's UI, so instructions can point at a familiar icon rather than a generic one. |

## Public exports

`packages/install-prompt/src/index.js` re-exports: `InstallButton`, `InstallModal`,
`InstallNudge`, `InstallSettingsSection`, `InstallSuccessToast`, `ShareIcon`,
`useInstallPrompt`. `useInstallPrompt.js` additionally exports `detectPlatform` directly.

## Design decision: platform detection over feature detection alone

`detectPlatform()` does not rely solely on the presence of the native install event,
because iOS genuinely has no equivalent event to feature-detect — every non-Safari
browser on iOS (Chrome-iOS, Firefox-iOS, Edge-iOS) is a WKWebView wrapper mandated by
Apple's platform policy and cannot install a PWA at all, regardless of what the user-agent
string suggests about the underlying rendering engine. `detectPlatform` therefore
special-cases iOS explicitly: `canInstall` is true only when `os === 'ios'` implies
`browser === 'safari'`, or the platform is not iOS at all. Getting this wrong would show
install instructions to a user whose browser cannot act on them.

## Behavioural characteristics (no automated test suite)

This domain has no dedicated test file in the current suite — its correctness currently
rests on the `detectPlatform` logic being simple enough to review by inspection and on
manual verification across real devices. The load-bearing invariants a rebuild must
preserve, read directly from the implementation:

- `canInstall` must be `false` for every non-Safari iOS browser (Chrome-iOS, Firefox-iOS,
  Edge-iOS, and any other iOS browser), since none of them expose "Add to Home Screen."
- Visit-count and dismissal state must persist across sessions (localStorage keys
  `install-prompt-visit-count`, `install-prompt-dismissed-at`,
  `install-prompt-welcome-shown`) so a user who dismisses the prompt is not shown it again
  immediately on the next visit — the dismissal is honored for a fixed remind-later window
  before the nudge can reappear.
- Standalone-mode detection (`display-mode: standalone` media query, or
  `navigator.standalone` on iOS) must suppress the install prompt entirely once the app is
  already installed — prompting to install an app the user has already installed is the
  UX failure this check exists to prevent.

## Failure modes

- Treating `canInstall` as a pure user-agent sniff without the iOS special case would
  offer a native install flow to a WKWebView wrapper browser that has no way to fulfill
  it, producing a dead button.
- Skipping the localStorage dismissal/visit tracking would make the nudge reappear every
  session regardless of the user's prior choice — exactly the nagging behavior the visit
  threshold and remind-later window exist to avoid.
