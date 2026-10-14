// net.mjs -- .NET regex and string semantics, and PowerShell value semantics, in JavaScript.
//
// The oa-state port keeps every pattern of oa-state.ps1 VERBATIM and translates it here, so the
// two cannot drift by transcription. This is write-turn.mjs's translator (item 3, proven by
// tests/write-turn-port/regex-diff.mjs against .NET itself), extended with the constructs
// oa-state.ps1 uses that write-turn.ps1 does not: Singleline (`(?s)` / RegexOptions), inline
// option groups (`(?i:...)`), backreferences, and the absolute anchors \A \z \Z.
//
// What it models: .NET `\w` `\d` `\s` `\b` are Unicode-aware; `.` excludes only `\n`; under (?m)
// `^` follows only `\n` and `$` precedes only `\n` (a CRLF line's `\r` is NOT absorbed);
// without (?m) `$` also matches before a final `\n`. .NET matches UTF-16 units, so surrogates are
// mapped one-to-one into the Private Use Area before matching (same length, no case, outside
// every class used here) and every value is read back from the ORIGINAL string by index.
//
// PowerShell's -match / -notmatch / -replace / -split are case-INSENSITIVE; [regex]::Match is
// not. Callers pick: psMatch / psReplace / psSplit vs rx / rxMatches.
import { PsDate } from './psdate.mjs';

const NET_W = '\\p{L}\\p{Mn}\\p{Nd}\\p{Pc}';
const NET_WB = NET_W + '\\u200C\\u200D'; // .NET's \b also counts ZWNJ/ZWJ as word characters
const NET_S = '\\f\\n\\r\\t\\v\\x85\\p{Z}';

export const mapSurrogates = (s) => s.replace(/[\uD800-\uDFFF]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x800));

function translate(src, opts) {
  let { i = false, m = false, s = false } = opts;
  let p = 0;
  const lead = /^\(\?([imsx]+)\)/.exec(src);
  if (lead) {
    for (const c of lead[1]) {
      if (c === 'i') i = true;
      else if (c === 'm') m = true;
      else if (c === 's') s = true;
      else throw new Error(`netRe: unsupported inline option ${c}`);
    }
    p = lead[0].length;
  }
  let out = '';
  let inClass = false;
  // Inline option groups `(?i:...)` / `(?-i:...)`: `^`/`$`/`.` are rewritten here, so m/s are
  // tracked on a stack and applied by the translator; `i` is passed through to JS's modifiers.
  const stack = [];
  let curM = m;
  let curS = s;
  while (p < src.length) {
    const c = src[p];
    if (c === '\\') {
      const n = src[p + 1];
      p += 2;
      if (n === 'w') out += inClass ? NET_W : `[${NET_W}]`;
      else if (n === 'd') out += '\\p{Nd}';
      else if (n === 's') out += inClass ? NET_S : `[${NET_S}]`;
      else if (!inClass && n === 'W') out += `[^${NET_W}]`;
      else if (!inClass && n === 'D') out += '\\P{Nd}';
      else if (!inClass && n === 'S') out += `[^${NET_S}]`;
      else if (!inClass && n === 'b') out += `(?:(?<=[${NET_WB}])(?![${NET_WB}])|(?<![${NET_WB}])(?=[${NET_WB}]))`;
      else if (!inClass && n === 'B') out += `(?:(?<=[${NET_WB}])(?=[${NET_WB}])|(?<![${NET_WB}])(?![${NET_WB}]))`;
      else if (!inClass && n === 'A') out += '(?<![\\s\\S])';
      else if (!inClass && n === 'z') out += '(?![\\s\\S])';
      else if (!inClass && n === 'Z') out += '(?=\\n?(?![\\s\\S]))';
      else if (!inClass && /[1-9]/.test(n)) {
        let num = n;
        while (/[0-9]/.test(src[p] || '')) num += src[p++];
        out += '\\' + num;
      } else if (!inClass && n === 'k' && src[p] === '<') {
        const end = src.indexOf('>', p);
        out += '\\k' + src.slice(p, end + 1);
        p = end + 1;
      } else if (n === 'x') { out += '\\x' + src.slice(p, p + 2); p += 2; }
      else if (n === 'u') { out += '\\u' + src.slice(p, p + 4); p += 4; }
      else if (n === 'p' || n === 'P') {
        const end = src.indexOf('}', p);
        out += '\\' + n + src.slice(p, end + 1);
        p = end + 1;
      } else if ('rntfv'.includes(n)) out += '\\' + n;
      else if (n === '0') out += '\\0';
      else if (/[0-9A-Za-z]/.test(n)) throw new Error(`netRe: unsupported escape \\${n} in ${src}`);
      else out += `\\u{${mapSurrogates(n).codePointAt(0).toString(16)}}`;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      out += mapSurrogates(c);
      p++;
      continue;
    }
    if (c === '[') {
      inClass = true;
      out += '[';
      p++;
      if (src[p] === '^') { out += '^'; p++; }
      if (src[p] === ']') { out += '\\]'; p++; }
      continue;
    }
    if (c === '(') {
      // A mid-pattern option switch `(?i)` / `(?m)` / `(?s)`: applies to the rest of the
      // enclosing group. m/s are applied by the translator; `i` can only be honoured when it is
      // already on or nothing case-sensitive precedes it (true of every pattern in oa-state.ps1).
      const sw = /^\(\?([ims]+)\)/.exec(src.slice(p));
      if (sw) {
        for (const f of sw[1]) {
          if (f === 'm') curM = true;
          else if (f === 's') curS = true;
          else if (!i) {
            if (/[A-Za-z]/.test(src.slice(0, p).replace(/\\./g, ''))) throw new Error(`netRe: (?i) after case-sensitive text is unsupported: ${src}`);
            i = true;
          }
        }
        p += sw[0].length;
        continue;
      }
      const opt = /^\(\?([ims]*)(?:-([ims]+))?:/.exec(src.slice(p));
      if (opt && (opt[1] || opt[2])) {
        stack.push({ m: curM, s: curS });
        let on = '';
        let off = '';
        for (const f of opt[1]) { if (f === 'm') curM = true; else if (f === 's') curS = true; else on += f; }
        for (const f of opt[2] || '') { if (f === 'm') curM = false; else if (f === 's') curS = false; else off += f; }
        out += on || off ? `(?${on}${off ? '-' + off : ''}:` : '(?:';
        p += opt[0].length;
        continue;
      }
      stack.push({ m: curM, s: curS });
      out += c;
      p++;
      continue;
    }
    if (c === ')') {
      const top = stack.pop();
      if (top) { curM = top.m; curS = top.s; }
      out += c;
      p++;
      continue;
    }
    if (c === '.') { out += curS ? '[\\s\\S]' : '[^\\n]'; p++; continue; }
    if (c === '^') { out += curM ? '(?:^|(?<=\\n))' : '^'; p++; continue; }
    if (c === '$') { out += curM ? '(?=\\n|$)' : '(?=\\n?$)'; p++; continue; }
    out += mapSurrogates(c);
    p++;
  }
  return { source: out, flags: 'ud' + (i ? 'i' : '') };
}

export class NetRegex {
  constructor(src, opts = {}) {
    const { source, flags } = translate(src, opts);
    this.src = src;
    this.reG = new RegExp(source, flags + 'g');
  }
  static result(s, mm) {
    const pick = (span) => (span ? s.slice(span[0], span[1]) : undefined);
    const r = mm.indices.map(pick);
    r.index = mm.index;
    r.spans = mm.indices;
    r.groups = mm.indices.groups ? Object.fromEntries(Object.entries(mm.indices.groups).map(([k, span]) => [k, pick(span)])) : undefined;
    return r;
  }
  // First match at or after `start` (Regex.Match(s, start)).
  exec(s, start = 0) {
    const re = this.reG;
    re.lastIndex = start;
    const mm = re.exec(mapSurrogates(s));
    return mm ? NetRegex.result(s, mm) : null;
  }
  test(s) { return this.exec(s) !== null; }
  matches(s) {
    const t = mapSurrogates(s);
    const re = this.reG;
    re.lastIndex = 0;
    const out = [];
    let mm;
    while ((mm = re.exec(t)) !== null) {
      out.push(NetRegex.result(s, mm));
      if (mm[0] === '') re.lastIndex++;
    }
    return out;
  }
  // .NET Regex.Replace with a .NET replacement pattern ($1, ${name}, $$, $0, $&) or a function.
  replace(s, replacement, count = -1) {
    let out = '';
    let last = 0;
    let n = 0;
    for (const mm of this.matches(s)) {
      if (count >= 0 && n >= count) break;
      out += s.slice(last, mm.index);
      out += typeof replacement === 'function' ? replacement(mm) : expandNetReplacement(replacement, mm);
      last = mm.index + mm[0].length;
      n++;
    }
    return out + s.slice(last);
  }
  replaceFirst(s, replacement) { return this.replace(s, replacement, 1); }
  // .NET Regex.Split (what PowerShell's -split does): captured groups are included.
  split(s) {
    const out = [];
    let last = 0;
    for (const mm of this.matches(s)) {
      if (mm[0] === '' && (mm.index === 0 || mm.index === s.length)) continue;
      out.push(s.slice(last, mm.index));
      for (let g = 1; g < mm.length; g++) if (mm[g] !== undefined) out.push(mm[g]);
      last = mm.index + mm[0].length;
    }
    out.push(s.slice(last));
    return out;
  }
}

function expandNetReplacement(rep, mm) {
  return rep.replace(/\$(\$|&|\d+|\{([^}]+)\})/g, (all, tok, name) => {
    if (tok === '$') return '$';
    if (tok === '&') return mm[0];
    if (name !== undefined) {
      if (/^\d+$/.test(name)) return Number(name) < mm.length ? (mm[Number(name)] ?? '') : all;
      return mm.groups && name in mm.groups ? (mm.groups[name] ?? '') : all;
    }
    const g = Number(tok);
    return g < mm.length ? (mm[g] ?? '') : all;
  });
}

const reCache = new Map();
export function netRe(src, { i = false, m = false, s = false } = {}) {
  const key = `${i}|${m}|${s}|${src}`;
  let re = reCache.get(key);
  if (!re) { re = new NetRegex(src, { i, m, s }); reCache.set(key, re); }
  return re;
}

// PowerShell `-match` (case-insensitive). Returns the match array (like $Matches) or null.
export const psMatch = (s, pat) => netRe(pat, { i: true }).exec(psStr(s));
export const psIsMatch = (s, pat) => netRe(pat, { i: true }).test(psStr(s));
// PowerShell `-replace` (case-insensitive, .NET replacement syntax).
export const psReplace = (s, pat, rep = '') => netRe(pat, { i: true }).replace(psStr(s), rep);
// PowerShell `-split <regex>` (case-insensitive; captures included).
export const psSplit = (s, pat) => netRe(pat, { i: true }).split(psStr(s));
// [regex]::Match / ::Matches / ::IsMatch / ::Replace -- case-sensitive unless the pattern says (?i).
export const rx = (s, pat, opts) => netRe(pat, opts).exec(s);
export const rxMatches = (s, pat, opts) => netRe(pat, opts).matches(s);
export const rxTest = (s, pat, opts) => netRe(pat, opts).test(s);
export const rxReplace = (s, pat, rep, opts) => netRe(pat, opts).replace(s, rep);
// [regex]::Escape
export const rxEscape = (s) => String(s).replace(/[\\*+?|{[()^$.# \t\n\r\f]/g,
  (c) => ({ '\t': '\\t', '\n': '\\n', '\r': '\\r', '\f': '\\f', ' ': '\\ ' }[c] ?? '\\' + c));

// ---------------------------------------------------------------------------------------------
// .NET string semantics
// ---------------------------------------------------------------------------------------------
const NET_WS_RE = /[\t\n\v\f\r\x85\p{Z}]/u;
export const isNetWs = (ch) => NET_WS_RE.test(ch);
export function netTrimEnd(s, chars) {
  let e = s.length;
  if (chars !== undefined) { while (e > 0 && chars.includes(s[e - 1])) e--; return s.slice(0, e); }
  while (e > 0 && isNetWs(s[e - 1])) e--;
  return s.slice(0, e);
}
export function netTrimStart(s, chars) {
  let b = 0;
  if (chars !== undefined) { while (b < s.length && chars.includes(s[b])) b++; return s.slice(b); }
  while (b < s.length && isNetWs(s[b])) b++;
  return s.slice(b);
}
export const netTrim = (s, chars) => netTrimEnd(netTrimStart(s, chars), chars);
export const isNullOrWhiteSpace = (s) => s === null || s === undefined || netTrim(String(s)) === '';
// ToLowerInvariant / ToUpperInvariant: simple one-to-one mappings, never context-sensitive.
export function lowerInvariant(s) {
  let out = '';
  for (const ch of String(s)) {
    const l = ch.toLowerCase();
    out += [...l].length === 1 ? l : ch;
  }
  return out;
}
export function upperInvariant(s) {
  let out = '';
  for (const ch of String(s)) {
    const u = ch.toUpperCase();
    out += [...u].length === 1 ? u : ch;
  }
  return out;
}
export const splitLines = (s) => s.split(/\r?\n/);

// ---------------------------------------------------------------------------------------------
// PowerShell value semantics, for values read out of JSON or computed in the port.
// ---------------------------------------------------------------------------------------------
export function psTruthy(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length === 0 ? false : v.length === 1 ? psTruthy(v[0]) : true;
  return true;
}
// "$x": PowerShell's string conversion (InvariantCulture).
export function psStr(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'number') return fmtNumber(v);
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof PsDate) return v.toInvariantString();
  if (v.constructor?.name === 'NetDouble') return v.toString();
  if (Array.isArray(v)) return v.map(psStr).join(' ');
  return '@{' + Object.entries(v).map(([k, x]) => `${k}=${Array.isArray(x) ? 'System.Object[]' : psStr(x)}`).join('; ') + '}';
}
export function fmtNumber(n) {
  if (Number.isInteger(n)) return String(n);
  let s = String(n);
  if (/e/.test(s)) {
    const [mant, exp] = s.split('e');
    const e = Number(exp);
    s = `${mant}E${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
  }
  return s;
}
// PowerShell -eq: the right side is converted to the left side's type; strings compare
// case-insensitively.
export function psEq(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  if (typeof a === 'string') return lowerInvariant(a) === lowerInvariant(psStr(b));
  if (typeof a === 'number') {
    if (typeof b === 'string' && !b.trim()) return a === 0;
    const n = Number(typeof b === 'string' ? b.trim() : b);
    return !Number.isNaN(n) && n === a;
  }
  if (typeof a === 'boolean') return a === psTruthy(b);
  if (a instanceof PsDate && b instanceof PsDate) return a.ticks === b.ticks;
  return a === b;
}
export const ciEq = psEq;
export const ciContains = (arr, v) => (arr || []).some((x) => psEq(x, v));

// ConvertFrom-Json objects are read case-insensitively by property name.
export function prop(obj, name) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || obj instanceof PsDate) return { has: false, value: undefined };
  if (Object.prototype.hasOwnProperty.call(obj, name)) return { has: true, value: obj[name], key: name };
  const lname = name.toLowerCase();
  for (const k of Object.keys(obj)) if (k.toLowerCase() === lname) return { has: true, value: obj[k], key: k };
  return { has: false, value: undefined };
}
export const get = (obj, name) => prop(obj, name).value;
export const has = (obj, name) => prop(obj, name).has;
// Set-Member: update in place when the property exists (keeping its spelling), add otherwise.
export function setMember(obj, name, value) {
  const p = prop(obj, name);
  obj[p.has ? p.key : name] = value;
}
// `Add-Member -NotePropertyName <name> -NotePropertyValue <v> -Force`: REPLACES the member, so an
// existing property moves to the END of the object (unlike setMember / `.name = v`, which keep
// its place). Key order is part of the emitted JSON, so the port must move it too.
export function addMemberForce(obj, name, value) {
  const p = prop(obj, name);
  if (p.has) delete obj[p.key];
  obj[name] = value;
}
// `@($x)`: $null -> empty, scalar -> [scalar], array -> itself.
export const asArray = (v) => (v === null || v === undefined ? [] : Array.isArray(v) ? v : [v]);

// [int] conversion (banker's rounding for doubles, as .NET does).
export function toInt(v) {
  if (v instanceof PsDate) throw new Error('Cannot convert the "System.DateTime" value to type "System.Int32".');
  if (typeof v === 'number') return roundHalfEven(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null || v === undefined) return 0;
  const s = netTrim(psStr(v));
  if (s === '') return 0;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) throw new Error(`Cannot convert value "${psStr(v)}" to type "System.Int32". Error: "The input string '${psStr(v)}' was not in a correct format."`);
  return roundHalfEven(Number(s));
}
export function roundHalfEven(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

// [Math]::Round(x, digits): .NET scales, rounds half to EVEN, and scales back -- so 5.25 KB is
// 5.2, where JS Math.round would say 5.3 (found by the live-data shadow on a 5,376-byte file).
export function netRound(x, digits = 0) {
  if (!Number.isFinite(x) || Math.abs(x) >= 1e16) return x;
  const p = 10 ** digits;
  const r = roundHalfEven(x * p) / p;
  return r === 0 && (x < 0 || Object.is(x, -0)) ? -0 : r;
}

// en-US `{0:N0}`.
const N0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0, minimumFractionDigits: 0 });
export const fmtN0 = (x) => N0.format(x);
