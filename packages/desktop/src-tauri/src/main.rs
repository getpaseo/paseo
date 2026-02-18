// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// `tauri dev` runs the raw executable (`target/debug/Paseo`) on macOS (not the .app bundle),
// so we must embed an Info.plist containing usage descriptions for WebKit media
// permission prompts in dev.
#[cfg(all(target_os = "macos", debug_assertions))]
tauri::embed_plist::embed_info_plist!("../Info.plist");

fn main() {
    paseo_lib::run();
}
