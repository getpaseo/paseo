use futures::channel::oneshot;
use gpui::App;
use rn_gpui_module::{FromValue, ModuleError, ModuleThread, Path, Value};

use crate::builtins::rn_gpui_specs::{
    ContextMenuOptions, ContextMenuSelection, NativeGpuiContextMenuEvents,
    NativeGpuiContextMenuSpec,
};
use crate::desktop::context_menu;
use crate::desktop::errors::DesktopError;

const MODULE: &str = "GpuiContextMenu";

struct ContextMenuModule;

fn window_key(window_id: i32) -> u32 {
    window_id as u32
}

fn to_json(value: Value) -> serde_json::Value {
    match value {
        Value::Null | Value::Callback(_) => serde_json::Value::Null,
        Value::Bool(flag) => serde_json::Value::Bool(flag),
        Value::Number(number) => serde_json::Number::from_f64(number)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        Value::String(text) => serde_json::Value::String(text),
        Value::Array(items) => serde_json::Value::Array(items.into_iter().map(to_json).collect()),
        Value::Object(fields) => serde_json::Value::Object(
            fields
                .into_iter()
                .map(|(key, item)| (key, to_json(item)))
                .collect(),
        ),
        Value::Buffer(bytes) => serde_json::Value::Array(
            bytes
                .into_iter()
                .map(|byte| serde_json::Value::Number(byte.into()))
                .collect(),
        ),
    }
}

fn from_json(value: &serde_json::Value) -> Value {
    match value {
        serde_json::Value::Null => Value::Null,
        serde_json::Value::Bool(flag) => Value::Bool(*flag),
        serde_json::Value::Number(number) => {
            number.as_f64().map(Value::Number).unwrap_or(Value::Null)
        }
        serde_json::Value::String(text) => Value::String(text.clone()),
        serde_json::Value::Array(items) => Value::Array(items.iter().map(from_json).collect()),
        serde_json::Value::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(key, item)| (key.clone(), from_json(item)))
                .collect(),
        ),
    }
}

fn module_error(error: DesktopError) -> ModuleError {
    ModuleError::new(error.message)
}

impl NativeGpuiContextMenuSpec for ContextMenuModule {
    const THREAD: ModuleThread = ModuleThread::Main;

    fn new(_events: NativeGpuiContextMenuEvents) -> Self {
        Self
    }

    async fn context_menu_show(
        &self,
        items: Vec<Value>,
        options: ContextMenuOptions,
    ) -> Result<ContextMenuSelection, ModuleError> {
        let items = serde_json::Value::Array(items.into_iter().map(to_json).collect());
        crate::desktop::icon::preload_menu(&items).await;
        let (sender, receiver) = oneshot::channel();
        crate::desktop::post_to_main(Box::new(move |cx: &mut App| {
            let responder = context_menu::Responder::desktop(sender);
            let rejected = responder.clone();
            if let Err(error) = context_menu::show(
                cx,
                items,
                options.x,
                options.y,
                options.window_id.map(window_key),
                responder,
            ) {
                rejected.reject(error);
            }
        }));
        let result = receiver
            .await
            .map_err(|_| ModuleError::new("the command was dismissed"))?
            .map_err(module_error)?;
        let mut path = Path::result(MODULE, "contextMenuShow");
        ContextMenuSelection::from_value(from_json(&result), &mut path)
            .map_err(|error| ModuleError::new(error.message))
    }

    fn add_listener(&self, _event_name: String) {}

    fn remove_listeners(&self, _count: f64) {}
}

pub fn register() {
    rn_gpui_module::register(
        crate::builtins::rn_gpui_specs::native_gpui_context_menu_module::<ContextMenuModule>(),
    );
}
