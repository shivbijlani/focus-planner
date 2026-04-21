# Stage 7 — Deploy

## Goal
A public GitHub Pages URL that works for a new user in incognito.

## Deliverable
- `.github/workflows/deploy.yml` — build + publish to `gh-pages` on push to main
- `vite.config.ts` — `base` set to the repo path
- `public/404.html` — SPA fallback if any deep links get added later
- Landing copy explaining "Chrome or Edge required for V1"

## Tests
- CI: deploy workflow succeeds on a dummy commit.
- Post-deploy Playwright smoke test against the live URL:
  1. Page loads, no console errors.
  2. "Open planner folder" button visible.
  3. App shell hash matches the commit SHA (cache-bust check).
- Manual: open on a fresh Chrome profile, grant folder once, full lifecycle works.

## First-load UX checklist
- Non-Chromium browser: clear, friendly message + link to download Edge.
- First visit: one button, one sentence of explanation, nothing else.
- Subsequent visits: adapter restores, app opens to last state.
- No analytics, no tracking, no cookies (matches "no auth, no server" promise).

## Done when
- Public URL works end-to-end.
- A fresh user can go from zero to their first task in under 60 seconds.

## Risks retired
- Base path math (common GH Pages trap).
- First-load performance.

## Out of scope
- Custom domain. PWA install prompt (future).
