# Domain: install-prompt

`install-prompt` is a small React package for "install this planner as an app" UX. It centralises platform detection, the native browser install prompt when available, manual instructions when no install API exists, a softer nudge after repeat visits, a settings entry point, and a first-run installed-app toast. The package is intentionally self-contained so the app can drop it into different surfaces without duplicating browser-specific logic. See [Architecture](Architecture) and [Domain-app](Domain-app).

## Responsibility

`packages/install-prompt/src/useInstallPrompt.js` is the package's authority. It decides whether the planner already runs in standalone mode, classifies the platform and browser from `navigator.userAgent`, records visit counts and dismissals in `localStorage`, captures `beforeinstallprompt`, and exposes a single state object to all UI components. The design is pragmatic rather than abstract. On iOS, only Safari can install PWAs, so every other iOS browser gets instructions to switch browsers instead of a dead install button.

> [!NOTE]
> **Technical detail: concrete example** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

```js
export function detectPlatform() {
  ...
  const canInstall = !isIOS || browser === 'safari'
  return { os, browser, canInstall }
}

export function useInstallPrompt() {
  const [installed, setInstalled] = useState(() => readStandalone())
  const [deferred, setDeferred] = useState(null)
  const [eligible, setEligible] = useState(false)
  ...
}
```


</details>
## Modules and exports

> [!NOTE]
> **Technical detail: concrete reference.** Optional implementation detail; the surrounding section states the product behavior.

<details>
<summary><strong>Show technical detail</strong></summary>

| Path | Exports from `spec-facts.json` | Role |
| --- | --- | --- |
| `packages/install-prompt/src/InstallButton.jsx` | `InstallButton` | Direct trigger for the native prompt or modal. |
| `packages/install-prompt/src/InstallModal.jsx` | `InstallModal` | Overlay with native install CTA or manual install instructions by platform. |
| `packages/install-prompt/src/InstallNudge.jsx` | `InstallNudge` | Visit-threshold-based install suggestion with dismiss action. |
| `packages/install-prompt/src/InstallSettingsSection.jsx` | `InstallSettingsSection` | Settings-page card for reopening install guidance. |
| `packages/install-prompt/src/InstallSuccessToast.jsx` | `InstallSuccessToast` | One-time standalone welcome toast. |
| `packages/install-prompt/src/ShareIcon.jsx` | `ShareIcon` | iOS share glyph matching Safari chrome. |
| `packages/install-prompt/src/index.js` | `InstallButton`, `InstallModal`, `InstallNudge`, `InstallSettingsSection`, `InstallSuccessToast`, `ShareIcon`, `useInstallPrompt` | Public package surface. |
| `packages/install-prompt/src/useInstallPrompt.js` | `detectPlatform`, `useInstallPrompt` | Stateful platform detection and prompt orchestration. |

</details>

## Principal mechanics

The hook uses three persistent keys: `install-prompt-dismissed-at`, `install-prompt-visit-count`, and `install-prompt-welcome-shown`. Eligibility for a soft nudge starts only after `VISIT_THRESHOLD = 3` visits and is suppressed for `30` days after dismissal. `promptInstall()` only calls the browser-native prompt when a deferred event exists; otherwise the modal explains manual steps. `InstallModal.jsx` branches carefully: native prompt if available, Safari-specific share-sheet steps on install-capable iOS, a browser-switch warning for non-Safari iOS, menu-based instructions on Android, and address-bar or browser-menu instructions on desktop.

The components stay thin on purpose. `InstallButton.jsx`, `InstallNudge.jsx`, `InstallSettingsSection.jsx`, and `InstallSuccessToast.jsx` only read the hook and render affordances. That structure keeps browser detection in one file, which matters because the main risk is not a crash but a plausible lie: showing an install path that cannot work on the current browser.

## Behavioural requirements from tests

`spec-facts.json` contains no install-prompt domain test entries, so this domain currently has no dedicated automated behavioural spec in the repository. The implementation still exposes concrete rebuild requirements from source:

- Standalone mode suppresses install UI and triggers a one-time welcome toast.
- The soft nudge appears only after repeated visits and respects a 30-day dismissal cooldown.
- `beforeinstallprompt` is captured and deferred so the app can decide when to ask.
- Non-Safari iOS never claims installation is possible in-place.
- Manual instructions name the exact UI the user should tap, including the Safari share glyph rendered by `ShareIcon`.

A rebuilder should treat missing tests here as an explicit gap, not as proof the behaviour is trivial.

## Failure modes

The dominant failure mode is misclassification: if `detectPlatform()` is wrong, every downstream component becomes wrong in a way that still looks polished. The user sees the wrong instructions, an unavailable install button, or no install affordance at all. Because the defect is silent and per-platform, this package is unusually dependent on real-browser verification. The package mitigates that partly by concentrating all detection and state in `useInstallPrompt.js`, so there is one place to test and one place to fix.
