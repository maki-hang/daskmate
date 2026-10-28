use crate::{err, now, store::Store, Result};
use chrono::{DateTime, Days, Local, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc};
use serde_json::{json, Value};

fn text(value: &Value, key: &str, max: usize) -> Result<String> {
    let text = value[key].as_str().ok_or("请输入有效内容")?.trim();
    if text.is_empty() || text.encode_utf16().count() > max {
        return Err("请输入有效内容".into());
    }
    Ok(text.into())
}
fn date(value: &Value) -> Result<NaiveDate> {
    let value = value["date"].as_str().ok_or("日期无效")?;
    let date = NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| "日期无效")?;
    if date.format("%Y-%m-%d").to_string() != value {
        return Err("日期无效".into());
    }
    Ok(date)
}
fn valid_repeat(value: &str) -> Result<()> {
    if ["none", "daily", "weekly"].contains(&value) {
        Ok(())
    } else {
        Err("重复方式无效".into())
    }
}
pub fn save_note(store: &mut Store, value: &Value) -> Result<Value> {
    let date = date(value)?.to_string();
    let content = text(value, "content", 10000)?;
    let stamp = now();
    store.update(|state| {
        let notes = state["notes"].as_array_mut().unwrap();
        let index = if let Some(id) = value["id"].as_str().filter(|id| !id.is_empty()) {
            notes
                .iter()
                .position(|note| note["id"] == id)
                .ok_or("missingNote")?
        } else {
            notes.push(json!({"id":uuid::Uuid::new_v4().to_string(),"createdAt":stamp}));
            notes.len() - 1
        };
        let note = &mut notes[index];
        note["date"] = json!(date);
        note["content"] = json!(content);
        note["updatedAt"] = json!(stamp);
        Ok(note.clone())
    })
}
pub fn save_agenda(store: &mut Store, value: &Value) -> Result<Value> {
    let day = date(value)?;
    let content = text(value, "content", 10000)?;
    let clock = value["time"].as_str().ok_or("invalidTime")?;
    let time = NaiveTime::parse_from_str(clock, "%H:%M:%S").map_err(|_| "invalidTime")?;
    if time.format("%H:%M:%S").to_string() != clock {
        return Err("invalidTime".into());
    }
    let due = Local
        .from_local_datetime(&NaiveDateTime::new(day, time))
        .earliest()
        .ok_or("invalidTime")?
        .with_timezone(&Utc)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let repeat = value["repeat"].as_str().unwrap_or("none");
    valid_repeat(repeat)?;
    let stamp = now();
    store.update(|state| {
        let notes = state["notes"].as_array_mut().unwrap();
        let index = if let Some(id) = value["id"].as_str().filter(|id| !id.is_empty()) { notes.iter().position(|note| note["id"]==id).ok_or("missingNote")? } else { notes.push(json!({"id":uuid::Uuid::new_v4().to_string(),"createdAt":stamp})); notes.len()-1 };
        let previous = notes[index].clone(); let id = previous["id"].clone();
        notes[index]["date"] = json!(day.to_string()); notes[index]["time"] = json!(clock); notes[index]["content"] = json!(content); notes[index]["updatedAt"] = json!(stamp); let note = notes[index].clone();
        let reminders = state["reminders"].as_array_mut().unwrap();
        if !value["remind"].as_bool().unwrap_or(false) { reminders.retain(|r|r["noteId"]!=id); }
        else {
            let index = reminders.iter().position(|r|r["noteId"]==id).unwrap_or_else(||{reminders.push(json!({"id":uuid::Uuid::new_v4().to_string(),"noteId":id,"createdAt":note["createdAt"]}));reminders.len()-1});
            let reminder = &mut reminders[index];
            let rescheduled = previous["date"]!=day.to_string() || previous["time"]!=clock || reminder["repeat"]!=repeat || reminder["dueAt"].is_null();
            reminder["title"] = json!(content.chars().take(200).collect::<String>());
            if rescheduled { for (key,value) in json!({"dueAt":due,"repeat":repeat,"enabled":true,"completed":false,"unread":false,"lastFiredAt":null}).as_object().unwrap() { reminder[key]=value.clone(); } }
        }
        Ok(note)
    })
}
pub fn save_reminder(store: &mut Store, value: &Value) -> Result<Value> {
    let title = text(value, "title", 200)?;
    let due = DateTime::parse_from_rfc3339(value["dueAt"].as_str().ok_or("提醒时间无效")?)
        .map_err(err)?
        .with_timezone(&Utc)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let repeat = value["repeat"].as_str().ok_or("重复方式无效")?;
    valid_repeat(repeat)?;
    store.update(|state| {
        let reminders = state["reminders"].as_array_mut().unwrap();
        let index = if let Some(id) = value["id"].as_str().filter(|s|!s.is_empty()) { reminders.iter().position(|r|r["id"]==id).ok_or("提醒已不存在")? } else { reminders.push(json!({"id":uuid::Uuid::new_v4().to_string(),"createdAt":now()}));reminders.len()-1 };
        let reminder = &mut reminders[index];
        for (key,value) in json!({"title":title,"dueAt":due,"repeat":repeat,"enabled":true,"completed":false,"unread":false,"lastFiredAt":null}).as_object().unwrap() { reminder[key]=value.clone(); } Ok(reminder.clone())
    })
}
pub fn collect_due(store: &mut Store, at: DateTime<Utc>) -> Result<Vec<Value>> {
    let pending = |r: &Value| {
        r["enabled"] == true
            && r["completed"] != true
            && r["dueAt"]
                .as_str()
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                .is_some_and(|d| d <= at)
    };
    if !store.state["reminders"]
        .as_array()
        .unwrap()
        .iter()
        .any(pending)
    {
        return Ok(Vec::new());
    }
    store.update(|state| {
        let mut fired = Vec::new();
        for reminder in state["reminders"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .filter(|r| pending(r))
        {
            let mut item = reminder.clone();
            item["occurrenceAt"] = reminder["dueAt"].clone();
            fired.push(item);
            reminder["lastFiredAt"] =
                json!(at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
            reminder["unread"] = json!(true);
            if reminder["repeat"] == "none" {
                reminder["completed"] = json!(true);
                reminder["enabled"] = json!(false);
            } else {
                let mut next = DateTime::parse_from_rfc3339(reminder["dueAt"].as_str().unwrap())
                    .map_err(err)?
                    .with_timezone(&Local);
                let days = if reminder["repeat"] == "daily" { 1 } else { 7 };
                // Keep local wall time across DST and skip missing spring-forward times.
                while next <= at {
                    let local = next
                        .naive_local()
                        .checked_add_days(Days::new(days))
                        .ok_or("提醒时间越界")?;
                    next = Local
                        .from_local_datetime(&local)
                        .earliest()
                        .unwrap_or_else(|| {
                            Local.from_utc_datetime(
                                &(local
                                    - chrono::Duration::seconds(i64::from(
                                        next.offset().local_minus_utc(),
                                    ))),
                            )
                        });
                }
                reminder["dueAt"] = json!(next
                    .with_timezone(&Utc)
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
            }
        }
        Ok(fired)
    })
}
