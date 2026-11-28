//! `Settings`: a persistent key-value store in a JSON file in the app's data
//! directory.

use std::path::PathBuf;

use rn_gpui_module::{ModuleError, ModuleThread, Value};
use serde_json::Map;

use crate::builtins::rn_gpui_specs::{
    NativeSettingsManagerEvents, NativeSettingsManagerSpec, SettingsConstants,
};

struct SettingsModule;

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

fn settings_path() -> PathBuf {
    let app_id = crate::desktop::snapshot_app_id();
    let safe_id = crate::desktop::app_dir::safe_id(&app_id);
    #[cfg(feature = "visual-capture")]
    if let Some(window_state) = std::env::var_os("RN_GPUI_WINDOW_STATE") {
        return PathBuf::from(window_state).with_extension("settings.json");
    }
    crate::desktop::app_dir::app_dir().join(format!("{safe_id}-settings.json"))
}

fn load() -> Map<String, serde_json::Value> {
    std::fs::read_to_string(settings_path())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn update(change: impl FnOnce(&mut Map<String, serde_json::Value>)) {
    let mut settings = load();
    change(&mut settings);
    let path = settings_path();
    let saved = path
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|()| {
            let temporary = path.with_extension("json.tmp");
            std::fs::write(&temporary, serde_json::Value::Object(settings).to_string())?;
            std::fs::rename(&temporary, &path)
        });
    if let Err(error) = saved {
        log::warn!("Settings: could not save: {error}");
    }
}

impl NativeSettingsManagerSpec for SettingsModule {
    const THREAD: ModuleThread = ModuleThread::Own;

    fn new(_events: NativeSettingsManagerEvents) -> Self {
        Self
    }

    fn get_constants(&self) -> Result<SettingsConstants, ModuleError> {
        Ok(SettingsConstants {
            settings: json_value(&serde_json::Value::Object(load())),
        })
    }

    fn set_values(&self, values: Value) {
        if let serde_json::Value::Object(values) = value_json(values) {
            update(|settings| settings.extend(values));
        }
    }

    fn delete_values(&self, keys: Vec<String>) {
        update(|settings| {
            for key in keys {
                settings.remove(&key);
            }
        });
    }
}

pub fn register() {
    rn_gpui_module::register(
        crate::builtins::rn_gpui_specs::native_settings_manager_module::<SettingsModule>(),
    );
}
