use rn_gpui_module::{ModuleError, ModuleThread};

use crate::builtins::main_thread::on_main;
use crate::builtins::rn_gpui_specs::{
    GetConstantsResult, NativeGpuiClipboardEvents, NativeGpuiClipboardSpec,
};

struct ClipboardModule;

impl NativeGpuiClipboardSpec for ClipboardModule {
    const THREAD: ModuleThread = ModuleThread::Main;

    fn new(_events: NativeGpuiClipboardEvents) -> Self {
        Self
    }

    fn get_constants(&self) -> Result<GetConstantsResult, ModuleError> {
        Ok(GetConstantsResult {})
    }

    async fn get_string(&self) -> Result<String, ModuleError> {
        on_main(|cx| {
            cx.read_from_clipboard()
                .and_then(|item| item.text())
                .unwrap_or_default()
        })
        .await
    }

    fn set_string(&self, content: String) {
        crate::desktop::post_to_main(Box::new(move |cx| {
            cx.write_to_clipboard(gpui::ClipboardItem::new_string(content));
        }));
    }
}

pub fn register() {
    rn_gpui_module::register(
        crate::builtins::rn_gpui_specs::native_gpui_clipboard_module::<ClipboardModule>(),
    );
}
