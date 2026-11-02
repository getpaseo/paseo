//! The desktop-shell TurboModule: one method per command in
//! `src-gpui/src/private/specs/NativeGpuiDesktop.ts`.
//!
//! A command needs the GPUI app context, which only the main loop holds, so
//! each one is posted to the main thread and awaited here. The value methods
//! (`capabilities`, `platform`, `appId`) read immutable state and run inline on
//! the JS thread, which is what makes them synchronous.

use rn_gpui_module::{ModuleError, ModuleThread};

use super::capabilities;

pub struct GpuiDesktopModule;

rn_gpui_module::include_specs!();

impl NativeGpuiDesktopSpec for GpuiDesktopModule {
    /// Every command runs where the GPUI app context is.
    const THREAD: ModuleThread = ModuleThread::Main;

    fn new(_events: NativeGpuiDesktopEvents) -> Self {
        Self
    }

    fn capabilities(&self) -> Result<DesktopCapabilities, ModuleError> {
        Ok(DesktopCapabilities {
            native_app_menu: capabilities::native_app_menu(),
            native_context_menu: capabilities::native_context_menu(),
            tray: capabilities::tray(),
            tray_popover_anchored: capabilities::tray_popover_anchored(),
            window_position: capabilities::window_position(),
            always_on_top: capabilities::always_on_top(),
            transparent_titlebar: capabilities::transparent_titlebar(),
            menu_bar_in_window: capabilities::menu_bar_in_window(),
            client_decorations: capabilities::client_decorations(),
        })
    }

    fn platform(&self) -> Result<String, ModuleError> {
        Ok(super::snapshot_platform())
    }

    fn app_id(&self) -> Result<String, ModuleError> {
        Ok(super::snapshot_app_id())
    }

    async fn app_info(&self) -> Result<DesktopAppInfo, ModuleError> {
        Ok(DesktopAppInfo {
            platform: super::snapshot_platform(),
            arch: std::env::consts::ARCH.to_string(),
            capabilities: self.capabilities()?,
        })
    }

    fn add_listener(&self, _event_name: String) {}

    fn remove_listeners(&self, _count: f64) {}
}

/// Registers the desktop module. Called once, before the first JS runtime.
pub fn register() {
    rn_gpui_module::register(native_gpui_desktop_module::<GpuiDesktopModule>());
}
