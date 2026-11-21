/**
 * Checks the selection-adjustment maths: moving the frame, resizing it from each
 * handle, and the clamping that keeps it on screen and non-inverted.
 *
 * These are the rules that decide what the user's drag actually does, so they are
 * lifted out of `lib/overlay.js` and exercised directly rather than trusted.
 *
 * Run with `node tests/selection.mjs`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'lib', 'overlay.js'), 'utf8');

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`);
}

/** Pull a named function out of the shipping file and evaluate it. */
function lift(name) {
  const pattern = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`);
  const match = source.match(pattern);
  if (match === null) {
    console.error(`cannot find ${name} in lib/overlay.js`);
    process.exit(1);
  }
  return match[0];
}

const screenWidth = 1000;
const screenHeight = 800;
const factory = new Function(
  'screenWidth', 'screenHeight',
  `${lift('handlePoint')}
   ${lift('hitHandle')}
   ${lift('insideRect')}
   ${lift('resizeRect')}
   ${lift('moveRect')}
   const HANDLE_RADIUS = 7;
   const HANDLES = ['nw','n','ne','e','se','s','sw','w'];
   return { handlePoint, hitHandle, insideRect, resizeRect, moveRect, HANDLES };`,
);
const { handlePoint, hitHandle, insideRect, resizeRect, moveRect, HANDLES } = factory(screenWidth, screenHeight);

const base = { x: 100, y: 100, w: 300, h: 200 };

console.log('handles');
check('there are eight', HANDLES.length === 8);
check('nw sits at the top-left corner', JSON.stringify(handlePoint(base, 'nw')) === JSON.stringify({ x: 100, y: 100 }));
check('se sits at the bottom-right corner', JSON.stringify(handlePoint(base, 'se')) === JSON.stringify({ x: 400, y: 300 }));
check('n sits at the top edge centre', JSON.stringify(handlePoint(base, 'n')) === JSON.stringify({ x: 250, y: 100 }));
check('w sits at the left edge centre', JSON.stringify(handlePoint(base, 'w')) === JSON.stringify({ x: 100, y: 200 }));

console.log('hit testing');
check('the corner is grabbable', hitHandle(100, 100, base) === 'nw');
check('a point near but not on a handle misses', hitHandle(140, 140, base) === null);
check('the middle of an edge is grabbable', hitHandle(250, 100, base) === 'n');
check('the inside is not a handle', hitHandle(250, 200, base) === null);
check('insideRect agrees', insideRect(250, 200, base) === true && insideRect(50, 50, base) === false);

console.log('moving');
check('a move translates the rectangle', (() => {
  const moved = moveRect(base, 40, -30);
  return moved.x === 140 && moved.y === 70 && moved.w === 300 && moved.h === 200;
})());
check('a move cannot leave the left edge', moveRect(base, -500, 0).x === 0);
check('a move cannot leave the right edge', moveRect(base, 5000, 0).x === screenWidth - base.w);
check('a move cannot leave the bottom', moveRect(base, 0, 5000).y === screenHeight - base.h);
check('a move keeps the size', (() => {
  const moved = moveRect(base, -500, -500);
  return moved.w === base.w && moved.h === base.h;
})());

console.log('resizing by handle');
check('east changes the width only', (() => {
  const r = resizeRect(base, 'e', 500, 999);
  return r.x === 100 && r.y === 100 && r.w === 400 && r.h === 200;
})());
check('south changes the height only', (() => {
  const r = resizeRect(base, 's', 1, 400);
  return r.x === 100 && r.y === 100 && r.w === 300 && r.h === 300;
})());
check('west moves the left edge and keeps the right one', (() => {
  const r = resizeRect(base, 'w', 40, 200);
  return r.x === 40 && r.x + r.w === 400;
})());
check('north moves the top edge and keeps the bottom one', (() => {
  const r = resizeRect(base, 'n', 250, 30);
  return r.y === 30 && r.y + r.h === 300;
})());
check('the south-east corner changes both axes', (() => {
  const r = resizeRect(base, 'se', 500, 400);
  return r.w === 400 && r.h === 300;
})());
check('the north-west corner changes both axes', (() => {
  const r = resizeRect(base, 'nw', 50, 60);
  return r.x === 50 && r.y === 60 && r.x + r.w === 400 && r.y + r.h === 300;
})());

console.log('resize clamps');
check('a handle cannot invert the rectangle', (() => {
  const r = resizeRect(base, 'w', 9999, 200);
  return r.w >= 8 && r.x + r.w === 400;
})());
check('a handle cannot drag the left edge off screen', resizeRect(base, 'w', -300, 200).x === 0);
check('a handle cannot drag the top edge off screen', resizeRect(base, 'n', 250, -300).y === 0);
check('a handle cannot exceed the screen width', (() => {
  const r = resizeRect(base, 'e', 99999, 200);
  return r.x + r.w <= screenWidth;
})());
check('a handle cannot exceed the screen height', (() => {
  const r = resizeRect(base, 's', 250, 99999);
  return r.y + r.h <= screenHeight;
})());

console.log('axis independence');
check('resizing one axis leaves the other untouched', (() => {
  const r = resizeRect(base, 'e', 350, 100);
  return r.y === base.y && r.h === base.h;
})());

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nthe selection can be moved and resized independently');
