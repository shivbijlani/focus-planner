# Future UI & Packaging Ideas

Illustrative, not prescriptive. How a future version might *present* the capabilities in `features.md` and where it might ship.

## Packaging targets
- PWA install banner on web.
- iOS app via Capacitor → App Store.
- Android app via Capacitor → Play Store.
- Desktop app via Tauri → Microsoft Store / direct download.

The core (UI + worker + file-formats) stays the same; packaging just wraps it.

## UI surfaces
- Dark mode and a theme system.
- Keyboard shortcuts throughout.
- Command palette (Cmd/Ctrl-K) covering every capability.
- Rich-text editor toggle on journals (still persists as markdown).
- Code block syntax highlighting inside journals.
- Calendar view for tasks with due dates.
- Conflict-resolution view when sync detects divergent edits.
- Search box with live filtering across tasks and journals.
- Reminder / notification center.
- Settings screen for adapter selection (local folder, OneDrive, encrypted sync, etc.).

## Intentionally unspecified
Exact layouts, breakpoints, navigation model, mobile gestures. These should be decided at build time against the capabilities list.
