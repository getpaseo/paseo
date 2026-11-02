use rn_gpui_module::{FromValue, IntoValue, ModuleError, ModuleThread, Path, Value};

use crate::builtins::main_thread::on_main;
use crate::builtins::rn_gpui_specs::{
    MenuDescription, MenuItemPatch, NativeGpuiAppMenuEvents, NativeGpuiAppMenuSpec,
};
use crate::desktop::app_menu;
use crate::desktop::errors::{DesktopError, DesktopResult};
use crate::desktop::windows::MAIN_WINDOW_KEY;

const MODULE: &str = "GpuiAppMenu";

struct AppMenuModule;

fn value_json(value: Value) -> serde_json::Value {
    match value {
        Value::Null | Value::Callback(_) => serde_json::Value::Null,
        Value::Bool(flag) => serde_json::Value::Bool(flag),
        Value::Number(number) => serde_json::Number::from_f64(number)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        Value::String(text) => serde_json::Value::String(text),
        Value::Array(items) => {
            serde_json::Value::Array(items.into_iter().map(value_json).collect())
        }
        Value::Object(fields) => serde_json::Value::Object(
            fields
                .into_iter()
                .map(|(key, item)| (key, value_json(item)))
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

fn json_value(value: &serde_json::Value) -> Value {
    match value {
        serde_json::Value::Null => Value::Null,
        serde_json::Value::Bool(flag) => Value::Bool(*flag),
        serde_json::Value::Number(number) => {
            number.as_f64().map(Value::Number).unwrap_or(Value::Null)
        }
        serde_json::Value::String(text) => Value::String(text.clone()),
        serde_json::Value::Array(items) => Value::Array(items.iter().map(json_value).collect()),
        serde_json::Value::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(key, item)| (key.clone(), json_value(item)))
                .collect(),
        ),
    }
}

fn json_items(items: Option<Vec<Value>>) -> Option<serde_json::Value> {
    items.map(|items| serde_json::Value::Array(items.into_iter().map(value_json).collect()))
}

fn module_error(error: DesktopError) -> ModuleError {
    ModuleError::new(error.message)
}

fn typed<T: FromValue>(method: &'static str, result: DesktopResult) -> Result<T, ModuleError> {
    let mut path = Path::result(MODULE, method);
    let value = json_value(&result.map_err(module_error)?);
    T::from_value(value, &mut path).map_err(|error| ModuleError::new(error.message))
}

impl NativeGpuiAppMenuSpec for AppMenuModule {
    const THREAD: ModuleThread = ModuleThread::Main;

    fn new(_events: NativeGpuiAppMenuEvents) -> Self {
        Self
    }

    async fn menu_set_application_menu(
        &self,
        items: Option<Vec<Value>>,
    ) -> Result<(), ModuleError> {
        let items = json_items(items);
        if let Some(items) = &items {
            crate::desktop::icon::preload_menu(items).await;
        }
        on_main(move |cx| {
            app_menu::set_application_menu(cx, items.as_ref())?;
            Ok(serde_json::Value::Null)
        })
        .await?
        .map(|_| ())
        .map_err(module_error)
    }

    async fn menu_update(&self, id: String, patch: MenuItemPatch) -> Result<(), ModuleError> {
        on_main(move |cx| {
            app_menu::update_item(cx, &id, &value_json(patch.into_value()))?;
            Ok(serde_json::Value::Null)
        })
        .await?
        .map(|_| ())
        .map_err(module_error)
    }

    async fn menu_set_menu_bar_visible(
        &self,
        visible: bool,
        window_id: Option<f64>,
    ) -> Result<(), ModuleError> {
        let window_id = window_id.map(|id| id as u32).unwrap_or(MAIN_WINDOW_KEY);
        on_main(move |cx| {
            app_menu::set_menu_bar_visible(cx, window_id, visible)?;
            Ok(serde_json::Value::Null)
        })
        .await?
        .map(|_| ())
        .map_err(module_error)
    }

    async fn menu_perform_role(&self, role: String) -> Result<(), ModuleError> {
        on_main(move |cx| {
            app_menu::perform_role(cx, &role)?;
            Ok(serde_json::Value::Null)
        })
        .await?
        .map(|_| ())
        .map_err(module_error)
    }

    async fn menu_get(&self) -> Result<MenuDescription, ModuleError> {
        let result = on_main(|cx| -> DesktopResult { Ok(app_menu::menu_json(cx)) }).await?;
        typed("menuGet", result)
    }

    fn add_listener(&self, _event_name: String) {}

    fn remove_listeners(&self, _count: f64) {}
}

pub fn register() {
    rn_gpui_module::register(
        crate::builtins::rn_gpui_specs::native_gpui_app_menu_module::<AppMenuModule>(),
    );
}
