<p align="center">
  <img src="icon.svg" width="96" height="96" alt="dsh-screenshot">
</p>

<h1 align="center">dsh-screenshot</h1>

<h3 align="center"><a href="README.md">简体中文</a> &nbsp;·&nbsp; English</h3>

<p align="center"><b>Native annotated-screenshot plugin for DeepSeek Harness</b><br>Open a full-screen window, select a region, annotate it, press Enter to insert it into the composer.<br>Windows only.</p>

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
| "Hide this window" menu | Affects the button only: minimize the Harness window before capturing. The shortcut captures the screen as-is |

## Limitations

- Windows only.
- Shortcut is fixed at `Ctrl+Alt+Q` with no settings entry; a free fallback is chosen if taken.
- The shortcut captures the screen as-is and never hides a window; "hide this window" applies to the camera button only (minimize, then capture).
- "Hide this window" moves the window off-screen and back.

## License

MIT, see [LICENSE](LICENSE).

## Disclaimer

**This project was generated entirely by AI, with no human involvement.**

