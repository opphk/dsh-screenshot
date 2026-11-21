/**
 * Host half of the screenshot bundle.
 *
 * The annotation surface is a **native full-screen window**, run as a child
 * process (`lib/overlay.js`). Earlier revisions drew the overlay in the page,
 * which could never cover the window's own title bar or anything outside the
 * window — that is why the taskbar stayed on top and why covering the screen
 * required resizing the user's window. A real window has none of those limits.
 *
 * The child process matters too: the overlay owns a Win32 message pump, and
 * running that on the host's thread would freeze DSH while the user drags.
 *
 * The host's only jobs are to run the overlay, hand its PNG to the browser, and
 * clean up the temporary file.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Hard dependency: this plugin answers over the browser HTTP carrier. */
export const inject = ['webServer'];

/** Exact path the browser half fetches; keep in sync with `CAPTURE_URL` in `client.js`. */
const SNAP_PATH = '/plugins/dsh-screenshot/snap';

const here = dirname(fileURLToPath(import.meta.url));
const overlayScript = join(here, 'lib', 'overlay.js');
const hotkeyScript = join(here, 'lib', 'hotkey.js');

/** A user who leaves the overlay open is still allowed to; this only guards a hang. */
const OVERLAY_TIMEOUT_MS = 5 * 60_000;

/**
 * The system-wide shortcut.
 *
 * The browser half can only see keys while its page has focus, so a real global hotkey
 * has to be owned by the operating system. `lib/hotkey.js` does that in its own child
 * process (a Win32 message pump must not run on the Host's thread) and reports presses
 * here.
 *
 * This is the Host's copy of the preference; the page writes it through
 * {@link SNAP_CONFIG_PATH} whenever the user changes the shortcut in settings.
 */
const DEFAULT_HOTKEY = 'ctrl+alt+q';
/** Where the page stores the shortcut, relative to `/plugins/dsh-screenshot`. */
const CONFIG_PATH = '/plugins/dsh-screenshot/config';
/** How long to wait for the helper to report `ready` before giving up. */
const HOTKEY_READY_TIMEOUT_MS = 4000;

/**
 * The page's "include this application's own window" preference, mirrored here.
 *
 * The setting lives in the page's `localStorage`, which the Host cannot read. A capture
 * started from the **button** carries the preference in its query string, so the route
 * already knows it; a capture started from the **global shortcut** has no request at all
 * and would otherwise have to guess. Guessing `false` was the old behaviour, which is why
 * the shortcut always stepped the window aside even when the user had asked to keep it.
 *
 * The page therefore mirrors the value here whenever it changes, and the shortcut path
 * reads it. Default `false` matches the product default (the button's menu starts
 * unchecked), and a page that never loads leaves this at the default.
 */
let includeSelfPreference = false;

export function apply(ctx) {
  const supported = process.platform === 'win32' && existsSync(overlayScript);

  if (!supported) {
    console.error(
      '[dsh-screenshot] the native overlay is unavailable on this platform, so capture is disabled. '
      + `Expected ${overlayScript} on Windows.`,
    );
  }

  /**
   * Run the overlay and return the PNG it wrote.
   *
   * Exit codes are the overlay's contract: 0 wrote the file, 2 the user
   * cancelled, 3 it could not write. A cancel is a normal outcome, not an
   * error, so it is reported as `cancelled` rather than thrown.
   */
  function runOverlay(includeSelf, options = {}) {
    return new Promise((resolve, reject) => {
      const directory = mkdtemp(join(tmpdir(), 'dsh-screenshot-')).catch(() => null);
      directory.then((dir) => {
        if (dir === null) {
          reject(new Error('could not create a temporary directory'));
          return;
        }
        const output = join(dir, 'shot.png');
        const args = [overlayScript, output];
        if (includeSelf) args.push('--include-self');
        // Shortcut captures confirm into the clipboard; see the press handler below.
        if (options.clipboard === true) args.push('--clipboard');

        const child = spawn(process.execPath, args, {
          // ELECTRON_RUN_AS_NODE keeps the child a plain Node process, which is
          // what the overlay needs; inheriting the harness's own flags does not.
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });

        let stderr = '';
        let settled = false;
        const finish = async (outcome) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          await rm(dir, { recursive: true, force: true }).catch(() => {});
          resolve(outcome);
        };

        const timer = setTimeout(() => {
          child.kill();
          finish({ cancelled: false, error: 'the screenshot window did not close' });
        }, OVERLAY_TIMEOUT_MS);
        timer.unref?.();

        child.stderr?.on('data', (chunk) => {
          stderr = (stderr + String(chunk)).slice(-2000);
        });
        child.stdout?.on('data', () => {
          /* the overlay only writes diagnostics here when debugging */
        });

        child.on('error', (error) => {
          finish({ cancelled: false, error: error.message });
        });

        child.on('close', async (code) => {
          if (settled) return;
          if (code === 2) {
            await finish({ cancelled: true });
            return;
          }
          /*
           * 4 means "the user asked for the clipboard instead".
           *
           * The overlay has already put the image there, so there is no file to read
           * and nothing to insert into the composer. Reported as its own outcome so the
           * page can stay silent rather than showing an error or a stray image.
           */
          if (code === 4) {
            await finish({ cancelled: false, copied: true });
            return;
          }
          if (code !== 0) {
            await finish({ cancelled: false, error: stderr.trim() || `the screenshot window exited with code ${String(code)}` });
            return;
          }
          // Read before the temporary directory is removed.
          const bytes = await readFile(output).catch(() => null);
          if (bytes === null || bytes.length < 64) {
            await finish({ cancelled: false, error: 'the screenshot window produced no image' });
            return;
          }
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          await rm(dir, { recursive: true, force: true }).catch(() => {});
          resolve({ cancelled: false, bytes });
        });
      });
    });
  }

  // ------------------------------------------------------------------ hotkey

  /**
   * The accelerator the helper is currently registered for, or null when idle.
   * @type {string | null}
   */
  let activeHotkey = null;
  /** @type {import('node:child_process').ChildProcess | null} */
  let hotkeyChild = null;

  /**
   * Why the last registration failed, or null while the shortcut is healthy.
   *
   * A transient failure at boot must not be silent: this is what `GET /config`
   * reports so the page can show the truth instead of the preference it saved.
   *
   * @type {string | null}
   */
  let hotkeyError = null;

  /**
   * Start the global hotkey helper, replacing any running one.
   *
   * Registration is exclusive in Windows: two processes cannot own the same
   * combination, so the old helper must be torn down before the new one starts or the
   * new registration fails and the shortcut silently stops working.
   *
   * @param {string} accelerator e.g. `ctrl+alt+q`
   * @returns {Promise<{ ok: boolean, error?: string }>} whether it registered
   */
  function startHotkey(accelerator) {
    return new Promise((resolve) => {
      if (!supported || !existsSync(hotkeyScript)) {
        resolve({ ok: false, error: 'the global shortcut needs Windows' });
        return;
      }

      stopHotkey();

      const child = spawn(process.execPath, [hotkeyScript, accelerator], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      hotkeyChild = child;
      activeHotkey = accelerator;

      let settled = false;
      let buffer = '';
      const settle = (outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      };
      const timer = setTimeout(() => {
        settle({ ok: false, error: 'the global shortcut did not start' });
      }, HOTKEY_READY_TIMEOUT_MS);
      timer.unref?.();

      child.stdout?.on('data', (chunk) => {
        buffer += String(chunk);
        // The helper speaks one line per event; keep the tail for partial lines.
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const text = line.trim();
          if (text === 'ready' || text.startsWith('ready ')) {
            /*
             * The helper reports the combination it actually claimed, which may differ
             * from the one asked for: `RegisterHotKey` fails when another process owns
             * the combination, and the helper then walks a short fallback list. Passing
             * the effective value back is what lets the page show the truth instead of
             * the preference it saved.
             */
            const effective = text.startsWith('ready ') ? text.slice(6).trim() : accelerator;
            if (effective !== accelerator) activeHotkey = effective;
            settle({ ok: true, hotkey: effective, substituted: effective !== accelerator });
          } else if (text.startsWith('error ')) {
            settle({ ok: false, error: text.slice(6) });
          } else if (text === 'press') {
            /*
             * The shortcut just grabs the screen as it is.
             *
             * It does not try to work out whether the Harness window is in front or to
             * hide it: that judgement is what caused the Harness window to be brought
             * forward on a shortcut capture taken over another app. Pressing the global
             * shortcut means "capture what I am looking at", so the overlay runs with
             * `includeSelf` and takes the frame directly. The button path, which runs from
             * inside the Harness window, is the one that hides it.
             *
             * `clipboard: true` is what makes the capture useful from another app: there
             * is no composer request to insert into, so the confirm copies the image to
             * the system clipboard instead of writing a file (overlay exits 4).
             */
            void runOverlay(true, { clipboard: true }).then((result) => {
              if (result.error !== undefined) console.error('[dsh-screenshot] hotkey capture failed:', result.error);
            });
          }
        }
      });

      child.stderr?.on('data', (chunk) => {
        console.error('[dsh-screenshot] hotkey:', String(chunk).trim());
      });

      child.on('error', (error) => {
        settle({ ok: false, error: error.message });
      });

      child.on('close', () => {
        if (hotkeyChild === child) {
          hotkeyChild = null;
          activeHotkey = null;
        }
        // A helper that dies before reporting is a failed registration.
        settle({ ok: false, error: 'the global shortcut stopped unexpectedly' });
      });
    });
  }

  /** Stop the helper and release the combination. */
  function stopHotkey() {
    const child = hotkeyChild;
    hotkeyChild = null;
    activeHotkey = null;
    if (child === null) return;
    try {
      // Closing stdin is the helper's shutdown signal; `kill` is the fallback.
      child.stdin?.end();
      child.kill();
    } catch {
      /* already gone */
    }
  }

  // The helper must not outlive the Host: a leftover process keeps the combination
  // registered, and the next Harness run would fail to claim it.
  ctx.effect(() => () => stopHotkey(), 'dsh-screenshot: global hotkey');

  /**
   * Retry a failed registration a few times with a short backoff.
   *
   * A busy boot can make the first attempt fail transiently — the helper needs its own
   * process and a message queue. One silent failure used to leave the shortcut dead for
   * the whole session, so the reason is remembered and a couple of retries follow.
   *
   * @param {string} accelerator e.g. `ctrl+alt+q`
   * @param {number} attemptsLeft how many further attempts to make
   */
  function retryHotkey(accelerator, attemptsLeft) {
    if (attemptsLeft <= 0) return;
    const timer = setTimeout(() => {
      void startHotkey(accelerator).then(
        (outcome) => {
          if (outcome.ok) {
            hotkeyError = null;
            console.log('[dsh-screenshot] global shortcut ready after retry:', outcome.hotkey ?? accelerator);
            return;
          }
          retryHotkey(accelerator, attemptsLeft - 1);
        },
        // A synchronous spawn failure rejects the promise; treat it as one failed attempt
        // rather than letting it escape as an unhandled rejection.
        () => retryHotkey(accelerator, attemptsLeft - 1),
      );
    }, 500);
    timer.unref?.();
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: SNAP_PATH,
    handler: async (req, res) => {
      const connection = ctx.get('connection');
      const rejection = connection === undefined ? undefined : connection.requestRejection(req);
      if (rejection !== undefined) {
        res.statusCode = rejection;
        res.end();
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405;
        res.setHeader('allow', 'GET, HEAD');
        res.end();
        return;
      }
      if (!supported) {
        res.statusCode = 501;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end('the screenshot overlay is only available on Windows');
        return;
      }

      const query = new URL(String(req.url ?? ''), 'http://localhost').searchParams;
      const includeSelf = query.get('self') === '1';

      let result;
      try {
        result = await runOverlay(includeSelf);
      } catch (error) {
        res.statusCode = 500;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(`screenshot failed: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }

      if (result.error !== undefined) {
        res.statusCode = 500;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(`screenshot failed: ${result.error}`);
        return;
      }

      if (result.cancelled === true) {
        // 204 means "the user changed their mind": the page shows nothing.
        res.statusCode = 204;
        res.setHeader('cache-control', 'no-store');
        res.end();
        return;
      }

      if (result.copied === true) {
        /*
         * 202: the image is on the clipboard, nothing to return.
         *
         * A distinct status rather than 204 so the page can tell "copied" from
         * "cancelled" if it ever wants to, while still having no body to insert.
         */
        res.statusCode = 202;
        res.setHeader('cache-control', 'no-store');
        res.end();
        return;
      }

      res.statusCode = 200;
      res.setHeader('content-type', 'image/png');
      res.setHeader('cache-control', 'no-store, no-cache, must-revalidate');
      res.setHeader('content-length', String(result.bytes.length));
      res.end(req.method === 'HEAD' ? undefined : result.bytes);
    },
  }), `dsh-screenshot: GET ${SNAP_PATH}`);

  /*
   * The shortcut has to be registered by the Host, but it is chosen in the page's
   * settings. This route is how the two agree: the page posts the accelerator it just
   * saved, and the Host registers (or re-registers) the helper for it.
   *
   * It also answers `GET` so the page can start the shortcut on load without knowing
   * whether one is already running.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CONFIG_PATH,
    handler: async (req, res) => {
      const connection = ctx.get('connection');
      const rejection = connection === undefined ? undefined : connection.requestRejection(req);
      if (rejection !== undefined) {
        res.statusCode = rejection;
        res.end();
        return;
      }

      const send = (status, body) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(JSON.stringify(body));
      };

      if (req.method === 'GET') {
        // Report the live state; `activeHotkey` is what the OS currently holds.
        send(200, {
          hotkey: activeHotkey ?? DEFAULT_HOTKEY,
          registered: hotkeyChild !== null,
          includeSelf: includeSelfPreference,
          // Why the shortcut is not live, so the page can show the truth.
          error: hotkeyError,
        });
        return;
      }

      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.setHeader('allow', 'GET, POST');
        res.end();
        return;
      }

      // Read the JSON body; the request is tiny, so buffering it whole is fine.
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        send(400, { error: 'invalid JSON' });
        return;
      }
      const hotkey = typeof payload.hotkey === 'string' && payload.hotkey !== ''
        ? payload.hotkey
        : DEFAULT_HOTKEY;

      /*
       * Mirror the "include my own window" preference.
       *
       * A shortcut-triggered capture has no request to read the preference from, so the
       * page pushes it here. Accepting it on the same POST as the hotkey keeps this to one
       * call per page load and on every toggle.
       */
      if (typeof payload.includeSelf === 'boolean') includeSelfPreference = payload.includeSelf;

      if (!supported) {
        send(501, { hotkey, registered: false, error: 'the global shortcut needs Windows' });
        return;
      }

      const outcome = await startHotkey(hotkey);
      if (!outcome.ok) {
        send(409, { hotkey, registered: false, error: outcome.error ?? 'could not register' });
        return;
      }
      /*
       * Answer with the combination that is actually registered.
       *
       * When another application owns the requested one, the helper substitutes a free
       * combination; reporting that lets the page correct its display instead of
       * claiming a shortcut that is not live.
       */
      send(200, {
        hotkey: outcome.hotkey ?? hotkey,
        registered: true,
        substituted: outcome.substituted === true,
        requested: hotkey,
        includeSelf: includeSelfPreference,
      });
    },
  }), `dsh-screenshot: ${CONFIG_PATH}`);

  /*
   * Register the default shortcut at startup, so it works before the page is opened.
   *
   * The page's POST overrides it once the user picks something else.
   *
   * `DSH_SCREENSHOT_NO_GLOBAL_HOTKEY` opts out. The helper is a long-lived child process that
   * owns a real OS resource, so a test that only wants to exercise the routes must not
   * spawn it: the child would keep the runner alive (and hold the combination, blocking
   * the developer's own instance).
   */
  if (supported && existsSync(hotkeyScript) && process.env.DSH_SCREENSHOT_NO_GLOBAL_HOTKEY !== '1') {
    console.log('[dsh-screenshot] starting the global shortcut helper');
    void startHotkey(DEFAULT_HOTKEY).then((outcome) => {
      if (!outcome.ok) {
        /*
         * Record why, and keep trying.
         *
         * A startup race can make the first attempt fail — the helper needs its own
         * process and a message queue, and on a busy boot that has been seen to fail
         * transiently. One silent failure left the shortcut dead for the whole session
         * with nothing to show for it, so the reason is remembered (readable from
         * `/config`) and a couple of retries follow.
         */
        hotkeyError = outcome.error ?? 'could not register';
        console.error('[dsh-screenshot] the global shortcut is unavailable:', hotkeyError);
        retryHotkey(DEFAULT_HOTKEY, 2);
      } else {
        hotkeyError = null;
        console.log('[dsh-screenshot] global shortcut ready:', outcome.hotkey ?? DEFAULT_HOTKEY);
      }
    }, (error) => {
      /*
       * A rejected `startHotkey` is a failed registration, not a fatal error.
       *
       * Without this branch the rejection would be unhandled, and the Host treats an
       * unhandled rejection during load as a fatal failure — one bad shortcut attempt
       * would take the whole application down.
       */
      hotkeyError = error?.message ?? String(error);
      console.error('[dsh-screenshot] the global shortcut could not start:', hotkeyError);
      retryHotkey(DEFAULT_HOTKEY, 2);
    });
  } else if (process.env.DSH_SCREENSHOT_NO_GLOBAL_HOTKEY === '1') {
    console.log('[dsh-screenshot] global shortcut disabled by DSH_SCREENSHOT_NO_GLOBAL_HOTKEY');
  }
}
