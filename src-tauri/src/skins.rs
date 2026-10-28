use crate::{err, store::Store, Result};
use serde_json::{json, Value};
use std::{fs, path::Path};
pub fn all(store: &Store, assets: &Path) -> Result<Value> {
    let catalog: Value =
        serde_json::from_slice(&fs::read(assets.join("catalog.json")).map_err(err)?)
            .map_err(err)?;
    let mut skins = Vec::new();
    for id in catalog["skins"]
        .as_array()
        .ok_or("Invalid artwork catalog")?
    {
        let id = id.as_str().ok_or("Invalid artwork id")?;
        let directory = assets.join(id);
        let mut skin: Value =
            serde_json::from_slice(&fs::read(directory.join("skin.json")).map_err(err)?)
                .map_err(err)?;
        skin["id"] = json!(id);
        skin["directory"] = json!(directory.to_string_lossy());
        skins.push(skin);
    }
    skins.extend(store.state["skins"].as_array().unwrap().iter().cloned());
    for skin in &mut skins {
        let directory = skin["directory"]
            .as_str()
            .ok_or("Invalid skin directory")?
            .to_string();
        for file in skin["states"]
            .as_object_mut()
            .ok_or("Invalid skin states")?
            .values_mut()
        {
            let relative = file.as_str().ok_or("Invalid skin asset")?;
            *file = json!(Path::new(&directory).join(relative).to_string_lossy());
        }
    }
    Ok(json!(skins))
}
pub fn import(store: &mut Store, manifest: &Path) -> Result<Value> {
    let value: Value = serde_json::from_slice(&fs::read(manifest).map_err(err)?).map_err(err)?;
    let name = value["name"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or("资源包需要 name 和 states.idle。")?;
    if !value["states"]["idle"].is_string() {
        return Err("资源包需要 name 和 states.idle。".into());
    }
    let root = fs::canonicalize(manifest.parent().ok_or("Invalid manifest path")?).map_err(err)?;
    let mut files = Vec::new();
    let mut states = json!({});
    for (key, file) in value["states"].as_object().ok_or("Invalid skin states")? {
        if !["idle", "happy", "attention", "error", "reminder", "working"].contains(&key.as_str()) {
            continue;
        }
        let source = fs::canonicalize(root.join(file.as_str().ok_or("Invalid animation path")?))
            .map_err(err)?;
        if !source.starts_with(&root) {
            return Err("动画文件必须位于资源包目录内。".into());
        }
        let extension = source
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();
        if !["gif", "webp", "png", "apng"].contains(&extension.as_str()) {
            return Err("动画支持 GIF、WebP、PNG、APNG。".into());
        }
        let meta = fs::metadata(&source).map_err(err)?;
        if !meta.is_file() || meta.len() > 20 * 1024 * 1024 {
            return Err("单个动画文件须小于 20 MB。".into());
        }
        let target = format!("{key}.{extension}");
        states[key] = json!(target);
        files.push((source, target));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let directory = store.directory.join("skins").join(&id);
    fs::create_dir_all(&directory).map_err(err)?;
    let result = (|| {
        for (source, target) in files {
            fs::copy(source, directory.join(target)).map_err(err)?;
        }
        let trim = |key: &str, default: &str, max: usize| {
            value[key]
                .as_str()
                .unwrap_or(default)
                .chars()
                .take(max)
                .collect::<String>()
        };
        let skin = json!({"id":id,"name":name.trim().chars().take(60).collect::<String>(),"author":trim("author","自定义",100),"source":trim("source","",500),"license":trim("license","",200),"states":states,"directory":directory.to_string_lossy()});
        fs::write(directory.join("skin.json"), skin.to_string()).map_err(err)?;
        store.update(|s| {
            s["skins"].as_array_mut().unwrap().push(skin.clone());
            Ok(())
        })?;
        Ok(skin)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&directory);
    }
    result
}
