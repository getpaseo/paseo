//! Shortcuts that fire while no window of the app has focus.
//!
//! They are registered with the operating system instead of GPUI's keymap, but
//! they are the same shortcuts: the same ids, the same key syntax, and a press
//! goes out as the `gpuiDesktop:shortcut` event, so the handlers and user
//! remapping of the registry apply unchanged.

use std::collections::HashMap;
use std::sync::OnceLock;

use global_hotkey::hotkey::{Code, HotKey, Modifiers};
use global_hotkey::{GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState};
use gpui::App;

use crate::desktop::keymap::Shortcut;

/// A shortcut the system would not register: another app owns the keys, or the
/// platform cannot do global shortcuts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Failure {
    pub id: String,
    pub reason: String,
}

struct Registered {
    keys: String,
    hotkey: HotKey,
}

#[derive(Default)]
struct State {
    manager: Option<GlobalHotKeyManager>,
    by_id: HashMap<String, Registered>,
    by_hotkey: HashMap<u32, String>,
}

#[derive(Default)]
struct GlobalState(State);

impl gpui::Global for GlobalState {}

/// Where a press is sent from the thread the system reports it on.
pub static PRESS_HANDLER: OnceLock<Box<dyn Fn(u32) + Send + Sync>> = OnceLock::new();

/// Makes the registered shortcuts the given ones, and says which could not be
/// registered. Must run on the main thread: macOS and Windows tie a hotkey to
/// the thread that runs the event loop.
pub fn install(cx: &mut App, shortcuts: &[Shortcut]) -> Vec<Failure> {
    let wanted: Vec<&Shortcut> = shortcuts
        .iter()
        .filter(|shortcut| shortcut.enabled && shortcut.global)
        .collect();
    // Wayland has no key grabs for a client: the desktop portal binds them.
    #[cfg(target_os = "linux")]
    if crate::desktop::capabilities::is_wayland() {
        return install_with_portal(cx, &wanted);
    }
    if wanted.is_empty() && cx.try_global::<GlobalState>().is_none() {
        return Vec::new();
    }
    if cx.try_global::<GlobalState>().is_none() {
        cx.set_global(GlobalState::default());
        GlobalHotKeyEvent::set_event_handler(Some(|event: GlobalHotKeyEvent| {
            if event.state() == HotKeyState::Pressed {
                if let Some(handler) = PRESS_HANDLER.get() {
                    handler(event.id());
                }
            }
        }));
    }
    let state = &mut cx.global_mut::<GlobalState>().0;
    let mut failures = Vec::new();

    let stale: Vec<String> = state
        .by_id
        .iter()
        .filter(|(id, registered)| {
            !wanted
                .iter()
                .any(|shortcut| &shortcut.id == *id && shortcut.keys == registered.keys)
        })
        .map(|(id, _)| id.clone())
        .collect();
    for id in stale {
        if let Some(registered) = state.by_id.remove(&id) {
            state.by_hotkey.remove(&registered.hotkey.id());
            if let Some(manager) = &state.manager {
                let _ = manager.unregister(registered.hotkey);
            }
        }
    }

    for shortcut in wanted {
        if state.by_id.contains_key(&shortcut.id) {
            continue;
        }
        let hotkey = match hotkey_for(&shortcut.keys) {
            Ok(hotkey) => hotkey,
            Err(reason) => {
                failures.push(Failure {
                    id: shortcut.id.clone(),
                    reason,
                });
                continue;
            }
        };
        if state.manager.is_none() {
            match GlobalHotKeyManager::new() {
                Ok(manager) => state.manager = Some(manager),
                Err(error) => {
                    failures.push(Failure {
                        id: shortcut.id.clone(),
                        reason: error.to_string(),
                    });
                    continue;
                }
            }
        }
        let registered = state
            .manager
            .as_ref()
            .map(|manager| manager.register(hotkey));
        match registered {
            Some(Ok(())) => {
                state.by_hotkey.insert(hotkey.id(), shortcut.id.clone());
                state.by_id.insert(
                    shortcut.id.clone(),
                    Registered {
                        keys: shortcut.keys.clone(),
                        hotkey,
                    },
                );
            }
            Some(Err(error)) => failures.push(Failure {
                id: shortcut.id.clone(),
                reason: error.to_string(),
            }),
            None => {}
        }
    }
    failures
}

/// The connection to the desktop portal, once a global shortcut needed it.
#[cfg(target_os = "linux")]
#[derive(Default)]
struct PortalGlobal(Option<crate::desktop::portal_shortcuts::Portal>);

#[cfg(target_os = "linux")]
impl gpui::Global for PortalGlobal {}

/// Asks the portal for the shortcuts, and returns the ones it can already tell
/// are impossible. A refusal from the user or the desktop arrives later, through
/// `report_failure`.
#[cfg(target_os = "linux")]
fn install_with_portal(cx: &mut App, wanted: &[&Shortcut]) -> Vec<Failure> {
    use crate::desktop::portal_shortcuts::{self, Binding};

    if wanted.is_empty() && cx.try_global::<PortalGlobal>().is_none() {
        return Vec::new();
    }
    if cx.try_global::<PortalGlobal>().is_none() {
        cx.set_global(PortalGlobal::default());
    }
    if cx.global::<PortalGlobal>().0.is_none() {
        match portal_shortcuts::start(&crate::desktop::snapshot_app_id()) {
            Ok(portal) => cx.global_mut::<PortalGlobal>().0 = Some(portal),
            Err(reason) => {
                return wanted
                    .iter()
                    .map(|shortcut| Failure {
                        id: shortcut.id.clone(),
                        reason: reason.clone(),
                    })
                    .collect()
            }
        }
    }
    let mut failures = Vec::new();
    let mut bindings = Vec::new();
    for shortcut in wanted {
        match portal_trigger(&shortcut.keys) {
            Ok(trigger) => bindings.push(Binding {
                id: shortcut.id.clone(),
                description: shortcut.id.clone(),
                trigger,
            }),
            Err(reason) => failures.push(Failure {
                id: shortcut.id.clone(),
                reason,
            }),
        }
    }
    if let Some(portal) = &cx.global::<PortalGlobal>().0 {
        portal.set(bindings);
    }
    failures
}

/// Sends a failure the portal reported after the fact to the app.
pub fn report_failure(cx: &mut App, id: &str, reason: &str) {
    let Some(store) = crate::store::store_from(cx) else {
        return;
    };
    let host = store.read(cx).host.clone();
    host.emit_device_event_json(
        "gpuiDesktop:shortcutFailure",
        &serde_json::json!({ "id": id, "reason": reason }).to_string(),
    );
}

/// Sends the shortcut with this id, which the portal reported pressed.
pub fn fire_named(cx: &mut App, id: &str) {
    crate::desktop::keymap::emit_app_shortcut(cx, id, None);
}

/// A shortcut's keys in the portal's spelling: modifiers in capitals joined by
/// `+`, then the key's X keysym name, as in `ALT+space` or `CTRL+SHIFT+k`.
pub fn portal_trigger(keys: &str) -> Result<String, String> {
    if keys.split_whitespace().count() > 1 {
        return Err("a global shortcut cannot be a chord".to_string());
    }
    let keystroke = gpui::Keystroke::parse_with_os(keys, crate::desktop::keymap::host_os())
        .map_err(|error| error.to_string())?;
    if keystroke.modifiers.function {
        return Err("a global shortcut cannot use the fn key".to_string());
    }
    let key = keysym_for(&keystroke.key)
        .ok_or_else(|| format!("{:?} cannot be the key of a global shortcut", keystroke.key))?;
    let mut parts = Vec::new();
    if keystroke.modifiers.control {
        parts.push("CTRL".to_string());
    }
    if keystroke.modifiers.alt {
        parts.push("ALT".to_string());
    }
    if keystroke.modifiers.shift {
        parts.push("SHIFT".to_string());
    }
    if keystroke.modifiers.platform {
        parts.push("LOGO".to_string());
    }
    let function_key = matches!(keystroke.key.as_bytes(), [b'f', b'1'..=b'9', ..]);
    if parts.is_empty() && !function_key {
        return Err("a global shortcut needs a modifier key".to_string());
    }
    parts.push(key);
    Ok(parts.join("+"))
}

fn keysym_for(key: &str) -> Option<String> {
    let key = key.to_ascii_lowercase();
    if let [letter @ b'a'..=b'z'] | [letter @ b'0'..=b'9'] = key.as_bytes() {
        return Some((*letter as char).to_string());
    }
    if let Some(number) = key.strip_prefix('f').and_then(|n| n.parse::<usize>().ok()) {
        return (1..=24).contains(&number).then(|| format!("F{number}"));
    }
    Some(
        match key.as_str() {
            "space" => "space",
            "enter" => "Return",
            "tab" => "Tab",
            "escape" => "Escape",
            "backspace" => "BackSpace",
            "delete" => "Delete",
            "left" => "Left",
            "right" => "Right",
            "up" => "Up",
            "down" => "Down",
            "home" => "Home",
            "end" => "End",
            "pageup" => "Page_Up",
            "pagedown" => "Page_Down",
            "-" => "minus",
            "=" => "equal",
            "[" => "bracketleft",
            "]" => "bracketright",
            ";" => "semicolon",
            "'" => "apostrophe",
            "," => "comma",
            "." => "period",
            "/" => "slash",
            "\\" => "backslash",
            "`" => "grave",
            _ => return None,
        }
        .to_string(),
    )
}

/// Sends the shortcut a system hotkey press belongs to.
pub fn fire(cx: &mut App, hotkey: u32) {
    let id = cx
        .try_global::<GlobalState>()
        .and_then(|state| state.0.by_hotkey.get(&hotkey).cloned());
    if let Some(id) = id {
        crate::desktop::keymap::emit_app_shortcut(cx, &id, None);
    }
}

/// The system hotkey for GPUI keystroke text such as `alt-space`.
fn hotkey_for(keys: &str) -> Result<HotKey, String> {
    if keys.split_whitespace().count() > 1 {
        return Err("a global shortcut cannot be a chord".to_string());
    }
    let keystroke = gpui::Keystroke::parse_with_os(keys, crate::desktop::keymap::host_os())
        .map_err(|error| error.to_string())?;
    let mut modifiers = Modifiers::empty();
    if keystroke.modifiers.control {
        modifiers |= Modifiers::CONTROL;
    }
    if keystroke.modifiers.alt {
        modifiers |= Modifiers::ALT;
    }
    if keystroke.modifiers.shift {
        modifiers |= Modifiers::SHIFT;
    }
    if keystroke.modifiers.platform {
        modifiers |= Modifiers::META;
    }
    if keystroke.modifiers.function {
        return Err("a global shortcut cannot use the fn key".to_string());
    }
    let code = code_for(&keystroke.key)
        .ok_or_else(|| format!("{:?} cannot be the key of a global shortcut", keystroke.key))?;
    let function_key = matches!(keystroke.key.as_bytes(), [b'f', b'1'..=b'9', ..]);
    if modifiers.is_empty() && !function_key {
        return Err("a global shortcut needs a modifier key".to_string());
    }
    Ok(HotKey::new(
        (!modifiers.is_empty()).then_some(modifiers),
        code,
    ))
}

fn code_for(key: &str) -> Option<Code> {
    use Code::*;
    const LETTERS: [Code; 26] = [
        KeyA, KeyB, KeyC, KeyD, KeyE, KeyF, KeyG, KeyH, KeyI, KeyJ, KeyK, KeyL, KeyM, KeyN, KeyO,
        KeyP, KeyQ, KeyR, KeyS, KeyT, KeyU, KeyV, KeyW, KeyX, KeyY, KeyZ,
    ];
    const DIGITS: [Code; 10] = [
        Digit0, Digit1, Digit2, Digit3, Digit4, Digit5, Digit6, Digit7, Digit8, Digit9,
    ];
    const FUNCTION_KEYS: [Code; 24] = [
        F1, F2, F3, F4, F5, F6, F7, F8, F9, F10, F11, F12, F13, F14, F15, F16, F17, F18, F19, F20,
        F21, F22, F23, F24,
    ];
    let key = key.to_ascii_lowercase();
    if let [letter @ b'a'..=b'z'] = key.as_bytes() {
        return Some(LETTERS[usize::from(letter - b'a')]);
    }
    if let [digit @ b'0'..=b'9'] = key.as_bytes() {
        return Some(DIGITS[usize::from(digit - b'0')]);
    }
    if let Some(number) = key.strip_prefix('f').and_then(|n| n.parse::<usize>().ok()) {
        return FUNCTION_KEYS.get(number.checked_sub(1)?).copied();
    }
    Some(match key.as_str() {
        "space" => Space,
        "enter" => Enter,
        "tab" => Tab,
        "escape" => Escape,
        "backspace" => Backspace,
        "delete" => Delete,
        "left" => ArrowLeft,
        "right" => ArrowRight,
        "up" => ArrowUp,
        "down" => ArrowDown,
        "home" => Home,
        "end" => End,
        "pageup" => PageUp,
        "pagedown" => PageDown,
        "-" => Minus,
        "=" => Equal,
        "[" => BracketLeft,
        "]" => BracketRight,
        ";" => Semicolon,
        "'" => Quote,
        "," => Comma,
        "." => Period,
        "/" => Slash,
        "\\" => Backslash,
        "`" => Backquote,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_keystroke_becomes_a_system_hotkey() {
        let hotkey = hotkey_for("alt-space").unwrap();
        assert_eq!(hotkey, HotKey::new(Some(Modifiers::ALT), Code::Space));
        let hotkey = hotkey_for("ctrl-shift-k").unwrap();
        assert_eq!(
            hotkey,
            HotKey::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyK)
        );
    }

    #[test]
    fn a_keystroke_is_spelled_the_way_the_portal_asks() {
        assert_eq!(portal_trigger("alt-space").unwrap(), "ALT+space");
        assert_eq!(portal_trigger("ctrl-shift-k").unwrap(), "CTRL+SHIFT+k");
        assert_eq!(portal_trigger("super-f5").unwrap(), "LOGO+F5");
        assert_eq!(portal_trigger("f5").unwrap(), "F5");
        assert_eq!(portal_trigger("alt-pageup").unwrap(), "ALT+Page_Up");
        assert!(portal_trigger("k").unwrap_err().contains("modifier"));
        assert!(portal_trigger("ctrl-k ctrl-s")
            .unwrap_err()
            .contains("chord"));
    }

    #[test]
    fn what_a_system_cannot_register_is_refused_with_a_reason() {
        assert!(hotkey_for("secondary-k secondary-s")
            .unwrap_err()
            .contains("chord"));
        assert!(hotkey_for("k").unwrap_err().contains("modifier"));
        assert!(hotkey_for("fn-k").is_err());
        assert!(hotkey_for("f5").is_ok());
    }
}
