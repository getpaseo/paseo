use rn_gpui_module::{FromValue, ModuleError, ModuleThread, Path, Value};

use crate::builtins::main_thread::on_main;
use crate::builtins::rn_gpui_specs::{
    NativeGpuiTrayEvents, NativeGpuiTraySpec, TrayHandle, TrayOptions, TrayState,
};
use crate::desktop::tray;

const MODULE: &str = "GpuiTray";

struct TrayModule;

fn value_json(value: Value) -> serde_json::Value {
    match value {
        Value::Null | Value::Callback(_) => serde_json::Value::Null,
        Value::Bool(flag) => serde_json::Value::Bool(flag),
        Value::Number(number) => serde_json::Number::from_f64(number)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        Value::Buffer(bytes) => serde_json::Value::Array(
            bytes
                .into_iter()
                .map(|byte| serde_json::Value::Number(byte.into()))
                .collect(),
        ),
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

fn desktop_error(error: crate::desktop::errors::DesktopError) -> ModuleError {
    ModuleError::new(error.message)
}

fn typed<T: FromValue>(method: &'static str, value: &serde_json::Value) -> Result<T, ModuleError> {
    let mut path = Path::result(MODULE, method);
    T::from_value(json_value(value), &mut path).map_err(|error| ModuleError::new(error.message))
}

fn void(
    result: Result<serde_json::Value, crate::desktop::errors::DesktopError>,
) -> Result<(), ModuleError> {
    result
        .map(|_| ())
        .map_err(|error| ModuleError::new(error.message))
}

impl NativeGpuiTraySpec for TrayModule {
    const THREAD: ModuleThread = ModuleThread::Main;

    fn new(_events: NativeGpuiTrayEvents) -> Self {
        Self
    }

    async fn tray_install(&self, options: TrayOptions) -> Result<TrayHandle, ModuleError> {
        let icon = match options.icon.as_deref() {
            Some(uri) => Some(
                crate::desktop::icon::load(uri)
                    .await
                    .map_err(ModuleError::new)?,
            ),
            None => None,
        };
        let menu = json_items(options.menu);
        if let Some(menu) = &menu {
            crate::desktop::icon::preload_menu(menu).await;
        }
        let handle = on_main(
            move |cx| -> Result<serde_json::Value, crate::desktop::errors::DesktopError> {
                let mut config = tray::TrayConfig::default();
                if let Some(id) = options.id {
                    config.id = id;
                }
                config.tooltip = options.tooltip;
                config.title = options.title;
                if let Some(icon) = icon {
                    config.icon = Some((icon.rgba.clone(), icon.width, icon.height));
                    config.icon_is_template = options.icon_template.unwrap_or(false);
                }
                config.component = options.component;
                if let Some(size) = options.size {
                    config = config.size(size.width as f32, size.height as f32);
                }
                if let Some(menu) = menu {
                    config.menu = Some(crate::desktop::menu_model::parse_menu(&menu)?);
                }
                if let Some(on_left_click) = options.menu_on_left_click {
                    config.menu_on_left_click = on_left_click;
                }
                if let Some(quit) = options.quit_on_last_window_closed {
                    config.quit_on_last_window_closed = quit;
                }
                if let Some(hide) = options.hide_window_on_close {
                    config.hide_window_on_close = hide;
                }
                tray::install(cx, config)
            },
        )
        .await?;
        typed("trayInstall", &handle.map_err(desktop_error)?)
    }

    async fn tray_destroy(&self) -> Result<(), ModuleError> {
        on_main(tray::destroy).await.and_then(void)
    }

    async fn tray_get_state(&self) -> Result<TrayState, ModuleError> {
        let value = on_main(
            |cx| -> Result<serde_json::Value, crate::desktop::errors::DesktopError> {
                Ok(tray::state(cx))
            },
        )
        .await?;
        typed("trayGetState", &value.map_err(desktop_error)?)
    }

    async fn tray_set_tooltip(&self, tooltip: Option<String>) -> Result<(), ModuleError> {
        on_main(move |cx| tray::set_tooltip(cx, tooltip.as_deref()))
            .await
            .and_then(void)
    }

    async fn tray_set_visible(&self, visible: bool) -> Result<(), ModuleError> {
        on_main(move |cx| tray::set_visible(cx, visible))
            .await
            .and_then(void)
    }

    async fn tray_set_icon(&self, icon: String, template: bool) -> Result<(), ModuleError> {
        let icon = crate::desktop::icon::load(&icon)
            .await
            .map_err(ModuleError::new)?;
        on_main(move |cx| tray::set_icon(cx, &icon, template))
            .await
            .and_then(void)
    }

    async fn tray_set_title(&self, title: Option<String>) -> Result<(), ModuleError> {
        on_main(move |cx| tray::set_title(cx, title.as_deref()))
            .await
            .and_then(void)
    }

    async fn tray_set_menu(&self, items: Option<Vec<Value>>) -> Result<(), ModuleError> {
        let items = json_items(items);
        if let Some(items) = &items {
            crate::desktop::icon::preload_menu(items).await;
        }
        on_main(move |cx| tray::set_menu(cx, items.as_ref()))
            .await
            .and_then(void)
    }

    fn add_listener(&self, _event_name: String) {}

    fn remove_listeners(&self, _count: f64) {}
}

pub fn register() {
    rn_gpui_module::register(crate::builtins::rn_gpui_specs::native_gpui_tray_module::<
        TrayModule,
    >());
}
