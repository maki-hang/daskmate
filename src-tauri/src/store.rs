use crate::{err, Result};
use chrono::{DateTime, Local, TimeZone};
use rusqlite::{
    params, params_from_iter, types::Value as Sql, Connection, OptionalExtension,
    TransactionBehavior,
};
use serde_json::{json, Map, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

const TABLES: &[(&str, &[&str])] = &[
    (
        "notes",
        &["date", "time", "content", "createdAt", "updatedAt"],
    ),
    (
        "reminders",
        &[
            "noteId",
            "title",
            "dueAt",
            "repeat",
            "enabled",
            "completed",
            "unread",
            "lastFiredAt",
            "createdAt",
        ],
    ),
    (
        "repositories",
        &["path", "name", "count", "syncedAt", "error", "identity"],
    ),
    (
        "skins",
        &["name", "author", "source", "license", "directory", "states"],
    ),
];
fn is_json(key: &str) -> bool {
    matches!(key, "identity" | "states")
}
fn is_bool(key: &str) -> bool {
    matches!(key, "enabled" | "completed" | "unread")
}
fn sqlite_check(conn: &Connection) -> rusqlite::Result<()> {
    let check: String = conn.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    if check != "ok" {
        return Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(11),
            Some(check),
        ));
    }
    Ok(())
}
fn open_checked(file: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(file)?;
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.execute_batch("PRAGMA foreign_keys=ON;PRAGMA synchronous=FULL;")?;
    sqlite_check(&conn)?;
    Ok(conn)
}
fn restore(file: &Path) -> Result<()> {
    let backup = file.with_extension("sqlite.bak");
    let conn = Connection::open_with_flags(&backup, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| "本地数据库损坏，请保留数据目录并从备份恢复。".to_string())?;
    sqlite_check(&conn).map_err(err)?;
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(err)?;
    let initialized: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM metadata WHERE key='initialized')",
            [],
            |row| row.get(0),
        )
        .map_err(err)?;
    if version != 1 || !initialized {
        return Err("数据库备份无效，请保留数据目录。".into());
    }
    drop(conn);
    if file.exists() {
        fs::copy(
            file,
            file.with_extension(format!(
                "sqlite.damaged-{}",
                chrono::Utc::now().timestamp_micros()
            )),
        )
        .map_err(err)?;
    }
    fs::copy(backup, file).map_err(err)?;
    Ok(())
}
pub fn defaults() -> Value {
    json!({"version":1,"agendaVersion":2,"settings":{"agent":"codex","skins":{},"alwaysOnTop":true,"launchAtLogin":false,"petQuotaDisplay":"always"},"notes":[],"reminders":[],"repositories":[],"skins":[]})
}
pub fn data_directory(base: &Path) -> PathBuf {
    if let Some(value) = std::env::var_os("DESKMATE_DATA_DIR")
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var_os("LONGLING_DATA_DIR").filter(|s| !s.is_empty()))
    {
        let path = PathBuf::from(value);
        return if path.is_absolute() {
            path
        } else {
            std::env::current_dir().unwrap_or_default().join(path)
        };
    }
    let current = base.join("DeskMate");
    let old = base.join("Longling PC Assistant");
    let has = |root: &Path| {
        [
            "assistant.sqlite",
            "assistant.sqlite.bak",
            "assistant.json",
            "assistant.json.bak",
        ]
        .iter()
        .any(|file| root.join(file).exists())
    };
    if !has(&current) && has(&old) {
        old
    } else {
        current
    }
}
pub struct Store {
    pub directory: PathBuf,
    pub conn: Connection,
    pub state: Value,
    pub recovered: bool,
}
impl Store {
    pub fn open(directory: impl AsRef<Path>) -> Result<Self> {
        let directory = directory.as_ref().to_path_buf();
        fs::create_dir_all(&directory).map_err(err)?;
        let file = directory.join("assistant.sqlite");
        let mut recovered = false;
        if !file.exists() && directory.join("assistant.sqlite.bak").exists() {
            restore(&file)?;
            recovered = true;
        }
        let mut conn = match open_checked(&file) {
            Ok(conn) => conn,
            Err(error) => {
                if !matches!(
                    error.sqlite_error_code(),
                    Some(rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase)
                ) {
                    return Err(err(error));
                }
                restore(&file)?;
                recovered = true;
                open_checked(&file).map_err(err)?
            }
        };
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(err)?;
        if version > 1 {
            return Err("数据库版本较新，请使用更新版本的 DeskMate。".into());
        }
        if version == 0 {
            let tx = conn.transaction().map_err(err)?;
            tx.execute_batch(include_str!("schema.sql")).map_err(err)?;
            tx.commit().map_err(err)?;
        }
        conn.create_scalar_function(
            "js_lower",
            1,
            rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC
                | rusqlite::functions::FunctionFlags::SQLITE_UTF8,
            |context| {
                Ok(context
                    .get::<Option<String>>(0)?
                    .unwrap_or_default()
                    .to_lowercase())
            },
        )
        .map_err(err)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        let initialized = tx
            .query_row(
                "SELECT value FROM metadata WHERE key='initialized'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(err)?
            .is_some();
        if !initialized {
            let legacy_file = directory.join("assistant.json");
            let backup = directory.join("assistant.json.bak");
            let mut state = if legacy_file.exists() || backup.exists() {
                match read_legacy(&legacy_file) {
                    Ok(value) => value,
                    Err(error) => {
                        if !backup.exists() {
                            return Err(format!(
                                "旧版数据无法读取，迁移已取消；原文件保持不变。{error}"
                            ));
                        }
                        recovered = true;
                        read_legacy(&backup)?
                    }
                }
            } else {
                defaults()
            };
            upgrade_agenda(&mut state)?;
            write_state(&tx, &json!({}), &state)?;
            for entry in fs::read_dir(&directory).map_err(err)? {
                let entry = entry.map_err(err)?;
                let name = entry.file_name().to_string_lossy().to_string();
                if !entry.file_type().map_err(err)?.is_file()
                    || !name.starts_with("git-")
                    || !name.ends_with(".json")
                {
                    continue;
                }
                let id = &name[4..name.len() - 5];
                let records: Value = serde_json::from_slice(&fs::read(entry.path()).map_err(err)?)
                    .map_err(|e| format!("{}: {e}", entry.path().display()))?;
                let count = put_commits(&tx, id, &records)?;
                tx.execute(
                    "UPDATE repositories SET count=? WHERE id=?",
                    params![count, id],
                )
                .map_err(err)?;
            }
            tx.execute("INSERT INTO metadata VALUES ('initialized','true')", [])
                .map_err(err)?;
        }
        tx.commit().map_err(err)?;
        let state = load_state(&conn)?;
        let store = Self {
            directory,
            conn,
            state,
            recovered,
        };
        store.backup()?;
        Ok(store)
    }
    pub fn update<T>(&mut self, change: impl FnOnce(&mut Value) -> Result<T>) -> Result<T> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        let previous = load_state(&tx)?;
        let mut next = previous.clone();
        let result = change(&mut next)?;
        write_state(&tx, &previous, &next)?;
        tx.commit().map_err(err)?;
        self.state = next;
        Ok(result)
    }
    pub fn backup(&self) -> Result<()> {
        let temporary = self.directory.join("assistant.sqlite.bak.tmp");
        if temporary.exists() {
            fs::remove_file(&temporary).map_err(err)?;
        }
        self.conn
            .execute("VACUUM INTO ?", [temporary.to_string_lossy().as_ref()])
            .map_err(err)?;
        crate::process::replace_file(&temporary, &self.directory.join("assistant.sqlite.bak"))
    }
    pub fn save_commits(&mut self, id: &str, records: &Value, identity: &Value) -> Result<()> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        let previous = load_state(&tx)?;
        let mut next = previous.clone();
        if let Some(repo) = next["repositories"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|repo| repo["id"] == id)
        {
            let count = put_commits(&tx, id, records)?;
            repo["count"] = json!(count);
            repo["identity"] = identity.clone();
            repo["syncedAt"] = json!(crate::now());
            repo["error"] = Value::Null;
            write_state(&tx, &previous, &next)?;
        }
        tx.commit().map_err(err)?;
        self.state = next;
        Ok(())
    }
    pub fn query_git(&self, filter: &Value) -> Result<Value> {
        let mut conditions = Vec::new();
        let mut values = Vec::<Sql>::new();
        if let Some(id) = filter["repoId"].as_str().filter(|s| !s.is_empty()) {
            conditions.push("c.repo_id=?".to_string());
            values.push(Sql::Text(id.into()));
        }
        if filter["mineOnly"].as_bool().unwrap_or(true) {
            conditions.push("((coalesce(json_extract(r.identity,'$.email'),'')<>'' AND c.email_key=js_lower(json_extract(r.identity,'$.email'))) OR (coalesce(json_extract(r.identity,'$.email'),'')='' AND coalesce(json_extract(r.identity,'$.name'),'')<>'' AND c.author=json_extract(r.identity,'$.name')))".into());
        }
        if let Some(date) = filter["date"].as_str().filter(|s| !s.is_empty()) {
            let Ok(day) = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d") else {
                return Ok(json!({"total":0,"rows":[]}));
            };
            if day.format("%Y-%m-%d").to_string() != date {
                return Ok(json!({"total":0,"rows":[]}));
            }
            let start = Local
                .from_local_datetime(&day.and_hms_opt(0, 0, 0).unwrap())
                .earliest()
                .ok_or("日期无效")?;
            let end_day = day.succ_opt().ok_or("日期无效")?;
            let end = Local
                .from_local_datetime(&end_day.and_hms_opt(0, 0, 0).unwrap())
                .earliest()
                .ok_or("日期无效")?;
            conditions.push("c.timestamp>=? AND c.timestamp<?".into());
            values.extend([
                Sql::Integer(start.timestamp_millis()),
                Sql::Integer(end.timestamp_millis()),
            ]);
        }
        let term: String = filter["query"]
            .as_str()
            .unwrap_or("")
            .to_lowercase()
            .chars()
            .take(300)
            .collect();
        if !term.is_empty() {
            conditions.push(format!(
                "({})",
                ["c.message", "c.author", "c.email", "c.hash", "r.name"]
                    .map(|f| format!("instr(js_lower({f}),?)>0"))
                    .join(" OR ")
            ));
            values.extend((0..5).map(|_| Sql::Text(term.clone())));
        }
        let from = format!(
            "FROM commits c JOIN repositories r ON r.id=c.repo_id{}",
            if conditions.is_empty() {
                String::new()
            } else {
                format!(" WHERE {}", conditions.join(" AND "))
            }
        );
        let total: i64 = self
            .conn
            .query_row(
                &format!("SELECT count(*) {from}"),
                params_from_iter(&values),
                |row| row.get(0),
            )
            .map_err(err)?;
        let page = filter["page"].as_f64().unwrap_or(0.0).max(0.0).floor();
        let offset = (page as i64).min(i64::MAX / 40) * 40;
        values.push(Sql::Integer(offset));
        let mut statement = self.conn.prepare(&format!("SELECT c.hash,c.date,c.author,c.email,c.message,c.subject,c.repo_id,r.name,c.extra {from} ORDER BY c.timestamp DESC,c.repo_id,c.hash LIMIT 40 OFFSET ?")).map_err(err)?;
        let rows = statement
            .query_map(params_from_iter(&values), |row| {
                let extra: String = row.get(8)?;
                let mut value: Value = serde_json::from_str(&extra).unwrap_or(json!({}));
                for (index, key) in [
                    "hash",
                    "date",
                    "author",
                    "email",
                    "message",
                    "subject",
                    "repoId",
                    "repository",
                ]
                .iter()
                .enumerate()
                {
                    value[key] = json!(row.get::<_, String>(index)?);
                }
                Ok(value)
            })
            .map_err(err)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(err)?;
        Ok(json!({"total":total,"rows":rows}))
    }
}
fn read_legacy(file: &Path) -> Result<Value> {
    let value: Value = serde_json::from_slice(&fs::read(file).map_err(err)?).map_err(err)?;
    if value["version"] != 1 || TABLES.iter().any(|(key, _)| !value[key].is_array()) {
        return Err("数据格式无效".into());
    }
    let missing_agenda_version = value.get("agendaVersion").is_none();
    let mut state = defaults();
    for (key, value) in value.as_object().ok_or("数据格式无效")? {
        if key == "settings" {
            for (key, value) in value.as_object().ok_or("数据格式无效")? {
                state["settings"][key] = value.clone();
            }
        } else {
            state[key] = value.clone();
        }
    }
    // defaults represent a new store; an omitted legacy version still needs upgrading.
    if missing_agenda_version {
        state["agendaVersion"] = Value::Null;
    }
    Ok(state)
}
fn upgrade_agenda(state: &mut Value) -> Result<()> {
    if state["agendaVersion"] == 2 {
        return Ok(());
    }
    for note in state["notes"].as_array_mut().unwrap() {
        if note["time"].as_str().unwrap_or("").is_empty() {
            note["time"] = json!("00:00:00");
        }
    }
    for index in 0..state["reminders"].as_array().unwrap().len() {
        let reminder = state["reminders"][index].clone();
        if reminder["noteId"].is_string()
            && state["notes"]
                .as_array()
                .unwrap()
                .iter()
                .any(|note| note["id"] == reminder["noteId"])
        {
            continue;
        }
        let due = DateTime::parse_from_rfc3339(reminder["dueAt"].as_str().ok_or("提醒时间无效")?)
            .map_err(err)?
            .with_timezone(&Local);
        let id = uuid::Uuid::new_v4().to_string();
        state["notes"].as_array_mut().unwrap().push(json!({"id":id,"date":due.format("%Y-%m-%d").to_string(),"time":due.format("%H:%M:%S").to_string(),"content":reminder["title"],"createdAt":reminder["createdAt"],"updatedAt":reminder.get("createdAt").cloned().unwrap_or(json!(due.to_rfc3339()))}));
        state["reminders"][index]["noteId"] = json!(id);
    }
    state["agendaVersion"] = json!(2);
    Ok(())
}
fn load_state(conn: &Connection) -> Result<Value> {
    let mut state = json!({});
    for table in ["metadata", "settings"] {
        let mut statement = conn
            .prepare(&format!(
                "SELECT key,value FROM {table} WHERE key<>'initialized'"
            ))
            .map_err(err)?;
        let entries = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(err)?;
        if table == "settings" {
            state["settings"] = json!({});
        }
        for entry in entries {
            let (key, value) = entry.map_err(err)?;
            let decoded = serde_json::from_str(&value).map_err(err)?;
            if table == "settings" {
                state["settings"][key] = decoded;
            } else {
                state[key] = decoded;
            }
        }
    }
    for (table, columns) in TABLES {
        let mut statement = conn
            .prepare(&format!(
                "SELECT id,extra,{} FROM {table} ORDER BY position",
                columns
                    .iter()
                    .map(|s| format!("\"{s}\""))
                    .collect::<Vec<_>>()
                    .join(",")
            ))
            .map_err(err)?;
        let rows = statement
            .query_map([], |row| {
                let extra: String = row.get(1)?;
                let mut value: Value = serde_json::from_str(&extra).unwrap_or(json!({}));
                value["id"] = json!(row.get::<_, String>(0)?);
                for (index, key) in columns.iter().enumerate() {
                    let field: Sql = row.get(index + 2)?;
                    if field == Sql::Null {
                        continue;
                    }
                    value[key] = if is_bool(key) {
                        json!(row.get::<_, i64>(index + 2)? != 0)
                    } else if *key == "count" {
                        json!(row.get::<_, i64>(index + 2)?)
                    } else {
                        let text: String = row.get(index + 2)?;
                        if is_json(key) {
                            serde_json::from_str(&text).unwrap_or(Value::Null)
                        } else {
                            json!(text)
                        }
                    };
                }
                Ok(value)
            })
            .map_err(err)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(err)?;
        state[table] = json!(rows);
    }
    Ok(state)
}
fn metadata(state: &Value) -> Map<String, Value> {
    state
        .as_object()
        .map(|m| {
            m.iter()
                .filter(|(key, _)| {
                    key.as_str() != "settings"
                        && key.as_str() != "initialized"
                        && !TABLES.iter().any(|(table, _)| *table == key.as_str())
                })
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect()
        })
        .unwrap_or_default()
}
fn write_state(conn: &Connection, previous: &Value, next: &Value) -> Result<()> {
    for table in ["metadata", "settings"] {
        let before = if table == "metadata" {
            metadata(previous)
        } else {
            previous["settings"]
                .as_object()
                .cloned()
                .unwrap_or_default()
        };
        let after = if table == "metadata" {
            metadata(next)
        } else {
            next["settings"]
                .as_object()
                .cloned()
                .ok_or("Invalid settings")?
        };
        for key in before.keys().filter(|key| !after.contains_key(*key)) {
            conn.execute(&format!("DELETE FROM {table} WHERE key=?"), [key])
                .map_err(err)?;
        }
        for (key, value) in &after {
            if before.get(key) != Some(value) {
                conn.execute(&format!("INSERT INTO {table}(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"), params![key,value.to_string()]).map_err(err)?;
            }
        }
    }
    for (table, columns) in TABLES {
        let before = previous[table].as_array().cloned().unwrap_or_default();
        let after = next[table].as_array().ok_or("Invalid records")?;
        let old: HashMap<&str, (usize, &Value)> = before
            .iter()
            .enumerate()
            .filter_map(|(i, v)| v["id"].as_str().map(|id| (id, (i, v))))
            .collect();
        let ids: HashSet<&str> = after
            .iter()
            .map(|v| {
                v["id"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .ok_or("Invalid record id")
            })
            .collect::<std::result::Result<_, _>>()?;
        if ids.len() != after.len() {
            return Err("Duplicate record id".into());
        }
        for id in old.keys().filter(|id| !ids.contains(*id)) {
            conn.execute(&format!("DELETE FROM {table} WHERE id=?"), [id])
                .map_err(err)?;
        }
        let fields: Vec<&str> = [vec!["id", "position"], columns.to_vec(), vec!["extra"]].concat();
        let sql = format!(
            "INSERT INTO {table}({}) VALUES ({}) ON CONFLICT(id) DO UPDATE SET {}",
            fields
                .iter()
                .map(|f| format!("\"{f}\""))
                .collect::<Vec<_>>()
                .join(","),
            vec!["?"; fields.len()].join(","),
            fields
                .iter()
                .skip(1)
                .map(|f| format!("\"{f}\"=excluded.\"{f}\""))
                .collect::<Vec<_>>()
                .join(",")
        );
        let mut statement = conn.prepare(&sql).map_err(err)?;
        for (position, row) in after.iter().enumerate() {
            let id = row["id"].as_str().unwrap();
            if old
                .get(id)
                .is_some_and(|(i, v)| *i == position && *v == row)
            {
                continue;
            }
            let mut values = vec![Sql::Text(id.into()), Sql::Integer(position as i64)];
            for key in *columns {
                let value = &row[key];
                values.push(if value.is_null() {
                    Sql::Null
                } else if is_bool(key) {
                    Sql::Integer(i64::from(value.as_bool().ok_or("Invalid boolean")?))
                } else if *key == "count" {
                    Sql::Integer(value.as_i64().ok_or("Invalid count")?)
                } else if is_json(key) {
                    Sql::Text(value.to_string())
                } else {
                    Sql::Text(value.as_str().ok_or("Invalid text field")?.into())
                });
            }
            let extra: Map<_, _> = row
                .as_object()
                .unwrap()
                .iter()
                .filter(|(key, value)| {
                    key.as_str() != "id" && (!columns.contains(&key.as_str()) || value.is_null())
                })
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            values.push(Sql::Text(Value::Object(extra).to_string()));
            statement.execute(params_from_iter(values)).map_err(err)?;
        }
    }
    Ok(())
}
fn put_commits(conn: &Connection, id: &str, records: &Value) -> Result<i64> {
    let records = records.as_array().ok_or("Invalid Git archive")?;
    conn.execute("INSERT OR IGNORE INTO git_archives VALUES (?)", [id])
        .map_err(err)?;
    let mut statement = conn.prepare("INSERT INTO commits(repo_id,hash,date,timestamp,author,email,email_key,message,subject,extra) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(repo_id,hash) DO UPDATE SET date=excluded.date,timestamp=excluded.timestamp,author=excluded.author,email=excluded.email,email_key=excluded.email_key,message=excluded.message,subject=excluded.subject,extra=excluded.extra WHERE commits.date<>excluded.date OR commits.author<>excluded.author OR commits.email<>excluded.email OR commits.message<>excluded.message OR commits.subject<>excluded.subject OR commits.extra<>excluded.extra").map_err(err)?;
    for record in records {
        let get = |key: &str| {
            record[key]
                .as_str()
                .ok_or_else(|| format!("Invalid Git commit {key}"))
        };
        let hash = get("hash")?;
        if !(40..=64).contains(&hash.len())
            || !hash
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return Err("Invalid Git commit hash".into());
        }
        let date = get("date")?;
        let timestamp = DateTime::parse_from_rfc3339(date)
            .map_err(err)?
            .timestamp_millis();
        let extra: Map<_, _> = record
            .as_object()
            .unwrap()
            .iter()
            .filter(|(key, _)| {
                !["hash", "date", "author", "email", "message", "subject"].contains(&key.as_str())
            })
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        statement
            .execute(params![
                id,
                hash,
                date,
                timestamp,
                get("author")?,
                get("email")?,
                get("email")?.to_lowercase(),
                get("message")?,
                get("subject")?,
                Value::Object(extra).to_string()
            ])
            .map_err(err)?;
    }
    conn.query_row(
        "SELECT count(*) FROM commits WHERE repo_id=?",
        [id],
        |row| row.get(0),
    )
    .map_err(err)
}
