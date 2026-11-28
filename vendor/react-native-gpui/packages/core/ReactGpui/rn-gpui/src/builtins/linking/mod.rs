mod scheme;

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
        Ok(crate::desktop::deep_link::initial_url())
    }

    async fn can_open_url(&self, url: String) -> Result<bool, ModuleError> {
        Ok(scheme::can_open(&url))
    }

    async fn open_url(&self, url: String) -> Result<(), ModuleError> {
        on_main(move |cx| cx.open_url(&url)).await
    }

    async fn open_settings(&self) -> Result<(), ModuleError> {
        on_main(|cx| scheme::open_settings(cx))
            .await?
            .map_err(ModuleError::new)
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
