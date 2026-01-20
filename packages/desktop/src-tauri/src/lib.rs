use std::sync::atomic::{AtomicU64, Ordering};
use tauri::menu::{Menu, MenuItemBuilder, Submenu};
use tauri::Manager;
use tauri::WebviewWindow;

// Store zoom as u64 bits (f64 * 100 as integer for atomic ops)
static ZOOM_LEVEL: AtomicU64 = AtomicU64::new(100);

fn get_zoom_factor() -> f64 {
    ZOOM_LEVEL.load(Ordering::Relaxed) as f64 / 100.0
}

fn set_zoom_factor(webview: &WebviewWindow, factor: f64) {
    let clamped = factor.clamp(0.5, 3.0);
    ZOOM_LEVEL.store((clamped * 100.0) as u64, Ordering::Relaxed);
    let _ = webview.set_zoom(clamped);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Build the View menu with zoom controls
            let zoom_in = MenuItemBuilder::with_id("zoom_in", "Zoom In")
                .accelerator("CmdOrCtrl+=")
                .build(app)?;
            let zoom_out = MenuItemBuilder::with_id("zoom_out", "Zoom Out")
                .accelerator("CmdOrCtrl+-")
                .build(app)?;
            let zoom_reset = MenuItemBuilder::with_id("zoom_reset", "Actual Size")
                .accelerator("CmdOrCtrl+0")
                .build(app)?;

            let view_menu = Submenu::with_items(
                app,
                "View",
                true,
                &[&zoom_in, &zoom_out, &zoom_reset],
            )?;

            let menu = Menu::with_items(app, &[&view_menu])?;
            app.set_menu(menu)?;

            let window = app.get_webview_window("main").unwrap();
            let window_clone = window.clone();

            app.on_menu_event(move |_app, event| {
                let id = event.id().as_ref();
                if id == "zoom_in" {
                    let current = get_zoom_factor();
                    set_zoom_factor(&window_clone, current + 0.1);
                } else if id == "zoom_out" {
                    let current = get_zoom_factor();
                    set_zoom_factor(&window_clone, current - 0.1);
                } else if id == "zoom_reset" {
                    set_zoom_factor(&window_clone, 1.0);
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
