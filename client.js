/**
 * Browser half of the screenshot bundle.
 *
 * The annotation surface is a native window owned by the host (see `index.js`
 * and `lib/overlay.js`), so this half is deliberately small: one button, one
 * shortcut, and the code that hands the finished PNG to the composer.
 *
 * That division is the point. A page cannot cover its own window frame, so every
 * overlay drawn here fought the window manager; the native window simply is
 * full-screen and has no frame to fight.
 */
window.__ModuleLoader__.load({
  id: 'dsh-screenshot',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Namespace of the client dictionary this plugin registers. */
    const NS = 'dsh-screenshot';
    /** Must match the route the host half registers. */
    const SNAP_URL = '/plugins/dsh-screenshot/snap';
    /**
     * Where the page asks the Host to (re)register the system-wide shortcut.
     *
     * The browser can only see keys while its own page has focus, so the Host's helper
     * process is what claims the combination from Windows. This route is how the two
     * agree — the page sends the combination on load.
     */
    const CONFIG_URL = '/plugins/dsh-screenshot/config';
    /** Preference: whether this application's own window is part of the shot. */
    const PREF_INCLUDE_SELF = 'dsh-screenshot.include-self';
    /** Preference: the capture shortcut, stored as "ctrl+alt+q". */
    const PREF_HOTKEY = 'dsh-screenshot.hotkey';
    const DEFAULT_HOTKEY = 'ctrl+alt+q';

    const DICTS = {
      en: {
        'launcher.title': 'Screenshot ({hotkey})',
        'launcher.menu': 'Screenshot options',
        'launcher.takeShot': 'Take a screenshot',
        'launcher.hideSelf': 'Hide this window when capturing',
        'status.insertFailed': 'Could not add the screenshot: {message}',
        'status.failed': 'Screenshot failed: {message}',
        'error.title': 'Screenshot failed',
      },
      zh: {
        'launcher.title': '截图 ({hotkey})',
        'launcher.menu': '截图选项',
        'launcher.takeShot': '截图',
        'launcher.hideSelf': '隐藏当前窗口',
        'status.insertFailed': '加入输入框失败：{message}',
        'status.failed': '截图失败：{message}',
        'error.title': '截图失败',
      },
    };

    const ICONS = {
      /*
       * Scissors: two handle rings at the left, two blades crossing to the right.
       *
       * Hand-rolled coordinates kept failing here, and each failure looked the same —
       * a blade passing through a ring, or a ring clipped by the viewBox. The numbers
       * below were tuned against a rendered preview so that:
       *   - each ring (r 2.3 at x 5.6) spans y 4.3..19.7, clear of the 24-box edges;
       *   - the rings end at x 7.9, and both blades start at x 10, so nothing touches;
       *   - the blades cross near (15, 12) and end at x 20.3, inside the box.
       */
      scissors: [
        'M5.6 8.9a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6z',
        'M5.6 19.7a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6z',
        'M10 9.7L20.3 16.4',
        'M10 14.3L20.3 7.6',
      ],      caret: ['M7 10l5 5 5-5'],
      check: ['M5 13l4 4L19 7'],
      // Menu glyphs: an eye for the window switches.
      eye: [
        'M2.6 12S6.2 5.6 12 5.6 21.4 12 21.4 12 17.8 18.4 12 18.4 2.6 12 2.6 12z',
        'M12 9.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8z',
      ],
    };

    /** Human-readable shortcut, e.g. "Ctrl+Alt+Q". */
    const HOTKEY_MODIFIERS = ['ctrl', 'alt', 'shift', 'meta'];
    const HOTKEY_KEY_LABEL = { ' ': 'Space' };
    const MODIFIER_LABELS = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Meta' };

    function parseHotkey(value) {
      const parts = String(value ?? '').toLowerCase().split('+').map((part) => part.trim()).filter((part) => part !== '');
      const modifiers = new Set();
      let key = '';
      for (const part of parts) {
        if (HOTKEY_MODIFIERS.includes(part)) modifiers.add(part);
        else key = part;
      }
      if (key === '' || modifiers.size === 0) return null;
      return { modifiers, key };
    }

    function formatHotkey(value) {
      const parsed = parseHotkey(value);
      if (parsed === null) return String(value ?? '');
      const order = ['ctrl', 'alt', 'shift', 'meta'];
      const parts = order.filter((name) => parsed.modifiers.has(name)).map((name) => MODIFIER_LABELS[name]);
      parts.push(HOTKEY_KEY_LABEL[parsed.key] ?? parsed.key.toUpperCase());
      return parts.join('+');
    }

    function keyOfEvent(event) {
      const code = typeof event.code === 'string' ? event.code : '';
      const named = { Space: ' ', Escape: 'escape', Enter: 'enter', Tab: 'tab', Backquote: '`', Minus: '-', Equal: '=' };
      if (code.startsWith('Key')) return code.slice(3).toLowerCase();
      if (code.startsWith('Digit')) return code.slice(5);
      if (named[code] !== undefined) return named[code];
      if (/^F\d{1,2}$/.test(code)) return code.toLowerCase();
      const key = String(event.key ?? '').toLowerCase();
      return key === '' ? code.toLowerCase() : key;
    }

    function readPreference(key, fallback) {
      try {
        const stored = window.localStorage.getItem(key);
        return stored === null ? fallback : stored;
      } catch (error) {
        return fallback;
      }
    }

    function writePreference(key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch (error) {
        console.error('[dsh-screenshot] a preference could not be stored', error);
      }
    }

    function format(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match));
    }

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error);
    }

    const hotkey = {
      get value() {
        return readPreference(PREF_HOTKEY, DEFAULT_HOTKEY);
      },
      matches(event) {
        const parsed = parseHotkey(this.value);
        if (parsed === null) return false;
        if (event.ctrlKey === true !== parsed.modifiers.has('ctrl')) return false;
        if (event.altKey === true !== parsed.modifiers.has('alt')) return false;
        if (event.shiftKey === true !== parsed.modifiers.has('shift')) return false;
        if (event.metaKey === true !== parsed.modifiers.has('meta')) return false;
        return keyOfEvent(event) === parsed.key;
      },
      label() {
        return formatHotkey(this.value);
      },
    };

    /** Whether the Harness window should be in the shot. */
    function readIncludeSelf() {
      return readPreference(PREF_INCLUDE_SELF, '0') === '1';
    }

    function writeIncludeSelf(value) {
      writePreference(PREF_INCLUDE_SELF, value ? '1' : '0');
    }

    /**
     * Ask the Host to claim the capture shortcut system-wide, and mirror the
     * "include my own window" preference.
     *
     * The Host registers a default at startup, so the shortcut is a re-assertion rather
     * than the only registration: if the user has a saved combination, that is what should
     * be live, and posting it here makes the two agree no matter which side started first.
     *
     * The preference travels with it because a shortcut-triggered capture has **no
     * request** to read it from — the page's `localStorage` is invisible to the Host. The
     * Host used to hard-code "step aside", so the shortcut never captured the Harness
     * window even when the user had asked it to.
     *
     * A failure is not fatal: the button still captures by click, and the in-page
     * shortcut still works while the Harness window has focus. The most common cause is
     * another application already owning the combination.
     *
     * @param {string} value e.g. `ctrl+alt+q`
     * @returns {Promise<{ registered: boolean, hotkey?: string, substituted?: boolean, error?: string }>}
     */
    async function syncGlobalHotkey(value) {
      try {
        const response = await fetch(CONFIG_URL, {
          method: 'POST',
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ hotkey: value, includeSelf: readIncludeSelf() }),
        });
        const body = await response.json().catch(() => ({}));
        return {
          registered: body.registered === true,
          hotkey: typeof body.hotkey === 'string' ? body.hotkey : undefined,
          substituted: body.substituted === true,
          error: body.error,
        };
      } catch (error) {
        return { registered: false, error: error instanceof Error ? error.message : String(error) };
      }
    }

    // ---------------------------------------------------------------- store

    const store = {
      state: { busy: false, toast: null, includeSelf: readIncludeSelf() },
      listeners: new Set(),
    };
    let toastTimer = null;

    function emit() {
      for (const listener of store.listeners) {
        try {
          listener();
        } catch (error) {
          console.error('[dsh-screenshot] listener failed', error);
        }
      }
    }

    function subscribe(listener) {
      store.listeners.add(listener);
      return () => store.listeners.delete(listener);
    }

    function flashToast(text) {
      store.state = { ...store.state, toast: String(text) };
      emit();
      if (toastTimer !== null) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        toastTimer = null;
        store.state = { ...store.state, toast: null };
        emit();
      }, 2600);
    }

    function setBusy(value) {
      store.state = { ...store.state, busy: Boolean(value) };
      emit();
    }

    function setIncludeSelf(value) {
      writeIncludeSelf(value);
      store.state = { ...store.state, includeSelf: Boolean(value) };
      emit();
      /*
       * Push the change to the Host immediately.
       *
       * The value only matters to a capture started from the global shortcut, and that
       * request never reaches this page — so the Host has to be told rather than asked.
       * Fire-and-forget: a failure here leaves the previous mirror in place, and the next
       * page load re-sends it anyway.
       */
      void syncGlobalHotkey(hotkey.value);
    }

    function useStoreState() {
      const [state, setState] = React.useState(store.state);
      React.useEffect(() => subscribe(() => setState(store.state)), []);
      return state;
    }

    // ------------------------------------------------------- composer handoff

    /**
     * Hand a PNG to the composer as if the user pasted it.
     *
     * The composer is a Lexical editor whose own paste handler reads
     * `event.clipboardData.items` and calls `getAsFile()`, so a synthetic
     * ClipboardEvent travels exactly the code path a real Ctrl+V uses. No DSH
     * internal API is touched, and the draft mints its own attachment id.
     */
    function insertIntoComposer(blob, name) {
      const editors = document.querySelectorAll('[data-lexical-editor="true"]');
      let editor = null;
      for (const candidate of editors) {
        const box = candidate.getBoundingClientRect();
        if (box.width > 0 && box.height > 0) editor = candidate;
      }
      if (editor === null) editor = editors.length > 0 ? editors[0] : null;
      if (editor === null) return false;

      const file = new File([blob], name, { type: 'image/png' });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      editor.focus();

      // Both keys are supplied: ClipboardEventInit is specified as `dataTransfer`,
      // while the read-only property consumers read is `clipboardData`.
      let event = null;
      try {
        event = new ClipboardEvent('paste', {
          dataTransfer: transfer,
          clipboardData: transfer,
          bubbles: true,
          cancelable: true,
          composed: true,
        });
      } catch (error) {
        event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, composed: true });
      }
      if (event.clipboardData === null || event.clipboardData === undefined) {
        try {
          Object.defineProperty(event, 'clipboardData', { value: transfer, configurable: true });
        } catch (error) {
          /* fall through to the failure path */
        }
      }
      if (event.clipboardData === null || event.clipboardData === undefined) return false;

      editor.dispatchEvent(event);
      return true;
    }

    function stamp() {
      const now = new Date();
      const pad = (value) => String(value).padStart(2, '0');
      return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    }

    // ------------------------------------------------------------- the action

    let running = false;

    /**
     * Capture, then drop the result into the composer.
     *
     * The host owns the whole interaction — its native window handles the drag,
     * the annotation and the confirmation — so this is one request. A cancel
     * comes back as 204 and is silent, because changing your mind is not a
     * failure.
     */
    async function capture(t) {
      if (running) return;
      running = true;
      setBusy(true);
      try {
        const response = await fetch(`${SNAP_URL}?t=${Date.now()}&self=${store.state.includeSelf ? '1' : '0'}`, {
          cache: 'no-store',
          credentials: 'same-origin',
        });
        /*
         * 204: cancelled, nothing to do.
         * 202: the overlay already put the image on the clipboard itself, which is
         *      what the toolbar's copy button asks for. Not an error and not an
         *      insertion — the user's request has already been fulfilled over there.
         */
        if (response.status === 204 || response.status === 202) return;
        if (!response.ok) {
          throw new Error((await response.text()).trim() || `HTTP ${response.status}`);
        }
        const blob = await response.blob();
        const name = `screenshot-${stamp()}.png`;
        if (insertIntoComposer(blob, name)) {
          // No toast on success: the image appearing in the message box *is* the
          // feedback, and a banner on top of it is just noise.
          return;
        }
        // No editor was reachable: put the image on the clipboard so the work is
        // not lost, and say what happened.
        try {
          if (navigator.clipboard !== undefined && typeof window.ClipboardItem === 'function') {
            await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })]);
            flashToast(format(t('status.insertFailed'), { message: 'clipboard' }));
            return;
          }
        } catch (error) {
          /* report the original failure below */
        }
        flashToast(format(t('status.insertFailed'), { message: 'no editor' }));
      } catch (error) {
        flashToast(format(t('status.failed'), { message: messageOf(error) }));
      } finally {
        running = false;
        setBusy(false);
      }
    }

    // ------------------------------------------------------------ components

    function Icon({ name, size = 18 }) {
      const paths = ICONS[name] ?? [];
      const children = paths.map((path, index) => h('path', { key: index, d: path }));
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        children,
      );
    }

    /**
     * The composer button. A plain click captures; the caret opens a menu with
     * the one per-capture choice that matters — whether this application's own
     * window is in the shot.
     */
    function Launcher({ t }) {
      const state = useStoreState();
      const [menu, setMenu] = React.useState(false);
      const rootRef = React.useRef(null);
      const title = format(t('launcher.title'), { hotkey: hotkey.label() });

      React.useEffect(() => {
        if (!menu) return;
        const onDown = (event) => {
          if (rootRef.current !== null && !rootRef.current.contains(event.target)) setMenu(false);
        };
        const onKey = (event) => {
          if (event.key === 'Escape') setMenu(false);
        };
        document.addEventListener('pointerdown', onDown, true);
        document.addEventListener('keydown', onKey, true);
        return () => {
          document.removeEventListener('pointerdown', onDown, true);
          document.removeEventListener('keydown', onKey, true);
        };
      }, [menu]);

      /**
       * One menu row: a leading glyph, the label, an optional shortcut hint, and a
       * radio dot on the right for the toggling entries.
       *
       * The dot is only rendered when the row actually represents a choice; a plain
       * command showing an empty circle would read as an unchecked option.
       */
      const MenuRow = ({ icon, label, hint, selected, onSelect }) => h(
        'button',
        {
          type: 'button',
          role: selected === undefined ? 'menuitem' : 'menuitemradio',
          className: 'dshshot-menu-item',
          'aria-checked': selected === undefined ? undefined : selected === true,
          onClick: onSelect,
        },
        h('span', { className: 'dshshot-menu-icon' }, icon === undefined ? null : h(Icon, { name: icon, size: 14 })),
        h('span', { className: 'dshshot-menu-label' }, label),
        h('span', { className: 'dshshot-menu-hint' }, hint ?? ''),
        selected === undefined
          ? null
          : h('span', { className: 'dshshot-menu-radio', 'data-on': selected === true ? 'true' : 'false' }),
      );

      return h(
        'div',
        { className: 'dshshot-launch-wrap', ref: rootRef },
        h(
          'button',
          {
            type: 'button',
            className: 'dshshot-launcher',
            title,
            'aria-label': title,
            disabled: state.busy,
            onClick: () => void capture(t),
          },
          h(Icon, { name: 'scissors', size: 17 }),
          h('span', { className: 'dshshot-launcher-caret' }, h(Icon, { name: 'caret', size: 11 })),
        ),
        // The caret inside the button opens the menu; a second invisible affordance
        // would split one control into two, which is what the reference avoids.
        h('span', {
          className: 'dshshot-menu-hotspot',
          role: 'button',
          tabIndex: -1,
          'aria-label': t('launcher.menu'),
          onClick: (event) => {
            event.stopPropagation();
            setMenu((open) => !open);
          },
        }),
        menu
          ? h(
            'div',
            { className: 'dshshot-menu', role: 'menu' },
            h(MenuRow, {
              icon: 'scissors',
              label: t('launcher.takeShot'),
              hint: hotkey.label(),
              onSelect: () => {
                setMenu(false);
                void capture(t);
              },
            }),
            h('div', { className: 'dshshot-menu-divider' }),
            /*
             * A single checkbox, not two mutually exclusive rows.
             *
             * "Hide the window" is one decision with two states, and a checkbox says
             * that; offering both states as options made the menu read as a chooser
             * and took a row for something that needs none.
             */
            h(MenuRow, {
              icon: 'eye',
              label: t('launcher.hideSelf'),
              selected: state.includeSelf === false,
              onSelect: () => {
                // Toggle the preference without starting a capture: the menu is a
                // settings surface, the scissor row is the action.
                setIncludeSelf(state.includeSelf !== false ? false : true);
                setMenu(false);
              },
            }),
          )
          : null,
      );
    }

    /** The toast that reports what happened after the native window closed. */
    function Toast({ t }) {
      const state = useStoreState();
      if (state.toast === null) return null;
      return h('div', { className: 'dshshot-toast', role: 'status' }, state.toast);
    }

    // ---------------------------------------------------------------- styles

    const FONT_STACK = 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';

    const CSS = `
/*
 * The launcher is one pill holding a capture button and a caret, mirroring the
 * frame-picker control the composer already uses beside it. Hovering anywhere on
 * the pill highlights the whole thing — not just the button under the pointer — so
 * the pair reads as one control, and the glyph lifts slightly to acknowledge the
 * pointer without moving the layout.
 */
.dshshot-launch-wrap { position:relative; display:inline-flex; align-items:center; border-radius:8px; transition:background .15s ease; }
.dshshot-launch-wrap:hover { background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.16)); }
.dshshot-launcher { display:inline-flex; align-items:center; gap:1px; height:28px; padding:0 4px 0 5px; border:0; border-radius:8px; background:transparent; color:var(--dsw-alias-label-secondary,#6b7280); cursor:pointer; transition:color .15s ease, transform .15s ease; }
.dshshot-launcher:hover { color:var(--dsw-alias-label-primary,#111827); }
.dshshot-launcher:hover svg { transform:scale(1.06); }
.dshshot-launcher svg { transition:transform .15s ease; }
.dshshot-launcher:active { transform:scale(.95); }
.dshshot-launcher:disabled { opacity:.45; cursor:default; }
.dshshot-launcher:focus-visible { outline:2px solid var(--dsw-alias-brand-primary,#2f7cf6); outline-offset:1px; }
/* The caret sits inside the button, as in the tool this follows: one control, not two. */
.dshshot-launcher-caret { display:inline-flex; margin-left:-1px; color:var(--dsw-alias-label-secondary,#9aa3af); opacity:.75; }
/* A transparent strip over the caret's half, so clicking there opens the menu while
   the rest of the button still captures. */
.dshshot-menu-hotspot { position:absolute; right:0; top:0; bottom:0; width:13px; cursor:pointer; }
/*
 * The menu follows the active theme instead of forcing a white card: it sits on the
 * composer, so it has to belong to whatever surface the user is looking at. Every
 * colour here is a real theme token with a neutral fallback for a host that does
 * not define one.
 */
/*
 * Geometry and surface both follow the Host's own menus, so this reads as a peer of
 * the composer's own dropdowns rather than a look-alike:
 *
 *   - Width and rows: 4px card inset, 34px rows, 13px text. The Host's MenuView keeps
 *     padding at 4px and each item at min-height 34px, padding 6px 8px, font-size 13px.
 *   - Surface: a translucent menu fill behind a strong backdrop blur
 *     (--dsw-specific-menu, which resolves to rgba(48,49,54,.64) on dark and
 *     rgba(252,253,254,.7) on light, over blur(40px) saturate(150%)). The previous
 *     version used an opaque --dsw-alias-bg-overlay card with a light 12px blur, which
 *     is why it read as a solid slab next to the real popovers.
 *   - Chrome: a half-pixel --dsw-alias-border-l1 stroke and the --dsw-radius-lg corner
 *     (16px), not the hand-picked 12px, plus the shared prominent elevation.
 *
 * Each token keeps a literal fallback for a Host that does not define it.
 */
.dshshot-menu { position:absolute; left:0; bottom:34px; z-index:2147483002; min-width:200px; padding:4px; isolation:isolate; border-radius:var(--dsw-radius-lg,16px); background:var(--dsw-specific-menu,rgba(48,49,54,.64)); border:0.5px solid var(--dsw-alias-border-l1,rgba(255,255,255,.1)); box-shadow:var(--dsw-elevation-prominent,0 3px 8px rgba(0,0,0,.04),0 0 20px rgba(0,0,0,.05)); backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%)); -webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%)); }
.dshshot-menu-item { display:flex; align-items:center; gap:6px; width:100%; min-height:34px; padding:6px 8px; border:0; border-radius:var(--dsw-radius-md,12px); background:transparent; color:var(--dsw-alias-label-primary,#e8eaed); font:400 13px/20px ${FONT_STACK}; cursor:pointer; text-align:left; transition:background .12s ease; }
.dshshot-menu-item:hover { background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08)); }
.dshshot-menu-item:focus-visible { outline:2px solid var(--dsw-alias-brand-primary,#2f7cf6); outline-offset:-2px; }
.dshshot-menu-icon { display:inline-flex; flex:none; color:var(--dsw-alias-menu-icon,var(--dsw-alias-label-secondary,#a6adb9)); }
.dshshot-menu-label { flex:1; min-width:0; white-space:nowrap; }
/* The shortcut is a right-aligned hint, tabular so the two rows line up. */
.dshshot-menu-hint { flex:none; color:var(--dsw-alias-label-secondary,#a6adb9); opacity:.7; font-size:12px; font-variant-numeric:tabular-nums; }
/* A tick for the selected state, matching the reference: clearer than a dot at a
   glance and it leaves the row's leading edge free for the glyph. */
.dshshot-menu-radio { display:inline-flex; flex:none; width:16px; height:16px; align-items:center; justify-content:center; color:var(--dsw-alias-brand-primary,#2f7cf6); opacity:0; }
.dshshot-menu-radio[data-on='true'] { opacity:1; }
.dshshot-menu-radio::after { content:''; width:11px; height:6px; border-left:2px solid currentColor; border-bottom:2px solid currentColor; transform:rotate(-45deg) translate(1px,-2px); }
.dshshot-menu-divider { height:1px; margin:4px 8px; background:var(--dsw-alias-border-l1,rgba(255,255,255,.09)); }
.dshshot-toast { position:fixed; left:50%; bottom:36px; transform:translateX(-50%); z-index:2147483001; max-width:calc(100vw - 48px); padding:8px 14px; border-radius:10px; background:rgba(17,24,39,.92); color:#f9fafb; font:400 13px/18px ${FONT_STACK}; box-shadow:0 12px 34px rgba(0,0,0,.3); pointer-events:none; }
`;

    // ---------------------------------------------------------------- wiring

    function translateFactory(ctx) {
      const locale = ctx.get('locale');
      const browser = typeof navigator === 'object' && navigator !== null ? navigator.language : '';
      const fallback = String(browser || '').toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
      const local = (key) => {
        const dict = DICTS[fallback] ?? DICTS.en;
        return dict[key] !== undefined ? dict[key] : (DICTS.en[key] !== undefined ? DICTS.en[key] : key);
      };
      if (locale === undefined || locale === null) return local;
      try {
        const snapshot = typeof locale.getLocale === 'function' ? locale.getLocale() : locale.getSnapshot();
        const ids = new Set(['en']);
        for (const entry of (snapshot && snapshot.locales) || []) {
          if (entry !== null && typeof entry === 'object' && typeof entry.id === 'string') ids.add(entry.id);
        }
        for (const id of ids) {
          const dict = String(id).toLowerCase().indexOf('zh') === 0 ? DICTS.zh : DICTS.en;
          try {
            const dispose = locale.register(NS, id, dict);
            if (typeof dispose === 'function' && typeof ctx.effect === 'function') {
              ctx.effect(() => dispose, `dsh-screenshot: locale ${id}`);
            }
          } catch (cause) {
            console.error(`[dsh-screenshot] locale ${id} was not registered`, cause);
          }
        }
        const bound = locale.bind(NS);
        return (key) => {
          const value = bound(key);
          return typeof value === 'string' && value !== key ? value : local(key);
        };
      } catch (cause) {
        console.error('[dsh-screenshot] locale service unavailable', cause);
        return local;
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const t = translateFactory(ctx);

        /*
         * Re-assert the saved shortcut once the page loads.
         *
         * There is no settings row for this any more — the shortcut is not something the
         * General settings page should own — so the page simply hands the Host its saved
         * value and lets it register. Silent by design: a combination another program
         * already owns is not worth interrupting the user for, and the in-page shortcut
         * plus the button keep working either way.
         */
        void syncGlobalHotkey(hotkey.value).then((outcome) => {
          if (outcome.registered && outcome.substituted === true && outcome.hotkey !== undefined) {
            // The requested combination was taken; adopt the one Windows accepted so the
            // button's tooltip matches what will actually fire.
            writePreference(PREF_HOTKEY, outcome.hotkey);
          }
        });

        if (typeof ctx.effect === 'function') {
          ctx.effect(() => {
            const element = document.createElement('style');
            element.setAttribute('data-dsh-screenshot', '');
            element.textContent = CSS;
            document.head.appendChild(element);
            return () => element.remove();
          }, 'dsh-screenshot: styles');
          ctx.effect(() => () => {
            if (toastTimer !== null) clearTimeout(toastTimer);
            toastTimer = null;
            store.state = { busy: false, toast: null, includeSelf: store.state.includeSelf };
            store.listeners.clear();
          }, 'dsh-screenshot: store');
        } else {
          const element = document.createElement('style');
          element.setAttribute('data-dsh-screenshot', '');
          element.textContent = CSS;
          document.head.appendChild(element);
        }

        const onKeyDown = (event) => {
          if (store.state.busy || event.repeat || event.altGraphKey) return;
          if (!hotkey.matches(event)) return;
          event.preventDefault();
          event.stopPropagation();
          void capture(t);
        };
        window.addEventListener('keydown', onKeyDown, true);
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => () => window.removeEventListener('keydown', onKeyDown, true), 'dsh-screenshot: shortcut');
        }

        const track = (dispose, label) => {
          if (typeof dispose !== 'function') return;
          if (typeof ctx.effect === 'function') ctx.effect(() => dispose, label);
        };

        track(ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'dsh-screenshot.launcher',
          order: 6,
        }, () => h(Launcher, { t }))), 'dsh-screenshot: composer button');

        track(ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-screenshot.toast',
          order: 40,
        }, () => h(Toast, { t }))), 'dsh-screenshot: toast');

        /*
         * No General-settings row.
         *
         * The shortcut used to appear there as a key recorder. It belongs with the
         * screenshot feature rather than in the Harness's general preferences — the
         * general page is for things that affect the whole application, and a capture
         * shortcut is not one. The row is removed until the global binding works
         * reliably; the launcher menu still shows the current combination.
         */
      },
    };
  },
});
