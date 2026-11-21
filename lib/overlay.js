/**
 * The screenshot overlay, as a real native window.
 *
 * Why this exists instead of drawing in the page:
 *
 * A web page cannot cover its own window frame or anything outside its window.
 * Every problem with the earlier page-based overlay followed from that one
 * constraint — the taskbar stayed on top, the title bar stayed clickable, and
 * making the page cover the screen required resizing the user's window in ways
 * that ended up in the screenshot.
 *
 * This process owns a topmost full-screen popup window. It freezes the captured
 * desktop by painting it, draws the selection frame and the toolbar itself, and
 * writes the finished PNG. The Harness window is hidden for the instant of the
 * capture (the composition is awaited, not guessed) and put back immediately, so
 * it never appears in the shot unless the user asks for it.
 *
 * It runs as a **child process**: the message pump must never run on the host's
 * thread, or DSH would freeze while the user drags.
 *
 * Protocol: `node overlay.js <output.png> [--include-self]`
 *   exit 0 — wrote the PNG
 *   exit 2 — the user cancelled
 *   exit 3 — could not write the PNG
 * On failure the reason goes to stderr.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

const outputPath = process.argv[2];
const includeSelf = process.argv.includes('--include-self');
/**
 * `--clipboard` sends the result to the clipboard instead of a file.
 *
 * The global shortcut is fired from another application, where there is no composer to
 * insert into and no request to answer — so confirming a shortcut capture puts the image
 * on the system clipboard, ready to paste. The button path is unchanged.
 */
const toClipboard = process.argv.includes('--clipboard');
/**
 * `--preview <path>` renders the overlay's own surface to a PNG and exits.
 *
 * Without it the only way to inspect the drawing is to photograph a window owned
 * by another process, which returns black for a GDI-painted topmost window. The
 * preview asks the real paint code to draw into a bitmap instead, so what it
 * captures is exactly what the user sees.
 */
const previewIndex = process.argv.indexOf('--preview');
const previewPath = previewIndex === -1 ? null : process.argv[previewIndex + 1];
const previewSelection = (() => {
  const at = process.argv.indexOf('--select');
  if (at === -1) return null;
  const parts = String(process.argv[at + 1] ?? '').split(',').map(Number);
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) return null;
  return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
})();
if (outputPath === undefined) {
  console.error('usage: node overlay.js <output.png> [--include-self]');
  process.exit(3);
}

// ------------------------------------------------------------------ FFI setup

function resolveKoffi() {
  const candidates = [];
  const installDir = process.env.DSH_INSTALL_DIR ?? '';
  if (installDir !== '') {
    const modules = dirname(dirname(installDir));
    candidates.push(join(modules, 'koffi'));
    candidates.push(join(modules.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`), 'koffi'));
  }
  // Walk up from this file: works for a plain install and for an unpacked asar.
  let cursor = here;
  for (let step = 0; step < 12; step += 1) {
    if (existsSync(join(cursor, 'node_modules', 'koffi'))) {
      candidates.push(join(cursor, 'node_modules', 'koffi'));
      break;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  for (const bin of [process.execPath, process.env.DSH_NODE_EXECUTABLE].filter(Boolean)) {
    const resources = join(dirname(bin), 'resources');
    candidates.push(join(resources, 'app.asar.unpacked', 'dsh', 'node_modules', 'koffi'));
    candidates.push(join(resources, 'dsh', 'node_modules', 'koffi'));
  }
  const seen = new Set();
  for (const base of candidates) {
    const key = base.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = join(base, 'index.cjs');
    if (!existsSync(entry)) continue;
    try {
      return require(entry);
    } catch {
      /* try the next one */
    }
  }
  throw new Error('the koffi FFI bundled with dsh could not be located');
}

const koffi = resolveKoffi();
const user32 = koffi.load('user32.dll');
/*
 * The foreground window, captured as early as an FFI call is possible.
 *
 * The overlay is a separate process, so from spawn to the app section there is a startup
 * delay; capturing the foreground here — before GDI+, the api table and the PNG tables are
 * set up — narrows the window in which something else could take focus, so the window
 * restored on exit is really the one the user was in.
 */
const foregroundAtStart = user32.func('void * __stdcall GetForegroundWindow()')();
const gdi32 = koffi.load('gdi32.dll');
const kernel32 = koffi.load('kernel32.dll');
const dwmapi = koffi.load('dwmapi.dll');
const imm32 = koffi.load('imm32.dll');
/**
 * GDI+ for the interface.
 *
 * Plain GDI cannot antialias, blend alpha, or draw a smooth rounded corner, which
 * is why the toolbar looked crude however carefully it was placed. GDI+ does all
 * three, so the overlay's chrome is drawn with it while the screenshot itself
 * stays on the fast `BitBlt` path.
 */
const gdiplus = koffi.load('gdiplus.dll');

/**
 * The rectangle GDI+ text layout takes, in floating-point.
 *
 * Declared as a real struct so koffi marshals it; passing a plain object to a
 * `void *` parameter fails at call time.
 */
const RectF = koffi.struct('RectF', {
  X: 'float',
  Y: 'float',
  Width: 'float',
  Height: 'float',
});

const api = {
  // window lifecycle
  RegisterClassW: user32.func('uint16_t __stdcall RegisterClassW(void *wndClass)'),
  CreateWindowExW: user32.func(
    'void * __stdcall CreateWindowExW(uint32_t exStyle, void *className, void *windowName, uint32_t style, '
    + 'int x, int y, int w, int h, void *parent, void *menu, void *instance, void *param)',
  ),
  DestroyWindow: user32.func('bool __stdcall DestroyWindow(void *hWnd)'),
  DefWindowProcW: user32.func('intptr_t __stdcall DefWindowProcW(void *h, uint32_t m, uintptr_t w, intptr_t l)'),
  ShowWindow: user32.func('bool __stdcall ShowWindow(void *hWnd, int command)'),
  UpdateWindow: user32.func('bool __stdcall UpdateWindow(void *hWnd)'),
  PeekMessageW: user32.func('bool __stdcall PeekMessageW(void *msg, void *hWnd, uint32_t min, uint32_t max, uint32_t remove)'),
  TranslateMessage: user32.func('bool __stdcall TranslateMessage(void *msg)'),
  DispatchMessageW: user32.func('intptr_t __stdcall DispatchMessageW(void *msg)'),
  PostQuitMessage: user32.func('void __stdcall PostQuitMessage(int code)'),
  PostMessageW: user32.func('bool __stdcall PostMessageW(void *hWnd, uint32_t msg, uintptr_t w, intptr_t l)'),
  InvalidateRect: user32.func('bool __stdcall InvalidateRect(void *hWnd, void *rect, bool erase)'),
  GetClientRect: user32.func('bool __stdcall GetClientRect(void *hWnd, void *rect)'),
  BeginPaint: user32.func('void * __stdcall BeginPaint(void *hWnd, void *paintStruct)'),
  EndPaint: user32.func('bool __stdcall EndPaint(void *hWnd, void *paintStruct)'),
  GetDC: user32.func('void * __stdcall GetDC(void *hWnd)'),
  ReleaseDC: user32.func('int __stdcall ReleaseDC(void *hWnd, void *hDC)'),
  SetCapture: user32.func('void * __stdcall SetCapture(void *hWnd)'),
  ReleaseCapture: user32.func('bool __stdcall ReleaseCapture()'),
  // Modifier state. A `WM_KEYDOWN` carries only the virtual-key code — the shift
  // and control bits live in the mouse messages, not the keyboard ones — so the
  // only way to know whether Ctrl is held is to ask. `GetKeyState` answers for the
  // thread that owns the message queue, which is this one.
  GetKeyState: user32.func('int16_t __stdcall GetKeyState(int key)'),
  GetSystemMetrics: user32.func('int __stdcall GetSystemMetrics(int index)'),
  SetCursor: user32.func('void * __stdcall SetCursor(void *cursor)'),
  LoadCursorW: user32.func('void * __stdcall LoadCursorW(void *instance, void *name)'),
  // window geometry, for stepping this application's own window aside
  EnumWindows: user32.func('bool __stdcall EnumWindows(void *callback, void *param)'),
  IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(void *hWnd)'),
  IsZoomed: user32.func('bool __stdcall IsZoomed(void *hWnd)'),
  IsIconic: user32.func('bool __stdcall IsIconic(void *hWnd)'),
  GetWindowThreadProcessId: user32.func('uint32_t __stdcall GetWindowThreadProcessId(void *hWnd, _Out_ uint32_t *pid)'),
  GetWindowRect: user32.func('bool __stdcall GetWindowRect(void *hWnd, _Out_ int *rect)'),
  SetWindowPos: user32.func('bool __stdcall SetWindowPos(void *hWnd, void *after, int x, int y, int cx, int cy, uint32_t flags)'),
  GetWindowTextW: user32.func('int __stdcall GetWindowTextW(void *hWnd, void *buffer, int count)'),
  GetClassNameW: user32.func('int __stdcall GetClassNameW(void *hWnd, void *buffer, int count)'),
  // Foreground restore: remember who was focused before the overlay and hand focus
  // back on exit, so a shortcut capture taken over another app does not leave the
  // Harness window in front.
  GetForegroundWindow: user32.func('void * __stdcall GetForegroundWindow()'),
  SetForegroundWindow: user32.func('bool __stdcall SetForegroundWindow(void *hWnd)'),
  IsWindow: user32.func('bool __stdcall IsWindow(void *hWnd)'),
  AttachThreadInput: user32.func('bool __stdcall AttachThreadInput(uint32_t idAttach, uint32_t idAttachTo, bool fAttach)'),
  BringWindowToTop: user32.func('bool __stdcall BringWindowToTop(void *hWnd)'),
  GetCurrentThreadId: kernel32.func('uint32_t __stdcall GetCurrentThreadId()'),
  // gdi
  CreateCompatibleDC: gdi32.func('void * __stdcall CreateCompatibleDC(void *hdc)'),
  CreateCompatibleBitmap: gdi32.func('void * __stdcall CreateCompatibleBitmap(void *hdc, int w, int h)'),
  SelectObject: gdi32.func('void * __stdcall SelectObject(void *hdc, void *obj)'),
  DeleteObject: gdi32.func('int __stdcall DeleteObject(void *obj)'),
  DeleteDC: gdi32.func('int __stdcall DeleteDC(void *hdc)'),
  BitBlt: gdi32.func('int __stdcall BitBlt(void *dst, int x, int y, int w, int h, void *src, int sx, int sy, uint32_t rop)'),
  GetDIBits: gdi32.func('int __stdcall GetDIBits(void *hdc, void *bmp, uint32_t start, uint32_t lines, void *bits, void *bmi, uint32_t usage)'),
  SetDIBitsToDevice: gdi32.func(
    'int __stdcall SetDIBitsToDevice(void *hdc, int xDest, int yDest, uint32_t w, uint32_t h, '
    + 'int xSrc, int ySrc, uint32_t startScan, uint32_t lines, void *bits, void *bmi, uint32_t usage)',
  ),
  CreateSolidBrush: gdi32.func('void * __stdcall CreateSolidBrush(uint32_t color)'),
  CreatePen: gdi32.func('void * __stdcall CreatePen(int style, int width, uint32_t color)'),
  // FillRect is exported by user32, not gdi32, even though it takes an HDC.
  FillRect: user32.func('int __stdcall FillRect(void *hdc, void *rect, void *brush)'),
  Rectangle: gdi32.func('bool __stdcall Rectangle(void *hdc, int l, int t, int r, int b)'),
  Ellipse: gdi32.func('bool __stdcall Ellipse(void *hdc, int l, int t, int r, int b)'),
  MoveToEx: gdi32.func('bool __stdcall MoveToEx(void *hdc, int x, int y, void *prev)'),
  LineTo: gdi32.func('bool __stdcall LineTo(void *hdc, int x, int y)'),
  SetTextColor: gdi32.func('uint32_t __stdcall SetTextColor(void *hdc, uint32_t color)'),
  SetBkMode: gdi32.func('int __stdcall SetBkMode(void *hdc, int mode)'),
  TextOutW: gdi32.func('bool __stdcall TextOutW(void *hdc, int x, int y, void *text, int count)'),
  CreateFontW: gdi32.func(
    'void * __stdcall CreateFontW(int height, int width, int escapement, int orientation, int weight, '
    + 'uint32_t italic, uint32_t underline, uint32_t strikeOut, uint32_t charSet, uint32_t outPrecision, '
    + 'uint32_t clipPrecision, uint32_t quality, uint32_t pitchAndFamily, void *face)',
  ),
  // kernel
  GetModuleHandleW: kernel32.func('void * __stdcall GetModuleHandleW(void *name)'),
  Sleep: kernel32.func('void __stdcall Sleep(uint32_t ms)'),
  // dwm
  DwmFlush: dwmapi.func('int __stdcall DwmFlush()'),
  /*
   * Clipboard.
   *
   * The image is handed over as a `CF_DIB` block, not as PNG: a PNG blob on the
   * clipboard is only understood by a few modern applications, while `CF_DIB` is what
   * Paint, Word, chat clients and the Snipping Tool all read. The cost is that the
   * pixels have to be laid out bottom-up with a 32-bit header, which is done below.
   */
  OpenClipboard: user32.func('bool __stdcall OpenClipboard(void *hWnd)'),
  CloseClipboard: user32.func('bool __stdcall CloseClipboard()'),
  EmptyClipboard: user32.func('bool __stdcall EmptyClipboard()'),
  SetClipboardData: user32.func('void * __stdcall SetClipboardData(uint32_t format, void *mem)'),
  GetClipboardData: user32.func('void * __stdcall GetClipboardData(uint32_t format)'),
  IsClipboardFormatAvailable: user32.func('bool __stdcall IsClipboardFormatAvailable(uint32_t format)'),
  // kernel32 heap, for the clipboard's movable global memory
  GlobalAlloc: kernel32.func('void * __stdcall GlobalAlloc(uint32_t flags, uintptr_t bytes)'),
  GlobalLock: kernel32.func('void * __stdcall GlobalLock(void *mem)'),
  GlobalUnlock: kernel32.func('bool __stdcall GlobalUnlock(void *mem)'),
  GlobalFree: kernel32.func('void * __stdcall GlobalFree(void *mem)'),
  /*
   * A raw memory copy, for filling a `GlobalLock`ed block.
   *
   * `koffi.encode` cannot write into a locked clipboard block: its first argument must
   * be a reference koffi can hand to the callee, and `GlobalLock` returns a bare
   * address, so `encode` either rejects it or silently writes somewhere else — which
   * is what produced a clipboard full of garbage. `RtlMoveMemory` takes plain
   * addresses on both sides, so it does exactly what is needed.
   */
  RtlMoveMemory: kernel32.func('void __stdcall RtlMoveMemory(void *dst, void *src, uintptr_t length)'),
  /*
   * IME positioning.
   *
   * The overlay draws its own text rather than using an edit control, so Windows
   * has nothing to anchor the input method's candidate window to and drops it in
   * the top-left corner of the screen — which is where the user saw the pinyin
   * choices appear, far away from the caret. Telling the IME where the composition
   * is fixes that.
   */
  ImmGetContext: imm32.func('void * __stdcall ImmGetContext(void *hwnd)'),
  // ImmReleaseContext is exported by imm32.dll, not user32 — probed, not assumed.
  ImmReleaseContext: imm32.func('bool __stdcall ImmReleaseContext(void *hwnd, void *himc)'),
  ImmSetCompositionWindow: imm32.func('bool __stdcall ImmSetCompositionWindow(void *himc, void *form)'),
  ImmAssociateContext: imm32.func('void * __stdcall ImmAssociateContext(void *hwnd, void *himc)'),
  /*
   * A window timer, used only to blink the text caret.
   *
   * Without a timer the caret would be painted once and then sit frozen, because
   * nothing invalidates the window while the user is thinking about what to type.
   */
  SetTimer: user32.func('uintptr_t __stdcall SetTimer(void *hwnd, uintptr_t id, uint32_t interval, void *proc)'),
  KillTimer: user32.func('bool __stdcall KillTimer(void *hwnd, uintptr_t id)'),
};

// ------------------------------------------------------------------- GDI+

/**
 * GDI+ entry points used for the interface chrome.
 *
 * Only `GdipCreateFromHDC` and friends are declared: the screenshot bitmap is
 * still moved with `BitBlt`, and GDI+ only ever touches the panel, the toolbar and
 * the annotation strokes, which is where smooth edges actually matter.
 */
const gdip = {
  GdiplusStartup: gdiplus.func('int __stdcall GdiplusStartup(_Out_ uintptr_t *token, void *input, void *output)'),
  GdipCreateFromHDC: gdiplus.func('int __stdcall GdipCreateFromHDC(void *hdc, _Out_ void **graphics)'),
  GdipDeleteGraphics: gdiplus.func('int __stdcall GdipDeleteGraphics(void *graphics)'),
  GdipSetSmoothingMode: gdiplus.func('int __stdcall GdipSetSmoothingMode(void *graphics, int mode)'),
  GdipSetInterpolationMode: gdiplus.func('int __stdcall GdipSetInterpolationMode(void *graphics, int mode)'),
  GdipSetTextRenderingHint: gdiplus.func('int __stdcall GdipSetTextRenderingHint(void *graphics, int hint)'),
  GdipSetPixelOffsetMode: gdiplus.func('int __stdcall GdipSetPixelOffsetMode(void *graphics, int mode)'),
  GdipCreateSolidFill: gdiplus.func('int __stdcall GdipCreateSolidFill(uint32_t color, _Out_ void **brush)'),
  GdipDeleteBrush: gdiplus.func('int __stdcall GdipDeleteBrush(void *brush)'),
  GdipCreatePen1: gdiplus.func('int __stdcall GdipCreatePen1(uint32_t color, float width, int unit, _Out_ void **pen)'),
  GdipDeletePen: gdiplus.func('int __stdcall GdipDeletePen(void *pen)'),
  GdipSetPenLineCap197819: gdiplus.func('int __stdcall GdipSetPenLineCap197819(void *pen, int startCap, int endCap, int dashCap)'),
  GdipSetPenLineJoin: gdiplus.func('int __stdcall GdipSetPenLineJoin(void *pen, int join)'),
  GdipCreatePath: gdiplus.func('int __stdcall GdipCreatePath(int fillMode, _Out_ void **path)'),
  GdipDeletePath: gdiplus.func('int __stdcall GdipDeletePath(void *path)'),
  GdipAddPathArc: gdiplus.func('int __stdcall GdipAddPathArc(void *path, float x, float y, float width, float height, float startAngle, float sweepAngle)'),
  GdipAddPathLine: gdiplus.func('int __stdcall GdipAddPathLine(void *path, float x1, float y1, float x2, float y2)'),
  GdipAddPathEllipse: gdiplus.func('int __stdcall GdipAddPathEllipse(void *path, float x, float y, float width, float height)'),
  GdipAddPathRectangle: gdiplus.func('int __stdcall GdipAddPathRectangle(void *path, float x, float y, float width, float height)'),
  GdipClosePathFigure: gdiplus.func('int __stdcall GdipClosePathFigure(void *path)'),
  GdipFillPath: gdiplus.func('int __stdcall GdipFillPath(void *graphics, void *brush, void *path)'),
  GdipDrawPath: gdiplus.func('int __stdcall GdipDrawPath(void *graphics, void *pen, void *path)'),
  GdipFillRectangleI: gdiplus.func('int __stdcall GdipFillRectangleI(void *graphics, void *brush, int x, int y, int w, int h)'),
  GdipFillEllipse: gdiplus.func('int __stdcall GdipFillEllipse(void *graphics, void *brush, float x, float y, float w, float h)'),
  GdipDrawLine: gdiplus.func('int __stdcall GdipDrawLine(void *graphics, void *pen, float x1, float y1, float x2, float y2)'),
  GdipCreateFontFamilyFromName: gdiplus.func('int __stdcall GdipCreateFontFamilyFromName(void *name, void *collection, _Out_ void **family)'),
  GdipDeleteFontFamily: gdiplus.func('int __stdcall GdipDeleteFontFamily(void *family)'),
  GdipCreateFont: gdiplus.func('int __stdcall GdipCreateFont(void *family, float size, int style, int unit, _Out_ void **font)'),
  GdipDeleteFont: gdiplus.func('int __stdcall GdipDeleteFont(void *font)'),
  GdipCreateStringFormat: gdiplus.func('int __stdcall GdipCreateStringFormat(int attributes, int16_t language, _Out_ void **format)'),
  GdipDeleteStringFormat: gdiplus.func('int __stdcall GdipDeleteStringFormat(void *format)'),
  GdipSetStringFormatAlign: gdiplus.func('int __stdcall GdipSetStringFormatAlign(void *format, int align)'),
  GdipSetStringFormatLineAlign: gdiplus.func('int __stdcall GdipSetStringFormatLineAlign(void *format, int align)'),
  GdipDrawString: gdiplus.func(
    'int __stdcall GdipDrawString(void *graphics, void *text, int length, void *font, RectF *layoutRect, void *format, void *brush)',
  ),
  /*
   * `boundingBox` is declared `void *` so the caller can pass a Buffer.
   *
   * With `RectF *` koffi marshals a JS object in but cannot copy the written struct
   * back, so the width came back as 0 for every string.
   */
  GdipMeasureString: gdiplus.func(
    'int __stdcall GdipMeasureString(void *graphics, void *text, int length, void *font, RectF *layoutRect, void *format, void *boundingBox, _Out_ int *codepointsFitted, _Out_ int *linesFilled)',
  ),
  GdipSetClipRectI: gdiplus.func('int __stdcall GdipSetClipRectI(void *graphics, int x, int y, int w, int h, int combineMode)'),
  GdipResetClip: gdiplus.func('int __stdcall GdipResetClip(void *graphics)'),
  /*
   * A world-space translation.
   *
   * The export draws into a bitmap that starts at the top-left of the *crop*, while
   * every annotation stores **screen** coordinates. Without a translation each
   * stroke lands offset by the crop origin — a 150,200 selection shifted every
   * annotation by 150,200 — which is what made an arrow appear to move 64 px when
   * the pointer moved 100.
   */
  GdipTranslateWorldTransform: gdiplus.func(
    'int __stdcall GdipTranslateWorldTransform(void *graphics, float dx, float dy, int order)',
  ),
};

/** GDI+ is started once for the life of the process. */
let gdiplusToken = null;

function startGdiplus() {
  if (gdiplusToken !== null) return;
  // GdiplusStartupInput: GdiplusVersion = 1, everything else zero.
  const input = Buffer.alloc(24);
  input.writeUInt32LE(1, 0);
  const token = Buffer.alloc(8);
  const status = gdip.GdiplusStartup(token, input, null);
  if (status !== 0) throw new Error(`GdiplusStartup failed with status ${status}`);
  gdiplusToken = token.readBigUInt64LE(0);
}

/** Run `body` with a GDI+ graphics object bound to `hdc`, smoothing enabled. */
function withGraphics(hdc, body) {
  startGdiplus();
  const out = Buffer.alloc(8);
  const status = gdip.GdipCreateFromHDC(hdc, out);
  if (status !== 0) throw new Error(`GdipCreateFromHDC failed with status ${status}`);
  const graphics = out.readBigUInt64LE(0);
  try {
    // Antialiased edges and high-quality text: the two settings that make the
    // difference between the previous stair-stepped look and this one.
    gdip.GdipSetSmoothingMode(graphics, 4 /* AntiAlias */);
    gdip.GdipSetInterpolationMode(graphics, 7 /* HighQualityBicubic */);
    gdip.GdipSetPixelOffsetMode(graphics, 4 /* Half */);
    gdip.GdipSetTextRenderingHint(graphics, 5 /* ClearTypeGridFit */);
    /*
     * Shift the coordinate system so screen coordinates land correctly on whatever
     * surface this is.
     *
     * The window's back buffer covers the whole screen, so the offset is zero there
     * and nothing changes. The export draws into a bitmap the size of the *crop*,
     * so the offset is the crop's origin — without it every annotation was drawn
     * that many pixels off, which is why a moved arrow looked like it had barely
     * moved.
     */
    if (drawOriginX !== 0 || drawOriginY !== 0) {
      // MatrixOrderPrepend: translate the existing (identity) transform.
      gdip.GdipTranslateWorldTransform(graphics, -drawOriginX, -drawOriginY, 0);
    }
    /*
     * The clip has to be applied *here*, in screen coordinates, before the world
     * transform above is accounted for.
     *
     * Every drawing helper opens its own GDI+ context, so a clip set on one context
     * had no effect on the next — which is why an early attempt at clipping the
     * annotations let ink spill across the frame anyway. Applying it in the single
     * factory every helper goes through is the only place it can hold.
     */
    if (clipRect !== null) {
      gdip.GdipSetClipRectI(
        graphics,
        Math.round(clipRect.x + drawOriginX),
        Math.round(clipRect.y + drawOriginY),
        Math.round(clipRect.w),
        Math.round(clipRect.h),
        0 /* CombineModeReplace */,
      );
    }
    return body(graphics);
  } finally {
    gdip.GdipDeleteGraphics(graphics);
  }
}

/**
 * The screen coordinate that maps to (0,0) of the current drawing surface.
 *
 * Zero everywhere except while `buildResult` composes the export, where the surface
 * is the crop rather than the whole screen. It is module state rather than a
 * parameter because every drawing helper takes an HDC and nothing else — threading
 * an origin through the whole paint stack would touch far more code than it is
 * worth for a value that is only ever non-zero inside one synchronous call.
 */
let drawOriginX = 0;
let drawOriginY = 0;

/**
 * The rectangle every drawing operation is confined to, in screen coordinates.
 *
 * Null means "no limit". It exists so ink cannot be painted on the dimmed desktop
 * outside the frame: that area is not part of the export, so anything drawn there
 * would be visible on screen and then missing from the saved image.
 */
let clipRect = null;

const toW = (text) => Buffer.from(`${text}\0`, 'utf16le');
const addrOf = (buffer) => koffi.address(buffer);

// ------------------------------------------------------------------ constants

const SM_CXSCREEN = 0;
const SM_CYSCREEN = 1;
const SRCCOPY = 0x00cc0020;
const DIB_RGB_COLORS = 0;
const BI_RGB = 0;
const WS_POPUP = 0x80000000;
const WS_VISIBLE = 0x10000000;
const WS_EX_TOPMOST = 0x00000008;
const PM_REMOVE = 1;
const WM_DESTROY = 0x0002;
const WM_PAINT = 0x000f;
const WM_ERASEBKGND = 0x0014;
const WM_KEYDOWN = 0x0100;
const WM_CHAR = 0x0102;
const WM_TIMER = 0x0113;
const WM_MOUSEMOVE = 0x0200;
const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;
const WM_RBUTTONDOWN = 0x0204;
const WM_RBUTTONUP = 0x0205;
/** Sent by DefWindowProc for a right-click; swallowed so no context menu appears. */
const WM_CONTEXTMENU = 0x007b;
const WM_LBUTTONDBLCLK = 0x0203;
const VK_ESCAPE = 0x1b;
const VK_RETURN = 0x0d;
const VK_BACK = 0x08;
const VK_DELETE = 0x2e;
const VK_HOME = 0x24;
const VK_END = 0x23;
const VK_LEFT = 0x25;
const VK_UP = 0x26;
const VK_RIGHT = 0x27;
const VK_DOWN = 0x28;
const VK_SHIFT = 0x10;
const VK_CONTROL = 0x11;

/**
 * Interface colours, as GDI+ ARGB (`0xAARRGGBB`).
 *
 * The interface is drawn entirely with GDI+, so every colour here needs a real
 * alpha byte. A `0x00......` value is fully transparent in GDI+ — that is not the
 * same as the GDI `COLORREF` that meant "opaque, with this RGB" — so the alpha is
 * always explicit.
 */
const COLOR_ACCENT = 0xff2f7cf6; // #2f7cf6
const COLOR_WHITE = 0xffffffff;
const COLOR_INK = 0xff111827;
/** Annotation palette: red, orange, blue, green, black. */
const PEN_COLORS = [0xffe63c3c, 0xfff5a623, 0xff2f7cf6, 0xff22b455, 0xff111111];

/**
 * Tools, in toolbar order.
 *
 * There is no separate "move" tool. Repositioning is a property of the thing under
 * the pointer rather than a mode: a press on a drawn annotation picks it up, and a
 * press on the frame's own edge slides the frame, both without changing tools.
 * Making the user switch modes first was a step that existed only because the
 * original hit-testing could not tell the two apart.
 */
const TOOLS = ['rect', 'ellipse', 'arrow', 'pen', 'text', 'mosaic'];

/**
 * Human labels for the toolbar, shown as a tooltip on hover.
 *
 * The interface has no text on its buttons — icons only, so the bar stays narrow —
 * which makes a tooltip the only place the names can live.
 */
const TOOL_LABELS = {
  rect: '矩形',
  ellipse: '椭圆',
  arrow: '箭头',
  pen: '画笔',
  text: '文字',
  mosaic: '马赛克',
  undo: '撤销 (Ctrl+Z)',
  copy: '复制到剪贴板',
  cancel: '取消 (Esc)',
  confirm: '完成 (Enter)',
  style: '颜色与粗细',
};

/**
 * The stroke-width range.
 *
 * A continuous slider replaced the three fixed steps: the useful range is narrow,
 * so a slider is more precise — the user can land on 3 or 5 — and dragging reads as
 * one gesture instead of three separate picks.
 */
const STROKE_MIN = 1;
const STROKE_MAX = 12;
/** Height of the slider's hit band inside the popup. */
const SLIDER_BAND = 30;
const SLIDER_TRACK = 118;
const SLIDER_KNOB_RADIUS = 7;

/** The eight resize handles, named by compass direction. */
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

// --------------------------------------------------------------- screen grab

/**
 * Copy the whole desktop into a **bottom-up** BGRA buffer.
 *
 * Bottom-up is GDI's native convention for both `GetDIBits` and
 * `SetDIBitsToDevice`, so the buffer stays in that form for drawing; only the PNG
 * export converts to top-down. Earlier versions flipped here *and* used a
 * negative-height header for drawing, which GDI refuses to render — the selection
 * came out solid black.
 */
function grabScreen() {
  const width = api.GetSystemMetrics(SM_CXSCREEN);
  const height = api.GetSystemMetrics(SM_CYSCREEN);
  const screen = api.GetDC(null);
  const memory = api.CreateCompatibleDC(screen);
  const bitmap = api.CreateCompatibleBitmap(screen, width, height);
  const previous = api.SelectObject(memory, bitmap);
  try {
    if (api.BitBlt(memory, 0, 0, width, height, screen, 0, 0, SRCCOPY) === 0) {
      throw new Error('BitBlt failed');
    }
    const bits = Buffer.alloc(width * 4 * height);
    const header = Buffer.alloc(40);
    header.writeUInt32LE(40, 0);
    header.writeInt32LE(width, 4);
    // Positive: bottom-up, the convention every GDI call below expects.
    header.writeInt32LE(height, 8);
    header.writeUInt16LE(1, 12);
    header.writeUInt16LE(32, 14);
    header.writeUInt32LE(BI_RGB, 16);
    if (api.GetDIBits(memory, bitmap, 0, height, bits, header, DIB_RGB_COLORS) !== height) {
      throw new Error('GetDIBits failed');
    }
    return { width, height, bits };
  } finally {
    api.SelectObject(memory, previous);
    api.DeleteObject(bitmap);
    api.DeleteDC(memory);
    api.ReleaseDC(null, screen);
  }
}

/**
 * Step the Harness window aside so it is not in the shot.
 *
 * Moving is used rather than hiding: hiding leaves the window's pixels fading
 * into the capture, and the failure mode (a window that never comes back) is
 * much worse than a window that has to be nudged back. The rectangle and the
 * maximized state are restored afterwards.
 */
function stepAsideOwnWindow(foreground) {
  const family = new Set([process.pid, process.ppid]);
  const pidOut = [0];
  const titleBuffer = Buffer.alloc(512);
  const nameBuffer = Buffer.alloc(256);
  const rect = [0, 0, 0, 0];
  const shellSurfaces = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd']);
  let target = null;
  let bestArea = 0;

  const prototype = koffi.pointer(koffi.proto('bool __stdcall EnumProc(void *h, long l)'));
  const callback = koffi.register((hwnd) => {
    try {
      if (!api.IsWindowVisible(hwnd)) return true;
      nameBuffer.fill(0);
      const nameLength = api.GetClassNameW(hwnd, nameBuffer, 128);
      if (nameLength > 0) {
        const name = nameBuffer.subarray(0, nameLength * 2).toString('utf16le');
        if (shellSurfaces.has(name)) return true;
      }
      rect[0] = 0;
      rect[1] = 0;
      rect[2] = 0;
      rect[3] = 0;
      if (!api.GetWindowRect(hwnd, rect)) return true;
      const area = (rect[2] - rect[0]) * (rect[3] - rect[1]);
      if (area <= 0) return true;
      pidOut[0] = 0;
      api.GetWindowThreadProcessId(hwnd, pidOut);
      const owned = family.has(pidOut[0]);
      if (!owned && area <= bestArea) return true;
      if (!owned) {
        // Fall back to the window title, which is how an ancestor chain that
        // does not surface the app process still finds the right window.
        titleBuffer.fill(0);
        const titleLength = api.GetWindowTextW(hwnd, titleBuffer, 256);
        const title = titleLength > 0 ? titleBuffer.subarray(0, titleLength * 2).toString('utf16le') : '';
        if (!title.toLowerCase().includes('deepseek harness')) return true;
      }
      if (area > bestArea) {
        bestArea = area;
        target = hwnd;
      }
      return true;
    } catch {
      return true;
    }
  }, prototype);

  try {
    api.EnumWindows(callback, null);
  } finally {
    koffi.unregister(callback);
  }
  if (target === null) return null;
  logFocus(`stepAside target=${target} [${describeWindow(target)}] fg=${foreground} matches=${target === foreground}`);

  /*
   * Only step aside when the Harness window is the one in front.
   *
   * A shortcut capture fires while some other application is foreground; the Harness
   * window is behind it and cannot appear in the shot. Moving it anyway was actively
   * harmful: restoring a maximized window (`ShowWindow(SW_RESTORE)`) activates it, so the
   * Harness window jumped to the front mid-capture and the shot came out showing the
   * Harness window instead of the app the user was in. The button path never hit this
   * because the Harness window already had focus there.
   *
   * If it is not the foreground window, leave it alone — it is not in the picture.
   */
  if (target !== foreground) return null;

  /*
   * Minimize rather than move.
   *
   * The old approach moved the window to `x = primaryWidth + 80`. On a multi-monitor
   * desktop that lands on the *next* monitor, so the window never actually left the
   * screen: it stayed visible (and in the virtual-desktop grab), and the user watched it
   * jump sideways and back. Minimizing removes it from every monitor and is confirmed
   * with `IsIconic` before the grab, so the shot cannot contain it.
   */
  if (api.IsIconic(target)) return null; // already minimized: nothing to hide or restore

  const wasMaximized = api.IsZoomed(target);
  api.ShowWindow(target, 6 /* SW_MINIMIZE */);
  let minimized = false;
  for (let step = 0; step < 20; step += 1) {
    if (api.IsIconic(target)) { minimized = true; break; }
    api.Sleep(10);
  }
  api.DwmFlush();
  if (!minimized) return null;
  return { hwnd: target, wasMaximized };
}

/** Put the window back the way it was: restored, keeping its maximized state. */
function restoreOwnWindow(saved) {
  if (saved === null) return;
  // SW_RESTORE un-minimizes and returns the window to its previous size (maximized stays
  // maximized), so a separate maximize call is not needed and would lose the position.
  api.ShowWindow(saved.hwnd, 9 /* SW_RESTORE */);
}

// ------------------------------------------------------------------ PNG encode

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/**
 * Encode a **top-down** BGRA region into a PNG.
 *
 * The buffer convention is fixed by `grabScreen`, so this takes a plain origin
 * and reads rows forward. PNG scanlines are top-down too, which is why no flip
 * appears here.
 */
function encodePng(width, height, bits, options = {}) {
  const {
    originX = 0,
    originY = 0,
    stride = width,
  } = options;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let offset = 0;
  for (let row = 0; row < height; row += 1) {
    raw[offset] = 0;
    offset += 1;
    const base = ((originY + row) * stride + originX) * 4;
    for (let column = 0; column < width; column += 1) {
      const at = base + column * 4;
      raw[offset] = bits[at + 2];
      raw[offset + 1] = bits[at + 1];
      raw[offset + 2] = bits[at];
      offset += 3;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 3 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------- the app

/*
 * Who had focus just before the overlay exists.
 *
 * A shortcut capture fires while some other application is in front. Windows does not
 * reliably hand focus back to that window once this overlay is destroyed, so the user
 * saw the Harness window jump to the front afterwards. Remembering the window here and
 * restoring it on exit fixes that for both the shortcut and the button paths.
 */
const foregroundBefore = foregroundAtStart ?? api.GetForegroundWindow();

/** Class and title of a window, for the focus log. */
function describeWindow(hwnd) {
  if (hwnd === null || hwnd === undefined) return '(none)';
  try {
    const name = Buffer.alloc(256);
    const n = api.GetClassNameW(hwnd, name, 128);
    const cls = n > 0 ? name.subarray(0, n * 2).toString('utf16le') : '';
    const title = Buffer.alloc(512);
    const t = api.GetWindowTextW(hwnd, title, 256);
    const text = t > 0 ? title.subarray(0, t * 2).toString('utf16le') : '';
    return `${cls} | ${text}`;
  } catch {
    return '(error)';
  }
}

/**
 * Append one line to a diagnostic log next to the temp files.
 *
 * Focus behaviour cannot be unit-tested (it needs a real second application and a real
 * keypress), so the overlay records enough to tell *why* focus ended up somewhere: who was
 * in front when it opened, which window it targeted, and what it restored to. The file is
 * small and capped by rotating on size.
 */
function logFocus(message) {
  try {
    const { appendFileSync, statSync, writeFileSync } = require('node:fs');
    const { join } = require('node:path');
    const { tmpdir } = require('node:os');
    const file = join(tmpdir(), 'dsh-screenshot-focus.log');
    try {
      if (statSync(file).size > 64 * 1024) writeFileSync(file, '');
    } catch {
      /* first write */
    }
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
  } catch {
    /* logging must never break capture */
  }
}

logFocus(`open includeSelf=${includeSelf} fg=${foregroundBefore} [${describeWindow(foregroundBefore)}]`);

// Hide this window for the capture, unless the caller asked to keep it.
const savedWindow = includeSelf ? null : stepAsideOwnWindow(foregroundBefore);
let frame;
try {
  frame = grabScreen();
} finally {
  restoreOwnWindow(savedWindow);
}

const { width: screenWidth, height: screenHeight, bits } = frame;
const stride = screenWidth;

/**
 * The bitmap header describing the raw frame buffer.
 *
 * **Positive height, i.e. bottom-up.** `SetDIBitsToDevice` requires a positive
 * `biHeight`; a top-down DIB makes it draw nothing, which the user saw as the
 * selection filling with solid black. The buffer therefore stays in GDI's native
 * bottom-up form, and the flip to top-down happens only when encoding the PNG.
 */
const bim = Buffer.alloc(40);
bim.writeUInt32LE(40, 0);
bim.writeInt32LE(screenWidth, 4);
bim.writeInt32LE(screenHeight, 8);
bim.writeUInt16LE(1, 12);
bim.writeUInt16LE(32, 14);
bim.writeUInt32LE(BI_RGB, 16);

/**
 * Render a bottom-up DIB into a device-dependent bitmap.
 *
 * Working through a DDB is what makes the rest of the drawing tractable: once the
 * frame lives in a bitmap, every copy is a plain `BitBlt` with a top-left origin
 * and a size, and GDI handles the row order itself. Passing DIB headers around
 * with hand-computed scanline indices is where the black selection and the
 * upside-down export both came from.
 */
function dibToBitmap(dibBits, header, width, height) {
  const screenDc = api.GetDC(null);
  try {
    const memory = api.CreateCompatibleDC(screenDc);
    const bitmap = api.CreateCompatibleBitmap(screenDc, width, height);
    const previous = api.SelectObject(memory, bitmap);
    const blitHeader = Buffer.from(header);
    blitHeader.writeInt32LE(height, 8);
    const written = api.SetDIBitsToDevice(
      memory, 0, 0, width, height,
      0, 0, 0, height, dibBits, blitHeader, DIB_RGB_COLORS,
    );
    if (written !== height) {
      api.SelectObject(memory, previous);
      api.DeleteObject(bitmap);
      api.DeleteDC(memory);
      throw new Error(`SetDIBitsToDevice wrote ${written} of ${height} scanlines`);
    }
    // The screen DC is no longer needed: the bitmap is already compatible with it
    // and holds its own pixels. Releasing it here used to be skipped, which leaked
    // a DC per frame and eventually made later captures read back blank.
    return { memory, bitmap, previous };
  } finally {
    api.ReleaseDC(null, screenDc);
  }
}

/** Release what `dibToBitmap` allocated. */
function releaseFrameBitmap(frame) {
  api.SelectObject(frame.memory, frame.previous);
  api.DeleteObject(frame.bitmap);
  api.DeleteDC(frame.memory);
}

/**
 * The frame and its dimmed copy, as device-dependent bitmaps.
 *
 * Built once at startup. Every later operation is a `BitBlt` between bitmaps,
 * which is both faster and free of the row-order pitfalls that come with keeping
 * the frame as a raw DIB buffer.
 */
const frameBitmap = dibToBitmap(bits, bim, screenWidth, screenHeight);
const dimmedFrame = (() => {
  const dimBits = Buffer.alloc(bits.length);
  for (let i = 0; i < bits.length; i += 4) {
    dimBits[i] = (bits[i] * 0.42) | 0;
    dimBits[i + 1] = (bits[i + 1] * 0.42) | 0;
    dimBits[i + 2] = (bits[i + 2] * 0.42) | 0;
    dimBits[i + 3] = 255;
  }
  return dibToBitmap(dimBits, bim, screenWidth, screenHeight);
})();

/**
 * The off-screen surface every frame is composed on.
 *
 * Painting directly to the window meant a cleared background was visible between
 * the first and last draw call, which is what flickered. Composing here and
 * blitting once removes the intermediate states entirely.
 */
const backBuffer = (() => {
  const screenDc = api.GetDC(null);
  try {
    const memory = api.CreateCompatibleDC(screenDc);
    const bitmap = api.CreateCompatibleBitmap(screenDc, screenWidth, screenHeight);
    const previous = api.SelectObject(memory, bitmap);
    return { memory, bitmap, previous };
  } finally {
    api.ReleaseDC(null, screenDc);
  }
})();

/**
 * Compose one whole frame into `hdc`.
 *
 * Kept for the preview and the export, which need a complete image without
 * going through the window. The window paints through the same steps, so what
 * these produce and what the user sees cannot drift apart.
 */
function paint(hdc) {
  api.BitBlt(hdc, 0, 0, screenWidth, screenHeight, dimmedFrame.memory, 0, 0, SRCCOPY);
  const sel = state.sel;
  if (sel !== null && sel.w > 0 && sel.h > 0) {
    const x = Math.max(0, Math.round(sel.x));
    const y = Math.max(0, Math.round(sel.y));
    const w = Math.min(screenWidth - x, Math.round(sel.w));
    const h = Math.min(screenHeight - y, Math.round(sel.h));
    if (w > 0 && h > 0) api.BitBlt(hdc, x, y, w, h, frameBitmap.memory, x, y, SRCCOPY);
  }
  drawOverlay(hdc);
  try {
    drawFeedback(hdc);
  } catch {
    /* the toast is cosmetic; never let it break painting the capture */
  }
}

const state = {
  dragging: false,
  choosing: false,
  startX: 0,
  startY: 0,
  sel: null,
  /**
   * The in-flight move or resize of an existing selection, or null.
   *
   * Holds the rectangle as it was at press time plus where the press happened, so
   * the whole gesture is computed from one origin and cannot accumulate drift.
   */
  grab: null,
  /**
   * The active drawing tool, or null before one is chosen.
   *
   * `null` is a real state, not a placeholder: right after the frame is dragged out
   * there is nothing to draw with yet, so the whole interior is still "the thing
   * being positioned" and a press anywhere inside slides the frame. Picking a tool
   * is what turns the interior into canvas — from then on the frame is moved by its
   * border, so shapes can be placed anywhere without the frame sliding away.
   */
  tool: null,
  colorIndex: 0,
  /** Stroke width in pixels; applies to every drawing tool. */
  strokeWidth: 4,
  /** Whether the stroke-width and colour popup is showing. */
  styleMenuOpen: false,
  /** Whether the pointer is dragging the width slider. */
  sliderDrag: false,
  /**
   * The selection as it was before the current drag started.
   *
   * A press outside the frame starts a candidate new one; if the release is too
   * small to be a real selection this is put back, so a stray click never destroys
   * the frame and annotations the user already has.
   */
  selBeforeChoose: null,
  /**
   * The annotation the user has picked out, or -1.
   *
   * This is what makes an arrow separately movable: the selection rectangle can
   * only move the whole picture, so a second, per-annotation selection is needed to
   * pick one stroke back up after it has been drawn. It is an index rather than a
   * reference because undo replaces the list wholesale, and a stale reference would
   * keep editing an object that is no longer on screen.
   */
  selectedAnnotation: -1,
  /** Where a press on a picked annotation started, so the drag cannot drift. */
  annotGrab: null,
  /**
   * Undo history of the annotation list.
   *
   * `redoStack` has no button — the bar carries a single undo control — but Ctrl+Y
   * still walks it forward, so a mistaken undo is recoverable without spending bar
   * space on a second arrow.
   */
  undoStack: [],
  redoStack: [],
  annots: [],
  draft: null,
  text: null,
  /**
   * The index an edited annotation came from, or -1 when the text is new.
   *
   * An annotation is lifted out of the list while it is being edited so there is one
   * code path for "text being typed"; this remembers where to put it back.
   */
  editIndex: -1,
  done: false,
  cancelled: false,
  cursor: { x: 0, y: 0 },
  /** The toolbar entry under the pointer, for the hover highlight. */
  hoverItem: null,
};

const TOOLBAR_HEIGHT = 40;
const TOOLBAR_GAP = 10;

/** Where the toolbar sits, given the current selection. */
function toolbarRect() {
  const width = toolbarWidth();
  const sel = state.sel;
  let anchorX = sel === null ? Math.round(screenWidth / 2 - width / 2) : Math.round(sel.x + sel.w - width);
  let anchorY = sel === null ? Math.round(screenHeight / 2) : Math.round(sel.y + sel.h + TOOLBAR_GAP);
  anchorX = Math.max(8, Math.min(anchorX, screenWidth - width - 8));
  if (anchorY + TOOLBAR_HEIGHT > screenHeight - 8) {
    anchorY = Math.max(8, sel === null ? 8 : sel.y - TOOLBAR_HEIGHT - TOOLBAR_GAP);
  }
  return { x: anchorX, y: anchorY, w: width, h: TOOLBAR_HEIGHT };
}

/**
 * The toolbar: one row, with the style controls behind a single button.
 *
 * A second permanent row of swatches made the bar twice as tall for controls that
 * are used occasionally. Both stroke width and colour now live in one popup, opened
 * from the button that shows the current choice — which is how the tools this
 * imitates arrange it, and it keeps the bar only as wide as the tools themselves.
 */
function toolbarItems() {
  const items = [];
  for (const tool of TOOLS) items.push({ kind: 'tool', value: tool, width: 34 });
  items.push({ kind: 'sep', width: 13 });
  items.push({ kind: 'style', width: 46 });
  items.push({ kind: 'sep', width: 13 });
  items.push({ kind: 'undo', width: 32 });
  items.push({ kind: 'sep', width: 13 });
  items.push({ kind: 'copy', width: 34 });
  items.push({ kind: 'cancel', width: 34 });
  items.push({ kind: 'confirm', width: 34 });
  return items;
}

/**
 * The average colour of a rectangle of the captured frame, as opaque GDI+ ARGB.
 *
 * The mosaic preview needs the real pixels underneath to look like the export.
 * `bits` holds the raw capture, bottom-up BGRA, which is why the row is read
 * through `screenHeight - 1 - y`: that is the one place the flip is visible, and
 * getting it wrong made the preview sample a vertically mirrored patch.
 */
function averageFrameColor(x, y, w, h) {
  const left = Math.max(0, Math.round(x));
  const top = Math.max(0, Math.round(y));
  const right = Math.min(screenWidth, Math.round(x + w));
  const bottom = Math.min(screenHeight, Math.round(y + h));
  if (right <= left || bottom <= top) return 0xff808080;

  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  // One sample every few pixels: averaging a 10 px cell in full is thousands of
  // reads per cell and changes the colour imperceptibly.
  const stepY = Math.max(1, Math.floor((bottom - top) / 4));
  const stepX = Math.max(1, Math.floor((right - left) / 4));
  for (let sy = top; sy < bottom; sy += stepY) {
    const row = (screenHeight - 1 - sy) * stride;
    for (let sx = left; sx < right; sx += stepX) {
      const at = (row + sx) * 4;
      b += bits[at];
      g += bits[at + 1];
      r += bits[at + 2];
      count += 1;
    }
  }
  if (count === 0) return 0xff808080;
  return 0xff000000 | (((r / count) | 0) << 16) | (((g / count) | 0) << 8) | ((b / count) | 0);
}

/**
 * Whether a toolbar entry can do anything right now.
 *
 * Only undo can be unavailable: with an empty history there is nothing to step
 * back to. It stays visible in its grey ink so the bar does not change width, but
 * a disabled control must not answer the pointer either — hovering it would light
 * it up and name a tooltip for an action that cannot run.
 */
function itemEnabled(item) {
  if (item.kind === 'undo') return state.undoStack.length > 0;
  return true;
}

/** Total width of a row of items. */
function rowWidth(items) {
  return items.reduce((total, item) => total + item.width, 0) + 14;
}

function toolbarWidth() {
  return rowWidth(toolbarItems());
}

/**
 * The style popup: a stroke-width slider on top, the colour row below.
 *
 * One panel rather than two keeps the number of surfaces the user has to dismiss
 * down, and both settings are almost always changed together.
 */
function stylePopupRect() {
  const bar = toolbarRect();
  const width = Math.max(168, SLIDER_TRACK + 56, PEN_COLORS.length * 32 + 20);
  const height = SLIDER_BAND * 2 + 12;

  // Anchor under the style button, clamped to the screen.
  let buttonX = bar.x + 7;
  for (const item of toolbarItems()) {
    if (item.kind === 'style') break;
    buttonX += item.width;
  }
  const x = Math.max(8, Math.min(buttonX - 8, screenWidth - width - 8));
  const below = bar.y + bar.h + 6;
  const y = below + height <= screenHeight - 8 ? below : Math.max(8, bar.y - height - 6);
  return { x, y, w: width, h: height };
}

/** Where the slider's groove starts and ends, in screen coordinates. */
function sliderTrack() {
  const popup = stylePopupRect();
  const left = popup.x + 14 + SLIDER_KNOB_RADIUS;
  return {
    left,
    right: left + SLIDER_TRACK,
    centreY: popup.y + 6 + SLIDER_BAND / 2,
  };
}

/**
 * Map an x coordinate to a stroke width on the slider.
 *
 * Kept as a fraction of one pixel — no rounding.
 *
 * The rounded version stepped through 12 discrete values across 118 px of track,
 * so the knob jumped ~10 px at a time however smoothly the pointer moved. That is
 * what "不够丝滑" describes. A float width draws every intermediate stroke
 * thickness smoothly, and the readout rounds for display only.
 */
function widthFromSliderX(x) {
  const track = sliderTrack();
  const fraction = Math.max(0, Math.min(1, (x - track.left) / (track.right - track.left)));
  return STROKE_MIN + fraction * (STROKE_MAX - STROKE_MIN);
}

/** Map a stroke width back to the knob's x coordinate. */
function sliderXFromWidth(width) {
  const track = sliderTrack();
  const fraction = (width - STROKE_MIN) / (STROKE_MAX - STROKE_MIN);
  return track.left + Math.max(0, Math.min(1, fraction)) * (track.right - track.left);
}

/**
 * Resolve a press inside the style popup.
 * @returns {{ kind: 'width', value: number } | { kind: 'color', value: number } | { kind: 'widthDrag' } | null}
 */
function hitStylePopup(x, y) {
  if (!state.styleMenuOpen) return null;
  const popup = stylePopupRect();
  if (x < popup.x || x > popup.x + popup.w || y < popup.y || y > popup.y + popup.h) return null;

  const widthRowY = popup.y + 6;
  const colorRowY = widthRowY + SLIDER_BAND;
  if (y >= widthRowY && y < widthRowY + SLIDER_BAND) {
    // Anywhere on this band starts a drag, not just on the knob: aiming at a 14 px
    // handle is the kind of precision a slider exists to avoid.
    return { kind: 'widthDrag', value: widthFromSliderX(x) };
  }
  if (y >= colorRowY && y < colorRowY + SLIDER_BAND) {
    const index = Math.floor((x - popup.x - 10) / 32);
    if (index >= 0 && index < PEN_COLORS.length) return { kind: 'color', value: index };
    return null;
  }
  return null;
}

/** How close the pointer must be to a handle to grab it, in pixels. */
const HANDLE_RADIUS = 7;

/** The centre of one resize handle on a rectangle. */
function handlePoint(rect, handle) {
  const centreX = rect.x + rect.w / 2;
  const centreY = rect.y + rect.h / 2;
  const right = rect.x + rect.w;
  const bottom = rect.y + rect.h;
  switch (handle) {
    case 'nw': return { x: rect.x, y: rect.y };
    case 'n': return { x: centreX, y: rect.y };
    case 'ne': return { x: right, y: rect.y };
    case 'e': return { x: right, y: centreY };
    case 'se': return { x: right, y: bottom };
    case 's': return { x: centreX, y: bottom };
    case 'sw': return { x: rect.x, y: bottom };
    default: return { x: rect.x, y: centreY };
  }
}

/** Which handle, if any, the pointer is on. */
function hitHandle(x, y, rect) {
  if (rect === null) return null;
  for (const handle of HANDLES) {
    const anchor = handlePoint(rect, handle);
    if (Math.abs(x - anchor.x) <= HANDLE_RADIUS && Math.abs(y - anchor.y) <= HANDLE_RADIUS) return handle;
  }
  return null;
}

/** Whether a point is inside a rectangle. */
function insideRect(x, y, rect) {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

/**
 * The bounding box of an annotation, or null if it has none.
 *
 * Every annotation stores its own extent differently — a rectangle has two
 * corners, a pen stroke has a point list, text has an anchor and a measured width
 * — so this normalises them into one box. That box is what hit-testing and the
 * selection outline are built on, and having a single source keeps the highlight
 * and the clickable area from disagreeing.
 */
function annotationBounds(item) {
  if (item === null || item === undefined) return null;
  if (item.type === 'pen') {
    const points = item.points ?? [];
    if (points.length === 0) return null;
    let left = points[0].x;
    let right = points[0].x;
    let top = points[0].y;
    let bottom = points[0].y;
    for (const point of points) {
      left = Math.min(left, point.x);
      right = Math.max(right, point.x);
      top = Math.min(top, point.y);
      bottom = Math.max(bottom, point.y);
    }
    // A stroke is a line, so pad by its width: a one-pixel-tall horizontal pen
    // stroke would otherwise have a zero-height box that nothing can be inside.
    const pad = Math.max(2, (item.width ?? 2) / 2);
    return { x: left - pad, y: top - pad, w: right - left + pad * 2, h: bottom - top + pad * 2 };
  }
  if (item.type === 'text') {
    const size = item.size ?? 18;
    const width = measureText(item.text ?? '', size);
    return { x: item.x1, y: item.y1 - 2, w: Math.max(6, width), h: size * 1.35 };
  }
  const left = Math.min(item.x1, item.x2);
  const right = Math.max(item.x1, item.x2);
  const top = Math.min(item.y1, item.y2);
  const bottom = Math.max(item.y1, item.y2);
  const pad = Math.max(2, (item.width ?? 2) / 2);
  return { x: left - pad, y: top - pad, w: right - left + pad * 2, h: bottom - top + pad * 2 };
}

/**
 * Whether a point is on the ink of an annotation, as opposed to inside its box.
 *
 * A bounding box is the wrong shape for this. An arrow runs corner to corner
 * through its box, so most of that box is empty paper — testing the box meant the
 * pointer turned into a move cursor over a large empty area, and the user rightly
 * reported that the indication should follow the drawn shape, not the rectangle
 * around it.
 *
 * Each type is therefore tested against the geometry it actually draws, with a
 * tolerance of half the stroke width plus a couple of pixels: a 2 px line is not
 * something anyone can hit exactly.
 *
 * @param {object} item the annotation
 * @param {number} x screen x
 * @param {number} y screen y
 * @returns {boolean} true when the point lands on the drawn shape
 */
function hitsInk(item, x, y) {
  // Half the stroke, plus a floor so thin strokes and text stay grabbable.
  const tolerance = Math.max(3, (item.width ?? 2) / 2 + 1.5);

  if (item.type === 'pen') {
    const points = item.points ?? [];
    for (let index = 1; index < points.length; index += 1) {
      if (distanceToSegment(x, y, points[index - 1], points[index]) <= tolerance) return true;
    }
    // A single-point pen stroke is a dot.
    if (points.length === 1) {
      return Math.hypot(x - points[0].x, y - points[0].y) <= tolerance;
    }
    return false;
  }

  if (item.type === 'text') {
    // Text is a block of glyphs with no meaningful outline to follow, so its box
    // is honestly the right test.
    const bounds = annotationBounds(item);
    return bounds !== null && insideRect(x, y, bounds);
  }

  const left = Math.min(item.x1, item.x2);
  const right = Math.max(item.x1, item.x2);
  const top = Math.min(item.y1, item.y2);
  const bottom = Math.max(item.y1, item.y2);

  if (item.type === 'arrow') {
    // The shaft, and the solid head at the far end.
    if (distanceToSegment(x, y, { x: item.x1, y: item.y1 }, { x: item.x2, y: item.y2 }) <= tolerance) {
      return true;
    }
    return Math.hypot(x - item.x2, y - item.y2) <= Math.max(6, (item.width ?? 2) * 2.2);
  }

  if (item.type === 'mosaic') {
    // A mosaic has no outline but is a filled region, so its box is the shape.
    return x >= left - tolerance && x <= right + tolerance
      && y >= top - tolerance && y <= bottom + tolerance;
  }

  // Rectangle and ellipse: the outline only. These are two different predicates —
  // a point can be inside the ellipse's box but outside the ellipse itself, which
  // is exactly the mistake this function exists to avoid.
  const w = right - left;
  const h = bottom - top;

  if (item.type === 'rect') {
    // Flattened rectangles draw as a line, so test the line.
    if (w < 0.5 || h < 0.5) {
      return distanceToSegment(x, y, { x: left, y: top }, { x: right, y: bottom }) <= tolerance;
    }
    const nearVerticalEdge = (Math.abs(x - left) <= tolerance || Math.abs(x - right) <= tolerance)
      && y >= top - tolerance && y <= bottom + tolerance;
    const nearHorizontalEdge = (Math.abs(y - top) <= tolerance || Math.abs(y - bottom) <= tolerance)
      && x >= left - tolerance && x <= right + tolerance;
    return nearVerticalEdge || nearHorizontalEdge;
  }

  if (item.type === 'ellipse') {
    const radiusX = w / 2;
    const radiusY = h / 2;
    if (radiusX < 0.5 || radiusY < 0.5) {
      return distanceToSegment(x, y, { x: left, y: top }, { x: right, y: bottom }) <= tolerance;
    }
    const centreX = left + radiusX;
    const centreY = top + radiusY;
    // Normalised radius: 1 is exactly on the ellipse.
    const normalised = Math.hypot((x - centreX) / radiusX, (y - centreY) / radiusY);
    // Convert the pixel tolerance into the same normalised units, using the
    // smaller radius so the tolerance is never generous in one direction only.
    const slack = tolerance / Math.min(radiusX, radiusY);
    return Math.abs(normalised - 1) <= slack;
  }

  // An unknown type falls back to its box rather than becoming unclickable.
  const bounds = annotationBounds(item);
  return bounds !== null && insideRect(x, y, bounds);
}

/** Distance from a point to a line segment. */
function distanceToSegment(x, y, from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(x - from.x, y - from.y);
  // Projection of the point onto the segment, clamped to its ends.
  const t = Math.max(0, Math.min(1, ((x - from.x) * dx + (y - from.y) * dy) / lengthSquared));
  return Math.hypot(x - (from.x + t * dx), y - (from.y + t * dy));
}

/**
 * Which annotation is on top at a point, or -1.
 *
 * Topmost wins, as it does on screen. A point must land on an annotation's drawn
 * shape, not merely inside the box around it.
 */
function annotationAt(x, y) {
  for (let index = state.annots.length - 1; index >= 0; index -= 1) {
    const item = state.annots[index];
    const bounds = annotationBounds(item);
    // The box is a cheap rejection test first: most of the screen is outside every
    // annotation, and the per-type geometry below is much more expensive.
    if (bounds === null || !insideRect(x, y, bounds)) continue;
    if (hitsInk(item, x, y)) return index;
  }
  return -1;
}

/**
 * Clamp a delta so the annotation being moved stays inside the selection.
 *
 * Not the screen. Annotations are burned into the crop, so anything dragged past
 * the frame's edge is painted on the dimmed desktop and then cut out of the export
 * — the user sees ink that the saved image does not contain, and cannot tell why it
 * vanished. Clamping to the frame keeps what is on screen and what is saved the
 * same thing.
 *
 * A shape larger than the frame cannot be contained by translation, so it is pinned
 * to the frame's near edge instead of being shuttled back and forth.
 */
function clampAnnotationDelta(item, dx, dy) {
  const bounds = annotationBounds(item);
  if (bounds === null) return { dx: 0, dy: 0 };
  const sel = state.sel;
  if (sel === null || sel.w <= 0 || sel.h <= 0) {
    // No frame yet: the screen is the only limit there is.
    return {
      dx: Math.max(-bounds.x, Math.min(screenWidth - (bounds.x + bounds.w), dx)),
      dy: Math.max(-bounds.y, Math.min(screenHeight - (bounds.y + bounds.h), dy)),
    };
  }
  const minDx = sel.x - bounds.x;
  const maxDx = (sel.x + sel.w) - (bounds.x + bounds.w);
  const minDy = sel.y - bounds.y;
  const maxDy = (sel.y + sel.h) - (bounds.y + bounds.h);
  return {
    // When the shape is wider than the frame the lower bound exceeds the upper one;
    // taking the minimum keeps it at the left/top edge rather than flipping.
    dx: Math.max(Math.min(minDx, maxDx), Math.min(Math.max(minDx, maxDx), dx)),
    dy: Math.max(Math.min(minDy, maxDy), Math.min(Math.max(minDy, maxDy), dy)),
  };
}
function moveAnnotation(item, dx, dy) {
  if (item.type === 'pen') {
    for (const point of item.points ?? []) {
      point.x += dx;
      point.y += dy;
    }
    return;
  }
  item.x1 += dx;
  item.y1 += dy;
  if (item.type !== 'text') {
    // Text has no second corner: its width comes from the glyphs, not from `x2`.
    item.x2 += dx;
    item.y2 += dy;
  }
}

/**
 * The annotation the user is working on, or null.
 *
 * Resolved through the index every time rather than held as a reference: undo and
 * redo swap the whole list, so a stored object would silently stop being the one
 * that is drawn.
 */
function selectedAnnotation() {
  const index = state.selectedAnnotation;
  if (index < 0 || index >= state.annots.length) return null;
  return state.annots[index];
}

/**
 * Resize a rectangle by dragging one handle.
 *
 * Each handle moves only the edges it names, so dragging the east handle changes
 * the width alone — which is what makes the two axes independently controllable.
 * Opposite edges are clamped so the rectangle can never invert.
 */
function resizeRect(base, handle, x, y) {
  const MIN = 8;
  let left = base.x;
  let top = base.y;
  let right = base.x + base.w;
  let bottom = base.y + base.h;
  if (handle.includes('w')) left = Math.min(x, right - MIN);
  if (handle.includes('e')) right = Math.max(x, left + MIN);
  if (handle.includes('n')) top = Math.min(y, bottom - MIN);
  if (handle.includes('s')) bottom = Math.max(y, top + MIN);
  const clampedLeft = Math.max(0, left);
  const clampedTop = Math.max(0, top);
  return {
    x: clampedLeft,
    y: clampedTop,
    w: Math.min(screenWidth, right) - clampedLeft,
    h: Math.min(screenHeight, bottom) - clampedTop,
  };
}

/** Move a rectangle without resizing it, kept fully on screen. */
function moveRect(base, dx, dy) {
  return {
    x: Math.max(0, Math.min(screenWidth - base.w, base.x + dx)),
    y: Math.max(0, Math.min(screenHeight - base.h, base.y + dy)),
    w: base.w,
    h: base.h,
  };
}

/** The resize cursor for a handle, as an IDC_ constant. */
const HANDLE_CURSOR = {
  nw: 32642, n: 32645, ne: 32643, e: 32644,
  se: 32642, s: 32645, sw: 32643, w: 32644,
};

/**
 * System cursor ids used by the overlay.
 *
 * `LoadCursorW` with a NULL instance takes these small integers directly, which is
 * the documented way to ask for a stock cursor — no resource handles to manage.
 */
const IDC_ARROW = 32512;
const IDC_IBEAM = 32513;
const IDC_CROSS = 32515;
const IDC_SIZEALL = 32646;

/**
 * Whether a point is on the selection frame's own border line.
 *
 * The frame is an outline, so it is dragged by its outline — the same rule the
 * annotations follow. Everywhere inside it is canvas for drawing, which is what
 * makes the two behaviours distinguishable at all: before, a press anywhere inside
 * the frame moved the whole picture, so there was no way to place a shape near the
 * edge of a small selection without dragging the frame instead.
 *
 * @param {number} x screen x
 * @param {number} y screen y
 * @returns {boolean} true when the pointer is within grab distance of an edge
 */
function hitsFrameEdge(x, y) {
  const sel = state.sel;
  if (sel === null || sel.w <= 0 || sel.h <= 0) return false;
  // The frame is drawn 2 px thick with a white underlay, so a few pixels either
  // side is the line as it appears on screen.
  const tolerance = 4;
  const left = sel.x;
  const top = sel.y;
  const right = sel.x + sel.w;
  const bottom = sel.y + sel.h;
  const withinX = x >= left - tolerance && x <= right + tolerance;
  const withinY = y >= top - tolerance && y <= bottom + tolerance;
  if (!withinX || !withinY) return false;
  const nearVertical = Math.abs(x - left) <= tolerance || Math.abs(x - right) <= tolerance;
  const nearHorizontal = Math.abs(y - top) <= tolerance || Math.abs(y - bottom) <= tolerance;
  return nearVertical || nearHorizontal;
}

/**
 * Set the mouse cursor for the pointer position.
 *
 * `LoadCursorW` with a NULL instance and a small integer is the documented way to
 * get a system cursor, so the id is passed straight through as the pointer value.
 *
 * Every annotation answers with the four-way move cursor, whatever tool is active,
 * because a press on one always picks it up (see the press handler). The cursor is
 * the only way the overlay can say "this is a movable object" before a click, and a
 * shape that looks identical whether or not it can be grabbed is the reason the
 * previous version felt unresponsive.
 *
 * Before a tool is picked the whole interior of the frame moves it, so the cursor
 * says so there too — the indication has to match what a press would actually do.
 */
function applyCursorFor(x, y) {
  const handle = hitHandle(x, y, state.sel);
  let cursorId = state.tool === 'text' ? IDC_IBEAM : IDC_CROSS;
  if (handle !== null) {
    cursorId = HANDLE_CURSOR[handle];
  } else if (annotationAt(x, y) !== -1) {
    // A drawn annotation is grabbed by pressing on the shape itself.
    cursorId = IDC_SIZEALL;
  } else if (state.tool === null) {
    // No tool yet: the frame's interior is the handle.
    if (state.sel !== null && insideRect(x, y, state.sel)) cursorId = IDC_SIZEALL;
  } else if (hitsFrameEdge(x, y)) {
    // With a tool active the interior is canvas, so only the border moves the frame.
    cursorId = IDC_SIZEALL;
  }
  const cursor = api.LoadCursorW(null, cursorId);
  if (cursor !== null) api.SetCursor(cursor);
}

/**
 * Whether the toolbar is on screen right now.
 *
 * One predicate for both painting and hit-testing: a toolbar that is drawn but
 * not clickable, or clickable but not drawn, is a bug either way. It is hidden
 * while a new selection is being dragged out, so the user sees the area they are
 * framing instead of a control card sitting on top of it.
 */
function toolbarVisible() {
  return state.sel !== null && state.sel.w > 2 && state.sel.h > 2 && !state.choosing;
}

/**
 * Which toolbar entry is under a point, or null.
 *
 * `hitToolbar` answers the same question for clicks; this exists as the single
 * source for both, so a button can never be highlighted in one place and clickable
 * in another. The popup is checked first because it is drawn on top.
 */
function toolbarItemAt(x, y) {
  if (!toolbarVisible()) return null;
  const bar = toolbarRect();
  if (y < bar.y || y > bar.y + bar.h || x < bar.x || x > bar.x + bar.w) return null;
  let cursorX = bar.x + 7;
  for (const item of toolbarItems()) {
    if (item.kind !== 'sep' && x >= cursorX && x < cursorX + item.width) return item;
    cursorX += item.width;
  }
  return null;
}

function hitToolbar(x, y) {
  return toolbarItemAt(x, y);
}

// --------------------------------------------------------------- painting

/**
 * Rounded rectangle path at the given rectangle.
 *
 * GDI+ builds it from four arcs, which is what makes the corner genuinely smooth
 * rather than a staircase.
 */
function roundRectPath(graphics, x, y, w, h, radius) {
  const out = Buffer.alloc(8);
  if (gdip.GdipCreatePath(0 /* FillModeAlternate */, out) !== 0) return null;
  const path = out.readBigUInt64LE(0);
  const r = Math.max(0, Math.min(radius, Math.min(w, h) / 2));
  if (r <= 0) {
    gdip.GdipAddPathRectangle(path, x, y, w, h);
    gdip.GdipClosePathFigure(path);
    return path;
  }
  const d = r * 2;
  gdip.GdipAddPathArc(path, x, y, d, d, 180, 90);
  gdip.GdipAddPathArc(path, x + w - d, y, d, d, 270, 90);
  gdip.GdipAddPathArc(path, x + w - d, y + h - d, d, d, 0, 90);
  gdip.GdipAddPathArc(path, x, y + h - d, d, d, 90, 90);
  gdip.GdipClosePathFigure(path);
  return path;
}

/** Fill a rounded rectangle. */
function fillRoundRect(hdc, x, y, w, h, radius, color) {
  if (w <= 0 || h <= 0) return;
  withGraphics(hdc, (graphics) => {
    const path = roundRectPath(graphics, x, y, w, h, radius);
    if (path === null) return;
    const brush = Buffer.alloc(8);
    try {
      if (gdip.GdipCreateSolidFill(color, brush) === 0) {
        gdip.GdipFillPath(graphics, brush.readBigUInt64LE(0), path);
        gdip.GdipDeleteBrush(brush.readBigUInt64LE(0));
      }
    } finally {
      gdip.GdipDeletePath(path);
    }
  });
}

/**
 * A rounded rectangle, filled with a soft shadow in two passes.
 *
 * GDI+ blends alpha, so the shadow is an actual translucent layer instead of the
 * flat grey bar the GDI version had to approximate.
 */
function fillRoundRectWithShadow(hdc, x, y, w, h, radius, color, shadow) {
  withGraphics(hdc, (graphics) => {
    // Two inward steps approximate a blur at this size for far less cost than a
    // real Gaussian pass.
    for (const step of [3, 2, 1]) {
      const path = roundRectPath(graphics, x + 1, y + step, w, h, radius);
      if (path === null) continue;
      const brush = Buffer.alloc(8);
      const alpha = step === 3 ? shadow : Math.min(255, Math.round(shadow * 1.6));
      if (gdip.GdipCreateSolidFill(alpha, brush) === 0) {
        gdip.GdipFillPath(graphics, brush.readBigUInt64LE(0), path);
        gdip.GdipDeleteBrush(brush.readBigUInt64LE(0));
      }
      gdip.GdipDeletePath(path);
    }
    const path = roundRectPath(graphics, x, y, w, h, radius);
    if (path === null) return;
    const brush = Buffer.alloc(8);
    try {
      if (gdip.GdipCreateSolidFill(color, brush) === 0) {
        gdip.GdipFillPath(graphics, brush.readBigUInt64LE(0), path);
        gdip.GdipDeleteBrush(brush.readBigUInt64LE(0));
      }
    } finally {
      gdip.GdipDeletePath(path);
    }
  });
}

/** Outline a rounded rectangle. */
function strokeRoundRect(hdc, x, y, w, h, radius, color, width = 1) {
  withGraphics(hdc, (graphics) => {
    const path = roundRectPath(graphics, x + 0.5, y + 0.5, w - 1, h - 1, radius);
    if (path === null) return;
    const pen = Buffer.alloc(8);
    try {
      // GDI+ ARGB: the alpha byte is the high byte.
      if (gdip.GdipCreatePen1(color, width, 2 /* UnitPixel */, pen) === 0) {
        gdip.GdipDrawPath(graphics, pen.readBigUInt64LE(0), path);
        gdip.GdipDeletePen(pen.readBigUInt64LE(0));
      }
    } finally {
      gdip.GdipDeletePath(path);
    }
  });
}

/** Fill a plain rectangle, for elements that do not need rounded corners. */
function fillRect(hdc, x, y, w, h, color) {
  if (w <= 0 || h <= 0) return;
  withGraphics(hdc, (graphics) => {
    const brush = Buffer.alloc(8);
    if (gdip.GdipCreateSolidFill(color, brush) === 0) {
      gdip.GdipFillRectangleI(graphics, brush.readBigUInt64LE(0), Math.round(x), Math.round(y), Math.round(w), Math.round(h));
      gdip.GdipDeleteBrush(brush.readBigUInt64LE(0));
    }
  });
}

/** A filled circle, used for the colour swatches. */
function fillCircle(hdc, cx, cy, radius, color) {
  withGraphics(hdc, (graphics) => {
    const brush = Buffer.alloc(8);
    if (gdip.GdipCreateSolidFill(color, brush) === 0) {
      gdip.GdipFillEllipse(graphics, brush.readBigUInt64LE(0), cx - radius, cy - radius, radius * 2, radius * 2);
      gdip.GdipDeleteBrush(brush.readBigUInt64LE(0));
    }
  });
}

/** Outline a rectangle with crisp lines. */
function strokeRect(hdc, x, y, w, h, color, lineWidth = 1) {
  if (w <= 0 || h <= 0) return;
  withGraphics(hdc, (graphics) => {
    const pen = Buffer.alloc(8);
    if (gdip.GdipCreatePen1(color, lineWidth, 2 /* UnitPixel */, pen) === 0) {
      const handle = pen.readBigUInt64LE(0);
      const right = x + w;
      const bottom = y + h;
      gdip.GdipDrawLine(graphics, handle, x, y, right, y);
      gdip.GdipDrawLine(graphics, handle, right, y, right, bottom);
      gdip.GdipDrawLine(graphics, handle, right, bottom, x, bottom);
      gdip.GdipDrawLine(graphics, handle, x, bottom, x, y);
      gdip.GdipDeletePen(handle);
    }
  });
}

/**
 * Draw a line of text with a real font.
 *
 * GDI+ takes a `RectF` for layout and returns the drawn extent, so `y` here is the
 * top of the box rather than a baseline to nudge. The font family falls back to
 * Segoe UI if Microsoft YaHei is missing, which keeps Latin text sensible on a
 * system without the CJK fonts installed.
 */
/**
 * Width of a single line of text at a given size, in pixels.
 *
 * Used to size the tooltip pill. The alternative — estimating from the character
 * count — clips CJK labels, which are two glyph-widths each rather than one.
 */
function measureText(text, size) {
  if (text === '') return 0;
  startGdiplus();
  const screenDc = api.GetDC(null);
  const memory = api.CreateCompatibleDC(screenDc);
  const bitmap = api.CreateCompatibleBitmap(screenDc, 8, 8);
  const previous = api.SelectObject(memory, bitmap);
  try {
    const out = Buffer.alloc(8);
    if (gdip.GdipCreateFromHDC(memory, out) !== 0) return text.length * size * 0.7;
    const graphics = out.readBigUInt64LE(0);
    try {
      gdip.GdipSetTextRenderingHint(graphics, 5);
      const familyOut = Buffer.alloc(8);
      let family = null;
      for (const name of ['Microsoft YaHei UI', 'Microsoft YaHei', 'Segoe UI']) {
        if (gdip.GdipCreateFontFamilyFromName(toW(name), null, familyOut) === 0) {
          family = familyOut.readBigUInt64LE(0);
          break;
        }
      }
      if (family === null) return text.length * size * 0.7;
      const fontOut = Buffer.alloc(8);
      if (gdip.GdipCreateFont(family, size, 0, 2, fontOut) !== 0) {
        gdip.GdipDeleteFontFamily(family);
        return text.length * size * 0.7;
      }
      const font = fontOut.readBigUInt64LE(0);
      /*
       * The bounding box must be a Buffer, not a plain object.
       *
       * `GdipMeasureString` writes its result through the pointer. Koffi marshals a
       * plain object *in* correctly but has no way to copy the mutated struct back
       * out, so `bound.Width` stayed 0 for every string — which silently broke
       * every consumer: the tooltip pill was sized from the fallback estimate, and
       * the text caret was drawn at the start of the line instead of after the last
       * glyph. Reading the four floats back out of a Buffer works, because the
       * callee writes into memory the Buffer already owns.
       */
      const bound = Buffer.alloc(16);
      const layout = { X: 0, Y: 0, Width: 4096, Height: size * 2.4 };
      const fitted = [0];
      const lines = [0];
      const status = gdip.GdipMeasureString(graphics, toW(text), text.length, font, layout, null, bound, fitted, lines);
      gdip.GdipDeleteFont(font);
      gdip.GdipDeleteFontFamily(family);
      if (status !== 0) return text.length * size * 0.7;
      // Offset 8 is `Width` in RectF { X, Y, Width, Height }.
      const width = bound.readFloatLE(8);
      // A zero width means the measurement failed rather than "the text is empty":
      // an empty string was already handled above. Fall back to an estimate so a
      // caller never positions something exactly on top of the text.
      return width > 0 ? width : text.length * size * 0.7;
    } finally {
      gdip.GdipDeleteGraphics(graphics);
    }
  } finally {
    api.SelectObject(memory, previous);
    api.DeleteObject(bitmap);
    api.DeleteDC(memory);
    api.ReleaseDC(null, screenDc);
  }
}

function drawText(hdc, text, x, y, color, size = 20, bold = false) {
  if (text === '') return;
  withGraphics(hdc, (graphics) => {
    const familyOut = Buffer.alloc(8);
    let family = null;
    for (const name of ['Microsoft YaHei UI', 'Microsoft YaHei', 'Segoe UI']) {
      if (gdip.GdipCreateFontFamilyFromName(toW(name), null, familyOut) === 0) {
        family = familyOut.readBigUInt64LE(0);
        break;
      }
    }
    if (family === null) return;

    const fontOut = Buffer.alloc(8);
    // GDI+ sizes are in points by default; pixels keep this predictable at any DPI.
    const style = bold ? 1 /* FontStyleBold */ : 0;
    if (gdip.GdipCreateFont(family, size, style, 2 /* UnitPixel */, fontOut) !== 0) {
      gdip.GdipDeleteFontFamily(family);
      return;
    }
    const font = fontOut.readBigUInt64LE(0);

    const formatOut = Buffer.alloc(8);
    const hasFormat = gdip.GdipCreateStringFormat(0, 0, formatOut) === 0;
    const format = hasFormat ? formatOut.readBigUInt64LE(0) : null;
    if (format !== null) {
      // 0 = Near (left/top): no hidden centring offsets to reason about.
      gdip.GdipSetStringFormatAlign(format, 0);
      gdip.GdipSetStringFormatLineAlign(format, 0);
    }

    const brush = Buffer.alloc(8);
    if (gdip.GdipCreateSolidFill(color, brush) === 0) {
      const handle = brush.readBigUInt64LE(0);
      const buffer = toW(text);
      const rect = {
        X: x,
        Y: y,
        Width: Math.max(1, screenWidth - x),
        Height: Math.max(1, size * 2.2),
      };
      gdip.GdipDrawString(graphics, buffer, text.length, font, rect, format, handle);
      gdip.GdipDeleteBrush(handle);
    }

    if (format !== null) gdip.GdipDeleteStringFormat(format);
    gdip.GdipDeleteFont(font);
    gdip.GdipDeleteFontFamily(family);
  });
}

/** Draw one annotation. */
function drawAnnotation(hdc, item) {
  withGraphics(hdc, (graphics) => {
    const width = Math.max(1.5, item.width);
    const pen = Buffer.alloc(8);
    const hasPen = gdip.GdipCreatePen1(item.color, width, 2 /* UnitPixel */, pen) === 0;
    const penHandle = hasPen ? pen.readBigUInt64LE(0) : null;
    if (penHandle !== null) {
      // Round caps and joins: the difference between a drawn stroke and a
      // pixelated polygon at these widths.
      gdip.GdipSetPenLineCap197819(penHandle, 2 /* Round */, 2, 2);
      gdip.GdipSetPenLineJoin(penHandle, 2 /* Round */);
    }

    const brush = Buffer.alloc(8);
    const hasBrush = gdip.GdipCreateSolidFill(item.color, brush) === 0;
    const brushHandle = hasBrush ? brush.readBigUInt64LE(0) : null;

    try {
      if (item.type === 'rect') {
        const x = Math.min(item.x1, item.x2);
        const y = Math.min(item.y1, item.y2);
        const w = Math.abs(item.x2 - item.x1);
        const h = Math.abs(item.y2 - item.y1);
        /*
         * A rectangle with a zero side is a straight line, and GDI+ refuses to draw
         * a degenerate path: `GdipAddPathRectangle` with width or height 0 produces
         * nothing at all. That is why a horizontal "guide line" — dragged with the
         * height left at zero — showed only its selection box and no line.
         *
         * A line is drawn explicitly instead, so pulling the rectangle flat gives
         * the line the pointer is describing rather than silence.
         */
        if (penHandle !== null && (w < 0.5 || h < 0.5)) {
          // The flattened pair of corners, which for a degenerate box is its two ends.
          gdip.GdipDrawLine(graphics, penHandle, x, y, x + w, y + h);
        } else if (penHandle !== null) {
          const pathOut = Buffer.alloc(8);
          if (gdip.GdipCreatePath(0, pathOut) === 0) {
            const path = pathOut.readBigUInt64LE(0);
            gdip.GdipAddPathRectangle(path, x, y, w, h);
            gdip.GdipDrawPath(graphics, penHandle, path);
            gdip.GdipDeletePath(path);
          }
        }
      } else if (item.type === 'ellipse') {
        const x = Math.min(item.x1, item.x2);
        const y = Math.min(item.y1, item.y2);
        const w = Math.abs(item.x2 - item.x1);
        const h = Math.abs(item.y2 - item.y1);
        const pathOut = Buffer.alloc(8);
        if (penHandle !== null && (w < 0.5 || h < 0.5)) {
          // Same degenerate case as the rectangle: an ellipse with no area is a
          // line, and a path-based ellipse with a zero side would vanish.
          gdip.GdipDrawLine(graphics, penHandle, x, y, x + w, y + h);
        } else if (penHandle !== null && gdip.GdipCreatePath(0, pathOut) === 0) {
          const path = pathOut.readBigUInt64LE(0);
          gdip.GdipAddPathEllipse(path, x, y, w, h);
          gdip.GdipDrawPath(graphics, penHandle, path);
          gdip.GdipDeletePath(path);
        }
      } else if (item.type === 'arrow') {
        const angle = Math.atan2(item.y2 - item.y1, item.x2 - item.x1);
        const length = Math.hypot(item.x2 - item.x1, item.y2 - item.y1);
        const headLength = Math.min(length * 0.4, Math.max(14, width * 5));
        const headWidth = headLength * 0.66;
        const baseX = item.x2 - headLength * Math.cos(angle);
        const baseY = item.y2 - headLength * Math.sin(angle);
        // Shaft stops at the head's base so it never pokes through the tip.
        if (penHandle !== null) gdip.GdipDrawLine(graphics, penHandle, item.x1, item.y1, baseX, baseY);
        // Solid triangular head.
        const perpX = -Math.sin(angle) * (headWidth / 2);
        const perpY = Math.cos(angle) * (headWidth / 2);
        const pathOut = Buffer.alloc(8);
        if (brushHandle !== null && gdip.GdipCreatePath(0, pathOut) === 0) {
          const path = pathOut.readBigUInt64LE(0);
          gdip.GdipAddPathLine(path, baseX + perpX, baseY + perpY, item.x2, item.y2);
          gdip.GdipAddPathLine(path, item.x2, item.y2, baseX - perpX, baseY - perpY);
          gdip.GdipClosePathFigure(path);
          gdip.GdipFillPath(graphics, brushHandle, path);
          gdip.GdipDeletePath(path);
        }
      } else if (item.type === 'pen') {
        const points = item.points ?? [];
        if (penHandle !== null && points.length > 1) {
          const pathOut = Buffer.alloc(8);
          if (gdip.GdipCreatePath(0, pathOut) === 0) {
            const path = pathOut.readBigUInt64LE(0);
            for (let index = 1; index < points.length; index += 1) {
              gdip.GdipAddPathLine(
                path,
                points[index - 1].x, points[index - 1].y,
                points[index].x, points[index].y,
              );
            }
            gdip.GdipDrawPath(graphics, penHandle, path);
            gdip.GdipDeletePath(path);
          }
        }
      } else if (item.type === 'mosaic') {
        /*
         * The live preview.
         *
         * This used to paint a grey checkerboard, which read as "this area is
         * selected" rather than "this area will be blurred" — nothing like the
         * result. It now averages the real screenshot underneath, so what the
         * preview shows is what the export produces. The cell is smaller than the
         * export's block because the preview is drawn over the live frame at screen
         * resolution and a large cell looks like a coarse pattern, not a blur.
         */
        const left = Math.max(0, Math.round(Math.min(item.x1, item.x2)));
        const top = Math.max(0, Math.round(Math.min(item.y1, item.y2)));
        const right = Math.min(screenWidth, Math.round(Math.max(item.x1, item.x2)));
        const bottom = Math.min(screenHeight, Math.round(Math.max(item.y1, item.y2)));
        const cell = 10;
        for (let by = top; by < bottom; by += cell) {
          for (let bx = left; bx < right; bx += cell) {
            fillRect(
              hdc, bx, by,
              Math.min(cell, right - bx), Math.min(cell, bottom - by),
              averageFrameColor(bx, by, Math.min(cell, right - bx), Math.min(cell, bottom - by)),
            );
          }
        }
      }
    } finally {
      if (brushHandle !== null) gdip.GdipDeleteBrush(brushHandle);
      if (penHandle !== null) gdip.GdipDeletePen(penHandle);
    }
  });
  if (item.type === 'text' && item.text) {
    // The annotation carries its own size, so changing the stroke width later does
    // not resize labels that were already placed.
    drawText(hdc, item.text, item.x1, item.y1 - 2, item.color, item.size ?? 18, true);
  }
}

/**
 * Tool glyphs, drawn with GDI+ pens so they are smooth at any scale.
 *
 * Each is deliberately one idea: a frame, an oval, an arrow, a nib, four tiles.
 */
function drawToolIcon(hdc, tool, x, y, color) {
  withGraphics(hdc, (graphics) => {
    const pen = Buffer.alloc(8);
    if (gdip.GdipCreatePen1(color, 1.7, 2 /* UnitPixel */, pen) !== 0) return;
    const handle = pen.readBigUInt64LE(0);
    gdip.GdipSetPenLineCap197819(handle, 2, 2, 2);
    gdip.GdipSetPenLineJoin(handle, 2);
    try {
      if (tool === 'text') {
        // A capital T with a serif foot: unmistakable, and it does not need a font.
        gdip.GdipDrawLine(graphics, handle, x + 3, y + 4, x + 15, y + 4);
        gdip.GdipDrawLine(graphics, handle, x + 9, y + 4, x + 9, y + 15);
        gdip.GdipDrawLine(graphics, handle, x + 6, y + 15, x + 12, y + 15);
      } else if (tool === 'rect') {
        const pathOut = Buffer.alloc(8);
        if (gdip.GdipCreatePath(0, pathOut) === 0) {
          const path = pathOut.readBigUInt64LE(0);
          gdip.GdipAddPathRectangle(path, x + 2, y + 4, 14, 11);
          gdip.GdipDrawPath(graphics, handle, path);
          gdip.GdipDeletePath(path);
        }
      } else if (tool === 'ellipse') {
        const pathOut = Buffer.alloc(8);
        if (gdip.GdipCreatePath(0, pathOut) === 0) {
          const path = pathOut.readBigUInt64LE(0);
          gdip.GdipAddPathEllipse(path, x + 1.5, y + 4, 15, 11);
          gdip.GdipDrawPath(graphics, handle, path);
          gdip.GdipDeletePath(path);
        }
      } else if (tool === 'arrow') {
        gdip.GdipDrawLine(graphics, handle, x + 2, y + 15, x + 15, y + 3);
        gdip.GdipDrawLine(graphics, handle, x + 15, y + 3, x + 8, y + 3);
        gdip.GdipDrawLine(graphics, handle, x + 15, y + 3, x + 15, y + 10);
      } else if (tool === 'pen') {
        gdip.GdipDrawLine(graphics, handle, x + 2, y + 16, x + 5, y + 9.5);
        gdip.GdipDrawLine(graphics, handle, x + 5, y + 9.5, x + 12.5, y + 2.5);
        gdip.GdipDrawLine(graphics, handle, x + 12.5, y + 2.5, x + 16, y + 6);
        gdip.GdipDrawLine(graphics, handle, x + 16, y + 6, x + 8.5, y + 13);
        gdip.GdipDrawLine(graphics, handle, x + 8.5, y + 13, x + 2, y + 16);
      } else if (tool === 'mosaic') {
        for (let row = 0; row < 2; row += 1) {
          for (let column = 0; column < 2; column += 1) {
            const px = x + 2 + column * 7;
            const py = y + 4 + row * 7;
            const pathOut = Buffer.alloc(8);
            if (gdip.GdipCreatePath(0, pathOut) === 0) {
              const path = pathOut.readBigUInt64LE(0);
              gdip.GdipAddPathRectangle(path, px, py, 5, 5);
              gdip.GdipDrawPath(graphics, handle, path);
              gdip.GdipDeletePath(path);
            }
          }
        }
      }
    } finally {
      gdip.GdipDeletePen(handle);
    }
  });
}

/**
 * A tick, used on the confirm button.
 *
 * Sized to match the close cross next to it: the first version was 10 px wide with
 * a 2.1 px stroke, which read as a speck rather than a control at this scale.
 */
/**
 * Two overlapping sheets: the universal "copy" mark.
 *
 * Drawn as outlines rather than solid blocks so it reads at 18 px next to the other
 * glyphs, which are all line art.
 *
 * @param {void *} hdc target
 * @param {number} cx centre x
 * @param {number} cy centre y
 */
function drawCopyIcon(hdc, cx, cy) {
  withGraphics(hdc, (graphics) => {
    const pen = Buffer.alloc(8);
    if (gdip.GdipCreatePen1(0xff2b3442, 1.7, 2 /* UnitPixel */, pen) !== 0) return;
    const handle = pen.readBigUInt64LE(0);
    gdip.GdipSetPenLineCap197819(handle, 2, 2, 2);
    gdip.GdipSetPenLineJoin(handle, 2);
    try {
      const pathOut = Buffer.alloc(8);
      if (gdip.GdipCreatePath(0, pathOut) === 0) {
        const path = pathOut.readBigUInt64LE(0);
        // The back sheet, offset up and left, then the front sheet over it.
        gdip.GdipAddPathRectangle(path, cx - 6.5, cy - 6.5, 9, 11);
        gdip.GdipAddPathRectangle(path, cx - 2.5, cy - 2.5, 9, 11);
        gdip.GdipDrawPath(graphics, handle, path);
        gdip.GdipDeletePath(path);
      }
    } finally {
      gdip.GdipDeletePen(handle);
    }
  });
}

function drawCheckIcon(hdc, cx, cy, color) {
  withGraphics(hdc, (graphics) => {
    const pen = Buffer.alloc(8);
    if (gdip.GdipCreatePen1(color, 2.4, 2, pen) !== 0) return;
    const handle = pen.readBigUInt64LE(0);
    gdip.GdipSetPenLineCap197819(handle, 2, 2, 2);
    gdip.GdipSetPenLineJoin(handle, 2);
    try {
      gdip.GdipDrawLine(graphics, handle, cx - 6.5, cy + 0.5, cx - 2, cy + 5);
      gdip.GdipDrawLine(graphics, handle, cx - 2, cy + 5, cx + 6.5, cy - 5);
    } finally {
      gdip.GdipDeletePen(handle);
    }
  });
}

/** The small cross that closes the overlay. */
function drawCloseIcon(hdc, cx, cy, color) {
  withGraphics(hdc, (graphics) => {
    const pen = Buffer.alloc(8);
    if (gdip.GdipCreatePen1(color, 1.8, 2, pen) !== 0) return;
    const handle = pen.readBigUInt64LE(0);
    gdip.GdipSetPenLineCap197819(handle, 2, 2, 2);
    try {
      gdip.GdipDrawLine(graphics, handle, cx - 5, cy - 5, cx + 5, cy + 5);
      gdip.GdipDrawLine(graphics, handle, cx + 5, cy - 5, cx - 5, cy + 5);
    } finally {
      gdip.GdipDeletePen(handle);
    }
  });
}

/**
 * The undo arrow: a line that hooks back on itself.
 *
 * A hairpin — a straight run, a half-circle turn, and a return leg carrying the
 * head — is the shape people read as "go back one step". A plain left arrow reads
 * as "back" instead, which in a screenshot editor means the wrong thing.
 *
 * A disabled arrow keeps its place and only loses its ink, so nothing in the bar
 * shifts when the history empties. The grey is a light solid rather than a
 * low-alpha black: the bar is a light card, and a transparent ink washed out until
 * the button looked like an empty circle.
 */
function drawUndoIcon(hdc, cx, cy, enabled) {
  withGraphics(hdc, (graphics) => {
    const pen = Buffer.alloc(8);
    const color = enabled ? 0xff2b3442 : 0xffc2c8d0;
    if (gdip.GdipCreatePen1(color, 1.7, 2, pen) !== 0) return;
    const handle = pen.readBigUInt64LE(0);
    gdip.GdipSetPenLineCap197819(handle, 2, 2, 2);
    try {
      // The hairpin. The turns' two ends sit at (turnX, bottomY) and (turnX, topY);
      // the ellipse's centre is (turnX, cy) with `radius`, so the legs meet it
      // exactly and the three pieces read as one continuous line. The numbers put
      // the whole glyph inside a cx ± 5.8 box, so it is centred on (cx, cy).
      const radius = 3.8;
      const topY = cy - radius;
      const bottomY = cy + radius;
      const legLeftX = cx - 5.8;
      const turnX = cx + 2.0;

      const pathOut = Buffer.alloc(8);
      if (gdip.GdipCreatePath(0, pathOut) === 0) {
        const path = pathOut.readBigUInt64LE(0);
        // Out along the bottom leg, around the right-hand turn (90° is the bottom
        // of the ellipse, and a negative sweep carries it over the right to the
        // top), then back along the top leg to where the head goes.
        gdip.GdipAddPathLine(path, legLeftX, bottomY, turnX, bottomY);
        gdip.GdipAddPathArc(
          path,
          turnX - radius,
          topY,
          radius * 2,
          radius * 2,
          90,
          -180,
        );
        gdip.GdipAddPathLine(path, turnX, topY, legLeftX, topY);
        gdip.GdipDrawPath(graphics, handle, path);
        gdip.GdipDeletePath(path);
      }

      // Head on the returning leg, pointing where the line came from.
      gdip.GdipDrawLine(graphics, handle, legLeftX, topY, legLeftX + 3.6, topY - 2.5);
      gdip.GdipDrawLine(graphics, handle, legLeftX, topY, legLeftX + 3.6, topY + 2.5);
    } finally {
      gdip.GdipDeletePen(handle);
    }
  });
}

/**
 * The thin dashed box around a picked annotation.
 *
 * Dashed rather than solid so it reads as "selected, not part of the picture" —
 * a solid box in the accent colour is exactly what the selection frame looks like,
 * and two identical frames would be ambiguous. It is drawn by hand from short
 * segments because the pen's dash pattern is a separate GDI+ entry point and this
 * needs only one shape.
 */
function drawAnnotationFrame(hdc, bounds) {
  // A little air around the stroke, so the box sits outside the ink rather than
  // cutting through it.
  const pad = 4;
  const x = bounds.x - pad;
  const y = bounds.y - pad;
  const w = bounds.w + pad * 2;
  const h = bounds.h + pad * 2;
  const dash = 5;
  const gap = 4;

  withGraphics(hdc, (graphics) => {
    // Two passes: a white line first, then the accent offset on top of it. The
    // white keeps the box visible over dark content, which is where a lone accent
    // line vanished entirely.
    for (const pass of [{ color: 0xccffffff, width: 2.5, inset: 0 }, { color: COLOR_ACCENT, width: 1.2, inset: 0 }]) {
      const pen = Buffer.alloc(8);
      if (gdip.GdipCreatePen1(pass.color, pass.width, 2 /* UnitPixel */, pen) !== 0) continue;
      const handle = pen.readBigUInt64LE(0);
      try {
        const left = x + pass.inset;
        const top = y + pass.inset;
        const right = x + w - pass.inset;
        const bottom = y + h - pass.inset;
        for (let at = left; at < right; at += dash + gap) {
          const end = Math.min(at + dash, right);
          gdip.GdipDrawLine(graphics, handle, at, top, end, top);
          gdip.GdipDrawLine(graphics, handle, at, bottom, end, bottom);
        }
        for (let at = top; at < bottom; at += dash + gap) {
          const end = Math.min(at + dash, bottom);
          gdip.GdipDrawLine(graphics, handle, left, at, left, end);
          gdip.GdipDrawLine(graphics, handle, right, at, right, end);
        }
      } finally {
        gdip.GdipDeletePen(handle);
      }
    }
  });
}

/**
 * The font size of the pending text.
 *
 * New text follows the stroke-width slider; text reopened for editing keeps the size
 * it was drawn at, so fixing a typo in an old caption cannot silently resize it.
 *
 * @returns {number}
 */
function pendingTextSize() {
  if (state.text === null) return textSizeFor(state.strokeWidth);
  return state.text.size ?? textSizeFor(state.strokeWidth);
}

/**
 * Where the text caret currently is, in screen coordinates.
 *
 * The end of the pending string, not the point where the user first clicked. Every
 * repositioning of the IME window and every caret draw goes through this, so the
 * painted caret and the candidate window cannot disagree about where the insertion
 * point is.
 *
 * @returns {{x: number, y: number, height: number} | null} null when not typing
 */
function caretPosition() {
  if (state.text === null) return null;
  const size = pendingTextSize();
  /*
   * The caret sits at the insertion index, not at the end of the string.
   *
   * While a selection is active the caret is drawn at the *anchor* end and the
   * selected range is painted behind the text — the caret marks where the next
   * keystroke will start replacing from, so parking it at the string's end while a
   * range is highlighted would point at the wrong place.
   */
  const index = selectionMin(state.text);
  const width = measureText(state.text.value.slice(0, index), size);
  return {
    x: state.text.x + width,
    y: state.text.y,
    height: size * 1.2,
  };
}

/**
 * The lower end of the current text selection.
 *
 * The text being typed keeps two indices — an anchor where the selection started
 * and a cursor where it ends — exactly like an edit control. With no selection the
 * two are equal and this is simply the insertion point.
 *
 * @param {{anchor: number, cursor: number, value: string}} text
 * @returns {number} the smaller index, clamped into the string
 */
function selectionMin(text) {
  const low = Math.min(text.anchor ?? text.value.length, text.cursor ?? text.value.length);
  return Math.max(0, Math.min(text.value.length, low));
}

/** The upper end of the current text selection. */
function selectionMax(text) {
  const high = Math.max(text.anchor ?? text.value.length, text.cursor ?? text.value.length);
  return Math.max(0, Math.min(text.value.length, high));
}

/** Whether the pending text has a non-empty selection. */
function hasTextSelection(text) {
  return text !== null && selectionMin(text) !== selectionMax(text);
}

/**
 * The rightmost x a text annotation may reach before it would leave the frame.
 *
 * Text is the one annotation whose extent grows as it is typed, so it needs the same
 * rule the others follow — stay inside the selection — applied while typing rather
 * than only when dragging. Without it the string kept growing past the edge, the caret
 * walked off the frame, and the visible result was text silently vanishing at the
 * border while the user kept typing into nothing.
 *
 * @param {object} text the pending-text state
 * @returns {number} screen x, or Infinity when there is no frame to respect
 */
function textLimitX(text) {
  const sel = state.sel;
  if (sel === null || sel.w <= 0) return Infinity;
  return sel.x + sel.w;
}

/**
 * Whether `candidate` would still fit inside the frame at this text's position.
 *
 * The width is measured rather than estimated, so the check matches what is actually
 * painted — the same reason the caret uses `measureText` for its position.
 *
 * @param {object} text the pending-text state
 * @param {string} candidate the string that would result
 * @param {number} size font size
 * @returns {boolean}
 */
function textFitsFrame(text, candidate, size) {
  const limit = textLimitX(text);
  if (limit === Infinity) return true;
  return text.x + measureText(candidate, size) <= limit;
}

/**
 * Replace the pending text's selection with `insert`, moving the caret after it.
 *
 * This is the single mutation path for typing, so every edit goes through the same
 * selection bookkeeping — a keystroke over a highlighted range must delete that
 * range first, which is what "select all then type" depends on.
 *
 * A replacement that would push the text past the frame is **rejected**: the string
 * stays as it was and nothing is inserted. Deletions are always allowed, because
 * removing characters can only ever make the text shorter.
 *
 * @param {object} text the pending-text state
 * @param {string} insert the replacement, empty to delete
 * @param {number} size font size, for the overflow check
 * @returns {boolean} true when the change was applied
 */
function replaceTextSelection(text, insert, size) {
  const from = selectionMin(text);
  const to = selectionMax(text);
  const candidate = text.value.slice(0, from) + insert + text.value.slice(to);
  /*
   * Only a *longer* string can overflow, and only when something is being inserted.
   * Checking `candidate.length > text.value.length` keeps Backspace and Delete working
   * at the edge — clamping those too would trap the user with text that cannot be
   * shortened.
   */
  if (insert.length > 0 && candidate.length > text.value.length
    && !textFitsFrame(text, candidate, size)) {
    return false;
  }
  text.value = candidate;
  const at = from + insert.length;
  text.anchor = at;
  text.cursor = at;
  return true;
}

/**
 * Where a byte index of the pending text lands on screen.
 *
 * Used for the selection highlight and for turning a click into a caret index, so
 * the painted range and the text you can click on agree.
 *
 * @param {object} text the pending-text state
 * @param {number} index character index into `text.value`
 * @param {number} size font size
 * @returns {number} screen x
 */
function textXAtIndex(text, index, size) {
  return text.x + measureText(text.value.slice(0, index), size);
}

/**
 * The character index nearest a screen x position.
 *
 * Walks the string and takes the first boundary past the pointer, which makes
 * clicking between two characters land on the nearer gap rather than always to one
 * side of the glyph.
 *
 * @param {object} text the pending-text state
 * @param {number} x screen x
 * @param {number} size font size
 * @returns {number} index in `[0, value.length]`
 */
function textIndexAtX(text, x, size) {
  if (x <= text.x) return 0;
  let best = text.value.length;
  for (let index = 0; index <= text.value.length; index += 1) {
    if (textXAtIndex(text, index, size) >= x) { best = index; break; }
  }
  return best;
}

/**
 * Tell the input method where the text caret is.
 *
 * Without this the IME has no anchor inside this window and puts its candidate
 * window at the top-left of the screen, so typing pinyin showed the choices in a
 * corner far from the text being typed. `COMPOSITIONFORM` is what a real edit
 * control fills in for the same purpose.
 *
 * It must be called again after **every** change to the pending text, not just once
 * when the caret is placed: the candidate window belongs at the insertion point,
 * and that point moves right with each character. Calling it only on the initial
 * click left the candidates parked where the user first clicked while the caret
 * marched away to the right.
 *
 * `CFS_POINT` anchors the candidate window's top-left at the caret. The full
 * `CFS_RECT`+`CFS_FORCE_POSITION` combination is what a real edit control uses, but
 * point anchoring is what makes the candidates follow the caret, which is the
 * behaviour being fixed here.
 *
 * The struct is written by hand because it is only used here and the layout is
 * fixed: dwStyle(4), ptCurrentPos.x(4), ptCurrentPos.y(4), rcArea(16).
 */
function placeImeWindow(caret) {
  const himc = api.ImmGetContext(windowHandle);
  if (himc === null || himc === undefined) return;
  try {
    const CFS_POINT = 0x0002;
    const form = Buffer.alloc(28);
    form.writeUInt32LE(CFS_POINT, 0);
    form.writeInt32LE(Math.round(caret.x), 4);
    form.writeInt32LE(Math.round(caret.y), 8);
    // rcArea is unused with CFS_POINT but must be present in the struct.
    form.writeInt32LE(0, 12);
    form.writeInt32LE(0, 16);
    form.writeInt32LE(0, 20);
    form.writeInt32LE(0, 24);
    api.ImmSetCompositionWindow(himc, form);
  } finally {
    api.ImmReleaseContext(windowHandle, himc);
  }
}

/**
 * Reposition the IME candidate window at the caret's current end.
 *
 * Wrapped so callers do not have to think about `caretPosition()` returning null,
 * which happens whenever typing has ended.
 */
function syncImeToCaret() {
  const caret = caretPosition();
  if (caret !== null) placeImeWindow(caret);
}

/**
 * Handle a key press while text is being typed.
 *
 * This is the text editor's key map, and it exists because the old code handled only
 * three keys by hand: Enter, Escape and Backspace. Everything else fell through to
 * the overlay's own shortcuts, so `Ctrl+A` did nothing (the user's report), arrow
 * keys moved the *selection frame* instead of the insertion point, and Backspace cut
 * the last character regardless of where the caret was.
 *
 * @param {object} text the pending-text state
 * @param {number} key virtual-key code
 * @param {boolean} ctrl whether Ctrl is held
 * @param {boolean} shift whether Shift is held
 * @returns {boolean} true when the key was consumed
 */
function handleTextKey(text, key, ctrl, shift) {
  const length = text.value.length;
  const selectAll = () => { text.anchor = 0; text.cursor = length; };
  const moveTo = (index, extend) => {
    const at = Math.max(0, Math.min(length, index));
    text.cursor = at;
    // Shift extends the selection from wherever the anchor already is; a bare move
    // collapses it, which is the behaviour every field has.
    if (!extend) text.anchor = at;
  };

  if (ctrl) {
    if (key === 0x41 /* A */) { selectAll(); return true; }
    // Ctrl+Backspace / Ctrl+Delete remove a whole word, which is how people fix a
    // sentence rather than a letter.
    if (key === VK_BACK) {
      if (hasTextSelection(text)) { replaceTextSelection(text, ''); return true; }
      let at = text.cursor;
      // Walk back over spaces, then over the word itself.
      while (at > 0 && /\s/.test(text.value[at - 1])) at -= 1;
      while (at > 0 && !/\s/.test(text.value[at - 1])) at -= 1;
      replaceTextSelectionWithoutMove(text, at, text.cursor);
      return true;
    }
    if (key === VK_DELETE) {
      if (hasTextSelection(text)) { replaceTextSelection(text, ''); return true; }
      let at = text.cursor;
      while (at < length && /\s/.test(text.value[at])) at += 1;
      while (at < length && !/\s/.test(text.value[at])) at += 1;
      replaceTextSelectionWithoutMove(text, text.cursor, at);
      return true;
    }
    // Everything else with Ctrl belongs to the overlay (Ctrl+Z, Ctrl+Y).
    return false;
  }

  /*
   * Arrows move the insertion point; Shift extends the selection.
   *
   * With a range highlighted, a bare arrow collapses to the edge it travels toward,
   * which is what every text field does — landing on the far side of the selection
   * would skip a character.
   */
  const low = selectionMin(text);
  const high = selectionMax(text);
  if (key === VK_LEFT) { moveTo(hasTextSelection(text) && !shift ? low : text.cursor - 1, shift); return true; }
  if (key === VK_RIGHT) { moveTo(hasTextSelection(text) && !shift ? high : text.cursor + 1, shift); return true; }
  if (key === VK_HOME) { moveTo(0, shift); return true; }
  if (key === VK_END) { moveTo(length, shift); return true; }
  if (key === VK_BACK) {
    if (hasTextSelection(text)) { replaceTextSelection(text, ''); return true; }
    // A bare Backspace removes one character and leaves the caret where it began.
    if (text.cursor > 0) replaceTextSelectionWithoutMove(text, text.cursor - 1, text.cursor);
    return true;
  }
  if (key === VK_DELETE) {
    if (hasTextSelection(text)) { replaceTextSelection(text, ''); return true; }
    if (text.cursor < length) replaceTextSelectionWithoutMove(text, text.cursor, text.cursor + 1);
    return true;
  }
  // Enter and Escape keep the overlay's existing meaning, so they are not consumed
  // here; the caller handles them further down.
  return false;
}

/**
 * Delete a range without moving the caret past it.
 *
 * `replaceTextSelection` always parks the caret after the inserted text, which is
 * right for typing but wrong for a plain Backspace: the caret should end up where
 * the deleted character began, not after it.
 */
function replaceTextSelectionWithoutMove(text, from, to) {
  const low = Math.max(0, Math.min(text.value.length, from));
  const high = Math.max(low, Math.min(text.value.length, to));
  text.value = text.value.slice(0, low) + text.value.slice(high);
  text.anchor = low;
  text.cursor = low;
}

/**
 * Start editing an existing text annotation, or null if it is not text.
 *
 * The annotation is pulled out of the list while it is being edited and becomes the
 * pending text, so there is exactly one code path for "text being typed": the caret,
 * the selection range, the IME anchoring and the overflow clip all behave identically
 * whether the text is new or old. On commit it goes back into the list at its
 * original position, which keeps the paint order the user already sees.
 *
 * @param {number} index annotation index
 * @returns {boolean} true when editing started
 */
function beginEditingAnnotation(index) {
  const item = state.annots[index];
  if (item === undefined || item.type !== 'text') return false;
  /*
   * Remember the target by identity, not by index.
   *
   * `commitText` splices the label that was being edited back into the list, which
   * shifts every index at or after it. Re-reading `annots[index]` afterwards therefore
   * addresses a *different* annotation — the test caught this by reopening the second
   * label and finding the first one being edited again. Holding the object and
   * locating it again by reference is stable under that shift.
   */
  commitText();
  const target = state.annots[index];
  if (target !== item) {
    // The list moved underneath us; find the same object where it now lives.
    const found = state.annots.indexOf(item);
    if (found === -1) return false;
    index = found;
  }
  if (item.type !== 'text') return false;

  state.annots.splice(index, 1);
  state.editIndex = index;
  state.selectedAnnotation = -1;
  state.text = {
    x: item.x1,
    y: item.y1,
    value: item.text ?? '',
    color: item.color,
    // The same size it was drawn at, not the current slider value: opening an old
    // label must not silently resize it.
    size: item.size ?? textSizeFor(state.strokeWidth),
    anchor: (item.text ?? '').length,
    cursor: (item.text ?? '').length,
  };
  startCaretBlink();
  syncImeToCaret();
  return true;
}

/**
 * Draw the text the user is currently typing.
 *
 * Separated from `drawOverlay` so it can be called inside the frame clip: this is
 * the one string that can grow past the frame's edge while being typed, and letting
 * it spill on to the dimmed desktop showed text that the export would not contain.
 */
function drawPendingText(hdc) {
  if (state.text === null) return;
  const size = pendingTextSize();
  /*
   * The selected range, painted behind the glyphs.
   *
   * Select-all that gives no visual feedback is indistinguishable from doing
   * nothing — which is part of why the missing shortcut was hard to notice. A tinted
   * band over the whole string is the feedback.
   */
  if (hasTextSelection(state.text)) {
    const from = textXAtIndex(state.text, selectionMin(state.text), size);
    const to = textXAtIndex(state.text, selectionMax(state.text), size);
    if (to > from) {
      fillRect(hdc, from, state.text.y - 2, to - from, size * 1.25, 0x552f7cf6);
    }
  }
  drawText(hdc, state.text.value, state.text.x, state.text.y - 2, state.text.color, size, true);
}

/**
 * Whether the caret is inside the frame, so it is worth drawing.
 *
 * The bar itself is drawn outside the clip so it stays visible when it sits on the
 * border, but once the insertion point has run past the frame there is nothing for
 * it to mark — the text it belongs to is clipped away — so it is dropped rather than
 * floating on the dimmed area.
 *
 * @param {{x: number, y: number, height: number}} caret
 * @returns {boolean}
 */
function caretVisible(caret) {
  const sel = state.sel;
  if (sel === null || sel.w <= 0 || sel.h <= 0) return true;
  // A small grace on the right edge: a caret exactly at `x + w` is the normal end
  // state for text that fills the frame, and hiding it there would look like the
  // caret had been lost.
  return caret.x >= sel.x - 1
    && caret.x <= sel.x + sel.w + 2
    && caret.y + caret.height >= sel.y
    && caret.y <= sel.y + sel.h;
}

/** The window timer id used for the caret blink. Arbitrary; only needs to be unique. */
const CARET_TIMER_ID = 0x51;
/**
 * Milliseconds between caret repaints — half of a full blink.
 *
 * Windows' own caret runs at `GetCaretBlinkTime()`, which defaults to 530 ms for a
 * complete on/off cycle, so each state lasts 530 ms and the timer fires on that
 * boundary. The previous 265 ms was half a *state*, i.e. a full cycle every 530 ms
 * total — twice the system rate, which is why it read as frantic.
 */
const CARET_INTERVAL = 530;

/** One-shot timer id for clearing the "no room" flash. */
const OVERFLOW_TIMER_ID = 0x52;

/** One-shot timer id: shows the success toast briefly, then closes the overlay. */
const FEEDBACK_TIMER_ID = 0x53;
/** How long the success toast stays up before the overlay exits. */
const FEEDBACK_MS = 900;
/** The toast text while a confirm/copy is being shown, or null. */
let feedbackText = null;
/** Exit code to use once the toast has been shown. */
let feedbackExitCode = 0;
/** Safety deadline: if the toast timer never arrives, stop waiting anyway. */
let feedbackDeadline = 0;

/**
 * Show a success toast near the top centre, then exit with `code`.
 *
 * Confirming used to close the window instantly with no sign that anything happened. A
 * short, static toast says both *that* it worked and *how* the image was saved (draft vs
 * clipboard). No animation: it appears, holds, and the window closes.
 *
 * @param {string} text message, e.g. "✓ 已复制到剪贴板"
 * @param {number} code exit code to use after the toast
 */
function showFeedback(text, code) {
  feedbackText = text;
  feedbackExitCode = code;
  feedbackDeadline = Date.now() + FEEDBACK_MS + 3000;
  state.done = true;
  if (windowHandle === null) {
    exitWith(code);
    return;
  }
  api.InvalidateRect(windowHandle, null, false);
  api.SetTimer(windowHandle, FEEDBACK_TIMER_ID, FEEDBACK_MS, null);
}

/** Draw the success toast, if one is pending. Called last, so it sits on top. */
function drawFeedback(hdc) {
  if (feedbackText === null) return;
  // Small and unobtrusive: a compact pill, not a banner.
  const size = 15;
  const textWidth = measureText(feedbackText, size);
  const pillW = Math.round(textWidth) + 30;
  const pillH = 30;
  const x = Math.round((screenWidth - pillW) / 2);
  const y = 40;
  fillRoundRectWithShadow(hdc, x, y, pillW, pillH, 8, 0xff2ea043, 0x40000000);
  drawText(hdc, feedbackText, x + 15, y + 8, 0xffffffff, size, true);
}


let caretTimerRunning = false;

/** Start the caret blinking: a timer, so the window repaints while typing idles. */
function startCaretBlink() {
  if (caretTimerRunning || windowHandle === null) return;
  api.SetTimer(windowHandle, CARET_TIMER_ID, CARET_INTERVAL, null);
  caretTimerRunning = true;
}

/** Stop the caret timer. Called whenever the pending text is finished or dropped. */
function stopCaretBlink() {
  if (!caretTimerRunning || windowHandle === null) return;
  api.KillTimer(windowHandle, CARET_TIMER_ID);
  caretTimerRunning = false;
}

/**
 * Whether the text caret is held on instead of blinking.
 *
 * Only ever set by the `--preview-caret` flag, which the screenshot tests use so a
 * capture cannot land on the dark half of the blink. Nothing in normal operation
 * touches it.
 */
let caretAlwaysVisible = false;

/**
 * When the text last refused a keystroke because it would overflow the frame.
 *
 * Used to flash the "no room" edge for a moment. A silent refusal is indistinguishable
 * from a broken keyboard, and the user is looking at the caret, not at the frame's
 * border — a brief red rule at the limit says why nothing happened.
 */
let textOverflowAt = 0;

/**
 * Draw everything above the screenshot: annotations, the selection frame, the size
 * readout and the toolbar.
 *
 * The screenshot and its veil are already in the back buffer, so this only touches
 * the foreground. All of it goes through GDI+ now, which is what the visual quality
 * depends on.
 */
function drawOverlay(hdc) {
  const sel = state.sel;

  /*
   * Annotations are clipped to the frame.
   *
   * They are burned into the crop only, so anything outside the frame belongs to
   * the dimmed desktop and is not part of the image. Drawing it anyway showed ink
   * that would not be saved — which made an annotation dragged past the edge look
   * like it had escaped.
   *
   * The clip is module state rather than a GDI+ call here because each
   * `drawAnnotation` opens its own graphics context; `withGraphics` applies it.
   *
   * The pending text is inside the clip too. It was previously drawn after the clip
   * was restored, so a long label ran out past the frame on to the dimmed desktop —
   * and since it is the one piece of text the user is actively typing, that is the
   * case most likely to be long enough to overflow.
   */
  const previousClip = clipRect;
  clipRect = sel !== null && sel.w > 0 && sel.h > 0
    ? { x: sel.x, y: sel.y, w: sel.w, h: sel.h }
    : null;
  try {
    for (const item of state.annots) drawAnnotation(hdc, item);
    if (state.draft !== null) drawAnnotation(hdc, state.draft);
    if (state.text !== null) drawPendingText(hdc);
  } finally {
    clipRect = previousClip;
  }

  // The picked annotation's dashed box is deliberately outside the clip: it marks
  // the shape, and a frame that vanished at the border would be confusing exactly
  // when an annotation is pressed against it.
  const picked = selectedAnnotation();
  if (picked !== null) {
    const bounds = annotationBounds(picked);
    if (bounds !== null) drawAnnotationFrame(hdc, bounds);
  }

  if (state.text !== null) {
    /*
     * The caret is drawn outside the clip so it stays visible while it sits exactly
     * on the frame's edge, which is where it ends up when the text fills the frame.
     * It is still hidden when the insertion point is beyond the frame entirely,
     * because at that point the user cannot see where they are typing at all.
     */
    const caret = caretPosition();
    const typing = caretAlwaysVisible || Math.floor(Date.now() / CARET_INTERVAL) % 2 === 0;
    /*
     * No caret while a range is selected. The highlight already marks the selection
     * and a blinking bar inside it would suggest a second insertion point that does
     * not exist — the next keystroke replaces the whole range.
     */
    if (typing && caret !== null && !hasTextSelection(state.text) && caretVisible(caret)) {
      fillRect(hdc, caret.x, state.text.y - 2, 2, caret.height, state.text.color);
    }
    /*
     * The "no room" flash.
     *
     * Drawn at the frame's right edge for a third of a second after a keystroke was
     * refused, in the same red as the cancel button so it reads as a stop rather than
     * decoration. Without it, hitting the limit looks exactly like a dead keyboard.
     */
    const flashAge = Date.now() - textOverflowAt;
    if (textOverflowAt !== 0 && flashAge < 340 && sel !== null) {
      const edge = sel.x + sel.w;
      fillRect(hdc, edge - 3, state.text.y - 4, 3, pendingTextSize() * 1.4, 0xffd93a3a);
    }
  }

  if (sel !== null && sel.w > 0 && sel.h > 0) {
    // A white underlay then the accent on top: a single 1.5 px line over a dimmed
    // desktop disappears against dark content, and this keeps the frame readable on
    // any background without making it look heavy.
    strokeRect(hdc, sel.x - 0.5, sel.y - 0.5, sel.w + 1, sel.h + 1, 0xb0ffffff, 1);
    strokeRect(hdc, sel.x, sel.y, sel.w, sel.h, COLOR_ACCENT, 2);
    // Eight handles: the affordance that says "this can be resized". Drawn only
    // once the selection is settled, so they do not jitter around during the drag.
    if (!state.dragging && sel.w > 12 && sel.h > 12) {
      for (const handle of HANDLES) {
        const anchor = handlePoint(sel, handle);
        fillRoundRect(hdc, anchor.x - 4, anchor.y - 4, 8, 8, 2, 0xffffffff);
        strokeRoundRect(hdc, anchor.x - 4, anchor.y - 4, 8, 8, 2, COLOR_ACCENT, 1.4);
      }
    }
    // Size readout in a small dark pill above the selection.
    const label = `${Math.round(sel.w)} x ${Math.round(sel.h)}`;
    const labelWidth = label.length * 7.4 + 16;
    const labelY = Math.max(0, sel.y - 27);
    fillRoundRect(hdc, sel.x, labelY, labelWidth, 22, 6, 0xf0151a21);
    drawText(hdc, label, sel.x + 8, labelY + 4, 0xffffffff, 12);
  }

  if (toolbarVisible()) {
    const bar = toolbarRect();
    const radius = 10;

    fillRoundRectWithShadow(hdc, bar.x, bar.y, bar.w, bar.h, radius, 0xffffffff, 0x30000000);
    strokeRoundRect(hdc, bar.x, bar.y, bar.w, bar.h, radius, 0x22000000, 1);

    let cursorX = bar.x + 7;
    for (const item of toolbarItems()) {
      if (item.kind === 'sep') {
        fillRect(hdc, cursorX + 5, bar.y + 11, 1, bar.h - 22, 0x1a000000);
        cursorX += item.width;
        continue;
      }
      const active = (item.kind === 'tool' && state.tool === item.value)
        || (item.kind === 'style' && state.styleMenuOpen);
      // Hover is tracked by hand: this is a native window, so there is no style
      // engine to apply `:hover`. The pointer position arrives in WM_MOUSEMOVE and
      // is compared against the same rectangles the clicks use.
      const hovered = state.hoverItem !== null
        && state.hoverItem.kind === item.kind
        && state.hoverItem.value === item.value
        && itemEnabled(item);
      const buttonY = bar.y + 5;
      const buttonH = bar.h - 10;
      if (active) {
        fillRoundRect(hdc, cursorX + 1, buttonY, item.width - 2, buttonH, 7, 0x1a2f7cf6);
      } else if (hovered) {
        // A neutral wash, deliberately weaker than the selected tint so the two
        // states stay distinguishable.
        fillRoundRect(hdc, cursorX + 1, buttonY, item.width - 2, buttonH, 7, 0x12000000);
      }

      if (item.kind === 'confirm') {
        // Icon-only, on the same white card as every other button: the tick itself
        // is green. A filled button here made the row look like two different
        // toolbars glued together.
        drawCheckIcon(hdc, cursorX + item.width / 2, bar.y + bar.h / 2, 0xff22a559);
      } else if (item.kind === 'cancel') {
        // Red cross on the shared white background, for the same reason: only the
        // glyph carries the meaning.
        drawCloseIcon(hdc, cursorX + item.width / 2, bar.y + bar.h / 2, 0xffd93a3a);
      } else if (item.kind === 'undo') {
        drawUndoIcon(hdc, cursorX + item.width / 2, bar.y + bar.h / 2, state.undoStack.length > 0);
      } else if (item.kind === 'copy') {
        drawCopyIcon(hdc, cursorX + item.width / 2, bar.y + bar.h / 2);
      } else if (item.kind === 'style') {
        // Current ink shown as a filled dot in the current colour and width, with a
        // chevron: one control that says what it will draw.
        const cy = bar.y + bar.h / 2;
        fillCircle(hdc, cursorX + 14, cy, Math.min(6.5, state.strokeWidth / 2 + 2), PEN_COLORS[state.colorIndex]);
        withGraphics(hdc, (graphics) => {
          const pen = Buffer.alloc(8);
          if (gdip.GdipCreatePen1(0xff8b93a1, 1.5, 2, pen) === 0) {
            const handle = pen.readBigUInt64LE(0);
            gdip.GdipSetPenLineCap197819(handle, 2, 2, 2);
            const chevX = cursorX + 28;
            const chevY = state.styleMenuOpen ? cy - 1 : cy + 3;
            gdip.GdipDrawLine(graphics, handle, chevX, chevY,
              chevX + 3.5, chevY + (state.styleMenuOpen ? 3.5 : -3.5));
            gdip.GdipDrawLine(graphics, handle, chevX + 3.5, chevY + (state.styleMenuOpen ? 3.5 : -3.5),
              chevX + 7, chevY);
            gdip.GdipDeletePen(handle);
          }
        });
      } else if (item.kind === 'tool') {
        drawToolIcon(hdc, item.value, cursorX + (item.width - 18) / 2, bar.y + 10,
          active ? COLOR_ACCENT : 0xff2b3442);
      }
      cursorX += item.width;
    }

    // Tooltip for whatever the pointer is over. Drawn as part of the same frame so
    // it never lags behind a separate window, and skipped while the style popup is
    // open because the two would overlap.
    const hovered = state.hoverItem;
    if (hovered !== null && !state.styleMenuOpen && itemEnabled(hovered)) {
      const label = TOOL_LABELS[hovered.kind === 'tool' ? hovered.value : hovered.kind];
      if (label !== undefined) {
        // Anchored to the button's own centre, not the pointer: the pointer can be
        // anywhere within the button, and following it would make the pill jitter as
        // the mouse moves across a single item.
        let buttonX = bar.x + 7;
        let buttonWidth = 34;
        for (const entry of toolbarItems()) {
          if (entry.kind === hovered.kind && entry.value === hovered.value) {
            buttonWidth = entry.width;
            break;
          }
          buttonX += entry.width;
        }
        const centreX = buttonX + buttonWidth / 2;
        // Measured, not estimated: guessing a character width clipped CJK labels.
        const textWidth = measureText(label, 12.5);
        const pillW = textWidth + 18;
        const pillH = 24;
        let pillX = centreX - pillW / 2;
        pillX = Math.max(6, Math.min(pillX, screenWidth - pillW - 6));
        // Above the bar, since the bar sits under the selection.
        const pillY = Math.max(6, bar.y - pillH - 7);
        fillRoundRectWithShadow(hdc, pillX, pillY, pillW, pillH, 7, 0xf2181c24, 0x40000000);
        drawText(hdc, label, pillX + 9, pillY + 4, 0xffffffff, 12.5);
      }
    }
  }

  // The style popup is drawn last so it sits above the bar.
  if (state.styleMenuOpen && toolbarVisible()) {
    const popup = stylePopupRect();
    fillRoundRectWithShadow(hdc, popup.x, popup.y, popup.w, popup.h, 9, 0xffffffff, 0x38000000);
    strokeRoundRect(hdc, popup.x, popup.y, popup.w, popup.h, 9, 0x22000000, 1);

    // --- stroke width: a slider -------------------------------------------
    const track = sliderTrack();
    const widthRowY = popup.y + 6;
    // The groove, and the portion already crossed, so the value reads from the bar
    // itself rather than only from the knob's position.
    fillRoundRect(hdc, track.left, track.centreY - 2, track.right - track.left, 4, 2, 0x1a000000);
    const knobX = sliderXFromWidth(state.strokeWidth);
    fillRoundRect(hdc, track.left, track.centreY - 2, knobX - track.left, 4, 2, COLOR_ACCENT);
    fillCircle(hdc, knobX, track.centreY, SLIDER_KNOB_RADIUS, 0xffffffff);
    strokeRoundRect(hdc, knobX - SLIDER_KNOB_RADIUS, track.centreY - SLIDER_KNOB_RADIUS,
      SLIDER_KNOB_RADIUS * 2, SLIDER_KNOB_RADIUS * 2, SLIDER_KNOB_RADIUS, COLOR_ACCENT, 2);
    // A dot inside the knob previews the actual thickness.
    fillCircle(hdc, knobX, track.centreY, Math.max(1, state.strokeWidth / 2), COLOR_ACCENT);
    // The number, right of the track: a slider without a readout is guesswork.
    // Rounded for display only — the stored width keeps its fraction so the stroke
    // and the knob position stay smooth.
    drawText(hdc, String(Math.round(state.strokeWidth)), track.right + 12,
      widthRowY + SLIDER_BAND / 2 - 8, 0xff2b3442, 12.5);

    // --- colours ----------------------------------------------------------
    const colorRowY = widthRowY + SLIDER_BAND;
    for (let index = 0; index < PEN_COLORS.length; index += 1) {
      const cellX = popup.x + 10 + index * 32;
      const selected = state.colorIndex === index;
      if (selected) fillRoundRect(hdc, cellX, colorRowY, 28, SLIDER_BAND, 6, 0x1a2f7cf6);
      fillCircle(hdc, cellX + 14, colorRowY + SLIDER_BAND / 2, 7, PEN_COLORS[index]);
      if (selected) strokeRoundRect(hdc, cellX + 3, colorRowY + 2, 22, SLIDER_BAND - 4, 11, COLOR_ACCENT, 1.5);
    }
  }
}

// ------------------------------------------------------------------ clipboard

/** `CF_DIB`: a device-independent bitmap with a 40-byte header. */
const CF_DIB = 8;
/** `GMEM_MOVEABLE`: required by `SetClipboardData`. */
const GMEM_MOVEABLE = 0x0002;

/**
 * Put a block of pixels on the Windows clipboard as a DIB.
 *
 * `CF_DIB` rather than PNG because it is what every Windows application can paste:
 * Paint, Word, Explorer and most chat clients read it, while a PNG blob is only
 * understood by newer software. The clipboard takes ownership of the memory block, so
 * it must come from `GlobalAlloc` and must **not** be freed after a successful
 * `SetClipboardData`.
 *
 * The DIB is written bottom-up because that is the form GDI and most consumers
 * expect; `pixels` arrives top-down, so the rows are copied in reverse.
 *
 * @param {number} width image width
 * @param {number} height image height
 * @param {Buffer} pixels top-down BGRA, `width * height * 4` bytes
 * @returns {boolean} true when the clipboard accepted the image
 */
function copyBitmapToClipboard(width, height, pixels) {
  // BITMAPINFOHEADER(40) + pixel data. The header describes a bottom-up 32-bit DIB.
  const headerSize = 40;
  const rowBytes = width * 4;
  const total = headerSize + rowBytes * height;

  const memory = api.GlobalAlloc(GMEM_MOVEABLE, total);
  if (memory === null || memory === undefined) return false;
  const locked = api.GlobalLock(memory);
  if (locked === null || locked === undefined) {
    api.GlobalFree(memory);
    return false;
  }
  try {
    // Built as one Buffer so the struct writes and the pixel copy stay together, then
    // copied into the locked block in a single call.
    const block = Buffer.alloc(total);
    block.writeUInt32LE(headerSize, 0);      // biSize
    block.writeInt32LE(width, 4);            // biWidth
    block.writeInt32LE(height, 8);           // biHeight, positive: bottom-up
    block.writeUInt16LE(1, 12);              // biPlanes
    block.writeUInt16LE(32, 14);             // biBitCount
    block.writeUInt32LE(0, 16);              // BI_RGB
    block.writeUInt32LE(0, 20);              // biSizeImage (0 is legal for BI_RGB)
    block.writeInt32LE(2835, 24);            // biXPelsPerMeter, 72 dpi
    block.writeInt32LE(2835, 28);            // biYPelsPerMeter
    block.writeUInt32LE(0, 32);              // biClrUsed
    block.writeUInt32LE(0, 36);              // biClrImportant
    for (let row = 0; row < height; row += 1) {
      // Top-down source read backwards into a bottom-up DIB.
      const source = (height - 1 - row) * rowBytes;
      pixels.copy(block, headerSize + row * rowBytes, source, source + rowBytes);
    }
    // One copy into the locked block. `koffi.address(block)` is where the Buffer's
    // bytes actually live, which is what the native side needs.
    api.RtlMoveMemory(locked, koffi.address(block), total);
  } finally {
    api.GlobalUnlock(memory);
  }

  if (!api.OpenClipboard(windowHandle)) {
    api.GlobalFree(memory);
    return false;
  }
  try {
    api.EmptyClipboard();
    // `SetClipboardData` takes ownership on success; freeing afterwards would leave
    // the clipboard pointing at released memory, so the result decides.
    const stored = api.SetClipboardData(CF_DIB, memory);
    if (stored === null || stored === undefined) {
      api.GlobalFree(memory);
      return false;
    }
    return true;
  } finally {
    api.CloseClipboard();
  }
}

// ------------------------------------------------------------------ exports

/**
 * Render the selection, with annotations burned in, into a pixel buffer.
 *
 * Split out of `buildResult` because there are now two consumers of the same image:
 * the PNG encoder (used when confirming the capture) and the clipboard (which needs
 * raw BGRA pixels, not a compressed file). Sharing this function is what guarantees
 * the pasted image is byte-for-byte the same picture as the saved one.
 *
 * The returned buffer is **top-down BGRA**, matching what `encodePng` and the
 * clipboard writer both expect.
 *
 * @param {{x: number, y: number, w: number, h: number}} sel the crop
 * @returns {{width: number, height: number, pixels: Buffer} | null}
 */
function renderSelectionPixels(sel) {
  const x = Math.max(0, Math.round(sel.x));
  const y = Math.max(0, Math.round(sel.y));
  const w = Math.min(screenWidth - x, Math.round(sel.w));
  const h = Math.min(screenHeight - y, Math.round(sel.h));
  if (w <= 0 || h <= 0) return null;

  // Compatible with the *screen*, not a NULL memory DC: the latter produces a
  // 1-bit monochrome bitmap and the export would come out as a black-and-white
  // dither of the screenshot.
  const screenDc = api.GetDC(null);
  const memory = api.CreateCompatibleDC(screenDc);
  const bitmap = api.CreateCompatibleBitmap(screenDc, w, h);
  const previous = api.SelectObject(memory, bitmap);
  // Everything below draws in screen coordinates; this is the one line that maps
  // them onto the crop. Set before any annotation is drawn and restored in the
  // `finally`, so a later paint of the real window is unaffected.
  const previousOriginX = drawOriginX;
  const previousOriginY = drawOriginY;
  drawOriginX = x;
  drawOriginY = y;
  try {
    // The header for handing a **negative-height** DIB to GetDIBits is fine, but
    // SetDIBitsToDevice needs positive. The frame copy below uses `bim`, which is
    // positive, and the read-back uses this one.
    const header = Buffer.alloc(40);
    header.writeUInt32LE(40, 0);
    header.writeInt32LE(w, 4);
    header.writeInt32LE(h, 8);
    header.writeUInt16LE(1, 12);
    header.writeUInt16LE(32, 14);
    header.writeUInt32LE(BI_RGB, 16);

    // Copy just the selection out of the frame bitmap. A `BitBlt` with a source
    // offset is the whole crop — no scanline maths, no header games.
    if (api.BitBlt(memory, 0, 0, w, h, frameBitmap.memory, x, y, SRCCOPY) === 0) return null;
    for (const item of state.annots) {
      if (item.type === 'mosaic') {
        /*
         * Real pixelation, over the exported pixels.
         *
         * The bounds are kept in **screen** coordinates like every other
         * annotation, and `fillRect` maps them onto the crop through the world
         * transform. Subtracting the crop origin here as well would apply the
         * offset twice and draw the blocks in the wrong place.
         */
        const left = Math.max(x, Math.round(Math.min(item.x1, item.x2)));
        const top = Math.max(y, Math.round(Math.min(item.y1, item.y2)));
        const right = Math.min(x + w, Math.round(Math.max(item.x1, item.x2)));
        const bottom = Math.min(y + h, Math.round(Math.max(item.y1, item.y2)));
        const block = 10;
        for (let by = top; by < bottom; by += block) {
          for (let bx = left; bx < right; bx += block) {
            let r = 0;
            let g = 0;
            let b = 0;
            let count = 0;
            for (let sy = by; sy < Math.min(by + block, bottom); sy += 3) {
              // `bits` is bottom-up, so the row must be flipped to sample the patch
              // that is actually under the mosaic. Reading it straight sampled the
              // mirror-image row, which pixelated unrelated content.
              const row = (screenHeight - 1 - Math.min(screenHeight - 1, sy)) * stride;
              for (let sx = bx; sx < Math.min(bx + block, right); sx += 3) {
                const at = (row + sx) * 4;
                b += bits[at];
                g += bits[at + 1];
                r += bits[at + 2];
                count += 1;
              }
            }
            if (count === 0) continue;
            /*
             * Opaque ARGB, not a bare RGB triple.
             *
             * `fillRect` goes through GDI+, which reads `0xAARRGGBB` — a value with
             * no alpha byte is fully transparent there, so the whole mosaic used to
             * paint nothing at all. The bytes are also ordered correctly here: the
             * DIB is BGRA, so `bits[at]` is blue.
             */
            const blue = (b / count) | 0;
            const green = (g / count) | 0;
            const red = (r / count) | 0;
            fillRect(
              memory, bx, by,
              Math.min(block, right - bx), Math.min(block, bottom - by),
              0xff000000 | (red << 16) | (green << 8) | blue,
            );
          }
        }
      } else {
        drawAnnotation(memory, item);
      }
    }

    // Read back bottom-up (the form GDI reliably honours), then flip once, so the
    // encoded image has the same orientation as what the user saw.
    const bottomUpPixels = Buffer.alloc(w * 4 * h);
    const readHeader = Buffer.from(header);
    readHeader.writeInt32LE(h, 8);
    if (api.GetDIBits(memory, bitmap, 0, h, bottomUpPixels, readHeader, DIB_RGB_COLORS) !== h) return null;
    const rowBytes = w * 4;
    const pixels = Buffer.alloc(bottomUpPixels.length);
    for (let row = 0; row < h; row += 1) {
      bottomUpPixels.copy(pixels, row * rowBytes, (h - 1 - row) * rowBytes, (h - row) * rowBytes);
    }
    return { width: w, height: h, pixels };
  } finally {
    drawOriginX = previousOriginX;
    drawOriginY = previousOriginY;
    api.SelectObject(memory, previous);
    api.DeleteObject(bitmap);
    api.DeleteDC(memory);
    api.ReleaseDC(null, screenDc);
  }
}

/**
 * Build the final PNG: the selection, with annotations burned in.
 * @param {{x: number, y: number, w: number, h: number}} sel the crop
 * @returns {Buffer | null}
 */
function buildResult(sel) {
  const rendered = renderSelectionPixels(sel);
  if (rendered === null) return null;
  return encodePng(rendered.width, rendered.height, rendered.pixels);
}

/**
 * Copy the selection to the Windows clipboard, annotations included.
 *
 * Returns whether it worked so the caller can report a failure; a silent no-op would
 * leave the user pasting a stale image with no idea why.
 *
 * @param {{x: number, y: number, w: number, h: number}} sel the crop
 * @returns {boolean}
 */
function copySelectionToClipboard(sel) {
  const rendered = renderSelectionPixels(sel);
  if (rendered === null) return false;
  return copyBitmapToClipboard(rendered.width, rendered.height, rendered.pixels);
}

// ------------------------------------------------------------------- the loop

const classBuffer = toW('DshScreenshotOverlay');
let windowHandle = null;

const wndProcType = koffi.pointer(koffi.proto('intptr_t __stdcall WndProc(void *h, uint32_t m, uintptr_t w, intptr_t l)'));
const wndProc = koffi.register((hwnd, message, wParam, lParam) => {
  try {
    if (message === WM_PAINT) {
      const paintStruct = Buffer.alloc(72);
      const hdc = api.BeginPaint(hwnd, paintStruct);
      try {
        // Double buffering: compose the identical frame the preview produces,
        // off-screen, then present it in one blit. Painting straight onto the
        // window DC exposed a cleared background between draw calls, which is
        // what made the panel and toolbar flicker.
        paint(backBuffer.memory);
        api.BitBlt(hdc, 0, 0, screenWidth, screenHeight, backBuffer.memory, 0, 0, SRCCOPY);
      } finally {
        api.EndPaint(hwnd, paintStruct);
      }
      return 0;
    }
    if (message === WM_ERASEBKGND) {
      // Claim the erase: nothing needs clearing because `WM_PAINT` covers every
      // pixel. Without this Windows fills the window with the class background —
      // black — between frames, which is the flash.
      return 1;
    }
    if (message === WM_MOUSEMOVE) {
      const x = Number(BigInt(lParam) & 0xffffn);
      const y = Number((BigInt(lParam) >> 16n) & 0xffffn);

      state.cursor = { x, y };
      // Slider drag: the width follows the pointer until the button is released,
      // which is what makes it feel continuous rather than stepped.
      if (state.sliderDrag) {
        const next = widthFromSliderX(x);
        if (next !== state.strokeWidth) {
          state.strokeWidth = next;
          api.InvalidateRect(hwnd, null, false);
        }
        return 0;
      }
      // Track what the pointer is over so the toolbar can highlight it. Only while
      // nothing is being dragged: during a drag the pointer belongs to the gesture,
      // and repainting the bar would be noise.
      if (!state.dragging) {
        // A disabled entry never becomes the hovered one: it must not light up and
        // must not name a tooltip for an action that cannot run. The entry itself is
        // still returned by `toolbarItemAt`, so a click on it is swallowed by the bar
        // instead of falling through and starting a new selection.
        const hitNow = toolbarItemAt(x, y);
        const nextHover = hitNow !== null && itemEnabled(hitNow) ? hitNow : null;
        const changed = (nextHover === null) !== (state.hoverItem === null)
          || (nextHover !== null && state.hoverItem !== null
            && (nextHover.kind !== state.hoverItem.kind || nextHover.value !== state.hoverItem.value));
        if (changed) {
          state.hoverItem = nextHover;
          // Only the bar changed, but the whole overlay is composed into one buffer;
          // an invalidation is still cheaper than leaving the highlight stale.
          api.InvalidateRect(hwnd, null, false);
        }
      }
      if (state.dragging) {
        if (state.choosing) {
          state.sel = {
            x: Math.min(state.startX, x),
            y: Math.min(state.startY, y),
            w: Math.abs(x - state.startX),
            h: Math.abs(y - state.startY),
          };
        } else if (state.annotGrab !== null) {
          // Dragging a picked annotation. The delta is measured from where the press
          // landed and applied incrementally, so the annotation follows the pointer
          // exactly even after being clamped at an edge — it stops at the border and
          // resumes the moment the pointer comes back, rather than storing up an
          // offset that would make it jump.
          const target = selectedAnnotation();
          if (target !== null) {
            const wantedX = x - state.annotGrab.startX;
            const wantedY = y - state.annotGrab.startY;
            const step = clampAnnotationDelta(
              target,
              wantedX - state.annotGrab.appliedX,
              wantedY - state.annotGrab.appliedY,
            );
            if (step.dx !== 0 || step.dy !== 0) {
              moveAnnotation(target, step.dx, step.dy);
              state.annotGrab.appliedX += step.dx;
              state.annotGrab.appliedY += step.dy;
            }
          }
        } else if (state.grab !== null) {
          // Moving or resizing the selection that is already there. Both work off
          // the rectangle captured at press time, so the gesture never drifts.
          if (state.grab.mode === 'move') {
            state.sel = moveRect(state.grab.base, x - state.grab.fromX, y - state.grab.fromY);
          } else {
            state.sel = resizeRect(state.grab.base, state.grab.handle, x, y);
          }
        } else if (state.draft !== null) {
          /*
           * Clamp the pointer to the frame before recording it.
           *
           * A drawing gesture that leaves the frame used to keep recording, so the
           * stroke ran across the dimmed desktop and was silently cut off by the
           * crop. Pinning the point to the frame's edge means the line stops exactly
           * at the border, matching what will be saved.
           */
          const inside = state.sel === null ? { x, y } : {
            x: Math.max(state.sel.x, Math.min(state.sel.x + state.sel.w, x)),
            y: Math.max(state.sel.y, Math.min(state.sel.y + state.sel.h, y)),
          };
          if (state.draft.type === 'pen') {
            state.draft.points.push({ x: inside.x, y: inside.y });
          } else {
            state.draft.x2 = inside.x;
            state.draft.y2 = inside.y;
          }
        }
        api.InvalidateRect(hwnd, null, false);
      } else {
        // Not dragging: the cursor advertises what a press would do here — resize,
        // move, or start a new selection.
        applyCursorFor(x, y);
      }
      return 0;
    }
    if (message === WM_LBUTTONDBLCLK) {
      /*
       * Double-clicking a text annotation reopens it for editing.
       *
       * This is the standard gesture for "edit this label", and it is what makes text
       * repairable: before this, a typo could only be fixed by deleting the whole
       * annotation and drawing a new one.
       */
      const x = Number(BigInt(lParam) & 0xffffn);
      const y = Number((BigInt(lParam) >> 16n) & 0xffffn);
      const index = annotationAt(x, y);
      if (index !== -1 && state.annots[index]?.type === 'text' && beginEditingAnnotation(index)) {
        api.InvalidateRect(hwnd, null, false);
        return 0;
      }
      // Anything else: fall through to the ordinary press behaviour.
    }
    if (message === WM_LBUTTONDOWN) {
      const x = Number(BigInt(lParam) & 0xffffn);
      const y = Number((BigInt(lParam) >> 16n) & 0xffffn);

      // The popup is drawn on top, so its hits must be resolved first.
      const styleHit = hitStylePopup(x, y);
      if (styleHit !== null) {
        if (styleHit.kind === 'widthDrag') {
          /*
           * The slider stays open and keeps tracking: closing on press would make it
           * a one-shot picker and defeat the point of dragging. The capture keeps the
           * pointer so the drag survives leaving the popup's rectangle.
           */
          state.strokeWidth = styleHit.value;
          state.sliderDrag = true;
          api.SetCapture(hwnd);
          api.InvalidateRect(hwnd, null, false);
          return 0;
        }
        if (styleHit.kind === 'color') {
          /*
           * Picking a colour keeps the popup open.
           *
           * Closing on every swatch made the panel a one-shot picker: choosing a
           * colour and then a width meant reopening it, and comparing two colours
           * meant reopening it twice. The popup now closes when the user does
           * something else — picks a tool, presses inside the frame, or presses
           * outside the panel.
           */
          state.colorIndex = styleHit.value;
          api.InvalidateRect(hwnd, null, false);
          return 0;
        }
        state.styleMenuOpen = false;
        api.InvalidateRect(hwnd, null, false);
        return 0;
      }
      /*
       * A press outside the panel closes it **and keeps going**.
       *
       * This used to `return` after closing, so the first click on the canvas only
       * dismissed the popup and left nothing behind — the user then had to click a
       * second time to actually draw at that spot. Closing a panel is not an action
       * the user asked for; it is a side effect of where they pressed, so the press
       * continues to whatever it would have done anyway.
       *
       * The one thing this must not break is a press on the toolbar or on the panel
       * itself: both are handled above and return before reaching here.
       */
      if (state.styleMenuOpen) {
        state.styleMenuOpen = false;
        api.InvalidateRect(hwnd, null, false);
        // Falls through deliberately: the same press starts the annotation.
      }

      if (state.text !== null) {
        /*
         * A click while typing repositions the caret when it lands on the text.
         *
         * Committing on every click made it impossible to place the caret mid-word —
         * the only way to edit was to delete from the end. Clicking away from the text
         * still commits, which is what "click elsewhere to finish" means.
         */
        const size = pendingTextSize();
        const bounds = annotationBounds({
          type: 'text',
          x1: state.text.x,
          y1: state.text.y,
          text: state.text.value,
          size,
        });
        if (bounds !== null && insideRect(x, y, bounds)) {
          const at = textIndexAtX(state.text, x, size);
          // Shift+click extends from the existing anchor, as in any editor. The
          // modifier is read from `GetKeyState` here because this handler has no
          // access to the keyboard branch's local `shiftDown`.
          const shiftHeld = (api.GetKeyState(VK_SHIFT) & 0x8000) !== 0;
          state.text.cursor = at;
          if (!shiftHeld) state.text.anchor = at;
          syncImeToCaret();
          api.InvalidateRect(hwnd, null, false);
          return 0;
        }
        commitText();
        return 0;
      }
      const hit = hitToolbar(x, y);
      if (hit !== null) {
        if (hit.kind === 'tool') {
          state.tool = hit.value;
          // Picking a tool is a commitment to drawing, so the settings panel gets
          // out of the way — this is the "用了某个工具再收起" rule.
          state.styleMenuOpen = false;
        } else if (hit.kind === 'style') state.styleMenuOpen = !state.styleMenuOpen;
        else if (hit.kind === 'undo') undo();
        else if (hit.kind === 'copy') copyAndExit();
        else if (hit.kind === 'confirm') confirm();
        else if (hit.kind === 'cancel') cancel();
        api.InvalidateRect(hwnd, null, false);
        return 0;
      }
      // A selection handle always wins: it is the smallest target and the one the
      // user aims at most deliberately.
      if (state.sel !== null && hitHandle(x, y, state.sel) !== null) {
        state.dragging = true;
        state.choosing = false;
        state.grab = {
          mode: 'resize',
          base: { ...state.sel },
          handle: hitHandle(x, y, state.sel),
          fromX: x,
          fromY: y,
        };
        api.SetCapture(hwnd);
        return 0;
      }
      /*
       * Picking up a single annotation.
       *
       * This is resolved *before* the tool branches: a press on an existing
       * annotation always picks that annotation up, whichever tool is selected. The
       * alternative — requiring a dedicated move tool — meant that with the arrow
       * tool still active, clicking an arrow started drawing a new arrow on top of
       * it instead of grabbing it.
       *
       * Drawing a *new* annotation is unaffected: it needs a press on empty space,
       * which is exactly what this branch does not claim.
       */
      {
        const index = annotationAt(x, y);
        if (index !== -1) {
          state.selectedAnnotation = index;
          state.annotGrab = {
            index,
            startX: x,
            startY: y,
            // The annotation is edited in place, so the last applied delta has to be
            // subtracted rather than recomputing from a copy: text and pen strokes
            // have no single origin to rebuild them from.
            appliedX: 0,
            appliedY: 0,
          };
          state.dragging = true;
          state.choosing = false;
          api.SetCapture(hwnd);
          api.InvalidateRect(hwnd, null, false);
          return 0;
        }
        // Empty space clears the pick, so the dashed box cannot be left behind
        // pointing at something the user has moved on from.
        if (state.selectedAnnotation !== -1) {
          state.selectedAnnotation = -1;
          api.InvalidateRect(hwnd, null, false);
        }
      }
      /*
       * Dragging the frame itself.
       *
       * Two rules, chosen by whether a tool has been picked:
       *
       * - No tool yet (the frame was just dragged out): the whole interior moves the
       *   frame. Nothing can be drawn, so there is nothing else a press could mean,
       *   and asking the user to hit a 4 px border to nudge a fresh selection would
       *   be needless precision.
       * - A tool is active: only the border moves the frame, and the interior becomes
       *   canvas, so a shape can be placed near the edge of a small selection without
       *   the frame sliding out from under the pointer.
       */
      if (state.tool === null
        ? (state.sel !== null && insideRect(x, y, state.sel))
        : hitsFrameEdge(x, y)) {
        state.dragging = true;
        state.choosing = false;
        state.grab = { mode: 'move', base: { ...state.sel }, fromX: x, fromY: y };
        api.SetCapture(hwnd);
        return 0;
      }
      if (state.sel !== null && x >= state.sel.x && x <= state.sel.x + state.sel.w
        && y >= state.sel.y && y <= state.sel.y + state.sel.h) {
        if (state.tool === 'mosaic') {
          state.draft = { type: 'mosaic', x1: x, y1: y, x2: x, y2: y, color: PEN_COLORS[state.colorIndex], width: 1 };
          state.dragging = true;
          state.choosing = false;
          api.SetCapture(hwnd);
          return 0;
        }
        if (state.tool === 'text') {
          // Click places a caret; typing goes to `state.text` from WM_CHAR, and
          // Enter or a click elsewhere commits it.
          commitText();
          state.text = {
            x,
            y,
            value: '',
            color: PEN_COLORS[state.colorIndex],
            // Two indices, like an edit control: `anchor` is where a selection
            // started, `cursor` is where it ends. Equal means "no selection, caret
            // at this index".
            anchor: 0,
            cursor: 0,
          };
          /*
           * Park the IME's candidate window on the caret, or it appears in the
           * screen's top-left corner where nobody is looking. This is only the
           * initial placement — every later keystroke re-anchors it, because the
           * insertion point moves as the text grows.
           */
          syncImeToCaret();
          startCaretBlink();
          api.InvalidateRect(hwnd, null, false);
          return 0;
        }
        if (state.tool === 'rect' || state.tool === 'ellipse' || state.tool === 'arrow' || state.tool === 'pen') {
          const width = state.strokeWidth;
          state.draft = state.tool === 'pen'
            ? { type: 'pen', points: [{ x, y }], color: PEN_COLORS[state.colorIndex], width }
            : { type: state.tool, x1: x, y1: y, x2: x, y2: y, color: PEN_COLORS[state.colorIndex], width };
          state.dragging = true;
          state.choosing = false;
          api.SetCapture(hwnd);
          return 0;
        }
      }
      // Anything else starts a new selection. Its annotations are reset when the
      // new frame is actually drawn (on release), not here: doing it on press meant
      // a click that turned out to be a mis-click destroyed the existing work.
      state.selBeforeChoose = state.sel;
      state.choosing = true;
      state.dragging = true;
      state.startX = x;
      state.startY = y;
      state.sel = { x, y, w: 0, h: 0 };
      api.SetCapture(hwnd);
      api.InvalidateRect(hwnd, null, false);
      return 0;
    }
    if (message === WM_LBUTTONUP) {

      // Releasing the slider ends the drag but keeps the popup open, so the width can
      // be adjusted again without reopening it.
      if (state.sliderDrag) {
        state.sliderDrag = false;
        api.ReleaseCapture();
        api.InvalidateRect(hwnd, null, false);
        return 0;
      }
      if (state.dragging) {
        state.dragging = false;
        state.grab = null;
        // The drag of a picked annotation is committed on release and does not touch
        // the frame, so it is checked before the frame bookkeeping below.
        if (state.annotGrab !== null) {
          state.annotGrab = null;
          api.ReleaseCapture();
          api.InvalidateRect(hwnd, null, false);
          return 0;
        }
        api.ReleaseCapture();
        if (state.choosing) {
          state.choosing = false;
          if (state.sel !== null && (state.sel.w < 5 || state.sel.h < 5)) {
            // Too small to be a frame: a mis-click. Put the previous frame back so
            // the user's selection and annotations survive it.
            state.sel = state.selBeforeChoose;
          } else {
            // A genuine new frame: its annotations start empty, and the tool goes
            // back to "none" so the fresh frame can be nudged by pressing anywhere
            // inside it. That is the state the frame is in right after it is first
            // dragged out, which is when it still needs positioning.
            state.annots = [];
            state.tool = null;
            state.selectedAnnotation = -1;
          }
          state.selBeforeChoose = null;
        } else if (state.draft !== null) {
          pushAnnotation(state.draft);
          state.draft = null;
        }
        api.InvalidateRect(hwnd, null, false);
      }
      return 0;
    }
    if (message === WM_RBUTTONDOWN) {
      /*
       * Consume the press; cancel on the release.
       *
       * Cancelling on right-button-DOWN destroyed this window before the matching
       * right-button-UP, so the UP — and the context-menu message the system derives from
       * it — fell through to the window underneath, which opened its own context menu.
       * Keeping the window alive through the UP keeps the whole gesture here.
       */
      return 0;
    }
    if (message === WM_RBUTTONUP) {
      cancel();
      return 0;
    }
    if (message === WM_CONTEXTMENU) {
      // This window only exists to be drawn on; never show a context menu.
      return 0;
    }
    if (message === WM_KEYDOWN) {
      const key = Number(BigInt(wParam) & 0xffffn);
      /*
       * The modifiers are read from `GetKeyState`, not from `lParam`.
       *
       * Bits 16..23 of a `WM_KEYDOWN` are the scan code and bit 29 is the Alt
       * context — there is no Ctrl bit at all. The old check read bit 15 of the
       * scan code and consulted a `state.ctrlHeld` that nothing ever set, so Ctrl+Z
       * silently did nothing.
       */
      const ctrlDown = (api.GetKeyState(VK_CONTROL) & 0x8000) !== 0;
      const shiftDown = (api.GetKeyState(VK_SHIFT) & 0x8000) !== 0;

      /*
       * While text is being typed the keyboard belongs to that text.
       *
       * This has to come before every other shortcut. Ctrl+A was doing nothing
       * because only a bare handful of keys were handled at all — arrows nudged the
       * *frame* instead of moving the insertion point, and Backspace blindly cut the
       * last character no matter where the caret was. The edit keys are handled here
       * as one block so the text behaves like the field it looks like.
       *
       * Returns true when the key was consumed.
       */
      if (state.text !== null && handleTextKey(state.text, key, ctrlDown, shiftDown)) {
        syncImeToCaret();
        api.InvalidateRect(hwnd, null, false);
        return 0;
      }

      // A palette accelerator: Ctrl+Z / Ctrl+Y, the shortcuts every drawing tool has.
      if (ctrlDown && (key === 0x5a /* Z */ || key === 0x59 /* Y */)) {
        if (key === 0x5a) undo();
        else redo();
        api.InvalidateRect(hwnd, null, false);
        return 0;
      }
      /*
       * Arrow keys nudge whatever is picked — the annotation if one is picked, the
       * frame otherwise.
       *
       * This is the keyboard half of "separately movable": a mouse drag is good for
       * a rough placement, but landing an arrow exactly on a row of text needs
       * single-pixel steps. Shift takes a bigger stride for crossing the screen.
       */
      if (key === VK_LEFT || key === VK_UP || key === VK_RIGHT || key === VK_DOWN) {
        const stride = shiftDown ? 10 : 1;
        const dx = key === VK_LEFT ? -stride : key === VK_RIGHT ? stride : 0;
        const dy = key === VK_UP ? -stride : key === VK_DOWN ? stride : 0;
        const target = selectedAnnotation();
        if (target !== null) {
          const step = clampAnnotationDelta(target, dx, dy);
          if (step.dx !== 0 || step.dy !== 0) {
            moveAnnotation(target, step.dx, step.dy);
            api.InvalidateRect(hwnd, null, false);
          }
          return 0;
        }
        if (state.sel !== null) {
          state.sel = moveRect(state.sel, dx, dy);
          api.InvalidateRect(hwnd, null, false);
          return 0;
        }
        return 0;
      }
      // Delete removes the picked annotation. The frame itself is not deletable —
      // there would be nothing left to capture.
      if ((key === VK_DELETE || key === VK_BACK) && selectedAnnotation() !== null) {
        const index = state.selectedAnnotation;
        pushAnnotationRemoval(index);
        api.InvalidateRect(hwnd, null, false);
        return 0;
      }
      if (key === VK_ESCAPE) {
        // Escape drops the pick first, then closes the popup, then cancels: each
        // step undoes the most local thing the user did.
        if (state.selectedAnnotation !== -1) {
          state.selectedAnnotation = -1;
          api.InvalidateRect(hwnd, null, false);
          return 0;
        }
        // Escape closes the popup first: cancelling the whole screenshot because a
        // menu was open would be a nasty surprise.
        if (state.styleMenuOpen) state.styleMenuOpen = false;
        else if (state.text !== null) {
          state.text = null;
          stopCaretBlink();
        } else cancel();
        api.InvalidateRect(hwnd, null, false);
        return 0;
      }
      if (key === VK_RETURN) {
        if (state.text !== null) commitText();
        else confirm();
        api.InvalidateRect(hwnd, null, false);
        return 0;
      }
      return 0;
    }
    if (message === WM_CHAR) {
      if (state.text !== null) {
        const code = Number(BigInt(wParam) & 0xffffn);
        if (code >= 32) {
          /*
           * Typing replaces the selection, exactly as an edit control does. Without
           * that, "select all then type" would append to the old string instead of
           * replacing it — which makes select-all useless even once it exists.
           *
           * The size is passed so the edit can be refused when it would push the text
           * past the frame's edge: text obeys the same "nothing leaves the selection"
           * rule as every other annotation, and the alternative — accepting the
           * keystroke but clipping the result — leaves the user typing into a wall.
           */
          const accepted = replaceTextSelection(state.text, String.fromCharCode(code), pendingTextSize());
          if (!accepted) {
            /*
             * Refused because it would leave the frame.
             *
             * The caret blink timer is far too slow to clear a short flash, so a
             * dedicated one-shot timer repaints once the 340 ms window has passed.
             * Without it the red rule would linger until the next blink.
             */
            textOverflowAt = Date.now();
            api.SetTimer(hwnd, OVERFLOW_TIMER_ID, 360, null);
          }
          /*
           * The insertion point just moved, so the candidate window is repositioned
           * to sit under the new end of the text.
           *
           * This is the call that was missing: without it the IME stayed parked
           * where the user first clicked and the candidates drifted away from the
           * caret as the line grew.
           */
          syncImeToCaret();
          api.InvalidateRect(hwnd, null, false);
        }
      }
      return 0;
    }
    if (message === WM_TIMER) {
      /*
       * Two timers share this message; `wParam` says which fired.
       *
       * The caret blink only repaints while text is pending. The overflow flash is a
       * one-shot that repaints once and then removes itself, so the red edge clears
       * promptly instead of waiting for the next blink.
       */
      const timerId = Number(BigInt(wParam) & 0xffffn);
      if (timerId === FEEDBACK_TIMER_ID) {
        // The success toast has been on screen long enough: close with the saved outcome.
        api.KillTimer(hwnd, FEEDBACK_TIMER_ID);
        exitWith(feedbackExitCode);
        return 0;
      }
      if (timerId === OVERFLOW_TIMER_ID) {
        api.KillTimer(hwnd, OVERFLOW_TIMER_ID);
        api.InvalidateRect(hwnd, null, false);
        return 0;
      }
      if (state.text !== null) api.InvalidateRect(hwnd, null, false);
      return 0;
    }
    if (message === WM_DESTROY) {
      stopCaretBlink();
      api.PostQuitMessage(0);
      return 0;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logFocus(`window procedure error: ${message}`);
    console.error('overlay error:', message);
  }
  return api.DefWindowProcW(hwnd, message, wParam, lParam);
}, wndProcType);

let textInputStarted = false;

/**
 * Add an annotation and record the step for undo.
 *
 * History is a snapshot of the list rather than a command log: the lists are tiny
 * and a snapshot cannot drift out of sync with what is on screen.
 */
function pushAnnotation(item) {
  state.undoStack.push(state.annots.slice());
  if (state.undoStack.length > 50) state.undoStack.shift();
  state.redoStack.length = 0;
  state.annots.push(item);
}

/**
 * Remove one annotation and record the step for undo.
 *
 * Kept separate from `pushAnnotation` because the pick has to be dropped too: the
 * index would otherwise point at whatever slotted into the deleted one's place.
 */
function pushAnnotationRemoval(index) {
  if (index < 0 || index >= state.annots.length) return;
  state.undoStack.push(state.annots.slice());
  if (state.undoStack.length > 50) state.undoStack.shift();
  state.redoStack.length = 0;
  state.annots.splice(index, 1);
  state.selectedAnnotation = -1;
}

/** Step back one annotation. */
function undo() {
  if (state.undoStack.length === 0) return;
  state.redoStack.push(state.annots.slice());
  state.annots = state.undoStack.pop();
  // The list was replaced wholesale, so an index into it now names a different
  // annotation — or none. Dropping the pick is the only honest answer.
  state.selectedAnnotation = -1;
}

/** Step forward again after an undo. Reached only by Ctrl+Y — the bar has no redo button. */
function redo() {
  if (state.redoStack.length === 0) return;
  state.undoStack.push(state.annots.slice());
  state.annots = state.redoStack.pop();
  state.selectedAnnotation = -1;
}

/**
 * Finish the text being typed and add it as an annotation.
 *
 * The previous version inspected the pending text and then dropped it, so typing a
 * label produced nothing at all — the text simply vanished on Enter.
 */
function commitText() {
  if (state.text === null) return;
  const pending = state.text;
  const editing = state.editIndex;
  state.text = null;
  state.editIndex = -1;
  // The caret has nothing left to blink for.
  stopCaretBlink();
  const value = pending.value.trim();
  /*
   * Editing an existing label puts it back where it was, rather than appending a new
   * annotation and deleting the old one: the paint order the user is looking at stays
   * put, and the undo history records one step instead of two.
   */
  if (editing !== -1) {
    state.undoStack.push(state.annots.slice());
    if (state.undoStack.length > 50) state.undoStack.shift();
    state.redoStack.length = 0;
    if (value === '') return; // emptied: the label is gone
    const restored = {
      type: 'text',
      x1: pending.x,
      y1: pending.y,
      x2: pending.x,
      y2: pending.y,
      color: pending.color,
      width: state.strokeWidth,
      text: value,
      // Keep the size it had, so editing a caption does not resize it.
      size: pending.size ?? textSizeFor(state.strokeWidth),
    };
    const at = Math.max(0, Math.min(state.annots.length, editing));
    state.annots.splice(at, 0, restored);
    return;
  }
  if (value === '') return;
  pushAnnotation({
    type: 'text',
    x1: pending.x,
    y1: pending.y,
    x2: pending.x,
    y2: pending.y,
    color: pending.color,
    width: state.strokeWidth,
    text: value,
    size: pending.size ?? textSizeFor(state.strokeWidth),
  });
}

/** Text size follows the stroke width, so a "bold" label is also a bigger one. */
function textSizeFor(width) {
  // Mapped from the slider's range rather than three fixed steps, so the label
  // grows continuously as the slider moves.
  if (width >= 9) return 30;
  if (width >= 6) return 25;
  if (width >= 4) return 21;
  return 17;
}

/**
 * Copy the selection to the clipboard and close without producing a file.
 *
 * The point of the button is "I want this image elsewhere", so the capture must not
 * also be inserted into the composer — the two would race and the user would end up
 * with the picture in both places after asking for one. Exit code 4 tells the host
 * that this happened: nothing to insert, nothing to report as a failure.
 */
function copyAndExit() {
  if (state.done) return;
  const selection = state.sel ?? { x: 0, y: 0, w: screenWidth, h: screenHeight };
  const copied = copySelectionToClipboard(selection);
  if (!copied) {
    logFocus('copy to clipboard FAILED');
    process.stderr.write('could not copy the image to the clipboard\n');
    state.done = true;
    exitWith(3);
    return;
  }
  logFocus(`copy to clipboard ok selection=${Math.round(selection.w)}x${Math.round(selection.h)}`);
  // Confirm the copy before closing so the user knows it worked and where it went.
  showFeedback('✓ 已复制到剪贴板', 4);
}

function confirm() {
  if (state.done) return;
  /*
   * A shortcut capture confirms into the clipboard, not a file: the overlay was started
   * from another app, so there is no composer request waiting on a PNG file. `copyAndExit`
   * writes CF_DIB and exits with code 4, which the host already understands.
   */
  if (toClipboard) {
    copyAndExit();
    return;
  }
  const selection = state.sel ?? { x: 0, y: 0, w: screenWidth, h: screenHeight };
  const png = buildResult(selection);
  if (png === null) {
    process.stderr.write('could not build the image\n');
    state.done = true;
    exitWith(3);
    return;
  }
  try {
    const { writeFileSync } = require('node:fs');
    writeFileSync(outputPath, png);
    logFocus(`confirm wrote ${png.length} bytes to ${outputPath}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logFocus(`confirm write FAILED: ${message}`);
    process.stderr.write(`could not write ${outputPath}: ${message}\n`);
    state.done = true;
    exitWith(3);
    return;
  }
  // Tell the user it went into the draft, then close.
  showFeedback('✓ 已加入草稿', 0);
}

function cancel() {
  if (state.done) return;
  state.done = true;
  state.cancelled = true;
  exitWith(2);
}

/**
 * Give the foreground back to `foregroundBefore`.
 *
 * `SetForegroundWindow` alone is refused whenever Windows does not consider this process
 * entitled to change the foreground — which is exactly the shortcut case: the overlay is a
 * topmost window with no owner, spawned by the Harness process, and the previous owner can
 * lose out to the Harness window. The documented workaround is to attach this thread's
 * input queue to the target window's thread and retry while attached.
 *
 * @returns {boolean} whether the target is now the foreground window
 */
function restoreForeground() {
  const target = foregroundBefore;
  if (target === null || target === undefined || target === windowHandle) return false;
  try {
    if (!api.IsWindow(target)) return false;
    if (api.SetForegroundWindow(target)) return true;

    const targetThread = api.GetWindowThreadProcessId(target, [0]);
    const ourThread = api.GetCurrentThreadId();
    if (targetThread === 0 || targetThread === ourThread) return false;
    if (!api.AttachThreadInput(ourThread, targetThread, true)) return false;
    try {
      api.BringWindowToTop(target);
      return api.SetForegroundWindow(target) === true;
    } finally {
      api.AttachThreadInput(ourThread, targetThread, false);
    }
  } catch {
    return false;
  }
}

/** Tear the window down and leave with a status. */
function exitWith(code) {
  /*
   * Destroy first, then restore focus.
   *
   * Destroying the topmost overlay is itself what hands the foreground back to the Harness
   * window (its parent process). Restoring focus *before* the destroy therefore had no
   * effect: the destroy immediately undid it, which is why the Harness window kept coming
   * back over the app the user had been in. So tear the overlay down, let that settle, and
   * only then force the remembered window forward.
   */
  try {
    if (windowHandle !== null) api.DestroyWindow(windowHandle);
  } catch {
    /* already gone */
  }
  api.Sleep(30);

  const wanted = foregroundBefore;
  const current = api.GetForegroundWindow();
  let restored = current === wanted;
  if (!restored && wanted !== null && wanted !== undefined && wanted !== windowHandle && api.IsWindow(wanted)) {
    restored = restoreForeground();
  }
  logFocus(`exit restore=${restored} want=${wanted} [${describeWindow(wanted)}] now=${api.GetForegroundWindow()} [${describeWindow(api.GetForegroundWindow())}]`);

  try {
    koffi.unregister(wndProc);
  } catch {
    /* already released */
  }
  process.exit(code);
}

// -------------------------------------------------------------- start up

const wndClassBuffer = Buffer.alloc(80);
// WNDCLASSW on x64: style(4+pad4) lpfnWndProc(8) cbClsExtra(4) cbWndExtra(4)
// hInstance(8) hIcon(8) hCursor(8) hbrBackground(8) lpszMenuName(8) lpszClassName(8)
/*
 * CS_DBLCLKS is what makes Windows send `WM_LBUTTONDBLCLK` at all.
 *
 * With a class style of 0 a second click arrives as an ordinary `WM_LBUTTONDOWN`, so
 * double-clicking a text annotation could never do anything — the message was
 * declared but unreachable. Editing existing text is built on it.
 */
const CS_DBLCLKS = 0x0008;
wndClassBuffer.writeUInt32LE(CS_DBLCLKS, 0);
wndClassBuffer.writeBigUInt64LE(koffi.address(wndProc), 8);
wndClassBuffer.writeInt32LE(0, 16);
wndClassBuffer.writeInt32LE(0, 20);
wndClassBuffer.writeBigUInt64LE(BigInt(`0x${api.GetModuleHandleW(null).toString(16)}`), 24);
wndClassBuffer.writeBigUInt64LE(0n, 32);
wndClassBuffer.writeBigUInt64LE(0n, 40);
wndClassBuffer.writeBigUInt64LE(0n, 48);
wndClassBuffer.writeBigUInt64LE(0n, 56);
wndClassBuffer.writeBigUInt64LE(koffi.address(classBuffer), 64);

const atom = api.RegisterClassW(wndClassBuffer);
if (atom === 0) {
  process.stderr.write('RegisterClassW failed\n');
  process.exit(3);
}

const titleBuffer = toW('dsh-screenshot');
windowHandle = api.CreateWindowExW(
  WS_EX_TOPMOST,
  koffi.address(classBuffer),
  koffi.address(titleBuffer),
  WS_POPUP | WS_VISIBLE,
  0, 0, screenWidth, screenHeight,
  null, null, api.GetModuleHandleW(null), null,
);
if (windowHandle === null) {
  process.stderr.write('CreateWindowExW failed\n');
  process.exit(3);
}

api.ShowWindow(windowHandle, 5 /* SW_SHOW */);
api.UpdateWindow(windowHandle);

// `--preview` draws the real surface into an offscreen bitmap and stops: a way to
// see the toolbar without photographing another process's window.
if (previewPath !== null) {
  const { writeFileSync } = require('node:fs');
  if (previewSelection !== null) state.sel = previewSelection;
  // `--preview-undo` shows the enabled ink rather than the disabled one, which is
  // otherwise the only undo state an empty history can render.
  if (process.argv.includes('--preview-undo')) state.undoStack.push([]);
  // `--preview-hover <kind>` parks the pointer on an entry, which is the only way to
  // photograph the hover/tooltip state: it otherwise needs a real mouse over a real
  // window. Pass `undo` with an empty history to prove a disabled button stays quiet.
  const hoverArg = process.argv.indexOf('--preview-hover');
  if (hoverArg !== -1) {
    const kind = String(process.argv[hoverArg + 1] ?? '');
    state.hoverItem = TOOLS.includes(kind)
      ? { kind: 'tool', value: kind }
      : { kind, value: undefined };
  }
  /*
   * `--preview-annots <json>` injects annotations straight into the state.
   *
   * Driving a real mouse cannot reproduce degenerate shapes: a horizontal guide
   * line needs y1 === y2 exactly, and a synthetic drag that lands one pixel off
   * hides the very bug being investigated. Injecting the annotation removes the
   * pointer from the equation.
   *
   * The JSON is an array of annotation objects in the same shape the tools build.
   */
  const annotsArg = process.argv.indexOf('--preview-annots');
  if (annotsArg !== -1) {
    const text = String(process.argv[annotsArg + 1] ?? '');
    try {
      state.annots = JSON.parse(text);
    } catch (error) {
      process.stderr.write(`bad --preview-annots JSON: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    const pickArg = process.argv.indexOf('--preview-pick');
    if (pickArg !== -1) state.selectedAnnotation = Number(process.argv[pickArg + 1] ?? -1);
  }
  /*
   * `--preview-text <x,y,value>` shows the in-progress text, with its caret.
   *
   * The caret is only drawn while text is pending, which cannot be photographed by
   * committing an annotation — so this puts the pending state directly in place.
   * The visibility test is time-based, so 265-second-multiples decide whether the
   * caret is caught on or off; the test accounts for both.
   */
  const textArg = process.argv.indexOf('--preview-text');
  if (textArg !== -1) {
    const parts = String(process.argv[textArg + 1] ?? '').split(',');
    const value = parts.slice(2).join(',');
    state.text = {
      x: Number(parts[0] ?? 0),
      y: Number(parts[1] ?? 0),
      value,
      color: PEN_COLORS[state.colorIndex],
      anchor: value.length,
      cursor: value.length,
    };
    /*
     * `--preview-select <from>,<to>` highlights a range, so the selection feedback
     * can be photographed. Without it every capture shows a bare caret, and the
     * "select-all shows nothing" problem would be invisible to a test.
     */
    const selectArg = process.argv.indexOf('--preview-select');
    if (selectArg !== -1) {
      const range = String(process.argv[selectArg + 1] ?? '').split(',');
      state.text.anchor = Number(range[0] ?? 0);
      state.text.cursor = Number(range[1] ?? value.length);
    }
    // Tests cannot rely on catching the lit half of a 50% duty cycle.
    if (process.argv.includes('--preview-caret')) caretAlwaysVisible = true;
  }
  // CreateCompatibleBitmap must be compatible with a *screen* DC. Passing a
  // memory DC's NULL handle yields a 1-bit monochrome bitmap, which renders every
  // colour as a black-and-white dither and looks like a broken toolbar.
  const screenDc = api.GetDC(null);
  const memory = api.CreateCompatibleDC(screenDc);
  const bitmap = api.CreateCompatibleBitmap(screenDc, screenWidth, screenHeight);
  const previous = api.SelectObject(memory, bitmap);
  try {
    paint(memory);
    const header = Buffer.alloc(40);
    header.writeUInt32LE(40, 0);
    header.writeInt32LE(screenWidth, 4);
    header.writeInt32LE(screenHeight, 8);
    header.writeUInt16LE(1, 12);
    header.writeUInt16LE(32, 14);
    header.writeUInt32LE(BI_RGB, 16);
    const bottomUp = Buffer.alloc(screenWidth * 4 * screenHeight);
    // Read through a **fresh** bitmap instead of the one that was selected when
    // `paint` ran. `paint` legitimately selects and restores temporary pens,
    // brushes and fonts; reading back through the original handle after that is
    // what produced a solid black preview of an otherwise correct paint.
    const readMem = api.CreateCompatibleDC(screenDc);
    const readBmp = api.CreateCompatibleBitmap(screenDc, screenWidth, screenHeight);
    const readPrev = api.SelectObject(readMem, readBmp);
    try {
      api.BitBlt(readMem, 0, 0, screenWidth, screenHeight, memory, 0, 0, SRCCOPY);
      if (api.GetDIBits(readMem, readBmp, 0, screenHeight, bottomUp, header, DIB_RGB_COLORS) !== screenHeight) {
        process.stderr.write('preview readback failed\n');
        process.exit(3);
      }
    } finally {
      api.SelectObject(readMem, readPrev);
      api.DeleteObject(readBmp);
      api.DeleteDC(readMem);
    }
    // Flip to top-down, matching the convention `encodePng` expects.
    const stride4 = screenWidth * 4;
    const topDown = Buffer.alloc(bottomUp.length);
    for (let row = 0; row < screenHeight; row += 1) {
      bottomUp.copy(topDown, row * stride4, (screenHeight - 1 - row) * stride4, (screenHeight - row) * stride4);
    }
    writeFileSync(previewPath, encodePng(screenWidth, screenHeight, topDown));
  } finally {
    api.SelectObject(memory, previous);
    api.DeleteObject(bitmap);
    api.DeleteDC(memory);
    api.ReleaseDC(null, screenDc);
  }
  exitWith(0);
}

// Pump until the user decides. This is why the overlay is a separate process:
// this loop blocks, and blocking DSH's thread would freeze the whole app.
//
// A pending success toast keeps the loop alive past `state.done`: the toast is shown by
// the window timer, and *that* timer is what exits with the real code (0 for a file, 4 for
// a clipboard copy). Stopping as soon as `state.done` was set skipped the toast entirely
// and exited 0 — which, on the copy path, meant "exited with no image" to the host.
const message = Buffer.alloc(64);
while (!state.done || (feedbackText !== null && Date.now() < feedbackDeadline)) {
  let handled = false;
  while (api.PeekMessageW(message, null, 0, 0, PM_REMOVE)) {
    api.TranslateMessage(message);
    api.DispatchMessageW(message);
    handled = true;
  }
  if (!handled) api.Sleep(8);
}

exitWith(feedbackText !== null ? feedbackExitCode : (state.cancelled ? 2 : 0));
