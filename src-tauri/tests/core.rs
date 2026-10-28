use deskmate::{agenda, git, store::Store, updates, usage};
use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    process::Command,
    sync::{Arc, Mutex},
};
fn legacy() -> Value {
    json!({"version":1,"agendaVersion":2,"settings":{"agent":"claude","language":"ja","skins":{"claude":"custom"}},"notes":[{"id":"n","date":"2026-10-28","time":"12:34:56","content":"中文 🐉","future":{"keep":true}}],"reminders":[{"id":"r","noteId":"n","title":"中文 🐉","dueAt":"2026-10-28T12:34:56+08:00","repeat":"weekly","enabled":false,"completed":false,"unread":true,"lastFiredAt":null}],"repositories":[{"id":"repo","name":"作者 Ä","path":"offline","identity":{"email":"ä@example.invalid","name":"作者"}}],"skins":[{"id":"custom","name":"test","directory":"offline","states":{"idle":"idle.webp"}}],"futureTop":{"keep":true}})
}
fn commit(hash: u64) -> Value {
    json!({"hash":format!("{hash:040x}"),"date":"2026-10-28T01:00:00+08:00","author":"作者 Ä","email":"Ä@Example.invalid","subject":"100% _ 测试","message":"100% _ 测试\n多行 🐉"})
}
#[test]
fn migration_is_once_atomic_and_preserves_originals() {
    let dir = tempfile::tempdir().unwrap();
    let source = legacy().to_string();
    fs::write(dir.path().join("assistant.json"), &source).unwrap();
    fs::write(
        dir.path().join("git-repo.json"),
        json!([commit(1), commit(2)]).to_string(),
    )
    .unwrap();
    let mut store = Store::open(dir.path()).unwrap();
    let expected = legacy();
    for key in ["notes", "reminders", "skins", "futureTop"] {
        assert_eq!(store.state[key], expected[key]);
    }
    assert_eq!(
        store.state["settings"]["skins"],
        expected["settings"]["skins"]
    );
    assert_eq!(store.query_git(&json!({})).unwrap()["total"], 2);
    assert_eq!(
        fs::read_to_string(dir.path().join("assistant.json")).unwrap(),
        source
    );
    store
        .update(|state| {
            state["notes"][0]["content"] = json!("new DB value");
            Ok(())
        })
        .unwrap();
    drop(store);
    fs::write(dir.path().join("assistant.json"), "{bad").unwrap();
    fs::write(dir.path().join("git-repo.json"), "{bad").unwrap();
    let store = Store::open(dir.path()).unwrap();
    assert_eq!(store.state["notes"][0]["content"], "new DB value");
    assert_eq!(store.query_git(&json!({})).unwrap()["total"], 2);
}
#[test]
fn import_failure_rolls_back_and_retries() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("assistant.json"), legacy().to_string()).unwrap();
    fs::write(
        dir.path().join("git-repo.json"),
        json!([commit(1),{"hash":"invalid"}]).to_string(),
    )
    .unwrap();
    assert!(Store::open(dir.path()).is_err());
    let db = rusqlite::Connection::open(dir.path().join("assistant.sqlite")).unwrap();
    assert_eq!(
        db.query_row("SELECT count(*) FROM notes", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    drop(db);
    fs::write(
        dir.path().join("git-repo.json"),
        json!([commit(1)]).to_string(),
    )
    .unwrap();
    let store = Store::open(dir.path()).unwrap();
    assert_eq!(store.query_git(&json!({})).unwrap()["total"], 1);
}
#[test]
fn database_backup_and_future_version_protection() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path()).unwrap();
    agenda::save_agenda(&mut store,&json!({"date":"2026-10-28","time":"12:34:56","content":"keep me","remind":true,"repeat":"none"})).unwrap();
    store.backup().unwrap();
    drop(store);
    fs::remove_file(dir.path().join("assistant.sqlite")).unwrap();
    let store = Store::open(dir.path()).unwrap();
    assert!(store.recovered);
    assert_eq!(store.state["notes"][0]["content"], "keep me");
    drop(store);
    fs::write(dir.path().join("assistant.sqlite"), "bad db").unwrap();
    let store = Store::open(dir.path()).unwrap();
    assert!(store.recovered);
    assert_eq!(store.state["notes"][0]["content"], "keep me");
    store.conn.execute_batch("PRAGMA user_version=999").unwrap();
    drop(store);
    assert!(Store::open(dir.path())
        .err()
        .unwrap()
        .contains("数据库版本较新"));
}
#[test]
fn agenda_transaction_and_restart_semantics() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path()).unwrap();
    let input = json!({"date":"2026-10-01","time":"12:34:56","content":"task","remind":true,"repeat":"none"});
    let note = agenda::save_agenda(&mut store, &input).unwrap();
    let now = chrono::DateTime::parse_from_rfc3339("2026-10-28T12:00:00Z")
        .unwrap()
        .to_utc();
    assert_eq!(agenda::collect_due(&mut store, now).unwrap().len(), 1);
    let mut input = input;
    input["id"] = note["id"].clone();
    input["content"] = json!("edited");
    agenda::save_agenda(&mut store, &input).unwrap();
    assert!(agenda::collect_due(&mut store, now).unwrap().is_empty());
    let before = store.state.clone();
    assert!(store
        .update(|s| {
            s["settings"]["language"] = json!("en");
            s["notes"] = json!([]);
            Ok(())
        })
        .is_err());
    assert_eq!(store.state, before);
    drop(store);
    let mut store = Store::open(dir.path()).unwrap();
    assert!(agenda::collect_due(&mut store, now).unwrap().is_empty());
    assert_eq!(store.state["reminders"][0]["unread"], true);
    assert_eq!(store.state["notes"][0]["content"], "edited");
}
#[test]
fn sqlite_git_search_pagination_and_archives() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path()).unwrap();
    store
        .update(|s| {
            s["repositories"] = json!([{"id":"repo","path":"offline","name":"repo Ä"}]);
            Ok(())
        })
        .unwrap();
    let records = json!((1..=45).map(commit).collect::<Vec<_>>());
    store
        .save_commits("repo", &records, &json!({"email":"ä@EXAMPLE.invalid"}))
        .unwrap();
    let first = store.query_git(&json!({"query":"100% _"})).unwrap();
    let second = store.query_git(&json!({"page":1})).unwrap();
    assert_eq!(first["total"], 45);
    assert_eq!(
        store.query_git(&json!({"date":"2026-02-30"})).unwrap()["total"],
        0
    );
    assert!(store.query_git(&json!({"page":1e100})).unwrap()["rows"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(first["rows"].as_array().unwrap().len(), 40);
    assert_eq!(second["rows"].as_array().unwrap().len(), 5);
    assert_eq!(store.query_git(&json!({"query":"Ä"})).unwrap()["total"], 45);
    assert_eq!(
        store.query_git(&json!({"query":"' OR 1=1 --"})).unwrap()["total"],
        0
    );
    store.save_commits("repo", &json!([]), &json!({})).unwrap();
    assert_eq!(store.query_git(&json!({})).unwrap()["total"], 0);
    assert_eq!(
        store.query_git(&json!({"mineOnly":false})).unwrap()["total"],
        45
    );
    store
        .update(|s| {
            s["repositories"] = json!([]);
            Ok(())
        })
        .unwrap();
    assert_eq!(
        store
            .conn
            .query_row("SELECT count(*) FROM commits", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        45
    );
}
#[test]
fn node_sqlite_roundtrip_compatibility() {
    let dir = tempfile::tempdir().unwrap();
    let module = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/core/store.cjs");
    let module = serde_json::to_string(&module.to_string_lossy()).unwrap();
    let directory = serde_json::to_string(&dir.path().to_string_lossy()).unwrap();
    let code=format!("const {{Store,saveAgenda}}=require({module});const s=new Store({directory});saveAgenda(s,{{date:'2026-10-28',time:'01:02:03',content:'from Node 🐉',remind:true,repeat:'weekly'}});s.update(v=>v.settings.skins.claude='star-cat');s.close();");
    assert!(Command::new("node")
        .args(["-e", &code])
        .status()
        .unwrap()
        .success());
    let mut store = Store::open(dir.path()).unwrap();
    assert_eq!(store.state["notes"][0]["content"], "from Node 🐉");
    assert_eq!(store.state["settings"]["skins"]["claude"], "star-cat");
    store
        .update(|s| {
            s["notes"][0]["content"] = json!("from Rust 🐉");
            s["reminders"][0]["enabled"] = json!(false);
            Ok(())
        })
        .unwrap();
    drop(store);
    let code=format!("const assert=require('node:assert/strict');const {{Store}}=require({module});const s=new Store({directory});assert.equal(s.state.notes[0].content,'from Rust 🐉');assert.equal(s.state.reminders[0].enabled,false);s.close();");
    assert!(Command::new("node")
        .args(["-e", &code])
        .status()
        .unwrap()
        .success());
}
#[test]
fn usage_and_version_values_preserve_zero_and_missing() {
    assert_eq!(
        usage::tokens_from(&json!({}), "2026-10-28")["today"],
        Value::Null
    );
    assert_eq!(
        usage::tokens_from(
            &json!({"summary":{"lifetimeTokens":0},"dailyUsageBuckets":[{"startDate":"2026-10-28","tokens":0}]}),
            "2026-10-28"
        )["today"],
        json!(0.0)
    );
    assert_eq!(
        usage::windows_from(
            &json!({"rateLimits":{"primary":{"usedPercent":0,"windowDurationMins":300}}})
        )[0]["remainingPercent"],
        json!(100.0)
    );
    assert_eq!(usage::reset_credits_from(&json!({})), Value::Null);
    assert_eq!(updates::newer("rust-v0.200.0", Some("0.199.9")), true);
    assert_eq!(updates::newer("v1.0.0", None), Value::Null);
    assert!(updates::translated_url("https://example.com", "ja").is_err());
}

#[test]
fn claude_logs_deduplicate_and_snapshot_staleness_is_preserved() {
    let directory = tempfile::tempdir().unwrap();
    let projects = directory.path().join("projects");
    fs::create_dir(&projects).unwrap();
    let message = json!({"type":"assistant","timestamp":chrono::Utc::now().to_rfc3339(),"message":{"id":"same","usage":{"input_tokens":50,"output_tokens":10,"cache_read_input_tokens":20}}});
    fs::write(
        projects.join("one.jsonl"),
        format!("{message}\n{message}\n{{unfinished"),
    )
    .unwrap();
    fs::write(projects.join("copy.jsonl"), format!("{message}\n")).unwrap();
    fs::write(directory.path().join("claude-usage.json"),json!({"updatedAt":"2000-01-01T00:00:00Z","rate_limits":{"five_hour":{"used_percentage":0,"resets_at":1900000000}}}).to_string()).unwrap();
    let mut service = usage::UsageService::default();
    let result = service.claude_from(directory.path(), &projects).unwrap();
    assert_eq!(result["tokens"]["total"], json!(80.0));
    assert_eq!(result["windows"][0]["remainingPercent"], json!(100.0));
    assert_eq!(result["stale"], true);
    fs::remove_file(projects.join("one.jsonl")).unwrap();
    fs::remove_file(projects.join("copy.jsonl")).unwrap();
    let result = service.claude_from(directory.path(), &projects).unwrap();
    assert_eq!(result["tokens"]["total"], Value::Null);
    assert_eq!(result["status"], "ok");
}

#[test]
fn imported_artwork_copies_files_and_rejects_directory_escape() {
    let directory = tempfile::tempdir().unwrap();
    let pack = directory.path().join("pack");
    fs::create_dir(&pack).unwrap();
    fs::write(pack.join("idle.webp"), b"fixture").unwrap();
    let manifest = pack.join("skin.json");
    fs::write(
        &manifest,
        json!({"name":"自定义","states":{"idle":"idle.webp"}}).to_string(),
    )
    .unwrap();
    let mut store = Store::open(directory.path().join("data")).unwrap();
    let skin = deskmate::skins::import(&mut store, &manifest).unwrap();
    assert_eq!(store.state["skins"].as_array().unwrap().len(), 1);
    assert!(Path::new(skin["directory"].as_str().unwrap())
        .join("idle.webp")
        .is_file());
    fs::write(directory.path().join("outside.webp"), b"outside").unwrap();
    fs::write(
        &manifest,
        json!({"name":"escape","states":{"idle":"../outside.webp"}}).to_string(),
    )
    .unwrap();
    assert!(deskmate::skins::import(&mut store, &manifest).is_err());
    assert_eq!(store.state["skins"].as_array().unwrap().len(), 1);
}

#[cfg(feature = "desktop")]
#[test]
fn desktop_edges_support_negative_monitors_and_scaling() {
    use deskmate::desktop::clamp_position;
    assert_eq!(
        clamp_position(-500.0, -500.0, (0.0, 0.0, 1920.0, 1040.0), 1.0),
        (-35, -53)
    );
    assert_eq!(
        clamp_position(5000.0, 5000.0, (0.0, 0.0, 1920.0, 1040.0), 1.0),
        (1695, 802)
    );
    assert_eq!(
        clamp_position(-5000.0, 5000.0, (-1280.0, 0.0, 1280.0, 1024.0), 1.0),
        (-1315, 786)
    );
    assert_eq!(
        clamp_position(5000.0, 5000.0, (0.0, 0.0, 3840.0, 2080.0), 2.0),
        (3390, 1604)
    );
}

#[cfg(feature = "desktop")]
#[test]
fn native_statusline_uses_the_same_snapshot_without_launching_windows() {
    use std::io::Write;
    use std::process::Stdio;
    let directory = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_DeskMate"))
        .arg("--claude-statusline")
        .env("DESKMATE_DATA_DIR", directory.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(json!({"rate_limits":{"five_hour":{"used_percentage":0,"resets_at":1900000000}},"secret":"must not persist"}).to_string().as_bytes()).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("5h: 0%"));
    let snapshot: Value =
        serde_json::from_slice(&fs::read(directory.path().join("claude-usage.json")).unwrap())
            .unwrap();
    assert!(snapshot.get("secret").is_none());
    assert_eq!(
        snapshot["rate_limits"]["five_hour"]["used_percentage"],
        json!(0.0)
    );
    assert!(!directory.path().join("assistant.sqlite").exists());
}
#[tokio::test]
async fn real_git_preserves_deleted_branch_history() {
    let root = tempfile::tempdir().unwrap();
    let repo = root.path().join("repo 中文");
    fs::create_dir(&repo).unwrap();
    let run = |args: &[&str]| {
        assert!(Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(args)
            .output()
            .unwrap()
            .status
            .success())
    };
    run(&["init", "-b", "main"]);
    run(&["config", "user.name", "Local"]);
    run(&["config", "user.email", "local@example.invalid"]);
    run(&["commit", "--allow-empty", "-m", "main"]);
    run(&["checkout", "-b", "feature"]);
    run(&["commit", "--allow-empty", "-m", "feature"]);
    run(&["checkout", "main"]);
    let store = Arc::new(Mutex::new(Store::open(root.path().join("data")).unwrap()));
    git::add(&store, &repo).await.unwrap();
    git::sync(&store).await.unwrap();
    run(&["branch", "-D", "feature"]);
    run(&["reflog", "expire", "--expire=now", "--all"]);
    git::sync(&store).await.unwrap();
    assert_eq!(
        store.lock().unwrap().query_git(&json!({})).unwrap()["total"],
        2
    );
}
#[cfg(feature = "test-fixtures")]
#[tokio::test]
async fn codex_stdio_protocol_runs_in_rust() {
    let value = usage::codex_usage(Some(env!("CARGO_BIN_EXE_deskmate-protocol-fixture")))
        .await
        .unwrap();
    assert_eq!(value["status"], "ok");
    assert_eq!(value["windows"][0]["remainingPercent"], json!(64.0));
    assert_eq!(value["tokens"]["today"], json!(123456.0));
    assert_eq!(value["resetCredits"]["availableCount"], json!(2.0));
}
