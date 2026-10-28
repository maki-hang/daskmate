use crate::{err, process, store::Store, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

async fn git(directory: &Path, args: &[&str]) -> Result<String> {
    let mut command = process::command("git");
    command
        .args(["-c", "core.quotepath=false", "-C"])
        .arg(directory)
        .args(args);
    process::output(&mut command, Duration::from_secs(30), 32 * 1024 * 1024)
        .await
        .map(|s| s.trim().into())
}
pub fn discover(root: &Path) -> Value {
    let mut found = Vec::new();
    let mut warnings = Vec::new();
    let walker = walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            entry.depth() == 0
                || ![
                    ".git",
                    "node_modules",
                    "$RECYCLE.BIN",
                    "System Volume Information",
                    ".venv",
                    "venv",
                ]
                .contains(&entry.file_name().to_string_lossy().as_ref())
        });
    for entry in walker {
        match entry {
            Ok(entry) if entry.file_type().is_dir() => {
                let path = entry.path();
                if path.join(".git").exists()
                    || (path.join("HEAD").exists() && path.join("objects").is_dir())
                {
                    found.push(path.to_string_lossy().to_string());
                }
            }
            Err(error) => warnings.push(error.path().unwrap_or(root).to_string_lossy().to_string()),
            _ => (),
        }
    }
    json!({"found":found,"warnings":warnings})
}
pub fn repository_id(root: &Path) -> String {
    let mut path = root
        .to_string_lossy()
        .trim_start_matches("\\\\?\\")
        .to_string();
    if cfg!(windows) {
        path = path.to_lowercase();
    }
    format!("{:x}", Sha256::digest(path.as_bytes()))[..20].into()
}
pub async fn add(store: &Arc<Mutex<Store>>, directory: &Path) -> Result<String> {
    let bare = git(directory, &["rev-parse", "--is-bare-repository"]).await?;
    let root = if bare == "true" {
        directory.to_path_buf()
    } else {
        PathBuf::from(git(directory, &["rev-parse", "--show-toplevel"]).await?)
    };
    let root = std::fs::canonicalize(root).map_err(err)?;
    let root = PathBuf::from(
        root.to_string_lossy()
            .trim_start_matches("\\\\?\\")
            .to_string(),
    );
    let id = repository_id(&root);
    store.lock().map_err(err)?.update(|state| {
        let repos=state["repositories"].as_array_mut().unwrap();
        if !repos.iter().any(|r|r["id"]==id) { repos.push(json!({"id":id,"path":root.to_string_lossy(),"name":root.file_name().unwrap_or_default().to_string_lossy(),"count":0,"syncedAt":null})); } Ok(())
    })?;
    Ok(id)
}
pub fn parse_commits(output: &str) -> Value {
    let fields: Vec<_> = output.split('\0').collect();
    let mut records = Vec::new();
    for chunk in fields.as_chunks::<5>().0 {
        let hash = chunk[0].trim();
        if !(40..=64).contains(&hash.len()) || !hash.bytes().all(|c| c.is_ascii_hexdigit()) {
            continue;
        }
        records.push(json!({"hash":hash,"date":chunk[1],"author":chunk[2],"email":chunk[3],"message":chunk[4].trim_end(),"subject":chunk[4].split('\n').next().unwrap_or("")}));
    }
    json!(records)
}
pub async fn sync(store: &Arc<Mutex<Store>>) -> Result<()> {
    let repos = store.lock().map_err(err)?.state["repositories"]
        .as_array()
        .unwrap()
        .clone();
    for repo in repos {
        let id = repo["id"].as_str().ok_or("Invalid repository")?;
        let path = Path::new(repo["path"].as_str().ok_or("Invalid repository path")?);
        let result: Result<()> = async {
            let email = git(path, &["config", "user.email"])
                .await
                .unwrap_or_default();
            let name = git(path, &["config", "user.name"])
                .await
                .unwrap_or_default();
            let mut command = process::command("git");
            command.arg("-C").arg(path).args([
                "log",
                "--all",
                "--reflog",
                "--date-order",
                "--format=%H%x00%aI%x00%an%x00%ae%x00%B%x00",
            ]);
            let output =
                process::output(&mut command, Duration::from_secs(180), 256 * 1024 * 1024).await?;
            store.lock().map_err(err)?.save_commits(
                id,
                &parse_commits(&output),
                &json!({"email":email,"name":name}),
            )
        }
        .await;
        if let Err(error) = result {
            store.lock().map_err(err)?.update(|state| {
                if let Some(repo) = state["repositories"]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .find(|r| r["id"] == id)
                {
                    repo["error"] = json!(error.chars().take(300).collect::<String>());
                }
                Ok(())
            })?;
        }
    }
    Ok(())
}
