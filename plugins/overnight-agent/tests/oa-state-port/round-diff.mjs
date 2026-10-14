// round-diff.mjs -- netRound (core/net.mjs) against .NET's own [Math]::Round(x, digits).
//
// The live-data shadow (step 3) found the port printing a 5,376-byte deliverable as 5.3 KB where
// oa-state.ps1 printed 5.2: .NET rounds half to EVEN after scaling, JS Math.round rounds half up.
// This pins the replacement on the inputs that matter -- byte counts / 1024 and / 4000 (extract)
// and elapsed seconds (scan) -- with every exact midpoint included, plus seeded random doubles.
//
//   node round-diff.mjs [--n 4000] [--seed 7]
import { spawnSync } from 'node:child_process';
import { netRound } from '../../skills/overnight-agent/oa-state-lib/core/net.mjs';
import { toJson, netDouble } from '../../skills/overnight-agent/oa-state-lib/core/psjson.mjs';

const arg = (k, d) => (process.argv.includes(k) ? Number(process.argv[process.argv.indexOf(k) + 1]) : d);
const n = arg('--n', 4000);
let seed = arg('--seed', 7) >>> 0;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

const cases = [];
for (let b = 0; b <= 20480; b += 256) cases.push([b / 1024, 1]);        // every x.x5 KB midpoint and its neighbours
for (let b = 0; b <= 8000; b += 200) cases.push([b / 4 / 1000, 1]);       // the token estimate
for (let i = 0; i < n; i++) {
  const r = rand();
  if (r < 0.4) cases.push([Math.floor(rand() * 300000) / 1024, 1]);
  else if (r < 0.7) cases.push([Math.floor(rand() * 80000) / 4 / 1000, 1]);
  else cases.push([rand() * 300, 2]);
}

const script = '$in = [Console]::In.ReadToEnd() | ConvertFrom-Json; ' +
  '$out = foreach ($c in $in) { [math]::Round([double]$c[0], [int]$c[1]) }; ConvertTo-Json -InputObject @($out) -Compress';
const r = spawnSync(process.env.CHAR_PWSH || 'pwsh', ['-NoProfile', '-NonInteractive', '-Command', script],
  { input: JSON.stringify(cases), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if (r.status !== 0) { console.error(r.stderr); process.exit(2); }
const net = JSON.parse(r.stdout);
let bad = 0;
for (let i = 0; i < cases.length; i++) {
  const mine = netRound(cases[i][0], cases[i][1]);
  if (mine !== net[i]) {
    if (bad++ < 10) console.error(`DIFF Round(${cases[i][0]}, ${cases[i][1]}): .NET ${net[i]} node ${mine}`);
  }
}

// ...and how ConvertTo-Json WRITES a [double]: 6.0, -0.0, 5.2 (the shadow also found `"kb": 6` vs 6.0).
const sample = cases.slice(0, 400).map(([x, d]) => netRound(x, d)).concat([-0, 6, 0.1, 1e20, 123456.75, 1e15, 999999999999999, 0.0001, 0.00001, 1.5e-7, 2.5e17, 9.99e16, 1e17, 1e16, -1e17, -0.00001, 123456789012345678]);
const script2 = '$in = [Console]::In.ReadToEnd() | ConvertFrom-Json; ' +
  '$out = foreach ($c in $in) { [double]$c }; ConvertTo-Json -InputObject @($out) -Compress';
const sampleText = '[' + sample.map((x) => (Object.is(x, -0) ? '-0.0' : String(x))).join(',') + ']';
const r2 = spawnSync(process.env.CHAR_PWSH || 'pwsh', ['-NoProfile', '-NonInteractive', '-Command', script2],
  { input: sampleText, encoding: 'utf8' });
if (r2.status !== 0) { console.error(r2.stderr); process.exit(2); }
const mineText = toJson(sample.map((x) => netDouble(x)), { compress: true }).text;
if (mineText !== r2.stdout.trim()) {
  bad++;
  const a = mineText.split(','); const b = r2.stdout.trim().split(',');
  const k = a.findIndex((x, i) => x !== b[i]);
  console.error(`DIFF ConvertTo-Json [double] at #${k}: .NET ${b[k]} node ${a[k]}`);
}
console.log(`round-diff: ${cases.length} inputs, ${bad} differences`);
process.exit(bad ? 1 : 0);
