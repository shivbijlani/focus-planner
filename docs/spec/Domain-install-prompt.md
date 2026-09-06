# Domain: install-prompt

`install-prompt` (`packages/install-prompt/`) is a small, self-contained React package implementing
cross-platform "install this PWA" UX: the browser-native prompt where supported, and a manual
instructional flow (notably for iOS Safari, which exposes no install API at all).

## Responsibility

Detect the current platform/browser's install capability and present the right affordance for it —
a real install button where `beforeinstallprompt` fires, or a modal walking the user through
Safari's Share-sheet "Add to Home Screen" flow where it does not — plus a settings-page entry point
and a post-install success toast.

## Principal modules

| Path | Purpose |
| --- | --- |
| `packages/install-prompt/src/useInstallPrompt.js` | The platform-detection hook (`detectPlatform`, `useInstallPrompt`) driving every component below. |
| `packages/install-prompt/src/InstallButton.jsx` | A direct install trigger, shown when the native prompt is available. |
| `packages/install-prompt/src/InstallModal.jsx` | The manual walkthrough (e.g. iOS Share-sheet instructions) for platforms with no native prompt. |
| `packages/install-prompt/src/InstallNudge.jsx` | A dismissible, less intrusive install suggestion. |
| `packages/install-prompt/src/InstallSettingsSection.jsx` | The settings-page entry point to (re-)trigger install guidance. |
| `packages/install-prompt/src/InstallSuccessToast.jsx` | Confirms a successful install. |
| `packages/install-prompt/src/ShareIcon.jsx` | The iOS Share glyph (square with an up-arrow), matching what users actually see in Safari's chrome, since the modal has to visually match the exact UI the user is being told to tap. |

## Public exports

`InstallButton`, `InstallModal`, `InstallNudge`, `InstallSettingsSection`, `InstallSuccessToast`,
`ShareIcon`, `detectPlatform`, `useInstallPrompt`.

## Behavioural requirements

This domain currently has no dedicated test suite in `testFiles` (0 files, 0 tests) — its
correctness today rests on manual verification across real browsers, which `ShareIcon.jsx`'s own
doc comment implicitly acknowledges: "Matches what users see at the bottom (portrait) or top
(landscape/iPad) of Safari" is a claim about live browser chrome, not something a unit test can
assert. A rebuilder should treat platform detection (`detectPlatform`) as the one piece worth
covering with automated tests, since every component's correct behavior is entirely conditioned on
its output.

## Failure modes

A `detectPlatform` misclassification is the single point of failure for the whole domain: every
downstream component (`InstallButton`, `InstallModal`, `InstallNudge`) branches on its result, so a
wrong platform read shows the wrong instructions (e.g. the native-prompt button on a platform that
has none) rather than crashing — a silent UX defect rather than a loud one, which is exactly the
shape of bug this domain has no automated check for.
