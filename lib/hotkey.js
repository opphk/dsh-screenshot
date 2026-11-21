/**
 * A Windows-wide hotkey listener.
 *
 * The browser half can only see keystrokes while its own page has focus, so a
 * "global" shortcut has to be registered with the operating system instead. The Host
 * half runs under `ELECTRON_RUN_AS_NODE` (`process.versions.electron` is undefined),
 * so Electron's `globalShortcut` is not available; this goes straight to Win32.
 *
 * `RegisterHotKey` needs a thread with a message queue, and the Harness's own thread
 * must not be blocked by a pump. This module therefore runs in its own child process:
 * it creates a message-only window, registers the combination, pumps messages, and
 * reports each press on stdout. The parent decides what a press means.
 *
 * Protocol (one line per event on stdout):
 *   ready            the hotkey is registered and the pump is running
 *   press            the hotkey fired
 *   error <message>  registration or setup failed; the process is exiting
 *
 * Invoked as: node hotkey.js <accelerator>
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the `koffi` build that ships with the running Harness.
 *
 * Mirrors `lib/overlay.js`: the module lives inside `app.asar`, whose native addons
 * are unpacked beside it, so several locations have to be tried.
 */
function resolveKoffi() {
  const candidates = [];
  const installDir = process.env.DSH_INSTALL_DIR ?? '';
  if (installDir !== '') {
    const modules = dirname(dirname(installDir));
    candidates.push(join(modules, 'koffi'));
    candidates.push(join(modules.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`), 'koffi'));
  }
  candidates.push(join(here, '..', 'node_modules', 'koffi'));
  candidates.push(join(dirname(process.execPath), 'resources', 'app.asar.unpacked', 'dsh', 'node_modules', 'koffi'));
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

/** Modifier flags for `RegisterHotKey`. */
const MOD_ALT = 0x0001;
const MOD_CONTROL = 0x0002;
const MOD_SHIFT = 0x0004;
const MOD_WIN = 0x0008;
/** Stops the combination from repeating while held: one press, one screenshot. */
const MOD_NOREPEAT = 0x4000;

const WM_HOTKEY = 0x0312;
const PM_REMOVE = 0x0001;

/** The one hotkey id this process registers. */
const HOTKEY_ID = 0xB10;

/**
 * Keys whose virtual-key code is not simply the upper-case letter.
 *
 * Everything else falls back to the ASCII code, which is correct for A-Z, 0-9 and
 * the function keys F1-F24 (0x70 onward).
 */
const NAMED_KEYS = {
  space: 0x20,
  tab: 0x09,
  enter: 0x0d,
  return: 0x0d,
  escape: 0x1b,
  esc: 0x1b,
  backspace: 0x08,
  delete: 0x2e,
  insert: 0x2d,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pagedown: 0x22,
  arrowup: 0x26,
  arrowdown: 0x28,
  arrowleft: 0x25,
  arrowright: 0x27,
  up: 0x26,
  down: 0x28,
  left: 0x25,
  right: 0x27,
  '-': 0xbd,
  '=': 0xbb,
  ',': 0xbc,
  '.': 0xbe,
  '/': 0xbf,
  ';': 0xba,
  '\'': 0xde,
  '[': 0xdb,
  ']': 0xdd,
  '\\': 0xdc,
  '`': 0xc0,
};

/**
 * Turn an accelerator like `ctrl+alt+q` into `RegisterHotKey` arguments.
 *
 * @param {string} accelerator the configured shortcut
 * @returns {{ modifiers: number, vk: number } | null} null when it cannot be mapped
 */
export function toHotkey(accelerator) {
  const parts = String(accelerator ?? '').toLowerCase().split('+').map((part) => part.trim()).filter((part) => part !== '');
  if (parts.length === 0) return null;

  let modifiers = MOD_NOREPEAT;
  let vk = null;
  for (const part of parts) {
    if (part === 'ctrl' || part === 'control') modifiers |= MOD_CONTROL;
    else if (part === 'alt') modifiers |= MOD_ALT;
    else if (part === 'shift') modifiers |= MOD_SHIFT;
    else if (part === 'meta' || part === 'win' || part === 'super') modifiers |= MOD_WIN;
    else vk = virtualKeyFor(part);
  }
  // A bare key would swallow that key everywhere in Windows.
  if (vk === null) return null;
  if ((modifiers & (MOD_CONTROL | MOD_ALT | MOD_SHIFT | MOD_WIN)) === 0) return null;
  return { modifiers, vk };
}

/**
 * Map one key name to a virtual-key code.
 *
 * @param {string} name lower-case key name, e.g. `q`, `f5`, `space`
 * @returns {number | null}
 */
function virtualKeyFor(name) {
  if (NAMED_KEYS[name] !== undefined) return NAMED_KEYS[name];
  if (/^f([1-9]|1\d|2[0-4])$/.test(name)) return 0x6f + Number(name.slice(1));
  if (/^[a-z]$/.test(name)) return name.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(name)) return name.charCodeAt(0);
  return null;
}

/** Report one protocol line and flush, so the parent sees it immediately. */
function emit(line) {
  process.stdout.write(`${line}\n`);
}

const accelerator = process.argv[2] ?? '';
const mapped = toHotkey(accelerator);
if (mapped === null) {
  emit(`error unsupported accelerator: ${accelerator}`);
  process.exit(3);
}

const koffi = resolveKoffi();
const user32 = koffi.load('user32.dll');

/*
 * Only what the thread-queue design needs: register/release the combination, and read
 * this thread's message queue. There is deliberately no window API here — see the note
 * on `windowHandle` below for why windows were abandoned.
 */
const RegisterHotKey = user32.func('bool __stdcall RegisterHotKey(void *hWnd, int id, uint32_t fsModifiers, uint32_t vk)');
const UnregisterHotKey = user32.func('bool __stdcall UnregisterHotKey(void *hWnd, int id)');
const PeekMessageW = user32.func('bool __stdcall PeekMessageW(void *msg, void *hWnd, uint32_t min, uint32_t max, uint32_t remove)');

/*
 * No window at all: register against the calling thread.
 *
 * `RegisterHotKey(NULL, ...)` posts `WM_HOTKEY` straight to this thread's message
 * queue, which the pump below reads with `PeekMessageW`. That turned out to be the only
 * reliable option here:
 *
 *   - A registered window class produced `CreateWindowExW` returning NULL with
 *     `GetLastError()` still 0, so there was nothing to diagnose.
 *   - The built-in `STATIC` class created a window fine, but a system class keeps its
 *     own window procedure, so this process's handler never saw `WM_HOTKEY` and a press
 *     was posted into a procedure that did not know about it.
 *
 * A thread-queue registration needs neither, and it is exactly what a background
 * shortcut listener wants: one thread, one queue, no window to manage or clean up.
 */
let windowHandle = null;
const className = null;

/*
 * Claim the combination, falling back when Windows says it is taken.
 *
 * `Ctrl+Alt+Q` is a popular binding — chat clients and the text-input service both use
 * combinations in that family — and Windows gives a hotkey to exactly one process, so a
 * single hard-coded default fails on a real machine and the feature looks broken. Rather
 * than making the user hunt for a free combination, walk a short list of equivalents and
 * report which one actually took effect; the page then shows that instead of the
 * preference it asked for.
 */
const FALLBACKS = ['ctrl+alt+q', 'ctrl+alt+shift+q', 'ctrl+alt+f9', 'ctrl+shift+f9', 'ctrl+alt+s'];

let registered = null;
for (const candidate of [accelerator, ...FALLBACKS]) {
  const attempt = candidate === accelerator ? mapped : toHotkey(candidate);
  if (attempt === null) continue;
  if (RegisterHotKey(windowHandle, HOTKEY_ID, attempt.modifiers, attempt.vk)) {
    registered = candidate;
    break;
  }
}

if (registered === null) {
  emit('error no free shortcut (tried ' + [accelerator, ...FALLBACKS].join(', ') + ')');
  process.exit(3);
}

// Report the combination that is actually live, which may differ from the requested one.
if (registered === accelerator) emit('ready');
else emit(`ready ${registered}`);

/** Leave cleanly: release the combination so the next instance can take it. */
function shutdown(code = 0) {
  try {
    UnregisterHotKey(windowHandle, HOTKEY_ID);
  } catch {
    /* already gone */
  }
  try {
    if (windowHandle !== null) DestroyWindow(windowHandle);
  } catch {
    /* already gone */
  }
  try {
    koffi.unregister(wndProc);
  } catch {
    /* already released */
  }
  process.exit(code);
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
// The parent closing the pipe means it is going away; nothing left to serve.
process.stdout.on('error', () => shutdown(0));

/*
 * The pump.
 *
 * `PeekMessage` rather than a blocking `GetMessageW`, for one reason: it lets the loop
 * notice a closed stdin pipe and exit. A blocked `GetMessageW` would leave this
 * process running after the Harness restarts, holding the hotkey so the new instance
 * could not register it.
 *
 * There is no window, so `WM_HOTKEY` is read from the queue instead of being dispatched
 * to a window procedure — `DispatchMessageW` is not needed and would have nothing to
 * dispatch to.
 */
const message = Buffer.alloc(64);
/** `MSG.message` sits at byte 8 on x64, after the 8-byte `hwnd`. */
const MSG_MESSAGE_OFFSET = 8;
let running = true;
process.stdin.on('end', () => { running = false; });
process.stdin.on('close', () => { running = false; });
process.stdin.resume();

/**
 * One pump pass: drain the queue, then yield.
 *
 * The yield is a `setTimeout`, not `kernel32.Sleep`. A synchronous sleep would block
 * Node's event loop for its whole duration, so the `end` handler above could never run
 * and the helper would survive its parent — keeping the combination registered and
 * breaking the next Harness instance. `setTimeout` returns to the loop between passes,
 * which costs nothing here: the queue is checked again a few milliseconds later.
 */
function pump() {
  if (!running) {
    shutdown(0);
    return;
  }
  let pumped = false;
  while (PeekMessageW(message, null, 0, 0, PM_REMOVE)) {
    const kind = message.readUInt32LE(MSG_MESSAGE_OFFSET);
    if (kind === WM_HOTKEY) emit('press');
    pumped = true;
  }
  // Drain fully before yielding: a burst of messages should not add latency.
  setTimeout(pump, pumped ? 0 : 25);
}

pump();
