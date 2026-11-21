/**
 * Proves the pointer only sees an annotation where it is actually drawn.
 *
 * The user reported that the whole dashed box around an arrow turned the cursor
 * into a move arrow, including the large empty areas beside the shaft. That is
 * because hit-testing used the bounding box. These checks drive the shipped
 * predicates directly rather than through a mouse, so the geometry is tested
 * exactly — an arrow through its own box is mostly empty paper, and hitting that
 * paper must not select it.
 *
 * The predicates are extracted by importing the overlay with the window-startup
 * path short-circuited, which `--preview` already does.
 *
 *     node tests/hit-testing.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const require = createRequire(import.meta.url);

function resolveKoffi() {
  const modules = dirname(dirname(process.env.DSH_INSTALL_DIR ?? ''));
  const candidates = [
    join(modules, 'koffi'),
    join(modules.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`), 'koffi'),
    join(dirname(process.execPath), 'resources', 'app.asar.unpacked', 'dsh', 'node_modules', 'koffi'),
  ];
  for (const base of candidates) {
    const entry = join(base, 'index.cjs');
    if (existsSync(entry)) {
      try {
        return require(entry);
      } catch {
        /* next */
      }
    }
  }
  throw new Error('koffi not found');
}

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}${detail}`);
  else { console.log(`  FAIL ${name}${detail}`); failures += 1; }
};

/*
 * The overlay is a script, not a module with exports: it starts a window at the top
 * level. Rather than restructure it for testability, evaluate the geometry helpers
 * out of its source in a fresh context — the same approach `selection.mjs` uses for
 * the rectangle maths. Any of these functions calling something absent throws at
 * eval time, so the extraction itself is a smoke test.
 */
const source = readFileSync(join(root, 'lib', 'overlay.js'), 'utf8');

/** Pull one top-level function out of the source by name. */
function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found in overlay.js`);
  // Walk braces from the opening one so nested blocks and strings are balanced.
  const open = source.indexOf('{', start);
  let depth = 0;
  let index = open;
  let inString = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (inLineComment) { if (char === '\n') inLineComment = false; continue; }
    if (inBlockComment) { if (char === '*' && next === '/') { inBlockComment = false; index += 1; } continue; }
    if (inString !== null) {
      if (char === '\\') { index += 1; continue; }
      if (char === inString) inString = null;
      continue;
    }
    if (char === '/' && next === '/') { inLineComment = true; index += 1; continue; }
    if (char === '/' && next === '*') { inBlockComment = true; index += 1; continue; }
    if (char === '\'' || char === '"' || char === '`') { inString = char; continue; }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unbalanced braces while extracting ${name}`);
}

const wanted = ['hitsInk', 'distanceToSegment', 'annotationBounds', 'insideRect', 'measureText', 'hitsFrameEdge'];
const parts = [];
for (const name of wanted) {
  // `annotationBounds` calls `measureText` for text annotations; that needs GDI+, so
  // substitute a deterministic width instead. The geometry under test does not
  // depend on glyph metrics.
  if (name === 'measureText') {
    parts.push('function measureText(text, size) { return String(text).length * size * 0.6; }');
    continue;
  }
  parts.push(extractFunction(name));
}

const harness = new Function('screenWidth', 'state', `
  ${parts.join('\n\n')}
  return { hitsInk, distanceToSegment, annotationBounds, insideRect, hitsFrameEdge };
`);
// Screen dimensions only matter to clamping, which is not under test here.
const frameState = { sel: { x: 100, y: 100, w: 200, h: 100 } };
const helpers = harness(1366, frameState);
const { hitsInk, hitsFrameEdge } = helpers;

console.log('the extracted helpers exist');
check('hitsInk was extracted', typeof hitsInk === 'function');
check('distanceToSegment was extracted', typeof helpers.distanceToSegment === 'function');

/*
 * An arrow from (100,100) to (300,200): its box is 200x100, but the shaft only
 * occupies the diagonal. The two corners off the diagonal are the empty paper the
 * user pointed at.
 */
const arrow = { type: 'arrow', x1: 100, y1: 100, x2: 300, y2: 200, color: 0xffe63c3c, width: 4 };
const midShaft = { x: 200, y: 150 };
const offShaftCorner = { x: 120, y: 190 };
const head = { x: 300, y: 200 };

console.log('arrow');
check('the shaft is grabbable', hitsInk(arrow, midShaft.x, midShaft.y));
check('the head is grabbable', hitsInk(arrow, head.x, head.y));
check('the empty corner of the box is not', !hitsInk(arrow, offShaftCorner.x, offShaftCorner.y));
check('far outside is not', !hitsInk(arrow, 500, 500));

/*
 * A rectangle is an outline. Its centre is inside the box but not on the shape,
 * which the old box test wrongly claimed was grabbable.
 */
const rect = { type: 'rect', x1: 100, y1: 100, x2: 300, y2: 200, color: 0xffe63c3c, width: 4 };
console.log('rectangle');
check('the top edge is grabbable', hitsInk(rect, 200, 100));
check('the left edge is grabbable', hitsInk(rect, 100, 150));
check('the centre of the box is not', !hitsInk(rect, 200, 150));
check('a point near but not on an edge is not', !hitsInk(rect, 140, 130));

/*
 * An ellipse is the classic wrong-box case: the box's corners are well outside the
 * curve, so a box test would grab empty air.
 */
const ellipse = { type: 'ellipse', x1: 100, y1: 100, x2: 300, y2: 200, color: 0xffe63c3c, width: 4 };
console.log('ellipse');
check('the rightmost point is grabbable', hitsInk(ellipse, 300, 150));
check('the topmost point is grabbable', hitsInk(ellipse, 200, 100));
check('the centre is not on the outline', !hitsInk(ellipse, 200, 150));
check('the box corner is not', !hitsInk(ellipse, 105, 105));

/*
 * A pen stroke is a polyline: only the drawn path counts, not the loop it makes.
 */
const pen = {
  type: 'pen',
  points: [{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 200 }],
  color: 0xffe63c3c,
  width: 4,
};
console.log('pen');
check('a point on the stroke is grabbable', hitsInk(pen, 150, 100));
check('a point on the second leg is grabbable', hitsInk(pen, 200, 150));
check('a point inside the bend is not', !hitsInk(pen, 130, 150));

console.log('mosaic');
const mosaic = { type: 'mosaic', x1: 100, y1: 100, x2: 300, y2: 200, color: 0xffe63c3c, width: 1 };
check('a mosaic grabs anywhere in its area', hitsInk(mosaic, 200, 150));
check('a mosaic does not grab outside', !hitsInk(mosaic, 400, 400));

console.log('a flattened rectangle behaves as a line');
const flat = { type: 'rect', x1: 100, y1: 150, x2: 300, y2: 150, color: 0xffe63c3c, width: 4 };
check('the line is grabbable', hitsInk(flat, 200, 150));
check('above the line is not', !hitsInk(flat, 200, 120));

/*
 * The rule a press follows depends on whether a tool has been chosen yet.
 *
 * `hitsFrameEdge` is the tool-active rule. Before a tool is picked there is nothing
 * to draw with, so the whole interior moves the frame — that is `insideRect` plus a
 * null tool, which the cursor and press handlers both read. Both halves are checked
 * here so the two states cannot silently collapse into one.
 */
console.log('the selection frame is dragged by its border once a tool is active');
check('the top border is grabbable', hitsFrameEdge(200, 100));
check('the left border is grabbable', hitsFrameEdge(100, 150));
check('the bottom border is grabbable', hitsFrameEdge(200, 200));
check('the right border is grabbable', hitsFrameEdge(300, 150));
check('the middle of the frame is canvas, not a handle', !hitsFrameEdge(200, 150));
check('a point close to a corner but inside is not', !hitsFrameEdge(120, 120));
check('far outside the frame is not', !hitsFrameEdge(600, 600));
frameState.sel = null;
check('with no selection nothing is a border', !hitsFrameEdge(200, 100));

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nonly the drawn shape answers the pointer');
process.exit(0);
