// psdate.mjs -- a model of .NET System.DateTime as PowerShell 7 produces and consumes it.
//
// Why a class and not a JS Date: three observable behaviours of the PowerShell depend on .NET's
// DateTime, and the goldens pin all three.
//   1. KIND. ConvertFrom-Json (PowerShell 7) turns an ISO string with an offset into a Local
//      DateTime (converted to this machine's zone), one ending in `Z` into a Utc DateTime, and one
//      with neither into an Unspecified DateTime. ConvertTo-Json writes them back as
//      `...-07:00`, `...Z` and `...` respectively, with trailing zero fractions trimmed.
//   2. "$x". Interpolating a DateTime renders InvariantCulture `MM/dd/yyyy HH:mm:ss`.
//   3. COMPARISON. DateTime compares wall-clock ticks and IGNORES Kind.
// So a DateTime here is (wall-clock ticks, kind): the ticks are the digits on the clock face.
const TICKS_PER_MS = 10000n;
const EPOCH_TICKS = 621355968000000000n; // 1970-01-01 in .NET ticks

const p2 = (n) => String(n).padStart(2, '0');
const p4 = (n) => String(n).padStart(4, '0');

// The local UTC offset (minutes, east positive) in force at a UTC instant.
export function localOffsetMinutesAtUtc(utcMs) {
  return -new Date(utcMs).getTimezoneOffset();
}
// The local UTC offset for a LOCAL wall clock (resolving DST the way .NET does closely enough:
// the offset in force at the instant that wall clock denotes).
export function localOffsetMinutesAtWall(wallMs) {
  let off = localOffsetMinutesAtUtc(wallMs);
  off = localOffsetMinutesAtUtc(wallMs - off * 60000);
  return localOffsetMinutesAtUtc(wallMs - off * 60000);
}

export class PsDate {
  // ticks: BigInt wall-clock ticks since 0001-01-01; kind: 'Local' | 'Utc' | 'Unspecified'
  constructor(ticks, kind = 'Unspecified') {
    this.ticks = BigInt(ticks);
    this.kind = kind;
  }
  static fromWallMs(wallMs, kind = 'Unspecified', subMsTicks = 0n) {
    return new PsDate(EPOCH_TICKS + BigInt(Math.trunc(wallMs)) * TICKS_PER_MS + BigInt(subMsTicks), kind);
  }
  static fromInstant(utcMs, kind = 'Local') {
    if (kind === 'Utc') return PsDate.fromWallMs(utcMs, 'Utc');
    return PsDate.fromWallMs(utcMs + localOffsetMinutesAtUtc(utcMs) * 60000, kind);
  }
  // Get-Date / [datetime]::Now
  static now() { return PsDate.fromInstant(Date.now(), 'Local'); }
  static utcNow() { return PsDate.fromInstant(Date.now(), 'Utc'); }
  static fromParts(y, mo, d, h = 0, mi = 0, s = 0, ms = 0, kind = 'Unspecified', subMsTicks = 0n) {
    const t = new Date(Date.UTC(2000, mo - 1, d, h, mi, s, ms));
    t.setUTCFullYear(y);
    return PsDate.fromWallMs(t.getTime(), kind, subMsTicks);
  }
  get wallMs() { return Number((this.ticks - EPOCH_TICKS) / TICKS_PER_MS) - (this.ticks < EPOCH_TICKS && (this.ticks - EPOCH_TICKS) % TICKS_PER_MS !== 0n ? 1 : 0); }
  get subMsTicks() { const r = (this.ticks - EPOCH_TICKS) % TICKS_PER_MS; return r < 0n ? r + TICKS_PER_MS : r; }
  parts() {
    const d = new Date(this.wallMs);
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), ms: d.getUTCMilliseconds(), dow: d.getUTCDay() };
  }
  // 7-digit fraction (ticks within the second)
  fraction7() {
    const r = ((this.ticks % 10000000n) + 10000000n) % 10000000n;
    return String(r).padStart(7, '0');
  }
  // The UTC instant (ms) this DateTime denotes. Unspecified is treated as Local (as .NET's
  // ToUniversalTime does).
  instantMs() {
    if (this.kind === 'Utc') return this.wallMs;
    return this.wallMs - localOffsetMinutesAtWall(this.wallMs) * 60000;
  }
  offsetMinutes() {
    if (this.kind === 'Utc') return 0;
    return localOffsetMinutesAtWall(this.wallMs);
  }
  toUniversalTime() {
    if (this.kind === 'Utc') return this;
    return new PsDate(this.ticks - BigInt(this.offsetMinutes()) * 60n * 1000n * TICKS_PER_MS, 'Utc');
  }
  toLocalTime() {
    if (this.kind === 'Local') return this;
    const utcWall = this.wallMs;
    const off = localOffsetMinutesAtUtc(utcWall);
    return new PsDate(this.ticks + BigInt(off) * 60n * 1000n * TICKS_PER_MS, 'Local');
  }
  get date() { const { y, mo, d } = this.parts(); return PsDate.fromParts(y, mo, d, 0, 0, 0, 0, this.kind); }
  addMs(ms) { return new PsDate(this.ticks + BigInt(Math.round(ms * 10000)), this.kind); }
  addSeconds(n) { return this.addMs(n * 1000); }
  addMinutes(n) { return this.addMs(n * 60000); }
  addHours(n) { return this.addMs(n * 3600000); }
  addDays(n) { return this.addMs(n * 86400000); }
  // DateTime - DateTime: wall-clock difference, ignoring Kind. Returned in milliseconds.
  diffMs(other) { return Number(this.ticks - other.ticks) / 10000; }
  compare(other) { return this.ticks < other.ticks ? -1 : this.ticks > other.ticks ? 1 : 0; }
  // K: Local -> "-07:00", Utc -> "Z", Unspecified -> "".
  kSuffix() {
    if (this.kind === 'Utc') return 'Z';
    if (this.kind === 'Unspecified') return '';
    return fmtOffset(this.offsetMinutes());
  }
  // .ToString(format) for the custom formats the script uses.
  format(fmt) {
    const { y, mo, d, h, mi, s } = this.parts();
    if (fmt === 'o' || fmt === 'O') return `${p4(y)}-${p2(mo)}-${p2(d)}T${p2(h)}:${p2(mi)}:${p2(s)}.${this.fraction7()}${this.kSuffix()}`;
    if (fmt === 's') return `${p4(y)}-${p2(mo)}-${p2(d)}T${p2(h)}:${p2(mi)}:${p2(s)}`;
    if (fmt === 'u') { const u = this.kind === 'Utc' ? this : this; const q = u.parts(); return `${p4(q.y)}-${p2(q.mo)}-${p2(q.d)} ${p2(q.h)}:${p2(q.mi)}:${p2(q.s)}Z`; }
    let out = '';
    let i = 0;
    while (i < fmt.length) {
      const c = fmt[i];
      if (c === "'" || c === '"') {
        const end = fmt.indexOf(c, i + 1);
        out += fmt.slice(i + 1, end < 0 ? fmt.length : end);
        i = end < 0 ? fmt.length : end + 1;
        continue;
      }
      if (c === '\\') { out += fmt[i + 1] ?? ''; i += 2; continue; }
      let n = 1;
      while (fmt[i + n] === c) n++;
      const tok = c.repeat(n);
      switch (c) {
        case 'y': out += n === 2 ? p2(y % 100) : n === 1 ? String(y % 100) : String(y).padStart(n, '0'); break;
        case 'M': out += n >= 2 ? p2(mo) : String(mo); break;
        case 'd': out += n >= 2 ? p2(d) : String(d); break;
        case 'H': out += n >= 2 ? p2(h) : String(h); break;
        case 'h': { const hh = h % 12 || 12; out += n >= 2 ? p2(hh) : String(hh); break; }
        case 'm': out += n >= 2 ? p2(mi) : String(mi); break;
        case 's': out += n >= 2 ? p2(s) : String(s); break;
        case 'f': out += this.fraction7().slice(0, n); break;
        case 'F': out += this.fraction7().slice(0, n).replace(/0+$/, ''); break;
        case 'K': out += this.kSuffix(); break;
        case 'z': {
          const off = this.kind === 'Utc' ? 0 : this.offsetMinutes();
          const sign = off < 0 ? '-' : '+';
          const a = Math.abs(off);
          out += n === 1 ? `${sign}${Math.floor(a / 60)}` : n === 2 ? `${sign}${p2(Math.floor(a / 60))}` : `${sign}${p2(Math.floor(a / 60))}:${p2(a % 60)}`;
          break;
        }
        case 't': out += n === 1 ? (h < 12 ? 'A' : 'P') : h < 12 ? 'AM' : 'PM'; break;
        default: out += tok;
      }
      i += n;
    }
    return out;
  }
  // "$x" (InvariantCulture): MM/dd/yyyy HH:mm:ss
  toInvariantString() { return this.format('MM/dd/yyyy HH:mm:ss'); }
  // Newtonsoft's ISO rendering, as ConvertTo-Json writes a DateTime.
  toJsonString() {
    const { y, mo, d, h, mi, s } = this.parts();
    const frac = this.fraction7().replace(/0+$/, '');
    return `${p4(y)}-${p2(mo)}-${p2(d)}T${p2(h)}:${p2(mi)}:${p2(s)}${frac ? '.' + frac : ''}${this.kSuffix()}`;
  }
  toJSON() { return this.toJsonString(); }
  toString() { return this.toInvariantString(); }
}

export function fmtOffset(min) {
  const sign = min < 0 ? '-' : '+';
  const a = Math.abs(min);
  return `${sign}${p2(Math.floor(a / 60))}:${p2(a % 60)}`;
}

// The strings ConvertFrom-Json (PowerShell 7 / Newtonsoft) turns into DateTime.
const JSON_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?(Z|[+-]\d{2}(?::?\d{2})?)?$/;
export function jsonDateOrNull(s) {
  const m = JSON_DATE_RE.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo) || h > 23 || mi > 59 || se > 59) return null;
  const frac = BigInt((m[7] || '').padEnd(7, '0') || '0');
  const base = PsDate.fromParts(y, mo, d, h, mi, se, 0, 'Unspecified', 0n);
  const wall = new PsDate(base.ticks + frac, 'Unspecified');
  if (!m[8]) return wall;
  if (m[8] === 'Z') return new PsDate(wall.ticks, 'Utc');
  const om = /^([+-])(\d{2})(?::?(\d{2}))?$/.exec(m[8]);
  const off = (om[1] === '-' ? -1 : 1) * (Number(om[2]) * 60 + Number(om[3] || 0));
  const utc = new PsDate(wall.ticks - BigInt(off) * 600000000n, 'Utc');
  return utc.toLocalTime();
}
export const daysInMonth = (y, mo) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

// [datetime]::Parse(text) / [datetime]$text (en-US / Invariant): ISO forms (with optional
// offset/Z -> converted to Local) and the M/d/yyyy H:mm:ss forms. Throws when not a date.
export function parseDateTime(text) {
  if (text instanceof PsDate) return text;
  const s = String(text).trim();
  let mm = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.(\d{1,7}))?)?)?\s*(Z|[+-]\d{1,2}(?::?\d{2})?)?$/i.exec(s);
  if (mm) {
    const [y, mo, d, h, mi, se] = [mm[1], mm[2], mm[3], mm[4] || 0, mm[5] || 0, mm[6] || 0].map(Number);
    if (!validParts(y, mo, d, h, mi, se)) throw new Error(`String '${text}' was not recognized as a valid DateTime.`);
    const frac = BigInt((mm[7] || '').padEnd(7, '0') || '0');
    const wall = new PsDate(PsDate.fromParts(y, mo, d, h, mi, se).ticks + frac, 'Unspecified');
    if (!mm[8]) return wall;
    if (mm[8].toUpperCase() === 'Z') return new PsDate(wall.ticks, 'Utc').toLocalTime();
    const om = /^([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(mm[8]);
    const off = (om[1] === '-' ? -1 : 1) * (Number(om[2]) * 60 + Number(om[3] || 0));
    return new PsDate(wall.ticks - BigInt(off) * 600000000n, 'Utc').toLocalTime();
  }
  mm = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?\s*(AM|PM)?)?$/i.exec(s);
  if (mm) {
    let [mo, d, y, h, mi, se] = [mm[1], mm[2], mm[3], mm[4] || 0, mm[5] || 0, mm[6] || 0].map(Number);
    if (mm[7]) { if (h < 1 || h > 12) throw new Error(`String '${text}' was not recognized as a valid DateTime.`); h = (h % 12) + (mm[7].toUpperCase() === 'PM' ? 12 : 0); }
    if (!validParts(y, mo, d, h, mi, se)) throw new Error(`String '${text}' was not recognized as a valid DateTime.`);
    return PsDate.fromParts(y, mo, d, h, mi, se);
  }
  throw new Error(`String '${text}' was not recognized as a valid DateTime.`);
}
export function tryParseDateTime(text) {
  try { return parseDateTime(text); } catch { return null; }
}
function validParts(y, mo, d, h, mi, s) {
  return y >= 1 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo) && h <= 23 && mi <= 59 && s <= 59;
}
// [datetime]::TryParseExact(text, 'yyyy-MM-dd', Invariant)
export function parseExactYmd(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text));
  if (!m) return null;
  const [y, mo, d] = m.slice(1).map(Number);
  if (!validParts(y, mo, d, 0, 0, 0)) return null;
  return PsDate.fromParts(y, mo, d);
}
