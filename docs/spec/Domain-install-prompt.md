# Domain: install-prompt

## Responsibility

A self-contained React component package (`packages/install-prompt`) implementing the "Add to Home
Screen" install flow across desktop and mobile PWA install affordances. It has no dependency on the
rest of the app beyond React itself, so it is independently reusable and independently testable.

## Principal modules

| Path | Exports | Role |
| --- | --- | --- |
| `packages/install-prompt/src/useInstallPrompt.js` | `useInstallPrompt`, `detectPlatform` | The hook: listens for the browser's `beforeinstallprompt` event (Chromium) and detects iOS/Android/desktop so the UI can show the right instructions where no native prompt exists (Safari). |
| `packages/install-prompt/src/InstallButton.jsx` | `InstallButton` | A single call-to-action button that triggers the native prompt or opens `InstallModal`. |
| `packages/install-prompt/src/InstallModal.jsx` | `InstallModal` | The full instructional modal, including iOS Safari's manual "Add to Home Screen" steps (no native API exists there). |
| `packages/install-prompt/src/InstallNudge.jsx` | `InstallNudge` | A dismissible, lower-friction nudge shown opportunistically. |
| `packages/install-prompt/src/InstallSettingsSection.jsx` | `InstallSettingsSection` | The Settings-page entry point for installing later. |
| `packages/install-prompt/src/InstallSuccessToast.jsx` | `InstallSuccessToast` | Confirms a successful install. |
| `packages/install-prompt/src/ShareIcon.jsx` | `ShareIcon` | Renders the iOS Share glyph (square + up-arrow) exactly as Safari shows it, since users must find that specific icon to start the manual flow. |

## Design

The platform-detection and prompt-capture logic is isolated in `useInstallPrompt.js` precisely so
every visual component (`InstallButton`, `InstallModal`, `InstallNudge`, ...) can share one behavioral
source of truth: which platform is this, is a native prompt available, has the user already
dismissed/ installed. `ShareIcon.jsx` exists as its own module because getting an OS-chrome icon
pixel-faithful is a distinct, narrowly-scoped concern from the modal's copy and layout.

## Failure modes

- On a platform with no native `beforeinstallprompt` (iOS Safari), the component tree must fall back
  to the manual instructional modal rather than silently doing nothing — `detectPlatform` exists
  specifically to drive that branch.
- A stale "already installed" detection would keep nudging a user who already installed the app;
  the hook is expected to track install state across the session it is mounted in.

There is no dedicated `testFiles` suite for this package in the collected facts; correctness here is
exercised through the app's own manual QA rather than an automated behavioural spec.
