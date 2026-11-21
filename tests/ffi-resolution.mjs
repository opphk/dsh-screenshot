/**
 * Guards the failure that once made the plugin feel slow and broken: the FFI it
 * needs is bundled with the dsh installation, not with the profile, and the
 * lookup depended on `DSH_INSTALL_DIR` — which a desktop app started from a
 * shortcut does not have. Resolution then quietly fell back to a slow path.
 *
 * This runs the overlay's resolver with and without the environment variable and
 * asserts the FFI is still found, so a plain shortcut launch keeps working.
 *
 * Run with `node tests/ffi-resolution.mjs`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The overlay resolves the FFI at import time, so the probe asks it for a version
 * banner instead of importing the whole overlay and opening a window.
 */
function probe(label, env) {
  const script = `
    import('node:fs').then(async ({ existsSync }) => {
      const { createRequire } = await import('node:module');
      const { dirname, join, sep } = await import('node:path');
      const require = createRequire(${JSON.stringify(`file:///${root.replace(/\\/g, '/')}/lib/overlay.js`)});
      const here = ${JSON.stringify(`${root.replace(/\\/g, '/')}\\lib`)};
      const candidates = [];
      const installDir = process.env.DSH_INSTALL_DIR ?? '';
      if (installDir !== '') {
        const modules = dirname(dirname(installDir));
        candidates.push(join(modules, 'koffi'));
        candidates.push(join(modules.replace(sep + 'app.asar' + sep, sep + 'app.asar.unpacked' + sep), 'koffi'));
      }
      let cursor = here;
      for (let step = 0; step < 12; step += 1) {
        if (existsSync(join(cursor, 'node_modules', 'koffi'))) { candidates.push(join(cursor, 'node_modules', 'koffi')); break; }
        const parent = dirname(cursor);
        if (parent === cursor) break;
        cursor = parent;
      }
      for (const bin of [process.execPath, process.env.DSH_NODE_EXECUTABLE].filter(Boolean)) {
        const resources = join(dirname(bin), 'resources');
        candidates.push(join(resources, 'app.asar.unpacked', 'dsh', 'node_modules', 'koffi'));
        candidates.push(join(resources, 'dsh', 'node_modules', 'koffi'));
      }
      let loaded = false;
      for (const base of candidates) {
        const entry = join(base, 'index.cjs');
        if (!existsSync(entry)) continue;
        try { require(entry); loaded = true; break; } catch (e) { /* next */ }
      }
      console.log(JSON.stringify({ loaded }));
    });
  `;
  const result = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8', timeout: 60_000 });
  if (result.status !== 0) {
    console.error(`${label}: probe failed\n${result.stderr ?? ''}`);
    process.exit(1);
  }
  return JSON.parse(result.stdout.trim());
}

function findHarnessBinary() {
  const candidates = [
    'H:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe',
    'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe',
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return null;
}

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`);
}

if (process.platform !== 'win32') {
  console.log('skipped: the native overlay is Windows-only');
  process.exit(0);
}

const scrubbed = { ...process.env };
delete scrubbed.DSH_INSTALL_DIR;
delete scrubbed.DSH_NODE_EXECUTABLE;

check('resolves with DSH_INSTALL_DIR set', probe('with', process.env).loaded === true);

const binary = findHarnessBinary();
if (binary === null) {
  console.log('  skip resolves from the app binary — no Harness installation found');
} else {
  const asApp = { ...scrubbed, DSH_NODE_EXECUTABLE: binary };
  check('resolves from the app binary with no env vars', probe('binary', asApp).loaded === true);
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nthe FFI is found however the app was launched');
