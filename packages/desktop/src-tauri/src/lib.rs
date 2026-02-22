use serde::Serialize;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::menu::{Menu, MenuItemBuilder, MenuItemKind, PredefinedMenuItem, Submenu};
#[cfg(target_os = "macos")]
use tauri::menu::AboutMetadata;
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_updater::UpdaterExt;

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DaemonUpdateCommandResult {
    exit_code: i32,
    stdout: String,
    stderr: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppUpdateCheckResult {
    has_update: bool,
    current_version: String,
    latest_version: Option<String>,
    body: Option<String>,
    date: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppUpdateInstallResult {
    installed: bool,
    version: Option<String>,
    message: String,
}

fn resolve_login_shell() -> String {
    std::env::var("SHELL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "/bin/zsh".to_string())
}

fn execute_local_daemon_update(shell: &str) -> DaemonUpdateCommandResult {
    let script = r#"if command -v paseo >/dev/null 2>&1; then
  paseo daemon update
else
  echo "paseo command not found in PATH. Ensure Paseo CLI is installed for this user." >&2
  exit 127
fi"#;

    match Command::new(shell).arg("-lc").arg(script).output() {
        Ok(output) => DaemonUpdateCommandResult {
            exit_code: output.status.code().unwrap_or(1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        },
        Err(error) => DaemonUpdateCommandResult {
            exit_code: -1,
            stdout: String::new(),
            stderr: format!("Failed to run daemon update command: {error}"),
        },
    }
}

#[tauri::command]
async fn run_local_daemon_update() -> DaemonUpdateCommandResult {
    let shell = resolve_login_shell();
    tauri::async_runtime::spawn_blocking(move || execute_local_daemon_update(&shell))
        .await
        .unwrap_or_else(|error| DaemonUpdateCommandResult {
            exit_code: -1,
            stdout: String::new(),
            stderr: format!("Daemon update task failed: {error}"),
        })
}

#[tauri::command]
async fn check_app_update(app: AppHandle) -> Result<AppUpdateCheckResult, String> {
    let current_version = app.package_info().version.to_string();
    let updater = app
        .updater()
        .map_err(|error| format!("Failed to initialize updater: {error}"))?;
    let update = updater
        .check()
        .await
        .map_err(|error| format!("Failed to check for updates: {error}"))?;

    if let Some(update) = update {
        return Ok(AppUpdateCheckResult {
            has_update: true,
            current_version,
            latest_version: Some(update.version.to_string()),
            body: update.body,
            date: update.date.map(|date| date.to_string()),
        });
    }

    Ok(AppUpdateCheckResult {
        has_update: false,
        current_version,
        latest_version: None,
        body: None,
        date: None,
    })
}

#[tauri::command]
async fn install_app_update(app: AppHandle) -> Result<AppUpdateInstallResult, String> {
    let updater = app
        .updater()
        .map_err(|error| format!("Failed to initialize updater: {error}"))?;
    let update = updater
        .check()
        .await
        .map_err(|error| format!("Failed to check for updates: {error}"))?;

    let Some(update) = update else {
        return Ok(AppUpdateInstallResult {
            installed: false,
            version: None,
            message: "No update is currently available.".to_string(),
        });
    };

    let version = update.version.to_string();
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|error| format!("Failed to download and install update: {error}"))?;

    Ok(AppUpdateInstallResult {
        installed: true,
        version: Some(version),
        message: "Update installed. Restart Paseo to finish applying it.".to_string(),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_websocket::init())
        .invoke_handler(tauri::generate_handler![
            run_local_daemon_update,
            check_app_update,
            install_app_update
        ])
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

            #[cfg(target_os = "macos")]
            {
                let app_menu = menu.items()?.into_iter().find_map(|item| match item {
                    MenuItemKind::Submenu(submenu) => Some(submenu),
                    _ => None,
                });

                if let Some(submenu) = app_menu {
                    // Tauri's default about item sets only `version`, which macOS renders as
                    // "Version <plist short> (<version>)". Set only `short_version` instead.
                    let about_metadata = AboutMetadata {
                        name: Some(app.package_info().name.clone()),
                        short_version: Some(app.package_info().version.to_string()),
                        copyright: app.config().bundle.copyright.clone(),
                        ..Default::default()
                    };
                    let about = PredefinedMenuItem::about(app.handle(), None, Some(about_metadata))?;

                    if submenu.remove_at(0)?.is_some() {
                        submenu.insert(&about, 0)?;
                    }
                }
            }

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
