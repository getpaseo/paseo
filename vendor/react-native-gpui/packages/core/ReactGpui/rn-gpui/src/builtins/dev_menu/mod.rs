use rn_gpui_module::ModuleThread;

use crate::builtins::rn_gpui_specs::{NativeGpuiDevMenuEvents, NativeGpuiDevMenuSpec};

struct DevMenuModule;

impl NativeGpuiDevMenuSpec for DevMenuModule {
    const THREAD: ModuleThread = ModuleThread::Main;

    fn new(_events: NativeGpuiDevMenuEvents) -> Self {
        Self
    }

    fn show(&self) {
        if let Some(handler) = rn_gpui_sys::DEV_MENU_SHOW_HANDLER.get() {
            handler();
        }
    }

    fn reload(&self) {
        if let Some(handler) = rn_gpui_sys::DEV_MENU_PERFORM_HANDLER.get() {
            handler(crate::desktop::dev_menu::RELOAD.to_string());
        }
    }

    fn set_profiling_enabled(&self, enabled: bool) {
        dev_setting("profiling", enabled);
    }

    fn set_hot_loading_enabled(&self, enabled: bool) {
        dev_setting("hotLoading", enabled);
    }

    fn toggle_element_inspector(&self) {
        dev_setting("inspectorToggle", true);
    }

    fn add_listener(&self, _event_name: String) {}

    fn remove_listeners(&self, _count: f64) {}
}

fn dev_setting(name: &str, enabled: bool) {
    if let Some(handler) = rn_gpui_sys::DEV_SETTING_HANDLER.get() {
        handler(name.to_string(), enabled);
    }
}

pub fn register() {
    rn_gpui_module::register(
        crate::builtins::rn_gpui_specs::native_gpui_dev_menu_module::<DevMenuModule>(),
    );
}
