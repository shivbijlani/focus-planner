# @focus/diagnostics

Tiny diagnostics fan-out for planner sync debugging.

Diagnostics are off by default. Enable them with any one of:

- add `?diag=1` to the app URL;
- run `window.__plannerDiag.enable()` in DevTools/CDP;
- set `localStorage.setItem('planner.diag', '1')` and reload.

Read structured events with one CDP evaluate:

```js
window.__plannerDiag.dump()
```

Clear the in-memory ring buffer with:

```js
window.__plannerDiag.clear()
```

Disable diagnostics with `window.__plannerDiag.disable()`.
