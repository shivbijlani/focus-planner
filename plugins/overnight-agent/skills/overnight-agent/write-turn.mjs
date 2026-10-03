#!/usr/bin/env node
/*
  write-turn.mjs -- the sanctioned way to write an Overnight Agent turn into a journal.

  A Node port of write-turn.ps1 with IDENTICAL behaviour (item 3 of the "one product, two
  deployments" plan; spec decision: "the sanctioned write tool is a Node command-line script the
  agent runs; nothing extra stays running"). Zero dependencies, Node 20+, one self-contained file
  so a mutation check can copy it anywhere and run the copy.

  THE CONTRACT IS THE GOLDENS. `tests/characterization` pins what write-turn.ps1 observably does
  (exit code, stdout/JSON, stderr message, file effects) and runs the same cases against this file:
      node tests/characterization/run.mjs --impl node --tool write-turn
  Every quirk below that looks odd is deliberate: it is what the PowerShell does, measured.

  WHY THE TOOL EXISTS (write-turn.ps1 carries the long history of each guard): a journal turn
  can be silently corrupted on its way to disk, and a rule the tool refuses to let you break is
  finished in a way a prose rule never is. It is APPEND ONLY -- it never rewrites or deletes
  existing content, so it physically cannot eat one of Shiv's replies -- and the body comes from
  a FILE, so the turn never passes through a shell string.

  Guards (exit 2, nothing written):
    G1  lost-interpolation tombstone (`~\-275`)          G2  doubled apostrophe (`don''t`)
    G3  an H2 that is not moon-first                     G4  provenance marker with no heading
    G5  no moon-anchored heading at all                  G7  a turn heading with no provenance
    G8  provenance marker at the start of a fenced line  G9-G11 pointer guards (doc-bound task)
    G12 one turn per wake (property of the destination)  G13 the declared ask (-Ask required)
    G14 a question declared as not needing him           G15 proposing already-shipped work
    G16 an advertised reply word the reader rejects      G17 a turn into a user-paused task
    G18 an unverified agent-gate edit ask                G19 a proposed plan's first step
  G6 is not a refusal: a journal with no OVERNIGHT-AGENT sentinel gets one on append.
  G20 a target that is not this task's own journal (agent-gate.md, user-settings.md, a path in
      -Id, a symlink out of -JournalDir). G21 a hand-written `oa-by` identity stamp. G22 a turn
      into a snoozed task. None can be switched off with -DisableGuard: they are what make the tool
      the ONLY way an agent writes.

  Every appended turn carries `<!-- oa-by: session=<id> host=<host> -->` under its provenance
  marker and `oa-ask` stamp: which agent wrote it, from which machine (-Author, else
  COPILOT_AGENT_SESSION_ID; WRITE_TURN_HOST, else COMPUTERNAME / the host name).

  The sent-messages ledger (spec: a reply on Teams, mail or a Google Doc counts as his only if its
  message id is NOT one the agent sent) lives here too, as two subcommands:
    node write-turn.mjs record-sent -Channel teams -MessageId <id> [-TaskId 448] [-At <iso>]
    node write-turn.mjs was-sent -Channel teams -MessageId <id>
  Both print JSON; the ledger is <OA home>/sent-messages.jsonl (docs/spec/Data-Formats.md).

  Per-device agent metadata (the 🤖 session link; docs/spec/Domain-agent-metadata.md) is published
  here too, so it is written by the sanctioned tool and nothing else:
    node write-turn.mjs publish-metadata [-SessionsListFile <host session list>] [-Revalidate <id>]
  It writes only <planner>/agent-metadata/<this device's key>.json (oa-state-lib/act/agent-metadata.mjs).

  Usage (PowerShell-style names, GNU `--name` and `--name=value` are accepted too):
    node write-turn.mjs -Id 448 -BodyFile turn.md -Ask offer             # validate, back up, append
    node write-turn.mjs -Id 448 -BodyFile turn.md -Ask blocking -Validate  # validate only
    node write-turn.mjs -BodyFile turn.md -Ask none -Validate -Json       # lint any turn text

  Exit codes: 0 ok - 2 guard violation (nothing written) - 3 OA_SANDBOX_ROOT violation -
  1 bad arguments / missing body / missing journal (PowerShell's `Write-Error` under
  `$ErrorActionPreference = 'Stop'` terminates with 1, whatever the `exit 3` after it says).
*/
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MOON = '\u{1F319}';
const IS_WIN = process.platform === 'win32';
const EOL = IS_WIN ? '\r\n' : '\n';
const SEP = IS_WIN ? '\\' : '/';

// #425 pointer-turn thresholds: REFUSE at 1500 (above the first real pointer turn, 902 chars),
// NUDGE at 800 (the issue's own target). Both measured; see write-turn.ps1.
const POINTER_CEILING = 1500;
const POINTER_NUDGE = 800;

// ---------------------------------------------------------------------------------------------
// .NET regex semantics, in JavaScript.
//
// Every pattern below is the PowerShell script's pattern verbatim, translated by netRe() rather
// than rewritten by hand, so the two cannot drift by transcription. The translation covers the
// differences that matter: .NET `\w` `\d` `\s` `\b` are Unicode-aware; `.` excludes only `\n`;
// under (?m) `^` follows only `\n` and `$` precedes only `\n` (so a CRLF line's `\r` is NOT
// absorbed -- a quirk several guards depend on); without (?m) `$` also matches before a final `\n`.
// PowerShell's -match/-notmatch/-split are case-INSENSITIVE; [regex]::Match is not -- callers pick.
// ---------------------------------------------------------------------------------------------
const NET_W = '\\p{L}\\p{Mn}\\p{Nd}\\p{Pc}';
const NET_WB = NET_W + '\\u200C\\u200D'; // .NET's \b also counts ZWNJ/ZWJ as word characters
const NET_S = '\\f\\n\\r\\t\\v\\x85\\p{Z}';

// .NET matches UTF-16 UNITS; a `u`-mode JS class would swallow a whole surrogate pair. So the
// subject (and any literal in the pattern) has every surrogate unit mapped one-to-one into the
// Private Use Area (D800-DFFF -> E000-E7FF): same length, and -- like a surrogate in .NET -- no
// case and outside every class used here. Values are read back from the ORIGINAL string by index.
const mapSurrogates = (s) => s.replace(/[\uD800-\uDFFF]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x800));

function translate(src, opts) {
  let { i = false, m = false } = opts;
  let p = 0;
  const lead = /^\(\?([imx]+)\)/.exec(src);
  if (lead) {
    for (const c of lead[1]) {
      if (c === 'i') i = true;
      else if (c === 'm') m = true;
      else throw new Error(`netRe: unsupported inline option ${c}`);
    }
    p = lead[0].length;
  }
  let out = '';
  let inClass = false;
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
      else if ('rntfv'.includes(n)) out += '\\' + n;
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
    if (c === '.') { out += '[^\\n]'; p++; continue; }
    if (c === '^') { out += m ? '(?:^|(?<=\\n))' : '^'; p++; continue; }
    if (c === '$') { out += m ? '(?=\\n|$)' : '(?=\\n?$)'; p++; continue; }
    out += mapSurrogates(c);
    p++;
  }
  return { source: out, flags: 'ud' + (i ? 'i' : '') };
}

class NetRegex {
  constructor(src, opts = {}) {
    const { source, flags } = translate(src, opts);
    this.re = new RegExp(source, flags);
    this.reG = new RegExp(source, flags + 'g');
  }
  static result(s, mm) {
    const pick = (span) => (span ? s.slice(span[0], span[1]) : undefined);
    const r = mm.indices.map(pick);
    r.index = mm.index;
    r.groups = mm.indices.groups ? Object.fromEntries(Object.entries(mm.indices.groups).map(([k, span]) => [k, pick(span)])) : undefined;
    return r;
  }
  exec(s) {
    const mm = this.re.exec(mapSurrogates(s));
    return mm ? NetRegex.result(s, mm) : null;
  }
  test(s) { return this.re.test(mapSurrogates(s)); }
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
  replaceFirst(s, replacement) {
    const mm = this.exec(s);
    return mm ? s.slice(0, mm.index) + replacement + s.slice(mm.index + mm[0].length) : s;
  }
}

const reCache = new Map();
function netRe(src, { i = false, m = false } = {}) {
  const key = `${i}|${m}|${src}`;
  let re = reCache.get(key);
  if (!re) { re = new NetRegex(src, { i, m }); reCache.set(key, re); }
  return re;
}

// PowerShell `-match` (case-insensitive). Returns the match array or null.
const psMatch = (s, pat) => netRe(pat, { i: true }).exec(s);
// [regex]::Matches -- case-sensitive unless the pattern says (?i).
const rxMatches = (s, pat) => netRe(pat).matches(s);

// ---------------------------------------------------------------------------------------------
// .NET string semantics
// ---------------------------------------------------------------------------------------------
const NET_WS_RE = /[\t\n\v\f\r\x85\p{Z}]/u;
const isNetWs = (ch) => NET_WS_RE.test(ch);
function netTrimEnd(s) {
  let e = s.length;
  while (e > 0 && isNetWs(s[e - 1])) e--;
  return s.slice(0, e);
}
function netTrim(s) {
  let b = 0;
  while (b < s.length && isNetWs(s[b])) b++;
  return netTrimEnd(s.slice(b));
}
function trimChars(s, chars) {
  let b = 0;
  let e = s.length;
  while (b < e && chars.includes(s[b])) b++;
  while (e > b && chars.includes(s[e - 1])) e--;
  return s.slice(b, e);
}
// ToLowerInvariant: a simple (one-to-one) mapping, never context-sensitive.
function lowerInvariant(s) {
  let out = '';
  for (const ch of s) out += String.fromCodePoint(ch.toLowerCase().codePointAt(0));
  return out;
}
const ciEq = (a, b) => typeof a === 'string' && typeof b === 'string' && lowerInvariant(a) === lowerInvariant(b);
const ciContains = (arr, v) => arr.some((x) => ciEq(x, v));
const splitLines = (s) => s.split(/\r?\n/);

// PowerShell truthiness and "$x" stringification, for values read out of JSON.
function psTruthy(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length === 0 ? false : v.length === 1 ? psTruthy(v[0]) : true;
  return true;
}
function psStr(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map(psStr).join(' ');
  return '@{' + Object.entries(v).map(([k, x]) => `${k}=${psStr(x)}`).join('; ') + '}';
}
// ConvertFrom-Json objects are read case-insensitively by property name.
function prop(obj, name) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { has: false, value: undefined };
  if (Object.prototype.hasOwnProperty.call(obj, name)) return { has: true, value: obj[name] };
  const lname = name.toLowerCase();
  for (const k of Object.keys(obj)) if (k.toLowerCase() === lname) return { has: true, value: obj[k] };
  return { has: false, value: undefined };
}
const get = (obj, name) => prop(obj, name).value;

// en-US `{0:N0}`: thousands separators, rounded half away from zero.
const N0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0, minimumFractionDigits: 0 });
const fmtN0 = (x) => N0.format(x);

// Join-Path: one separator between the parts, nothing normalised.
const joinPS = (a, b) => a.replace(/[\\/]+$/, '') + SEP + b.replace(/^[\\/]+/, '');

// ---------------------------------------------------------------------------------------------
// Files: [IO.File]::ReadAllText detects a BOM and strips it, defaulting to UTF-8; output is UTF-8
// without a BOM. Test-Path is true for directories too.
// ---------------------------------------------------------------------------------------------
function decodeUtf32(buf, start, le) {
  let s = '';
  for (let o = start; o + 3 < buf.length; o += 4) {
    const cp = le ? buf.readUInt32LE(o) : buf.readUInt32BE(o);
    s += cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '\uFFFD';
  }
  if ((buf.length - start) % 4) s += '\uFFFD';
  return s;
}
function readAllText(p) {
  const buf = fs.readFileSync(p);
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return new TextDecoder('utf-8').decode(buf.subarray(3));
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xfe && buf[2] === 0 && buf[3] === 0) return decodeUtf32(buf, 4, true);
  if (buf.length >= 4 && buf[0] === 0 && buf[1] === 0 && buf[2] === 0xfe && buf[3] === 0xff) return decodeUtf32(buf, 4, false);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  return new TextDecoder('utf-8').decode(buf);
}
const writeAllText = (p, s) => fs.writeFileSync(p, Buffer.from(s, 'utf8'));
function testPath(p) {
  if (!p) return false;
  try { fs.statSync(p); return true; } catch { return false; }
}
function readJsonLoose(p) {
  const text = readAllText(p);
  if (!text.trim()) return null; // Get-Content -Raw of an empty file is $null; nothing is read
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------------------------
// Wall-clock time. .NET subtracts local DateTimes as wall clocks, so every time here is a local
// wall clock expressed as "UTC milliseconds of the same digits".
// ---------------------------------------------------------------------------------------------
function wallOf(instantMs) {
  const d = new Date(instantMs);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
}
const wallNow = () => wallOf(Date.now());
function validYmdHms(y, mo, d, h, mi, s) {
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return false;
  const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return d <= dim && y >= 1;
}
function wallUtc(y, mo, d, h, mi, s, ms) {
  const t = new Date(Date.UTC(2000, mo - 1, d, h, mi, s, ms));
  t.setUTCFullYear(y);
  return t.getTime();
}
// [datetime]::Parse(text, InvariantCulture): an offset or Z converts to local; none is local.
function parseNetDate(text) {
  const s = String(text);
  let mm = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.(\d{1,7}))?)?)?\s*(Z|[+-]\d{1,2}(?::?\d{2})?)?\s*$/i.exec(s);
  if (mm) {
    const [y, mo, d, h, mi, se] = [mm[1], mm[2], mm[3], mm[4] || 0, mm[5] || 0, mm[6] || 0].map(Number);
    const ms = mm[7] ? Number((mm[7] + '000').slice(0, 3)) : 0;
    if (!validYmdHms(y, mo, d, h, mi, se)) throw new Error('not a date');
    const wall = wallUtc(y, mo, d, h, mi, se, ms);
    if (!mm[8]) return wall;
    if (mm[4] === undefined) throw new Error('not a date');
    let offMin = 0;
    if (mm[8].toUpperCase() !== 'Z') {
      const om = /^([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(mm[8]);
      offMin = (om[1] === '-' ? -1 : 1) * (Number(om[2]) * 60 + Number(om[3] || 0));
    }
    return wallOf(wall - offMin * 60000);
  }
  mm = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?\s*(AM|PM)?)?\s*$/i.exec(s);
  if (mm) {
    let [mo, d, y, h, mi, se] = [mm[1], mm[2], mm[3], mm[4] || 0, mm[5] || 0, mm[6] || 0].map(Number);
    if (mm[7]) { if (h < 1 || h > 12) throw new Error('not a date'); h = (h % 12) + (mm[7].toUpperCase() === 'PM' ? 12 : 0); }
    if (!validYmdHms(y, mo, d, h, mi, se)) throw new Error('not a date');
    return wallUtc(y, mo, d, h, mi, se, 0);
  }
  throw new Error('not a date');
}
function stampNow() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------
class Exit extends Error {
  constructor(code, message) { super(message || ''); this.code = code; }
}
const fail = (message) => new Exit(1, message); // Write-Error under ErrorActionPreference=Stop

// ---------------------------------------------------------------------------------------------
// Arguments: PowerShell's binder as `pwsh -File` drives it -- case-insensitive names, unique
// prefixes, `-Name:value`, positional binding in declaration order, a switch never takes a
// separate value -- plus GNU `--name`, `--name=value` and kebab-case aliases.
// ---------------------------------------------------------------------------------------------
const PARAMS = [
  { name: 'Id', type: 'string', pos: 0 },
  { name: 'BodyFile', type: 'string', pos: 1, mandatory: true },
  { name: 'JournalDir', type: 'string', pos: 2 },
  { name: 'Ask', type: 'string', pos: 3 },
  { name: 'Author', type: 'string', pos: 4 },
  { name: 'Validate', type: 'switch' },
  { name: 'Json', type: 'switch' },
  { name: 'DisableGuard', type: 'string[]', pos: 5 },
  // [CmdletBinding()] common parameters: accepted, and inert in this script.
  { name: 'Verbose', type: 'switch', common: true, aliases: ['vb'] },
  { name: 'Debug', type: 'switch', common: true, aliases: ['db'] },
  { name: 'ErrorAction', type: 'string', common: true, aliases: ['ea'] },
  { name: 'WarningAction', type: 'string', common: true, aliases: ['wa'] },
  { name: 'InformationAction', type: 'string', common: true, aliases: ['infa'] },
  { name: 'ProgressAction', type: 'string', common: true, aliases: ['proga'] },
  { name: 'ErrorVariable', type: 'string', common: true, aliases: ['ev'] },
  { name: 'WarningVariable', type: 'string', common: true, aliases: ['wv'] },
  { name: 'InformationVariable', type: 'string', common: true, aliases: ['iv'] },
  { name: 'OutVariable', type: 'string', common: true, aliases: ['ov'] },
  { name: 'OutBuffer', type: 'string', common: true, aliases: ['ob'] },
  { name: 'PipelineVariable', type: 'string', common: true, aliases: ['pv'] },
];
const GNU_ALIASES = { 'body-file': 'BodyFile', 'journal-dir': 'JournalDir', 'disable-guard': 'DisableGuard' };
const TYPE_NAME = { string: 'System.String', 'string[]': 'System.String[]' };

function resolveParam(raw) {
  const lname = raw.toLowerCase();
  if (GNU_ALIASES[lname]) return PARAMS.find((p) => p.name === GNU_ALIASES[lname]);
  const exact = PARAMS.find((p) => p.name.toLowerCase() === lname || (p.aliases || []).includes(lname));
  if (exact) return exact;
  const pre = PARAMS.filter((p) => p.name.toLowerCase().startsWith(lname));
  if (pre.length === 1) return pre[0];
  if (pre.length > 1) {
    throw fail(`Parameter cannot be processed because the parameter name '${raw}' is ambiguous. Possible matches include: ${pre.map((p) => '-' + p.name).join(' ')}.`);
  }
  throw fail(`A parameter cannot be found that matches parameter name '${raw}'.`);
}

function parseArgs(argv) {
  const bound = {};
  const positional = [];
  const isName = (a) => /^--?[A-Za-z_?]/.test(a);
  let endOfOptions = false;
  const bind = (p, value) => {
    if (p.type === 'string[]') {
      // Repeated flags and `a,b` both accumulate, as `-DisableGuard G7,G12` does in PowerShell.
      (bound[p.name] ||= []).push(...value.split(','));
      return;
    }
    if (Object.prototype.hasOwnProperty.call(bound, p.name)) {
      throw fail(`Cannot bind parameter because parameter '${p.name}' is specified more than once. To provide multiple values to parameters that can accept multiple values, use the array syntax. For example, "-parameter value1,value2,value3".`);
    }
    bound[p.name] = value;
  };
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (!endOfOptions && a === '--') { endOfOptions = true; continue; }
    if (endOfOptions || !isName(a)) { positional.push(a); continue; }
    let body = a.replace(/^--?/, '');
    let inline;
    const colon = /^([^:=]+)[:=]([\s\S]*)$/.exec(body);
    if (colon) { body = colon[1]; inline = colon[2]; }
    const p = resolveParam(body);
    if (p.type === 'switch') {
      let on = true;
      if (inline !== undefined) on = !/^(\$?false|0)$/i.test(inline.trim());
      if (Object.prototype.hasOwnProperty.call(bound, p.name)) {
        throw fail(`Cannot bind parameter because parameter '${p.name}' is specified more than once. To provide multiple values to parameters that can accept multiple values, use the array syntax. For example, "-parameter value1,value2,value3".`);
      }
      bound[p.name] = on;
      continue;
    }
    let value = inline;
    if (value === undefined) {
      const next = argv[k + 1];
      if (next === undefined || isName(next)) {
        throw fail(`Missing an argument for parameter '${p.name}'. Specify a parameter of type '${TYPE_NAME[p.type]}' and try again.`);
      }
      value = next;
      k++;
    }
    bind(p, value);
  }
  for (const v of positional) {
    const p = PARAMS.filter((x) => x.pos !== undefined && !Object.prototype.hasOwnProperty.call(bound, x.name)).sort((x, y) => x.pos - y.pos)[0];
    if (!p) throw fail(`A positional parameter cannot be found that accepts argument '${v}'.`);
    bind(p, v);
  }
  if (!Object.prototype.hasOwnProperty.call(bound, 'BodyFile')) {
    throw fail('Cannot process command because of one or more missing mandatory parameters: BodyFile.');
  }
  if (bound.BodyFile === '') throw fail("Cannot bind argument to parameter 'BodyFile' because it is an empty string.");
  return bound;
}

// ---------------------------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------------------------
// #423's binding stamp; kept in step with `$script:DocMetaRe` in oa-state.ps1.
const DocMetaRe = '<!--\\s*doc-meta\\s+docId=(?<id>[A-Za-z0-9_\\-]+)(?:\\s+docUrl=(?<url>\\S+))?\\s*-->';
// #627: kept in step with oa-state.ps1's NonWorkableStatus minus ClosedStatus.
const PausedStatusWT = ['proposed', 'blocked'];
// #473: the managed-turn heading shape, the same oa-state.ps1 and the Telegram bridge use.
const ManagedTurnRe = '^[ \\t]*##[^\\r\\n]*(' + MOON + '|Overnight Agent)';
// #560: the declared-ask values and the stamp oa-state.ps1's `$script:AskDeclRe` reads.
const AskValues = ['blocking', 'offer', 'none'];
// #491: kept character-for-character in step with `$script:ConsentAffirmRe` in oa-state.ps1.
const ConsentAffirmRe = '(?i)(?<![\\w-])(approved?|approve it|yes|yep|yeah|go ahead|go for it|go|lgtm|ship it|do it|vibe it|send it|make it so|proceed|merge[ \\t]+#?\\d+)(?![\\w-])';
const AskDeclRe = '(?im)^[ \\t]*<!--[ \\t]*oa-ask[ \\t]*:[ \\t]*([a-z]+)[ \\t]*-->[ \\t\\r]*$';
const ProvenanceLineRe = '^[ \\t]*<!--[ \\t]*from:[ \\t]*overnight-agent[ \\t]*-->[ \\t\\r]*$';
const FenceRe = '^[ \\t]*```';
const H2Re = '^[ \\t]*##[ \\t]+\\S';
const H3Re = '^[ \\t]*###';
const H2PrefixRe = '^[ \\t]*##[ \\t]+';
const AgentMarkerRe = '^[ \\t]*<!--[ \\t]*from:[ \\t]*overnight-agent[ \\t]*-->';
const SENTINEL_FIND = 'OVERNIGHT-AGENT do not edit';
const SENTINEL_LINE = '<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->';

const isH2 = (l) => psMatch(l, H2Re) && !psMatch(l, H3Re);
const afterH2 = (l) => netRe(H2PrefixRe).replaceFirst(l, '');

function newFinding(guard, line, snippet, why) {
  return { guard, line: Math.trunc(Number(line) || 0), snippet: snippet == null ? '' : String(snippet), why };
}

// The writing agent's identity, stamped into every appended turn. Values are reduced to a safe
// alphabet, and a bare AUTO / AGENT word gets a `_` so the stamp can never match the app's
// agent-block sentinel (/^<!--.*\b(AUTO|AGENT)\b.*-->/i in src/journalChat.js).
function identityValue(v) {
  const s = String(v || '').replace(/[^A-Za-z0-9._@:-]/g, '_').slice(0, 128).replace(/\b(auto|agent)\b/gi, '$1_');
  return s || 'unknown';
}
// [Environment]::MachineName, which the PowerShell fallback uses when COMPUTERNAME is unset: the
// NetBIOS name on Windows (at most 15 characters), the first DNS label elsewhere.
function machineName() {
  const h = os.hostname();
  return IS_WIN ? h.slice(0, 15) : h.split('.')[0];
}
const hostName = () => process.env.WRITE_TURN_HOST || process.env.COMPUTERNAME || machineName();
function identityStamp(author) {
  const session = author || process.env.COPILOT_AGENT_SESSION_ID || 'unknown';
  const host = hostName();
  return `<!-- oa-by: session=${identityValue(session)} host=${identityValue(host)} -->`;
}
const IdentityStampRe = '^[ \\t]*<!--[ \\t]*oa-by[ \\t]*:';

// Insert `<!-- oa-ask: VALUE -->` (then the identity stamp) directly beneath the turn's LAST provenance marker outside a
// fence, so the stamp stays bound to the attribution it qualifies and above the turn-end
// terminator `mark` appends. No marker (G7 disabled) -> appended at the end instead.
function addAskStamp(body, ask, by) {
  const nl = body.includes('\r\n') ? '\r\n' : '\n';
  const lines = splitLines(body);
  let fence = false;
  let at = -1;
  for (let i = 0; i < lines.length; i++) {
    if (psMatch(lines[i], FenceRe)) { fence = !fence; continue; }
    if (fence) continue;
    if (psMatch(lines[i], ProvenanceLineRe)) at = i;
  }
  if (at < 0) return netTrimEnd(body) + nl + nl + `<!-- oa-ask: ${ask} -->` + nl + by;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    if (i === at) out.push(`<!-- oa-ask: ${ask} -->`, by);
  }
  return out.join(nl);
}

// Blank out fenced regions, preserving line count, line endings and length (#320).
function fenceMaskedText(text) {
  if (!text) return '';
  const parts = text.split(/(\r?\n)/);
  let fence = false;
  for (let i = 0; i < parts.length; i++) {
    if (/^\r?\n$/.test(parts[i])) continue;
    if (psMatch(parts[i], FenceRe)) { fence = !fence; parts[i] = ' '.repeat(parts[i].length); continue; }
    if (fence) parts[i] = ' '.repeat(parts[i].length);
  }
  return parts.join('');
}

// READ ONLY, from the JOURNAL (never state): the task's catch-up doc binding, fences masked.
function journalDocMeta(p) {
  if (!p || !testPath(p)) return null;
  const mm = netRe(DocMetaRe).exec(fenceMaskedText(readAllText(p)));
  if (!mm) return null;
  return { doc_id: mm.groups.id, doc_url: mm.groups.url !== undefined ? mm.groups.url : '' };
}

// Newest managed turn heading and newest human marker in the managed region (the sentinel on).
// Both regexes are .NET (?m) patterns: the human marker's `[ \t]*$` does not absorb a CRLF `\r`.
function managedPositions(scan) {
  const sentinel = scan.lastIndexOf(SENTINEL_FIND);
  if (sentinel < 0) return null;
  const managed = scan.slice(sentinel);
  let lastTurn = -1;
  for (const mm of rxMatches(managed, '(?m)^[ \\t]*##[ \\t][^\\r\\n]*')) {
    if (psMatch(mm[0], ManagedTurnRe)) lastTurn = mm.index;
  }
  let lastHuman = -1;
  for (const mm of rxMatches(managed, '(?m)^[ \\t]*<!--[ \\t]*from:[ \\t]*me[ \\t]*-->[ \\t]*$')) lastHuman = mm.index;
  return { sentinel, managed, lastTurn, lastHuman };
}

// true when a human marker sits BELOW the newest managed turn. Every uncertain answer is true
// (= "he may have spoken", = allow): a false refusal of the turn that answers him is worse.
function humanSpokeLast(journalPath) {
  try {
    if (!journalPath || !testPath(journalPath)) return true;
    const pos = managedPositions(fenceMaskedText(readAllText(journalPath)));
    if (!pos || pos.lastTurn < 0) return true;
    return pos.lastHuman > pos.lastTurn;
  } catch {
    return true;
  }
}

function makeContext({ id, journalDir, oaHome, author, issueResolver, wakeWindowMin }) {
  return { id, journalDir, oaHome, author, issueResolver, wakeWindowMin, g15Note: null, pauseAdvisory: null, pauseVerdict: null };
}

// G17's evidence (#627). null means "not provably paused" and is returned for every uncertainty;
// only a state file that positively says the USER paused the row, with no reply below the newest
// turn, produces a verdict. The stamp is quoted verbatim from the file text, never re-rendered.
function userPauseVerdict(ctx, taskId, journalPath) {
  if (!taskId) return null;
  const statePath = path.join(ctx.oaHome, 'state', `task-${taskId}.json`);
  if (!testPath(statePath)) return null;
  let st = null;
  let raw = '';
  try {
    raw = readAllText(statePath);
    st = raw.trim() ? JSON.parse(raw) : null;
  } catch {
    ctx.pauseAdvisory = `G17 could not read state for task ${taskId}; pause not checked`;
    return null;
  }
  if (!psTruthy(st)) return null;
  if (lowerInvariant(psStr(get(st, 'status_by'))) !== 'user') return null;
  const status = lowerInvariant(psStr(get(st, 'status')));
  if (!PausedStatusWT.includes(status)) return null;
  if (humanSpokeLast(journalPath)) return null;
  const mm = /"paused_at"\s*:\s*"([^"]*)"/.exec(raw);
  return { status, at: mm ? mm[1] : '' };
}

// G12 -- ONE TURN PER WAKE (#473, #475, #477, #532). The only guard that is a property of the
// DESTINATION. Refuses when the newest managed turn has no human content after it AND it belongs
// to this wake: written at/after `session.last_woken_at`, or -- when that stamp is absent or older
// than the wake window -- written inside the window. Recency comes from state's `last_turn_at`
// AND this tool's own backups (a forgotten `mark` must not fail open), newer wins. The bound,
// live session (the owner) may supersede a turn that is not its own.
function wakeTurnFinding(ctx, journalPath, taskId) {
  if (!journalPath || !testPath(journalPath)) return null;
  const content = readAllText(journalPath);
  const scan = fenceMaskedText(content);
  const pos = managedPositions(scan);
  if (!pos || pos.lastTurn < 0) return null;
  if (pos.lastHuman > pos.lastTurn) return null;

  let written = null;
  let wokenAt = null;
  let owner = null;
  let turnBy = null;
  const statePath = path.join(ctx.oaHome, 'state', `task-${taskId}.json`);
  if (testPath(statePath)) {
    try {
      const st = readJsonLoose(statePath);
      const ltaP = prop(st, 'last_turn_at');
      if (ltaP.has && psTruthy(ltaP.value)) written = parseNetDate(psStr(ltaP.value));
      const ltbP = prop(st, 'last_turn_by');
      if (ltbP.has && psTruthy(ltbP.value)) turnBy = psStr(ltbP.value);
      const sessP = prop(st, 'session');
      if (sessP.has && psTruthy(sessP.value)) {
        const sess = sessP.value;
        const lwP = prop(sess, 'last_woken_at');
        if (lwP.has && psTruthy(lwP.value)) wokenAt = parseNetDate(psStr(lwP.value));
        const sidP = prop(sess, 'session_id');
        if (sidP.has && psTruthy(sidP.value) && ciEq(psStr(get(sess, 'state')), 'live')) owner = psStr(sidP.value);
      }
    } catch {
      written = null; wokenAt = null; owner = null; turnBy = null;
    }
  }
  // The backup trail this tool writes itself: task-<id>.bak-yyyyMMdd-HHmm.md (minute resolution).
  if (testPath(ctx.oaHome)) {
    let names = [];
    try { names = fs.readdirSync(ctx.oaHome); } catch { names = []; }
    const wild = new RegExp('^' + `task-${taskId}.bak-*.md`.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[\\s\\S]*').replace(/\?/g, '[\\s\\S]') + '$', 'iu');
    for (const name of names) {
      if (!wild.test(name)) continue;
      const mm = netRe('bak-(\\d{8})-(\\d{4})\\.md$').exec(name);
      if (!mm) continue;
      const digits = mm[1] + mm[2];
      if (!/^[0-9]{12}$/.test(digits)) continue;
      const [y, mo, d, h, mi] = [digits.slice(0, 4), digits.slice(4, 6), digits.slice(6, 8), digits.slice(8, 10), digits.slice(10, 12)].map(Number);
      if (!validYmdHms(y, mo, d, h, mi, 0)) continue;
      const t = wallUtc(y, mo, d, h, mi, 0, 0);
      if (written === null || t > written) written = t;
    }
  }
  if (written === null) return null;

  const now = wallNow();
  const ageMin = (now - written) / 60000;

  // #532: a wake stamp older than the window cannot identify the current wake -- the same
  // position as having no stamp, so the window fallback decides.
  let staleWake = false;
  let wakeAgeMin = 0;
  if (wokenAt !== null) {
    wakeAgeMin = (now - wokenAt) / 60000;
    if (wakeAgeMin >= ctx.wakeWindowMin) { staleWake = true; wokenAt = null; }
  }

  let why;
  const floorMin = (t) => t - (((t % 60000) + 60000) % 60000);
  if (wokenAt !== null) {
    if (floorMin(written) < floorMin(wokenAt)) return null; // the turn predates this wake
    why = 'a turn for THIS wake already exists';
  } else {
    if (ageMin >= ctx.wakeWindowMin) return null;
    why = staleWake
      ? `a turn was written ${fmtN0(ageMin)} min ago and this task's wake stamp is ${fmtN0(wakeAgeMin)} min old, too stale to identify the current wake (#532)`
      : `a turn was written ${fmtN0(ageMin)} min ago and this task has no wake stamp to compare against`;
  }

  // WHOSE turn (#477): the owner supersedes a non-owner ('unknown' and absent are non-owners);
  // a same-author duplicate and a non-owner over anybody stay refused.
  const caller = ctx.author ? ctx.author : (process.env.COPILOT_AGENT_SESSION_ID || '');
  const callerIsOwner = !!(owner && caller && ciEq(caller, owner));
  const sameAuthor = !!(caller && turnBy && ciEq(caller, turnBy));
  if (callerIsOwner && !sameAuthor) return null;
  const whoTxt = sameAuthor ? 'by you' : turnBy ? `by '${turnBy}'` : 'by an unrecorded author';
  why = `${why} ${whoTxt}`;

  const line = splitLines(content.slice(0, Math.min(content.length, pos.sentinel + pos.lastTurn))).length;
  const head = netTrim(splitLines(pos.managed.slice(pos.lastTurn))[0]);
  return newFinding('G12', line, head,
    `${why} (${fmtN0(ageMin)} min ago, nothing from him since). ` +
    'The task sub-session owns the turn; the run session must not also write one (#473). ' +
    'If you are deliberately replacing a turn you just wrote, pass -DisableGuard G12.');
}

// Inline code spans are quotation for G1/G2: a turn documenting the defect must be writable.
const removeCodeSpans = (line) => line.replace(/`[^`]*`/g, ' ');

// A5 / G11: an ask in a dialect lib-live-ask.mjs (the digest) can read.
function turnHasAsk(body) {
  for (const l of splitLines(body)) {
    if (psMatch(l, '^\\s*\\*{0,2}Needs from you\\b[^:]*:\\*{0,2}\\s*\\S')) return true;
    if (psMatch(l, '^\\s*\\*{0,2}Next:\\*{0,2}\\s*\\S')) return true;
    if (psMatch(l, '^\\s*\\*{0,2}Your call:\\*{0,2}\\s*\\S')) return true;
    if (psMatch(l, '(?:^|\\s)Reply\\s+`[^`]+`')) return true;
  }
  return false;
}

// #513: does this turn INSTRUCT an agent-gate edit without naming the `-GatePath` check?
function gateEditAsk(body) {
  const scan = fenceMaskedText(body);
  if (netRe('(?i)-GatePath\\b').test(scan)) return null;
  const lines = splitLines(scan);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!psMatch(l, '(?i)agent-gate\\.md|Do not gate these|Always ask\\b')) continue;
    if (!psMatch(l, '(?i)\\b(add|paste|put|append|copy|write|edit|insert)\\b|once that line exists')) continue;
    return { line: i + 1, text: netTrim(l) };
  }
  return null;
}

// #618: an ask line that asks a direct question, unless it opens by saying nothing is needed.
function askContradiction(body) {
  const lines = splitLines(body);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const mm = psMatch(l, '^\\s*\\*{0,2}(?:Needs from you|Your call)\\b[^:]*:\\*{0,2}\\s*(\\S.*)$');
    if (!mm) continue;
    const ask = mm[1];
    if (psMatch(ask, '^\\s*[*_`]*\\s*(none|nothing|no|nil|n/a)\\b')) continue;
    if (psMatch(ask, '\\?')) return { line: i + 1, text: netTrim(l) };
  }
  return null;
}

// [int]"<digits>" -- overflow (or a non-ASCII digit .NET's \d accepted) is a terminating error.
function psInt(s) {
  if (!/^[0-9]+$/.test(s)) throw fail(`Cannot convert value "${s}" to type "System.Int32". Error: "The input string '${s}' was not in a correct format."`);
  const n = Number(s);
  if (n > 2147483647) throw fail(`Cannot convert value "${s}" to type "System.Int32". Error: "Value was either too large or too small for an Int32."`);
  return n;
}

// #635: forward-looking lines only (a **Next:** line, or an intent verb aimed at an issue).
function proposedIssues(lines, inFence) {
  const verbs = 'pick(?:ing)?\\s+up|start(?:ing)?(?:\\s+on)?|work(?:ing)?(?:\\s+on)?|recommend(?:ing)?|tackle|tackling|take\\s+on|move\\s+on\\s+to|queue(?:ing)?';
  const nextRe = '^\\s*[*_]{0,2}next(?:\\s+up|\\s+steps?|\\s+step)?[*_]{0,2}\\s*:';
  const verbRe = `\\b(?:${verbs})\\s+(?:gh\\s*)?#\\d+`;
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    if (inFence[i]) continue;
    const l = lines[i];
    if (!psMatch(l, nextRe) && !psMatch(l, verbRe)) continue;
    const prNums = rxMatches(l, '(?i)\\b(?:pr|pull\\s+request)\\s*#(\\d+)').map((mm) => mm[1]);
    for (const mm of rxMatches(l, '#(\\d+)')) {
      const num = mm[1];
      if (ciContains(prNums, num)) continue;
      found.push({ n: psInt(num), line: i + 1, text: netTrim(l) });
    }
  }
  return found;
}

// Ask the shipped/unworked classifier. ok=false, with a reason, for EVERY not-measured outcome.
function shippedVerdict(ctx, numbers) {
  if (!testPath(ctx.issueResolver)) return { ok: false, reason: `classifier not found at ${ctx.issueResolver}` };
  const r = spawnSync(process.execPath, [ctx.issueResolver, '--json', ...numbers.map(String)], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { ok: false, reason: `could not run node (${r.error.message})` };
  if (r.status === 3) return { ok: false, reason: 'the classifier rejected its arguments' };
  const outText = r.stdout ? r.stdout.toString('utf8') : '';
  const errText = r.stderr ? r.stderr.toString('utf8') : '';
  const text = netTrim([outText, errText].filter((x) => x.length).join('\n'));
  if (!text) return { ok: false, reason: 'the classifier printed nothing' };
  let v;
  try { v = JSON.parse(text); } catch {
    return { ok: false, reason: 'the classifier output was not JSON: ' + text.slice(0, Math.min(120, text.length)) };
  }
  if (!psTruthy(get(v, 'ok'))) return { ok: false, reason: psStr(get(v, 'reason')) };
  let results = get(v, 'results');
  results = Array.isArray(results) ? results : [results];
  return { ok: true, shipped: results.filter((x) => psTruthy(get(x, 'shipped'))) };
}

function looseIntEq(n, v) {
  if (typeof v === 'number') return n === v;
  if (typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v)) return n === Number(v);
  return false;
}

function turnBodyFindings(ctx, body, disabled, doc, ask) {
  const findings = [];
  const lines = splitLines(body);
  const on = (g) => !ciContains(disabled, g);

  // A fenced block is a verbatim quotation; no guard but G8 applies inside it.
  const inFence = new Array(lines.length).fill(false);
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    if (psMatch(lines[i], FenceRe)) { fence = !fence; inFence[i] = true; continue; }
    inFence[i] = fence;
  }

  // G1: lost-interpolation tombstones -- `~$150-275` -> `~\-275`, `\-520`, `****`, `~**,035**`.
  if (on('G1')) {
    for (let i = 0; i < lines.length; i++) {
      if (inFence[i]) continue;
      const l = removeCodeSpans(lines[i]);
      for (const pat of ['~\\\\-\\d', '(?<![\\\\`])\\\\-\\d{2,}', '\\*\\*\\*\\*', '~\\*\\*,\\d']) {
        if (psMatch(l, pat)) {
          findings.push(newFinding('G1', i + 1, netTrim(lines[i]),
            'looks like a value was eaten by PowerShell string interpolation (a `$` expanded to nothing)'));
          break;
        }
      }
    }
  }

  // G2: `letter''letter` is never valid markdown.
  if (on('G2')) {
    for (let i = 0; i < lines.length; i++) {
      if (inFence[i]) continue;
      if (psMatch(removeCodeSpans(lines[i]), "[A-Za-z]''[A-Za-z]")) {
        findings.push(newFinding('G2', i + 1, netTrim(lines[i]),
          "a doubled apostrophe (don''t) -- PowerShell single-quote escaping survived into the text"));
      }
    }
  }

  // G3: the Telegram bridge anchors on /^##\s*<moon>/, so every H2 must be moon-first.
  if (on('G3')) {
    for (let i = 0; i < lines.length; i++) {
      if (inFence[i]) continue;
      const l = lines[i];
      if (isH2(l) && !afterH2(l).startsWith(MOON)) {
        findings.push(newFinding('G3', i + 1, netTrim(l),
          "an H2 in an agent turn must start with the moon immediately after '##', or the Telegram bridge truncates the turn here"));
      }
    }
  }

  // G4: a provenance stamp is only a chat entry when an H2 heading precedes it.
  if (on('G4')) {
    let seenHeading = false;
    for (let i = 0; i < lines.length; i++) {
      if (inFence[i]) continue;
      const l = lines[i];
      if (isH2(l)) { seenHeading = true; continue; }
      if (psMatch(l, AgentMarkerRe) && !seenHeading) {
        findings.push(newFinding('G4', i + 1, netTrim(l),
          'a provenance stamp with no "## " heading above it severs the agent block and hides the ask below it'));
      }
    }
  }

  // G5: a body with no moon-anchored H2 is folded into the PREVIOUS turn by the bridge.
  if (on('G5')) {
    let anchored = false;
    for (let i = 0; i < lines.length; i++) {
      if (inFence[i]) continue;
      if (isH2(lines[i]) && afterH2(lines[i]).startsWith(MOON)) { anchored = true; break; }
    }
    if (!anchored) {
      const first = lines.find((x) => netTrim(x).length > 0);
      findings.push(newFinding('G5', 1, first === undefined ? '' : first,
        "this turn has no '## <moon> ...' heading, so the Telegram bridge cannot anchor it -- it would be folded into the previous turn instead of starting a new one"));
    }
  }

  // G7: each moon heading needs its own `<!-- from: overnight-agent -->` before the next H2,
  // or the consent reader attributes the agent's prose to whoever spoke last (#272).
  if (on('G7')) {
    for (let i = 0; i < lines.length; i++) {
      if (inFence[i]) continue;
      const l = lines[i];
      if (!isH2(l)) continue;
      if (!afterH2(l).startsWith(MOON)) continue;
      let stamped = false;
      for (let k = i + 1; k < lines.length; k++) {
        if (inFence[k]) continue;
        const n = lines[k];
        if (isH2(n)) break;
        if (psMatch(n, AgentMarkerRe)) { stamped = true; break; }
      }
      if (!stamped) {
        findings.push(newFinding('G7', i + 1, netTrim(l),
          "this turn has no \"<!-- from: overnight-agent -->\" under its heading, so the consent reader attributes it to whoever spoke last -- the agent's own words can then be read back as the user's approval (#272)"));
      }
    }
  }

  // G8: the consent reader has no fence concept, so a marker at the start of a FENCED line is a
  // live attribution to it (#320). Matches the reader's own pattern.
  if (on('G8')) {
    for (let i = 0; i < lines.length; i++) {
      if (!inFence[i]) continue;
      if (psMatch(lines[i], '^[ \\t]*<!--[ \\t]*from:[ \\t]*[^>\\r\\n]*?[ \\t]*-->')) {
        findings.push(newFinding('G8', i + 1, netTrim(lines[i]),
          'a provenance marker at the start of a fenced line is read as a LIVE attribution by the consent gate (it has no fence concept), so this sample can forge human consent for the text after it (#320) -- use inline code instead of a fenced block'));
      }
    }
  }

  // G9/G10/G11 (#425): armed ONLY by a doc-meta stamp on the target journal.
  if (doc) {
    const len = netTrim(body).length;
    if (on('G9') && len > POINTER_CEILING) {
      findings.push(newFinding('G9', 1, `${len} chars`,
        `this task has a catch-up doc, so a turn is a POINTER, not the story: ${len} chars is over the ` +
        `${POINTER_CEILING} ceiling (aim for ~${POINTER_NUDGE}). Move the narrative, tables and evidence into ` +
        'the doc and amend it in place; leave behind the status, the doc link, a sentence or two, and the ask'));
    }
    if (on('G10')) {
      let names = false;
      if (doc.doc_id && body.includes(doc.doc_id)) names = true;
      if (!names && doc.doc_url && body.includes(doc.doc_url)) names = true;
      if (!names) {
        findings.push(newFinding('G10', 1, 'docId=' + doc.doc_id,
          'this turn is a pointer with nothing to point at -- it never links the catch-up doc it is ' +
          'summarising, so the detail has left the journal and cannot be reached from it. Include the doc ' +
          'URL (or its id) in the turn'));
      }
    }
    if (on('G11') && !turnHasAsk(body)) {
      findings.push(newFinding('G11', 1, '(no ask marker)',
        'this task has a catch-up doc, and a doc-bound task posts nothing per turn to Telegram (#424) -- ' +
        'so an ask that is not in this turn reaches no surface at all. Keep the ask in the journal ' +
        '(duplicate it into the doc, never move it): "**Needs from you:** ...", "Reply `word`", ' +
        '"**Next:** ..." or "**Your call:** ...". Use -DisableGuard G11 for a genuinely informational turn'));
    }
  }

  // G18 (#513): an ask to edit agent-gate.md with no sign the edit was verified via -GatePath.
  if (on('G18')) {
    const gateAsk = gateEditAsk(body);
    if (gateAsk) {
      findings.push(newFinding('G18', gateAsk.line, gateAsk.text,
        'this turn asks Shiv to edit `agent-gate.md`, and nothing here shows the edit was ' +
        'verified to work. The floor is matched by action KIND and cannot be scoped, so no ' +
        'allow rule can create an exception to it -- an ask to add an allow line for a ' +
        'floor-blocked action is a promise the gate cannot keep, and he has already spent a ' +
        'cycle doing exactly that (#513). Verify it first: write the PROPOSED gate to a temp ' +
        'file and run `oa-state.ps1 consent -Id <id> -Action <kind> -Repo <repo> -GatePath ' +
        '<temp>`, then run it again with the requested edit OMITTED from that same proposed ' +
        'gate. If the two verdicts match, the line you are asking for contributes nothing and ' +
        'the ask is false however green it looks. Record the result in the turn -- the word ' +
        '`-GatePath` is what this guard looks for -- and if the only working edit is removing ' +
        'a floor rule, say so in those words and name what it exposes. `-DisableGuard G18` ' +
        'for a turn that discusses the gate without instructing an edit'));
    }
  }

  // G14 (#618): a not-blocking declaration over a direct question.
  if (on('G14') && (ciEq(ask, 'offer') || ciEq(ask, 'none'))) {
    const contra = askContradiction(body);
    if (contra) {
      findings.push(newFinding('G14', contra.line, contra.text,
        `this turn declares -Ask ${ask}, but asks Shiv a direct question. A not-blocking ` +
        'declaration sets awaiting_reply false, so the question is dropped from the ' +
        'blocked-on-human digest and no later run re-raises it (#618) -- it would reach ' +
        'nobody. Use -Ask blocking if you need the answer to continue; reword to a ' +
        'statement if you do not; -DisableGuard G14 if you really mean it'));
    }
  }

  // G17 (#627): a turn into a task the USER paused, with no reply from him since.
  if (on('G17') && ctx.pauseVerdict) {
    findings.push(newFinding('G17', 1, 'status=' + ctx.pauseVerdict.status,
      'this task was paused by the user' +
      (ctx.pauseVerdict.at ? ' at ' + ctx.pauseVerdict.at : '') +
      ', and writing a turn into it continues work he stopped. A pause is his instruction, not ' +
      'a scheduling state: dispatch already refuses to WAKE a paused task, and this refuses the ' +
      'other half #627 names -- a session that was already alive when the pause landed. He clears ' +
      'it by replying in the journal below the newest turn, or a run records his decision with ' +
      '`oa-state.ps1 mark -StatusBy user`. Use `-DisableGuard G17` only for a turn that is ' +
      'deliberately recording the pause itself'));
  }

  // G16 (#491): an OFFERED reply word (on an ask line, or a line opening with the offer) that
  // the consent reader does not accept.
  if (on('G16')) {
    const offerRe = '(?im)^[ \\t]*(?:\\*{0,2}(?:Needs from you|Your call|Next)\\b[^\\r\\n]*?|)\\breply\\s+(?:\\*\\*([^*\\r\\n]{1,40})\\*\\*|`([^`\\r\\n]{1,40})`)';
    for (const mm of rxMatches(body, offerRe)) {
      const line = mm[0];
      if (!psMatch(line, '(?i)(Needs from you|Your call|Next)\\b') && !psMatch(line, '(?i)^[ \\t]*reply\\b')) continue;
      const wordRaw = mm[1] !== undefined ? mm[1] : mm[2];
      const word = trimChars(netTrim(psStr(wordRaw)), '.,!:;');
      if (!word) continue;
      const lineNo = splitLines(body.slice(0, mm.index)).length;
      if (lineNo <= lines.length && inFence[lineNo - 1]) continue;
      if (netRe(ConsentAffirmRe).test(word)) continue;
      findings.push(newFinding('G16', lineNo, netTrim(mm[0]),
        `this turn offers "${word}" as a reply, but the consent reader does not accept it, so ` +
        'typing it would do nothing and would be indistinguishable from him declining (#491). ' +
        'Offer a word the reader accepts -- approve, yes, go ahead, lgtm, ship it, do it, ' +
        'proceed, or `merge <N>` -- or use -DisableGuard G16 if you really mean it'));
    }
  }

  // G15 (#635): a proposal naming an issue whose fix is already cited in shipped source. Fails
  // OPEN, loudly: a classifier that could not measure is an advisory (g15Note), not a refusal.
  if (on('G15')) {
    const proposed = proposedIssues(lines, inFence);
    if (proposed.length > 0) {
      const nums = [...new Set(proposed.map((x) => x.n))].sort((a, b) => a - b);
      const verdict = shippedVerdict(ctx, nums);
      if (!verdict.ok) {
        ctx.g15Note = verdict.reason;
      } else {
        for (const s of verdict.shipped) {
          const sn = get(s, 'n');
          const hit = proposed.find((x) => looseIntEq(x.n, sn));
          const impl = get(s, 'impl');
          const cited = psTruthy(impl) ? (Array.isArray(impl) ? impl : [impl]).slice(0, 2).map(psStr).join(', ') : 'implementation source';
          const n = psStr(sn);
          findings.push(newFinding('G15', hit ? hit.line : 0, hit ? hit.text : '',
            `this turn proposes work on #${n}, but #${n}'s fix is already cited in shipped source on ` +
            `origin/main (${cited}). A shipped PR does not close its issue here, so OPEN spans ` +
            'unworked AND shipped-awaiting-his-review, and the tracker shows them identically (#630) -- ' +
            'twelve such picks were made in two days (#635). Verify with ' +
            'git grep "#' + n + '" origin/main -- packages plugins, then propose something unworked. ' +
            'Use -DisableGuard G15 if he has asked for a second look at it'));
        }
      }
    }
  }

  // G19 (#739): a Proposed plan must open with a [gated] step under -Ask blocking, and every
  // numbered step after the status line must be classified.
  if (on('G19')) {
    let proposedLine = -1;
    let firstStep = -1;
    for (let i = 0; i < lines.length; i++) {
      if (inFence[i]) continue;
      if (psMatch(lines[i], '^[ \\t]*\\*\\*Status:\\*\\*[ \\t]*Proposed\\b')) proposedLine = i;
      if (proposedLine >= 0 && firstStep < 0 && psMatch(lines[i], '^[ \\t]*1\\.[ \\t]+')) firstStep = i;
    }
    if (proposedLine >= 0) {
      if (!ciEq(ask, 'blocking') || firstStep < 0 || !psMatch(lines[firstStep], '^[ \\t]*1\\.[ \\t]+\\[gated\\][ \\t]+')) {
        findings.push(newFinding('G19', proposedLine + 1, netTrim(lines[proposedLine]),
          'proposed parks the task: its first numbered step must be [gated] and -Ask blocking. ' +
          'For reversible or gate-allowed first steps, dispatch them this wake and write the ' +
          'outcome as in-progress/done (or blocked only when gated work remains)'));
      }
      for (let i = proposedLine + 1; i < lines.length; i++) {
        if (inFence[i] || !psMatch(lines[i], '^[ \\t]*[1-9][0-9]*\\.[ \\t]+')) continue;
        if (!psMatch(lines[i], '^[ \\t]*[1-9][0-9]*\\.[ \\t]+\\[(reversible|gate-allowed|gated)\\][ \\t]+')) {
          findings.push(newFinding('G19', i + 1, netTrim(lines[i]),
            'classify each proposed plan step as [reversible], [gate-allowed] or [gated]'));
        }
      }
    }
  }

  // G13 (#560): the author must DECLARE the ask; last, so real damage is reported alongside it.
  if (on('G13')) {
    const askVal = lowerInvariant(netTrim(ask));
    if (askVal.length === 0) {
      findings.push(newFinding('G13', 1, '(no -Ask)',
        'this turn does not declare what it asks of Shiv, so `awaiting_reply` would be recovered by regex ' +
        "from its closing sentence -- which is how the skill's own \"**Your call:** reply below in plain " +
        'English" boilerplate parked 81 tasks (#560). Pass -Ask blocking (the run cannot proceed until he ' +
        'answers), -Ask offer (a courtesy option he may decline by silence), or -Ask none (nothing is asked)'));
    } else if (!ciContains(AskValues, askVal)) {
      findings.push(newFinding('G13', 1, `-Ask ${ask}`,
        `unknown -Ask value '${ask}'. It must be exactly one of: ` + AskValues.join(', ') +
        '. A value this script does not recognise would be stamped into the journal and then ignored by ' +
        'oa-state.ps1, which falls back to the prose -- silently reinstating the defect the flag removes'));
    } else {
      for (let i = 0; i < lines.length; i++) {
        if (inFence[i]) continue;
        if (psMatch(lines[i], AskDeclRe)) {
          findings.push(newFinding('G13', i + 1, netTrim(lines[i]),
            'this body writes its own `oa-ask` stamp. The stamp is emitted by this script from -Ask, and ' +
            'the reader takes the LAST one in the turn -- so a hand-written stamp can silently override the ' +
            'declaration you passed. Remove it (or fence it, if you are quoting the format)'));
          break;
        }
      }
    }
  }

  // G21: the identity stamp is the tool's to write. A body carrying its own could claim any
  // author; fenced quotations are exempt. Not disableable.
  for (let i = 0; i < lines.length; i++) {
    if (inFence[i]) continue;
    if (psMatch(lines[i], IdentityStampRe)) {
      findings.push(newFinding('G21', i + 1, netTrim(lines[i]),
        'this body writes its own `oa-by` identity stamp. The stamp records which agent wrote the turn and is ' +
        'emitted by this tool from -Author / the session; a hand-written one could claim any author. Remove it ' +
        '(or fence it, if you are quoting the format). This guard cannot be disabled'));
      break;
    }
  }

  return findings;
}

// G20: the only file this tool may write is the task's own journal inside -JournalDir. The
// planner's consent rules (agent-gate.md, user-settings.md) are the user's alone (spec: the agent
// can never write agent-gate.md), so an -Id carrying a path, a target outside -JournalDir, or a
// journal that is a link to a protected file is refused. Not disableable.
const PROTECTED_FILES = ['agent-gate.md', 'user-settings.md'];
function protectedTargetFinding(journalDir, id, journal) {
  const refuse = (why) => newFinding('G20', 1, `-Id ${id}`,
    `${why} write-turn writes exactly one file, journal/task-<id>.md; agent-gate.md and ` +
    'user-settings.md hold the consent rules and only the user writes them. This guard cannot be disabled');
  if (/[\\/]/.test(id) || id.includes('..') || id.includes(':')) return refuse('-Id must be a task id, not a path.');
  const dir = path.resolve(journalDir);
  let target = path.resolve(journal);
  try { target = fs.realpathSync.native(target); } catch { /* not there yet: judged by its name */ }
  let realDir = dir;
  try { realDir = fs.realpathSync.native(dir); } catch { /* judged lexically */ }
  if (PROTECTED_FILES.includes(path.basename(target).toLowerCase())) return refuse(`the target resolves to ${path.basename(target)}.`);
  const inside = (d) => target.toLowerCase().startsWith((d.replace(/[\\/]+$/, '') + path.sep).toLowerCase());
  if (!inside(dir) && !inside(realDir)) return refuse('the target resolves outside -JournalDir.');
  return null;
}

// G22: no turn into a task that is snoozed today-or-later.
function ymdParts(raw) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw ?? '').trim());
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return { y, mo, d, text: `${m[1]}-${m[2]}-${m[3]}` };
}

function writeSnoozeActive(raw) {
  const p = ymdParts(raw);
  if (!p) return null;
  const now = new Date();
  const today = now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
  const key = p.y * 10000 + p.mo * 100 + p.d;
  // TODAY-COMPARISON-MUTANT-ANCHOR: today itself is still snoozed.
  return key >= today ? p.text : null;
}

function writeBoardRowId(line) {
  const s = String(line ?? '');
  if (!psMatch(s, '^\\s*\\|')) return null;
  const first = s.trim().replace(/^\|+|\|+$/g, '').split(/\|/)[0];
  if (first === undefined || first === null) return null;
  const m = psMatch(String(first).trim(), '^(\\d+)');
  return m ? m[1] : null;
}

function writeSnoozeVerdict(taskId, journalDir) {
  if (!taskId) return null;
  const plannerDir = path.dirname(journalDir);
  const storePath = path.join(plannerDir, 'snooze.json');
  const boardPath = path.join(plannerDir, 'planner.md');

  // STORE-READ-MUTANT-ANCHOR: store ignored
  if (testPath(storePath)) {
    try {
      const raw = readAllText(storePath);
      if (raw.trim().length > 0) {
        let json = JSON.parse(raw);
        for (const wrapper of ['tasks', 'snoozed']) {
          const v = get(json, wrapper);
          if (v) { json = v; break; }
        }
        if (json && typeof json === 'object') {
          for (const [name, rawVal] of Object.entries(json)) {
            if (!/^\d+$/.test(name)) continue;
            if (name !== String(taskId)) continue;
            let val = rawVal;
            if (typeof val !== 'string') val = get(val, 'until');
            const active = writeSnoozeActive(String(val ?? ''));
            if (active) return { kind: 'active', until: active, source: 'snooze.json', snippet: `snooze_until=${active}` };
            return null;
          }
        }
      }
    } catch {
      // MALFORMED-STORE-MUTANT-ANCHOR: malformed store must refuse rather than read as empty.
      return { kind: 'malformed', until: '', source: 'snooze.json', snippet: 'snooze.json' };
    }
  }

  if (testPath(boardPath)) {
    for (const line of splitLines(readAllText(boardPath))) {
      const tid = writeBoardRowId(line);
      if (tid !== String(taskId)) continue;
      const m = psMatch(line, '<!--\\s*snooze:(\\d{4}-\\d{2}-\\d{2})\\s*-->');
      if (m) {
        const active = writeSnoozeActive(m[1]);
        if (active) return { kind: 'active', until: active, source: 'planner.md', snippet: `snooze_until=${active}` };
      }
    }
  }
  return null;
}

function snoozeWriteFinding(id, verdict) {
  if (!verdict) return null;
  if (verdict.kind === 'malformed') {
    return newFinding('G22', 1, verdict.snippet,
      'cannot verify the snooze store; fix snooze.json. A malformed snooze.json could hide a task ' +
      'the user explicitly postponed, so write-turn refuses to append a turn until the store is readable. ' +
      'This guard cannot be disabled');
  }
  // G22-FINDING-MUTANT-ANCHOR: the snooze write guard is load-bearing.
  return newFinding('G22', 1, verdict.snippet,
    `task ${id} is snoozed until ${verdict.until} by ${verdict.source}, and a snoozed task gets no ` +
    'agent turn until that date has passed. Snooze is the executable eligibility floor: no plan, ' +
    'execution, board edit, or journal edit is allowed while it is active, even when the journal has ' +
    'a fresh human reply. This guard cannot be disabled');
}

// [int] conversion of WRITE_TURN_WAKE_WINDOW_MIN (default 45).
function wakeWindow(raw) {
  if (!raw) return 45;
  const s = raw.trim();
  if (/^[+-]?[0-9]+$/.test(s)) return Number(s);
  if (/^0x[0-9a-f]+$/i.test(s)) return parseInt(s, 16);
  if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) {
    const x = Number(s);
    const f = Math.floor(x);
    const r = x - f;
    return r > 0.5 || (r === 0.5 && f % 2 !== 0) ? f + 1 : f; // banker's rounding
  }
  throw fail(`Cannot convert value "${raw}" to type "System.Int32". Error: "The input string '${raw}' was not in a correct format."`);
}

function run(argv, out) {
  const P = parseArgs(argv);
  const id = P.Id ?? '';
  const bodyFile = P.BodyFile;
  const ask = P.Ask ?? '';
  const author = P.Author ?? '';
  const disabled = P.DisableGuard ?? [];
  let journalDir = P.JournalDir ?? 'C:\\Users\\shiv\\OneDrive\\Apps\\Focus Planner\\journal';

  let oaHome;
  if (process.env.WRITE_TURN_OA_HOME) oaHome = process.env.WRITE_TURN_OA_HOME;
  else if (process.env.OVERNIGHT_AGENT_HOME) oaHome = process.env.OVERNIGHT_AGENT_HOME;
  else {
    const lad = process.env.LOCALAPPDATA;
    if (lad === undefined) throw fail("Cannot bind argument to parameter 'Path' because it is null.");
    if (lad === '') throw fail("Cannot bind argument to parameter 'Path' because it is an empty string.");
    oaHome = joinPS(lad, 'overnight-agent');
  }

  // Sandbox mode (tests/e2e/run-sandbox.ps1), inert unless the variables are set: the planner
  // dir replaces the default journal folder (an explicit -JournalDir wins), and OA_SANDBOX_ROOT
  // makes any resolved path outside the sandbox a hard error (exit 3).
  if (process.env.OVERNIGHT_AGENT_PLANNER_DIR && P.JournalDir === undefined) {
    journalDir = joinPS(process.env.OVERNIGHT_AGENT_PLANNER_DIR, 'journal');
  }
  if (process.env.OA_SANDBOX_ROOT) {
    const expand = (s) => s.replace(/%([^%]+)%/g, (whole, name) => {
      const k = Object.keys(process.env).find((x) => x.toLowerCase() === name.toLowerCase());
      return k === undefined ? whole : process.env[k];
    });
    const full = (s) => path.resolve(expand(s)).replace(/[\\/]+$/, '');
    const sbRoot = full(process.env.OA_SANDBOX_ROOT);
    for (const [name, value] of [['JournalDir', journalDir], ['OA home', oaHome], ['BodyFile', bodyFile]]) {
      if (!value) continue;
      const f = full(value);
      const inside = f.toLowerCase() === sbRoot.toLowerCase() || f.toLowerCase().startsWith((sbRoot + path.sep).toLowerCase());
      if (!inside) throw new Exit(3, `oa_sandbox_violation: ${name} '${f}' is outside OA_SANDBOX_ROOT '${sbRoot}'`);
    }
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const issueResolver = process.env.WRITE_TURN_ISSUE_RESOLVER
    ? process.env.WRITE_TURN_ISSUE_RESOLVER
    : [here, '..', '..', 'checks', 'issue-shipped.mjs'].join(SEP);
  const ctx = makeContext({ id, journalDir, oaHome, author, issueResolver, wakeWindowMin: wakeWindow(process.env.WRITE_TURN_WAKE_WINDOW_MIN) });

  if (!testPath(bodyFile)) throw fail(`body file not found: ${bodyFile}`);
  const body = readAllText(bodyFile);
  if (netTrim(body).length === 0) throw fail('body file is empty');

  // The pointer guards and G17/G22 are properties of the DESTINATION, resolved before validation so
  // `-Validate` with an `-Id` reaches the same verdict as the real write.
  const journal = id ? joinPS(journalDir, `task-${id}.md`) : null;
  const doc = journal ? journalDocMeta(journal) : null;
  ctx.pauseVerdict = userPauseVerdict(ctx, id, journal);
  const snoozeVerdict = writeSnoozeVerdict(id, journalDir);

  let findings = turnBodyFindings(ctx, body, disabled, doc, ask);
  if (id && !ciContains(disabled, 'G12')) {
    const wake = wakeTurnFinding(ctx, journal, id);
    if (wake) findings = [...findings, wake];
  }
  // G22 is fail-closed and not disableable: a snoozed task is outside every agent phase until
  // the wake date has passed.
  if (snoozeVerdict) {
    const snooze = snoozeWriteFinding(id, snoozeVerdict);
    if (snooze) findings = [...findings, snooze];
  }
  if (id) {
    const prot = protectedTargetFinding(journalDir, id, journal);
    if (prot) findings = [...findings, prot];
  }
  const hasAsk = turnHasAsk(body);
  const askVal = lowerInvariant(netTrim(ask));
  const bodyLen = netTrim(body).length;
  const say = (s) => out(s + EOL);

  if (P.Json) {
    const json = JSON.stringify({
      ok: findings.length === 0,
      findings,
      hasAsk,
      ask: askVal,
      id,
      docBound: !!doc,
      docId: doc ? doc.doc_id : '',
      g15Note: ctx.g15Note ? String(ctx.g15Note) : '',
      length: bodyLen,
    }, null, 2);
    say(json.replace(/\n/g, EOL));
  } else {
    if (findings.length > 0) {
      say(`[write-turn] REFUSED - ${findings.length} guard violation(s); nothing written.`);
      for (const f of findings) {
        say(`  ${f.guard} line ${f.line}: ${f.why}`);
        say(`      | ${f.snippet}`);
      }
    }
    if (!hasAsk) {
      say('[write-turn] NOTE - this turn carries no ask the digest can read.');
      say('      Fine for an informational turn. If it is meant to ask for something,');
      say('      use one of: "**Needs from you:** ...", "Reply `word`", "**Next:** ...",');
      say('      or "**Your call:** ...". A bare "*Reply:* **`word`**" is NOT read as an ask.');
    }
    if (askVal === 'blocking' && !hasAsk) {
      say('[write-turn] NOTE - -Ask blocking, but no ask line the digest can read.');
      say('      The stamp parks the task; the PROSE is what reaches him. Add one of:');
      say('      "**Needs from you:** ...", "Reply `word`", "**Next:** ...", "**Your call:** ...".');
    }
    if (ctx.g15Note) {
      say('[write-turn] NOTE - could not check the proposed issue(s) against shipped source.');
      say(`      ${ctx.g15Note}`);
      say('      G15 did not run, so this turn may be proposing work that already shipped.');
      say('      Verify by hand: git grep "#<N>" origin/main -- packages plugins');
    }
    if (ctx.pauseAdvisory) {
      say('[write-turn] NOTE - could not check whether the user paused this task.');
      say(`      ${ctx.pauseAdvisory}`);
      say('      G17 did not run, so this turn may be continuing work he stopped.');
    }
    if (doc && findings.length === 0 && bodyLen > POINTER_NUDGE) {
      say(`[write-turn] NOTE - ${bodyLen} chars; this task has a catch-up doc, so aim under ~${POINTER_NUDGE}.`);
      say('      The narrative belongs in the doc (amended in place). The turn keeps the status,');
      say('      the doc link, a sentence or two, and the ask.');
    }
  }

  if (findings.length > 0) return 2;

  if (P.Validate) {
    if (!P.Json) say('[write-turn] clean (validate only - nothing written).');
    return 0;
  }

  if (!id) throw fail('-Id is required unless -Validate is set');
  if (!testPath(journal)) throw fail(`journal not found: ${journal}`);

  // Back up before touching it; the directory is created rather than assumed.
  const stamp = stampNow();
  fs.mkdirSync(oaHome, { recursive: true });
  fs.copyFileSync(journal, path.join(oaHome, `task-${id}.bak-${stamp}.md`));

  const existing = readAllText(journal);
  // Match the file's own newline style; journals round-trip through OneDrive and the web app.
  const nl = existing.includes('\r\n') ? '\r\n' : '\n';
  const sep = existing.endsWith('\n') ? nl : nl + nl;

  // G6: the Telegram bridge skips a journal with no sentinel, so open the managed block here.
  let prefix = '';
  if (!psMatch(existing, '<!-- OVERNIGHT-AGENT do not edit this line')) {
    prefix = '---' + nl + SENTINEL_LINE + nl + nl;
    if (!P.Json) say('[write-turn] journal had no OVERNIGHT-AGENT sentinel - adding it (the Telegram bridge skips tasks without one).');
  }

  const turn = addAskStamp(netTrimEnd(body), askVal, identityStamp(author)).replace(/\r?\n/g, nl);
  writeAllText(journal, existing + sep + prefix + turn + nl);
  if (!P.Json) say(`[write-turn] appended ${bodyLen} chars to task-${id}.md (ask: ${askVal}, backup: task-${id}.bak-${stamp}.md)`);
  return 0;
}

// ---------------------------------------------------------------------------------------------
// The sent-messages ledger. Teams, mail and Google Doc comments are posted AS the user, so a reply
// on those channels can only count as his when it is not one the agent itself sent. Every message
// the agent sends outside the planner is recorded here, and the consent reader asks was-sent.
// One JSON object per line, appended; an existing (channel, message id) is never recorded twice.
// ---------------------------------------------------------------------------------------------
const LEDGER_FILE = 'sent-messages.jsonl';
const bad = (message) => new Exit(3, message);

function oaHomeDir() {
  if (process.env.WRITE_TURN_OA_HOME) return process.env.WRITE_TURN_OA_HOME;
  if (process.env.OVERNIGHT_AGENT_HOME) return process.env.OVERNIGHT_AGENT_HOME;
  if (!process.env.LOCALAPPDATA) throw bad('cannot locate the OA home: set OVERNIGHT_AGENT_HOME (or LOCALAPPDATA)');
  return joinPS(process.env.LOCALAPPDATA, 'overnight-agent');
}

function assertLedgerSandbox(p) {
  if (!process.env.OA_SANDBOX_ROOT) return;
  const sb = path.resolve(process.env.OA_SANDBOX_ROOT).replace(/[\\/]+$/, '');
  const full = path.resolve(p).replace(/[\\/]+$/, '');
  const inside = full.toLowerCase() === sb.toLowerCase() || full.toLowerCase().startsWith((sb + path.sep).toLowerCase());
  if (!inside) throw bad(`oa_sandbox_violation: ledger '${full}' is outside OA_SANDBOX_ROOT '${sb}'`);
}

function ledgerArgs(argv, allowed) {
  const o = {};
  for (let k = 0; k < argv.length; k++) {
    const m = /^--?([A-Za-z][A-Za-z-]*)(?:[:=]([\s\S]*))?$/.exec(argv[k]);
    if (!m) throw bad(`unexpected argument '${argv[k]}'`);
    const key = m[1].toLowerCase().replace(/-/g, '');
    const name = allowed.find((a) => a.toLowerCase() === key);
    if (!name) throw bad(`unknown parameter '${m[1]}' (expected ${allowed.map((a) => '-' + a).join(', ')})`);
    let v = m[2];
    if (v === undefined) { v = argv[++k]; if (v === undefined) throw bad(`-${name} needs a value`); }
    o[name] = v;
  }
  return o;
}

function ledgerRows(file) {
  const rows = [];
  let malformed = 0;
  if (!testPath(file)) return { rows, malformed };
  for (const line of readAllText(file).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r.channel === 'string' && typeof r.message_id === 'string') rows.push(r); else malformed++;
    } catch { malformed++; }
  }
  return { rows, malformed };
}

function isoLocal(ms) {
  const d = new Date(ms);
  const p2 = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}` +
    `${off >= 0 ? '+' : '-'}${p2(Math.floor(Math.abs(off) / 60))}:${p2(Math.abs(off) % 60)}`;
}

function ledgerCommand(cmd, argv, out) {
  const a = ledgerArgs(argv, cmd === 'record-sent' ? ['Channel', 'MessageId', 'TaskId', 'At', 'Author'] : ['Channel', 'MessageId']);
  const channel = String(a.Channel || '').trim().toLowerCase();
  const messageId = String(a.MessageId || '').trim();
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(channel)) throw bad('-Channel is required: a short lower-case name such as teams, mail, google-doc, telegram');
  if (!messageId || messageId.length > 1024 || /[\r\n]/.test(messageId)) throw bad('-MessageId is required: the id the channel gave the sent message (one line, at most 1024 characters)');
  const home = oaHomeDir();
  const file = path.join(home, LEDGER_FILE);
  assertLedgerSandbox(file);
  const { rows, malformed } = ledgerRows(file);
  const existing = rows.find((r) => r.channel.toLowerCase() === channel && r.message_id === messageId) || null;
  const emit = (o) => out(JSON.stringify(o, null, 2).replace(/\n/g, EOL) + EOL);
  if (cmd === 'was-sent') {
    emit({ ok: true, sent: !!existing, entry: existing, ledger: file, malformed });
    return 0;
  }
  const taskId = a.TaskId === undefined ? '' : String(a.TaskId).trim();
  if (taskId.length > 64 || /[\r\n]/.test(taskId)) throw bad('-TaskId must be a task id (one line, at most 64 characters)');
  let at = isoLocal(Date.now());
  if (a.At !== undefined) {
    const ms = Date.parse(String(a.At));
    if (Number.isNaN(ms) || !/^\d{4}-\d{2}-\d{2}T/.test(String(a.At))) throw bad('-At must be an ISO-8601 timestamp, e.g. 2026-10-01T03:00:00-07:00');
    at = String(a.At);
  }
  if (existing) {
    emit({ ok: true, recorded: false, duplicate: true, entry: existing, ledger: file });
    return 0;
  }
  const session = a.Author || process.env.COPILOT_AGENT_SESSION_ID || 'unknown';
  const host = hostName();
  const entry = { v: 1, at, channel, message_id: messageId, task_id: taskId, by: identityValue(session), host: identityValue(host) };
  fs.mkdirSync(home, { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  emit({ ok: true, recorded: true, duplicate: false, entry, ledger: file });
  return 0;
}

function publishMetadata(argv, out) {
  // Lazy: write-turn.mjs stays one self-contained file for every other path (mutation checks copy
  // it alone and run the copy); only this subcommand needs the engine's library.
  const fail = (e) => {
    const code = e instanceof Exit ? e.code : (Number.isInteger(e?.code) ? e.code : 1);
    if (e?.message) process.stderr.write(e.message + EOL);
    process.exitCode = code;
  };
  import('./oa-state-lib/act/agent-metadata.mjs').then((m) => {
    try {
      process.exitCode = m.publishMetadataCommand(argv, {
        oaHome: oaHomeDir,
        out: (o) => out(JSON.stringify(o, null, 2).replace(/\n/g, EOL) + EOL),
      });
    } catch (e) { fail(e); }
  }, fail);
}

function main() {
  const out = (s) => process.stdout.write(s);
  try {
    const argv = process.argv.slice(2);
    if (argv[0] === 'record-sent' || argv[0] === 'was-sent') { process.exitCode = ledgerCommand(argv[0], argv.slice(1), out); return; }
    if (argv[0] === 'publish-metadata') { publishMetadata(argv.slice(1), out); return; }
    process.exitCode = run(argv, out);
  } catch (e) {
    if (e instanceof Exit) {
      if (e.message) process.stderr.write(e.message + EOL);
      process.exitCode = e.code;
      return;
    }
    process.stderr.write((e && e.message ? e.message : String(e)) + EOL);
    process.exitCode = 1;
  }
}

// Exported for the differential tests only; the CLI is the contract.
export { netRe, netTrim, netTrimEnd, lowerInvariant, parseNetDate, fenceMaskedText };

let invokedPath = '';
try { invokedPath = process.argv[1] ? fs.realpathSync(process.argv[1]) : ''; } catch { invokedPath = ''; }
if (invokedPath && invokedPath === fs.realpathSync(fileURLToPath(import.meta.url))) main();
