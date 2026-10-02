// fsx.mjs -- file reads and writes with the exact encodings oa-state.ps1 uses.
//
//   readAllText        [IO.File]::ReadAllText(path[, UTF8]): honours a BOM (UTF-8/16/32), strips
//                      it, defaults to UTF-8. Invalid UTF-8 decodes to U+FFFD, as .NET does.
//   getContentRaw      Get-Content -Raw (PowerShell 7): the same decode, but an EMPTY file is $null.
//   writeJsonAtomic    Write-JsonAtomic: `ConvertTo-Json -Depth 12`, UTF-8 WITH a BOM, via a temp
//                      file and an atomic replace.
//   writeAllTextUtf8   [IO.File]::WriteAllText(p, s, UTF8Encoding($false)): no BOM.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { toJson } from './psjson.mjs';

function decodeUtf32(buf, start, le) {
  let s = '';
  for (let o = start; o + 3 < buf.length; o += 4) {
    const cp = le ? buf.readUInt32LE(o) : buf.readUInt32BE(o);
    s += cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '\uFFFD';
  }
  if ((buf.length - start) % 4) s += '\uFFFD';
  return s;
}

export function decodeBuffer(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return new TextDecoder('utf-8').decode(buf.subarray(3));
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xfe && buf[2] === 0 && buf[3] === 0) return decodeUtf32(buf, 4, true);
  if (buf.length >= 4 && buf[0] === 0 && buf[1] === 0 && buf[2] === 0xfe && buf[3] === 0xff) return decodeUtf32(buf, 4, false);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  return new TextDecoder('utf-8').decode(buf);
}

export const readAllText = (p) => decodeBuffer(fs.readFileSync(p));

export function getContentRaw(p) {
  const text = readAllText(p);
  return text === '' ? null : text;
}

// Test-Path: true for files and directories; false for empty/null.
export function testPath(p) {
  if (!p) return false;
  try { fs.statSync(p); return true; } catch { return false; }
}
export function isFile(p) {
  if (!p) return false;
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
export function isDir(p) {
  if (!p) return false;
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

export const writeAllTextUtf8 = (p, s) => fs.writeFileSync(p, Buffer.from(s, 'utf8'));
export const writeAllTextUtf8Bom = (p, s) => fs.writeFileSync(p, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(s, 'utf8')]));
export const appendAllTextUtf8 = (p, s) => fs.appendFileSync(p, Buffer.from(s, 'utf8'));

export function ensureDir(d) {
  if (d && !testPath(d)) fs.mkdirSync(d, { recursive: true });
}

export function writeJsonAtomic(p, obj) {
  const tmp = `${p}.${crypto.randomUUID().replace(/-/g, '')}.tmp`;
  try {
    writeAllTextUtf8Bom(tmp, toJson(obj, { depth: 12 }).text);
    fs.renameSync(tmp, p);
  } finally {
    if (testPath(tmp)) fs.rmSync(tmp, { force: true });
  }
}

// [System.IO.Path]::GetFileNameWithoutExtension
export function fileNameWithoutExtension(p) {
  const base = path.win32.basename(String(p).replace(/\//g, '\\'));
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : dot === 0 ? '' : base;
}

// Read-JournalText: ALWAYS UTF-8 (a BOM is still honoured, as ReadAllText does), '' when absent.
export function readJournalText(p) {
  if (!testPath(p)) return '';
  return readAllText(p);
}