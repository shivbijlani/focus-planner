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

// The two top-level files every source contains.
export const PLAN_FILE = 'planner.md'
export const COMPLETED_FILE = 'planner-completed.md'

// Default folder name when the app creates a folder inside a cloud provider
// (e.g. Google Drive). For OneDrive, the folder name is controlled by the
// AAD app registration's display name, not by code.
export const CLOUD_FOLDER_NAME = 'Planner'
