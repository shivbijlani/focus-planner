// Output normalisation for the characterization harness.
//
// ONLY three things are normalised, and nothing semantic:
//   1. temp/sandbox paths  -> <ROOT>, <SKILL>, <REPO>   (separators folded to `/` after the token)
//   2. clock-derived times -> <NOW+Nm> / <DATE+Nd> / <STAMP+Nm>, relative to the case clock (T0)
//   3. generated GUIDs     -> <GUID>   (GUIDs supplied by the fixture/case are kept verbatim)
// plus one presentational rule: ANSI colour escapes are stripped. JSON is compared canonically
// (object keys sorted) because PowerShell hashtables serialise in a per-process random order.

// A timestamp is only treated as clock-derived when it lies within this window of T0. Fixture
// dates that are meant to be FIXED must therefore live far away from any run date (the fixtures
// use 2020-xx-xx for "long ago" and 2099-xx-xx for "far future").
const WINDOW_DAYS = 45;
const DAY_MS = 86400000;

const ISO_RE = /\b(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?(?![\d])/g;
const DATE_RE = /(?<![\d-])(\d{4})-(\d{2})-(\d{2})(?![\d:T])/g;
const STAMP_RE = /(?<!\d)(20\d{2})(\d{2})(\d{2})-?(\d{2})(\d{2})(?!\d)/g;
export const GUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const INV_RE = /\b(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})\b/g;
const ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function fmtDelta(prefix, n, unit) {
  const sign = n < 0 ? '-' : '+';
  return `<${prefix}${sign}${Math.abs(n)}${unit}>`;
}

// Minutes from T0, floored into 5-minute buckets (with a 1 s allowance for the whole-second
// truncation of token values). A timestamp generated while the case runs is at most a few minutes
// after T0, so it always lands in bucket 0 however slow the machine; tokens are whole minutes.
const BUCKET_MIN = 5;
function bucket(deltaMs) { return Math.floor((deltaMs / 60000 + 0.02) / BUCKET_MIN) * BUCKET_MIN; }

function localMidnight(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }

export function makeNormalizer({ t0, pathTokens, keepGuids = new Set() }) {
  // Longest first, so a nested path is not pre-empted by a shorter prefix.
  const variants = [];
  for (const [token, p] of pathTokens) {
    if (!p) continue;
    const set = new Set();
    const fwd = p.replace(/\\/g, '/');
    const back = p.replace(/\//g, '\\');
    for (const v of [p, fwd, back, back.replace(/\\/g, '\\\\')]) { set.add(v); set.add(v.toLowerCase()); }
    for (const v of set) variants.push([v, token]);
  }
  variants.sort((a, b) => b[0].length - a[0].length);
  const pathRes = variants.map(([v, token]) => [new RegExp(escapeRe(v), 'g'), token]);
  const t0Day = localMidnight(t0);
  const t0Minute = Math.floor(t0 / 60000) * 60000;

  // A `yyyyMMdd-HHmm` stamp is MINUTE precision, while T0 has milliseconds, so `stamp - T0` for a
  // stamp written while the case runs falls in (-1 min, +a few min] -- straddling the bucket edge
  // at 0. Which side it landed on depended on whether the minute rolled over between T0 and the
  // write (or T0 sat in a minute's first second, inside the 1 s allowance), so the same case
  // recorded <STAMP-5m> and replayed <STAMP+0m>: a flaky gate on every PR. Minute stamps are
  // therefore compared in whole minutes against T0's own minute, with the bucket edge moved 4
  // minutes out: a stamp from T0's minute through the next 3 (and the minute before) is
  // <STAMP-5m>, exactly what every existing golden recorded, and no realistic step lands on an
  // edge. Tokens are not minute stamps in any fixture.
  function stampBucket(stampMs) {
    const minutes = Math.round((stampMs - t0Minute) / 60000);
    return Math.floor((minutes - 4) / BUCKET_MIN) * BUCKET_MIN;
  }

  function paths(s) {
    for (const [re, token] of pathRes) s = s.replace(re, token);
    // Fold separators in the path tail following a token, so goldens are separator-agnostic.
    return s.replace(/<(ROOT|SKILL|REPO)>((?:\\\\|\\|\/)[A-Za-z0-9._@~+\-]+(?:(?:\\\\|\\|\/)[A-Za-z0-9._@~+\-]+)*)/g,
      (_, t, tail) => `<${t}>` + tail.replace(/\\\\|\\/g, '/'));
  }

  function times(s) {
    // PowerShell's InvariantCulture rendering of a [datetime] ("$x" after ConvertFrom-Json turned
    // an ISO string into one). Kept distinguishable from ISO on purpose: the FORMAT is observable.
    s = s.replace(INV_RE, (m, mo, d, y, h, mi, se) => {
      const ms = new Date(+y, +mo - 1, +d, +h, +mi, +se).getTime();
      if (Number.isNaN(ms) || Math.abs(ms - t0) > WINDOW_DAYS * DAY_MS) return m;
      return fmtDelta('INVTIME', bucket(ms - t0), 'm');
    });
    s = s.replace(ISO_RE, (m) => {
      const ms = Date.parse(m);
      if (Number.isNaN(ms) || Math.abs(ms - t0) > WINDOW_DAYS * DAY_MS) return m;
      return fmtDelta('NOW', bucket(ms - t0), 'm');
    });
    s = s.replace(STAMP_RE, (m, y, mo, d, h, mi) => {
      const ms = new Date(+y, +mo - 1, +d, +h, +mi).getTime();
      if (Number.isNaN(ms) || Math.abs(ms - t0) > WINDOW_DAYS * DAY_MS) return m;
      return fmtDelta('STAMP', stampBucket(ms), 'm');
    });
    s = s.replace(DATE_RE, (m, y, mo, d) => {
      const ms = new Date(+y, +mo - 1, +d).getTime();
      if (Number.isNaN(ms) || Math.abs(ms - t0Day) > WINDOW_DAYS * DAY_MS) return m;
      return fmtDelta('DATE', Math.round((ms - t0Day) / DAY_MS), 'd');
    });
    return s;
  }

  function text(s) {
    if (s == null) return s;
    s = String(s).replace(ANSI_RE, '');
    s = paths(s);
    // A GUID the case itself supplied (fixture, overlay, arguments) is DATA and stays verbatim, so
    // two different session ids never collapse into one token; only generated ones are folded.
    s = s.replace(GUID_RE, (g) => (keepGuids.has(g.toLowerCase()) ? g : '<GUID>'));
    return times(s);
  }

  function value(v, key) {
    // Wall-clock DURATIONS (e.g. `scan_seconds`) are timing, not behaviour.
    if (typeof v === 'number' && key && /(^|_)(seconds|elapsed|duration)(_ms)?$|_ms$/.test(key)) return '<DURATION>';
    if (typeof v === 'string') return text(v);
    if (Array.isArray(v)) return v.map((x) => value(x));
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v).sort()) out[text(k)] = value(v[k], k);
      return out;
    }
    return v;
  }

  return { text, value };
}

// PowerShell error decoration carries script line numbers, source excerpts, a `<script>.ps1:`
// prefix and console-width line wrapping, all implementation detail. What is kept is the MESSAGE:
// one string per error, wrapped lines re-joined. Errors generated by PowerShell's own parameter
// binder (not by the scripts) are folded to a stable token naming the parameter, because the
// contract is "that argument is rejected", not the binder's English.
export function cleanStderr(lines) {
  const msgs = [];
  let cur = null;
  const flush = () => { if (cur !== null && cur.trim()) msgs.push(cur.trim()); cur = null; };
  for (let line of lines) {
    if (/^\s*Line \|\s*$/.test(line)) continue;
    if (/^\s*\d+ \|/.test(line)) continue;
    if (/^\s*\|\s*~+\s*$/.test(line)) continue;
    // ConciseView header of a thrown exception: `Exception: <script>:<line>` starts a message.
    if (/^\s*[\w.]*Exception: \S+\.ps1:\d+\s*$/.test(line)) { flush(); cur = ''; continue; }
    const cont = /^\s{2,}\|\s?/.test(line);
    line = line.replace(/^\s{2,}\|\s?/, '');
    if (!line.trim()) continue;
    // `<script>.ps1: message` (Write-Error / binder errors) also starts a message.
    if (!cont && /^[\w.-]+\.ps1: /.test(line)) { flush(); cur = ''; line = line.replace(/^[\w.-]+\.ps1: /, ''); }
    line = line.replace(/(<SKILL>\/[\w.-]+\.ps1):\d+/g, '$1:<LINE>').replace(/\bchar:\d+/g, 'char:<COL>');
    cur = cur ? `${cur} ${line.trim()}` : line.trim();
  }
  flush();
  return msgs.map((m) => m
    .replace(/^Cannot validate argument on parameter '(\w+)'.*$/, '<PS-PARAM-INVALID:$1>')
    .replace(/^A parameter cannot be found that matches parameter name '(\w+)'.*$/, '<PS-PARAM-UNKNOWN:$1>')
    .replace(/^Cannot (?:process argument transformation|bind parameter|convert value).*? parameter '(\w+)'.*$/, '<PS-PARAM-TYPE:$1>')
    .replace(/^Missing an argument for parameter '(\w+)'.*$/, '<PS-PARAM-MISSING-VALUE:$1>'));
}

export function tryParseJson(s) {
  const t = (s || '').trim();
  if (!t || !/^[[{"]/.test(t)) return undefined;
  try { return JSON.parse(t); } catch { return undefined; }
}
