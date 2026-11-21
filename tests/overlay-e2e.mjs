/**
 * Drives the real native overlay end to end and checks the PNG it produces.
 *
 * The overlay is a window with its own message loop, so this test does what a
 * user would do — post the window real mouse input, press Enter — and then
 * inspects the file. That is the only way to know the drawing, the selection
 * maths and the export all agree.
 *
 * Run with `node tests/overlay-e2e.mjs`.
 */
/*
 * Drives the real desktop: this suite moves the cursor, opens a full-screen window
 * and takes focus, so it only runs when DSH_SCREENSHOT_UI_TESTS=1.
 */
import './_desktop-gate.mjs';

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const require = createRequire(import.meta.url);

function resolveKoffi() {
  const candidates = [];
  const installDir = process.env.DSH_INSTALL_DIR ?? '';
  if (installDir !== '') {
    const modules = dirname(dirname(installDir));
    candidates.push(join(modules, 'koffi'));
    candidates.push(join(modules.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`), 'koffi'));
  }
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

const koffi = resolveKoffi();
const user32 = koffi.load('user32.dll');
const FindWindowW = user32.func('void * __stdcall FindWindowW(void *className, void *windowName)');
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(void *hWnd, _Out_ int *rect)');
const SendMessageW = user32.func('intptr_t __stdcall SendMessageW(void *hWnd, uint32_t msg, uintptr_t wParam, intptr_t lParam)');
const PostMessageW = user32.func('bool __stdcall PostMessageW(void *hWnd, uint32_t msg, uintptr_t w, intptr_t l)');
const SetCursorPos = user32.func('bool __stdcall SetCursorPos(int x, int y)');
const mouse_event = user32.func('void __stdcall mouse_event(uint32_t flags, int dx, int dy, uint32_t data, uintptr_t extra)');
const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(void *hWnd)');

const toW = (text) => Buffer.from(`${text}\0`, 'utf16le');

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`);
}

const output = join(process.env.TEMP ?? root, 'dsh-screenshot-e2e.png');
if (existsSync(output)) unlinkSync(output);

const child = spawn(
  process.execPath,
  [join(root, 'lib', 'overlay.js'), output, '--include-self'],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
let stderr = '';
child.stderr.on('data', (chunk) => {
  stderr += String(chunk);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Wait for the window to appear.
let hwnd = null;
for (let attempt = 0; attempt < 100; attempt += 1) {
  hwnd = FindWindowW(toW('DshScreenshotOverlay'), null);
  if (hwnd !== null && hwnd !== undefined) break;
  await sleep(50);
}

console.log('window');
check('the overlay window exists', hwnd !== null && hwnd !== undefined, stderr.trim());

if (hwnd !== null && hwnd !== undefined) {
  const rect = [0, 0, 0, 0];
  GetWindowRect(hwnd, rect);
  const width = rect[2] - rect[0];
  const height = rect[3] - rect[1];
  console.log(`  size ${width} x ${height}`);
  check('it covers the screen', width >= 1000 && height >= 600, `${width}x${height}`);

  SetForegroundWindow(hwnd);
  await sleep(120);

  // Drive it with real cursor input rather than posted messages: once the window
  // captures the mouse, Windows keeps delivering the physical pointer position,
  // which overwrites any synthetic coordinates. Real input is also what the user
  // produces, so this is the honest test.
  const MOUSEEVENTF_LEFTDOWN = 0x0002;
  const MOUSEEVENTF_LEFTUP = 0x0004;

  const drag = async (fromX, fromY, toX, toY) => {
    SetCursorPos(fromX, fromY);
    await sleep(90);
    mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
    await sleep(90);
    // Move in steps so the window sees a drag, not a jump.
    const steps = 8;
    for (let step = 1; step <= steps; step += 1) {
      SetCursorPos(
        Math.round(fromX + ((toX - fromX) * step) / steps),
        Math.round(fromY + ((toY - fromY) * step) / steps),
      );
      await sleep(25);
    }
    await sleep(60);
    mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
    await sleep(120);
  };

  await drag(200, 150, 700, 450);

  console.log('interaction');
  check('the overlay is still running after the drag', child.exitCode === null, `exited ${String(child.exitCode)}`);

  // Confirm with Enter.
  PostMessageW(hwnd, 0x0100 /* WM_KEYDOWN */, BigInt(0x0d /* VK_RETURN */), 0n);
  await sleep(500);
}

const exited = await new Promise((resolve) => {
  if (child.exitCode !== null) {
    resolve(child.exitCode);
    return;
  }
  const timer = setTimeout(() => resolve('timeout'), 8000);
  child.on('exit', (code) => {
    clearTimeout(timer);
    resolve(code);
  });
});

console.log('result');
check('the overlay exited successfully', exited === 0, `exit ${String(exited)} ${stderr.trim()}`);
check('it produced a PNG', existsSync(output));

if (existsSync(output)) {
  const png = readFileSync(output);
  const isPng = png.length > 8 && png.subarray(1, 4).toString('ascii') === 'PNG';
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  console.log(`  png ${width} x ${height}, ${png.length} bytes`);
  check('the file is a valid PNG', isPng);
  // The drag covered 500x300 in window coordinates.
  check('the PNG matches the dragged region', Math.abs(width - 500) <= 3 && Math.abs(height - 300) <= 3, `${width}x${height}`);
  check('the PNG is not the whole screen', width < 1300 || height < 700, `${width}x${height}`);
  unlinkSync(output);
}

if (child.exitCode === null) child.kill();
console.log('');
if (failures > 0) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('the native overlay works end to end');
