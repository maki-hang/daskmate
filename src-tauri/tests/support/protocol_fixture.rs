use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
fn main() {
    if std::env::args().any(|arg| arg == "--version") {
        println!("codex-cli 0.1.0");
        return;
    }
    for line in io::stdin().lock().lines().map_while(Result::ok) {
        let Ok(request) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let result = match request["method"].as_str().unwrap_or("") {
            "initialize" => json!({"userAgent":"fixture"}),
            "account/rateLimits/read" => {
                json!({"rateLimits":{"planType":"test","primary":{"usedPercent":36,"windowDurationMins":300,"resetsAt":1900000000},"secondary":{"usedPercent":18,"windowDurationMins":10080,"resetsAt":1900000000}},"rateLimitResetCredits":{"availableCount":2,"credits":[]}})
            }
            "account/usage/read" => {
                json!({"summary":{"lifetimeTokens":12345678},"dailyUsageBuckets":[{"startDate":chrono::Local::now().format("%Y-%m-%d").to_string(),"tokens":123456}]})
            }
            _ => continue,
        };
        println!("{}", json!({"id":request["id"],"result":result}));
        io::stdout().flush().unwrap();
    }
}
