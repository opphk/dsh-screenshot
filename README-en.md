<p align="center">
  <img src="icon.svg" width="96" height="96" alt="dsh-screenshot">
</p>

<h1 align="center">dsh-screenshot</h1>

<h3 align="center"><a href="README.md">简体中文</a> &nbsp;·&nbsp; English</h3>

<p align="center"><b>A capture entry for DeepSeek Harness</b><br>Select a region, annotate the important parts, and the image drops into the composer draft.</p>

## For AI agents

**If you are an AI installing, configuring or fixing this project, read these two files first:**

- [AI-INSTALL.md](AI-INSTALL.md) — install and wiring, hot-reload vs restart, and how to verify.
- [AI-TROUBLESHOOTING.md](AI-TROUBLESHOOTING.md) — symptom-driven self-checks and fixes (shortcut, capture window, focus, log locations).

Quick facts: Windows-only DSH bundle; plugin id `dsh-screenshot`; host half `index.js`; capture overlay `lib/overlay.js` (reloaded on every capture); global shortcut `lib/hotkey.js`.

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
| Shortcut capture | Captures the screen as-is; after `Enter` the image goes to the **clipboard** (paste with `Ctrl+V`) |
| `Esc` / right-click / ✕ | Cancel |
| `Ctrl+Z` | Undo |
| "Hide this window" menu | Button only: minimize the Harness window before capturing. The shortcut captures the screen as-is |

## Limitations

- Windows only.
- Shortcut is fixed at `Ctrl+Alt+Q` with no settings entry; a free fallback is chosen if taken.
- The image goes into the draft only — it is not saved to the workspace. The shortcut captures the screen as-is and never hides a window ("hide this window" applies to the camera button only); after `Enter` the shortcut result goes to the clipboard.

## License

MIT — see [LICENSE](LICENSE).

## Disclaimer

**This project was generated entirely by AI.**

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
