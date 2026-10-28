use crate::{err, now, process, usage, Result};
use serde_json::{json, Value};
use std::{path::Path, time::Duration};
pub fn repository(agent: &str) -> Result<&'static str> {
    match agent {
        "codex" => Ok("openai/codex"),
        "claude" => Ok("anthropics/claude-code"),
        _ => Err("unknownAgent".into()),
    }
}
fn version(value: &str) -> Option<semver::Version> {
    let start = value.find(|c: char| c.is_ascii_digit())?;
    let value = &value[start..];
    let end = value
        .find(|c: char| !c.is_ascii_alphanumeric() && !['.', '-', '+'].contains(&c))
        .unwrap_or(value.len());
    semver::Version::parse(&value[..end]).ok()
}
pub fn newer(latest: &str, installed: Option<&str>) -> Value {
    match (version(latest), installed.and_then(version)) {
        (Some(a), Some(b)) => json!(a > b),
        _ => Value::Null,
    }
}
pub fn translated_url(raw: &str, language: &str) -> Result<String> {
    let parsed = url::Url::parse(raw).map_err(err)?;
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("github.com")
        || ![
            "/openai/codex/releases/tag/",
            "/anthropics/claude-code/releases/tag/",
        ]
        .iter()
        .any(|p| parsed.path().starts_with(p))
    {
        return Err("invalidLink".into());
    }
    if language == "en" {
        return Ok(raw.into());
    }
    let mut url = url::Url::parse("https://translate.google.com/translate").unwrap();
    url.query_pairs_mut()
        .append_pair("sl", "auto")
        .append_pair("tl", if language == "ja" { "ja" } else { "zh-CN" })
        .append_pair("u", raw);
    Ok(url.into())
}
async fn installed(agent: &str, custom: Option<&str>) -> Option<String> {
    let executable = if agent == "codex" {
        usage::find_codex(custom).await.ok()?
    } else {
        let output = process::output(
            process::command(if cfg!(windows) { "where.exe" } else { "which" }).arg(
                if cfg!(windows) {
                    "claude.exe"
                } else {
                    "claude"
                },
            ),
            Duration::from_secs(5),
            1024 * 1024,
        )
        .await
        .ok()?;
        std::path::PathBuf::from(output.lines().next()?)
    };
    let output = process::output(
        process::command(executable).arg("--version"),
        Duration::from_secs(10),
        10000,
    )
    .await
    .ok()?;
    version(&output).map(|v| v.to_string())
}
#[derive(Default)]
pub struct UpdateService;
impl UpdateService {
    pub async fn read(
        &mut self,
        agent: &str,
        directory: &Path,
        custom: Option<&str>,
        force: bool,
    ) -> Result<Value> {
        let repo = repository(agent)?;
        let file = directory.join(format!("release-{agent}.json"));
        let cached = std::fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .filter(|v| v.is_object());
        let installed = installed(agent, custom).await;
        let update = |mut value: Value, stale: bool| {
            value["installed"] = json!(installed);
            value["available"] = newer(
                value["version"].as_str().unwrap_or(""),
                installed.as_deref(),
            );
            if stale {
                value["stale"] = json!(true)
            }
            value
        };
        if !force {
            if let Some(value) = &cached {
                if chrono::Utc::now().timestamp_millis() - value["checkedAt"].as_i64().unwrap_or(0)
                    < 6 * 3600000
                {
                    return Ok(update(value.clone(), false));
                }
            }
        }
        let fetch:Result<Value>=async{
            let client=reqwest::Client::builder().user_agent("DeskMate-PC-Assistant").timeout(Duration::from_secs(20)).build().map_err(err)?;
            let response=client.get(format!("https://api.github.com/repos/{repo}/releases/latest")).header("Accept","application/vnd.github+json").send().await.map_err(err)?.error_for_status().map_err(err)?;
            if response.content_length().is_some_and(|len|len>2*1024*1024){return Err("releaseUnavailable".into())}
            let data:Value=response.json().await.map_err(err)?;let tag=data["tag_name"].as_str().ok_or("releaseUnavailable")?;
            if version(tag).is_none()||data["prerelease"]==true||data["draft"]==true{return Err("releaseUnavailable".into())}
            let tag:url::Url=url::Url::parse(&format!("https://github.com/{repo}/releases/tag/placeholder")).map_err(err)?.join(&url::form_urlencoded::byte_serialize(tag.as_bytes()).collect::<String>()).map_err(err)?;
            let value=json!({"agent":agent,"version":data["tag_name"],"body":data["body"].as_str().unwrap_or("").chars().take(100000).collect::<String>(),"url":tag.to_string(),"publishedAt":data["published_at"],"checkedAt":chrono::Utc::now().timestamp_millis(),"stale":false,"updatedAt":now()});
            let temporary=file.with_extension("json.tmp");std::fs::write(&temporary,value.to_string()).map_err(err)?;process::replace_file(&temporary,&file)?;Ok(value)
        }.await;
        Ok(match fetch{Ok(value)=>update(value,false),Err(_)=>cached.map(|v|update(v,true)).unwrap_or(json!({"agent":agent,"installed":installed,"error":"releaseUnavailable","available":null}))})
    }
}
