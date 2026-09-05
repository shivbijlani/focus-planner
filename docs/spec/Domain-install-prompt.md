# Domain: install-prompt

## Responsibility

`packages/install-prompt` is the PWA install-nudge UI: a per-platform "add this to your home screen"
flow that has to work around the fact that no single install API exists across browsers — Android
Chrome exposes a native `beforeinstallprompt` event; iOS Safari exposes nothing programmatic at all and
must be walked through the manual Share-sheet steps; other iOS browsers (Chrome/Firefox/Edge on iOS)
are WKWebView wrappers that cannot install a PWA no matter what UI is shown.

## Principal modules

| Module | Role |
| --- | --- |
| `packages/install-prompt/src/useInstallPrompt.js` | The shared hook: platform/browser detection, visit-count and dismissal tracking, and (where available) capture of the native `beforeinstallprompt` event. |
| `packages/install-prompt/src/InstallModal.jsx` | The full instructional flow, including the iOS manual Share-sheet walkthrough. |
| `packages/install-prompt/src/InstallNudge.jsx`, `InstallButton.jsx`, `InstallSuccessToast.jsx` | Lighter-weight entry points into the same hook: a dismissible banner, a manual trigger button, and a post-install confirmation toast. |
| `packages/install-prompt/src/InstallSettingsSection.jsx` | Lets a user re-open the install flow from settings after dismissing the nudge. |
| `packages/install-prompt/src/ShareIcon.jsx` | Renders the exact iOS Share glyph (square with an up-arrow) matching what Safari actually shows, so the instructions point at a recognizable icon rather than a generic one. |

## Public surface

`useInstallPrompt, detectPlatform` (`useInstallPrompt.js`); `InstallButton, InstallModal,
InstallNudge, InstallSettingsSection, InstallSuccessToast, ShareIcon` (component exports, re-exported
from `index.js`).

## Detection and gating logic

`detectPlatform()` classifies `os` as `ios`/`android`/`desktop` from the user-agent, further
classifies `browser` (distinguishing genuine Safari from `CriOS`/`FxiOS`/`EdgiOS` in-app-browser
variants on iOS), and derives `canInstall` as `!isIOS || browser === 'safari'` — the single line that
encodes the WKWebView limitation above. `useInstallPrompt` additionally tracks: whether the app is
already running standalone (`display-mode: standalone` or `navigator.standalone`), a visit counter
gating the nudge to a user who has returned at least `VISIT_THRESHOLD` (3) times rather than
interrupting a first visit, and a dismissal timestamp that suppresses re-prompting for
`DISMISS_REMIND_MS` (30 days) after the user declines.

## Design rationale

The domain exists as a separate package, rather than inline app UI, because the platform-detection and
gating logic (visit count, dismiss cooldown, standalone detection) is reusable independent of exactly
which component surfaces it — the app currently offers four different entry points (button, nudge
banner, settings section, success toast) onto the same underlying hook and state. Centralizing
`detectPlatform`/`useInstallPrompt` means the WKWebView `canInstall` rule and the Safari-icon match are
each defined exactly once rather than duplicated per surface, which matters because getting either one
wrong sends a user through instructions that cannot possibly complete.

## Test coverage

This domain currently has no dedicated automated test file in `testFiles`; its correctness rests on
manual verification against real device/browser combinations (the user-agent matching table above is
itself the executable specification, since there is no test suite pinning it). A rebuilder should treat
adding coverage for `detectPlatform`'s user-agent classification and the visit/dismissal timers as an
open gap, not an intentional omission — the logic is exactly the kind of string-matching table that
silently drifts as browsers change their user-agent strings.

## Failure modes this domain guards against

- **Prompting a user down a dead end** — the `canInstall` gate exists specifically so an iOS
  Chrome/Firefox/Edge user is never shown install instructions that culminate in a missing menu item.
- **Nagging a first-time visitor** — the visit-count threshold exists so the nudge is shown to someone
  who has demonstrated repeat interest, not on the first page load.
- **Re-nagging a user who already said no** — the 30-day dismissal cooldown, tracked independently of
  visit count, exists so a decline is actually respected for a meaningful period.
