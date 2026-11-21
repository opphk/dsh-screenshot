# 给 AI 的排查 / 自修参考

本文件面向 **AI / 自动化代理**：当 `dsh-screenshot` 表现异常时，按“症状 → 自查 → 修复”处理。改动后如何生效见 [AI-INSTALL.md](AI-INSTALL.md)。

## 0. 先收集证据（不要瞎改）

```powershell
# 焦点决策日志：记录每次截图“拍照瞬间前台是谁、要移到哪个窗口、恢复结果”
Get-Content "$env:TEMP\dsh-screenshot-focus.log" -Tail 40

# 快捷键 helper 是否在跑（注意：进程名是 DeepSeek Harness.exe，不是 node.exe）
Get-CimInstance Win32_Process | ? { $_.CommandLine -match 'hotkey\.js' } |
  Select-Object ProcessId, CommandLine

# Host 启动日志（包含 “[dsh-screenshot] global shortcut ready: <组合>” 之类）
```

- **401 vs 404**：`GET /plugins/dsh-screenshot/snap`（以及 `/config`）返回 **401 = 已注册**（连接信任闸），**404 = 没注册**。端口取 `DSH_WEB_URL`。

## 1. 快捷键按了没反应 / 不截图

**自查**
1. helper 在不在跑（上一节命令）？不在 → 见第 6 节“改动没生效”。
2. 组合是否被别的程序占用：helper 报 `ready <别的组合>` 说明它**自动换了备选**，原组合可能被占。看 Host 日志里的 `global shortcut ready: ...`。
3. 焦点日志里有没有 `press` 之后的 `open ...`？没有说明 Host 没收到按键。

**修复**
- 换一个空闲组合（改 `index.js` 里 `DEFAULT_HOTKEY` 或 helper 的备选列表），或关掉占用 `Ctrl+Alt+Q` 的程序。
- 改完 `index.js`/`lib/hotkey.js` 后**关→开插件**让 `apply()` 重跑。

## 2. 快捷键截图后，焦点跳回 Harness 窗口

**历史上两次都栽在这里，务必按现行设计判断：**

- ❌ 旧做法：截图前“判断 Harness 是否前台”，是就移动窗口 —— 判断错/移动最大化窗口会把它抢到前台。
- ❌ 旧做法：`SetForegroundWindow` 在**销毁覆盖层之前**还原焦点 —— 销毁覆盖层本身会把前台交回 Harness，先还原等于白做。
- ✅ 现行：**快捷键不碰任何窗口**（直接抓屏）；退出时**先销毁覆盖层，再用 `AttachThreadInput` 强制**把焦点还给拍照前的窗口。

**自查**
1. 焦点日志：`open ... fg=<你当时用的程序>` —— 若 `fg` 显示的是 Harness，说明拍照瞬间前台判定就错了（见“坑 A”）。
2. `exit restore=... now=...` —— `restore=false` 且 `now` 是 Harness，说明焦点没还回去。

**修复**
- 确认 `lib/overlay.js` 是最新版（它每次截图重载，改完即生效）。
- 坑 A：覆盖层进程启动有延时，前台窗口可能被抢占。现行代码在 koffi 加载**第一时间**就抓 `GetForegroundWindow()`；若仍错，把抓取点再提前（`lib/overlay.js` 顶部，`user32` 加载后立刻取）。

## 3. 截图里出现了 Harness 窗口（相机按钮路径）

**自查**
- 「隐藏当前窗口」是否为**勾选**（勾选 = 截前最小化 Harness）。未勾选就是会包含它，这是设计。
- 焦点日志里 `matches=false` 说明当时目标窗口不是前台、**没有**执行最小化。

**修复**
- 勾选「隐藏当前窗口」。
- 若勾了仍出现：确认最小化实现是 `ShowWindow(SW_MINIMIZE)` + `IsIconic` 确认（**不要**用 `SetWindowPos` 移到 `primaryWidth+80` —— 多显示器会落到第二块屏）。

## 4. 多显示器 / 窗口没被移开 / 位置跳变

- 症状根因几乎都是**把窗口移到屏幕右侧**的旧实现。现行实现已改为**最小化**，不依赖主屏宽度。
- 自查：`lib/overlay.js` 的 `stepAsideOwnWindow` 是否用了 `SW_MINIMIZE` 且校验 `IsIconic`；恢复用 `SW_RESTORE`。

## 5. `/snap` 返回 501 或 404

- **501**：当前不是 Windows（`process.platform !== 'win32'`），或找不到 `lib/overlay.js`。本插件仅 Windows。
- **404**：路由没注册。检查插件是否 `enabled: true`；`index.js` 是否抛错（看 Host 日志）；必要时关→开插件。

## 6. 改了代码但没生效

| 改了 | 处理 |
|---|---|
| `lib/overlay.js` | 无需处理，下次截图重载。 |
| `client.js` | 刷新页面。 |
| `index.js` / `lib/hotkey.js` | 关→开插件（`set_bundle false→true`）让 `apply()` 重跑。 |
| 仍不行 | 完全退出并重开 DSH。 |

## 7. 粘贴进输入框失败

- 实现走的是构造标准 `ClipboardEvent` 派发，和手动 `Ctrl+V` 同路径。若 Harness 换了编辑器实现导致失效，检查 `client.js` 里构造 paste 事件那段。
- 复制到剪贴板用的是 `CF_DIB`（`GlobalAlloc` 分配，`SetClipboardData` 成功后归系统所有，**不要**再 `GlobalFree`）。

## 8. 兜底

如果以上都不解决，把这几样一起带走再分析：
1. `%TEMP%\dsh-screenshot-focus.log` 最近 40 行；
2. `/plugins/dsh-screenshot/snap` 与 `/config` 的状态码；
3. `plugin_manager` 里 `dsh-screenshot` 的 enabled / fiberPhase；
4. helper 进程命令行（确认跑的是哪个组合、哪个路径）。
