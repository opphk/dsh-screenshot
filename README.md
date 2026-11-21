<p align="center">
  <img src="icon.svg" width="96" height="96" alt="dsh-screenshot">
</p>

<h1 align="center">dsh-screenshot · 截图标注</h1>

<h3 align="center">简体中文 &nbsp;·&nbsp; <a href="README-en.md">English</a></h3>

<p align="center"><b>给 DeepSeek Harness 加一个截图入口</b><br>框选区域、标注重点，图片直接进输入框草稿。</p>

## 给 AI 的入口

**如果你是一个 AI，要安装、配置或修复这个项目，先读下面两个文件：**

- [AI-INSTALL.md](AI-INSTALL.md) —— 安装与接线、热重载与重启的区别、装完怎么验证。
- [AI-TROUBLESHOOTING.md](AI-TROUBLESHOOTING.md) —— 常见故障的自查与修复步骤（快捷键、截图窗口、焦点、日志位置）。

速查：Windows-only 的 DSH bundle；插件 id `dsh-screenshot`；宿主 `index.js`；截图覆盖层 `lib/overlay.js`（每次截图重新加载）；全局快捷键 `lib/hotkey.js`。

## 特性

- **一个快捷键或按钮**：全局 `Ctrl+Alt+Q`，或输入框左侧的相机。
- **框选 + 六种标注**：矩形、椭圆、箭头、画笔、文字、马赛克。
- **直接进草稿**：`Enter` 把选区作为附件放进输入框（不自动发送）；另可复制到剪贴板。
- **拍不到自己**：点相机时可先把 Harness 窗口最小化再截（「隐藏当前窗口」）。
- **原生窗口 + DSH 自带 FFI**：抓屏约 60–110ms，无需额外依赖。

## 安装

设置 → 插件 → 添加插件，选本目录，刷新页面。

## 使用

| 操作 | 效果 |
|---|---|
| 相机按钮 / `Ctrl+Alt+Q` | 截图（快捷键全局生效，固定组合） |
| 拖动 | 框选 |
| 矩形/椭圆/箭头/画笔/文字/马赛克 | 标注 |
| `Enter` / ✓ | 图片进输入框（不自动发送） |
| 复制按钮 | 进剪贴板，不进输入框 |
| 快捷键截图 | 直接截当前屏幕；按 `Enter` 后图片进**剪贴板**（回输入框 `Ctrl+V` 粘贴） |
| `Esc` / 右键 / ✕ | 取消 |
| `Ctrl+Z` | 撤销 |
| 「隐藏当前窗口」菜单 | 仅影响按钮：是否把 Harness 窗口最小化后再截；快捷键直接截当前屏幕 |

## 限制

- 仅 Windows。
- 快捷键固定 `Ctrl+Alt+Q`，无设置入口；被占用时自动换一个可用组合。
- 截图只进草稿，不落盘到工作区；快捷键直接截当前屏幕、不隐藏窗口（隐藏只对相机按钮生效），确认后图片进剪贴板。

## License

MIT，见 [LICENSE](LICENSE)。

## 声明

**本项目完全由 AI 生成。**

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
