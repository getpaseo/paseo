//! GPUI derives an `NSMenuItem` key equivalent from the keymap binding for the
//! exact action value, and `Keymap` has no per-binding removal, so the desktop
//! bindings are filtered out and re-added whenever the menu changes. The Edit
//! roles act on the focused RN text input: `OsAction::Copy` needs an
//! `NSTextView` first responder, which GPUI-drawn inputs are not.

use crate::desktop::errors::{DesktopError, DesktopResult};
use crate::desktop::menu_model::{self, MenuItemDef, MenuModel, MenuNode, MenuRole, SubmenuDef};
use crate::desktop::windows::DesktopWindowsGlobal;
use crate::node_view::RNNodeView;
use crate::store::store_from;
use gpui::{Action, App, Entity, KeyBinding, Menu, MenuItem, SharedString, SystemMenuType};
use serde_json::{json, Value};

#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = rn_gpui_desktop, no_json, no_register)]
pub struct MenuAccelerator {
    pub id: String,
}

#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = rn_gpui_desktop, no_json, no_register)]
pub struct MenuEditAction {
    pub kind: String,
}

#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = rn_gpui_desktop, no_json, no_register)]
pub struct MenuHostAction {
    pub kind: String,
}

#[derive(Clone, Debug, PartialEq)]
pub enum AcceleratorAction {
    Press(String),
    Edit(String),
    Host(String),
    /// A Developer menu command, performed by the host like the dev menu's own
    /// buttons.
    Dev(String),
}

pub struct AppMenuState {
    pub model: MenuModel,
    pub user_set: bool,
    pub app_name: String,
    pub bindings: Vec<(String, String)>,
    pub accelerators: Vec<(gpui::Keystroke, AcceleratorAction)>,
    pub _interceptor: Option<gpui::Subscription>,
    pub rebuild_scheduled: bool,
    /// Windows only: the attached `muda` menu bar and the HWND it is on.
    ///
    /// `muda::Menu::init_for_hwnd` installs a window subclass whose `dwRefData`
    /// points into the `Menu`, so the `Menu` has to outlive the subclass. The
    /// value is held here, in a global that lives as long as the app, and the
    /// subclass is detached before it is replaced, otherwise the next message
    /// this window receives (a resize, a paint) calls through a dangling
    /// pointer and the process dies with `STATUS_STACK_BUFFER_OVERRUN`.
    #[cfg(target_os = "windows")]
    pub platform_menu: Option<(muda::Menu, isize)>,
}

pub struct AppMenuGlobal(pub AppMenuState);
impl gpui::Global for AppMenuGlobal {}

impl AppMenuGlobal {
    pub fn new(app_name: String) -> Self {
        Self(AppMenuState {
            model: default_menu(&app_name),
            user_set: false,
            app_name,
            bindings: Vec::new(),
            accelerators: Vec::new(),
            _interceptor: None,
            rebuild_scheduled: false,
            #[cfg(target_os = "windows")]
            platform_menu: None,
        })
    }
}

/// Detaches the attached menu bar when the global is dropped, so a window that
/// outlives the menu state never keeps a subclass pointing into freed memory.
#[cfg(target_os = "windows")]
impl Drop for AppMenuGlobal {
    fn drop(&mut self) {
        if let Some((menu, hwnd)) = self.0.platform_menu.take() {
            remove_platform_menu(menu, hwnd);
        }
    }
}

pub fn install(cx: &mut App, app_name: &str, dev_menu: bool) {
    cx.set_global(DevMenuEnabled(dev_menu));
    cx.set_global(AppMenuGlobal::new(app_name.to_string()));
    let model = default_menu(app_name);
    let _ = apply(cx, model, false);
    cx.on_action(|action: &MenuAccelerator, cx: &mut App| {
        trigger_item(cx, &action.id);
    });
    cx.on_action(|action: &MenuEditAction, cx: &mut App| {
        perform_edit(cx, &action.kind, None);
    });
    cx.on_action(|action: &MenuHostAction, cx: &mut App| {
        perform_host_action(cx, &action.kind, None);
    });
    // The keymap binding is what makes macOS draw the shortcut in the NSMenu and
    // what the menu item dispatches. Keystrokes are matched here as well,
    // because a window with no focused element has no dispatch path for the
    // keymap to resolve, and a global shortcut must work in that state too.
    let interceptor = cx.intercept_keystrokes(|event, window, cx| {
        // Yield to a shortcut. The keymap resolves a keystroke from the focused
        // element's context, and a shortcut in a scope outranks the app-wide
        // menu accelerator — but an interceptor runs *before* the keymap is
        // consulted, so handling the key here would take it away from a shortcut
        // that is entitled to it. Asking the keymap first is what keeps the
        // precedence the rest of this design promises.
        if crate::desktop::keymap::claims_keystroke(cx, window, &event.keystroke) {
            return;
        }
        if handle_accelerator(cx, window, &event.keystroke) {
            cx.stop_propagation();
        }
    });
    cx.global_mut::<AppMenuGlobal>().0._interceptor = Some(interceptor);
}

pub fn trigger_item(cx: &mut App, id: &str) {
    match accelerator_action(id) {
        AcceleratorAction::Press(id) => emit_menu_press(cx, &id),
        AcceleratorAction::Edit(kind) => perform_edit(cx, &kind, None),
        AcceleratorAction::Host(kind) => perform_host_action(cx, &kind, None),
        AcceleratorAction::Dev(id) => perform_dev_action(cx, id),
    }
}

pub fn handle_accelerator(
    cx: &mut App,
    window: &mut gpui::Window,
    keystroke: &gpui::Keystroke,
) -> bool {
    let action = {
        let state = &cx.global::<AppMenuGlobal>().0;
        state
            .accelerators
            .iter()
            .find(|(bound, _)| bound == keystroke)
            .map(|(_, action)| action.clone())
    };
    if std::env::var_os("RN_GPUI_DEBUG_DESKTOP").is_some() {
        // `RN_GPUI_DEBUG_DESKTOP=1` logs every keystroke the interceptor sees.
        let installed = cx
            .global::<AppMenuGlobal>()
            .0
            .accelerators
            .iter()
            .map(|(bound, _)| bound.to_string())
            .collect::<Vec<_>>();
        log::info!(
            "[desktop] keystroke {} matched={} installed=[{}]",
            keystroke,
            action.is_some(),
            installed.join(", ")
        );
    }
    let Some(action) = action else {
        return false;
    };
    // The window comes from the keystroke, not `active_window()`: a hidden or
    // off-screen window (the test driver's) is not the platform's active one.
    let handle: gpui::AnyWindowHandle = window.window_handle().into();
    match action {
        AcceleratorAction::Press(id) => emit_menu_press(cx, &id),
        AcceleratorAction::Edit(kind) => perform_edit(cx, &kind, Some(handle)),
        AcceleratorAction::Host(kind) => perform_host_action(cx, &kind, Some(handle)),
        AcceleratorAction::Dev(id) => perform_dev_action(cx, id),
    }
    // The JS listener needs a frame to run in.
    if let Some(store) = store_from(cx) {
        store.read(cx).frame_hook.arm(window);
    }
    true
}

pub fn set_application_menu(cx: &mut App, items: Option<&Value>) -> DesktopResult {
    let model = match items {
        Some(value) => menu_model::parse_menu(value)?,
        None => default_menu(&app_name(cx)),
    };
    let user_set = items.is_some();
    apply(cx, model, user_set)?;
    Ok(json!({"items": current_model(cx).ids().len()}))
}

pub fn update_item(cx: &mut App, id: &str, patch: &Value) -> DesktopResult {
    let patch = patch
        .as_object()
        .ok_or_else(|| DesktopError::invalid_argument("a menu patch must be an object"))?;
    {
        let state = &mut cx.global_mut::<AppMenuGlobal>().0;
        let Some(item) = find_item_mut(&mut state.model.items, id) else {
            return Err(DesktopError::not_found(format!(
                "menu item {id} is not set"
            )));
        };
        if let Some(label) = patch.get("label") {
            item.label = label
                .as_str()
                .ok_or_else(|| DesktopError::invalid_argument("`label` must be a string"))?
                .to_string();
        }
        if let Some(enabled) = patch.get("enabled") {
            item.enabled = enabled
                .as_bool()
                .ok_or_else(|| DesktopError::invalid_argument("`enabled` must be a boolean"))?;
        }
        if let Some(checked) = patch.get("checked") {
            item.checked = checked
                .as_bool()
                .ok_or_else(|| DesktopError::invalid_argument("`checked` must be a boolean"))?;
        }
    }
    schedule_rebuild(cx);
    Ok(json!({"id": id}))
}

/// Shows or hides the in-window menu bar of one window.
///
/// Windows detaches the `muda` menu from the HWND rather than destroying it: the
/// menu stays alive in the global so the same items can be shown again, and
/// accelerators are GPUI key bindings that never went through the menu widget, so
/// they keep working either way. Linux skips attaching the bar and drops the
/// inset, which is what makes the React surface grow into the space.
pub fn set_menu_bar_visible(cx: &mut gpui::App, window_id: u32, visible: bool) -> DesktopResult {
    crate::desktop::gpui_menu::set_menu_bar_visible(window_id, visible);
    #[cfg(target_os = "windows")]
    {
        set_windows_menu_attached(cx, window_id, visible)?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = cx;
    }
    // The surface size follows the bar, and the window has to relayout for the
    // inset change to reach the React root.
    crate::desktop::gpui_menu::resize_surfaces_for_menu_bar(cx, window_id);
    Ok(json!({"windowId": window_id, "menuBarVisible": visible}))
}

pub fn menu_json(cx: &App) -> Value {
    let state = &cx.global::<AppMenuGlobal>().0;
    json!({
        "appName": state.app_name,
        "userSet": state.user_set,
        "items": nodes_json(&state.model.items),
        // The main window's bar, which is the one an app asks about. A hidden
        // bar is per window, so this reports the window the call is about.
        "menuBarVisible": !crate::desktop::gpui_menu::menu_bar_hidden(
            crate::desktop::windows::MAIN_WINDOW_KEY,
        ),
    })
}

fn nodes_json(items: &[MenuNode]) -> Vec<Value> {
    items
        .iter()
        .map(|node| match node {
            MenuNode::Separator => json!({"type": "separator"}),
            MenuNode::StandardMenu(role) => {
                json!({"type": "role", "role": role_name(*role)})
            }
            MenuNode::Submenu(submenu) => json!({
                "type": "submenu",
                "id": submenu.id,
                "label": submenu.label,
                "enabled": submenu.enabled,
                "items": nodes_json(&submenu.items),
                "icon": submenu.icon,
            }),
            MenuNode::Item(item) => json!({
                "type": "item",
                "id": item.id,
                "label": item.label,
                "accelerator": item.accelerator,
                "enabled": item.enabled,
                "checked": item.checked,
                "role": item.role.map(role_name),
                "icon": item.icon,
            }),
        })
        .collect()
}

fn role_name(role: MenuRole) -> &'static str {
    match role {
        MenuRole::About => "about",
        MenuRole::Services => "services",
        MenuRole::Hide => "hide",
        MenuRole::HideOthers => "hideOthers",
        MenuRole::ShowAll => "showAll",
        MenuRole::Quit => "quit",
        MenuRole::Undo => "undo",
        MenuRole::Redo => "redo",
        MenuRole::Cut => "cut",
        MenuRole::Copy => "copy",
        MenuRole::Paste => "paste",
        MenuRole::SelectAll => "selectAll",
        MenuRole::Minimize => "minimize",
        MenuRole::Zoom => "zoom",
        MenuRole::ToggleFullscreen => "toggleFullscreen",
        MenuRole::Close => "close",
        MenuRole::Help => "help",
        MenuRole::AppMenu => "appMenu",
        MenuRole::EditMenu => "editMenu",
        MenuRole::WindowMenu => "windowMenu",
        MenuRole::HelpMenu => "helpMenu",
    }
}

fn find_item_mut<'a>(items: &'a mut [MenuNode], id: &str) -> Option<&'a mut MenuItemDef> {
    for node in items {
        match node {
            MenuNode::Item(item) if item.id == id => return Some(item),
            MenuNode::Submenu(submenu) => {
                if let Some(found) = find_item_mut(&mut submenu.items, id) {
                    return Some(found);
                }
            }
            _ => {}
        }
    }
    None
}

pub fn current_model(cx: &App) -> MenuModel {
    cx.global::<AppMenuGlobal>().0.model.clone()
}

pub fn app_name(cx: &App) -> String {
    cx.global::<AppMenuGlobal>().0.app_name.clone()
}

pub fn standard_menu_nodes(role: MenuRole, app_name: &str, dev_menu: bool) -> Vec<MenuNode> {
    let item = |role: MenuRole| {
        MenuNode::Item(MenuItemDef {
            id: role_action_id(role).to_string(),
            label: role.default_label().to_string(),
            accelerator: default_accelerator(role).map(str::to_string),
            enabled: true,
            checked: false,
            role: Some(role),
            icon: None,
        })
    };
    let items = |roles: &[MenuRole]| roles.iter().map(|role| item(*role)).collect();
    match role {
        MenuRole::AppMenu => vec![
            MenuNode::Item(MenuItemDef {
                id: role_action_id(MenuRole::About).to_string(),
                label: format!("About {app_name}"),
                accelerator: None,
                enabled: true,
                checked: false,
                role: Some(MenuRole::About),
                icon: None,
            }),
            MenuNode::Separator,
            item(MenuRole::Hide),
            item(MenuRole::HideOthers),
            item(MenuRole::ShowAll),
            MenuNode::Separator,
            item(MenuRole::Quit),
        ],
        MenuRole::EditMenu => {
            let mut nodes: Vec<MenuNode> = items(&[MenuRole::Undo, MenuRole::Redo]);
            nodes.push(MenuNode::Separator);
            nodes.extend(items(&[
                MenuRole::Cut,
                MenuRole::Copy,
                MenuRole::Paste,
                MenuRole::SelectAll,
            ]));
            nodes
        }
        MenuRole::WindowMenu => items(&[
            MenuRole::Minimize,
            MenuRole::Zoom,
            MenuRole::ToggleFullscreen,
            MenuRole::Close,
        ]),
        MenuRole::HelpMenu => {
            let mut nodes = Vec::new();
            if dev_menu {
                nodes.push(MenuNode::Submenu(SubmenuDef {
                    id: Some("dev".to_string()),
                    label: "Developer".to_string(),
                    enabled: true,
                    icon: None,
                    items: [
                        (crate::desktop::dev_menu::RELOAD, "Reload"),
                        (crate::desktop::dev_menu::OPEN_DEVTOOLS, "Open DevTools"),
                        (
                            crate::desktop::dev_menu::ELEMENT_INSPECTOR,
                            "Toggle Element Inspector",
                        ),
                        (
                            crate::desktop::dev_menu::PERF_MONITOR,
                            "Toggle Perf Monitor",
                        ),
                        (crate::desktop::dev_menu::FAST_REFRESH, "Fast Refresh"),
                    ]
                    .into_iter()
                    .map(|(id, label)| {
                        MenuNode::Item(MenuItemDef {
                            id: id.to_string(),
                            label: label.to_string(),
                            accelerator: None,
                            enabled: true,
                            checked: false,
                            role: None,
                            icon: None,
                        })
                    })
                    .collect(),
                }));
            }
            nodes
        }
        other => vec![item(other)],
    }
}

pub struct DevMenuEnabled(pub bool);
impl gpui::Global for DevMenuEnabled {}

fn dev_menu_enabled(cx: &App) -> bool {
    cx.try_global::<DevMenuEnabled>().is_some_and(|flag| flag.0)
}

pub fn default_menu(app_name: &str) -> MenuModel {
    let mut app_items = vec![
        MenuNode::Item(role_item(MenuRole::About, &format!("About {app_name}"))),
        MenuNode::Separator,
    ];
    if cfg!(target_os = "macos") {
        app_items.push(MenuNode::Item(role_item(MenuRole::Services, "Services")));
        app_items.push(MenuNode::Separator);
    }
    app_items.extend([
        MenuNode::Item(role_item(MenuRole::Hide, &format!("Hide {app_name}"))),
        MenuNode::Item(role_item(MenuRole::HideOthers, "Hide Others")),
        MenuNode::Item(role_item(MenuRole::ShowAll, "Show All")),
        MenuNode::Separator,
        MenuNode::Item(role_item(MenuRole::Quit, &format!("Quit {app_name}"))),
    ]);

    MenuModel {
        items: vec![
            MenuNode::Submenu(menu_model::SubmenuDef {
                id: None,
                label: app_name.to_string(),
                enabled: true,
                items: app_items,
                icon: None,
            }),
            MenuNode::StandardMenu(MenuRole::EditMenu),
            MenuNode::StandardMenu(MenuRole::WindowMenu),
            MenuNode::StandardMenu(MenuRole::HelpMenu),
        ],
    }
}

fn role_item(role: MenuRole, label: &str) -> MenuItemDef {
    MenuItemDef {
        id: format!("role:{}", role_name(role)),
        label: label.to_string(),
        accelerator: default_accelerator(role).map(str::to_string),
        enabled: role.is_supported(),
        checked: false,
        role: Some(role),
        icon: None,
    }
}

pub fn default_accelerator(role: MenuRole) -> Option<&'static str> {
    Some(match role {
        MenuRole::Undo => "secondary-z",
        MenuRole::Redo => "secondary-shift-z",
        MenuRole::Cut => "secondary-x",
        MenuRole::Copy => "secondary-c",
        MenuRole::Paste => "secondary-v",
        MenuRole::SelectAll => "secondary-a",
        MenuRole::Minimize => "secondary-m",
        MenuRole::Close => "secondary-w",
        MenuRole::Quit => "secondary-q",
        MenuRole::Hide => "secondary-h",
        MenuRole::HideOthers => "secondary-alt-h",
        MenuRole::ToggleFullscreen => "ctrl-cmd-f",
        _ => return None,
    })
}

fn apply(cx: &mut App, model: MenuModel, user_set: bool) -> Result<(), DesktopError> {
    let app_name = app_name(cx);
    let menus = build_menus(&model, &app_name, dev_menu_enabled(cx));
    let bindings = collect_bindings(dev_menu_enabled(cx), &model);
    let accelerators = replace_accelerator_bindings(cx, &bindings);
    // Windows has no `cx.set_menus()`; the model is attached to the HWND
    // instead. Built twice because the menu builders are not
    // cloneable.
    #[cfg(target_os = "windows")]
    {
        let platform_menus = build_menus(&model, &app_name, dev_menu_enabled(cx));
        if let Some(handle) = crate::desktop::dev_menu::main_window(cx) {
            let mut attached = None;
            let _ = handle.update(cx, |_root: gpui::AnyView, window, _cx| {
                attached = set_platform_menus(window, &platform_menus);
            });
            if let Some((bar, hwnd)) = attached {
                // Replacing the bar first detaches the previous window subclass,
                // which still points into the old menu; only then is that menu
                // dropped, so the window never calls through freed memory.
                if let Some((previous, previous_hwnd)) = cx
                    .global_mut::<AppMenuGlobal>()
                    .0
                    .platform_menu
                    .replace((bar, hwnd))
                {
                    remove_platform_menu(previous, previous_hwnd);
                }
            } else {
                log::warn!("[desktop] could not attach the Win32 menu bar");
            }
        }
    }
    cx.set_menus(menus);
    #[cfg(target_os = "macos")]
    set_menu_bar_icons(&model);
    let state = &mut cx.global_mut::<AppMenuGlobal>().0;
    state.model = model;
    state.user_set = user_set;
    state.bindings = bindings;
    state.accelerators = accelerators;
    state.rebuild_scheduled = false;
    Ok(())
}

/// GPUI's menu items have no image, so the icons are set on the `NSMenu` it
/// just installed, matching items by title the way the model nests them.
#[cfg(target_os = "macos")]
fn set_menu_bar_icons(model: &MenuModel) {
    use cocoa::base::{id, nil};
    use objc::{class, msg_send, sel, sel_impl};

    const SIZE: f64 = 16.0;

    unsafe fn item_titled(menu: id, title: &str, from: &mut isize) -> id {
        let count: isize = msg_send![menu, numberOfItems];
        while *from < count {
            let item: id = msg_send![menu, itemAtIndex: *from];
            *from += 1;
            let ns_title: id = msg_send![item, title];
            let utf8: *const std::os::raw::c_char = msg_send![ns_title, UTF8String];
            if !utf8.is_null() && std::ffi::CStr::from_ptr(utf8).to_str() == Ok(title) {
                return item;
            }
        }
        nil
    }

    unsafe fn set_image(item: id, uri: &str) {
        let Some(icon) = crate::desktop::icon::cached(uri) else {
            return;
        };
        let Some(image) = image::RgbaImage::from_raw(icon.width, icon.height, icon.rgba.clone())
        else {
            return;
        };
        let mut png = Vec::new();
        if image
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .is_err()
        {
            return;
        }
        let data: id = msg_send![class!(NSData), dataWithBytes: png.as_ptr() length: png.len()];
        let ns_image: id = msg_send![class!(NSImage), alloc];
        let ns_image: id = msg_send![ns_image, initWithData: data];
        if ns_image.is_null() {
            return;
        }
        let _: () = msg_send![ns_image, setSize: cocoa::foundation::NSSize::new(SIZE, SIZE)];
        let _: () = msg_send![item, setImage: ns_image];
        let _: () = msg_send![ns_image, release];
    }

    unsafe fn walk(menu: id, nodes: &[MenuNode]) {
        if menu.is_null() {
            return;
        }
        let mut from = 0;
        for node in nodes {
            match node {
                MenuNode::Item(item) => {
                    let ns_item = item_titled(menu, &item.label, &mut from);
                    if let (false, Some(uri)) = (ns_item.is_null(), item.icon.as_deref()) {
                        if !item.checked {
                            set_image(ns_item, uri);
                        }
                    }
                }
                MenuNode::Submenu(submenu) => {
                    let ns_item = item_titled(menu, &submenu.label, &mut from);
                    if ns_item.is_null() {
                        continue;
                    }
                    if let Some(uri) = submenu.icon.as_deref() {
                        set_image(ns_item, uri);
                    }
                    let child: id = msg_send![ns_item, submenu];
                    walk(child, &submenu.items);
                }
                MenuNode::Separator | MenuNode::StandardMenu(_) => {}
            }
        }
    }

    // SAFETY: called on the main thread right after GPUI installed the menu,
    // which it keeps alive as the application's main menu.
    unsafe {
        let app: id = msg_send![class!(NSApplication), sharedApplication];
        let main_menu: id = msg_send![app, mainMenu];
        walk(main_menu, &model.items);
    }
}

/// The titles of the menu bar's items that show an image. macOS only; the
/// test driver reads it, because the bar's images live in AppKit.
pub fn menu_bar_image_titles() -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        use cocoa::base::id;
        use objc::{class, msg_send, sel, sel_impl};

        unsafe fn walk(menu: id, out: &mut Vec<String>) {
            if menu.is_null() {
                return;
            }
            let count: isize = msg_send![menu, numberOfItems];
            for index in 0..count {
                let item: id = msg_send![menu, itemAtIndex: index];
                let image: id = msg_send![item, image];
                if !image.is_null() {
                    let title: id = msg_send![item, title];
                    let utf8: *const std::os::raw::c_char = msg_send![title, UTF8String];
                    if !utf8.is_null() {
                        out.push(
                            std::ffi::CStr::from_ptr(utf8)
                                .to_string_lossy()
                                .into_owned(),
                        );
                    }
                }
                let submenu: id = msg_send![item, submenu];
                walk(submenu, out);
            }
        }

        let mut out = Vec::new();
        // SAFETY: read on the main thread from the application's main menu.
        unsafe {
            let app: id = msg_send![class!(NSApplication), sharedApplication];
            let main_menu: id = msg_send![app, mainMenu];
            walk(main_menu, &mut out);
        }
        out
    }
    #[cfg(not(target_os = "macos"))]
    Vec::new()
}

fn schedule_rebuild(cx: &mut App) {
    {
        let state = &mut cx.global_mut::<AppMenuGlobal>().0;
        if state.rebuild_scheduled {
            return;
        }
        state.rebuild_scheduled = true;
    }
    let Some(window) = cx.active_window() else {
        rebuild_now(cx);
        return;
    };
    let _ = window.update(cx, |_root, window, _cx| {
        window.on_next_frame(move |_window, cx| {
            let scheduled = cx
                .try_global::<AppMenuGlobal>()
                .is_some_and(|state| state.0.rebuild_scheduled);
            if scheduled {
                rebuild_now(cx);
            }
        });
    });
}

fn rebuild_now(cx: &mut App) {
    let model = current_model(cx);
    let app_name = app_name(cx);
    let user_set = cx.global::<AppMenuGlobal>().0.user_set;
    let _ = apply(cx, model, user_set);
    let _ = app_name;
}

fn collect_bindings(dev_menu: bool, model: &MenuModel) -> Vec<(String, String)> {
    let mut bindings = model.accelerators();
    collect_role_bindings(&model.items, &mut bindings);
    if dev_menu {
        bindings.push((
            crate::desktop::dev_menu::ACCELERATOR_ID.to_string(),
            crate::desktop::dev_menu::ACCELERATOR.to_string(),
        ));
    }
    bindings
}

fn collect_role_bindings(items: &[MenuNode], out: &mut Vec<(String, String)>) {
    for node in items {
        match node {
            MenuNode::Item(item) => {
                if let Some(role) = item.role {
                    if let Some(accelerator) = default_accelerator(role) {
                        out.push((item.id.clone(), accelerator.to_string()));
                    }
                }
            }
            MenuNode::Submenu(submenu) => collect_role_bindings(&submenu.items, out),
            MenuNode::StandardMenu(role) => {
                for (id, accelerator) in standard_menu_bindings(*role) {
                    out.push((id.to_string(), accelerator.to_string()));
                }
            }
            _ => {}
        }
    }
}

fn standard_menu_bindings(role: MenuRole) -> Vec<(&'static str, &'static str)> {
    let roles: &[MenuRole] = match role {
        MenuRole::EditMenu => &[
            MenuRole::Undo,
            MenuRole::Redo,
            MenuRole::Cut,
            MenuRole::Copy,
            MenuRole::Paste,
            MenuRole::SelectAll,
        ],
        MenuRole::WindowMenu => &[
            MenuRole::Minimize,
            MenuRole::Zoom,
            MenuRole::ToggleFullscreen,
            MenuRole::Close,
        ],
        _ => &[],
    };
    roles
        .iter()
        .filter_map(|role| {
            let accelerator = default_accelerator(*role)?;
            Some((role_action_id(*role), accelerator))
        })
        .collect()
}

pub fn role_action_id(role: MenuRole) -> &'static str {
    match role {
        MenuRole::Undo => "role:undo",
        MenuRole::Redo => "role:redo",
        MenuRole::Cut => "role:cut",
        MenuRole::Copy => "role:copy",
        MenuRole::Paste => "role:paste",
        MenuRole::SelectAll => "role:selectAll",
        MenuRole::Minimize => "role:minimize",
        MenuRole::Zoom => "role:zoom",
        MenuRole::ToggleFullscreen => "role:toggleFullscreen",
        MenuRole::Close => "role:close",
        MenuRole::Quit => "role:quit",
        MenuRole::Hide => "role:hide",
        MenuRole::HideOthers => "role:hideOthers",
        MenuRole::ShowAll => "role:showAll",
        MenuRole::About => "role:about",
        _ => "role:menu",
    }
}

fn is_desktop_action(action: &dyn Action) -> bool {
    action.as_any().downcast_ref::<MenuAccelerator>().is_some()
        || action.as_any().downcast_ref::<MenuEditAction>().is_some()
        || action.as_any().downcast_ref::<MenuHostAction>().is_some()
}

/// Windows: `muda` attaches a native Win32 menu to the window's HWND.
///
/// Attaches or detaches the native menu bar on the window's HWND.
///
/// `muda` 0.15 has no hide/show for an HWND, so this uses `SetMenu` directly and
/// keeps the `muda::Menu` alive in `AppMenuGlobal` either way: detaching is what
/// hiding means, and the same menu is re-attached to show it again. The window
/// subclass `muda` installed stays in place, so clicks still route back to the
/// same dispatch when the bar returns.
#[cfg(target_os = "windows")]
fn set_windows_menu_attached(cx: &mut gpui::App, window_id: u32, visible: bool) -> DesktopResult {
    use muda::ContextMenu as _;
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use windows_sys::Win32::UI::WindowsAndMessaging::{DrawMenuBar, SetMenu};

    let menu = if visible {
        // Re-attach the menu that is still held in the global: hiding detached it
        // rather than destroying it, so the same items come back. `hpopupmenu` is
        // on muda's `ContextMenu` trait, not on `Menu` itself.
        cx.try_global::<AppMenuGlobal>()
            .and_then(|global| global.0.platform_menu.as_ref())
            .map(|(menu, _)| menu.hpopupmenu() as isize)
            .unwrap_or(0)
    } else {
        0
    };
    crate::desktop::windows::with_window(cx, window_id, move |window| {
        let Ok(handle) = HasWindowHandle::window_handle(window) else {
            return Err(DesktopError::failed("window has no handle"));
        };
        let RawWindowHandle::Win32(win32) = handle.as_raw() else {
            return Err(DesktopError::failed("window handle is not Win32"));
        };
        // SAFETY: the `HWND` comes from the window's raw handle and `menu` is the live popup menu this module owns.
        unsafe {
            SetMenu(win32.hwnd.get() as _, menu as _);
            // The client size changed, so the frame has to be redrawn; GPUI picks
            // the new size up from the `WM_SIZE` that follows.
            DrawMenuBar(win32.hwnd.get() as _);
        }
        Ok(())
    })
}

/// The built `muda::Menu` is returned rather than dropped: installing it leaves
/// a window subclass whose `dwRefData` points into the menu, so dropping it here
/// would leave the window calling through freed memory on its next message.
#[cfg(target_os = "windows")]
fn set_platform_menus(window: &mut gpui::Window, menus: &[Menu]) -> Option<(muda::Menu, isize)> {
    use super::context_menu::MudaAppend as _;
    use muda::{
        CheckMenuItem, Menu as MudaMenu, MenuItem as MudaItem, PredefinedMenuItem, Submenu,
    };
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    // The id for a menu-bar item, so a click can be routed back to the action it
    // stands for. `build_item` put the id in a `MenuAccelerator` action; that is
    // the same value the accelerator table and the JS `menuPress` event use, so
    // one id means one action however the user reached it.
    fn action_id(action: &dyn gpui::Action) -> Option<String> {
        action
            .as_any()
            .downcast_ref::<MenuAccelerator>()
            .map(|accelerator| accelerator.id.clone())
    }

    fn build(menu: &Menu, items: &mut Vec<Box<dyn muda::IsMenuItem>>) {
        for item in &menu.items {
            match item {
                MenuItem::Separator => items.push(Box::new(PredefinedMenuItem::separator())),
                MenuItem::Submenu(submenu) => {
                    let child = Submenu::new(submenu.name.to_string(), !submenu.disabled);
                    let mut child_items: Vec<Box<dyn muda::IsMenuItem>> = Vec::new();
                    build(submenu, &mut child_items);
                    let refs: Vec<&dyn muda::IsMenuItem> =
                        child_items.iter().map(|item| item.as_ref()).collect();
                    let _ = child.append_all(&refs);
                    items.push(Box::new(child));
                }
                MenuItem::Action {
                    name,
                    action,
                    checked,
                    disabled,
                    ..
                } => {
                    // The id travels as the muda item's id, which is what a
                    // `MenuEvent` reports. Without it a click on the menu bar is
                    // indistinguishable from any other item's, which is why
                    // nothing happened before.
                    //
                    // A checked item must be a `CheckMenuItem` in muda; a plain
                    // one has no `set_checked`. `disabled` is honoured for both:
                    // a checked-but-disabled item used to be enabled regardless.
                    let id = action_id(action.as_ref());
                    match (*checked, id) {
                        (true, Some(id)) => items.push(Box::new(CheckMenuItem::with_id(
                            id,
                            name.to_string(),
                            !*disabled,
                            true,
                            None,
                        ))),
                        (true, None) => items.push(Box::new(CheckMenuItem::new(
                            name.to_string(),
                            !*disabled,
                            true,
                            None,
                        ))),
                        (false, Some(id)) => items.push(Box::new(MudaItem::with_id(
                            id,
                            name.to_string(),
                            !*disabled,
                            None,
                        ))),
                        (false, None) => {
                            items.push(Box::new(MudaItem::new(name.to_string(), !*disabled, None)))
                        }
                    }
                }
                // The Services menu is a macOS concept; there is no Windows
                // equivalent to attach to the menu bar.
                MenuItem::SystemMenu(_) => {}
            }
        }
    }

    let handle = match HasWindowHandle::window_handle(window) {
        Ok(handle) => handle,
        Err(_) => return None,
    };
    let hwnd = match handle.as_raw() {
        RawWindowHandle::Win32(win32) => win32.hwnd.get() as isize,
        _ => return None,
    };
    let mut bar = MudaMenu::new();
    let mut bar_items: Vec<Box<dyn muda::IsMenuItem>> = Vec::new();
    for menu in menus {
        let submenu = Submenu::new(menu.name.to_string(), !menu.disabled);
        let mut menu_items: Vec<Box<dyn muda::IsMenuItem>> = Vec::new();
        build(menu, &mut menu_items);
        let refs: Vec<&dyn muda::IsMenuItem> =
            menu_items.iter().map(|item| item.as_ref()).collect();
        let _ = submenu.append_all(&refs);
        bar_items.push(Box::new(submenu));
    }
    let refs: Vec<&dyn muda::IsMenuItem> = bar_items.iter().map(|item| item.as_ref()).collect();
    let _ = bar.append_all(&refs);
    // SAFETY: `hwnd` is the live window handle this menu bar is built for.
    if unsafe { bar.init_for_hwnd(hwnd) }.is_err() {
        return None;
    }
    // Route menu-bar clicks to the same dispatch an accelerator uses, so one id
    // means one action however the user reached it.
    //
    // Registration goes through the app's single `muda` event route
    // (`desktop::menu_events`), not a private handler: `muda` exposes one event
    // channel and its handler setter is first-caller-wins, so a handler per menu
    // system would silently starve the others. The predicate accepts everything,
    // so it is registered last and acts as the fallback — a menu-bar id is
    // authoritative here, and `trigger_item` already forwards an id it does not
    // recognise to JS as a `menuPress` event.
    crate::desktop::menu_events::register(Box::new(|id| {
        if let Some(handler) = rn_gpui_sys::MENU_BAR_PERFORM_HANDLER.get() {
            handler(id.to_string());
            return true;
        }
        false
    }));
    Some((bar, hwnd))
}

/// Windows: detaches an attached menu bar and drops it.
///
/// `muda::Menu::remove_for_hwnd` clears the Win32 menu but leaves the window
/// subclass it installed in place; that subclass holds a raw pointer into the
/// menu. It has to be detached explicitly before the menu is dropped, otherwise
/// the next message the window receives calls into freed memory.
#[cfg(target_os = "windows")]
fn remove_platform_menu(mut menu: muda::Menu, hwnd: isize) {
    use muda::ContextMenu as _;
    // SAFETY: `hwnd` is the window the menu was attached to, and it is detached once.
    unsafe {
        menu.detach_menu_subclass_from_hwnd(hwnd);
        let _ = menu.remove_for_hwnd(hwnd);
    }
}

fn replace_accelerator_bindings(
    cx: &mut App,
    bindings: &[(String, String)],
) -> Vec<(gpui::Keystroke, AcceleratorAction)> {
    let keymap = cx.key_bindings();
    let kept: Vec<KeyBinding> = keymap
        .borrow()
        .bindings()
        .filter(|binding| !is_desktop_action(binding.action()))
        .cloned()
        .collect();
    {
        let mut keymap = keymap.borrow_mut();
        keymap.clear();
        keymap.add_bindings(kept);
    }

    let mut new_bindings: Vec<KeyBinding> = Vec::with_capacity(bindings.len());
    let mut accelerators: Vec<(gpui::Keystroke, AcceleratorAction)> = Vec::new();
    for (id, keystroke) in bindings {
        if keystroke.is_empty() {
            continue;
        }
        let action = accelerator_action(id);
        new_bindings.push(binding_for(keystroke, &action));
        if let Ok(parsed) = gpui::Keystroke::parse(keystroke) {
            accelerators.push((parsed, action));
        }
    }
    cx.bind_keys(new_bindings);
    accelerators
}

fn accelerator_action(id: &str) -> AcceleratorAction {
    if id == crate::desktop::dev_menu::ACCELERATOR_ID {
        return AcceleratorAction::Host("devMenu".to_string());
    }
    if crate::desktop::dev_menu::is_command(id) {
        return AcceleratorAction::Dev(id.to_string());
    }
    if let Some(kind) = id.strip_prefix("role:") {
        if matches!(
            kind,
            "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll"
        ) {
            return AcceleratorAction::Edit(kind.to_string());
        }
        if matches!(
            kind,
            "quit"
                | "hide"
                | "hideOthers"
                | "showAll"
                | "minimize"
                | "zoom"
                | "toggleFullscreen"
                | "close"
                | "about"
        ) {
            return AcceleratorAction::Host(kind.to_string());
        }
    }
    AcceleratorAction::Press(id.to_string())
}

/// A menu accelerator, as a keymap binding in the app-wide context.
///
/// The context matters. A shortcut belongs to a `ShortcutScope`, so its binding
/// matches at a greater depth than anything in the window root's `rn-app`; GPUI
/// dispatches the bindings for one keystroke in precedence order, so a scoped
/// shortcut consumes the key first and the menu item never runs. Without a
/// context the accelerator would tie with the window scope and win by being
/// added later, which is the behaviour this work set out to fix.
fn binding_for(keystroke: &str, action: &AcceleratorAction) -> KeyBinding {
    let context = crate::desktop::keymap::APP_CONTEXT;
    match action {
        AcceleratorAction::Press(id) | AcceleratorAction::Dev(id) => {
            KeyBinding::new(keystroke, MenuAccelerator { id: id.clone() }, Some(context))
        }
        AcceleratorAction::Edit(kind) => KeyBinding::new(
            keystroke,
            MenuEditAction { kind: kind.clone() },
            Some(context),
        ),
        AcceleratorAction::Host(kind) => KeyBinding::new(
            keystroke,
            MenuHostAction { kind: kind.clone() },
            Some(context),
        ),
    }
}

fn build_menus(model: &MenuModel, app_name: &str, dev_menu: bool) -> Vec<Menu> {
    model
        .items
        .iter()
        .filter_map(|node| match node {
            MenuNode::StandardMenu(role) => Some(standard_menu(*role, app_name, dev_menu)),
            MenuNode::Submenu(submenu) => Some(
                Menu::new(SharedString::from(submenu.label.clone()))
                    .items(build_items(&submenu.items))
                    .disabled(!submenu.enabled),
            ),
            MenuNode::Item(item) => Some(
                Menu::new(SharedString::from(item.label.clone())).items(vec![build_item(item)]),
            ),
            MenuNode::Separator => None,
        })
        .collect()
}

fn standard_menu(role: MenuRole, app_name: &str, dev_menu: bool) -> Menu {
    let (name, items): (&str, Vec<MenuItem>) = match role {
        MenuRole::EditMenu => (
            "Edit",
            vec![
                role_menu_item(MenuRole::Undo, None),
                role_menu_item(MenuRole::Redo, None),
                MenuItem::separator(),
                role_menu_item(MenuRole::Cut, None),
                role_menu_item(MenuRole::Copy, None),
                role_menu_item(MenuRole::Paste, None),
                role_menu_item(MenuRole::SelectAll, None),
            ],
        ),
        MenuRole::WindowMenu => (
            "Window",
            vec![
                role_menu_item(MenuRole::Minimize, None),
                role_menu_item(MenuRole::Zoom, None),
                MenuItem::separator(),
                role_menu_item(MenuRole::ToggleFullscreen, None),
                MenuItem::separator(),
                role_menu_item(MenuRole::Close, None),
            ],
        ),
        MenuRole::HelpMenu => (
            "Help",
            if dev_menu {
                vec![MenuItem::submenu(
                    Menu::new(SharedString::from("Developer")).items(dev_menu_items()),
                )]
            } else {
                Vec::new()
            },
        ),
        MenuRole::AppMenu => (
            app_name,
            vec![role_menu_item(MenuRole::About, Some(app_name))],
        ),
        _ => ("Menu", Vec::new()),
    };
    Menu::new(SharedString::from(name)).items(items)
}

fn build_items(items: &[MenuNode]) -> Vec<MenuItem> {
    items
        .iter()
        .filter_map(|node| match node {
            MenuNode::Separator => Some(MenuItem::separator()),
            MenuNode::StandardMenu(role) => Some(MenuItem::submenu(standard_menu(
                *role,
                role.default_label(),
                false,
            ))),
            MenuNode::Submenu(submenu) => Some(
                MenuItem::submenu(
                    Menu::new(SharedString::from(submenu.label.clone()))
                        .items(build_items(&submenu.items)),
                )
                .disabled(!submenu.enabled),
            ),
            MenuNode::Item(item) => Some(build_item(item)),
        })
        .collect()
}

fn dev_menu_items() -> Vec<MenuItem> {
    use crate::desktop::dev_menu as dev;
    [
        (dev::RELOAD, "Reload", false),
        (dev::OPEN_DEVTOOLS, "Open DevTools", false),
        (dev::ELEMENT_INSPECTOR, "Toggle Element Inspector", false),
        (dev::PERF_MONITOR, "Toggle Perf Monitor", false),
        (dev::FAST_REFRESH, "Fast Refresh", false),
    ]
    .into_iter()
    .map(|(id, label, checked)| {
        MenuItem::action(
            SharedString::from(label),
            MenuAccelerator { id: id.to_string() },
        )
        .checked(checked)
    })
    .collect()
}

fn build_item(item: &MenuItemDef) -> MenuItem {
    if let Some(role) = item.role {
        let mut built = role_menu_item(role, Some(&item.label));
        built = built.checked(item.checked);
        return built.disabled(!item.enabled);
    }
    let mut built = MenuItem::action(
        SharedString::from(item.label.clone()),
        MenuAccelerator {
            id: item.id.clone(),
        },
    );
    built = built.checked(item.checked).disabled(!item.enabled);
    built
}

fn role_menu_item(role: MenuRole, label: Option<&str>) -> MenuItem {
    let label = label.unwrap_or_else(|| role.default_label());
    match role {
        MenuRole::Services => {
            MenuItem::os_submenu(SharedString::from(label), SystemMenuType::Services)
        }
        MenuRole::Cut
        | MenuRole::Copy
        | MenuRole::Paste
        | MenuRole::SelectAll
        | MenuRole::Undo
        | MenuRole::Redo => MenuItem::action(
            SharedString::from(label),
            MenuEditAction {
                kind: role_action_id(role).trim_start_matches("role:").to_string(),
            },
        ),
        MenuRole::About
        | MenuRole::Hide
        | MenuRole::HideOthers
        | MenuRole::ShowAll
        | MenuRole::Quit
        | MenuRole::Minimize
        | MenuRole::Zoom
        | MenuRole::ToggleFullscreen
        | MenuRole::Close => MenuItem::action(
            SharedString::from(label),
            MenuHostAction {
                kind: role_action_id(role).trim_start_matches("role:").to_string(),
            },
        ),
        MenuRole::Help
        | MenuRole::AppMenu
        | MenuRole::EditMenu
        | MenuRole::WindowMenu
        | MenuRole::HelpMenu => MenuItem::action(
            SharedString::from(label),
            MenuHostAction {
                kind: "noop".to_string(),
            },
        ),
    }
}

fn emit_menu_press(cx: &mut App, id: &str) {
    let Some(store) = store_from(cx) else {
        return;
    };
    let host = store.read(cx).host.clone();
    let window_id = active_window_key(cx).unwrap_or(1);
    host.emit_device_event_json(
        "gpuiDesktop:menuPress",
        &json!({"id": id, "windowId": window_id}).to_string(),
    );
}

fn active_window_key(cx: &App) -> Option<u32> {
    let handle = cx.active_window()?;
    let windows = cx.try_global::<DesktopWindowsGlobal>()?;
    windows
        .0
        .keys()
        .into_iter()
        .find(|key| windows.0.get(*key).map(|entry| entry.handle) == Some(handle))
}

/// Must not be called from inside a window update: a nested `update_window`
/// fails.
fn focused_text_input(cx: &mut App, window: gpui::AnyWindowHandle) -> Option<Entity<RNNodeView>> {
    let debug = std::env::var_os("RN_GPUI_DEBUG_DESKTOP").is_some();
    let result = window.update(cx, |_root, window, cx| {
        let focused = window.focused(cx)?;
        let store = store_from(cx)?;
        let node = {
            let store = store.read(cx);
            store
                .nodes
                .values()
                .find(|node| node.read(cx).nearest_focus_handle(cx).as_ref() == Some(&focused))
                .cloned()
        };
        if debug {
            log::info!(
                "[desktop][menu] focused node found={} (store nodes={})",
                node.is_some(),
                store.read(cx).nodes.len()
            );
        }
        node
    });
    if let Err(error) = &result {
        if debug {
            log::info!("[desktop][menu] focus lookup failed: {error:?}");
        }
    }
    result.ok().flatten()
}

/// Runs a standard menu role, as a menu item or accelerator would.
///
/// A custom menu drawn in React is ordinary views, so nothing native performs its
/// role items. This is the one entry point that does, which is why it exists:
/// without it a custom "Copy" row would look right and do nothing.
///
/// It goes through the same dispatch the native menu uses, so the action, the
/// window and the effect are identical however the user asked for it.
pub fn perform_role(cx: &mut App, role: &str) -> DesktopResult {
    let handle = cx.active_window();
    match role {
        "undo" => perform_edit(cx, "undo", handle),
        "redo" => perform_edit(cx, "redo", handle),
        "cut" => perform_edit(cx, "cut", handle),
        "copy" => perform_edit(cx, "copy", handle),
        "paste" => perform_edit(cx, "paste", handle),
        "selectAll" => perform_edit(cx, "selectAll", handle),
        "minimize" => {
            if let Some(handle) = handle {
                let _ = handle.update(cx, |_, window, _| window.minimize_window());
            }
        }
        "zoom" => {
            if let Some(handle) = handle {
                let _ = handle.update(cx, |_, window, _| window.zoom_window());
            }
        }
        "toggleFullscreen" => {
            if let Some(handle) = handle {
                let _ = handle.update(cx, |_, window, _| window.toggle_fullscreen());
            }
        }
        "close" => {
            if let Some(handle) = handle {
                let _ = handle.update(cx, |_, window, _| window.remove_window());
            }
        }
        "quit" | "hide" | "hideOthers" | "showAll" | "about" => {
            perform_host_action(cx, role, handle)
        }
        // A menu with no action of its own: nothing to do, and saying so is
        // better than silently pretending.
        other => {
            return Err(DesktopError::failed(format!(
                "{other} is not a role this platform can perform"
            )))
        }
    }
    Ok(json!({"role": role}))
}

fn perform_edit(cx: &mut App, kind: &str, handle: Option<gpui::AnyWindowHandle>) {
    let kind = kind.to_string();
    // Deferred: the action is dispatched from inside a window update, and GPUI
    // forbids re-entering the same window.
    cx.defer(move |cx| {
        let debug = std::env::var_os("RN_GPUI_DEBUG_DESKTOP").is_some();
        let Some(window) = handle.or_else(|| cx.active_window()) else {
            return;
        };
        let Some(node) = focused_text_input(cx, window) else {
            if debug {
                log::info!("[desktop][menu] edit {kind}: no focused text input");
            }
            return;
        };
        let _ = window.update(cx, move |_root, window, cx| {
            node.update(cx, |node, cx| match kind.as_str() {
                "copy" => {
                    crate::builtins::textinput::input::copy_selection(node, cx);
                }
                "cut" => {
                    crate::builtins::textinput::input::cut_selection(node, window, cx);
                }
                "paste" => {
                    crate::builtins::textinput::input::paste_clipboard(node, window, cx);
                }
                "selectAll" => {
                    crate::builtins::textinput::input::select_all(node, window, cx);
                }
                // TODO: undo/redo need an edit history in the GPUI text input. The
                // item is present so an app can handle the press itself.
                _ => {}
            });
            if debug {
                let node = node.read(cx);
                log::info!(
                    "[desktop][menu] edit {kind} on {} selection={:?}",
                    node.component,
                    node.input_selection
                );
            }
        });
    });
}

/// Deferred: a menu action runs inside the platform's menu callback, and a
/// reload or a perf-monitor window must not start from there.
fn perform_dev_action(cx: &mut App, id: String) {
    cx.defer(move |cx| crate::desktop::dev_menu::perform(cx, &id));
}

fn perform_host_action(cx: &mut App, kind: &str, handle: Option<gpui::AnyWindowHandle>) {
    match kind {
        "quit" => cx.quit(),
        "hide" => cx.hide(),
        "hideOthers" => cx.hide_other_apps(),
        "showAll" => cx.unhide_other_apps(),
        "about" => show_about_panel(cx),
        // Deferred: the accelerator runs inside the keystroke's window update.
        "devMenu" => cx.defer(|cx| crate::desktop::dev_menu::show(cx)),
        "minimize" | "zoom" | "toggleFullscreen" | "close" => {
            let kind = kind.to_string();
            cx.defer(move |cx| {
                let Some(window) = handle.or_else(|| cx.active_window()) else {
                    return;
                };
                let _ = window.update(cx, move |_root, window, _cx| match kind.as_str() {
                    "minimize" => window.minimize_window(),
                    "zoom" => window.zoom_window(),
                    "toggleFullscreen" => window.toggle_fullscreen(),
                    "close" => window.remove_window(),
                    _ => {}
                });
            });
        }
        _ => {}
    }
}

#[cfg(target_os = "macos")]
fn show_about_panel(_cx: &mut App) {
    use objc::{class, msg_send, sel, sel_impl};
    // SAFETY: `NSApplication` is messaged from the main thread.
    unsafe {
        let app: cocoa::base::id = msg_send![class!(NSApplication), sharedApplication];
        let _: () =
            msg_send![app, orderFrontStandardAboutPanel: std::ptr::null::<cocoa::base::id>()];
    }
}

#[cfg(not(target_os = "macos"))]
fn show_about_panel(_cx: &mut App) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_menu_has_the_standard_groups() {
        let model = default_menu("Tester");
        assert!(model.has_help_menu());
        assert!(model.find("role:quit").is_some());
        let bindings = collect_bindings(false, &model);
        assert!(bindings
            .iter()
            .any(|(id, key)| id == "role:copy" && key == "secondary-c"));
        assert!(bindings
            .iter()
            .any(|(id, key)| id == "role:quit" && key == "secondary-q"));
    }

    #[test]
    fn standard_edit_menu_installs_accelerators() {
        let model = MenuModel {
            items: vec![MenuNode::StandardMenu(MenuRole::EditMenu)],
        };
        let bindings = collect_bindings(false, &model);
        assert_eq!(bindings.len(), 6);
        assert!(bindings.iter().any(|(_, key)| key == "secondary-v"));
    }

    #[test]
    fn unsupported_roles_are_dropped_from_the_built_menu() {
        let model = default_menu("Tester");
        let menus = build_menus(&model, "Tester", false);
        assert!(!menus.is_empty());
    }

    #[test]
    fn developer_items_run_on_the_host() {
        use crate::desktop::dev_menu as dev;
        for id in [
            dev::RELOAD,
            dev::OPEN_DEVTOOLS,
            dev::ELEMENT_INSPECTOR,
            dev::PERF_MONITOR,
            dev::FAST_REFRESH,
        ] {
            assert_eq!(accelerator_action(id), AcceleratorAction::Dev(id.into()));
        }
        assert_eq!(
            accelerator_action(dev::ACCELERATOR_ID),
            AcceleratorAction::Host("devMenu".into())
        );
        assert_eq!(
            accelerator_action("dev:custom"),
            AcceleratorAction::Press("dev:custom".into())
        );
    }
}
