// settings.mjs -- the values oa-state reads from user-settings.md itself (#310 / #579 / #391).
//
// Precedence: an explicit command-line parameter, then the settings row, then the built-in
// default. An absent, unreadable, empty or malformed file yields the defaults EXACTLY, and each
// resolved value reports where it came from: default | settings | settings-malformed | argument.
import { rx, rxEscape, netTrim, psIsMatch, psMatch, lowerInvariant } from '../core/net.mjs';
import { readJournalText, testPath } from '../core/fsx.mjs';

// settings-value.ps1: the first backtick span, otherwise the whole cell, trimmed.
export function convertFromSettingCell(cell) {
  const m = rx(String(cell ?? ''), '`([^`]*)`');
  if (m) return netTrim(m[1]);
  return netTrim(String(cell ?? ''));
}

// One `| Setting | Value |` row, matched on the setting name at the start of the cell.
export function getSettingRow(text, name) {
  if (!text) return null;
  const re = '(?im)^\\s*\\|\\s*' + rxEscape(name) + '\\s*\\|\\s*([^|\\r\\n]*?)\\s*\\|';
  const m = rx(text, re);
  if (!m) return null;
  return convertFromSettingCell(m[1]);
}

export const GateDefaults = { BackstopHours: 6, Strict: false };

export function resolveGateSettings(ctx) {
  const { p, explicit } = ctx;
  const explicitBackstop = explicit.has('TodayGateBackstopHours');
  const explicitStrict = explicit.has('TodayGateStrict');
  let backstop = GateDefaults.BackstopHours;
  let strict = GateDefaults.Strict;
  let backstopSource = 'default';
  let strictSource = 'default';
  if (!(explicitBackstop && explicitStrict)) {
    const path = ctx.userSettingsPath();
    if (path) {
      let text = null;
      try { text = readJournalText(path); } catch { text = null; }
      if (text) {
        const v = getSettingRow(text, 'Today gate backstop');
        if (v) {
          backstopSource = 'settings-malformed';
          let m;
          if (psIsMatch(v, '^(?i)(off|none|disabled)$')) { backstop = 0; backstopSource = 'settings'; }
          else if ((m = psMatch(v, '^\\s*(\\d+)'))) { backstop = Number(m[1]); backstopSource = 'settings'; }
        }
        const s = getSettingRow(text, 'Today gate strict');
        if (s !== null && s !== '') {
          strictSource = 'settings-malformed';
          if (psIsMatch(s, '^(?i)(on|yes|true)$')) { strict = true; strictSource = 'settings'; }
          else if (psIsMatch(s, '^(?i)(off|no|false)$')) { strict = false; strictSource = 'settings'; }
        }
      }
    }
  }
  let BackstopHours;
  if (!explicitBackstop) BackstopHours = backstop; else { BackstopHours = p.TodayGateBackstopHours; backstopSource = 'argument'; }
  let GateStrict;
  if (explicitStrict) { GateStrict = !!p.TodayGateStrict; strictSource = 'argument'; } else GateStrict = !!strict;
  if (p.TodayServedMinutes === 0) { GateStrict = true; strictSource = 'argument'; }
  if (BackstopHours < 0) { BackstopHours = GateDefaults.BackstopHours; backstopSource = 'default'; }
  ctx.BackstopHours = BackstopHours;
  ctx.GateStrict = GateStrict;
  ctx.BackstopSource = backstopSource;
  ctx.GateStrictSource = strictSource;
}

export const PacingDefaults = { Concurrency: 1 };

export function resolvePacingSettings(ctx) {
  let value = PacingDefaults.Concurrency;
  let source = 'default';
  const path = ctx.userSettingsPath();
  if (path) {
    let text = null;
    try { text = readJournalText(path); } catch { text = null; }
    if (text) {
      const v = getSettingRow(text, 'Overnight Agent concurrency');
      if (v !== null && v !== '') {
        source = 'settings-malformed';
        const m = psMatch(v, '^\\s*(\\d+)\\s*$');
        if (m) {
          const n = Number(m[1]);
          if (n >= 1) { value = n; source = 'settings'; }
        }
      }
    }
  }
  ctx.ConcurrencyLimit = value;
  ctx.ConcurrencySource = source;
}

const MODEL_RE = '^(?i)(auto|claude-(?:sonnet|opus|haiku)-[0-9]+(?:\\.[0-9]+)?|gpt-[0-9]+(?:\\.[0-9]+)?(?:-[a-z0-9]+)*|gemini-[0-9]+(?:\\.[0-9]+)?-[a-z0-9-]+|grok-[0-9]+(?:\\.[0-9]+)?|mai-code-[0-9]+(?:\\.[0-9]+)?-[a-z0-9-]+)$';

export function getAgentModelSettings(ctx) {
  const path = ctx.userSettingsPath();
  let value = null;
  if (path && testPath(path)) {
    try { value = getSettingRow(readJournalText(path), 'Overnight Agent model'); } catch { return { model: 'auto', source: 'settings-unreadable' }; }
  }
  if (value === null) return { model: 'auto', source: 'default' };
  if (psIsMatch(value, MODEL_RE)) return { model: lowerInvariant(value), source: 'settings' };
  return { model: 'auto', source: 'settings-malformed' };
}
