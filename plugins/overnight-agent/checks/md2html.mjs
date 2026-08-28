// md2html.mjs — minimal, dependency-free Markdown -> email-safe HTML.
// Handles: h1-h4, tables, bold/italic/code, ul/ol, hr, blockquote, links, paragraphs.
// Usage: node md2html.mjs <in.md> <out.html> ["Optional H1 override"]
import fs from 'node:fs';

const [, , inPath, outPath, titleOverride] = process.argv;
if (!inPath || !outPath) {
  console.error('usage: node md2html.mjs <in.md> <out.html> [title]');
  process.exit(1);
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(s) {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, '<code style="background:#f2f2f2;padding:1px 4px;border-radius:3px">$1</code>');
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  return t;
}

const lines = fs.readFileSync(inPath, 'utf8').split(/\r?\n/);
const out = [];
let i = 0;
let para = [];

const flushPara = () => {
  if (para.length) {
    out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  }
};

while (i < lines.length) {
  const line = lines[i];

  if (!line.trim()) { flushPara(); i++; continue; }

  // horizontal rule
  if (/^---+$/.test(line.trim())) {
    flushPara();
    out.push('<hr style="border:0;border-top:1px solid #ddd;margin:24px 0">');
    i++; continue;
  }

  // heading
  const h = line.match(/^(#{1,4})\s+(.*)$/);
  if (h) {
    flushPara();
    const lvl = h[1].length;
    const size = { 1: '22px', 2: '18px', 3: '16px', 4: '15px' }[lvl];
    const mt = lvl === 1 ? '0' : '26px';
    out.push(`<h${lvl} style="font-size:${size};margin:${mt} 0 10px;line-height:1.3">${inline(h[2])}</h${lvl}>`);
    i++; continue;
  }

  // table
  if (line.trim().startsWith('|') && lines[i + 1] && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
    flushPara();
    const cells = (r) => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    const head = cells(line);
    i += 2;
    const body = [];
    while (i < lines.length && lines[i].trim().startsWith('|')) { body.push(cells(lines[i])); i++; }
    const th = head.map((c) => `<th align="left" style="border-bottom:2px solid #ccc;padding:6px 10px 6px 0">${inline(c)}</th>`).join('');
    const tr = body.map((r) =>
      `<tr>${r.map((c) => `<td style="border-bottom:1px solid #eee;padding:6px 10px 6px 0">${inline(c)}</td>`).join('')}</tr>`).join('');
    out.push(`<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;margin:14px 0;font-size:15px">`
      + `<thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`);
    continue;
  }

  // blockquote
  if (line.trim().startsWith('>')) {
    flushPara();
    const buf = [];
    while (i < lines.length && lines[i].trim().startsWith('>')) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
    out.push(`<blockquote style="margin:14px 0;padding:10px 14px;border-left:3px solid #888;background:#fafafa">`
      + `${inline(buf.join(' '))}</blockquote>`);
    continue;
  }

  // lists (supports simple continuation lines)
  const li = line.match(/^\s*([-*]|\d+\.)\s+(.*)$/);
  if (li) {
    flushPara();
    const ordered = /\d/.test(li[1]);
    const items = [];
    while (i < lines.length) {
      const m = lines[i].match(/^\s*([-*]|\d+\.)\s+(.*)$/);
      if (m) { items.push(m[2]); i++; }
      else if (lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && items.length) { items[items.length - 1] += ' ' + lines[i].trim(); i++; }
      else break;
    }
    const tag = ordered ? 'ol' : 'ul';
    out.push(`<${tag} style="margin:12px 0;padding-left:22px">`
      + items.map((x) => `<li style="margin:5px 0">${inline(x)}</li>`).join('') + `</${tag}>`);
    continue;
  }

  para.push(line.trim());
  i++;
}
flushPara();

const title = titleOverride || 'Overnight Agent';
const html = `<!doctype html><html><head><meta charset="utf-8">`
  + `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>`
  + `<body style="margin:0;padding:16px;background:#fff">`
  + `<div style="max-width:660px;margin:0 auto;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;`
  + `font-size:16px;line-height:1.55;color:#1a1a1a">`
  + out.join('\n')
  + `</div></body></html>`;

fs.writeFileSync(outPath, html, 'utf8');
console.log(`wrote ${outPath} (${html.length} bytes)`);
