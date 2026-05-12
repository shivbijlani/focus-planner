/**
 * Centralised branding for the app. Anything user-visible that names the
 * app or its primary files should be sourced from here so a future rename
 * is a one-file change.
 *
 * Internal storage keys (e.g. `fp-file:`, `fp-sources`) intentionally keep
 * their historical prefix so existing user data continues to load without
 * a heavy storage migration. The user-facing names below are independent
 * of those keys.
 */

export const APP_NAME = 'Planner'
export const APP_DESCRIPTION = 'Markdown-backed task planner for focus and productivity'

// The two top-level files every source contains. Renamed from focus-plan*
// to planner* for the rebrand. The migration in src/storage/rename-files.js
// transparently upgrades any existing `focus-plan.md` / `focus-plan-completed.md`
// in localStorage / FSA / OneDrive / GoogleDrive on first read.
export const PLAN_FILE = 'planner.md'
export const COMPLETED_FILE = 'planner-completed.md'

// Legacy names — kept as constants for the one-time rename migration.
export const LEGACY_PLAN_FILE = 'focus-plan.md'
export const LEGACY_COMPLETED_FILE = 'focus-plan-completed.md'

// Default folder names when the app creates a folder inside a cloud provider
// (e.g. Google Drive). For OneDrive, the folder name is controlled by the
// AAD app registration's display name, not by code.
export const CLOUD_FOLDER_NAME = 'Planner'
