/**
 * Behavioural checks for the shortcut matcher. The client half is a browser
 * module, so the parser is lifted out of `client.js` verbatim and exercised
 * here rather than re-described: a passing copy would prove nothing.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(join(root, 'client.js'), 'utf8');

function lift(pattern, name) {
  const match = source.match(pattern);
  if (match === null) {
    console.error(`cannot find ${name} in client.js`);
    process.exit(1);
  }
  return match[0];
}

const pieces = [
  lift(/const HOTKEY_MODIFIERS = \[[^\]]*\];/, 'HOTKEY_MODIFIERS'),
  lift(/const HOTKEY_KEY_LABEL = \{[^}]*\};/, 'HOTKEY_KEY_LABEL'),
  lift(/const MODIFIER_LABELS = \{[^}]*\};/, 'MODIFIER_LABELS'),
  lift(/function parseHotkey\(value\) \{[\s\S]*?\n    \}/, 'parseHotkey'),
  lift(/function formatHotkey\(value\) \{[\s\S]*?\n    \}/, 'formatHotkey'),
  lift(/function keyOfEvent\(event\) \{[\s\S]*?\n    \}/, 'keyOfEvent'),
];

const factory = new Function(`${pieces.join('\n')}\nreturn { parseHotkey, formatHotkey, keyOfEvent };`);
const { parseHotkey, formatHotkey, keyOfEvent } = factory();

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
}

/** Build a keyboard event shaped the way the browser reports it. */
function key(init) {
  return { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, code: '', key: '', ...init };
}

console.log('parse');
check('default parses', parseHotkey('ctrl+alt+a') !== null, true);
check('order does not matter', parseHotkey('alt+ctrl+a'), parseHotkey('ctrl+alt+a'));
check('bare key is refused', parseHotkey('a'), null);
check('empty is refused', parseHotkey(''), null);
check('missing key is refused', parseHotkey('ctrl+alt'), null);

console.log('format');
check('default label', formatHotkey('ctrl+alt+a'), 'Ctrl+Alt+A');
check('shift before key', formatHotkey('shift+ctrl+s'), 'Ctrl+Shift+S');
check('function key', formatHotkey('ctrl+alt+f5'), 'Ctrl+Alt+F5');
check('digit', formatHotkey('ctrl+shift+1'), 'Ctrl+Shift+1');

console.log('keyOfEvent');
check('letter by code', keyOfEvent(key({ code: 'KeyA', key: 'a' })), 'a');
check('letter device independent', keyOfEvent(key({ code: 'KeyA', key: 'ф' })), 'a');
check('digit', keyOfEvent(key({ code: 'Digit1', key: '1' })), '1');
check('function key', keyOfEvent(key({ code: 'F5', key: 'F5' })), 'f5');

/** Mirror of hotkey.matches, with the stored value injected. */
function matches(stored, event) {
  const parsed = parseHotkey(stored);
  if (parsed === null) return false;
  if (event.ctrlKey === true !== parsed.modifiers.has('ctrl')) return false;
  if (event.altKey === true !== parsed.modifiers.has('alt')) return false;
  if (event.shiftKey === true !== parsed.modifiers.has('shift')) return false;
  if (event.metaKey === true !== parsed.modifiers.has('meta')) return false;
  return keyOfEvent(event) === parsed.key;
}

console.log('match');
check('default fires on Ctrl+Alt+A', matches('ctrl+alt+a', key({ ctrlKey: true, altKey: true, code: 'KeyA', key: 'a' })), true);
check('default ignores plain A', matches('ctrl+alt+a', key({ code: 'KeyA', key: 'a' })), false);
check('default ignores Ctrl+A', matches('ctrl+alt+a', key({ ctrlKey: true, code: 'KeyA', key: 'a' })), false);
check('default ignores extra Shift', matches('ctrl+alt+a', key({ ctrlKey: true, altKey: true, shiftKey: true, code: 'KeyA', key: 'a' })), false);
check('default ignores another key', matches('ctrl+alt+a', key({ ctrlKey: true, altKey: true, code: 'KeyS', key: 's' })), false);
check('custom fires', matches('ctrl+shift+s', key({ ctrlKey: true, shiftKey: true, code: 'KeyS', key: 's' })), true);
check('custom rejects the old chord', matches('ctrl+shift+s', key({ ctrlKey: true, altKey: true, code: 'KeyA', key: 'a' })), false);
check('function key fires', matches('ctrl+alt+f5', key({ ctrlKey: true, altKey: true, code: 'F5', key: 'F5' })), true);
check('shift-only chord fires', matches('shift+f9', key({ shiftKey: true, code: 'F9', key: 'F9' })), true);

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall shortcut checks passed');
