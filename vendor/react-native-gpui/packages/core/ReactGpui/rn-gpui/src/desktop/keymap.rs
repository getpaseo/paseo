//! Keyboard shortcuts, as ordinary keymap bindings.
//!
//! `useShortcut('mod+s', …)` in JS becomes one `KeyBinding` here, and a
//! `<ShortcutScope>` becomes a `key_context` on the element core already builds
//! for that node. Nothing intercepts keystrokes: the binding is resolved by
//! GPUI's own keymap, from the focused element's dispatch path, so
//!
//! * a shortcut consumes the key *before* a `TextInput`'s input handler sees
//!   it (`window.rs` `dispatch_keystroke` only reaches the handler when
//!   `cx.propagate_event` is still true),
//! * a binding in a deeper scope outranks one in a shallower scope
//!   (`keymap.rs` `binding_enabled` returns the depth the predicate matched at,
//!   and `bindings_for_input` sorts by depth),
//! * an inner scope can override an outer one, because every matching binding
//!   is returned in precedence order and dispatched until one stops
//!   propagation.
//!
//! A menu accelerator is then just another binding — in the app-wide context —
//! so a component can beat it, which the old `intercept_keystrokes` path could
//! never allow.

use gpui::{Action, App, KeyBinding};
use serde_json::{json, Value};

use crate::store::store_from;

/// The key context a `TextInput` puts on its element. A shortcut that does not
/// ask for `allowInTextInput` excludes itself with `!rn-text-input`.
pub const TEXT_INPUT_CONTEXT: &str = "rn-text-input";

/// The context the window root carries, so an app-scope shortcut can match with
/// nothing focused.
///
/// This is not decoration. `KeyBindingContextPredicate::eval_inner` returns
/// false for an *empty* context stack before it ever reaches a `Not`, so a
/// binding like `!rn-text-input` matches nothing when the focus path produces no
/// contexts at all — which is exactly the state a key arrives in when the window
/// has no focused element. A positive identifier on the root gives every key a
/// context to match against, and it is the weakest one the keymap can have,
/// which is what "the window scope may be overridden" means.
pub const APP_CONTEXT: &str = "rn-app";

/// Prefix for a scope's context, so a scope named `save` cannot collide with a
/// context core or a library already uses.
const SCOPE_PREFIX: &str = "rn-scope-";

/// One shortcut, as JS declares it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Shortcut {
    /// The stable name a handler is registered under, e.g. `file.save`.
    pub id: String,
    /// GPUI keystroke text, already normalised: `secondary-s`, or
    /// `secondary-k secondary-s` for a chord.
    pub keys: String,
    /// The `ShortcutScope` it belongs to, or `None` for the window/app scope.
    pub scope: Option<String>,
    pub enabled: bool,
    pub allow_in_text_input: bool,
}

impl Shortcut {
    /// Whether `keystroke` is the (first, for a chord) key this shortcut binds.
    pub fn key_matches(&self, keystroke: &gpui::Keystroke) -> bool {
        match gpui::Keystroke::parse(&self.keys) {
            Ok(parsed) => parsed.should_match(&gpui::KeybindingKeystroke::from_keystroke(
                keystroke.clone(),
            )),
            Err(_) => false,
        }
    }

    /// The context predicate this shortcut's bindings carry.
    ///
    /// `depth_of` returns the deepest prefix of the context stack the predicate
    /// matches, which is what gives an inner scope precedence over an outer one.
    /// A shortcut outside a text input appends `!rn-text-input`: `Not` scans the
    /// whole stack, so it fails whenever a text input is anywhere on the focus
    /// path — the inner editing keys keep the key and no binding consumes it.
    pub fn context(&self) -> String {
        let scope = self.scope.as_deref().map(scope_context);
        match (scope, self.allow_in_text_input) {
            (Some(scope), false) => format!("{scope} && !{TEXT_INPUT_CONTEXT}"),
            (Some(scope), true) => scope,
            (None, false) => format!("{APP_CONTEXT} && !{TEXT_INPUT_CONTEXT}"),
            // The window/app scope. `rn-app` is on the window root, so this
            // matches with nothing focused — and it is the shallowest context,
            // so every scope overrides it.
            (None, true) => APP_CONTEXT.to_string(),
        }
    }
}

/// The `KeyContext` identifier for a scope name.
///
/// GPUI identifiers are alphanumeric, `_` and `-` (`keymap/context.rs`
/// `is_identifier_char`), so a name with anything else is folded to `-`. The
/// prefix keeps a scope from shadowing a context somebody else defines.
pub fn scope_context(name: &str) -> String {
    let mut out = String::with_capacity(SCOPE_PREFIX.len() + name.len());
    out.push_str(SCOPE_PREFIX);
    for character in name.chars() {
        if character.is_alphanumeric() || character == '_' {
            out.push(character);
        } else {
            out.push('-');
        }
    }
    out
}

/// Parses a JS shortcut spec into GPUI keystroke text.
///
/// One key is a `+`-separated list of modifiers and a key; a chord is those
/// separated by whitespace. The result folds the spellings JS uses onto the ones
/// GPUI parses, so `mod` works on every platform and `ArrowLeft` means the same
/// as `left`.
pub fn parse_shortcut(spec: &str) -> Result<String, String> {
    let spec = spec.trim();
    if spec.is_empty() {
        return Err("a shortcut cannot be empty".to_string());
    }
    let mut chord = Vec::new();
    for key in spec.split_whitespace() {
        chord.push(parse_key(key)?);
    }
    Ok(chord.join(" "))
}

/// One keystroke of a chord, e.g. `mod+shift+k` -> `secondary-shift-k`.
fn parse_key(key: &str) -> Result<String, String> {
    let mut parts: Vec<&str> = key.split('+').map(str::trim).collect();
    let key_name = parts
        .pop()
        .filter(|part| !part.is_empty())
        .ok_or_else(|| format!("invalid shortcut key: {key}"))?;
    // `mod++` means the plus key; the split above turned it into an empty last
    // part, so put the character back.
    let key_name = if key_name.is_empty() { "+" } else { key_name };

    // A modifier listed twice is one modifier; `mod` and `ctrl` on Linux are the
    // same key, so they collapse too.
    let mut modifiers: Vec<&'static str> = Vec::new();
    for part in parts {
        if part.is_empty() {
            // `cmd++` again: the trailing `+` is part of the key, not a
            // separator, so this is only an error when the key is not `+`.
            if key_name == "+" {
                continue;
            }
            return Err(format!("invalid shortcut key: {key}"));
        }
        let modifier = match part.to_ascii_lowercase().as_str() {
            // `mod` is Command on macOS and Control elsewhere, which is what
            // GPUI's `secondary` already means.
            "mod" | "cmdorctrl" | "commandorcontrol" | "cmdorcontrol" | "secondary" => "secondary",
            "cmd" | "command" | "super" | "meta" | "win" => "cmd",
            "ctrl" | "control" => "ctrl",
            "alt" | "option" | "opt" => "alt",
            "shift" => "shift",
            other => return Err(format!("unknown shortcut modifier: {other}")),
        };
        if !modifiers.contains(&modifier) {
            modifiers.push(modifier);
        }
    }

    let key = normalise_key(key_name).ok_or_else(|| format!("unknown shortcut key: {key_name}"))?;

    let mut out = String::new();
    // `secondary` first so a binding reads the way it is written, then the rest in
    // a fixed order: two spellings of the same chord must produce one string, or
    // the same shortcut would be installed twice.
    for modifier in ["secondary", "cmd", "ctrl", "alt", "shift", "fn"] {
        if modifiers.contains(&modifier) {
            out.push_str(modifier);
            out.push('-');
        }
    }
    out.push_str(&key);
    Ok(out)
}

/// The GPUI key name for a JS or Electron spelling.
///
/// GPUI keeps the lower-case name (`keystroke.key`) and only compares it; the
/// web names in `onKeyDown` are produced separately, in `normalise_web_key`.
fn normalise_key(token: &str) -> Option<String> {
    let lower = token.to_ascii_lowercase();
    if token.chars().count() == 1 {
        let character = token.chars().next()?;
        if character.is_ascii_alphanumeric() {
            return Some(lower);
        }
        // Punctuation goes through as-is: GPUI parses it back, and `-` is
        // handled by its own splitting rule.
        return Some(character.to_string());
    }
    let named = match lower.as_str() {
        "enter" | "return" => "enter",
        "escape" | "esc" => "escape",
        "tab" => "tab",
        "space" | "spacebar" | " " => "space",
        "backspace" => "backspace",
        "delete" | "del" => "delete",
        "insert" | "ins" => "insert",
        "up" | "arrowup" => "up",
        "down" | "arrowdown" => "down",
        "left" | "arrowleft" => "left",
        "right" | "arrowright" => "right",
        "home" => "home",
        "end" => "end",
        "pageup" | "page-up" => "pageup",
        "pagedown" | "page-down" => "pagedown",
        "comma" => ",",
        "period" | "dot" => ".",
        "slash" => "/",
        "backslash" => "\\",
        "semicolon" => ";",
        "quote" | "apostrophe" => "'",
        "backquote" => "`",
        "bracketleft" => "[",
        "bracketright" => "]",
        "minus" => "-",
        "plus" => "+",
        "equal" => "=",
        _ => {
            // Function keys, `f1`..`f24`. GPUI has no list of valid names, so this
            // only has to agree with what the platform reports.
            if let Some(number) = lower.strip_prefix('f') {
                if let Ok(number) = number.parse::<u8>() {
                    if (1..=24).contains(&number) {
                        return Some(format!("f{number}"));
                    }
                }
            }
            return None;
        }
    };
    Some(named.to_string())
}

/// The web `key` name for a GPUI key, so `onKeyDown` reports `ArrowLeft` and
/// not `left`.
///
/// `event.key` in the DOM is a single printable character for printable keys or
/// one of the named values; `Shift+A` is `"A"`, which needs the modifiers to say.
pub fn normalise_web_key(key: &str, shift: bool) -> String {
    let named = match key {
        "enter" => "Enter",
        "escape" => "Escape",
        "tab" => "Tab",
        "space" => " ",
        "backspace" => "Backspace",
        "delete" => "Delete",
        "insert" => "Insert",
        "up" => "ArrowUp",
        "down" => "ArrowDown",
        "left" => "ArrowLeft",
        "right" => "ArrowRight",
        "home" => "Home",
        "end" => "End",
        "pageup" => "PageUp",
        "pagedown" => "PageDown",
        // `capslock` and friends: capitalise the first letter so a DOM consumer
        // sees `CapsLock` rather than the GPUI spelling.
        other => {
            if other.chars().count() == 1 {
                let character = other.chars().next().unwrap_or_default();
                return if shift {
                    character.to_uppercase().to_string()
                } else {
                    character.to_string()
                };
            }
            let mut characters = other.chars();
            return match characters.next() {
                Some(first) => first.to_uppercase().collect::<String>() + characters.as_str(),
                None => String::new(),
            };
        }
    };
    named.to_string()
}

/// The DOM `code` for a GPUI key: the physical key, independent of layout and
/// of Shift.
pub fn web_code(key: &str) -> String {
    match key {
        "enter" => "Enter".to_string(),
        "escape" => "Escape".to_string(),
        "tab" => "Tab".to_string(),
        "space" => "Space".to_string(),
        "backspace" => "Backspace".to_string(),
        "delete" => "Delete".to_string(),
        "insert" => "Insert".to_string(),
        "up" => "ArrowUp".to_string(),
        "down" => "ArrowDown".to_string(),
        "left" => "ArrowLeft".to_string(),
        "right" => "ArrowRight".to_string(),
        "home" => "Home".to_string(),
        "end" => "End".to_string(),
        "pageup" => "PageUp".to_string(),
        "pagedown" => "PageDown".to_string(),
        other => {
            if other.chars().count() == 1 {
                let character = other.chars().next().unwrap_or_default();
                return match character {
                    'a'..='z' => format!("Key{}", character.to_ascii_uppercase()),
                    'A'..='Z' => format!("Key{}", character.to_ascii_uppercase()),
                    '0'..='9' => format!("Digit{character}"),
                    ' ' => "Space".to_string(),
                    ',' => "Comma".to_string(),
                    '.' => "Period".to_string(),
                    '/' => "Slash".to_string(),
                    '\\' => "Backslash".to_string(),
                    ';' => "Semicolon".to_string(),
                    '\'' => "Quote".to_string(),
                    '`' => "Backquote".to_string(),
                    '[' => "BracketLeft".to_string(),
                    ']' => "BracketRight".to_string(),
                    '-' => "Minus".to_string(),
                    '=' => "Equal".to_string(),
                    // Not a physical key name the DOM defines; an empty string is
                    // what the DOM reports for a key it cannot name.
                    _ => String::new(),
                };
            }
            if let Some(number) = other.strip_prefix('f') {
                if number.parse::<u8>().is_ok() {
                    return format!("F{number}");
                }
            }
            String::new()
        }
    }
}

/// The legacy `keyCode` for a GPUI key, or 0 when the DOM has none.
pub fn key_code(key: &str) -> u32 {
    match key {
        "backspace" => 8,
        "tab" => 9,
        "enter" => 13,
        "escape" => 27,
        "space" => 32,
        "pageup" => 33,
        "pagedown" => 34,
        "end" => 35,
        "home" => 36,
        "left" => 37,
        "up" => 38,
        "right" => 39,
        "down" => 40,
        "insert" => 45,
        "delete" => 46,
        other => {
            if key.len() == 1 {
                let character = key.as_bytes()[0];
                if character.is_ascii_lowercase() {
                    return u32::from(character.to_ascii_uppercase());
                }
                if character.is_ascii_digit() {
                    return u32::from(character);
                }
            }
            if let Some(number) = other.strip_prefix('f') {
                if let Ok(number) = number.parse::<u32>() {
                    if (1..=24).contains(&number) {
                        return 111 + number;
                    }
                }
            }
            // Punctuation: the DOM's `keyCode` is the ASCII code for the
            // unshifted character, which is what we already have.
            other
                .chars()
                .next()
                .filter(|character| character.is_ascii())
                .map(|character| u32::from(character as u8))
                .unwrap_or(0)
        }
    }
}

/// The shortcuts in a JSON array, as `GpuiShortcuts` installs them.
///
/// A malformed entry is skipped with a log line rather than failing the whole
/// install: one bad shortcut must not leave an app with no working keys.
pub fn parse_shortcuts(value: &Value) -> Result<Vec<Shortcut>, String> {
    let array = value
        .as_array()
        .ok_or_else(|| "shortcuts must be an array".to_string())?;
    let mut shortcuts = Vec::with_capacity(array.len());
    for entry in array {
        let Some(object) = entry.as_object() else {
            log::warn!("[shortcut] skipped a shortcut that is not an object");
            continue;
        };
        let Some(id) = object.get("id").and_then(Value::as_str) else {
            log::warn!("[shortcut] skipped a shortcut with no `id`");
            continue;
        };
        let Some(keys) = object.get("keys").and_then(Value::as_str) else {
            log::warn!("[shortcut] {id} has no `keys`; skipped");
            continue;
        };
        let keys = match parse_shortcut(keys) {
            Ok(keys) => keys,
            Err(error) => {
                log::warn!("[shortcut] {id} has invalid keys: {error}");
                continue;
            }
        };
        shortcuts.push(Shortcut {
            id: id.to_string(),
            keys,
            scope: object
                .get("scope")
                .and_then(Value::as_str)
                .map(str::to_string),
            enabled: object
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            allow_in_text_input: object
                .get("allowInTextInput")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        });
    }
    Ok(shortcuts)
}

/// The installed shortcuts as JSON, which is what `shortcutGet` answers with.
pub fn shortcuts_json(cx: &App) -> Value {
    Value::Array(
        shortcuts(cx)
            .into_iter()
            .map(|shortcut| {
                json!({
                    "id": shortcut.id,
                    "keys": shortcut.keys,
                    "scope": shortcut.scope,
                    "enabled": shortcut.enabled,
                    "allowInTextInput": shortcut.allow_in_text_input,
                })
            })
            .collect(),
    )
}

/// A shortcut's action, carrying the id JS registered it under.
#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = rn_gpui_shortcut, no_json, no_register)]
pub struct ShortcutAction {
    pub id: String,
}

/// The installed shortcut list, and what the keymap was last built from.
pub struct ShortcutState {
    shortcuts: Vec<Shortcut>,
    /// The signature the current keymap bindings were built from. Rebuilding is
    /// only worth doing when this changes: a re-render must not thrash the
    /// keymap.
    built: String,
    /// A rebuild was asked for and a deferred one is already waiting.
    scheduled: bool,
}

impl Default for ShortcutState {
    fn default() -> Self {
        Self {
            shortcuts: Vec::new(),
            built: String::new(),
            scheduled: false,
        }
    }
}

pub struct ShortcutGlobal(pub ShortcutState);
impl gpui::Global for ShortcutGlobal {}

impl Default for ShortcutGlobal {
    fn default() -> Self {
        Self(ShortcutState::default())
    }
}

/// Installs a shortcut list, rebuilding the keymap only if it changed.
///
/// `scope_tags` is the set of mounted scope tags in the focused surface: a
/// binding is only useful where its scope element exists, so this is part of the
/// signature that decides whether to rebuild.
pub fn install(cx: &mut App, shortcuts: Vec<Shortcut>) {
    let signature = signature(&shortcuts);
    let state = &mut ensure_global(cx).0;
    if state.built == signature {
        return;
    }
    state.shortcuts = shortcuts;
    schedule_rebuild(cx);
}

/// The shortcuts currently installed.
pub fn shortcuts(cx: &App) -> Vec<Shortcut> {
    cx.try_global::<ShortcutGlobal>()
        .map(|state| state.0.shortcuts.clone())
        .unwrap_or_default()
}

/// The ids that belong to `scope` (or to no scope, when `scope` is `None`).
pub fn ids_in_scope(cx: &App, scope: Option<&str>) -> Vec<String> {
    shortcuts(cx)
        .into_iter()
        .filter(|shortcut| shortcut.enabled && shortcut.scope.as_deref() == scope)
        .map(|shortcut| shortcut.id)
        .collect()
}

/// Whether `id` is installed and enabled anywhere, so a `window`-scope action
/// from an element can be told apart from one it should pass on.
pub fn is_installed(cx: &App, id: &str) -> bool {
    cx.try_global::<ShortcutGlobal>().is_some_and(|state| {
        state
            .0
            .shortcuts
            .iter()
            .any(|shortcut| shortcut.enabled && shortcut.id == id)
    })
}

/// Whether a scoped shortcut would consume `keystroke` from the focused element.
///
/// Used by the menu interceptor, which runs before the keymap is consulted: it
/// has to know whether a shortcut outranks the menu accelerator it is about to
/// handle, or it would take the key away from a shortcut that is entitled to it.
///
/// `window.context_stack()` is the public way to ask what the focused element's
/// context is, so the precedence is evaluated here the same way
/// `Keymap::bindings_for_input` does it: deepest matching context first, later
/// bindings before earlier ones.
///
/// Only a *scoped* binding counts. An app-scope shortcut and a menu accelerator
/// both live in the window root's context, where the menu keeps the key — which
/// is what it did before this work, so nothing changes for the window scope.
pub fn claims_keystroke(cx: &App, window: &gpui::Window, keystroke: &gpui::Keystroke) -> bool {
    let stack = window.context_stack();
    // The menu accelerator this key would trigger is in the app context, which
    // is the shallowest one. A shortcut that matches at a greater depth wins the
    // key; a tie does not, so the menu keeps its behaviour there.
    let app_depth = gpui::KeyBindingContextPredicate::parse(APP_CONTEXT)
        .ok()
        .and_then(|predicate| predicate.depth_of(&stack))
        .unwrap_or(0);
    shortcuts(cx).iter().any(|shortcut| {
        if !shortcut.enabled || shortcut.scope.is_none() {
            return false;
        }
        // The shortcut's *own* context, not a guessed one: a shortcut that opted
        // into text inputs has no `!rn-text-input`, and evaluating anything else
        // here would let an Edit-menu accelerator keep a key the shortcut is
        // entitled to (`mod+a` and `selectAll` are exactly that pair).
        let Some(depth) = gpui::KeyBindingContextPredicate::parse(&shortcut.context())
            .ok()
            .and_then(|predicate| predicate.depth_of(&stack))
        else {
            return false;
        };
        depth > app_depth && shortcut.key_matches(keystroke)
    })
}

/// Whether the shortcut `id` belongs to `scope`, so a scope element knows if an
/// action reaching it is its own or should be passed outward.
pub fn scope_owns(cx: &App, scope: &str, id: &str) -> bool {
    cx.try_global::<ShortcutGlobal>().is_some_and(|state| {
        state.0.shortcuts.iter().any(|shortcut| {
            shortcut.enabled && shortcut.id == id && shortcut.scope.as_deref() == Some(scope)
        })
    })
}

/// Sends `topShortcut` to `tag`, which is the JS node for the scope that owns
/// the action.
pub fn dispatch_to(cx: &mut App, tag: i32, id: &str, window: Option<&mut gpui::Window>) {
    let Some(store) = store_from(cx) else {
        return;
    };
    let host = store.read(cx).host.clone();
    host.dispatch_event(tag, "topShortcut", &json!({ "id": id }));
    if let Some(window) = window {
        store.read(cx).frame_hook.arm(window);
    }
}

/// Sends `gpuiDesktop:shortcut` for a shortcut with no scope element, which is
/// the window/app scope and any shortcut whose scope has not mounted.
fn emit_app_shortcut(cx: &mut App, id: &str, scope: Option<&str>) {
    let Some(store) = store_from(cx) else {
        return;
    };
    let host = store.read(cx).host.clone();
    host.emit_device_event_json(
        "gpuiDesktop:shortcut",
        &json!({ "id": id, "scope": scope }).to_string(),
    );
}

fn ensure_global(cx: &mut App) -> &mut ShortcutGlobal {
    if cx.try_global::<ShortcutGlobal>().is_none() {
        cx.set_global(ShortcutGlobal::default());
    }
    cx.global_mut::<ShortcutGlobal>()
}

/// A stable description of a shortcut list, so an unchanged list costs nothing.
fn signature(shortcuts: &[Shortcut]) -> String {
    let mut rows: Vec<String> = shortcuts
        .iter()
        .map(|shortcut| {
            format!(
                "{}|{}|{}|{}|{}",
                shortcut.id,
                shortcut.keys,
                shortcut.scope.as_deref().unwrap_or(""),
                shortcut.enabled,
                shortcut.allow_in_text_input
            )
        })
        .collect();
    // Order is not meaning: two lists with the same shortcuts are the same
    // keymap, whichever order JS happened to register them in. Sorted so a
    // re-render that reorders the array does not rebuild.
    rows.sort();
    rows.join("\n")
}

/// Rebuilds once the current update has finished.
///
/// Debounced because a render pass can install shortcuts several times — a
/// mount batch, a props update, a user keymap change — and each rebuild clears
/// and re-adds every binding in the app.
///
/// Deferred on the app, not on a window's next frame: GPUI runs a window's
/// next-frame callbacks from the platform's frame request, and a hidden or
/// offscreen window (every e2e window on Windows) never gets one, so the
/// bindings would never be installed.
fn schedule_rebuild(cx: &mut App) {
    if cx
        .try_global::<ShortcutGlobal>()
        .is_some_and(|state| state.0.scheduled)
    {
        return;
    }
    ensure_global(cx).0.scheduled = true;
    cx.defer(|cx| {
        if cx
            .try_global::<ShortcutGlobal>()
            .is_some_and(|state| state.0.scheduled)
        {
            rebuild_now(cx);
        }
    });
}

/// Replaces every `ShortcutAction` binding in the keymap with the current list.
fn rebuild_now(cx: &mut App) {
    let shortcuts = cx
        .try_global::<ShortcutGlobal>()
        .map(|state| state.0.shortcuts.clone())
        .unwrap_or_default();
    let signature = signature(&shortcuts);

    // `Keymap` has no per-binding removal, so the shortcut bindings are filtered
    // out and the rest put back — the same approach the menu accelerators use.
    let keymap = cx.key_bindings();
    let kept: Vec<KeyBinding> = keymap
        .borrow()
        .bindings()
        .filter(|binding| !is_shortcut_action(binding.action()))
        .cloned()
        .collect();
    {
        let mut keymap = keymap.borrow_mut();
        keymap.clear();
        keymap.add_bindings(kept);
    }

    let mut bindings = Vec::with_capacity(shortcuts.len());
    for shortcut in &shortcuts {
        if !shortcut.enabled {
            continue;
        }
        // `KeyBinding::new` panics on a malformed context, and a scope name is
        // user data, so the predicate is parsed here and a bad one skips the
        // binding rather than taking the app down.
        let predicate = {
            let context = shortcut.context();
            if context.is_empty() {
                None
            } else {
                match gpui::KeyBindingContextPredicate::parse(&context) {
                    Ok(predicate) => Some(std::rc::Rc::new(predicate)),
                    Err(error) => {
                        log::warn!(
                            "[shortcut] {} has an invalid context {context:?}: {error}",
                            shortcut.id
                        );
                        continue;
                    }
                }
            }
        };
        let Ok(binding) = KeyBinding::load(
            &shortcut.keys,
            Box::new(ShortcutAction {
                id: shortcut.id.clone(),
            }),
            predicate,
            false,
            None,
            &gpui::DummyKeyboardMapper,
        ) else {
            log::warn!(
                "[shortcut] {} has unparseable keys {:?}; skipped",
                shortcut.id,
                shortcut.keys
            );
            continue;
        };
        bindings.push(binding);
    }
    cx.bind_keys(bindings);

    let state = &mut ensure_global(cx).0;
    state.built = signature;
    state.scheduled = false;
}

fn is_shortcut_action(action: &dyn Action) -> bool {
    action.as_any().downcast_ref::<ShortcutAction>().is_some()
}

/// Installs the app-wide action handler.
///
/// This is the last stop: it runs in the bubble phase after every element on the
/// focus path had a chance to claim the action, so a scoped shortcut never
/// reaches it. Anything that does is in the window/app scope.
pub fn register(cx: &mut App) {
    ensure_global(cx);
    cx.on_action(|action: &ShortcutAction, cx: &mut App| {
        let id = action.id.clone();
        let scope = shortcuts(cx)
            .into_iter()
            .find(|shortcut| shortcut.id == id)
            .and_then(|shortcut| shortcut.scope);
        // A scoped shortcut that reached this handler has no scope element on
        // the focus path, so there is no node to report to: it goes out as the
        // device event, which the registry also listens to.
        emit_app_shortcut(cx, &id, scope.as_deref());
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::Keystroke;

    #[test]
    fn mod_is_secondary_on_every_platform() {
        // `secondary` is what GPUI maps to Command on macOS and Control
        // elsewhere, so one JS spelling works everywhere.
        assert_eq!(parse_shortcut("mod+s").unwrap(), "secondary-s");
        assert_eq!(
            parse_shortcut("CmdOrCtrl+Shift+K").unwrap(),
            "secondary-shift-k"
        );
    }

    #[test]
    fn modifier_spellings_normalise() {
        assert_eq!(parse_shortcut("Cmd+S").unwrap(), "cmd-s");
        assert_eq!(parse_shortcut("Meta+S").unwrap(), "cmd-s");
        assert_eq!(parse_shortcut("Ctrl+S").unwrap(), "ctrl-s");
        assert_eq!(parse_shortcut("Control+S").unwrap(), "ctrl-s");
        assert_eq!(parse_shortcut("Alt+S").unwrap(), "alt-s");
        assert_eq!(parse_shortcut("Option+S").unwrap(), "alt-s");
        // Order in the spec does not change the binding.
        assert_eq!(parse_shortcut("Shift+Mod+K").unwrap(), "secondary-shift-k");
        assert_eq!(parse_shortcut("mod+shift+K").unwrap(), "secondary-shift-k");
    }

    #[test]
    fn a_repeated_modifier_is_one_modifier() {
        assert_eq!(parse_shortcut("mod+mod+s").unwrap(), "secondary-s");
        assert_eq!(parse_shortcut("Shift+shift+K").unwrap(), "shift-k");
    }

    #[test]
    fn keys_fold_to_gpui_names() {
        assert_eq!(parse_shortcut("Escape").unwrap(), "escape");
        assert_eq!(parse_shortcut("Esc").unwrap(), "escape");
        assert_eq!(parse_shortcut("ArrowLeft").unwrap(), "left");
        assert_eq!(parse_shortcut("Return").unwrap(), "enter");
        assert_eq!(parse_shortcut("Space").unwrap(), "space");
        assert_eq!(parse_shortcut("PageDown").unwrap(), "pagedown");
        assert_eq!(parse_shortcut("F5").unwrap(), "f5");
        assert_eq!(parse_shortcut("Cmd+,").unwrap(), "cmd-,");
    }

    #[test]
    fn chords_keep_their_keys_in_order() {
        assert_eq!(
            parse_shortcut("mod+k mod+s").unwrap(),
            "secondary-k secondary-s"
        );
        assert_eq!(
            parse_shortcut("  ctrl+x   ctrl+y ").unwrap(),
            "ctrl-x ctrl-y"
        );
    }

    #[test]
    fn bad_shortcuts_are_rejected_rather_than_panicking() {
        assert!(parse_shortcut("").is_err());
        assert!(parse_shortcut("   ").is_err());
        assert!(parse_shortcut("Hyper+S").is_err());
        assert!(parse_shortcut("mod+UnknownKey").is_err());
        assert!(parse_shortcut("mod+f99").is_err());
    }

    #[test]
    fn a_scope_becomes_a_prefixed_context() {
        assert_eq!(scope_context("editor"), "rn-scope-editor");
        // Anything outside GPUI's identifier alphabet folds to `-`, so a scope
        // named `a.b c` cannot produce a context that fails to parse.
        assert_eq!(scope_context("a.b c"), "rn-scope-a-b-c");
        let parsed = gpui::KeyContext::parse(&scope_context("file view")).unwrap();
        assert!(parsed.contains("rn-scope-file-view"));
    }

    #[test]
    fn a_scoped_shortcut_excludes_text_inputs() {
        let shortcut = Shortcut {
            id: "file.save".to_string(),
            keys: "secondary-s".to_string(),
            scope: Some("editor".to_string()),
            enabled: true,
            allow_in_text_input: false,
        };
        assert_eq!(shortcut.context(), "rn-scope-editor && !rn-text-input");

        let allowed = Shortcut {
            allow_in_text_input: true,
            ..shortcut.clone()
        };
        assert_eq!(allowed.context(), "rn-scope-editor");
    }

    #[test]
    fn the_window_scope_has_no_predicate() {
        let shortcut = Shortcut {
            id: "app.quit".to_string(),
            keys: "secondary-q".to_string(),
            scope: None,
            enabled: true,
            allow_in_text_input: true,
        };
        // The root context, which is the weakest binding in the keymap: any
        // scope overrides it.
        assert_eq!(shortcut.context(), APP_CONTEXT);

        let excluded = Shortcut {
            allow_in_text_input: false,
            ..shortcut
        };
        assert_eq!(
            excluded.context(),
            format!("{APP_CONTEXT} && !{TEXT_INPUT_CONTEXT}")
        );
    }

    /// A window-scope shortcut must fire with nothing focused.
    ///
    /// This is the bug the e2e caught and this unit test pins: an `empty`
    /// context stack matches *nothing*, including a negation, so an app-scope
    /// binding written as `!rn-text-input` could never fire before the root
    /// carried `rn-app`. The predicate is evaluated against an empty stack here
    /// on purpose, because that is what a window with no focused element
    /// produces.
    #[test]
    fn the_window_scope_matches_with_nothing_focused() {
        let shortcut = Shortcut {
            id: "window.save".to_string(),
            keys: "secondary-s".to_string(),
            scope: None,
            enabled: true,
            allow_in_text_input: false,
        };
        let binding = KeyBinding::new(
            &shortcut.keys,
            ShortcutAction {
                id: shortcut.id.clone(),
            },
            Some(&shortcut.context()),
        );
        let mut keymap = gpui::Keymap::default();
        keymap.add_bindings([binding]);
        let keystroke = Keystroke::parse("secondary-s").unwrap();

        // No root context at all: nothing matches. This is why `rn-app` exists.
        let (bindings, _) = keymap.bindings_for_input(&[keystroke.clone()], &[]);
        assert!(
            bindings.is_empty(),
            "an empty context stack matches no predicate, not even a negation"
        );

        // The window root provides `rn-app`, and now the shortcut resolves.
        let root = vec![gpui::KeyContext::parse(APP_CONTEXT).unwrap()];
        let (bindings, _) = keymap.bindings_for_input(&[keystroke], &root);
        assert_eq!(bindings.len(), 1);
    }

    /// The root context must not outrank a scope: it is the shallowest one.
    #[test]
    fn a_scope_outranks_the_app_context() {
        let window = KeyBinding::new(
            "secondary-j",
            ShortcutAction {
                id: "window".to_string(),
            },
            Some(APP_CONTEXT),
        );
        let scoped = KeyBinding::new(
            "secondary-j",
            ShortcutAction {
                id: "scoped".to_string(),
            },
            Some("rn-scope-editor"),
        );
        let mut keymap = gpui::Keymap::default();
        keymap.add_bindings([window, scoped]);
        let contexts = vec![
            gpui::KeyContext::parse(APP_CONTEXT).unwrap(),
            gpui::KeyContext::parse("rn-scope-editor").unwrap(),
        ];
        let (bindings, _) =
            keymap.bindings_for_input(&[Keystroke::parse("secondary-j").unwrap()], &contexts);
        assert_eq!(
            bindings[0]
                .action()
                .as_any()
                .downcast_ref::<ShortcutAction>()
                .unwrap()
                .id,
            "scoped"
        );
    }

    /// The precedence rule the whole design rests on: a binding in a deeper
    /// context matches at a greater depth, and `bindings_for_input` returns the
    /// bindings sorted by it.
    #[test]
    fn an_inner_scope_outranks_an_outer_one() {
        let outer = KeyBinding::new(
            "secondary-s",
            ShortcutAction {
                id: "outer".to_string(),
            },
            Some("rn-scope-outer"),
        );
        let inner = KeyBinding::new(
            "secondary-s",
            ShortcutAction {
                id: "inner".to_string(),
            },
            Some("rn-scope-inner"),
        );
        let mut keymap = gpui::Keymap::default();
        keymap.add_bindings([outer.clone(), inner.clone()]);

        let contexts = vec![
            gpui::KeyContext::parse("rn-scope-outer").unwrap(),
            gpui::KeyContext::parse("rn-scope-inner").unwrap(),
        ];
        let (bindings, pending) =
            keymap.bindings_for_input(&[Keystroke::parse("secondary-s").unwrap()], &contexts);
        assert!(!pending);
        assert_eq!(bindings.len(), 2);
        // Innermost first: dispatch runs them in this order and stops at the
        // first one that consumes the key.
        assert_eq!(
            bindings[0]
                .action()
                .as_any()
                .downcast_ref::<ShortcutAction>()
                .unwrap()
                .id,
            "inner"
        );
    }

    /// A shortcut that excludes text inputs does not match when a text input is
    /// on the focus path, so the input's own editing keys keep the key.
    #[test]
    fn a_text_input_disables_a_shortcut_that_opts_out() {
        let binding = KeyBinding::new(
            "secondary-a",
            ShortcutAction {
                id: "select.all".to_string(),
            },
            Some(&format!("rn-scope-editor && !{TEXT_INPUT_CONTEXT}")),
        );
        let mut keymap = gpui::Keymap::default();
        keymap.add_bindings([binding]);

        let in_editor = vec![
            gpui::KeyContext::parse("rn-scope-editor").unwrap(),
            gpui::KeyContext::parse("rn-text-input").unwrap(),
        ];
        let (bindings, _) =
            keymap.bindings_for_input(&[Keystroke::parse("secondary-a").unwrap()], &in_editor);
        assert!(
            bindings.is_empty(),
            "a text input must keep a key the shortcut opted out of"
        );

        let outside = vec![gpui::KeyContext::parse("rn-scope-editor").unwrap()];
        let (bindings, _) =
            keymap.bindings_for_input(&[Keystroke::parse("secondary-a").unwrap()], &outside);
        assert_eq!(bindings.len(), 1);
    }

    #[test]
    fn a_chord_needs_both_keys() {
        let binding = KeyBinding::new(
            "secondary-k secondary-s",
            ShortcutAction {
                id: "chord".to_string(),
            },
            None,
        );
        let mut keymap = gpui::Keymap::default();
        keymap.add_bindings([binding]);
        let first = Keystroke::parse("secondary-k").unwrap();
        let second = Keystroke::parse("secondary-s").unwrap();

        let (bindings, pending) = keymap.bindings_for_input(&[first.clone()], &[]);
        assert!(bindings.is_empty());
        assert!(pending, "the first key must wait for the second");

        let (bindings, pending) = keymap.bindings_for_input(&[first, second], &[]);
        assert_eq!(bindings.len(), 1);
        assert!(!pending);
    }

    /// The six keys the old `dispatch_key` translated, plus the ones it did not.
    ///
    /// This is the stage-4 contract: every key gets a DOM `key`, a `code` and a
    /// `keyCode`, where before only six names were mapped and everything else
    /// went out as GPUI's spelling with `keyCode: 0`.
    #[test]
    fn every_key_gets_a_dom_name_code_and_key_code() {
        for (gpui_key, web_key, code, legacy_code) in [
            ("left", "ArrowLeft", "ArrowLeft", 37),
            ("up", "ArrowUp", "ArrowUp", 38),
            ("right", "ArrowRight", "ArrowRight", 39),
            ("down", "ArrowDown", "ArrowDown", 40),
            ("enter", "Enter", "Enter", 13),
            ("escape", "Escape", "Escape", 27),
            ("backspace", "Backspace", "Backspace", 8),
            ("delete", "Delete", "Delete", 46),
            ("tab", "Tab", "Tab", 9),
            ("space", " ", "Space", 32),
            ("home", "Home", "Home", 36),
            ("end", "End", "End", 35),
            ("pageup", "PageUp", "PageUp", 33),
            ("pagedown", "PageDown", "PageDown", 34),
            ("a", "a", "KeyA", 65),
            ("z", "z", "KeyZ", 90),
            ("5", "5", "Digit5", 53),
            ("f2", "F2", "F2", 113),
        ] {
            assert_eq!(
                normalise_web_key(gpui_key, false),
                web_key,
                "key for {gpui_key}"
            );
            assert_eq!(web_code(gpui_key), code, "code for {gpui_key}");
            assert_eq!(key_code(gpui_key), legacy_code, "keyCode for {gpui_key}");
        }
    }

    #[test]
    fn web_key_names_are_the_dom_ones() {
        assert_eq!(normalise_web_key("left", false), "ArrowLeft");
        assert_eq!(normalise_web_key("up", false), "ArrowUp");
        assert_eq!(normalise_web_key("enter", false), "Enter");
        assert_eq!(normalise_web_key("escape", false), "Escape");
        assert_eq!(normalise_web_key("space", false), " ");
        assert_eq!(normalise_web_key("a", false), "a");
        assert_eq!(normalise_web_key("a", true), "A");
        assert_eq!(normalise_web_key("f5", false), "F5");
    }

    #[test]
    fn web_codes_are_physical_keys() {
        assert_eq!(web_code("a"), "KeyA");
        assert_eq!(web_code("4"), "Digit4");
        assert_eq!(web_code("left"), "ArrowLeft");
        assert_eq!(web_code("space"), "Space");
        assert_eq!(web_code("f5"), "F5");
    }

    #[test]
    fn key_codes_are_the_legacy_ones() {
        assert_eq!(key_code("a"), 65);
        assert_eq!(key_code("z"), 90);
        assert_eq!(key_code("4"), 52);
        assert_eq!(key_code("enter"), 13);
        assert_eq!(key_code("escape"), 27);
        assert_eq!(key_code("space"), 32);
        assert_eq!(key_code("left"), 37);
        assert_eq!(key_code("delete"), 46);
        assert_eq!(key_code("f1"), 112);
        assert_eq!(key_code("f12"), 123);
    }

    #[test]
    fn the_signature_ignores_order_but_not_content() {
        let one = Shortcut {
            id: "a".to_string(),
            keys: "secondary-a".to_string(),
            scope: None,
            enabled: true,
            allow_in_text_input: false,
        };
        let two = Shortcut {
            id: "b".to_string(),
            keys: "secondary-b".to_string(),
            scope: Some("editor".to_string()),
            enabled: true,
            allow_in_text_input: false,
        };
        assert_eq!(
            signature(&[one.clone(), two.clone()]),
            signature(&[two.clone(), one.clone()])
        );
        assert_ne!(signature(&[one.clone()]), signature(&[two]));
    }
}
