#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    if std::env::args().any(|arg| arg == "--claude-statusline") {
        deskmate::usage::statusline();
        return;
    }
    deskmate::desktop::run();
}
