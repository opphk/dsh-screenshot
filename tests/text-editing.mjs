/**
 * Exercises the text editor's key map — the reported "can't select all".
 *
 * The text being typed used to handle only Enter, Escape and Backspace, by hand.
 * Every other key fell through to the overlay's shortcuts, so `Ctrl+A` did nothing,
 * arrow keys nudged the selection *frame*, and Backspace cut the last character no
 * matter where the caret was.
 *
 * These checks drive the shipped `handleTextKey` through a small edit session, so
 * the behaviour is tested rather than the source text: select all, type over it,
 * move by arrows, extend with Shift, delete by word.
 *
 *     node tests/text-editing.mjs
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

/*
 * The virtual-key constants `handleTextKey` refers to. Taken as named parameters so
 * the extracted function closes over real numbers rather than globals that would be
 * undefined in this context.
 */
const harness = new Function('VK_BACK', 'VK_DELETE', 'VK_LEFT', 'VK_RIGHT', 'VK_HOME', 'VK_END', `
  ${extractFunction('selectionMin')}
  ${extractFunction('selectionMax')}
  ${extractFunction('hasTextSelection')}
  ${extractFunction('replaceTextSelection')}
  ${extractFunction('replaceTextSelectionWithoutMove')}
  ${extractFunction('handleTextKey')}
  return {
    handleTextKey, replaceTextSelection, selectionMin, selectionMax, hasTextSelection,
  };
`);
const api = harness(0x08, 0x2e, 0x25, 0x27, 0x24, 0x23);

const VK_A = 0x41;
const VK_BACK = 0x08;
const VK_DELETE = 0x2e;
const VK_LEFT = 0x25;
const VK_RIGHT = 0x27;
const VK_HOME = 0x24;
const VK_END = 0x23;

/** A fresh pending-text state holding `value`, caret at the end. */
function makeText(value) {
  return { x: 100, y: 100, value, anchor: value.length, cursor: value.length };
}

console.log('Ctrl+A selects everything');
const all = makeText('HELLO');
check('the key is consumed', api.handleTextKey(all, VK_A, true, false) === true);
check('the whole string is selected', api.selectionMin(all) === 0 && api.selectionMax(all) === 'HELLO'.length,
  ` — ${api.selectionMin(all)}..${api.selectionMax(all)}`);
check('a selection is reported', api.hasTextSelection(all) === true);

console.log('typing over a selection replaces it');
// This is the behaviour that makes select-all worth having.
api.replaceTextSelection(all, 'X');
check('the old text is gone', all.value === 'X', ` — "${all.value}"`);
check('the caret is after the replacement', all.cursor === 1 && all.anchor === 1,
  ` — anchor ${all.anchor}, cursor ${all.cursor}`);
check('nothing is left selected', api.hasTextSelection(all) === false);

console.log('arrows move the insertion point');
const moving = makeText('ABCDE');
api.handleTextKey(moving, VK_LEFT, false, false);
check('left steps back one', moving.cursor === 4, ` — ${moving.cursor}`);
api.handleTextKey(moving, VK_HOME, false, false);
check('Home goes to the start', moving.cursor === 0, ` — ${moving.cursor}`);
api.handleTextKey(moving, VK_END, false, false);
check('End goes to the end', moving.cursor === 5, ` — ${moving.cursor}`);
api.handleTextKey(moving, VK_LEFT, false, false);
api.handleTextKey(moving, VK_LEFT, false, false);
check('repeated left keeps stepping', moving.cursor === 3, ` — ${moving.cursor}`);

console.log('Shift+arrows extend a selection');
const extending = makeText('ABCDE');
api.handleTextKey(extending, VK_HOME, false, false);
api.handleTextKey(extending, VK_RIGHT, false, true);
api.handleTextKey(extending, VK_RIGHT, false, true);
check('two shifts select two characters',
  api.selectionMin(extending) === 0 && api.selectionMax(extending) === 2,
  ` — ${api.selectionMin(extending)}..${api.selectionMax(extending)}`);
check('the anchor stays put', extending.anchor === 0, ` — anchor ${extending.anchor}`);

console.log('a bare arrow collapses the selection');
api.handleTextKey(extending, VK_RIGHT, false, false);
check('the selection is gone', api.hasTextSelection(extending) === false);
check('the caret lands on the far edge', extending.cursor === 2, ` — ${extending.cursor}`);

console.log('Backspace deletes at the caret, not at the end');
const back = makeText('ABCDE');
// Caret between B and C: "A|B|CDE" style, index 2.
back.cursor = 2;
back.anchor = 2;
api.handleTextKey(back, VK_BACK, false, false);
// The character *before* index 2 is B, so "ABCDE" becomes "ACDE".
check('the character before the caret goes', back.value === 'ACDE', ` — "${back.value}"`);
check('the caret moves back by one', back.cursor === 1, ` — ${back.cursor}`);

console.log('Backspace over a selection deletes the selection');
const backSel = makeText('ABCDE');
backSel.anchor = 1;
backSel.cursor = 4;
api.handleTextKey(backSel, VK_BACK, false, false);
check('only the selected part goes', backSel.value === 'AE', ` — "${backSel.value}"`);
check('the caret sits at the cut', backSel.cursor === 1, ` — ${backSel.cursor}`);

console.log('Delete removes forward');
const del = makeText('ABCDE');
del.cursor = 2;
del.anchor = 2;
api.handleTextKey(del, VK_DELETE, false, false);
check('the character after the caret goes', del.value === 'ABDE', ` — "${del.value}"`);

console.log('Ctrl+Backspace deletes a word');
const word = makeText('hello world');
api.handleTextKey(word, VK_BACK, true, false);
check('the last word goes', word.value === 'hello ', ` — "${word.value}"`);
api.handleTextKey(word, VK_BACK, true, false);
check('trailing spaces and the next word go', word.value === '', ` — "${word.value}"`);

console.log('Ctrl+Z is left to the overlay');
const undoKey = makeText('ABC');
check('Ctrl+Z is not consumed by the text', api.handleTextKey(undoKey, 0x5a, true, false) === false);
check('the text is untouched', undoKey.value === 'ABC');

console.log('Enter and Escape are left to the overlay');
const enterKey = makeText('ABC');
check('Enter is not consumed', api.handleTextKey(enterKey, 0x0d, false, false) === false);
check('Escape is not consumed', api.handleTextKey(enterKey, 0x1b, false, false) === false);

console.log('the caret cannot escape the string');
const bounds = makeText('AB');
api.handleTextKey(bounds, VK_LEFT, false, false);
api.handleTextKey(bounds, VK_LEFT, false, false);
api.handleTextKey(bounds, VK_LEFT, false, false);
check('left stops at zero', bounds.cursor === 0, ` — ${bounds.cursor}`);
api.handleTextKey(bounds, VK_END, false, false);
api.handleTextKey(bounds, VK_RIGHT, false, false);
check('right stops at the length', bounds.cursor === 2, ` — ${bounds.cursor}`);

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\ntext editing behaves like a text field: select all, type over, arrows, ranges');
process.exit(0);
