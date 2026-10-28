# 桌伴 · PC 助手

**中文** · [English](README.en.md) · [日本語](README.ja.md)

**0.6.0 技术栈：Tauri 2 + Rust + WebView2 + SQLite。** 保留原 HTML/CSS/JavaScript 界面。运行版不需要 Node.js；开发和迁移细节见 [Rust 迁移说明](docs/rust-migration.md)。

8 位可选的桌面小伙伴：查看 AI Agent 用量、收集 Git 提交、按日期写便签、到点提醒。桌面始终只有一个宠物；切换 Agent 时，数据和绑定形象同步切换。当前目标平台为 Windows x64。

## 运行

打包版：打开 `release/DeskMate-0.6.0-rust-win32-x64/DeskMate.exe`，整个目录需一起保留。如果旧版正在运行，请先从旧版托盘「退出桌伴」，再启动新版。沿用原数据目录，旧便签和提醒会自动迁移。

源码版需要 Node.js 22.13+、npm、Git、Rust stable（1.90+）、C++ Build Tools、Windows SDK 与 WebView2：

```powershell
npm.cmd ci
npm.cmd start
```

点击宠物打开面板；右键宠物或托盘图标切换 Agent。在宠物上按住鼠标左键约 350 毫秒后移动，即可拖拽；松开结束并保存位置，拖动后不会误打开界面。短按左键仍打开面板。关闭面板后同步和提醒仍运行，通过托盘菜单「退出桌伴」退出。

## 功能与范围

- **Agent 用量**：内置 Codex、Claude Code。Codex 通过官方本地 `app-server` 的 `account/rateLimits/read` 和 `account/usage/read` 读取 5 小时/7 天等额度窗口、重置时间、重置卡数量和到期详情，以及今日/累计 Token。沿用 Codex 登录状态，读取不启动模型任务。重置卡只展示，请到 Codex 兑换；详情可能被截断，数量以服务端 `availableCount` 为准。每日 Token 使用服务端日期，缺失当日或累计数据均显示 —，不假设为 0。Claude Code 从本地日志去重统计 Token（含缓存），可选接入官方状态行额度快照；两种 Token 统计范围不同，不能直接横向比较。每分钟刷新，只显示当前 Agent。桌宠优先显示 5 小时窗口，同时显示长期窗口；重置卡只在用量面板展示；悬停查看重置时间，多窗口可滚动。
- **Git 足迹**：添加仓库或扫描代码目录，后台每分钟索引全部本地分支、已拉取远程跟踪分支及 reflog 可达提交，保留历史存档。默认仅展示各仓库有效 `git config user.email` 匹配的作者；没有邮箱时回退 `user.name`，两者都没有则无匹配记录。可切换「所有作者」，不影响存档。支持仓库/日期筛选、内容/作者/邮箱/哈希搜索与分页。已移除手动同步按钮。不修改 Git 配置或 Hook，不自动 fetch/push。未加入、未拉取或从未收录且已回收的记录无法恢复。
- **便签与提醒**：整合为一个日历入口。一日多条便签，时间精确到时、分、秒，按需勾选「到点提醒我」，支持单次/每天/每周、编辑、暂停、启用、推迟 10 分钟、标记已读及关联删除。支持所选日期/全部便签/未读提醒筛选。活跃的重复或稍后提醒按下次到期日出现在日历上，保留原便签日期。仅编辑文字保留完成或暂停状态；改动日期、时间或重复规则会重新安排。语言切换保留草稿，切换页面时会确认是否丢弃。
- **提醒运行方式**：使用本机时区。关闭面板仍提醒；退出程序或关机时不唤醒机器，启动或恢复时补发一次并推进重复任务。系统通知、桌宠气泡与未读记录并存。支持秒级时间输入，但系统负载/睡眠可能延后送达，并非实时调度器。打包版可设置开机启动。旧日期便签补为 `00:00:00`；旧提醒变成关联便签，保留重复、暂停、完成和未读状态。
- **动画形象**：内置 8 个角色，默认白发龙娘，每个 Agent 可选择不同角色或绑定自定义动画包，支持 GIF/WebP/PNG/APNG，缺少状态回退待机。

接口来源：[Codex App Server](https://learn.chatgpt.com/docs/app-server)、[Claude Code 状态行](https://code.claude.com/docs/en/statusline)。

## 桌宠额度展示

在「形象与设置 → 桌宠额度展示」或桌宠右键菜单中选择：

- **持续显示**（默认）：180 像素宽的紧凑额度条，每个窗口显示剩余百分比和进度条，低额度使用暖色提示。
- **鼠标悬停显示**：移到桌宠上显示与持续模式完全相同的 180 像素额度条；可以继续移入额度条并点击查看用量，移开后自动收起。键盘聚焦也可展开，Esc 收起。

设置立即生效并在重启后保留。两种模式都优先显示 5 小时窗口，重置卡仍只在用量面板展示。浮层隐藏区域及窗口透明留白可穿透点击，不遮挡桌面操作。

## 三语与更新日志

右上角或设置中可切换中文、英语、日语，应用于面板、桌宠、托盘、日期格式和 README，重启后保留。首次按系统语言选择，其他语言回退中文。用户便签、提交记录与自定义素材名称不自动翻译。

每 6 小时检查官方 GitHub 的 **Codex CLI / Claude Code 稳定版**，与检测到的本机 CLI 版本比较。未能检测版本时明确显示未知；这是 CLI 版本提示，不是 Codex 桌面应用更新器，也不会自动安装或升级 Agent。

点击更新提示，中文/日语通过 **Google 网页翻译** 打开该版本的官方更新日志，英语打开原文；保留官方原文按钮。需要能访问 Google Translate，翻译可能不准确或暂不可用。仅向翻译服务传递公开日志 URL，不发送便签或 Git 数据。已获取的日志保存在本机缓存，联网刷新失败会标记陈旧。

官方发布：[Codex CLI](https://github.com/openai/codex/releases)、[Claude Code](https://github.com/anthropics/claude-code/releases)。应用内下拉菜单、确认弹窗、时间输入框采用统一样式；文件选择器与系统托盘菜单遵循 Windows 原生样式。

## 内置动画来源与许可

内置素材库中的全部 **8 个角色**，由 **fywdy / chatgpt-chibi-pets** 创作/发布，均为非官方同人，与品牌方无关联。默认仍为白发龙娘，已有绑定和自定义动画保持不变。

| 角色 | 本地资源包 |
| --- | --- |
| ChatGPT 白发龙娘 | `assets/white-dragon/` |
| Claude 橙书娘 | `assets/orange-scholar/` |
| DeepSeek 蓝鲸女仆 | `assets/whale-maid/` |
| Gemini 星猫娘 | `assets/star-cat/` |
| Grok 暗金哥特娘 | `assets/gothic/` |
| Kimi 月影娘 | `assets/moon-maid/` |
| Qwen 蓝发学者娘 | `assets/blue-scholar/` |
| 智谱 珊瑚技术娘 | `assets/coral-tech/` |

在「Agent 用量」选择 Agent，再到「形象与设置」点击角色即可绑定；切换 Agent 会恢复其形象，重启后保留。角色名称随中文、英语、日语切换。所有角色均可用于当前支持的 Codex、Claude Code；角色素材与用量接入分别管理。

来源：[fywdy/chatgpt-chibi-pets](https://github.com/fywdy/chatgpt-chibi-pets)，固定版本 [`d5bbb27c79e5c08e8b8ab44d4023cd35a67418e2`](https://github.com/fywdy/chatgpt-chibi-pets/tree/d5bbb27c79e5c08e8b8ab44d4023cd35a67418e2)。各包的 `skin.json` 记录原角色路径；原始动画来自对应目录的 `qa/previews/`。`assets/catalog.json` 是内置清单，`assets/upstream-lock.json` 记录原路径、大小与 SHA-256 校验值。

每个角色复用未经修改的 `idle`、`waving`、`waiting`、`failed`、`jumping`、`review` 六份透明 WebP 动画，共 48 份，对应待机、交互、需关注、失败、提醒和工作状态。动画表示桌宠交互与提醒，不代表 Agent 的实时工作状态。

美术许可为 **CC BY-NC 4.0**：保留署名和声明，**仅限非商业用途**，不授予原角色或品牌权利。每个资源包均附有完整的 `UPSTREAM-LICENSE.txt` 与 `UPSTREAM-NOTICE.md`，安装包也包含这些文件。

Tauri、Rust、SQLite、Git 本地命令、官方用量接口与现成动画均予以复用；Git/便签/提醒和管理界面为本项目实现。早期调研见 `docs/existing-projects.md`。

## 自定义动画

准备一个文件夹，放入动画和 `skin.json`，再通过设置的「导入动画包」选择 JSON：

```json
{
  "name": "我的角色",
  "author": "你的名字",
  "source": "素材出处",
  "license": "素材使用许可",
  "states": {
    "idle": "idle.webp",
    "happy": "happy.gif",
    "attention": "attention.webp",
    "reminder": "reminder.webp"
  }
}
```

仅 `idle` 必填，另支持 `error`、`working`。单个文件不超过 20 MB，文件须在资源包目录内。导入时复制资源，之后移动原目录不会丢失形象。在用量页切换 Agent，再到设置中选形象，即可分别保存。本版不直接导入 Codex 精灵图 ZIP。

## Claude 可选额度接入

将下面设置合并到 Claude Code 配置，路径改成实际程序位置。使用 Rust 内置命令，无需安装 Node.js。已有状态行时保留原配置并自行串联。

```json
{
  "statusLine": {
    "type": "command",
    "command": "\"C:/DeskMate/DeskMate.exe\" --claude-statusline"
  }
}
```

## 生成 Windows 安装包

在项目目录 `E:\brain-storming\deskmate` 打开 PowerShell。构建环境要求同源码运行；首次构建需联网获取 Rust 依赖和 NSIS 工具。

```powershell
npm.cmd ci
npm.cmd run dist
```

产物：`src-tauri/target/release/bundle/nsis/`。`dist` 每次从当前源码重新打包，无需先运行 `package`。安装程序支持中文、英语、日语，按当前用户安装，无需管理员权限，可以选择安装目录，并创建桌面与开始菜单快捷方式。安装后可通过快捷方式启动。可在 Windows「已安装的应用」中卸载，卸载保留用户数据。同版本重复构建会更新对应安装包文件。

仅需要免安装目录时运行 `npm.cmd run package`，输出 `release/DeskMate-0.6.0-rust-win32-x64/`。该命令不覆盖已有目录，重新生成可指定 `DESKMATE_BUILD_NAME` 为新的目录名。安装版与免安装版共用同一用户数据目录，切换版本前先退出另一版。

构建配置：`src-tauri/tauri.conf.json` 和 `src-tauri/Cargo.toml`；使用 Tauri 的 NSIS 安装器。免安装目录由 `scripts/package-rust.cjs` 生成，包含 EXE 与素材。版本为 0.6.0。不会自动发布。现有签名和内置素材的非商业许可条件仍需遵守。

## 本地数据与验证

新用户默认数据目录为 `%APPDATA%/DeskMate/`；新目录尚无数据时，如果旧版 `%APPDATA%/Longling PC Assistant/` 存在 `assistant.sqlite`、`assistant.json` 或其 JSON 备份，会继续使用旧目录，不移动或删除原数据。`DESKMATE_DATA_DIR` 优先，旧变量 `LONGLING_DATA_DIR` 仍兼容。数据目录可在设置中打开。

便签、提醒、设置、仓库、形象绑定与 Git 提交索引统一存入 **SQLite 数据库 `assistant.sqlite`**。首次启动会在单个事务中导入 `assistant.json` 和全部 `git-*.json`（含已移除仓库的存档）；导入失败会回滚，修复原文件后可以重试。旧 JSON 和 `.bak` 保持原样，仅为迁移前快照；成功导入后不再读写它们。旧主 JSON 损坏时尝试读取旧 `.bak`，并显示恢复提示。数据库初始化后不会因旧 JSON 变化而重复导入。

启动成功及正常退出时生成一致的 `assistant.sqlite.bak` 快照；数据库损坏时尝试验证并恢复该快照，同时保留 `.damaged-*` 损坏副本。快照不是逐次修改备份，可能落后于最后一次修改；日常提交由 SQLite 事务保证一致性。自定义角色文件仍在 `skins/`，动画包描述仍为 `skin.json`，可重新获取的更新缓存仍为 `release-*.json`。备份时退出程序并复制整个目录。迁移后的新增数据不会同步回旧版程序。实现和恢复说明见 [数据库迁移](docs/database-migration.md)。

提醒先写入持久状态再发通知，以避免重复；极端情况下若进程恰在两步间崩溃，可从未读列表找回。界面使用隔离 preload 与受限 IPC，不发送便签、Git 历史或提醒到服务器。

```powershell
npm.cmd test           # 功能测试，含真实临时 Git 仓库
npm.cmd run test:skins # Built-in artwork, languages and per-agent bindings
npm.cmd run test:ui    # 隔离数据的 Tauri / WebView2 流程测试与截图
npm.cmd run test:pet    # 桌宠展示模式、交互和持久化
npm.cmd run package    # Windows x64 可运行目录
```

打包版使用 Rust 程序及系统 WebView2。免安装目录需整份保留，并预装 WebView2；NSIS 安装版带有 WebView2 引导安装。已有免安装目录不会覆盖。前端通过受限 Tauri 命令调用后台。

## 目录

- `docs/pc-assistant-acceptance.md`：当前 PC 助手验收条件；`docs/mvp.md` 保留早期需求。
- `docs/existing-projects.md`：候选项目、资料链接及待验证差异。
- `src-tauri/`：Rust 后台、SQLite 和 Tauri 窗口；`src/renderer/`：保留的界面；`src/core/`：历史兼容回归实现。
- `assets/`：动画及原始许可。
- `test/`、`scripts/`：验证、打包与可选状态行桥接。
