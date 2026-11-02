use crate::desktop::menu_model::{MenuItemDef, MenuModel, MenuNode};
use crate::desktop::perf_monitor;
use crate::desktop::windows::{DesktopWindowsGlobal, MAIN_WINDOW_KEY};
use crate::store::store_from;
use gpui::{App, Global};
use serde_json::{json, Value};
use std::cell::RefCell;

pub const RELOAD: &str = "dev:reload";
pub const OPEN_DEVTOOLS: &str = "dev:openDevTools";
pub const ELEMENT_INSPECTOR: &str = "dev:elementInspector";
pub const PERF_MONITOR: &str = "dev:perfMonitor";
pub const FAST_REFRESH: &str = "dev:fastRefresh";
pub const ACCELERATOR: &str = "secondary-d";
pub const ACCELERATOR_ID: &str = "dev:menu";

#[derive(Default)]
pub struct DevSettings {
    pub installed: bool,
    pub hot_loading: bool,
    pub profiling: bool,
    pub inspector: bool,
}

pub struct DevSettingsGlobal(pub RefCell<DevSettings>);
impl Global for DevSettingsGlobal {}

pub fn is_installed(cx: &App) -> bool {
    cx.try_global::<DevSettingsGlobal>()
        .is_some_and(|state| state.0.borrow().installed)
}

pub fn install(cx: &mut App, enabled: bool) {
    cx.set_global(DevSettingsGlobal(RefCell::new(DevSettings {
        installed: enabled,
        hot_loading: true,
        ..Default::default()
    })));
}

pub fn menu_model(cx: &App) -> MenuModel {
    let (hot_loading, inspector) = cx
        .try_global::<DevSettingsGlobal>()
        .map(|state| {
            let state = state.0.borrow();
            (state.hot_loading, state.inspector)
        })
        .unwrap_or((false, false));
    let profiling = perf_monitor::is_enabled(cx);
    let item = |id: &str, label: &str, checked: bool| {
        MenuNode::Item(MenuItemDef {
            id: id.to_string(),
            label: label.to_string(),
            accelerator: None,
            enabled: true,
            checked,
            role: None,
            icon: None,
        })
    };
    MenuModel {
        items: vec![
            item(RELOAD, "Reload", false),
            item(OPEN_DEVTOOLS, "Open DevTools", false),
            MenuNode::Separator,
            item(ELEMENT_INSPECTOR, "Toggle Element Inspector", inspector),
            item(PERF_MONITOR, "Toggle Perf Monitor", profiling),
            item(FAST_REFRESH, "Fast Refresh", hot_loading),
        ],
    }
}

pub fn show(cx: &mut App) {
    if !is_installed(cx) {
        log::warn!("[desktop][devmenu] the Dev Menu is not enabled in this build");
        return;
    }
    // The panel may have been closed since it was recorded, so liveness is
    // asked of the window rather than remembered.
    if let Some(handle) = open_panel(cx) {
        let _ = handle.update(cx, |_root: gpui::AnyView, window, _cx| {
            window.activate_window();
        });
        return;
    }
    // `WindowKind::Dialog` is a sheet on macOS, so this is a normal window
    // centred over the app window.
    let size = gpui::size(gpui::px(380.0), gpui::px(460.0));
    let bounds = main_window(cx)
        .and_then(|handle| {
            handle
                .update(cx, |_root: gpui::AnyView, window, _cx| window.bounds())
                .ok()
        })
        .map(|parent| {
            gpui::Bounds::new(
                gpui::point(
                    parent.origin.x + (parent.size.width - size.width) / 2.0,
                    parent.origin.y + (parent.size.height - size.height) / 2.0,
                ),
                size,
            )
        })
        .unwrap_or_else(|| gpui::Bounds::centered(None, size, cx));
    let options = gpui::WindowOptions {
        window_bounds: Some(gpui::WindowBounds::Windowed(bounds)),
        kind: gpui::WindowKind::Normal,
        is_resizable: false,
        window_min_size: Some(size),
        titlebar: Some(gpui::TitlebarOptions {
            title: Some("Dev Menu".into()),
            appears_transparent: false,
            traffic_light_position: None,
        }),
        ..Default::default()
    };
    match cx.open_window(options, |_window, cx| {
        gpui::AppContext::new(cx, |_cx| DevMenuPanel::new())
    }) {
        Ok(handle) => {
            let handle: gpui::AnyWindowHandle = handle.into();
            cx.set_global(DevMenuPanelGlobal(RefCell::new(Some(handle))));
            let _ = handle.update(cx, |_root: gpui::AnyView, window, _cx| {
                crate::desktop::platform_window::disable_window_animation(window);
            });
            log::info!("[desktop][devmenu] opened the panel");
        }
        Err(error) => log::error!("[desktop][devmenu] could not open the panel: {error}"),
    }
}

pub fn hide(cx: &mut App) {
    let Some(handle) = open_panel(cx) else {
        forget_panel(cx);
        return;
    };
    forget_panel(cx);
    let _ = handle.update(cx, |_root: gpui::AnyView, window, _cx| {
        window.remove_window()
    });
}

pub struct DevMenuPanelGlobal(pub RefCell<Option<gpui::AnyWindowHandle>>);
impl Global for DevMenuPanelGlobal {}

fn open_panel(cx: &mut App) -> Option<gpui::AnyWindowHandle> {
    let handle = cx
        .try_global::<DevMenuPanelGlobal>()
        .and_then(|panel| *panel.0.borrow())?;
    handle
        .update(cx, |_root: gpui::AnyView, _window, _cx| ())
        .ok()?;
    Some(handle)
}

fn forget_panel(cx: &mut App) {
    if let Some(panel) = cx.try_global::<DevMenuPanelGlobal>() {
        panel.0.borrow_mut().take();
    }
}

const DEFAULT_BUNDLER_PORT: u32 = 8081;

fn parse_bundler(text: &str) -> Result<(String, u32), &'static str> {
    let text = text.trim();
    let text = text
        .strip_prefix("http://")
        .or_else(|| text.strip_prefix("https://"))
        .unwrap_or(text)
        .trim_end_matches('/');
    let (host, port) = match text.rsplit_once(':') {
        Some((host, port)) => (
            host,
            port.parse::<u32>()
                .ok()
                .filter(|port| (1..=65535).contains(port))
                .ok_or("The port must be a number from 1 to 65535.")?,
        ),
        None => (text, DEFAULT_BUNDLER_PORT),
    };
    if host.is_empty() {
        return Err("Enter the bundler's address as host:port.");
    }
    Ok((host.to_string(), port))
}

fn is_bundler_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | ':' | '-' | '_' | '/' | '[' | ']')
}

pub struct DevMenuPanel {
    bundler: Option<String>,
    bundler_error: Option<&'static str>,
    focus: Option<gpui::FocusHandle>,
}

impl DevMenuPanel {
    pub fn new() -> Self {
        Self {
            bundler: None,
            bundler_error: None,
            focus: None,
        }
    }

    fn render_bundler(
        &mut self,
        text: String,
        window: &mut gpui::Window,
        cx: &mut gpui::Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        use gpui::{InteractiveElement, ParentElement, Styled};

        let focus = self.focus.get_or_insert_with(|| cx.focus_handle()).clone();
        if !focus.is_focused(window) {
            window.focus(&focus, cx);
        }
        gpui::div()
            .id(gpui::SharedString::from("dev-menu-bundler"))
            .track_focus(&focus)
            .size_full()
            .flex()
            .flex_col()
            .gap_2()
            .p_3()
            .bg(gpui::rgb(0xf4f5f7))
            .text_color(gpui::rgb(0x18212f))
            .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, window, cx| {
                let Some(text) = this.bundler.as_mut() else {
                    return;
                };
                let keystroke = &event.keystroke;
                let command = keystroke.modifiers.platform || keystroke.modifiers.control;
                match keystroke.key.as_str() {
                    "escape" => {
                        this.bundler = None;
                        this.bundler_error = None;
                    }
                    "backspace" => {
                        text.pop();
                        this.bundler_error = None;
                    }
                    "enter" => match parse_bundler(text) {
                        Ok((host, port)) => {
                            let applied = store_from(cx).is_some_and(|store| {
                                store.read(cx).host.set_dev_server(&host, port)
                            });
                            if applied {
                                log::info!(
                                    "[desktop][devmenu] bundler set to {host}:{port}; reloading"
                                );
                                forget_panel(cx);
                                window.remove_window();
                                return;
                            }
                            this.bundler_error =
                                Some("This build is not connected to a dev server.");
                        }
                        Err(error) => this.bundler_error = Some(error),
                    },
                    "v" if command => {
                        if let Some(pasted) = cx.read_from_clipboard().and_then(|item| item.text())
                        {
                            text.extend(pasted.chars().filter(|c| is_bundler_char(*c)));
                            this.bundler_error = None;
                        }
                    }
                    _ if command => {}
                    _ => {
                        if let Some(typed) = keystroke.key_char.as_ref() {
                            text.extend(typed.chars().filter(|c| is_bundler_char(*c)));
                            this.bundler_error = None;
                        }
                    }
                }
                cx.stop_propagation();
                cx.notify();
            }))
            .child(
                gpui::div()
                    .px_3()
                    .py_2()
                    .text_size(gpui::px(18.0))
                    .child("Configure Bundler"),
            )
            .child(
                gpui::div()
                    .px_3()
                    .text_size(gpui::px(13.0))
                    .text_color(gpui::rgba(0x000000aa))
                    .child("The Metro server to load the bundle from, as host:port."),
            )
            .child(
                gpui::div()
                    .mx_3()
                    .px_2()
                    .py_2()
                    .rounded(gpui::px(3.0))
                    .border_1()
                    .border_color(gpui::rgb(0x3b82f6))
                    .bg(gpui::white())
                    .text_size(gpui::px(14.0))
                    // The caret: the field is always at the end of the text.
                    .child(format!("{text}\u{2502}")),
            )
            .children(self.bundler_error.map(|error| {
                gpui::div()
                    .px_3()
                    .text_size(gpui::px(13.0))
                    .text_color(gpui::rgb(0xb91c1c))
                    .child(error)
            }))
            .child(
                gpui::div()
                    .px_3()
                    .text_size(gpui::px(13.0))
                    .text_color(gpui::rgba(0x00000099))
                    .child("Enter applies it and reloads. Escape goes back."),
            )
    }
}

impl gpui::Render for DevMenuPanel {
    fn render(
        &mut self,
        window: &mut gpui::Window,
        cx: &mut gpui::Context<Self>,
    ) -> impl gpui::IntoElement {
        use gpui::{InteractiveElement, IntoElement, ParentElement, Styled};

        window.on_window_should_close(cx, |_window, cx| {
            forget_panel(cx);
            true
        });

        if let Some(text) = self.bundler.clone() {
            return self.render_bundler(text, window, cx);
        }
        let bundler = store_from(cx)
            .map(|store| store.read(cx).host.dev_server_address())
            .unwrap_or_default();

        let rows = menu_model(cx);
        let mut elements: Vec<gpui::AnyElement> = Vec::new();
        for node in rows.items {
            match node {
                MenuNode::Separator => {
                    elements.push(
                        gpui::div()
                            .h(gpui::px(1.0))
                            .my_1()
                            .bg(gpui::rgba(0x00000022))
                            .into_any_element() as gpui::AnyElement,
                    );
                }
                MenuNode::Item(item) => {
                    let id = item.id.clone();
                    elements.push(
                        gpui::div()
                            .id(gpui::SharedString::from(format!("dev-menu-{}", item.id)))
                            .flex()
                            .flex_row()
                            .items_center()
                            .justify_between()
                            .px_3()
                            .py_2()
                            .rounded(gpui::px(3.0))
                            .text_size(gpui::px(14.0))
                            .cursor_pointer()
                            .hover(|style| style.bg(gpui::rgba(0x00000011)))
                            .child(item.label.clone())
                            .child(if item.checked { "✓" } else { "" })
                            .on_mouse_down(
                                gpui::MouseButton::Left,
                                cx.listener(move |_this, _event, window, cx| {
                                    if let Some(handler) =
                                        rn_gpui_sys::DEV_MENU_PERFORM_HANDLER.get()
                                    {
                                        handler(id.clone());
                                    }
                                    forget_panel(cx);
                                    window.remove_window();
                                }),
                            )
                            .into_any_element(),
                    );
                }
                MenuNode::Submenu(_) | MenuNode::StandardMenu(_) => {}
            }
        }

        gpui::div()
            .id(gpui::SharedString::from("dev-menu-panel"))
            .size_full()
            .flex()
            .flex_col()
            .gap_1()
            .p_3()
            .bg(gpui::rgb(0xf4f5f7))
            .text_color(gpui::rgb(0x18212f))
            .child(
                gpui::div()
                    .px_3()
                    .py_2()
                    .text_size(gpui::px(18.0))
                    .child("Dev Menu"),
            )
            .children(elements)
            // Only with a dev server: a release bundle has nowhere else to
            // load from.
            .children((!bundler.is_empty()).then(|| {
                gpui::div()
                    .id(gpui::SharedString::from("dev-menu-bundler-row"))
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .px_3()
                    .py_2()
                    .rounded(gpui::px(3.0))
                    .text_size(gpui::px(14.0))
                    .cursor_pointer()
                    .hover(|style| style.bg(gpui::rgba(0x00000011)))
                    .child("Configure Bundler…")
                    .child(
                        gpui::div()
                            .text_color(gpui::rgba(0x00000099))
                            .child(bundler.clone()),
                    )
                    .on_mouse_down(
                        gpui::MouseButton::Left,
                        cx.listener(move |this, _event, _window, cx| {
                            this.bundler = Some(bundler.clone());
                            this.bundler_error = None;
                            cx.notify();
                        }),
                    )
            }))
            .child(
                gpui::div()
                    .id(gpui::SharedString::from("dev-menu-close"))
                    .mt_2()
                    .px_3()
                    .py_2()
                    .rounded(gpui::px(3.0))
                    .text_size(gpui::px(14.0))
                    .text_color(gpui::rgba(0x00000099))
                    .cursor_pointer()
                    .hover(|style| style.bg(gpui::rgba(0x00000011)))
                    .child("Close")
                    .on_mouse_down(
                        gpui::MouseButton::Left,
                        cx.listener(|_this, _event, window, cx| {
                            forget_panel(cx);
                            window.remove_window();
                        }),
                    ),
            )
    }
}

pub fn is_command(id: &str) -> bool {
    matches!(
        id,
        RELOAD | OPEN_DEVTOOLS | ELEMENT_INSPECTOR | PERF_MONITOR | FAST_REFRESH
    )
}

pub fn perform(cx: &mut App, id: &str) {
    match id {
        RELOAD => {
            if let Some(store) = store_from(cx) {
                store.read(cx).host.request_reload();
            }
        }
        OPEN_DEVTOOLS => {
            if let Some(store) = store_from(cx) {
                store.read(cx).host.open_debugger();
            }
            emit(cx, "gpuiDesktop:devToolsRequested", json!({}));
        }
        ELEMENT_INSPECTOR => {
            let enabled = toggle(cx, "inspector");
            // The event React Native's `AppContainer` listens for; every
            // platform's dev menu toggles the inspector by emitting it.
            emit(cx, "toggleElementInspector", json!({}));
            emit(
                cx,
                "gpuiDesktop:elementInspector",
                json!({"enabled": enabled}),
            );
        }
        PERF_MONITOR => {
            let enabled = !perf_monitor::is_enabled(cx);
            perf_monitor::set_enabled(cx, enabled);
        }
        FAST_REFRESH => {
            let enabled = toggle(cx, "hotLoading");
            emit(cx, "gpuiDesktop:fastRefresh", json!({"enabled": enabled}));
        }
        _ => {}
    }
}

pub fn apply_setting(cx: &mut App, name: &str, enabled: bool) {
    match name {
        "profiling" => {
            perf_monitor::set_enabled(cx, enabled);
        }
        "hotLoading" => {
            if let Some(state) = cx.try_global::<DevSettingsGlobal>() {
                state.0.borrow_mut().hot_loading = enabled;
            }
            emit(cx, "gpuiDesktop:fastRefresh", json!({"enabled": enabled}));
        }
        // `DevSettings.toggleElementInspector` has no value to pass.
        "inspectorToggle" => {
            let enabled = toggle(cx, "inspector");
            emit(cx, "toggleElementInspector", json!({}));
            emit(
                cx,
                "gpuiDesktop:elementInspector",
                json!({"enabled": enabled}),
            );
        }
        "inspector" => {
            if let Some(state) = cx.try_global::<DevSettingsGlobal>() {
                state.0.borrow_mut().inspector = enabled;
            }
            emit(
                cx,
                "gpuiDesktop:elementInspector",
                json!({"enabled": enabled}),
            );
        }
        _ => {}
    }
}

fn toggle(cx: &App, which: &str) -> bool {
    let Some(state) = cx.try_global::<DevSettingsGlobal>() else {
        return false;
    };
    let mut state = state.0.borrow_mut();
    let value = match which {
        "inspector" => &mut state.inspector,
        "hotLoading" => &mut state.hot_loading,
        "profiling" => &mut state.profiling,
        _ => return false,
    };
    *value = !*value;
    *value
}

fn emit(cx: &App, name: &str, payload: Value) {
    let Some(store) = store_from(cx) else {
        return;
    };
    store
        .read(cx)
        .host
        .emit_device_event_json(name, &payload.to_string());
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn main_window(cx: &App) -> Option<gpui::AnyWindowHandle> {
    cx.try_global::<DesktopWindowsGlobal>()
        .and_then(|windows| windows.0.get(MAIN_WINDOW_KEY).map(|entry| entry.handle))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accelerator_is_command_or_control_d() {
        assert_eq!(ACCELERATOR, "secondary-d");
        assert_eq!(ACCELERATOR_ID, "dev:menu");
    }

    #[test]
    fn bundler_addresses_parse_with_and_without_a_port() {
        assert_eq!(
            parse_bundler("localhost:8082"),
            Ok(("localhost".into(), 8082))
        );
        assert_eq!(parse_bundler(" 10.0.0.5 "), Ok(("10.0.0.5".into(), 8081)));
        assert_eq!(
            parse_bundler("http://my-mac.local:9000/"),
            Ok(("my-mac.local".into(), 9000))
        );
        assert!(parse_bundler("").is_err());
        assert!(parse_bundler(":8081").is_err());
        assert!(parse_bundler("localhost:0").is_err());
        assert!(parse_bundler("localhost:port").is_err());
    }

    #[test]
    fn dev_item_ids_are_unique() {
        let ids = [
            RELOAD,
            OPEN_DEVTOOLS,
            ELEMENT_INSPECTOR,
            PERF_MONITOR,
            FAST_REFRESH,
        ];
        let unique: std::collections::HashSet<_> = ids.iter().collect();
        assert_eq!(unique.len(), ids.len());
    }
}
