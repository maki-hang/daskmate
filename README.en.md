# DeskMate · PC Assistant

[中文](README.md) · **English** · [日本語](README.ja.md)

A Windows x64 desktop companion for AI usage, Git history, notes and reminders. One pet shows the selected agent; each agent can have its own animation pack.

## Start

Run `release/DeskMate-0.4.1-win32-x64/DeskMate.exe`. Keep the entire folder together. If an older version is running, choose **Quit DeskMate** in its tray menu first. The new version uses the same local data directory and migrates existing notes and reminders automatically.

For source builds, install Node.js 22.12+, npm and Git:

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

## Default artwork and license

**ChatGPT white-haired dragon girl chibi**, by **fywdy / chatgpt-chibi-pets**, is unofficial fan art, not affiliated with OpenAI.

- Repository: [fywdy/chatgpt-chibi-pets](https://github.com/fywdy/chatgpt-chibi-pets).
- Pinned revision: [`d5bbb27c79e5c08e8b8ab44d4023cd35a67418e2`](https://github.com/fywdy/chatgpt-chibi-pets/tree/d5bbb27c79e5c08e8b8ab44d4023cd35a67418e2/chatgpt-white-dragon-chibi-v5).
- Original path: `chatgpt-white-dragon-chibi-v5/qa/previews/*.webp`.
- Six unmodified animations: `idle`, `waving`, `waiting`, `failed`, `jumping`, `review`.
- Artwork license: **CC BY-NC 4.0**. Attribution and notices must be retained; **noncommercial use only**. This does not grant rights to underlying characters or brands.
- Local files and original notices: `assets/white-dragon/`, `UPSTREAM-LICENSE.txt`, `UPSTREAM-NOTICE.md`.

Animations indicate pet interactions, reminders and quota attention; they do not claim to reflect live agent work status.

## Claude quota setup (optional)

Install Node.js and merge the following into your Claude Code settings, adjusting the path. If you already have a status line, preserve it and chain the scripts rather than replacing it:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"E:/brain-storming/deskmate/scripts/claude-statusline.cjs\""
  }
}
```

The packaged script is `resources/claude-statusline.cjs`. It saves only quota values, reset times and the snapshot time, prints a visible status line and does not read credentials or send additional quota requests. Both processes must use the same data directory. Use Claude again to refresh stale snapshots.

## Build a Windows installer

Open PowerShell in `E:\brain-storming\deskmate`. Requires Windows x64, Node.js 22.12+ and npm. The first build downloads Electron and NSIS tools.

```powershell
npm.cmd ci
npm.cmd run dist
```

Output: `release/installers/DeskMate-Setup-0.4.1-x64.exe`. Every `dist` run packages the current source; no separate `package` step is needed. The installer supports English, Chinese and Japanese, installs for the current user without administrator access, lets you choose a directory, and creates desktop/Start Menu shortcuts. It does not launch the app automatically. Uninstall from Windows Installed Apps; user data is retained. Rebuilding the same version replaces its installer artifact.

For a portable folder, run `npm.cmd run package`: output is `release/DeskMate-0.4.1-win32-x64/`. Existing portable output is protected; choose another `DESKMATE_BUILD_NAME` to rebuild. Both editions share user data; quit one before opening the other.

Configuration: `electron-builder.cjs`; workflow: `scripts/installer.cjs`; original generated icon: `scripts/icon.cjs`. Version comes from `package.json`. Uses electron-builder's NSIS target and never publishes automatically. The installer is unsigned and Windows may show an unknown publisher; configure code signing separately before public distribution. The default artwork's CC BY-NC 4.0 noncommercial restriction also applies to the installer.

## Data, development and testing

New users: `%APPDATA%/DeskMate/`. If the new directory has no saved data and `%APPDATA%/Longling PC Assistant/assistant.json` exists, the app keeps using that legacy directory without moving or deleting it. `DESKMATE_DATA_DIR` takes priority; `LONGLING_DATA_DIR` remains compatible. `assistant.json` stores notes, reminders and settings; `.bak` holds the previous version for recovery. `git-*.json` stores commit indexes, `skins/` imported artwork, and `release-*.json` release caches. Quit the app and copy the entire directory to back up. `DESKMATE_DATA_DIR` selects an isolated directory.

```powershell
npm.cmd test
npm.cmd run test:ui
npm.cmd run test:pet    # Pet display modes, interactions and persistence
npm.cmd run package
```

Packaging uses the official Electron runtime and ASAR. Existing output directories are never overwritten. This is an unsigned portable Windows x64 build. Renderers are sandboxed with context isolation and restricted IPC. The scheduler persists before notifying to avoid duplicates; a crash in between can leave a notification only in the unread list. Notes and Git history are not uploaded.

`src/` contains the app, `assets/` the licensed animations, `scripts/` build/integration tools, and `test/` functional checks. Prior research is kept in `docs/existing-projects.md`. Other Windows machines, very large repositories and every timezone/notification configuration have not been verified.
