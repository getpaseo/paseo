use rn_gpui_module::{ModuleError, ModuleThread};

use crate::builtins::main_thread::on_main;
use crate::builtins::rn_gpui_specs::{
    NativeGpuiLinkingManagerEvents, NativeGpuiLinkingManagerSpec,
};

struct LinkingManagerModule;

impl NativeGpuiLinkingManagerSpec for LinkingManagerModule {
    const THREAD: ModuleThread = ModuleThread::Main;

    fn new(_events: NativeGpuiLinkingManagerEvents) -> Self {
        Self
    }

    async fn get_initial_url(&self) -> Result<Option<String>, ModuleError> {
        Ok(None)
    }

    async fn can_open_url(&self, url: String) -> Result<bool, ModuleError> {
        let scheme = url
            .split_once(':')
            .map(|(scheme, _)| scheme.to_ascii_lowercase())
            .unwrap_or_default();
        Ok(matches!(
            scheme.as_str(),
            "http" | "https" | "mailto" | "tel"
        ))
    }

    async fn open_url(&self, url: String) -> Result<(), ModuleError> {
        on_main(move |cx| cx.open_url(&url)).await
    }

    async fn open_settings(&self) -> Result<(), ModuleError> {
        Err(ModuleError::new(
            "opening application settings is not supported by GPUI",
        ))
    }

    fn add_listener(&self, _event_name: String) {}

    fn remove_listeners(&self, _count: f64) {}
}

pub fn register() {
    rn_gpui_module::register(
        crate::builtins::rn_gpui_specs::native_gpui_linking_manager_module::<LinkingManagerModule>(
        ),
    );
}
