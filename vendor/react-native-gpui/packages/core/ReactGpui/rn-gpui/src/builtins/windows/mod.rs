use rn_gpui_module::{FromValue, ModuleError, ModuleThread, Path, Value};

use crate::bootstrap::{WindowBackground, WindowTitleBar};
use crate::builtins::main_thread::on_main;
use crate::builtins::rn_gpui_specs::{
    NativeGpuiWindowsEvents, NativeGpuiWindowsSpec, WindowHandle, WindowList, WindowOpenOptions,
    WindowState,
};
use crate::desktop::errors::{DesktopError, DesktopResult};
use crate::desktop::windows;

const MODULE: &str = "GpuiWindows";

struct WindowsModule;

fn window_key(window_id: i32) -> u32 {
    window_id as u32
}

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

fn module_error(error: DesktopError) -> ModuleError {
    ModuleError::new(error.message)
}

fn typed<T: FromValue>(method: &'static str, result: DesktopResult) -> Result<T, ModuleError> {
    let mut path = Path::result(MODULE, method);
    let value = json_value(&result.map_err(module_error)?);
    T::from_value(value, &mut path).map_err(|error| ModuleError::new(error.message))
}

fn void(result: DesktopResult) -> Result<(), ModuleError> {
    result.map(|_| ()).map_err(module_error)
}

impl NativeGpuiWindowsSpec for WindowsModule {
    const THREAD: ModuleThread = ModuleThread::Main;

    fn new(_events: NativeGpuiWindowsEvents) -> Self {
        Self
    }

    async fn window_open(&self, options: WindowOpenOptions) -> Result<WindowHandle, ModuleError> {
        let result = on_main(move |cx| -> DesktopResult {
            let always_on_top = options.always_on_top.unwrap_or(false);
            let on_all_workspaces = options.visible_on_all_workspaces.unwrap_or(false);
            let open = windows::OpenWindowOptions {
                component: options.component,
                props: options
                    .props
                    .map(value_json)
                    .filter(|value| value.is_object()),
                title: options.title,
                width: options.width.map(|value| value as f32),
                height: options.height.map(|value| value as f32),
                x: options.x.map(|value| value as f32),
                y: options.y.map(|value| value as f32),
                resizable: options.resizable.unwrap_or(true),
                // The same enum the main window's `desktop.json` maps to, so
                // `transparent` and `hidden` mean one thing in both places.
                title_bar: options
                    .title_bar
                    .as_deref()
                    .map(WindowTitleBar::from_name)
                    .unwrap_or_default(),
                background: options
                    .background
                    .as_deref()
                    .map(WindowBackground::from_name)
                    .unwrap_or_default(),
                window_buttons: options.window_buttons,
                shadow: options.shadow,
                traffic_light_position: options
                    .traffic_light_position
                    .map(|position| (position.x as f32, position.y as f32)),
                role: windows::WindowRoleOverride::Secondary,
                popup: false,
                ..Default::default()
            };
            let key = windows::open_window(cx, open)?;
            // Both are requests the platform may not grant (Wayland has no
            // raise-above, and only macOS has Spaces). A window that was asked
            // for them opens anyway; `capabilities()` says what is honoured.
            if always_on_top {
                if let Err(error) = windows::set_always_on_top(cx, key, true) {
                    log::warn!("[desktop] alwaysOnTop was not applied: {error}");
                }
            }
            if on_all_workspaces {
                if let Err(error) = windows::set_visible_on_all_workspaces(cx, key, true) {
                    log::warn!("[desktop] visibleOnAllWorkspaces was not applied: {error}");
                }
            }
            Ok(serde_json::json!({ "windowId": key }))
        })
        .await?;
        typed("windowOpen", result)
    }

    async fn window_list(&self) -> Result<WindowList, ModuleError> {
        let result = on_main(|cx| windows::list_windows(cx)).await?;
        typed("windowList", result)
    }

    fn window_get_state_sync(&self, window_id: i32) -> Result<WindowState, ModuleError> {
        let state = crate::desktop::window_mirror::get(window_key(window_id))
            .ok_or_else(|| ModuleError::new(format!("window {window_id} is not open")))?;
        typed("windowGetStateSync", Ok(state))
    }

    async fn window_get_state(&self, window_id: i32) -> Result<WindowState, ModuleError> {
        let result = on_main(move |cx| windows::window_state(cx, window_key(window_id))).await?;
        typed("windowGetState", result)
    }

    async fn window_close(&self, window_id: i32, force: bool) -> Result<(), ModuleError> {
        let result = on_main(move |cx| windows::close(cx, window_key(window_id), force)).await?;
        void(result)
    }

    async fn window_focus(&self, window_id: i32) -> Result<(), ModuleError> {
        on_main(move |cx| windows::focus(cx, window_key(window_id)))
            .await?
            .map(|_| ())
            .map_err(module_error)
    }

    async fn window_set_title(&self, window_id: i32, title: String) -> Result<(), ModuleError> {
        on_main(move |cx| windows::set_title(cx, window_key(window_id), title))
            .await?
            .map(|_| ())
            .map_err(module_error)
    }

    async fn window_set_size(
        &self,
        window_id: i32,
        width: f64,
        height: f64,
    ) -> Result<(), ModuleError> {
        on_main(move |cx| windows::set_size(cx, window_key(window_id), width as f32, height as f32))
            .await?
            .map(|_| ())
            .map_err(module_error)
    }

    async fn window_set_position(&self, window_id: i32, x: f64, y: f64) -> Result<(), ModuleError> {
        on_main(move |cx| windows::set_position(cx, window_key(window_id), x as f32, y as f32))
            .await?
            .map(|_| ())
            .map_err(module_error)
    }

    async fn window_set_min_size(
        &self,
        window_id: i32,
        width: f64,
        height: f64,
    ) -> Result<(), ModuleError> {
        on_main(move |cx| {
            windows::set_min_size(cx, window_key(window_id), width as f32, height as f32)
        })
        .await?
        .map(|_| ())
        .map_err(module_error)
    }

    async fn window_set_max_size(
        &self,
        window_id: i32,
        width: f64,
        height: f64,
    ) -> Result<(), ModuleError> {
        on_main(move |cx| {
            windows::set_max_size(cx, window_key(window_id), width as f32, height as f32)
        })
        .await?
        .map(|_| ())
        .map_err(module_error)
    }

    async fn window_set_resizable(
        &self,
        window_id: i32,
        resizable: bool,
    ) -> Result<(), ModuleError> {
        on_main(move |cx| windows::set_resizable(cx, window_key(window_id), resizable))
            .await?
            .map(|_| ())
            .map_err(module_error)
    }

    async fn window_set_fullscreen(
        &self,
        window_id: i32,
        fullscreen: bool,
    ) -> Result<(), ModuleError> {
        on_main(move |cx| windows::set_fullscreen(cx, window_key(window_id), fullscreen))
            .await?
            .map(|_| ())
            .map_err(module_error)
    }

    async fn window_set_always_on_top(
        &self,
        window_id: i32,
        on_top: bool,
    ) -> Result<(), ModuleError> {
        on_main(move |cx| windows::set_always_on_top(cx, window_key(window_id), on_top))
            .await?
            .map(|_| ())
            .map_err(module_error)
    }

    async fn window_set_visible_on_all_workspaces(
        &self,
        window_id: i32,
        visible: bool,
    ) -> Result<(), ModuleError> {
        on_main(move |cx| {
            windows::set_visible_on_all_workspaces(cx, window_key(window_id), visible)
        })
        .await?
        .map(|_| ())
        .map_err(module_error)
    }

    async fn window_minimize(&self, window_id: i32) -> Result<(), ModuleError> {
        on_main(move |cx| windows::minimize(cx, window_key(window_id)))
            .await?
            .map(|_| ())
            .map_err(module_error)
    }

    async fn window_move_focus(&self, window_id: i32, backwards: bool) -> Result<(), ModuleError> {
        on_main(move |cx| windows::move_focus(cx, window_key(window_id), backwards))
            .await?
            .map(|_| ())
            .map_err(module_error)
    }

    async fn window_maximize(&self, window_id: i32) -> Result<(), ModuleError> {
        on_main(move |cx| windows::maximize(cx, window_key(window_id)))
            .await?
            .map(|_| ())
            .map_err(module_error)
    }

    async fn window_unmaximize(&self, window_id: i32) -> Result<(), ModuleError> {
        on_main(move |cx| windows::unmaximize(cx, window_key(window_id)))
            .await?
            .map(|_| ())
            .map_err(module_error)
    }

    async fn window_toggle_maximize(&self, window_id: i32) -> Result<(), ModuleError> {
        on_main(move |cx| windows::toggle_maximize(cx, window_key(window_id)))
            .await?
            .map(|_| ())
            .map_err(module_error)
    }

    async fn window_set_zoom_factor(&self, window_id: i32, factor: f64) -> Result<(), ModuleError> {
        on_main(move |cx| windows::set_zoom_factor(cx, window_key(window_id), factor as f32))
            .await?
            .map(|_| ())
            .map_err(module_error)
    }

    async fn window_set_background_color(
        &self,
        window_id: i32,
        color: f64,
    ) -> Result<(), ModuleError> {
        on_main(move |cx| windows::set_background_color(cx, window_key(window_id), color as u32))
            .await?
            .map(|_| ())
            .map_err(module_error)
    }

    async fn window_set_chrome_appearance(
        &self,
        window_id: i32,
        appearance: String,
    ) -> Result<(), ModuleError> {
        let dark = match appearance.as_str() {
            "dark" => Some(true),
            "light" => Some(false),
            _ => None,
        };
        on_main(move |cx| windows::set_chrome_appearance(cx, window_key(window_id), dark))
            .await?
            .map(|_| ())
            .map_err(module_error)
    }

    async fn window_show(&self, window_id: i32) -> Result<(), ModuleError> {
        on_main(move |cx| windows::show(cx, window_key(window_id)))
            .await?
            .map(|_| ())
            .map_err(module_error)
    }

    async fn window_hide(&self, window_id: i32) -> Result<(), ModuleError> {
        on_main(move |cx| windows::hide(cx, window_key(window_id)))
            .await?
            .map(|_| ())
            .map_err(module_error)
    }

    async fn window_start_dragging(&self, window_id: i32) -> Result<(), ModuleError> {
        on_main(move |cx| windows::start_dragging(cx, window_key(window_id)))
            .await?
            .map(|_| ())
            .map_err(module_error)
    }

    async fn window_intercept_close(&self, window_id: i32, on: bool) -> Result<(), ModuleError> {
        on_main(move |cx| -> DesktopResult {
            let key = window_key(window_id);
            let entry = cx
                .global_mut::<windows::DesktopWindowsGlobal>()
                .0
                .get_mut(key)
                .ok_or_else(|| DesktopError::not_found(format!("window {key} is not open")))?;
            entry.intercept_close = on;
            Ok(serde_json::Value::Null)
        })
        .await?
        .map(|_| ())
        .map_err(module_error)
    }

    fn add_listener(&self, _event_name: String) {}

    fn remove_listeners(&self, _count: f64) {}
}

pub fn register() {
    rn_gpui_module::register(
        crate::builtins::rn_gpui_specs::native_gpui_windows_module::<WindowsModule>(),
    );
}
