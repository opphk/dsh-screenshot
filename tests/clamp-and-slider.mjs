/**
 * Checks that annotations stay inside the frame, and that the style slider is
 * continuous rather than stepped.
 *
 * Two separate reports are covered:
 *
 *   1. An annotation could be dragged past the frame's edge and was painted on the
 *      dimmed desktop — visible on screen, absent from the saved image. The clamp
 *      and the clip both have to hold for that to stop.
 *   2. The stroke-width slider moved in visible jumps, because the width was
 *      rounded to a whole pixel: 118 px of track over 12 values is ~10 px per step.
 *
 * The clamp is exercised through the shipped function; the slider through the same
 * `widthFromSliderX` the pointer uses.
 *
 *     node tests/style-and-clamp.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const source = readFileSync(join(root, 'lib', 'overlay.js'), 'utf8');

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}${detail}`);
  else { console.log(`  FAIL ${name}${detail}`); failures += 1; }
};

/** Pull one top-level function out of the source by name. */
function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found in overlay.js`);
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

const state = { sel: { x: 100, y: 100, w: 300, h: 200 } };
const harness = new Function('screenWidth', 'screenHeight', 'state', `
  ${extractFunction('annotationBounds')}
  ${extractFunction('clampAnnotationDelta')}
  function measureText(text, size) { return String(text).length * size * 0.6; }
  return { clampAnnotationDelta, annotationBounds };
`);
const { clampAnnotationDelta } = harness(1366, 768, state);

const rect = { type: 'rect', x1: 150, y1: 150, x2: 250, y2: 220, color: 0xffe63c3c, width: 4 };

console.log('an annotation cannot be dragged out of the frame');
// A press far to the left and above: the delta must stop at the frame's corner.
const farLeft = clampAnnotationDelta(rect, -1000, -1000);
check('a huge negative delta is clamped', farLeft.dx > -1000 && farLeft.dy > -1000,
  ` — dx ${farLeft.dx}, dy ${farLeft.dy}`);
check('it lands against the frame corner', Math.abs((150 + farLeft.dx) - 100) <= 2
  && Math.abs((150 + farLeft.dy) - 100) <= 2, ` — dx ${farLeft.dx}, dy ${farLeft.dy}`);

const farRight = clampAnnotationDelta(rect, 1000, 1000);
check('a huge positive delta is clamped', farRight.dx < 1000 && farRight.dy < 1000,
  ` — dx ${farRight.dx}, dy ${farRight.dy}`);
// The shape's right edge must not pass the frame's right edge (100 + 300 = 400).
check('the right edge stops at the frame', Math.abs((250 + farRight.dx) - 400) <= 2,
  ` — right edge at ${250 + farRight.dx}`);
check('the bottom edge stops at the frame', Math.abs((220 + farRight.dy) - 300) <= 2,
  ` — bottom edge at ${220 + farRight.dy}`);

console.log('a small delta inside the frame is passed through unchanged');
const small = clampAnnotationDelta(rect, 10, 10);
check('a legal move is not altered', small.dx === 10 && small.dy === 10, ` — dx ${small.dx}, dy ${small.dy}`);

console.log('a shape larger than the frame is pinned, not shuttled');
const huge = { type: 'rect', x1: 0, y1: 0, x2: 900, y2: 900, color: 0xffe63c3c, width: 4 };
const hugeDelta = clampAnnotationDelta(huge, 50, 50);
check('the clamp stays finite for an oversized shape',
  Number.isFinite(hugeDelta.dx) && Number.isFinite(hugeDelta.dy),
  ` — dx ${hugeDelta.dx}, dy ${hugeDelta.dy}`);

/*
 * The slider.
 *
 * The rounding that caused the jumping is gone if two pointer positions one pixel
 * apart produce different widths — with integers, ten such positions produced the
 * same number and the knob could not be placed between them.
 */
const sliderHarness = new Function(`
  const STROKE_MIN = 1;
  const STROKE_MAX = 12;
  const SLIDER_TRACK = 118;
  const SLIDER_KNOB_RADIUS = 7;
  const SLIDER_BAND = 30;
  const PEN_COLORS = [1, 2, 3, 4, 5];
  function stylePopupRect() { return { x: 0, y: 0, w: 200, h: 72 }; }
  ${extractFunction('sliderTrack')}
  ${extractFunction('widthFromSliderX')}
  ${extractFunction('sliderXFromWidth')}
  return { widthFromSliderX, sliderXFromWidth, sliderTrack };
`);
const slider = sliderHarness();
const track = slider.sliderTrack();

console.log('the stroke-width slider is continuous');
const samples = [];
for (let x = track.left; x <= track.right; x += 1) samples.push(slider.widthFromSliderX(x));
const distinct = new Set(samples.map((value) => value.toFixed(4))).size;
console.log(`  ${samples.length} pointer positions produced ${distinct} distinct widths`);
// 118 px of track must yield roughly 118 distinct widths, not 12.
check('every pixel of the track is a distinct width', distinct > samples.length * 0.9,
  ` — ${distinct} of ${samples.length}`);

const adjacent = Math.abs(samples[40] - samples[41]);
check('adjacent pixels differ by less than half a step', adjacent < 0.5,
  ` — ${adjacent.toFixed(4)}`);

console.log('the slider round-trips');
const midWidth = slider.widthFromSliderX((track.left + track.right) / 2);
const backX = slider.sliderXFromWidth(midWidth);
check('a width maps back to where it came from',
  Math.abs(backX - (track.left + track.right) / 2) < 1.5,
  ` — ${backX.toFixed(1)} vs ${((track.left + track.right) / 2).toFixed(1)}`);

/*
 * Clipping is module state applied inside `withGraphics`, not a call made at the
 * draw site. That distinction is the whole bug: an early version set a GDI+ clip
 * on one graphics object, but every drawing helper opens its own, so the clip had
 * no effect and ink still spilled across the frame.
 */
console.log('the frame clip reaches every drawing helper');
check('a module-level clip exists', /let clipRect = null;/.test(source));
check('withGraphics applies the clip', /if \(clipRect !== null\) \{\s*\n\s*gdip\.GdipSetClipRectI/.test(source));
check('the clip accounts for the export origin',
  /clipRect\.x \+ drawOriginX/.test(source) && /clipRect\.y \+ drawOriginY/.test(source));
check('the clip covers annotations and the draft',
  /clipRect = sel !== null && sel\.w > 0[\s\S]{0,400}for \(const item of state\.annots\) drawAnnotation[\s\S]{0,200}state\.draft !== null\) drawAnnotation/.test(source));
check('the picked-annotation frame is drawn outside the clip',
  /\} finally \{\s*\n\s*clipRect = previousClip;\s*\n\s*\}[\s\S]{0,400}drawAnnotationFrame/.test(source));

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nannotations stay inside the frame, and the slider is smooth');
process.exit(0);
