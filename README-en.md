# dsh-screenshot

Native annotated-screenshot plugin for DeepSeek Harness: open a full-screen window, select a region, annotate it, press Enter to insert the selection into the composer.

**Windows only.**

[中文](README.md)

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
| "Hide this window" menu | Whether the Harness window is included (shared by button and shortcut) |

## Limitations

- Windows only.
- Shortcut is fixed at `Ctrl+Alt+Q` with no settings entry; a free fallback is chosen if taken.
- "Hide this window" moves the window off-screen and back.

## License

MIT, see [LICENSE](LICENSE).

## Disclaimer

**This project was generated entirely by AI, with no human involvement.**
