pub mod app_menu;
pub mod capabilities;
pub mod client_frame;
pub mod context_menu;
pub mod dev_menu;
pub mod errors;
pub mod gpui_menu;
pub mod icon;
pub mod keymap;
pub mod menu_events;
pub mod menu_model;
pub mod module;
pub mod perf_monitor;
pub mod platform_window;
pub mod tray;
pub mod windows;

use gpui::App;
use std::sync::OnceLock;

#[derive(Clone)]
pub struct Snapshot {
    pub app_id: String,
    pub platform: &'static str,
}

static SNAPSHOT: OnceLock<Snapshot> = OnceLock::new();

/// Install the snapshot the module's value methods read. Must run before
/// `load_script`, so a module that reads a capability during initialization sees
/// the real value.
pub fn install_snapshot(app_id: &str) {
    let _ = SNAPSHOT.set(Snapshot {
        app_id: app_id.to_string(),
        platform: std::env::consts::OS,
    });
}

/// The app id, or an empty string before `install_snapshot` ran.
pub fn snapshot_app_id() -> String {
    SNAPSHOT
        .get()
        .map(|snapshot| snapshot.app_id.clone())
        .unwrap_or_default()
}

pub fn snapshot_platform() -> String {
    SNAPSHOT
        .get()
        .map(|snapshot| snapshot.platform.to_string())
        .unwrap_or_else(|| std::env::consts::OS.to_string())
}

/// The main loop's queue, installed by the bootstrap before the first command.
static COMMAND_SENDER: OnceLock<async_channel::Sender<crate::bootstrap::MainEvent>> =
    OnceLock::new();

pub(crate) fn set_command_sender(sender: async_channel::Sender<crate::bootstrap::MainEvent>) {
    let _ = COMMAND_SENDER.set(sender);
}

/// Queues one command for the GPUI main thread. The command answers through the
/// channel it was built with, which may be long after it returns: a context menu
/// answers when it closes.
pub fn post_to_main(command: Box<dyn FnOnce(&mut App) + Send + 'static>) {
    let Some(sender) = COMMAND_SENDER.get() else {
        log::warn!("[desktop] the main loop is not running; command dropped");
        return;
    };
    let _ = sender.send_blocking(crate::bootstrap::MainEvent::DesktopCommand(command));
}
