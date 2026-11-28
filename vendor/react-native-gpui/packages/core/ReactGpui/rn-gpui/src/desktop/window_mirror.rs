//! A copy of each window's state that any thread can read.
//!
//! The observers in `windows.rs` write it as a window opens, moves, resizes,
//! changes state or gains and loses focus, so a synchronous read from the JS
//! thread sees what the main thread last reported without waiting on it.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

fn mirror() -> &'static Mutex<HashMap<u32, serde_json::Map<String, Value>>> {
    static MIRROR: OnceLock<Mutex<HashMap<u32, serde_json::Map<String, Value>>>> = OnceLock::new();
    MIRROR.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Replaces a window's whole state.
pub fn set(key: u32, state: &Value) {
    if let Some(fields) = state.as_object() {
        mirror()
            .lock()
            .expect("window mirror poisoned")
            .insert(key, fields.clone());
    }
}

/// Changes some fields of a window's state, leaving the rest.
pub fn patch(key: u32, fields: &[(&str, Value)]) {
    let mut windows = mirror().lock().expect("window mirror poisoned");
    let state = windows.entry(key).or_default();
    for (name, value) in fields {
        state.insert((*name).to_string(), value.clone());
    }
}

/// What the app's state is derived from, for every known window.
pub fn facts() -> Vec<super::app_state::WindowFacts> {
    let flag = |state: &serde_json::Map<String, Value>, name: &str, default: bool| {
        state.get(name).and_then(Value::as_bool).unwrap_or(default)
    };
    mirror()
        .lock()
        .expect("window mirror poisoned")
        .values()
        .map(|state| super::app_state::WindowFacts {
            focused: flag(state, "isFocused", false),
            minimized: flag(state, "isMinimized", false),
            visible: flag(state, "isVisible", true),
        })
        .collect()
}

pub fn remove(key: u32) {
    mirror()
        .lock()
        .expect("window mirror poisoned")
        .remove(&key);
}

/// The last state reported for a window, or `None` for an unknown one.
pub fn get(key: u32) -> Option<Value> {
    let windows = mirror().lock().expect("window mirror poisoned");
    let state = windows.get(&key)?;
    if !state.contains_key("bounds") {
        return None;
    }
    let mut state = state.clone();
    state.insert("windowId".to_string(), json!(key));
    Some(Value::Object(state))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_patch_changes_only_its_fields() {
        let key = 9001;
        set(
            key,
            &json!({"bounds": {"x": 0, "y": 0, "width": 10, "height": 10}, "isFocused": false}),
        );
        patch(key, &[("isFocused", json!(true))]);
        let state = get(key).unwrap();
        assert_eq!(state["isFocused"], json!(true));
        assert_eq!(state["bounds"]["width"], json!(10));
        assert_eq!(state["windowId"], json!(key));
        remove(key);
        assert!(get(key).is_none());
    }

    #[test]
    fn a_window_with_no_bounds_is_unknown() {
        let key = 9002;
        patch(key, &[("isFocused", json!(true))]);
        assert!(get(key).is_none());
        remove(key);
    }
}
