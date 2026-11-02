//! The `GpuiShortcuts` TurboModule: how the JS registry installs its list.
//!
//! Every method is a thin wrapper over `desktop::keymap`, which owns the
//! shortcuts and the keymap rebuild. The list is the *only* thing JS sends:
//! parsing, precedence and dispatch are native, so a shortcut behaves the same
//! whether JS registered it through `useShortcut` or `Shortcut.addHandler`.

use rn_gpui_module::{FromValue, ModuleError, ModuleThread, Path, Value};

use crate::builtins::main_thread::on_main;
use crate::builtins::rn_gpui_specs::{
    NativeGpuiShortcutsEvents, NativeGpuiShortcutsSpec, ShortcutInstallResult, ShortcutSpec,
};
use crate::desktop::keymap;

const MODULE: &str = "GpuiShortcuts";

struct ShortcutsModule;

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

fn typed<T: FromValue>(method: &'static str, value: &serde_json::Value) -> Result<T, ModuleError> {
    let mut path = Path::result(MODULE, method);
    T::from_value(json_value(value), &mut path).map_err(|error| ModuleError::new(error.message))
}

impl NativeGpuiShortcutsSpec for ShortcutsModule {
    const THREAD: ModuleThread = ModuleThread::Main;

    fn new(_events: NativeGpuiShortcutsEvents) -> Self {
        Self
    }

    async fn shortcut_install(
        &self,
        shortcuts: Vec<ShortcutSpec>,
    ) -> Result<ShortcutInstallResult, ModuleError> {
        // The generated spec struct is turned back into the JSON the parser
        // reads, so there is one implementation of "what a shortcut is" and the
        // module cannot drift from `keymap::Shortcut`.
        let json = serde_json::Value::Array(
            shortcuts
                .into_iter()
                .map(|spec| {
                    serde_json::json!({
                        "id": spec.id,
                        "keys": spec.keys,
                        "scope": spec.scope,
                        "enabled": spec.enabled,
                        "allowInTextInput": spec.allow_in_text_input,
                    })
                })
                .collect(),
        );
        // Bad input is reported, not swallowed: an app that spelled a key wrong
        // has a shortcut that does not fire, and the error says which.
        let parsed = keymap::parse_shortcuts(&json).map_err(ModuleError::new)?;
        let installed = parsed.len();
        on_main(move |cx| {
            keymap::install(cx, parsed);
        })
        .await?;
        Ok(ShortcutInstallResult {
            installed: installed as f64,
        })
    }

    async fn shortcut_get(&self) -> Result<Vec<ShortcutSpec>, ModuleError> {
        let value = on_main(|cx| keymap::shortcuts_json(cx)).await?;
        typed(MODULE, &value)
    }

    fn add_listener(&self, _event_name: String) {}

    fn remove_listeners(&self, _count: f64) {}
}

pub fn register() {
    rn_gpui_module::register(
        crate::builtins::rn_gpui_specs::native_gpui_shortcuts_module::<ShortcutsModule>(),
    );
}
