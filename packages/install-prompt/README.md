# @local/install-prompt

PWA install prompt UI — drop-in React components for any of our apps.

This package is **vendored** (duplicated across repos rather than published).
When you fix a bug here, copy the directory to the other consumers.

## Components

| Export | What it does |
|---|---|
| `useInstallPrompt()` | Hook that tracks install state, eligibility, platform. |
| `<InstallButton onOpen={...} appName="X" />` | Compact "Install app" button. Auto-hides when installed. |
| `<InstallModal onClose={...} appName="X" />` | Native one-click flow when supported; platform-specific manual instructions otherwise (with iOS Safari hand-holding + non-Safari iOS warning). |
| `<InstallNudge onOpen={...} appName="X" />` | Throttled bottom-right toast (3rd visit, 30-day dismiss). |
| `<InstallSettingsSection onOpen={...} appName="X" />` | Always-on settings card. Auto-hides when installed. |
| `<InstallSuccessToast appName="X" />` | One-time top-center toast on first standalone launch. |

## Usage

```jsx
import {
  InstallButton, InstallModal, InstallNudge,
  InstallSettingsSection, InstallSuccessToast,
} from '@local/install-prompt'
import '@local/install-prompt/styles.css'

function App() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <InstallButton onOpen={() => setOpen(true)} appName="Planner" />
      <InstallNudge onOpen={() => setOpen(true)} appName="Planner" />
      <InstallSuccessToast appName="Planner" />
      {open && <InstallModal onClose={() => setOpen(false)} appName="Planner" />}
      {/* In your Settings dialog: */}
      <InstallSettingsSection onOpen={() => setOpen(true)} appName="Planner" />
    </>
  )
}
```

## Behaviour

- All components return `null` when running as installed PWA
  (`display-mode: standalone` or iOS `navigator.standalone`).
- Native install path uses the `beforeinstallprompt` event (Chrome/Edge/Android).
- iOS Safari: shows Add-to-Home-Screen instructions with the share glyph.
- iOS non-Safari (Chrome/Firefox/Edge on iOS): explains that only Safari
  can install PWAs and tells the user to open the link in Safari.
- LocalStorage keys used: `install-prompt-dismissed-at`,
  `install-prompt-visit-count`, `install-prompt-welcome-shown`.

## Styling

Import `@local/install-prompt/styles.css` for the default look. Override CSS
custom properties on `:root` to retheme:

```css
:root {
  --install-prompt-accent: #ea580c;
  --install-prompt-radius: 12px;
}
```

Or override class names by replacing them entirely — every public component
accepts a `className` / `sectionClassName` where relevant.
