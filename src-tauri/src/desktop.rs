use crate::{
    agenda, err, git, skins,
    store::{self, Store},
    updates, usage, Result,
};
use fs2::FileExt;
use serde_json::{json, Value};
use std::{
    fs::{self, File, OpenOptions},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, WebviewWindow,
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

#[derive(Clone, Copy)]
struct Drag {
    origin: PhysicalPosition<i32>,
    cursor: PhysicalPosition<f64>,
}
struct Runtime {
    store: Arc<Mutex<Store>>,
    assets: PathBuf,
    resources: PathBuf,
    last: Mutex<Value>,
    git_gate: tokio::sync::Mutex<()>,
    usage: [tokio::sync::Mutex<usage::UsageService>; 2],
    updates: [tokio::sync::Mutex<updates::UpdateService>; 2],
    drag: Mutex<Option<Drag>>,
    interactive: AtomicBool,
    quitting: AtomicBool,
    _lock: File,
}
fn runtime(app: &AppHandle) -> tauri::State<'_, Arc<Runtime>> {
    app.state::<Arc<Runtime>>()
}
fn tr(app: &AppHandle, key: &str) -> String {
    let language = runtime(app)
        .store
        .lock()
        .ok()
        .and_then(|s| s.state["settings"]["language"].as_str().map(str::to_owned))
        .unwrap_or_else(|| "zh-CN".into());
    let index = match language.as_str() {
        "en" => 1,
        "ja" => 2,
        _ => 0,
    };
    let messages: Value = serde_json::from_str(include_str!("../i18n.json")).unwrap();
    messages[key][index].as_str().unwrap_or(key).into()
}
fn state(app: &AppHandle) -> Result<Value> {
    let rt = runtime(app);
    let store = rt.store.lock().map_err(err)?;
    let mut state = store.state.clone();
    state["skins"] = skins::all(&store, &rt.assets)?;
    state["agents"] = usage::agents();
    state["dataDirectory"] = json!(store.directory.to_string_lossy());
    state["recovered"] = json!(store.recovered);
    state["packaged"] = json!(!cfg!(debug_assertions));
    state["lastReminder"] = rt.last.lock().map_err(err)?.clone();
    Ok(state)
}
fn changed(app: &AppHandle) {
    if let Ok(value) = state(app) {
        let _ = app.emit("assistant:changed", value);
    }
}
fn open_panel(app: &AppHandle, page: Option<&str>) {
    if let Some(window) = app.get_webview_window("panel") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        if let Some(page) = page {
            let _ = window.emit("assistant:navigate", page);
        }
    }
}
fn menu(app: &AppHandle) -> Result<Menu<tauri::Wry>> {
    let settings = runtime(app).store.lock().map_err(err)?.state["settings"].clone();
    let menu = Menu::new(app).map_err(err)?;
    let item = |id: &str, key: &str| {
        MenuItem::with_id(app, id, tr(app, key), true, None::<&str>).map_err(err)
    };
    menu.append(&item("open", "openApp")?).map_err(err)?;
    let agents = Submenu::new(app, tr(app, "switchAgent"), true).map_err(err)?;
    for (id, name) in [("codex", "Codex"), ("claude", "Claude Code")] {
        agents
            .append(
                &CheckMenuItem::with_id(
                    app,
                    format!("agent:{id}"),
                    name,
                    true,
                    settings["agent"] == id,
                    None::<&str>,
                )
                .map_err(err)?,
            )
            .map_err(err)?;
    }
    menu.append(&agents).map_err(err)?;
    let modes = Submenu::new(app, tr(app, "petQuotaDisplay"), true).map_err(err)?;
    for (id, key) in [("always", "quotaAlways"), ("hover", "quotaHover")] {
        modes
            .append(
                &CheckMenuItem::with_id(
                    app,
                    format!("mode:{id}"),
                    tr(app, key),
                    true,
                    settings["petQuotaDisplay"].as_str().unwrap_or("always") == id,
                    None::<&str>,
                )
                .map_err(err)?,
            )
            .map_err(err)?;
    }
    menu.append(&modes).map_err(err)?;
    for (id, key) in [("agenda", "agenda"), ("settings", "settings")] {
        menu.append(&item(id, key)?).map_err(err)?;
    }
    menu.append(&PredefinedMenuItem::separator(app).map_err(err)?)
        .map_err(err)?;
    for (id, key) in [("show", "showPet"), ("hide", "hidePet"), ("quit", "quit")] {
        menu.append(&item(id, key)?).map_err(err)?;
    }
    Ok(menu)
}
fn refresh_menu(app: &AppHandle) -> Result<()> {
    if let Some(tray) = app.tray_by_id("deskmate") {
        tray.set_menu(Some(menu(app)?)).map_err(err)?;
        tray.set_tooltip(Some(tr(app, "appTitle"))).map_err(err)?;
    }
    if let Some(panel) = app.get_webview_window("panel") {
        panel.set_title(&tr(app, "appTitle")).map_err(err)?;
    }
    Ok(())
}
fn trim_last(app: &AppHandle) {
    let rt = runtime(app);
    let unread = rt
        .store
        .lock()
        .ok()
        .map(|s| {
            s.state["reminders"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|r| r["unread"] == true)
                .map(|r| r["id"].clone())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if let Ok(mut last) = rt.last.lock() {
        if !unread.contains(&last["id"]) {
            *last = Value::Null;
        }
    };
}
fn tick(app: &AppHandle) -> Result<()> {
    let rt = runtime(app);
    if rt.quitting.load(Ordering::Relaxed) {
        return Ok(());
    }
    let fired = agenda::collect_due(&mut *rt.store.lock().map_err(err)?, chrono::Utc::now())?;
    for item in &fired {
        let value = json!({"title":item["title"],"id":item["id"],"at":crate::now()});
        *rt.last.lock().map_err(err)? = value.clone();
        let _ = app
            .notification()
            .builder()
            .title(tr(app, "reminderTitle"))
            .body(item["title"].as_str().unwrap_or(""))
            .show();
        if let Some(pet) = app.get_webview_window("pet") {
            let _ = pet.show();
        }
        let _ = app.emit("assistant:reminder", value);
    }
    if !fired.is_empty() {
        changed(app)
    }
    Ok(())
}
async fn refresh_usage(app: &AppHandle, force: bool) -> Result<Value> {
    let rt = runtime(app);
    let (settings, directory) = {
        let store = rt.store.lock().map_err(err)?;
        (store.state["settings"].clone(), store.directory.clone())
    };
    let agent = settings["agent"].as_str().unwrap_or("codex");
    let index = agent_index(agent)?;
    let value = rt.usage[index]
        .lock()
        .await
        .read(agent, settings["codexPath"].as_str(), &directory, force)
        .await;
    if rt.store.lock().map_err(err)?.state["settings"]["agent"] == agent {
        let _ = app.emit("assistant:usage", &value);
    }
    Ok(value)
}
fn agent_index(agent: &str) -> Result<usize> {
    match agent {
        "codex" => Ok(0),
        "claude" => Ok(1),
        _ => Err("未知 Agent".into()),
    }
}
async fn release(app: &AppHandle, value: &Value) -> Result<Value> {
    let rt = runtime(app);
    let (settings, directory) = {
        let store = rt.store.lock().map_err(err)?;
        (store.state["settings"].clone(), store.directory.clone())
    };
    let agent = value["agent"]
        .as_str()
        .or_else(|| settings["agent"].as_str())
        .unwrap_or("codex");
    let index = agent_index(agent)?;
    let mut service = rt.updates[index].lock().await;
    service
        .read(
            agent,
            &directory,
            settings["codexPath"].as_str(),
            value["force"] == true,
        )
        .await
}
async fn sync(app: &AppHandle) -> Result<()> {
    let rt = runtime(app);
    let _guard = rt.git_gate.lock().await;
    git::sync(&rt.store).await?;
    changed(app);
    Ok(())
}
fn settings(app: &AppHandle, value: &Value) -> Result<Value> {
    let rt = runtime(app);
    let all = {
        let store = rt.store.lock().map_err(err)?;
        skins::all(&store, &rt.assets)?
    };
    // Validate before applying any external OS setting.
    if let Some(language) = value.get("language") {
        if ![json!("zh-CN"), json!("en"), json!("ja")].contains(language) {
            return Err("invalidLanguage".into());
        }
    }
    if let Some(agent) = value.get("agent") {
        agent_index(agent.as_str().ok_or("未知 Agent")?)?;
    }
    if let Some(mode) = value.get("petQuotaDisplay") {
        if ![json!("always"), json!("hover")].contains(mode) {
            return Err("invalidQuotaDisplay".into());
        }
    }
    if let Some(skin) = value.get("skinId") {
        if !all.as_array().unwrap().iter().any(|s| s["id"] == *skin) {
            return Err("形象不存在".into());
        }
        if let Some(agent) = value.get("skinAgent") {
            agent_index(agent.as_str().ok_or("未知 Agent")?)?;
        }
    }
    for key in ["alwaysOnTop", "launchAtLogin"] {
        if value.get(key).is_some_and(|v| !v.is_boolean()) {
            return Err("Invalid setting".into());
        }
    }
    let previous = rt.store.lock().map_err(err)?.state["settings"].clone();
    if let Some(enabled) = value["launchAtLogin"].as_bool() {
        if cfg!(debug_assertions) {
            return Err("开机启动需使用打包后的桌面版。".into());
        }
        if enabled {
            app.autolaunch().enable().map_err(err)?
        } else {
            app.autolaunch().disable().map_err(err)?
        }
    }
    let result = rt.store.lock().map_err(err)?.update(|s| {
        for key in [
            "language",
            "agent",
            "petQuotaDisplay",
            "alwaysOnTop",
            "launchAtLogin",
        ] {
            if let Some(v) = value.get(key) {
                s["settings"][key] = v.clone();
            }
        }
        if let Some(id) = value.get("skinId") {
            let agent = value["skinAgent"]
                .as_str()
                .or_else(|| s["settings"]["agent"].as_str())
                .unwrap_or("codex")
                .to_string();
            s["settings"]["skins"][agent] = id.clone();
        }
        Ok(())
    });
    if let Err(error) = result {
        if value.get("launchAtLogin").is_some() {
            if previous["launchAtLogin"] == true {
                let _ = app.autolaunch().enable();
            } else {
                let _ = app.autolaunch().disable();
            }
        }
        return Err(error);
    }
    let always = rt.store.lock().map_err(err)?.state["settings"]["alwaysOnTop"]
        .as_bool()
        .unwrap_or(true);
    if let Some(pet) = app.get_webview_window("pet") {
        pet.set_always_on_top(always).map_err(err)?;
    }
    refresh_menu(app)?;
    changed(app);
    state(app)
}
fn end_drag(app: &AppHandle) -> Result<()> {
    let rt = runtime(app);
    let drag = rt.drag.lock().map_err(err)?.take();
    if drag.is_some() {
        save_position(app)?;
    }
    Ok(())
}
fn save_position(app: &AppHandle) -> Result<()> {
    let pet = app.get_webview_window("pet").ok_or("Missing pet")?;
    let position = pet.outer_position().map_err(err)?;
    let scale = pet.scale_factor().map_err(err)?;
    runtime(app).store.lock().map_err(err)?.update(|s|{s["settings"]["position"]=json!({"x":(f64::from(position.x)/scale).round(),"y":(f64::from(position.y)/scale).round()});s["settings"]["positionPhysical"]=json!({"x":position.x,"y":position.y});Ok(())})?;
    Ok(())
}
pub fn clamp_position(x: f64, y: f64, area: (f64, f64, f64, f64), scale: f64) -> (i32, i32) {
    let (min_x, min_y) = (area.0 - 35.0 * scale, area.1 - 53.0 * scale);
    (
        (x.clamp(min_x, min_x + (area.2 - 190.0 * scale).max(0.0))).round() as i32,
        (y.clamp(min_y, min_y + (area.3 - 185.0 * scale).max(0.0))).round() as i32,
    )
}
fn move_drag(app: &AppHandle, cursor: PhysicalPosition<f64>) -> Result<()> {
    let rt = runtime(app);
    let drag = *rt.drag.lock().map_err(err)?;
    if let Some(drag) = drag {
        let pet = app.get_webview_window("pet").ok_or("Missing pet")?;
        let monitor = pet
            .monitor_from_point(cursor.x, cursor.y)
            .map_err(err)?
            .or(pet.primary_monitor().map_err(err)?)
            .ok_or("Missing monitor")?;
        let area = monitor.work_area();
        let (x, y) = clamp_position(
            f64::from(drag.origin.x) + cursor.x - drag.cursor.x,
            f64::from(drag.origin.y) + cursor.y - drag.cursor.y,
            (
                f64::from(area.position.x),
                f64::from(area.position.y),
                f64::from(area.size.width),
                f64::from(area.size.height),
            ),
            monitor.scale_factor(),
        );
        pet.set_position(PhysicalPosition::new(x, y)).map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
async fn assistant_call(
    app: AppHandle,
    window: WebviewWindow,
    action: String,
    value: Value,
) -> Result<Value> {
    if !["panel", "pet"].contains(&window.label()) {
        return Err("不允许的请求".into());
    }
    if action.starts_with("pet.") && window.label() != "pet" {
        return Err("不允许的请求".into());
    }
    let rt = runtime(&app);
    match action.as_str() {
        "window.ready" => {
            window.show().map_err(err)?;
            Ok(json!(true))
        }
        "state" => state(&app),
        "usage" => refresh_usage(&app, value["force"] == true).await,
        "updates" => release(&app, &value).await,
        "updates.open" => {
            let data = release(&app, &value).await?;
            let language = if value["original"] == true {
                "en".into()
            } else {
                rt.store.lock().map_err(err)?.state["settings"]["language"]
                    .as_str()
                    .unwrap_or("zh-CN")
                    .to_string()
            };
            let url = updates::translated_url(
                data["url"].as_str().ok_or("releaseUnavailable")?,
                &language,
            )?;
            app.opener().open_url(url, None::<&str>).map_err(err)?;
            Ok(json!(true))
        }
        "panel" => {
            open_panel(&app, value["page"].as_str());
            Ok(json!(true))
        }
        "menu" => {
            window.popup_menu(&menu(&app)?).map_err(err)?;
            Ok(json!(true))
        }
        "settings" => {
            let result = settings(&app, &value)?;
            if value.get("agent").is_some() {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = refresh_usage(&handle, false).await;
                });
            }
            Ok(result)
        }
        "agenda.save" | "note.save" | "reminder.save" => {
            let result = {
                let mut store = rt.store.lock().map_err(err)?;
                match action.as_str() {
                    "agenda.save" => agenda::save_agenda(&mut store, &value),
                    "note.save" => agenda::save_note(&mut store, &value),
                    _ => agenda::save_reminder(&mut store, &value),
                }
            }?;
            trim_last(&app);
            changed(&app);
            tick(&app)?;
            Ok(result)
        }
        "note.delete" | "reminder.delete" | "reminder.toggle" | "reminder.snooze"
        | "reminder.ack" | "git.remove" => {
            rt.store.lock().map_err(err)?.update(|s| {
                match action.as_str() {
                    "note.delete" => {
                        s["notes"]
                            .as_array_mut()
                            .unwrap()
                            .retain(|n| n["id"] != value["id"]);
                        s["reminders"]
                            .as_array_mut()
                            .unwrap()
                            .retain(|r| r["noteId"] != value["id"]);
                    }
                    "reminder.delete" => s["reminders"]
                        .as_array_mut()
                        .unwrap()
                        .retain(|r| r["id"] != value["id"]),
                    "git.remove" => s["repositories"]
                        .as_array_mut()
                        .unwrap()
                        .retain(|r| r["id"] != value["id"]),
                    _ => {
                        for r in s["reminders"].as_array_mut().unwrap() {
                            if action == "reminder.ack" {
                                r["unread"] = json!(false);
                            } else if r["id"] == value["id"] {
                                if action == "reminder.toggle" {
                                    r["enabled"] = json!(r["enabled"] != true);
                                    if r["enabled"] == true {
                                        r["completed"] = json!(false);
                                    }
                                } else {
                                    r["dueAt"] = json!((chrono::Utc::now()
                                        + chrono::Duration::minutes(10))
                                    .to_rfc3339());
                                    r["enabled"] = json!(true);
                                    r["completed"] = json!(false);
                                    r["unread"] = json!(false);
                                }
                            }
                        }
                    }
                }
                Ok(())
            })?;
            trim_last(&app);
            changed(&app);
            tick(&app)?;
            Ok(json!(true))
        }
        "git.query" => rt.store.lock().map_err(err)?.query_git(&value),
        "git.sync" => {
            sync(&app).await?;
            Ok(rt.store.lock().map_err(err)?.state["repositories"].clone())
        }
        "git.add" => {
            let dialog = app.dialog().file().set_title(tr(
                &app,
                if value["scan"] == true {
                    "selectScan"
                } else {
                    "selectRepo"
                },
            ));
            let selected =
                tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_folder())
                    .await
                    .map_err(err)?;
            let Some(selected) = selected else {
                return Ok(json!({"canceled":true}));
            };
            let directory = selected.into_path().map_err(err)?;
            let discovery = if value["scan"] == true {
                let directory = directory.clone();
                tauri::async_runtime::spawn_blocking(move || git::discover(&directory))
                    .await
                    .map_err(err)?
            } else {
                json!({"found":[directory.to_string_lossy()],"warnings":[]})
            };
            let mut added = 0;
            let mut errors = Vec::new();
            for directory in discovery["found"].as_array().unwrap() {
                let before = rt.store.lock().map_err(err)?.state["repositories"]
                    .as_array()
                    .unwrap()
                    .len();
                if git::add(&rt.store, std::path::Path::new(directory.as_str().unwrap()))
                    .await
                    .is_ok()
                {
                    let after = rt.store.lock().map_err(err)?.state["repositories"]
                        .as_array()
                        .unwrap()
                        .len();
                    added += after.saturating_sub(before);
                } else {
                    errors.push(directory.clone());
                }
            }
            sync(&app).await?;
            Ok(json!({"added":added,"errors":errors,"warnings":discovery["warnings"]}))
        }
        "skin.import" | "codex.path" => {
            let mut dialog = app.dialog().file().set_title(tr(
                &app,
                if action == "skin.import" {
                    "selectSkin"
                } else {
                    "selectCodex"
                },
            ));
            if action == "skin.import" {
                dialog = dialog.add_filter(tr(&app, "skinFiles"), &["json"]);
            }
            let selected =
                tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_file())
                    .await
                    .map_err(err)?;
            let Some(selected) = selected else {
                return Ok(Value::Null);
            };
            let path = selected.into_path().map_err(err)?;
            let result = if action == "skin.import" {
                skins::import(&mut *rt.store.lock().map_err(err)?, &path)?
            } else {
                rt.store.lock().map_err(err)?.update(|s| {
                    s["settings"]["codexPath"] = json!(path.to_string_lossy());
                    Ok(())
                })?;
                json!(true)
            };
            changed(&app);
            Ok(result)
        }
        "data.open" => {
            let directory = rt
                .store
                .lock()
                .map_err(err)?
                .directory
                .to_string_lossy()
                .to_string();
            app.opener()
                .open_path(directory, None::<&str>)
                .map_err(err)?;
            Ok(json!(true))
        }
        "readme.open" => {
            let language = rt.store.lock().map_err(err)?.state["settings"]["language"]
                .as_str()
                .unwrap_or("zh-CN")
                .to_string();
            let file = match language.as_str() {
                "en" => "README.en.md",
                "ja" => "README.ja.md",
                _ => "README.md",
            };
            app.opener()
                .open_path(rt.resources.join(file).to_string_lossy(), None::<&str>)
                .map_err(err)?;
            Ok(json!(true))
        }
        "external" => {
            let url = match value["key"].as_str().unwrap_or("") {
                "codex" => "https://chatgpt.com/codex/settings/usage",
                "claude" => "https://claude.ai/settings/usage",
                "artwork" => "https://github.com/fywdy/chatgpt-chibi-pets",
                "documentation" => "https://code.claude.com/docs/en/statusline",
                _ => return Err("未知链接".into()),
            };
            app.opener().open_url(url, None::<&str>).map_err(err)?;
            Ok(json!(true))
        }
        "pet.pointer" => {
            let interactive = value["interactive"].as_bool().ok_or("不允许的请求")?;
            rt.interactive.store(interactive, Ordering::Relaxed);
            let dragging = rt.drag.lock().map_err(err)?.is_some();
            window
                .set_ignore_cursor_events(!dragging && !interactive)
                .map_err(err)?;
            Ok(json!(true))
        }
        "pet.drag.start" => {
            let cursor = app.cursor_position().map_err(err)?;
            let origin = window.outer_position().map_err(err)?;
            *rt.drag.lock().map_err(err)? = Some(Drag { origin, cursor });
            window.set_ignore_cursor_events(false).map_err(err)?;
            Ok(json!(true))
        }
        "pet.drag.end" => {
            end_drag(&app)?;
            Ok(json!(true))
        }
        _ => Err("未知操作".into()),
    }
}
fn pointer_worker(app: AppHandle) {
    std::thread::spawn(move || {
        let mut previous = None;
        while !runtime(&app).quitting.load(Ordering::Relaxed) {
            if let (Ok(cursor), Some(pet)) = (app.cursor_position(), app.get_webview_window("pet"))
            {
                #[cfg(windows)]
                {
                    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
                        GetAsyncKeyState, VK_LBUTTON,
                    };
                    if unsafe { GetAsyncKeyState(i32::from(VK_LBUTTON)) } >= 0 {
                        let _ = end_drag(&app);
                    }
                }
                let _ = move_drag(&app, cursor);
                if let (Ok(position), Ok(scale)) = (pet.outer_position(), pet.scale_factor()) {
                    let coordinates = (
                        (cursor.x - f64::from(position.x)) / scale,
                        (cursor.y - f64::from(position.y)) / scale,
                    );
                    if previous != Some(coordinates) {
                        previous = Some(coordinates);
                        let _ = pet.emit(
                            "assistant:pointer",
                            json!({"x":coordinates.0,"y":coordinates.1}),
                        );
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(16));
        }
    });
}
fn system_locale() -> String {
    #[cfg(windows)]
    {
        let mut name = [0u16; 85];
        let length = unsafe {
            windows_sys::Win32::Globalization::GetUserDefaultLocaleName(
                name.as_mut_ptr(),
                name.len() as i32,
            )
        };
        if length > 0 {
            return String::from_utf16_lossy(&name[..length as usize - 1]);
        }
    }
    std::env::var("LANG").unwrap_or_default()
}
fn setup(app: &mut tauri::App) -> Result<()> {
    let base = dirs::config_dir().ok_or("无法定位本地数据目录")?;
    let directory = store::data_directory(&base);
    fs::create_dir_all(&directory).map_err(err)?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(directory.join("deskmate.lock"))
        .map_err(err)?;
    lock.try_lock_exclusive()
        .map_err(|_| "桌伴已在运行，请先退出另一版本。")?;
    let mut store = Store::open(&directory)?;
    if store.state["settings"]["language"].is_null() {
        let locale = system_locale();
        let language = if locale.starts_with("ja") {
            "ja"
        } else if locale.starts_with("en") {
            "en"
        } else {
            "zh-CN"
        };
        store.update(|s| {
            s["settings"]["language"] = json!(language);
            Ok(())
        })?;
    }
    let resources = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf()
    } else {
        app.path().resource_dir().map_err(err)?
    };
    let assets = resources.join("assets");
    app.asset_protocol_scope()
        .allow_directory(&assets, true)
        .map_err(err)?;
    app.asset_protocol_scope()
        .allow_directory(directory.join("skins"), true)
        .map_err(err)?;
    let initial_settings = store.state["settings"].clone();
    if !cfg!(debug_assertions) && initial_settings["launchAtLogin"] == true {
        // Reuse Electron's registry entry and transfer its enabled setting to
        // this executable, rather than leaving two startup registrations.
        app.autolaunch().enable().map_err(err)?;
    }
    app.manage(Arc::new(Runtime {
        store: Arc::new(Mutex::new(store)),
        assets,
        resources,
        last: Mutex::new(Value::Null),
        git_gate: tokio::sync::Mutex::new(()),
        usage: std::array::from_fn(|_| tokio::sync::Mutex::new(usage::UsageService::default())),
        updates: std::array::from_fn(|_| tokio::sync::Mutex::new(updates::UpdateService)),
        drag: Mutex::new(None),
        interactive: AtomicBool::new(false),
        quitting: AtomicBool::new(false),
        _lock: lock,
    }));
    for configuration in app.config().app.windows.clone() {
        tauri::WebviewWindowBuilder::from_config(app, &configuration)
            .map_err(err)?
            .on_navigation(|url| {
                (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                    || (["http", "https"].contains(&url.scheme())
                        && url.host_str() == Some("tauri.localhost"))
            })
            .build()
            .map_err(err)?;
    }
    let handle = app.handle().clone();
    app.notification()
        .on_action({
            let handle = handle.clone();
            move |_| open_panel(&handle, Some("agenda"))
        })
        .map_err(err)?;
    let pet = app.get_webview_window("pet").ok_or("Missing pet")?;
    pet.set_ignore_cursor_events(true).map_err(err)?;
    pet.set_always_on_top(initial_settings["alwaysOnTop"].as_bool().unwrap_or(true))
        .map_err(err)?;
    let monitor = pet
        .primary_monitor()
        .map_err(err)?
        .ok_or("Missing monitor")?;
    let area = monitor.work_area();
    let scale = monitor.scale_factor();
    let mut x = f64::from(area.position.x + area.size.width as i32) - 260.0 * scale;
    let mut y = f64::from(area.position.y + area.size.height as i32) - 390.0 * scale;
    if let (Some(px), Some(py)) = (
        initial_settings["positionPhysical"]["x"].as_f64(),
        initial_settings["positionPhysical"]["y"].as_f64(),
    ) {
        x = px;
        y = py;
    } else if let (Some(px), Some(py)) = (
        initial_settings["position"]["x"].as_f64(),
        initial_settings["position"]["y"].as_f64(),
    ) {
        x = px * scale;
        y = py * scale;
    }
    let monitor = pet
        .monitor_from_point(x + 130.0 * scale, y + 145.0 * scale)
        .map_err(err)?
        .unwrap_or(monitor);
    let area = monitor.work_area();
    let (x, y) = clamp_position(
        x,
        y,
        (
            f64::from(area.position.x),
            f64::from(area.position.y),
            f64::from(area.size.width),
            f64::from(area.size.height),
        ),
        monitor.scale_factor(),
    );
    pet.set_position(PhysicalPosition::new(x, y)).map_err(err)?;
    let tray_menu = menu(&handle)?;
    TrayIconBuilder::with_id("deskmate")
        .icon(app.default_window_icon().ok_or("Missing icon")?.clone())
        .tooltip(tr(&handle, "appTitle"))
        .menu(&tray_menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                open_panel(tray.app_handle(), None);
            }
        })
        .build(app)
        .map_err(err)?;
    app.on_menu_event(|app, event| {
        let id = event.id().as_ref().to_string();
        match id.as_str() {
            "open" => open_panel(app, None),
            "agenda" | "settings" => open_panel(app, Some(&id)),
            "show" => {
                if let Some(pet) = app.get_webview_window("pet") {
                    let _ = pet.show();
                }
            }
            "hide" => {
                let _ = end_drag(app);
                if let Some(pet) = app.get_webview_window("pet") {
                    let _ = pet.hide();
                }
            }
            "quit" => {
                runtime(app).quitting.store(true, Ordering::Relaxed);
                app.exit(0);
            }
            _ => {
                let value = if let Some(agent) = id.strip_prefix("agent:") {
                    json!({"agent":agent})
                } else if let Some(mode) = id.strip_prefix("mode:") {
                    json!({"petQuotaDisplay":mode})
                } else {
                    return;
                };
                let _ = settings(app, &value);
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = refresh_usage(&app, false).await;
                });
            }
        }
    });
    pointer_worker(handle.clone());
    tauri::async_runtime::spawn({
        let app = handle.clone();
        async move {
            let _ = sync(&app).await;
            let mut interval = tokio::time::interval(Duration::from_secs(60));
            interval.tick().await;
            loop {
                interval.tick().await;
                if runtime(&app).quitting.load(Ordering::Relaxed) {
                    break;
                }
                let _ = sync(&app).await;
            }
        }
    });
    tauri::async_runtime::spawn({
        let app = handle.clone();
        async move {
            let mut interval = tokio::time::interval(Duration::from_secs(60));
            loop {
                interval.tick().await;
                if runtime(&app).quitting.load(Ordering::Relaxed) {
                    break;
                }
                let _ = refresh_usage(&app, false).await;
            }
        }
    });
    tauri::async_runtime::spawn({
        let app = handle.clone();
        async move {
            let mut interval = tokio::time::interval(Duration::from_secs(1));
            loop {
                interval.tick().await;
                if runtime(&app).quitting.load(Ordering::Relaxed) {
                    break;
                }
                let _ = tick(&app);
            }
        }
    });
    tauri::async_runtime::spawn({
        let app = handle;
        async move {
            let mut interval = tokio::time::interval(Duration::from_secs(6 * 3600));
            loop {
                interval.tick().await;
                if runtime(&app).quitting.load(Ordering::Relaxed) {
                    break;
                }
                for agent in ["codex", "claude"] {
                    let _ = release(&app, &json!({"agent":agent})).await;
                }
            }
        }
    });
    refresh_menu(app.handle())?;
    Ok(())
}
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            open_panel(app, None)
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name("DeskMate")
                .build(),
        )
        .invoke_handler(tauri::generate_handler![assistant_call])
        .setup(|app| {
            setup(app).map_err(|error| {
                app.dialog()
                    .message(&error)
                    .title("桌伴启动失败")
                    .blocking_show();
                Box::<dyn std::error::Error>::from(std::io::Error::other(error))
            })
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                if !window
                    .app_handle()
                    .try_state::<Arc<Runtime>>()
                    .is_some_and(|rt| rt.quitting.load(Ordering::Relaxed))
                {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            tauri::WindowEvent::Focused(false) if window.label() == "pet" => {
                let _ = end_drag(window.app_handle());
            }
            _ => (),
        })
        .build(tauri::generate_context!())
        .expect("Unable to build DeskMate");
    app.run(|app, event| match event {
        tauri::RunEvent::ExitRequested {
            code: None, api, ..
        } => api.prevent_exit(),
        tauri::RunEvent::Resumed => {
            let _ = tick(app);
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = refresh_usage(&app, true).await;
            });
        }
        tauri::RunEvent::Exit => {
            if let Some(rt) = app.try_state::<Arc<Runtime>>() {
                rt.quitting.store(true, Ordering::Relaxed);
                let _ = end_drag(app);
                if let Ok(store) = rt.store.lock() {
                    if let Err(error) = store.backup() {
                        eprintln!("Database backup failed: {error}");
                    }
                }
            }
        }
        _ => (),
    });
}
