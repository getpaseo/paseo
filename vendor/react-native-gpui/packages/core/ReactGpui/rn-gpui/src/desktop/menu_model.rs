use crate::desktop::errors::DesktopError;
use serde_json::Value;

/// Nesting limit for submenus. Deeper than any real menu, shallow enough that a
/// malformed payload cannot recurse without bound.
pub const MAX_DEPTH: usize = 10;

#[derive(Clone, Debug, PartialEq)]
pub enum MenuNode {
    Item(MenuItemDef),
    Submenu(SubmenuDef),
    Separator,
    StandardMenu(MenuRole),
}

#[derive(Clone, Debug, PartialEq)]
pub struct MenuItemDef {
    pub id: String,
    pub label: String,
    pub accelerator: Option<String>,
    pub enabled: bool,
    pub checked: bool,
    pub role: Option<MenuRole>,
    /// The URI of the item's icon, loaded by `desktop::icon`.
    pub icon: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SubmenuDef {
    pub id: Option<String>,
    pub label: String,
    pub enabled: bool,
    pub items: Vec<MenuNode>,
    pub icon: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MenuRole {
    About,
    Services,
    Hide,
    HideOthers,
    ShowAll,
    Quit,
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Minimize,
    Zoom,
    ToggleFullscreen,
    Close,
    Help,
    AppMenu,
    EditMenu,
    WindowMenu,
    HelpMenu,
}

impl MenuRole {
    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "about" => Self::About,
            "services" => Self::Services,
            "hide" => Self::Hide,
            "hideOthers" => Self::HideOthers,
            "showAll" => Self::ShowAll,
            "quit" => Self::Quit,
            "undo" => Self::Undo,
            "redo" => Self::Redo,
            "cut" => Self::Cut,
            "copy" => Self::Copy,
            "paste" => Self::Paste,
            "selectAll" => Self::SelectAll,
            "minimize" => Self::Minimize,
            "zoom" => Self::Zoom,
            "toggleFullscreen" => Self::ToggleFullscreen,
            "close" => Self::Close,
            "help" => Self::Help,
            "appMenu" => Self::AppMenu,
            "editMenu" => Self::EditMenu,
            "windowMenu" => Self::WindowMenu,
            "helpMenu" => Self::HelpMenu,
            _ => return None,
        })
    }

    pub fn is_standard_menu(self) -> bool {
        matches!(
            self,
            Self::AppMenu | Self::EditMenu | Self::WindowMenu | Self::HelpMenu
        )
    }

    pub fn default_label(self) -> &'static str {
        match self {
            Self::About => "About",
            Self::Services => "Services",
            Self::Hide => "Hide",
            Self::HideOthers => "Hide Others",
            Self::ShowAll => "Show All",
            Self::Quit => "Quit",
            Self::Undo => "Undo",
            Self::Redo => "Redo",
            Self::Cut => "Cut",
            Self::Copy => "Copy",
            Self::Paste => "Paste",
            Self::SelectAll => "Select All",
            Self::Minimize => "Minimize",
            Self::Zoom => "Zoom",
            Self::ToggleFullscreen => "Toggle Full Screen",
            Self::Close => "Close",
            Self::Help => "Help",
            Self::AppMenu => "App",
            Self::EditMenu => "Edit",
            Self::WindowMenu => "Window",
            Self::HelpMenu => "Help",
        }
    }

    /// Whether this platform can implement the role. Roles with no meaning are
    /// dropped from the built menu rather than shown disabled.
    pub fn is_supported(self) -> bool {
        match self {
            Self::Services | Self::Hide | Self::HideOthers | Self::ShowAll => {
                cfg!(target_os = "macos")
            }
            Self::About => cfg!(target_os = "macos"),
            _ => true,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Default)]
pub struct MenuModel {
    pub items: Vec<MenuNode>,
}

impl MenuModel {
    pub fn ids(&self) -> Vec<String> {
        let mut ids = Vec::new();
        collect_ids(&self.items, &mut ids);
        ids
    }

    pub fn find(&self, id: &str) -> Option<&MenuItemDef> {
        fn walk<'a>(items: &'a [MenuNode], id: &str) -> Option<&'a MenuItemDef> {
            for node in items {
                match node {
                    MenuNode::Item(item) if item.id == id => return Some(item),
                    MenuNode::Submenu(submenu) => {
                        if let Some(found) = walk(&submenu.items, id) {
                            return Some(found);
                        }
                    }
                    _ => {}
                }
            }
            None
        }
        walk(&self.items, id)
    }

    pub fn accelerators(&self) -> Vec<(String, String)> {
        let mut bindings = Vec::new();
        collect_accelerators(&self.items, &mut bindings);
        bindings
    }

    pub fn has_help_menu(&self) -> bool {
        self.items.iter().any(|node| match node {
            MenuNode::StandardMenu(MenuRole::HelpMenu) => true,
            MenuNode::Submenu(submenu) => submenu.label.eq_ignore_ascii_case("help"),
            _ => false,
        })
    }
}

fn collect_ids(items: &[MenuNode], ids: &mut Vec<String>) {
    for node in items {
        match node {
            MenuNode::Item(item) => ids.push(item.id.clone()),
            MenuNode::Submenu(submenu) => {
                if let Some(id) = &submenu.id {
                    ids.push(id.clone());
                }
                collect_ids(&submenu.items, ids);
            }
            _ => {}
        }
    }
}

fn collect_accelerators(items: &[MenuNode], out: &mut Vec<(String, String)>) {
    for node in items {
        match node {
            MenuNode::Item(item) => {
                if let Some(accelerator) = &item.accelerator {
                    out.push((item.id.clone(), accelerator.clone()));
                }
            }
            MenuNode::Submenu(submenu) => collect_accelerators(&submenu.items, out),
            _ => {}
        }
    }
}

pub fn parse_menu(value: &Value) -> Result<MenuModel, DesktopError> {
    let array = value
        .as_array()
        .ok_or_else(|| DesktopError::invalid_argument("a menu must be an array"))?;
    let items = parse_items(array, 0)?;
    let model = MenuModel { items };
    let mut seen = std::collections::HashSet::new();
    for id in model.ids() {
        if !seen.insert(id.clone()) {
            return Err(DesktopError::invalid_argument(format!(
                "duplicate menu item id: {id}"
            )));
        }
    }
    Ok(model)
}

fn parse_items(array: &[Value], depth: usize) -> Result<Vec<MenuNode>, DesktopError> {
    if depth > MAX_DEPTH {
        return Err(DesktopError::invalid_argument(format!(
            "menus nest deeper than {MAX_DEPTH} levels"
        )));
    }
    let mut nodes = Vec::with_capacity(array.len());
    for entry in array {
        nodes.push(parse_node(entry, depth)?);
    }
    Ok(nodes)
}

fn parse_node(value: &Value, depth: usize) -> Result<MenuNode, DesktopError> {
    let object = value
        .as_object()
        .ok_or_else(|| DesktopError::invalid_argument("a menu item must be an object"))?;
    let kind = object
        .get("type")
        .map(|value| {
            value
                .as_str()
                .ok_or_else(|| DesktopError::invalid_argument("menu item `type` must be a string"))
        })
        .transpose()?
        .unwrap_or("item");

    match kind {
        "separator" => {
            check_fields(object, &["type"])?;
            Ok(MenuNode::Separator)
        }
        "submenu" => {
            check_fields(object, &["type", "id", "label", "enabled", "items", "icon"])?;
            let label = required_string(object, "label")?;
            let enabled = optional_bool(object, "enabled")?.unwrap_or(true);
            let items = object
                .get("items")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    DesktopError::invalid_argument("a submenu requires an `items` array")
                })?;
            Ok(MenuNode::Submenu(SubmenuDef {
                id: optional_string(object, "id")?,
                label,
                enabled,
                items: parse_items(items, depth + 1)?,
                icon: optional_string(object, "icon")?,
            }))
        }
        "role" => {
            check_fields(object, &["type", "id", "role", "label", "enabled"])?;
            let role_name = required_string(object, "role")?;
            let role = MenuRole::parse(&role_name).ok_or_else(|| {
                DesktopError::invalid_argument(format!("unknown menu role: {role_name}"))
            })?;
            if role.is_standard_menu() {
                return Ok(MenuNode::StandardMenu(role));
            }
            Ok(MenuNode::Item(MenuItemDef {
                id: optional_string(object, "id")?.unwrap_or_else(|| format!("role:{role_name}")),
                label: optional_string(object, "label")?
                    .unwrap_or_else(|| role.default_label().to_string()),
                accelerator: None,
                enabled: optional_bool(object, "enabled")?.unwrap_or(true),
                checked: false,
                role: Some(role),
                icon: None,
            }))
        }
        "item" => {
            check_fields(
                object,
                &[
                    "type",
                    "id",
                    "label",
                    "accelerator",
                    "enabled",
                    "checked",
                    "role",
                    "icon",
                ],
            )?;
            let role = match optional_string(object, "role")? {
                Some(name) => Some(MenuRole::parse(&name).ok_or_else(|| {
                    DesktopError::invalid_argument(format!("unknown menu role: {name}"))
                })?),
                None => None,
            };
            let label = match optional_string(object, "label")? {
                Some(label) => label,
                None => role
                    .map(|role| role.default_label().to_string())
                    .ok_or_else(|| {
                        DesktopError::invalid_argument("a menu item requires a `label`")
                    })?,
            };
            let id = match optional_string(object, "id")? {
                Some(id) => id,
                None if role.is_some() => format!("role:{}", label),
                None => {
                    return Err(DesktopError::invalid_argument(
                        "a menu item requires an `id`",
                    ))
                }
            };
            let accelerator = match optional_string(object, "accelerator")? {
                Some(spec) => Some(parse_accelerator(&spec)?),
                None => None,
            };
            Ok(MenuNode::Item(MenuItemDef {
                id,
                label,
                accelerator,
                enabled: optional_bool(object, "enabled")?.unwrap_or(true),
                checked: optional_bool(object, "checked")?.unwrap_or(false),
                role,
                icon: optional_string(object, "icon")?,
            }))
        }
        other => Err(DesktopError::invalid_argument(format!(
            "unknown menu item type: {other}"
        ))),
    }
}

fn check_fields(
    object: &serde_json::Map<String, Value>,
    allowed: &[&str],
) -> Result<(), DesktopError> {
    for key in object.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(DesktopError::invalid_argument(format!(
                "unknown menu item field: {key}"
            )));
        }
    }
    Ok(())
}

fn required_string(
    object: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<String, DesktopError> {
    optional_string(object, key)?
        .ok_or_else(|| DesktopError::invalid_argument(format!("missing `{key}`")))
}

fn optional_string(
    object: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<Option<String>, DesktopError> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(DesktopError::invalid_argument(format!(
            "`{key}` must be a string"
        ))),
    }
}

fn optional_bool(
    object: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<Option<bool>, DesktopError> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(DesktopError::invalid_argument(format!(
            "`{key}` must be a boolean"
        ))),
    }
}

/// `CmdOrCtrl` becomes GPUI's `secondary`: Command on macOS, Control elsewhere.
pub fn parse_accelerator(spec: &str) -> Result<String, DesktopError> {
    let trimmed = spec.trim();
    if trimmed.is_empty() {
        return Err(DesktopError::invalid_argument(
            "an accelerator cannot be empty",
        ));
    }
    let mut parts: Vec<&str> = trimmed.split('+').map(str::trim).collect();
    let key_token = parts
        .pop()
        .filter(|key| !key.is_empty())
        .ok_or_else(|| DesktopError::invalid_argument(format!("invalid accelerator: {spec}")))?;

    let mut modifiers: Vec<&'static str> = Vec::new();
    for part in parts {
        if part.is_empty() {
            return Err(DesktopError::invalid_argument(format!(
                "invalid accelerator: {spec}"
            )));
        }
        let modifier = match part.to_ascii_lowercase().as_str() {
            "cmdorctrl" | "commandorcontrol" | "cmdorcontrol" | "controllorcmd" => "secondary",
            "command" | "cmd" | "super" | "meta" => "cmd",
            "control" | "ctrl" => "ctrl",
            "alt" | "option" => "alt",
            "shift" => "shift",
            "altgr" => {
                return Err(DesktopError::invalid_argument(
                    "AltGr is not supported in accelerators",
                ))
            }
            other => {
                return Err(DesktopError::invalid_argument(format!(
                    "unknown accelerator modifier: {other}"
                )))
            }
        };
        if !modifiers.contains(&modifier) {
            modifiers.push(modifier);
        }
    }

    let key = accelerator_key(key_token).ok_or_else(|| {
        DesktopError::invalid_argument(format!("unknown accelerator key: {key_token}"))
    })?;

    let mut keystroke = String::new();
    for modifier in modifiers {
        keystroke.push_str(modifier);
        keystroke.push('-');
    }
    keystroke.push_str(&key);
    Ok(keystroke)
}

fn accelerator_key(token: &str) -> Option<String> {
    let lower = token.to_ascii_lowercase();
    if token.chars().count() == 1 {
        let character = token.chars().next()?;
        if character.is_ascii_alphanumeric() {
            return Some(lower);
        }
        return Some(character.to_string());
    }
    if let Some(rest) = lower.strip_prefix('f') {
        if let Ok(number) = rest.parse::<u8>() {
            if (1..=24).contains(&number) {
                return Some(format!("f{number}"));
            }
        }
    }
    Some(
        match lower.as_str() {
            "enter" | "return" => "enter",
            "escape" | "esc" => "escape",
            "tab" => "tab",
            "space" | "spacebar" => "space",
            "backspace" => "backspace",
            "delete" | "del" => "delete",
            "insert" | "ins" => "insert",
            "up" | "arrowup" => "up",
            "down" | "arrowdown" => "down",
            "left" | "arrowleft" => "left",
            "right" | "arrowright" => "right",
            "home" => "home",
            "end" => "end",
            "pageup" => "pageup",
            "pagedown" => "pagedown",
            "plus" => "+",
            "minus" => "-",
            "comma" => ",",
            "period" => ".",
            "slash" => "/",
            "backslash" => "\\",
            "semicolon" => ";",
            "quote" => "'",
            "backquote" => "`",
            "bracketleft" => "[",
            "bracketright" => "]",
            _ => return None,
        }
        .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_a_nested_menu() {
        let model = parse_menu(&json!([
            {"label": "File", "type": "submenu", "items": [
                {"id": "new", "label": "New", "accelerator": "CmdOrCtrl+N"},
                {"type": "separator"},
                {"id": "quit", "label": "Quit", "role": "quit"}
            ]},
            {"type": "role", "role": "editMenu"}
        ]))
        .expect("valid menu");
        assert_eq!(model.items.len(), 2);
        assert_eq!(model.ids(), vec!["new".to_string(), "quit".to_string()]);
        assert!(model.find("new").is_some());
        assert!(matches!(
            model.items[1],
            MenuNode::StandardMenu(MenuRole::EditMenu)
        ));
    }

    #[test]
    fn rejects_duplicate_ids() {
        let error = parse_menu(&json!([
            {"id": "a", "label": "A"},
            {"id": "a", "label": "Again"}
        ]))
        .expect_err("duplicate ids are rejected");
        assert_eq!(error.code, crate::desktop::errors::codes::INVALID_ARGUMENT);
        assert!(error.message.contains("duplicate"));
    }

    #[test]
    fn rejects_unknown_fields() {
        let error = parse_menu(&json!([{"id": "a", "label": "A", "typo": true}]))
            .expect_err("unknown fields are rejected");
        assert!(error.message.contains("typo"));
    }

    #[test]
    fn rejects_unknown_types_and_roles() {
        assert!(parse_menu(&json!([{"type": "magic"}])).is_err());
        assert!(parse_menu(&json!([{"type": "role", "role": "nope"}])).is_err());
    }

    #[test]
    fn rejects_too_deep_nesting() {
        let mut value = json!({"id": "leaf", "label": "leaf"});
        for _ in 0..MAX_DEPTH + 2 {
            value = json!({"label": "sub", "type": "submenu", "items": [value]});
        }
        assert!(parse_menu(&json!([value])).is_err());
    }

    #[test]
    fn parses_accelerators() {
        assert_eq!(parse_accelerator("CmdOrCtrl+N").unwrap(), "secondary-n");
        assert_eq!(
            parse_accelerator("CmdOrCtrl+Shift+K").unwrap(),
            "secondary-shift-k"
        );
        assert_eq!(parse_accelerator("Ctrl+Alt+I").unwrap(), "ctrl-alt-i");
        assert_eq!(parse_accelerator("F5").unwrap(), "f5");
        assert_eq!(parse_accelerator("Cmd+,").unwrap(), "cmd-,");
        assert_eq!(parse_accelerator("Shift+Enter").unwrap(), "shift-enter");
    }

    #[test]
    fn rejects_bad_accelerators() {
        assert!(parse_accelerator("").is_err());
        assert!(parse_accelerator("Meta+UnknownKey").is_err());
        assert!(parse_accelerator("Hyper+K").is_err());
    }

    #[test]
    fn role_menus_are_standard_menus() {
        assert!(MenuRole::EditMenu.is_standard_menu());
        assert!(!MenuRole::Copy.is_standard_menu());
        assert!(!MenuRole::Copy.default_label().is_empty());
    }
}
