/**
 * Shared gate for tests that take over the real desktop.
 *
 * A dozen suites drive the native overlay with synthetic mouse and keyboard input:
 * they move your cursor, open a full-screen window, and steal focus. That is the only
 * way to test the real window behaviour, but it also means running them while you are
 * using the machine fights you for the pointer.
 *
 * So they are opt-in. Import this module at the top of such a suite; it exits quietly
 * unless `DSH_SCREENSHOT_UI_TESTS=1` is set. `pnpm test` / `tests/smoke.mjs` stay deterministic
 * and never touch the desktop.
 *
 *     # the fast, non-intrusive suites
 *     node tests/smoke.mjs
 *
 *     # the ones that need the desktop to themselves
 *     $env:DSH_SCREENSHOT_UI_TESTS=1; node tests/clipboard.mjs
 */
const enabled = process.env.DSH_SCREENSHOT_UI_TESTS === '1';

if (!enabled) {
  console.log('skipped: this suite drives the real desktop (cursor, focus, full-screen window).');
  console.log('         set DSH_SCREENSHOT_UI_TESTS=1 to run it when the machine is free.');
  // Exit 0: skipping is not a failure, and CI without a desktop must not go red.
  process.exit(0);
}

export const DESKTOP_TESTS_ENABLED = true;
