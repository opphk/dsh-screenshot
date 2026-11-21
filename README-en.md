<p align="center">
  <img src="icon.svg" width="96" height="96" alt="dsh-screenshot">
</p>

<h1 align="center">dsh-screenshot</h1>

<h3 align="center"><a href="README.md">简体中文</a> &nbsp;·&nbsp; English</h3>

<p align="center"><b>A capture entry for DeepSeek Harness</b><br>Select a region, annotate the important parts, and the image drops into the composer draft; it brings its own capture and does not need the system screenshot tool.<br>Windows only.</p>

## Why this plugin

Slim builds of Windows (N editions, LTSC and similar) remove the built-in screenshot tool, which leaves no way to capture the screen.

So this plugin brings its own capture: press the shortcut or click the camera, a native full-screen window opens, drag the region you want to explain, draw a few marks, and Enter turns it into a draft attachment — capture → annotate → draft in one step.

The annotation surface is a **separate native window**, not a page overlay, so there is no title bar, no taskbar on top, and your window is never resized. Capture uses DSH's own FFI (koffi → GDI) rather than launching PowerShell.

## Features

- **One shortcut or button**: global `Ctrl+Alt+Q`, or the camera at the left of the composer.
- **Region select + six tools**: rectangle, ellipse, arrow, pen, text, mosaic.
- **Straight into the draft**: `Enter` inserts the selection as an attachment (not sent); a copy button puts it on the clipboard.
- **Out of its own shot**: the button can minimize the Harness window first ("hide this window").
- **Native window + bundled FFI**: capture in ~60–110 ms, no extra dependencies.

## Install

Settings → Plugins → Add plugin, pick this folder, refresh the page.

## Usage

| Action | Result |
|---|---|
| Camera button / `Ctrl+Alt+Q` | Capture (shortcut is global and fixed) |
| Drag | Select a region |
| Rectangle / ellipse / arrow / pen / text / mosaic | Annotate |
| `Enter` / ✓ | Insert into composer (not sent) |
| Copy button | Copy to clipboard, not inserted |
| `Esc` / right-click / ✕ | Cancel |
| `Ctrl+Z` | Undo |
| "Hide this window" menu | Button only: minimize the Harness window before capturing. The shortcut captures the screen as-is |

## Limitations

- Windows only.
- Shortcut is fixed at `Ctrl+Alt+Q` with no settings entry; a free fallback is chosen if taken.
- The image goes into the draft only — it is not saved to the workspace. The shortcut captures the screen as-is and never hides a window ("hide this window" applies to the camera button only).

## License

MIT — see [LICENSE](LICENSE).

## Disclaimer

**This project was generated entirely by AI, with no human involvement.**
