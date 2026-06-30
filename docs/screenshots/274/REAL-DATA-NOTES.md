# #274 — Mobile layout, captured from the REAL planner (not sample data)

These screenshots replace the earlier sample-data harness. They are the actual
Focus Planner app rendering **Shiv's real planner data** (his real `planner.md`
board + journals), so they show what was previously missing: the **⋯ kebab**,
the **expandable todos**, and the **linked / lead-up tasks**.

## How they were produced (reproducible, no sign-in)
- Ran the app locally (`npm run dev`, http://localhost:5173).
- Seeded the browser `localStorage` (`fp-file:` keys) from the real
  `C:\Users\shiv\OneDrive\Apps\Focus Planner\` files: `planner.md`,
  `planner-completed.md`, and all 146 `journal/task-*.md` files, with the
  storage provider forced to `local-storage`.
- Viewport: **390 × 844 (iPhone 13)**, which triggers the app's mobile mode
  (`max-width: 768px`).

## What they show
1. `real-iphone13-01-default.png` — default board. ID column shows real
   linked-ID arrows (e.g. `326 → 204`, `297 → 323`); rows show real
   todo-preview expanders and first child/todo text. The **Work Priority**
   column is already clipped at the right edge.
2. `real-iphone13-02-row-expanded.png` — a row expanded (#297 *New york trip*)
   showing the real lead-up list / journal todos.
3. `real-iphone13-03-scrolled-right.png` — scrolled right to reveal the
   columns that are off-screen by default: **Work Priority**, **Age**, the
   **📓 journal** button, and the **⋯ kebab**.

## The problem, quantified
At 390px the task table is **495px wide** (content) vs **344px visible** — about
**151px (≈ a third) is clipped** and only reachable by horizontal scroll. That
hidden strip is exactly Work Priority + Age + journal + kebab. This is the
concrete "not enough space to show everything" of #274.
