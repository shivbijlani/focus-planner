#!/usr/bin/env node
// Deterministic stand-in for checks/issue-shipped.mjs, used by write-turn's G15 guard.
// CHAR_SHIPPED="640,641" marks those issue numbers as shipped; everything else is unworked.
// CHAR_SHIPPED="!fail" simulates a classifier that cannot measure (G15's advisory path).
const args = process.argv.slice(2).filter((a) => a !== '--json');
const spec = process.env.CHAR_SHIPPED || '';
if (spec === '!fail') {
  process.stdout.write(JSON.stringify({ ok: false, reason: 'origin/main is not resolvable (stub)', results: [] }));
  process.exit(2);
}
const shipped = new Set(spec.split(',').map((s) => s.trim()).filter(Boolean));
const results = args.map((a) => {
  const n = Number(a);
  const hit = shipped.has(String(n));
  return hit ? { n, shipped: true, impl: [`packages/example/src/fix-${n}.js`] } : { n, shipped: false, impl: [] };
});
process.stdout.write(JSON.stringify({ ok: true, ref: 'origin/main', results }));
process.exit(results.some((r) => r.shipped) ? 1 : 0);
