# Rust / Tauri 迁移

DeskMate 0.6.0 使用 Tauri 2、Rust 和 Windows WebView2。保留 HTML/CSS/JavaScript 界面及动画，不在运行时启动 Node.js 或捆绑 Electron。

## 模块

| 原模块 | Rust 实现 |
| --- | --- |
| `src/main.cjs` / preload | `src-tauri/src/desktop.rs` / `src/renderer/tauri-bridge.js` |
| Store / SQLite | `src-tauri/src/store.rs`、`schema.sql` |
| 便签和提醒 | `src-tauri/src/agenda.rs` |
| Git 索引与发现 | `src-tauri/src/git.rs` |
| Codex / Claude 用量 | `src-tauri/src/usage.rs` |
| 更新日志 | `src-tauri/src/updates.rs` |
| 动画导入与目录 | `src-tauri/src/skins.rs` |
| 子进程与超时 | `src-tauri/src/process.rs` |

界面仍调用 `window.assistant.call/on`。Tauri 适配层转换命令、事件与本地图片 URL；Rust 校验窗口身份、设置、允许打开的链接和动画包路径。前端没有任意文件或 shell 权限。图片协议仅允许内置素材目录和用户导入素材目录。

## 数据兼容

直接使用数据库迁移阶段的 `assistant.sqlite`，`user_version=1` 和表结构保持兼容，不创建第二套数据库。数据目录继续识别 DeskMate、旧品牌目录、`DESKMATE_DATA_DIR` 和 `LONGLING_DATA_DIR`。旧 JSON 的一次性事务导入、备份恢复与损坏副本保留也由 Rust 实现。

切换程序前通过托盘退出旧版。Rust 版使用单实例插件及数据目录文件锁；历史 Electron 安装包不认识新文件锁，因此不要同时打开新旧两个运行时。未知业务字段会保存在 `extra`，设置和嵌套素材元数据使用 JSON 值；业务记录和提交仍是独立数据库行。

正式版启动时，若用户原本已开启开机启动，会将同名 `DeskMate` 注册项更新为当前 EXE；关闭设置则移除该项，避免留下新旧两个启动项。开发版不修改开机启动设置。

## 桌宠与后台

桌宠和管理面板是两个 WebView2 窗口。关闭面板只隐藏窗口，托盘退出才结束后台。Rust 定时任务执行提醒、用量刷新、Git 索引和更新检查。

Windows 全局光标检测使点击穿透后的窗口仍能恢复交互。长按由现有界面判断，Rust 根据屏幕物理坐标拖动，按所在显示器工作区域和缩放约束宠物边界。位置同时保存兼容的逻辑坐标和新的物理坐标。子进程有超时、输出限制和 Windows Job Object 生命周期管理，退出时清理 CLI 及其后代进程。

## 构建

需要 Windows x64、Node.js 22.13+、Rust stable（锁定依赖最低 1.90）、Microsoft C++ Build Tools 和 Windows SDK、WebView2。最终用户运行打包版不需要 Node.js 或 Rust。

```powershell
npm.cmd ci
npm.cmd start       # Tauri 开发运行
npm.cmd test        # Rust 功能测试，包括 SQLite 双向兼容和 CLI 协议
npm.cmd run check   # clippy
npm.cmd run test:ui # 对已构建的 debug exe 执行 WebView2 UI 回归
npm.cmd run package # 免安装目录，包含素材
npm.cmd run dist    # NSIS 安装包
```

`scripts/rust.cjs` 优先使用项目 `.cache/cargo`、`.cache/rustup` 和 `.cache/buildtools` 中已经准备的隔离工具链；其他开发者也可直接使用系统 Rust / Visual Studio 安装。构建前将现有界面复制到 `.cache/tauri-web`，只在该副本注入 Tauri bridge 和 CSP。原 Electron HTML 保持可用于历史回归。

免安装产物为 `release/DeskMate-0.6.0-rust-win32-x64/DeskMate.exe`，整个目录一起保留；WebView2 需已安装。目录存在时不会覆盖，可通过 `DESKMATE_BUILD_NAME` 指定新名字。NSIS 产物位于 `src-tauri/target/release/bundle/nsis/`，包含 WebView2 安装引导。原始 Cargo 输出 EXE 不含旁边所需的动画资源，请使用打包目录或安装版。

`src/core/*.cjs`、`src/main.cjs` 和旧 Electron 脚本保留作兼容回归。`npm.cmd run electron:test` 执行原功能测试，`electron:start` 仅用于开发对照；正常的 `start/package/dist` 全部走 Rust。

## Claude 状态行

可以直接调用 Rust 程序，不需要 Node.js：

```json
{
  "statusLine": {
    "type": "command",
    "command": "\"C:/实际安装目录/DeskMate.exe\" --claude-statusline"
  }
}
```

已有状态行时自行串联，不覆盖原设置。该命令只从标准输入接收 Claude 报告的额度，将数字与更新时间保存到 `claude-usage.json` 并输出可见状态行，不启动桌面窗口，也不发起额外网络请求。旧 Node 状态行脚本仍兼容同一文件格式。

## 验证方式

Rust 测试覆盖旧 JSON 导入、失败事务回滚、备份和未来版本保护、便签与提醒重启语义、SQL Git 查询、真实 Git 分支历史、用量字段语义与 Codex stdio 协议。兼容测试由原 Node 存储层创建 SQLite，Rust 修改后再交回原存储层验证。

新 UI 测试通过本地 WebView2 调试端口连接实际 Tauri 进程，使用隔离数据目录和仅测试构建启用的 Codex 协议替身。正式构建不包含协议替身。覆盖数据库自动导入、额度、三语、动画、便签、提醒、Git、形象绑定、桌宠额度条的键盘展开/收起和重启持久化；截图位于 `test-output/rust/`。系统鼠标检测会覆盖 CDP 模拟光标，因此实鼠标穿透和长按拖动需要单独验收。本次原生工具检查受到用户输入中断，尚未完成这两项手动验收；负坐标、多显示器边界和缩放的坐标计算有 Rust 测试覆盖。
