use crate::{err, now, process, Result};
use chrono::{DateTime, Local, TimeZone, Utc};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, SystemTime},
};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};

pub fn agents() -> Value {
    json!([{"id":"codex","name":"Codex","description":"账户额度 · 官方本地接口"},{"id":"claude","name":"Claude Code","description":"本地 Token · 可接状态行额度"}])
}
fn seconds(value: &Value) -> Value {
    value
        .as_f64()
        .and_then(|n| Utc.timestamp_millis_opt((n * 1000.0) as i64).single())
        .map(|date| json!(date.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)))
        .unwrap_or(Value::Null)
}
pub fn windows_from(data: &Value) -> Value {
    let groups: Vec<(String, Value)> = data["rateLimitsByLimitId"]
        .as_object()
        .filter(|m| !m.is_empty())
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_else(|| vec![("codex".into(), data["rateLimits"].clone())]);
    let mut windows = Vec::new();
    for (id, bucket) in groups {
        for key in ["primary", "secondary"] {
            let window = &bucket[key];
            let Some(used) = window["usedPercent"].as_f64() else {
                continue;
            };
            let minutes = window["windowDurationMins"].as_i64();
            let duration = match minutes {
                Some(n) if n > 0 && n % 1440 == 0 => format!("{} 天", n / 1440),
                Some(n) if n > 0 && n % 60 == 0 => format!("{} 小时", n / 60),
                Some(n) if n > 0 => format!("{n} 分钟"),
                _ => {
                    if key == "primary" {
                        "当前窗口".into()
                    } else {
                        "长期窗口".into()
                    }
                }
            };
            let label = bucket["limitName"].as_str().unwrap_or(&id);
            windows.push(json!({"id":format!("{id}-{key}"),"bucket":label,"minutes":minutes,"label":format!("{label} · {duration}"),"usedPercent":used.clamp(0.0,100.0),"remainingPercent":(100.0-used).clamp(0.0,100.0),"resetsAt":seconds(&window["resetsAt"])}));
        }
    }
    json!(windows)
}
pub fn reset_credits_from(data: &Value) -> Value {
    let credits = &data["rateLimitResetCredits"];
    let Some(count) = credits["availableCount"].as_f64() else {
        return Value::Null;
    };
    let details = credits["credits"].as_array().map(|values| {
        json!(values
            .iter()
            .map(
                |c| json!({"id":c["id"],"status":c["status"],"expiresAt":seconds(&c["expiresAt"])})
            )
            .collect::<Vec<_>>())
    });
    json!({"availableCount":count.max(0.0),"credits":details})
}
pub fn tokens_from(data: &Value, day: &str) -> Value {
    let valid = |v: &Value| {
        v.as_f64()
            .filter(|v| *v >= 0.0)
            .map(|v| json!(v))
            .unwrap_or(Value::Null)
    };
    let today = data["dailyUsageBuckets"]
        .as_array()
        .and_then(|b| b.iter().find(|b| b["startDate"] == day))
        .map(|b| valid(&b["tokens"]))
        .unwrap_or(Value::Null);
    json!({"total":valid(&data["summary"]["lifetimeTokens"]),"today":today,"peak":valid(&data["summary"]["peakDailyTokens"]),"source":"account","daily":data["dailyUsageBuckets"].as_array()})
}
pub async fn find_codex(custom: Option<&str>) -> Result<PathBuf> {
    if let Some(custom) = custom.filter(|s| !s.is_empty()) {
        let path = PathBuf::from(custom);
        if path.is_file() {
            return Ok(path);
        }
        return Err("无法启动 Codex CLI，请检查可执行文件。".into());
    }
    let program = if cfg!(windows) { "where.exe" } else { "which" };
    let target = if cfg!(windows) { "codex.exe" } else { "codex" };
    if let Ok(output) = process::output(
        process::command(program).arg(target),
        Duration::from_secs(5),
        1024 * 1024,
    )
    .await
    {
        if let Some(path) = output.lines().next().filter(|s| !s.is_empty()) {
            return Ok(PathBuf::from(path));
        }
    }
    if cfg!(windows) {
        let root = PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap_or_default())
            .join("OpenAI/Codex/bin");
        let mut files = Vec::new();
        if let Ok(entries) = fs::read_dir(root) {
            for entry in entries.flatten() {
                let file = entry.path().join("codex.exe");
                if let Ok(meta) = fs::metadata(&file) {
                    files.push((meta.modified().unwrap_or(SystemTime::UNIX_EPOCH), file));
                }
            }
        }
        files.sort_by_key(|entry| std::cmp::Reverse(entry.0));
        if let Some((_, file)) = files.into_iter().next() {
            return Ok(file);
        }
    }
    Err("未找到 Codex CLI。请安装并登录 Codex，或在设置中选择 codex 可执行文件。".into())
}
async fn send(input: &mut tokio::process::ChildStdin, value: Value) -> Result<()> {
    input
        .write_all(format!("{value}\n").as_bytes())
        .await
        .map_err(|_| "Codex 接口提前关闭".to_string())
}
pub async fn codex_usage(custom: Option<&str>) -> Result<Value> {
    let executable = find_codex(custom).await?;
    let mut child = process::spawn(
        process::command(executable)
            .args(["app-server", "--listen", "stdio://"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null()),
    )
    .map_err(|_| "无法启动 Codex CLI，请检查可执行文件。")?;
    let mut input = child.stdin.take().unwrap();
    let mut reader = tokio::io::BufReader::new(child.stdout.take().unwrap().take(4 * 1024 * 1024));
    send(&mut input,json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"deskmate_pc_assistant","title":"DeskMate","version":env!("CARGO_PKG_VERSION")},"capabilities":{}}})).await?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(25);
    let mut limits = None;
    let mut token_data = Value::Null;
    let mut tokens_done = false;
    loop {
        let mut line = String::new();
        match tokio::time::timeout_at(deadline, reader.read_line(&mut line)).await {
            Err(_) if limits.is_some() => break,
            Err(_) => return Err("usageTimeout".into()),
            Ok(Err(_)) => return Err("usageUnavailable".into()),
            Ok(Ok(0)) if limits.is_some() => break,
            Ok(Ok(0)) => return Err("Codex 接口提前关闭，请检查 Codex 登录与配置。".into()),
            _ => (),
        }
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match message["id"].as_i64() {
            Some(1) => {
                if !message["error"].is_null() {
                    return Err("当前 Codex 版本不支持初始化，请更新 Codex。".into());
                }
                send(&mut input, json!({"method":"initialized"})).await?;
                send(
                    &mut input,
                    json!({"id":2,"method":"account/rateLimits/read"}),
                )
                .await?;
                send(&mut input, json!({"id":3,"method":"account/usage/read"})).await?;
            }
            Some(2) => {
                if !message["error"].is_null() || !message["result"].is_object() {
                    return Err("usageUnavailable".into());
                }
                limits = Some(message["result"].clone());
            }
            Some(3) => {
                tokens_done = true;
                if message["error"].is_null() {
                    token_data = message["result"].clone();
                }
            }
            _ => (),
        }
        if limits.is_some() && tokens_done {
            break;
        }
    }
    let _ = child.kill().await;
    let data = limits.ok_or("usageUnavailable")?;
    Ok(
        json!({"agent":"codex","status":"ok","source":"account","updatedAt":now(),"windows":windows_from(&data),"resetCredits":reset_credits_from(&data),"tokens":tokens_from(&token_data,&Local::now().format("%Y-%m-%d").to_string()),"plan":data["rateLimits"]["planType"]}),
    )
}

pub fn statusline() {
    use std::io::Read;
    let result: Result<Vec<String>> = (|| {
        let mut input = String::new();
        std::io::stdin()
            .take(1024 * 1024 + 1)
            .read_to_string(&mut input)
            .map_err(err)?;
        if input.len() > 1024 * 1024 {
            return Err("Input too large".into());
        }
        let value: Value = serde_json::from_str(&input).map_err(err)?;
        let mut limits = json!({});
        let mut labels = Vec::new();
        for (key, label) in [("five_hour", "5h"), ("seven_day", "7d")] {
            if let Some(used) = value["rate_limits"][key]["used_percentage"].as_f64() {
                let used = used.clamp(0.0, 100.0);
                limits[key] = json!({"used_percentage":used,"resets_at":value["rate_limits"][key]["resets_at"].as_f64()});
                labels.push(format!("{label}: {used:.0}%"));
            }
        }
        let directory =
            crate::store::data_directory(&dirs::config_dir().ok_or("无法定位本地数据目录")?);
        fs::create_dir_all(&directory).map_err(err)?;
        let temporary = directory.join(format!("claude-usage.{}.tmp", std::process::id()));
        fs::write(
            &temporary,
            json!({"updatedAt":now(),"rate_limits":limits}).to_string(),
        )
        .map_err(err)?;
        process::replace_file(&temporary, &directory.join("claude-usage.json"))?;
        Ok(labels)
    })();
    println!(
        "{}",
        match result {
            Ok(labels) if !labels.is_empty() => labels.join(" | "),
            Ok(_) => "桌伴 · 额度暂不可用".into(),
            Err(_) => "桌伴 · 等待额度数据".into(),
        }
    );
}
struct ClaudeLog {
    modified: SystemTime,
    length: u64,
    records: HashMap<String, (f64, String)>,
}
#[derive(Default)]
pub struct UsageService {
    cache: Option<Value>,
    files: HashMap<PathBuf, ClaudeLog>,
}
impl UsageService {
    pub async fn read(
        &mut self,
        agent: &str,
        custom: Option<&str>,
        directory: &Path,
        force: bool,
    ) -> Value {
        if !force {
            if let Some(cache) = &self.cache {
                if Utc::now().timestamp_millis() - cache["checkedAt"].as_i64().unwrap_or(0) < 60000
                {
                    return cache.clone();
                }
            }
        }
        let result = if agent == "codex" {
            codex_usage(custom).await
        } else {
            self.claude(directory)
        };
        let mut result=result.unwrap_or_else(|error|json!({"agent":agent,"status":"unavailable","windows":[],"source":if agent=="codex"{"Codex 官方本地接口"}else{"Claude 本地数据"},"message":error,"updatedAt":null}));
        result["checkedAt"] = json!(Utc::now().timestamp_millis());
        self.cache = Some(result.clone());
        result
    }
    pub fn claude(&mut self, directory: &Path) -> Result<Value> {
        let root = std::env::var_os("CLAUDE_CONFIG_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".claude"))
            .join("projects");
        self.claude_from(directory, &root)
    }
    pub fn claude_from(&mut self, directory: &Path, root: &Path) -> Result<Value> {
        let files: Vec<_> = walkdir::WalkDir::new(root)
            .follow_links(false)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_type().is_file() && e.path().extension().is_some_and(|e| e == "jsonl")
            })
            .map(|e| e.into_path())
            .collect();
        self.files.retain(|key, _| files.contains(key));
        for file in &files {
            let meta = fs::metadata(file).map_err(err)?;
            let modified = meta.modified().map_err(err)?;
            if self
                .files
                .get(file)
                .is_some_and(|log| log.modified == modified && log.length == meta.len())
            {
                continue;
            }
            let mut records = HashMap::<String, (f64, String)>::new();
            for line in BufReader::new(fs::File::open(file).map_err(err)?)
                .lines()
                .map_while(std::result::Result::ok)
            {
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if value["type"] != "assistant" || !value["message"]["usage"].is_object() {
                    continue;
                }
                let Some(key) = value["message"]["id"]
                    .as_str()
                    .or_else(|| value["uuid"].as_str())
                else {
                    continue;
                };
                let usage = &value["message"]["usage"];
                let tokens = [
                    "input_tokens",
                    "output_tokens",
                    "cache_creation_input_tokens",
                    "cache_read_input_tokens",
                ]
                .iter()
                .map(|k| usage[k].as_f64().unwrap_or(0.0))
                .sum::<f64>();
                if !records.get(key).is_some_and(|r| r.0 > tokens) {
                    records.insert(
                        key.into(),
                        (tokens, value["timestamp"].as_str().unwrap_or("").into()),
                    );
                }
            }
            self.files.insert(
                file.clone(),
                ClaudeLog {
                    modified,
                    length: meta.len(),
                    records,
                },
            );
        }
        let mut messages = HashMap::<String, (f64, String)>::new();
        for log in self.files.values() {
            for (key, record) in &log.records {
                if !messages.get(key).is_some_and(|r| r.0 >= record.0) {
                    messages.insert(key.clone(), record.clone());
                }
            }
        }
        let day = Local::now().date_naive();
        let mut total = 0.0;
        let mut today = 0.0;
        for (tokens, at) in messages.values() {
            total += tokens;
            if DateTime::parse_from_rfc3339(at)
                .is_ok_and(|date| date.with_timezone(&Local).date_naive() == day)
            {
                today += tokens;
            }
        }
        let snapshot = fs::read(directory.join("claude-usage.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
        let mut windows = Vec::new();
        if let Some(snapshot) = &snapshot {
            for (key, label, minutes) in
                [("five_hour", "5 小时", 300), ("seven_day", "7 天", 10080)]
            {
                let w = &snapshot["rate_limits"][key];
                if let Some(used) = w["used_percentage"].as_f64() {
                    windows.push(json!({"id":key,"label":label,"minutes":minutes,"usedPercent":used.clamp(0.0,100.0),"remainingPercent":(100.0-used).clamp(0.0,100.0),"resetsAt":seconds(&w["resets_at"])}));
                }
            }
        }
        let stale = snapshot.as_ref().is_some_and(|s| {
            s["updatedAt"]
                .as_str()
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                .is_none_or(|date| Utc::now().signed_duration_since(date).num_seconds() > 600)
                || windows.iter().any(|w| {
                    w["resetsAt"]
                        .as_str()
                        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                        .is_some_and(|date| date < Utc::now())
                })
        });
        Ok(
            json!({"agent":"claude","status":if files.is_empty()&&snapshot.is_none(){"unavailable"}else{"ok"},"stale":stale,"source":if snapshot.is_some(){"Claude Code 本地日志 + 状态行快照"}else{"Claude Code 本地日志"},"updatedAt":snapshot.as_ref().and_then(|s|s.get("updatedAt")).cloned().unwrap_or_else(||if files.is_empty(){Value::Null}else{json!(now())}),"windows":windows,"tokens":{"today":if files.is_empty(){Value::Null}else{json!(today)},"total":if files.is_empty(){Value::Null}else{json!(total)},"source":"local"},"message":if windows.is_empty(){"订阅额度尚未接入。可在设置中查看状态行接入说明；Token 来自本机日志，含缓存。"}else{"额度为最近一次 Claude 状态行快照，非主动联网查询。"}}),
        )
    }
}
