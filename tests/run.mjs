/**
 * Test runner with two clearly separated tiers.
 *
 * The suites fall into two groups, and mixing them was the problem: a dozen of them
 * drive the native overlay with real synthetic input, which moves the cursor, opens a
 * full-screen window and takes focus. Running those while you are using the machine
 * fights you for the pointer.
 *
 * So:
 *
 *   node tests/run.mjs           # safe: no cursor, no windows, no focus changes
 *   node tests/run.mjs --ui      # also the desktop suites; run when the machine is free
 *
 * A single suite can be run directly as before (`node tests/smoke.mjs`); the desktop
 * ones self-skip unless `DSH_SCREENSHOT_UI_TESTS=1` is set, so even a mistaken direct run
 * cannot hijack the pointer.
 */
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Suites that never touch the desktop: they read source, drive pure functions, or use
 * an offscreen render. These are safe at any time and are the default.
 */
const SAFE = [
    'smoke.mjs',
    'hotkey.mjs',
    'selection.mjs',
    'hit-testing.mjs',
    'clamp-and-slider.mjs',
    'ffi-resolution.mjs',
    'text-editing.mjs',
];

/**
 * Suites that take over the desktop: they move the cursor and/or open a full-screen
 * window. Run with `--ui` only when nothing else needs the pointer.
 */
const DESKTOP = [
    'overlay-e2e.mjs',
];

const wantDesktop = process.argv.includes('--ui');

/** Run one suite, streaming nothing and returning its outcome. */
function runSuite(name) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [join(here, name)], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                // The desktop suites self-skip without this; setting it here is what
                // makes `--ui` actually run them.
                DSH_SCREENSHOT_UI_TESTS: wantDesktop ? '1' : '0',
            },
        });
        let output = '';
        child.stdout.on('data', (chunk) => { output += String(chunk); });
        child.stderr.on('data', (chunk) => { output += String(chunk); });
        child.on('close', (code) => resolve({ name, code, output }));
    });
}

const planned = wantDesktop ? [...SAFE, ...DESKTOP] : SAFE;

// Fail loudly if a listed file does not exist, rather than silently running fewer tests.
const present = new Set(await readdir(here));
const missing = planned.filter((name) => !present.has(name));
if (missing.length > 0) {
    console.error(`missing test files: ${missing.join(', ')}`);
    process.exit(1);
}

console.log(`running ${planned.length} suite(s)${wantDesktop ? ' including desktop suites' : ' (safe tier)'}`);
if (wantDesktop) {
    console.log('note: the desktop suites move the cursor and take focus.');
}

const failures = [];
for (const name of planned) {
    const started = Date.now();
    const result = await runSuite(name);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const skipped = /^skipped:/m.test(result.output);
    if (result.code === 0) {
        console.log(`  ok   ${name}${skipped ? ' (skipped)' : ` (${seconds}s)`}`);
    } else {
        console.log(`  FAIL ${name} (${seconds}s)`);
        // Show only the failing lines; the full output of a passing suite is noise.
        for (const line of result.output.split('\n')) {
            if (/FAIL|Error|error:/.test(line)) console.log(`       ${line.trim()}`);
        }
        failures.push(name);
    }
}

if (failures.length > 0) {
    console.log(`\n${failures.length} suite(s) failed: ${failures.join(', ')}`);
    process.exit(1);
}
console.log(`\nall ${planned.length} suite(s) passed`);
process.exit(0);
