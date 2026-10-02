// psjson.mjs -- ConvertFrom-Json / ConvertTo-Json as PowerShell 7 behaves.
//
// ConvertFrom-Json: ISO date-time strings become DateTime (PsDate) -- see psdate.mjs for the
// kinds. Everything else is plain JSON.
//
// ConvertTo-Json: a container (object or array) nested deeper than -Depth (default 2) is not
// serialised but STRINGIFIED the way "$x" would ("1 2" for an array, "@{a=1}" for an object,
// "System.Collections.Hashtable" for a hashtable), and PowerShell writes ONE warning line,
// `WARNING: Resulting JSON is truncated as serialization has exceeded the set depth of N.`
// Pipeline input is collected: `$x | ConvertTo-Json` with one item emits that item (not a
// one-element array), and with no items emits nothing at all.
import { PsDate, jsonDateOrNull } from './psdate.mjs';
import { psStr } from './net.mjs';

// Marks an object as a PowerShell Hashtable / OrderedDictionary (only its "$x" differs).
export const PS_KIND = Symbol('psKind');
export const hashtable = (o = {}) => { Object.defineProperty(o, PS_KIND, { value: 'Hashtable', enumerable: false }); return o; };
export const ordered = (o = {}) => { Object.defineProperty(o, PS_KIND, { value: 'OrderedDictionary', enumerable: false }); return o; };

export function fromJson(text) {
  const t = String(text ?? '');
  if (!t.trim()) return null;
  return JSON.parse(t, (k, v) => (typeof v === 'string' ? jsonDateOrNull(v) ?? v : v));
}

function containerString(v) {
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === 'object' && !(x instanceof PsDate) ? containerString(x) : psStr(x))).join(' ');
  if (v[PS_KIND] === 'Hashtable') return 'System.Collections.Hashtable';
  if (v[PS_KIND] === 'OrderedDictionary') return 'System.Collections.Specialized.OrderedDictionary';
  return psStr(v);
}

// A .NET Double, for the values the PowerShell computes as [double] ([Math]::Round, `/`).
// ConvertTo-Json writes those differently from an integer: 6.0, -0.0, 1E+20. Plain JS numbers
// keep the integer rendering (what Int32/Int64 values and parsed JSON integers produce).
export class NetDouble {
  constructor(v) { this.v = v; }
  toJSON() { return this.v; }
  valueOf() { return this.v; }
  toString() { return Object.is(this.v, -0) ? '-0' : String(this.v); }
}
export const netDouble = (v) => new NetDouble(v);
const DBL = '\u0000NETDOUBLE:';
function netDoubleJson(x) {
  if (Object.is(x, -0)) return '-0.0';
  if (!Number.isFinite(x)) return JSON.stringify(String(x));
  // .NET's shortest round-trip form: scientific when the decimal exponent is >= 17 or < -4 (measured).
  const a = Math.abs(x);
  if (a !== 0 && (a >= 1e17 || a < 1e-4)) {
    const m = /^(-?[\d.]+)e([+-])(\d+)$/.exec(x.toExponential());
    return `${m[1]}E${m[2]}${m[3].padStart(2, '0')}`;
  }
  return Number.isInteger(x) ? `${x}.0` : String(x);
}

// Returns { text, truncated }. `value` is serialised as the -InputObject (no pipeline unrolling).
export function toJson(value, { depth = 2, compress = false } = {}) {
  let truncated = false;
  const walk = (v, level) => {
    if (v === undefined || v === null) return null;
    if (v instanceof PsDate) return v.toJsonString();
    if (v instanceof NetDouble) return DBL + netDoubleJson(v.v) + '\u0000';
    if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'bigint') return Number(v);
    if (typeof v !== 'object') return psStr(v);
    if (level > depth) { truncated = true; return containerString(v); }
    if (Array.isArray(v)) return v.map((x) => walk(x, level + 1));
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = walk(x, level + 1);
    return out;
  };
  const shaped = walk(value, 0);
  let text = compress ? JSON.stringify(shaped) : JSON.stringify(shaped, null, 2);
  text = text.replace(/"\\u0000NETDOUBLE:([^\\\\"]*)\\u0000"/g, '$1');
  return { text, truncated, depth };
}

export const truncationWarning = (depth) => `WARNING: Resulting JSON is truncated as serialization has exceeded the set depth of ${depth}.`;

// `$x | ConvertTo-Json`: pipeline semantics. Returns null when nothing would be written.
export function pipeToJson(value, opts) {
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    if (value.length === 1) return toJson(value[0], opts);
  }
  return toJson(value, opts);
}
