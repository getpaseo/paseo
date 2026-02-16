use std::sync::atomic::{AtomicU64, Ordering};
use tauri::menu::{Menu, MenuItemBuilder, MenuItemKind, PredefinedMenuItem, Submenu};
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
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_websocket::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Start from Tauri's default menu so macOS standard shortcuts (Cmd+A/C/V/etc)
            // keep working. Then inject our zoom controls into a View menu.
            //
            // On macOS in particular, a custom menu that omits Edit items can break
            // responder-chain shortcuts across the whole app.
            let menu = Menu::default(app.handle())?;

            let zoom_in = MenuItemBuilder::with_id("zoom_in", "Zoom In")
                .accelerator("CmdOrCtrl+=")
                .build(app)?;
            let zoom_out = MenuItemBuilder::with_id("zoom_out", "Zoom Out")
                .accelerator("CmdOrCtrl+-")
                .build(app)?;
            let zoom_reset = MenuItemBuilder::with_id("zoom_reset", "Actual Size")
                .accelerator("CmdOrCtrl+0")
                .build(app)?;

            let separator = PredefinedMenuItem::separator(app.handle())?;

            // On macOS, Tauri's default menu already has a "View" submenu (with Fullscreen).
            // Insert our zoom items at the top so we don't duplicate the submenu.
            #[cfg(target_os = "macos")]
            {
                let mut view_submenu: Option<Submenu<_>> = None;
                for item in menu.items()? {
                    if let MenuItemKind::Submenu(submenu) = item {
                        if submenu.text()? == "View" {
                            view_submenu = Some(submenu);
                            break;
                        }
                    }
                }

                if let Some(view) = view_submenu {
                    // Zoom controls first, then keep existing items (e.g. Fullscreen).
                    view.insert_items(&[&zoom_in, &zoom_out, &zoom_reset, &separator], 0)?;
                } else {
                    // Fallback: if the default menu ever changes, create a View menu.
                    let view_menu = Submenu::with_items(
                        app,
                        "View",
                        true,
                        &[&zoom_in, &zoom_out, &zoom_reset, &separator],
                    )?;
                    menu.append(&view_menu)?;
                }
            }

            // Non-macOS: default menu doesn't include a View menu, so add it.
            #[cfg(not(target_os = "macos"))]
            {
                let view_menu =
                    Submenu::with_items(app, "View", true, &[&zoom_in, &zoom_out, &zoom_reset])?;
                menu.append(&view_menu)?;
            }

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
