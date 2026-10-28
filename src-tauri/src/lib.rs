pub mod agenda;
#[cfg(feature = "desktop")]
pub mod desktop;
pub mod git;
pub mod process;
pub mod skins;
pub mod store;
pub mod updates;
pub mod usage;
pub type Result<T> = std::result::Result<T, String>;
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
