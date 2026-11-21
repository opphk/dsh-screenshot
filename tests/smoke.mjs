/**
 * Static checks for the bundle: manifest shape, patch, locale, icon, and the
 * contract between the two halves.
 *
 * The last section loads the real `index.js` and calls `apply()`. That exists
 * because a stale identifier once left every route at 404 while text-matching
 * checks passed: the file contained the name, but the module could not run.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`);
}

const read = (path) => readFile(join(root, path), 'utf8');

const manifest = JSON.parse(await read('package.json'));
const patch = await read('cordis.patch.yml');
const host = await read('index.js');
const client = await read('client.js');
const overlay = await read('lib/overlay.js');
const zh = JSON.parse(await read('locale/zh.json'));
const en = JSON.parse(await read('locale/en.json'));
const icon = await read('icon.svg');

console.log('manifest');
check('name is dsh-screenshot', manifest.name === 'dsh-screenshot', manifest.name);
check('declares a bundle patch', manifest.dsh?.bundle?.patch === './cordis.patch.yml');
check('declares a web client half', manifest.dsh?.client?.platform === 'web');
check('client half loads immediately', manifest.dsh?.client?.immediately === true);
check('exports the client entry', manifest.exports?.['./client'] === './client.js');
check('exports locale json', manifest.exports?.['./locale/*.json'] === './locale/*.json');
check('exports the icon', manifest.exports?.['./icon'] === './icon.svg');
check('ships lib for the overlay', manifest.files.includes('lib'));
for (const needed of ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg']) {
  check(`files ships ${needed}`, manifest.files.includes(needed), JSON.stringify(manifest.files));
}
/*
 * No packaged `docs` folder.
 *
 * The bundle used to ship a DETAIL image, but that preview went stale (it predated the
 * copy button, carried `<text>` the detail renderer forbids, and was drawn at the wrong
 * canvas size). The description alone covers the feature, so the detail document and its
 * images are gone and the details page falls back to the README.
 */
check('does not ship a stale docs folder', !manifest.files.includes('docs'),
  JSON.stringify(manifest.files));

console.log('patch');
check('patch inserts exactly one row', (patch.match(/- insert:/g) || []).length === 1);
check('row id matches the package', /id:\s*dsh-screenshot\b/.test(patch));
check('row name matches the package', /name:\s*'dsh-screenshot'/.test(patch));

console.log('contract');
const hostPath = host.match(/const SNAP_PATH = '([^']+)'/)?.[1];
const clientPath = client.match(/const SNAP_URL = '([^']+)'/)?.[1];
check('host declares the snap path', typeof hostPath === 'string', String(hostPath));
check('client calls the same path', clientPath === hostPath, `${String(hostPath)} vs ${String(clientPath)}`);
check('the host runs the overlay as a child process', /spawn\(process\.execPath/.test(host));
check('the child gets its own Node runtime', /ELECTRON_RUN_AS_NODE/.test(host));
check('a cancel is reported as 204, not an error', /statusCode = 204/.test(host));
check('the temporary directory is always removed', /rm\(dir, \{ recursive: true, force: true \}\)/.test(host));
check('the row checks connection trust', /requestRejection/.test(host));

console.log('native overlay');
check('it creates a real window', /CreateWindowExW/.test(overlay));
check('the window is topmost and borderless', /WS_EX_TOPMOST/.test(overlay) && /WS_POPUP/.test(overlay));
check('it pumps messages off the host thread', /PeekMessageW/.test(overlay));
check('it grabs the desktop with GDI', /BitBlt/.test(overlay) && /GetDIBits/.test(overlay));
check('it steps its own window aside unless asked to include it', /stepAsideOwnWindow/.test(overlay));
check('the window is put back', /restoreOwnWindow/.test(overlay));
/*
 * Focus must go back to whoever had it before the overlay, otherwise a shortcut capture
 * taken over another app leaves the Harness window in front.
 */
check('it restores the previous foreground window on exit',
  /GetForegroundWindow/.test(overlay) && /function restoreForeground/.test(overlay)
  && /AttachThreadInput/.test(overlay));
check('it writes PNG itself', /deflateSync/.test(overlay));
check('cancel exits 2', /process\.exit\(2\)|exitWith\(2\)/.test(overlay));
check('selection is exported at native size', /buildResult/.test(overlay));
check('no leftover page-drawn overlay', !/dshshot-overlay|dshshot-canvas/.test(client));
check('the old in-process capture module is gone', !existsSync(join(root, 'lib', 'capture.js')));

console.log('drawing correctness');
check('the interface is drawn with GDI+', /const gdiplus = koffi\.load\('gdiplus\.dll'\)/.test(overlay));
check('GDI+ is started once', /GdiplusStartup/.test(overlay) && /gdiplusToken/.test(overlay));
check('antialiasing and ClearType are enabled', /GdipSetSmoothingMode[\s\S]*GdipSetTextRenderingHint/.test(overlay));
check('a colour bitmap is compatible with the screen', /CreateCompatibleBitmap\(screenDc/.test(overlay));
check('no bitmap is created from a NULL memory DC', !/CreateCompatibleBitmap\(memory/.test(overlay));
check('colours are GDI+ ARGB with a real alpha byte', /COLOR_ACCENT = 0xff/.test(overlay) && /PEN_COLORS = \[0xff/.test(overlay));
check('no invented hollow-brush colour is used as a brush', !/CreateSolidBrush\(0x01ffffff\)/.test(overlay));
check('rounded corners come from a GDI+ path', /GdipAddPathArc/.test(overlay));
check('colour swatches are circles', /function fillCircle/.test(overlay) && /GdipFillEllipse/.test(overlay));
check('the frame is drawn through DDB blits, not DIB headers', /api\.BitBlt\(hdc, x, y, w, h, frameBitmap\.memory/.test(overlay));
check('the screen DC is released after building a bitmap', /finally \{\s*\n\s*api\.ReleaseDC\(null, screenDc\)/.test(overlay));

console.log('toolbar timing');
check('one predicate governs the toolbar', /function toolbarVisible/.test(overlay));
check('the toolbar is hidden while a selection is dragged out', /return state\.sel !== null[\s\S]*?!state\.choosing/.test(overlay));
check('painting and hit-testing share it', (overlay.match(/toolbarVisible\(\)/g) ?? []).length >= 3);
check('no leftover test hook', !/previewDragging/.test(overlay));
check('no instructional banner covers the capture', !/Drag to select a region/.test(overlay));
check('the size readout is still drawn', /`\$\{Math\.round\(sel\.w\)\} x \$\{Math\.round\(sel\.h\)\}`/.test(overlay));

console.log('flicker');
check('frames are composed off-screen', /const backBuffer = /.test(overlay));
check('the window paints through the back buffer', /api\.BitBlt\(hdc, 0, 0, screenWidth, screenHeight, backBuffer\.memory/.test(overlay));
check('the background erase is claimed', /WM_ERASEBKGND/.test(overlay) && /return 1;/.test(overlay));
check('preview and window share one composition', /function paint\(hdc\)[\s\S]*drawOverlay\(hdc\)/.test(overlay));

console.log('arrow shape');
check('the arrow head is a solid triangle', /headWidth = headLength \* 0\.66/.test(overlay));
check('the shaft stops at the head base', /GdipDrawLine\(graphics, penHandle, item\.x1, item\.y1, baseX, baseY\)/.test(overlay));

console.log('selection adjustment');
check('there is no separate move tool', !/const TOOLS = \[[^\]]*'move'/.test(overlay));
check('the pointer advertises a movable annotation', /else if \(annotationAt\(x, y\) !== -1\) \{\s*\n\s*\/\/ A drawn annotation is grabbed/.test(overlay));
check('before a tool is picked the whole frame interior moves it', /state\.tool === null\s*\n\s*\? \(state\.sel !== null && insideRect\(x, y, state\.sel\)\)\s*\n\s*: hitsFrameEdge\(x, y\)/.test(overlay));
check('a new frame resets to no tool so it can be nudged', /state\.annots = \[\];\s*\n\s*state\.tool = null;/.test(overlay));
check('no tool is a real state, not a placeholder', /tool: null,/.test(overlay));
check('the IME candidate window is anchored to the caret', /function placeImeWindow/.test(overlay) && /ImmSetCompositionWindow/.test(overlay));
check('the IME is anchored when typing starts', /syncImeToCaret\(\);\s*\n\s*startCaretBlink\(\);/.test(overlay));
check('the IME re-anchors after every text edit', /handleTextKey\(state\.text, key, ctrlDown, shiftDown\)\) \{\s*\n\s*syncImeToCaret\(\);/.test(overlay));
check('typing goes through one selection-aware mutation', /replaceTextSelection\(state\.text, String\.fromCharCode\(code\), pendingTextSize\(\)\)/.test(overlay));
check('text keeps an anchor and a cursor', /anchor: 0,\s*\n\s*cursor: 0,/.test(overlay));
check('Ctrl+A selects the whole string', /key === 0x41 \/\* A \*\/\) \{ selectAll\(\); return true; \}/.test(overlay));
check('typing replaces the selection', /function replaceTextSelection\(text, insert, size\)/.test(overlay) && /const candidate = text\.value\.slice\(0, from\)/.test(overlay));
check('text refuses to grow past the frame', /function textFitsFrame/.test(overlay) && /!textFitsFrame\(text, candidate, size\)/.test(overlay));
check('deleting is always allowed at the edge', /insert\.length > 0 && candidate\.length > text\.value\.length/.test(overlay));
check('a refused keystroke flashes the limit', /textOverflowAt = Date\.now\(\);/.test(overlay) && /OVERFLOW_TIMER_ID/.test(overlay));
check('the selection is painted before the glyphs', /hasTextSelection\(state\.text\)\) \{[\s\S]{0,400}fillRect\(hdc, from, state\.text\.y - 2/.test(overlay));
check('no caret while a range is selected', /!hasTextSelection\(state\.text\) && caretVisible\(caret\)/.test(overlay));
check('edit keys beat the overlay shortcuts', /if \(state\.text !== null && handleTextKey\(/.test(overlay));
check('a click inside the text moves the caret', /const at = textIndexAtX\(state\.text, x, size\);/.test(overlay));
check('the caret and the IME share one position helper', /function caretPosition/.test(overlay) && /const caret = caretPosition\(\);/.test(overlay));check('picking a colour keeps the panel open', /state\.colorIndex = styleHit\.value;\s*\n\s*api\.InvalidateRect/.test(overlay));
check('picking a tool closes the panel', /state\.tool = hit\.value;\s*\n\s*\/\/ Picking a tool is a commitment to drawing/.test(overlay));
check('a press outside the panel closes it and keeps going', /if \(state\.styleMenuOpen\) \{\s*\n\s*state\.styleMenuOpen = false;\s*\n\s*api\.InvalidateRect\(hwnd, null, false\);\s*\n\s*\/\//.test(overlay) && !/if \(state\.styleMenuOpen\) \{\s*\n\s*state\.styleMenuOpen = false;\s*\n\s*api\.InvalidateRect\(hwnd, null, false\);\s*\n\s*return 0;/.test(overlay));
check('the stroke width keeps its fraction', /return STROKE_MIN \+ fraction \* \(STROKE_MAX - STROKE_MIN\);/.test(overlay));
check('the readout rounds for display only', /String\(Math\.round\(state\.strokeWidth\)\)/.test(overlay));
check('a draught is clamped to the frame', /const inside = state\.sel === null \? \{ x, y \} :/.test(overlay));
check('the text tool shows an I-beam', /state\.tool === 'text' \? IDC_IBEAM : IDC_CROSS/.test(overlay));
check('the caret is a drawn bar, not a pipe glyph', /const caret = caretPosition\(\);/.test(overlay) && !/state\.text\.value \+ \(Math\.floor/.test(overlay));
check('the caret blinks at the system rate', /const CARET_INTERVAL = 530;/.test(overlay));
check('the caret blinks on a window timer', /SetTimer/.test(overlay) && /message === WM_TIMER/.test(overlay));
check('the caret timer stops when typing ends', /stopCaretBlink\(\);/.test(overlay));
check('GdipMeasureString writes into a Buffer', /const bound = Buffer\.alloc\(16\)/.test(overlay) && /bound\.readFloatLE\(8\)/.test(overlay));
check('the measurement out-param is void*, not RectF*', /void \*boundingBox, _Out_ int \*codepointsFitted/.test(overlay));
check('the frame border has its own predicate', /function hitsFrameEdge/.test(overlay));
check('a press inside the frame is canvas, not a frame drag', !/state\.sel !== null && state\.tool === 'move'/.test(overlay));
check('there are eight resize handles', /const HANDLES = \['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'\]/.test(overlay));
check('handles are drawn once the selection settles', /if \(!state\.dragging && sel\.w > 12/.test(overlay));
check('a press on a handle resizes instead of drawing', /hitHandle\(x, y, state\.sel\) !== null\) \{\s*\n\s*state\.dragging = true;/.test(overlay) && /mode: 'resize'/.test(overlay));
check('a press on an annotation picks it before moving the frame', /const index = annotationAt\(x, y\);\s*\n\s*if \(index !== -1\)/.test(overlay));
check('an annotation is pickable whatever the active tool', !/if \(state\.tool === 'move'\) \{\s*\n\s*const index = annotationAt/.test(overlay));
check('hits follow the drawn shape, not the box', /function hitsInk/.test(overlay) && /distanceToSegment/.test(overlay));
check('a rectangle interior is not grabbable', /nearVerticalEdge \|\| nearHorizontalEdge/.test(overlay));
check('an ellipse is tested as a curve', /Math\.abs\(normalised - 1\) <= slack/.test(overlay));
check('an annotation can be dragged on its own', /state\.annotGrab !== null/.test(overlay) && /moveAnnotation\(target, step\.dx, step\.dy\)/.test(overlay));
check('arrow keys nudge the picked annotation', /const stride = shiftDown \? 10 : 1;/.test(overlay) && /moveAnnotation\(target, step\.dx, step\.dy\)/.test(overlay));
check('the modifiers come from GetKeyState, not lParam', /api\.GetKeyState\(VK_CONTROL\)/.test(overlay));
check('a picked annotation shows a dashed frame', /function drawAnnotationFrame/.test(overlay) && /selectedAnnotation\(\)/.test(overlay));
check('Delete removes the picked annotation only', /pushAnnotationRemoval/.test(overlay) && /selectedAnnotation\(\) !== null\) \{\s*\n\s*const index/.test(overlay));
check('the mosaic export paints opaque pixels', /0xff000000 \| \(red << 16\)/.test(overlay));
check('the mosaic preview samples the real frame', /function averageFrameColor/.test(overlay) && /averageFrameColor\(bx, by/.test(overlay));
check('the toolbar has a copy button', /kind: 'copy'/.test(overlay));
check('the copy button sits before cancel', /kind: 'copy', width: 34 \}\);[\s\S]{0,120}kind: 'cancel'/.test(overlay));
check('the copy icon is a pair of sheets', /function drawCopyIcon/.test(overlay));
check('copying writes CF_DIB, not PNG', /const CF_DIB = 8;/.test(overlay) && /SetClipboardData\(CF_DIB/.test(overlay));
check('the clipboard block is filled by RtlMoveMemory', /RtlMoveMemory\(locked, koffi\.address\(block\), total\)/.test(overlay));
check('the clipboard block is not freed after a successful set', /if \(stored === null \|\| stored === undefined\) \{[\s\S]{0,120}GlobalFree\(memory\)/.test(overlay));
check('copy exits with its own code so nothing is inserted', /exitWith\(4\)/.test(overlay));
check('the host reports a copy distinctly', /copied: true/.test(host) && /result\.copied === true/.test(host));
check('the page stays silent on a copy', /response\.status === 204 \|\| response\.status === 202/.test(client));
check('no call to an undefined solidRect', !/solidRect\(/.test(overlay));
check('a flattened rectangle draws a line instead of vanishing', /w < 0\.5 \|\| h < 0\.5/.test(overlay));
check('a flattened ellipse draws a line too', /GdipDrawLine\(graphics, penHandle, x, y, x \+ w, y \+ h\)/.test(overlay));
check('the gesture works from the press-time rectangle', /state\.grab\.base/.test(overlay));
check('the grab is cleared on release', /state\.dragging = false;\s*\n\s*state\.grab = null;/.test(overlay));
check('the cursor advertises resize and move', /applyCursorFor/.test(overlay) && /HANDLE_CURSOR/.test(overlay));

console.log('single-row toolbar');
check('the toolbar is one row', !/function paramRowRect/.test(overlay) && !/TOOLBAR_ROW_GAP/.test(overlay));
check('one style button replaces the swatch row', /kind: 'style'/.test(overlay) && !/items\.push\(\{ kind: 'color'/.test(overlay));
check('the style button shows the current ink', /fillCircle\(hdc, cursorX \+ 14, cy, Math\.min\(6\.5, state\.strokeWidth/.test(overlay));
check('width and colour share one popup', /function stylePopupRect/.test(overlay) && /function hitStylePopup/.test(overlay));
check('the popup holds a width slider and a colour row', /function sliderTrack/.test(overlay) && /const colorRowY = widthRowY \+ SLIDER_BAND;/.test(overlay));
check('the slider is continuous, not stepped', /function widthFromSliderX/.test(overlay) && !/STROKE_WIDTHS/.test(overlay));
check('dragging the slider updates live', /state\.sliderDrag/.test(overlay) && /widthFromSliderX\(x\)/.test(overlay));
check('the slider shows its value', /drawText\(hdc, String\(Math\.round\(state\.strokeWidth\)\)/.test(overlay));

console.log('tooltips');
check('every toolbar entry has a label', /const TOOL_LABELS = \{/.test(overlay) && /mosaic: '马赛克'/.test(overlay));
check('the tooltip is anchored to its button', /centreX - pillW \/ 2/.test(overlay));
check('text is measured, not estimated', /function measureText/.test(overlay) && /GdipMeasureString/.test(overlay));
check('the popup takes clicks before the toolbar', /hitStylePopup\(x, y\)[\s\S]*?hitToolbar\(x, y\)/.test(overlay));
check('Escape closes the popup first', /if \(state\.styleMenuOpen\) state\.styleMenuOpen = false;/.test(overlay));
check('a text tool exists', /const TOOLS = \[[^\]]*'text'/.test(overlay));
check('a text tool has its own icon', /tool === 'text'/.test(overlay));
check('typing commits an annotation', /pushAnnotation\(\{\s*\n\s*type: 'text'/.test(overlay));
check('text carries its own size', /size: pending\.size \?\? textSizeFor\(state\.strokeWidth\)/.test(overlay));
check('the window class accepts double-clicks', /CS_DBLCLKS/.test(overlay) && /writeUInt32LE\(CS_DBLCLKS, 0\)/.test(overlay));
check('double-clicking text reopens it', /message === WM_LBUTTONDBLCLK/.test(overlay) && /beginEditingAnnotation\(index\)/.test(overlay));
check('editing lifts the annotation out and remembers where', /state\.annots\.splice\(index, 1\);\s*\n\s*state\.editIndex = index;/.test(overlay));
check('committing an edit puts it back in place', /const editing = state\.editIndex;/.test(overlay) && /state\.annots\.splice\(at, 0, restored\)/.test(overlay));
check('an edit keeps the original font size', /size: pending\.size \?\? textSizeFor/.test(overlay));
check('an edit is one undo step', /if \(editing !== -1\) \{\s*\n\s*state\.undoStack\.push/.test(overlay));
check('undo and redo exist', /function undo\(\)/.test(overlay) && /function redo\(\)/.test(overlay));
check('the confirm button is a green tick', /0xff22a559/.test(overlay) && /drawCheckIcon/.test(overlay));
check('the cancel button is red', /0xffd93a3a/.test(overlay));
check('both keep the shared white background', !/fillRoundRect\(hdc, cursorX \+ 3, buttonY, item\.width - 6, buttonH, 7, 0xff(22a559|f0f1f3)\)/.test(overlay));
check('a disabled undo is still visible', /enabled \? 0xff2b3442 : 0xffc2c8d0/.test(overlay));
check('the toolbar tracks what the pointer is over', /state\.hoverItem/.test(overlay));
check('hover and selection look different', /0x1a2f7cf6/.test(overlay) && /0x12000000/.test(overlay));
check('one function answers hover and clicks', /function toolbarItemAt/.test(overlay) && /return toolbarItemAt\(x, y\)/.test(overlay));
check('the bar carries exactly one undo button and no redo', /kind: 'undo'/.test(overlay) && !/kind: 'redo'/.test(overlay));
check('the undo icon is a hairpin, not a plain arrow', /turnX - radius,\s*\n\s*topY,/.test(overlay));
check('Ctrl+Y still walks the history forward', /else redo\(\);/.test(overlay));
check('a disabled entry is not hoverable', /function itemEnabled/.test(overlay) && /itemEnabled\(hitNow\) \? hitNow : null/.test(overlay));
check('a disabled entry draws no hover wash and no tooltip', /&& itemEnabled\(item\);/.test(overlay) && /!state\.styleMenuOpen && itemEnabled\(hovered\)/.test(overlay));
check('a mis-click keeps the existing frame', /state\.sel = state\.selBeforeChoose/.test(overlay));

console.log('composer handoff');
check('client targets the Lexical editor', /\[data-lexical-editor="true"\]/.test(client));
check('client builds a ClipboardEvent', /new ClipboardEvent\('paste'/.test(client));
check('client supplies dataTransfer', /dataTransfer: transfer/.test(client));
check('client supplies clipboardData', /clipboardData: transfer/.test(client));
check('a successful insert stays silent', !/status\.inserted/.test(client));
check('failures are still reported', /status\.insertFailed/.test(client) && /status\.failed/.test(client));

console.log('launcher affordance');
check('the button and caret form one pill', /\.dshshot-launch-wrap \{ position:relative; display:inline-flex/.test(client));
check('the whole pill highlights on hover', /\.dshshot-launch-wrap:hover \{ background:/.test(client));
check('the glyph lifts on hover', /\.dshshot-launcher:hover svg \{ transform:scale/.test(client));
check('pressing gives feedback', /\.dshshot-launcher:active \{ transform:scale/.test(client));
check('the button carries a scissors mark and a caret', /name: 'scissors'/.test(client) && /dshshot-launcher-caret/.test(client));
check('the menu follows the theme rather than forcing white',
  /background:var\(--dsw-specific-menu/.test(client) && !/\.dshshot-menu \{[^}]*background:#fff/.test(client));
check('the menu uses the host menu backdrop, not a hand-picked blur',
  /--dsw-menu-backdrop-filter/.test(client));
check('the menu offers one hide-window checkbox', /launcher\.hideSelf/.test(client) && !/launcher\.includeSelf/.test(client));
check('only real theme tokens are referenced', !/--dsw-alias-label-tertiary/.test(client));
check('focus is still visible for keyboards', /\.dshshot-launcher:focus-visible/.test(client));

console.log('shortcut');
check('the client reads the shortcut from preferences', /PREF_HOTKEY/.test(client));
check('the matcher rejects extra modifiers', /event\.ctrlKey === true/.test(client));
check('a bare key is not accepted', /modifiers\.size === 0/.test(client));
/*
 * No key recorder in the page any more.
 *
 * The shortcut is fixed and registered by the Host; the recorder UI (a click-then-press
 * widget in General settings) was removed with that settings row, so the page must not
 * carry its leftover state either.
 */
check('no leftover shortcut-recorder state', !/recordingHotkey/.test(client));

console.log('locale and artwork');
for (const [name, dict] of [['zh', zh], ['en', en]]) {
  check(`${name} has meta.title`, typeof dict.meta?.title === 'string' && dict.meta.title !== '', dict.meta?.title);
  check(`${name} has meta.description`, typeof dict.meta?.description === 'string' && dict.meta.description.length > 40);
  /*
   * When a locale declares a detail document, it must exist and be a single image line.
   * The document is optional now, so an omitted `meta.detail` is only an error if a file
   * was left behind pointing at nothing.
   */
  if (dict.meta?.detail !== undefined) {
    const body = await read(dict.meta.detail).catch(() => null);
    check(`${name} detail ${dict.meta.detail} exists and is one image line`,
      body !== null && body.trim() !== '' && body.trim().split('\n').length === 1);
  } else {
    check(`${name} declares no detail document (README fallback)`, true);
  }
}
check('icon is svg', icon.trimStart().startsWith('<svg'));
check('icon has a 36 viewBox', /viewBox="0 0 36 36"/.test(icon));
check('icon has no text element', !/<text/i.test(icon));

// Text matching cannot catch a reference to a variable that no longer exists.
console.log('host module loads');
try {
  const { apply } = await import(`file:///${join(root, 'index.js').replace(/\\/g, '/')}`);
  const paths = [];
  const webServer = {
    register(route) {
      paths.push(route.path);
      return () => {};
    },
  };
  const disposers = [];
  apply({
    webServer,
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
    },
    get: (name) => (name === 'webServer' ? webServer : undefined),
  });
  check('apply() completes without throwing', true);
  check('the snap route registers', paths.includes('/plugins/dsh-screenshot/snap'), JSON.stringify(paths));
  /*
   * The config route carries the global-shortcut handshake: the page posts the
   * combination it wants registered and the Host claims it from Windows.
   */
  check('the shortcut-config route registers', paths.includes('/plugins/dsh-screenshot/config'),
    JSON.stringify(paths));
  check('exactly two routes are registered', paths.length === 2, JSON.stringify(paths));
  check('the page hands its shortcut to the host', /syncGlobalHotkey/.test(client));
  /*
   * No shortcut row in General settings. The shortcut is a property of this feature, not
   * of the application, so it must not appear in the Host's general preferences page.
   */
  check('the general settings page is not touched', !/settings\.general\.item/.test(client)
    && !/HotkeySetting/.test(client));
  for (const dispose of disposers) dispose();
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  check('apply() completes without throwing', false, reason);
  check('the snap route registers', false, 'apply() threw');
  check('the shortcut-config route registers', false, 'apply() threw');
  check('exactly two routes are registered', false, 'apply() threw');
  check('the page hands its shortcut to the host', false, 'apply() threw');
  check('the general settings page is not touched', false, 'apply() threw');
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
