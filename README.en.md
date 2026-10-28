# DeskMate · PC Assistant

[中文](README.md) · **English** · [日本語](README.ja.md)

**0.6.0: Tauri 2 + Rust + WebView2 + SQLite.** The existing HTML/CSS/JavaScript UI is retained. Packaged builds do not need Node.js. See [Rust migration](docs/rust-migration.md) for development and compatibility details.

A Windows x64 desktop companion for AI usage, Git history, notes and reminders. One pet shows the selected agent; each agent can have its own animation pack.

## Start

Run `release/DeskMate-0.6.0-rust-win32-x64/DeskMate.exe`. Keep the entire folder together. If an older version is running, choose **Quit DeskMate** in its tray menu first. The new version uses the same local data directory and migrates existing notes and reminders automatically.

For source builds, install Node.js 22.13+, npm, Git, Rust stable (1.90+), C++ Build Tools, Windows SDK and WebView2:

```powershell
npm.cmd ci
npm.cmd start
```

Click the pet to open the panel; right-click it or the tray icon to switch agents. Hold the left mouse button on the pet for about 350 ms, then move to drag it. Release to save its position; releasing a drag does not open the panel. A short left click still opens the panel. Closing the panel keeps the app running. Use the tray menu to quit.

## Pet quota display

Choose a mode in **Appearance & settings → Pet quota display**, or from the pet's right-click menu:

- **Always visible** (default): a compact 180-pixel strip with a remaining percentage and progress bar for each window. Low quotas use warm colors.
- **Show on hover**: hover over the pet to reveal the same 180-pixel strip used in always-visible mode. Move onto the strip and click to open usage details; moving away hides it. Keyboard focus also reveals it, and Escape dismisses it.

The preference applies immediately and persists across restarts. Both modes prioritize the five-hour window; reset credits remain in the usage panel only. Hidden cards and transparent window padding allow clicks to pass through to the desktop.

## Languages

Choose Chinese, English or Japanese from the top-right language selector or Settings. The choice persists and applies to the panel, pet, tray, date formatting and user guide. First launch follows the system language, defaulting to Chinese for other languages. Your own notes, commit messages and custom pack names are not translated.

## Usage and updates

- **Codex:** uses the official local `app-server` methods `account/rateLimits/read` and `account/usage/read`. Reuses your Codex login; reading usage does not start model tasks. Displays separate quota windows, including 5 hours and 7 days when returned, reset times, earned reset count and available expiry details, today's tokens and lifetime tokens. Missing data is `—`, not zero. Reset credits are display-only; redeem them in Codex. The server's available count is authoritative, even if detailed rows are omitted or capped. Daily buckets follow server dates; an absent day stays unknown.
- **Claude Code:** counts tokens from local logs, including input, output and cache tokens, deduplicating streamed/copied messages. Optional status-line integration adds 5-hour/7-day quota snapshots. Snapshots older than 10 minutes or beyond their reset time are marked stale. Local totals and Codex account totals have different scopes.
- **Pet:** shows the 5-hour window before longer windows and leaves reset credits in the main usage panel only. Hover over quota rows for reset times. Multiple quota rows can be scrolled.
- **Agent updates:** checks official GitHub stable releases for **Codex CLI** and **Claude Code** every 6 hours. Compares against the detected local CLI; an unknown version is clearly marked. This is not a Codex desktop app updater. No agent is installed or upgraded automatically.
- **Release notes:** the update prompt opens the exact official release through Google website translation for Chinese/Japanese; English opens the original. An original-source button is always available. Translation requires Google Translate access and may be imperfect or unavailable. Only the public release URL goes to Google; notes and Git data are not sent. Previously fetched releases are cached, with stale results marked when a refresh fails.

Sources: [Codex App Server](https://learn.chatgpt.com/docs/app-server), [Claude status line](https://code.claude.com/docs/en/statusline), [Codex CLI releases](https://github.com/openai/codex/releases), [Claude Code releases](https://github.com/anthropics/claude-code/releases).

## Git history

Add repositories or scan a folder. All locally available branches, remote-tracking branches and reflog-reachable commits are indexed every minute. Previously indexed commits remain archived after a branch is deleted. Search messages, author names/emails and hashes; filter by repository/date and browse pages.

The default **Local author only** filter matches each repository's effective `git config user.email`, falling back to `user.name` if no email is configured. Without either, that repository has no matches; switch to **All authors** or configure Git. Repository-level identity overrides are respected. The filter does not delete archived commits. No manual sync button, Git hooks, configuration changes, fetch or push are required. Unfetched commits, unregistered repositories and already-collected garbage that was never indexed cannot be recovered.

## Notes and reminders

The combined calendar supports multiple notes per day, with **date and hh:mm:ss**. A note can optionally remind you at that time, once/daily/weekly. Edit, pause, resume, snooze for 10 minutes, mark read or delete the note and its linked reminder together. Filters show a selected day, all notes or unread reminders. Active recurring/snoozed notes appear on the calendar at their next due date; the original note date is retained.

Uses the PC's local timezone. Notification and pet bubble fire while the app runs, including with the panel hidden. The app does not wake a powered-off PC. Missed reminders catch up once on launch/resume; repeat schedules advance to the future. System do-not-disturb can suppress OS notifications; the unread list and pet bubble remain. Second precision is supported, but this is not a real-time scheduler: OS suspension or load can delay delivery. Editing only note text preserves a completed/paused reminder; change its date/time/repeat to reschedule. Packaged builds support optional launch at login.

Legacy date-only notes receive `00:00:00`. Old reminders become linked notes, preserving pause/completion/unread/repeat state. Unsaved drafts survive language changes; navigation asks before discarding them.

## Custom animations

Select an agent, then import a local `skin.json` in Settings:

```json
{
  "name": "My companion",
  "author": "Your name",
  "source": "Artwork source",
  "license": "Usage license",
  "states": {
    "idle": "idle.webp",
    "happy": "happy.gif",
    "attention": "attention.webp",
    "reminder": "reminder.webp"
  }
}
```

Only `idle` is required; `error` and `working` are also supported. GIF/WebP/PNG/APNG files must be inside the pack folder and each at most 20 MB. Import copies the files. Missing states fall back to idle. Codex sprite-sheet ZIP files are not directly supported.

## Built-in artwork and license

All **8 characters** from **fywdy / chatgpt-chibi-pets** are included. They are unofficial fan art with no brand affiliation. The white dragon girl remains the default; existing bindings and imported packs are preserved.

| Character | Local pack |
| --- | --- |
| ChatGPT · White dragon girl | `assets/white-dragon/` |
| Claude · Orange scholar | `assets/orange-scholar/` |
| DeepSeek · Whale maid | `assets/whale-maid/` |
| Gemini · Star cat girl | `assets/star-cat/` |
| Grok · Gothic girl | `assets/gothic/` |
| Kimi · Moon maid | `assets/moon-maid/` |
| Qwen · Blue-haired scholar | `assets/blue-scholar/` |
| Zhipu · Coral tech girl | `assets/coral-tech/` |

Choose an agent on the usage page, then click a character in **Appearance & settings**. Each agent keeps its own choice across switches and restarts. Built-in names follow the selected Chinese, English or Japanese language. Any character can be used with the supported Codex and Claude Code agents; artwork and usage integrations are managed separately.

Source: [fywdy/chatgpt-chibi-pets](https://github.com/fywdy/chatgpt-chibi-pets), pinned to [`d5bbb27c79e5c08e8b8ab44d4023cd35a67418e2`](https://github.com/fywdy/chatgpt-chibi-pets/tree/d5bbb27c79e5c08e8b8ab44d4023cd35a67418e2). Each pack's `skin.json` links to its original character directory; animations come from its `qa/previews/` folder. `assets/catalog.json` lists the packs and `assets/upstream-lock.json` records source paths, sizes and SHA-256 checksums.

Each pack includes six unmodified transparent WebP animations: `idle`, `waving`, `waiting`, `failed`, `jumping` and `review` (48 files total). They map to idle, interaction, attention, error, reminder and working states. Animations do not claim to reflect live agent work status.

Artwork license: **CC BY-NC 4.0**, **noncommercial use only**, retaining attribution and notices. This does not grant rights to underlying characters or brands. Each local pack includes the full `UPSTREAM-LICENSE.txt` and `UPSTREAM-NOTICE.md`, also included in packaged builds.

## Claude quota setup (optional)

Merge this into Claude Code settings and use the actual DeskMate executable path. The built-in Rust command needs no Node.js. Preserve and chain any existing status line.

```json
{
  "statusLine": {
    "type": "command",
    "command": "\"C:/DeskMate/DeskMate.exe\" --claude-statusline"
  }
}
```

## Build a Windows installer

Open PowerShell in `E:\brain-storming\deskmate`. Use the source-build prerequisites above. First build downloads Rust dependencies and NSIS tools.

```powershell
npm.cmd ci
npm.cmd run dist
```

Output: `src-tauri/target/release/bundle/nsis/`. Every `dist` run packages the current source; no separate `package` step is needed. The installer supports English, Chinese and Japanese, installs for the current user without administrator access, lets you choose a directory, and creates desktop/Start Menu shortcuts. Uninstall from Windows Installed Apps; user data is retained. Rebuilding the same version replaces its installer artifact.

For a portable folder, run `npm.cmd run package`: output is `release/DeskMate-0.6.0-rust-win32-x64/`. Existing portable output is protected; choose another `DESKMATE_BUILD_NAME` to rebuild. Both editions share user data; quit one before opening the other.

Build configuration: `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`. Tauri generates NSIS installers; `scripts/package-rust.cjs` creates a portable folder with the EXE and assets. Version: 0.6.0. Publishing is never automatic. Signing and artwork license requirements remain unchanged.

## Data, development and testing

New users: `%APPDATA%/DeskMate/`. If it has no saved data and the legacy `%APPDATA%/Longling PC Assistant/` contains `assistant.sqlite`, `assistant.json` or its JSON backup, that directory remains in use without moving or deleting files. `DESKMATE_DATA_DIR` takes priority; `LONGLING_DATA_DIR` remains compatible.

Notes, reminders, settings, repositories, skin bindings and commit indexes now live in **`assistant.sqlite` (SQLite)**. First launch imports `assistant.json` and every `git-*.json`, including removed repositories' archives, in one transaction. Failed imports roll back and can be retried after repairing the originals. Legacy JSON and `.bak` files remain unchanged as pre-migration snapshots and are no longer read or written after successful initialization. A damaged legacy main file can be imported from its valid `.bak`, with a recovery notice.

Successful startup and clean exit produce a consistent `assistant.sqlite.bak` snapshot. On database corruption, a verified snapshot can be restored automatically while preserving `.damaged-*` evidence. Snapshots may predate the latest edits; normal writes use SQLite transactions. `skins/`, animation manifests (`skin.json`), and disposable release caches (`release-*.json`) remain files. Quit the app and copy the whole directory for backups. New database changes do not sync back to older JSON-based builds. See [database migration](docs/database-migration.md).

```powershell
npm.cmd test
npm.cmd run test:skins # Built-in artwork, languages and per-agent bindings
npm.cmd run test:ui
npm.cmd run test:pet    # Pet display modes, interactions and persistence
npm.cmd run package
```

Packaged builds use a Rust executable and system WebView2. Keep the whole portable folder and install WebView2; NSIS includes a WebView2 bootstrapper. Existing portable output is protected. The frontend uses restricted Tauri commands.

`src-tauri/` contains the Rust backend, `src/renderer/` the UI, `assets/` the licensed animations, `scripts/` build/integration tools, and `test/` functional checks. Prior research is kept in `docs/existing-projects.md`. Other Windows machines, very large repositories and every timezone/notification configuration have not been verified.
