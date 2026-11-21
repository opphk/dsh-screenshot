# 给 AI 的安装教程 / AI install guide

本文件面向 **AI / 自动化代理**：如何把 `dsh-screenshot` 装进 DeepSeek Harness（DSH），以及改完代码后怎么让它生效、怎么验证。

> 面向人类的简明说明见 [README.md](../README.md)。

## 1. 前置条件

- **仅 Windows**（依赖 Win32 / GDI）。非 Windows 上 `/snap` 返回 `501`。
- DSH 桌面版，且插件系统可用（本插件是标准 DSH bundle）。

## 2. 目录结构（先认清每一半）

```
package.json        dsh.bundle.patch + dsh.client 声明；files 白名单
cordis.patch.yml    往 profile 插入 id=dsh-screenshot 的一行
index.js            Host 半：/snap、/config 两条路由；启动截图覆盖层子进程；全局快捷键管理
client.js           浏览器半：输入框相机按钮、下拉菜单、把图片塞进输入框
lib/overlay.js      截图/标注覆盖层（Win32 窗口，独立子进程）
lib/hotkey.js       全局快捷键 helper（独立子进程，RegisterHotKey + 消息泵）
locale/{zh,en}.json 插件卡片/市场描述（meta.title / meta.description）
icon.svg            插件图标
tests/              精简测试套件（见第 6 节）
```

## 3. 安装

任选其一：

- 插件管理器安装本地目录：
  ```
  plugin_manager action=install_bundle target="<本目录绝对路径>"
  ```
- 或从 GitHub 安装：
  ```
  plugin_manager action=install_bundle target="github:opphk/dsh-screenshot"
  ```
- 或 GUI：**设置 → 插件 → 添加插件**，选本目录，然后**刷新页面一次**。

安装后确认**已启用**（`enabled: true`）。插件 id / 依赖名是 `dsh-screenshot`。

> 不要手改 profile 的 `cordis.patch.yml`。启停、卸载一律用 `plugin_manager`（`set_bundle` / `remove_bundle`）。

### 3.1 安装后固定两步（务必照做）

1. **做一次热重载**：`set_bundle enabled=false`，再 `set_bundle enabled=true`。这会让 Host 重新执行 `apply()`，新的路由与快捷键 helper 才真正起来（比整机重启省事）。
2. **询问用户是否要跑「最小规模测试」**：**不要自作主张跑**。先用一句话问用户，例如
   > “已装好并热重载。要不要跑一个最小测试（安全档 `node tests/run.mjs`，不弹窗、不动鼠标）确认一下？”
   
   得到同意再跑（见第 6 节）；用户说不用就跳过。

## 4. 改完代码怎么生效（关键）

| 你改的文件 | 怎么生效 |
|---|---|
| `lib/overlay.js` | **不用管**：每次截图都会重新 `spawn` 这个脚本，下一次截图即生效。 |
| `client.js`（浏览器半） | **刷新页面**（从磁盘重新读取）。 |
| `index.js`（Host 半） | Host 代码在启动时只导入一次。用 `plugin_manager` 把插件**关→开**（`set_bundle enabled=false` 再 `enabled=true`），会**重新执行 `apply()`**，加载新代码（已实测有效，比整机重启省事）。 |
| `lib/hotkey.js` | 由 `apply()` 拉起；同上关→开一次即可让新 helper 生效。 |
| `locale/*.json` | 关→开一次，插件卡片/详情描述会更新。 |

如果关→开仍不生效，再考虑**完全退出并重开 DSH**。

## 5. 装完怎么验证

1. **路由已注册**：对 DSH 当前 Web 端口请求
   - `GET /plugins/dsh-screenshot/snap`
   - `GET /plugins/dsh-screenshot/config`
   
   返回 **401** = 已注册（这是连接信任闸，不是错误）；**404** = 没注册。端口见 `DSH_WEB_URL`。
2. **插件已启用**：`plugin_manager` 列表里 `dsh-screenshot` 为 `enabled: true`、`fiberPhase: active`。
3. **快捷键 helper 在跑**：按命令行找进程（⚠️ 它由 Host 用 `process.execPath` 拉起，进程名是 `DeepSeek Harness.exe`，**不是 node.exe**）：
   ```
   Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'hotkey\.js' }
   ```
   命令行里能看到 `...\lib\hotkey.js ctrl+alt+q`。

## 6. 跑测试

```
node tests/run.mjs        # 安全档：不弹窗、不动鼠标（清单/几何/FFI/文字编辑）
node tests/run.mjs --ui   # 追加端到端截图测试（会移动真实光标、弹全屏窗口）
```

桌面档套件在没有 `DSH_SCREENSHOT_UI_TESTS=1` 时会自动跳过并返回 0。

## 7. 不要踩的坑

- **别写死盘符**。koffi 的定位顺序是 `DSH_INSTALL_DIR` → `process.execPath` 推导的安装目录（`resources/app.asar.unpacked/...`）→ 相对 `node_modules`。写死 `H:\...` 在别人机器上必挂。
- **别把「隐藏窗口」实现成把窗口移到屏幕右侧**：多显示器下会落到第二块屏，等于没移开。用**最小化 + `IsIconic` 确认**。
- **快捷键路径不要做「是否前台」的判断**：那会把 Harness 窗口抢到前面。快捷键 = 直接截当前屏幕；只有相机按钮才需要隐藏窗口。
- **权限门槛**：所有 HTTP 路由先过 `connection.requestRejection`，只放行同源请求。

出问题时看 [AI-TROUBLESHOOTING.md](AI-TROUBLESHOOTING.md)。
