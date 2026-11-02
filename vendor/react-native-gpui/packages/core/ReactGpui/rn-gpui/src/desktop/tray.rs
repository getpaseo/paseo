//! Windows has no anchored popover: the window opens at the click point. Linux
//! AppIndicator only supports menus, not click-to-popover.

use crate::bootstrap::WindowTitleBar;
use crate::desktop::errors::{DesktopError, DesktopResult};
use crate::desktop::menu_model::{self, MenuModel};
use crate::desktop::windows::{self, OpenWindowOptions, WindowRoleOverride};
use gpui::{App, Global};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::HashSet;

#[derive(Clone)]
pub struct TrayConfig {
    pub id: String,
    pub tooltip: Option<String>,
    pub title: Option<String>,
    /// RGBA pixels for the icon. `None` uses a built-in template glyph.
    pub icon: Option<(Vec<u8>, u32, u32)>,
    pub icon_is_template: bool,
    pub component: Option<String>,
    pub width: f32,
    pub height: f32,
    pub menu: Option<MenuModel>,
    pub menu_on_left_click: bool,
    pub quit_on_last_window_closed: bool,
    /// Hide the last window when it is closed instead of destroying it, so opening
    /// the app again from the tray shows the same window with its state. Off by
    /// default: a closed window is gone and a reopened one starts fresh.
    pub hide_window_on_close: bool,
    pub accessory: bool,
}

impl Default for TrayConfig {
    fn default() -> Self {
        Self {
            id: "tray".to_string(),
            tooltip: None,
            title: None,
            icon: None,
            icon_is_template: true,
            component: None,
            width: 320.0,
            height: 420.0,
            menu: None,
            menu_on_left_click: false,
            quit_on_last_window_closed: false,
            hide_window_on_close: false,
            accessory: true,
        }
    }
}

impl TrayConfig {
    #[must_use]
    pub fn hide_window_on_close(mut self, hide: bool) -> Self {
        self.hide_window_on_close = hide;
        self
    }

    #[must_use]
    pub fn id(mut self, id: impl Into<String>) -> Self {
        self.id = id.into();
        self
    }

    #[must_use]
    pub fn tooltip(mut self, tooltip: impl Into<String>) -> Self {
        self.tooltip = Some(tooltip.into());
        self
    }

    #[must_use]
    pub fn component(mut self, component: impl Into<String>) -> Self {
        self.component = Some(component.into());
        self
    }

    #[must_use]
    pub fn size(mut self, width: f32, height: f32) -> Self {
        self.width = width.max(120.0);
        self.height = height.max(120.0);
        self
    }

    #[must_use]
    pub fn icon_rgba(mut self, rgba: Vec<u8>, width: u32, height: u32) -> Self {
        self.icon = Some((rgba, width, height));
        self
    }

    /// An encoded image (PNG, JPEG, …), typically from `include_bytes!`. One
    /// that does not decode is logged and the built-in glyph is used instead.
    #[must_use]
    pub fn icon_bytes(mut self, bytes: &[u8]) -> Self {
        match crate::desktop::icon::decode(bytes.to_vec()) {
            Ok(icon) => self.icon = Some((icon.rgba, icon.width, icon.height)),
            Err(error) => log::error!("[desktop][tray] icon: {error}"),
        }
        self
    }

    /// macOS: draw the icon as a template the menu bar tints for light and
    /// dark mode.
    #[must_use]
    pub fn icon_template(mut self, template: bool) -> Self {
        self.icon_is_template = template;
        self
    }

    #[must_use]
    pub fn menu(mut self, menu: MenuModel) -> Self {
        self.menu = Some(menu);
        self
    }

    #[must_use]
    pub fn accessory(mut self, accessory: bool) -> Self {
        self.accessory = accessory;
        self
    }
}

pub struct TrayState {
    icon: Option<tray_icon::TrayIcon>,
    config: TrayConfig,
    pub popover: Option<u32>,
    visible: bool,
    clicks: u32,
    pub popover_dismissed_at: Option<std::time::Instant>,
    /// The app's own quit-on-last-window policy, put back when the tray goes.
    app_quits_on_last_window: Option<bool>,
}

/// A click on the icon while the popover is open first dismisses it (it loses
/// activation) and then arrives here; within this window it must not reopen it.
const REOPEN_GUARD: std::time::Duration = std::time::Duration::from_millis(350);

pub struct TrayGlobal(pub RefCell<TrayState>);
impl Global for TrayGlobal {}

pub fn is_installed(cx: &App) -> bool {
    cx.try_global::<TrayGlobal>().is_some()
}

/// Create the tray icon. Called once, after the app has started, because
/// `NSStatusItem` needs a running `NSApplication`.
pub fn install(cx: &mut App, config: TrayConfig) -> DesktopResult {
    if is_installed(cx) {
        return Err(DesktopError::failed("a tray icon is already installed"));
    }
    let app_quits_on_last_window = cx
        .try_global::<crate::desktop::windows::QuitOnLastWindowClosed>()
        .map(|flag| flag.0);
    cx.set_global(TrayGlobal(RefCell::new(TrayState {
        icon: None,
        config: config.clone(),
        popover: None,
        visible: true,
        clicks: 0,
        popover_dismissed_at: None,
        app_quits_on_last_window,
    })));
    let quits_on_last_window =
        config.quit_on_last_window_closed && app_quits_on_last_window.unwrap_or(true);
    cx.set_global(crate::desktop::windows::QuitOnLastWindowClosed(
        quits_on_last_window,
    ));
    // GPUI quits by itself when its last window closes on every platform but macOS,
    // and our flag is only consulted after that: with the flag off, closing the
    // main window still ended the app, tray and all. While a tray keeps the app
    // alive, quitting is explicit — the tray's Exit, or the app asking — and
    // `windows::maybe_quit` stays the one place that applies the flag.
    cx.set_quit_mode(if quits_on_last_window {
        gpui::QuitMode::Default
    } else {
        gpui::QuitMode::Explicit
    });
    match build_icon(&config) {
        Ok(icon) => {
            attach_native_menu(&icon, &config);
            cx.global_mut::<TrayGlobal>().0.borrow_mut().icon = Some(icon);
            log::info!("[desktop][tray] installed `{}`", config.id);
            Ok(json!({"id": config.id}))
        }
        Err(error) => {
            log::error!("[desktop][tray] could not create the icon: {error}");
            Err(DesktopError::failed(format!(
                "could not create the tray icon: {error}"
            )))
        }
    }
}

pub fn destroy(cx: &mut App) -> DesktopResult {
    let (config, popover, app_quits_on_last_window) = {
        let Some(tray) = cx.try_global::<TrayGlobal>() else {
            return Err(DesktopError::not_found("no tray icon is installed"));
        };
        let mut tray = tray.0.borrow_mut();
        let popover = tray.popover.take();
        tray.icon = None;
        NATIVE_MENU.store(0, std::sync::atomic::Ordering::Relaxed);
        tray.visible = false;
        (
            tray.config.id.clone(),
            popover,
            tray.app_quits_on_last_window,
        )
    };
    if let Some(key) = popover {
        let _ = windows::close_window(cx, key, true);
    }
    cx.remove_global::<TrayGlobal>();
    if let Some(quit) = app_quits_on_last_window {
        cx.set_global(crate::desktop::windows::QuitOnLastWindowClosed(quit));
    }
    // Without a tray there is nothing left to keep the app alive: if no window is
    // open either, the app ends, as it would have when its last window closed.
    cx.set_quit_mode(gpui::QuitMode::Default);
    windows::maybe_quit(cx);
    Ok(json!({"id": config, "destroyed": true}))
}

pub fn handle_click(cx: &mut App, rect: TrayRect, button: TrayButton) {
    let (config, menu) = {
        let Some(tray) = cx.try_global::<TrayGlobal>() else {
            return;
        };
        let mut tray = tray.0.borrow_mut();
        tray.clicks += 1;
        (tray.config.clone(), tray.config.menu.clone())
    };
    if wants_menu(menu.is_some(), config.menu_on_left_click, button) {
        if let Some(menu) = menu {
            show_menu(cx, menu, rect);
        }
        return;
    }
    if config.component.is_some() {
        toggle_popover(cx, rect);
        return;
    }
    log::debug!("[desktop][tray] click with no popover component and no menu");
}

pub fn toggle_popover(cx: &mut App, rect: TrayRect) {
    let open = cx
        .try_global::<TrayGlobal>()
        .and_then(|tray| tray.0.borrow().popover);
    if open.is_some() {
        hide_popover(cx);
        return;
    }
    let just_dismissed = cx.try_global::<TrayGlobal>().is_some_and(|tray| {
        tray.0
            .borrow()
            .popover_dismissed_at
            .is_some_and(|at| at.elapsed() < REOPEN_GUARD)
    });
    if just_dismissed {
        return;
    }
    show_popover(cx, rect);
}

pub fn show_popover(cx: &mut App, rect: TrayRect) {
    let config = match cx.try_global::<TrayGlobal>() {
        Some(tray) => tray.0.borrow().config.clone(),
        None => return,
    };
    let Some(component) = config.component.clone() else {
        return;
    };
    let work_area = crate::desktop::platform_window::work_area_at(
        rect.x + rect.width / 2.0,
        rect.y + rect.height / 2.0,
    );
    let (x, y) = popover_origin(rect, config.width, config.height, work_area);
    let options = OpenWindowOptions {
        component,
        props: None,
        title: Some(config.tooltip.clone().unwrap_or_else(|| config.id.clone())),
        width: Some(config.width),
        height: Some(config.height),
        x: Some(x),
        y: Some(y),
        resizable: false,
        // A popover has no title bar at all; `popup` is what makes it frameless.
        title_bar: WindowTitleBar::Default,
        traffic_light_position: None,
        role: WindowRoleOverride::TrayPopover,
        popup: true,
    };
    match windows::open_window(cx, options) {
        Ok(key) => {
            cx.global_mut::<TrayGlobal>().0.borrow_mut().popover = Some(key);
            let _ = windows::focus(cx, key);
        }
        Err(error) => log::error!("[desktop][tray] could not open the popover: {error}"),
    }
}

/// Where a popover of `width` x `height` goes, in points: centred on the icon,
/// below it when there is room — a menu bar at the top of the screen — and above
/// it when there is not, which is where a taskbar at the bottom puts it.
///
/// `work_area` is `(x, y, width, height)` of the usable part of the display, when
/// the platform can say. Without it the popover goes where the icon puts it, below
/// and centred, as it always did. With it, the popover is also kept inside the
/// area on every side, so an icon near a corner does not push it off the screen.
fn popover_origin(
    rect: TrayRect,
    width: f32,
    height: f32,
    work_area: Option<(f32, f32, f32, f32)>,
) -> (f32, f32) {
    let x = rect.x + rect.width / 2.0 - width / 2.0;
    let below = rect.y + rect.height;
    let Some((area_x, area_y, area_width, area_height)) = work_area else {
        return (x, below);
    };
    let above = rect.y - height;
    let fits_below = below + height <= area_y + area_height;
    let y = if fits_below || above < area_y {
        below
    } else {
        above
    };
    let max_x = (area_x + area_width - width).max(area_x);
    let max_y = (area_y + area_height - height).max(area_y);
    (x.clamp(area_x, max_x), y.clamp(area_y, max_y))
}

pub fn hide_popover(cx: &mut App) {
    let open = cx
        .try_global::<TrayGlobal>()
        .and_then(|tray| tray.0.borrow_mut().popover.take());
    if let Some(key) = open {
        // Closed, not hidden: every show opens a new window, and a hidden one
        // would stay behind with its surface (and come back on screen when a
        // pending activation reaches it).
        let _ = windows::close_window(cx, key, true);
    }
}

/// Show `menu` through the context-menu presenter. A real click on macOS and
/// Windows never gets here: the status item shows its attached menu itself.
pub fn show_menu(cx: &mut App, menu: MenuModel, rect: TrayRect) {
    let request = crate::desktop::context_menu::ContextMenuRequest {
        window: match crate::desktop::context_menu::target_window(cx) {
            Ok((window, _)) => window,
            Err(error) => {
                log::warn!("[desktop][tray] {error}");
                return;
            }
        },
        x: rect.x,
        y: rect.y + rect.height,
        model: menu,
        native_view: crate::desktop::context_menu::target_window(cx)
            .map(|(_, view)| view)
            .unwrap_or(0),
    };
    let responder = crate::desktop::context_menu::Responder::callback(Box::new(|selection| {
        if let Some(id) = selection {
            if let Some(handler) = rn_gpui_sys::TRAY_MENU_PERFORM_HANDLER.get() {
                handler(id);
            }
        }
    }));
    let presenter = cx
        .global::<crate::desktop::context_menu::ContextMenuPresenterGlobal>()
        .0
        .clone();
    presenter.show(cx, request, responder);
}

pub fn set_tooltip(cx: &mut App, tooltip: Option<&str>) -> DesktopResult {
    let tray = installed(cx)?;
    let icon = tray.0.borrow().icon.clone();
    if let Some(icon) = icon {
        let _ = icon.set_tooltip(tooltip);
    }
    tray.0.borrow_mut().config.tooltip = tooltip.map(str::to_string);
    Ok(json!({"tooltip": tooltip}))
}

pub fn set_visible(cx: &mut App, visible: bool) -> DesktopResult {
    let tray = installed(cx)?;
    let icon = tray.0.borrow().icon.clone();
    if let Some(icon) = icon {
        let _ = icon.set_visible(visible);
    }
    tray.0.borrow_mut().visible = visible;
    Ok(json!({"visible": visible}))
}

pub fn set_icon(
    cx: &mut App,
    icon: &crate::desktop::icon::DecodedIcon,
    template: bool,
) -> DesktopResult {
    let tray = installed(cx)?;
    let native = tray_icon::Icon::from_rgba(icon.rgba.clone(), icon.width, icon.height)
        .map_err(|error| DesktopError::invalid_argument(format!("{error}")))?;
    let handle = tray.0.borrow().icon.clone();
    if let Some(handle) = handle {
        #[cfg(target_os = "macos")]
        let applied = if template {
            handle.set_icon_templated(Some(native))
        } else {
            handle.set_icon(Some(native))
        };
        #[cfg(not(target_os = "macos"))]
        let applied = handle.set_icon(Some(native));
        applied.map_err(|error| DesktopError::failed(format!("{error}")))?;
    }
    // Kept, so a tray rebuilt from its config shows the same icon.
    let mut state = tray.0.borrow_mut();
    state.config.icon = Some((icon.rgba.clone(), icon.width, icon.height));
    state.config.icon_is_template = template;
    Ok(json!({"width": icon.width, "height": icon.height, "template": template}))
}

/// Text beside the icon; Windows trays have none.
pub fn set_title(cx: &mut App, title: Option<&str>) -> DesktopResult {
    let tray = installed(cx)?;
    let icon = tray.0.borrow().icon.clone();
    if let Some(icon) = icon {
        icon.set_title(title);
    }
    tray.0.borrow_mut().config.title = title.map(str::to_string);
    Ok(json!({"title": title}))
}

/// `None` clears the menu.
pub fn set_menu(cx: &mut App, items: Option<&Value>) -> DesktopResult {
    let tray = installed(cx)?;
    let menu = match items {
        Some(items) => Some(menu_model::parse_menu(items)?),
        None => None,
    };
    tray.0.borrow_mut().config.menu = menu;
    {
        let tray = tray.0.borrow();
        if let Some(icon) = &tray.icon {
            attach_native_menu(icon, &tray.config);
        }
    }
    Ok(json!({"items": items.and_then(Value::as_array).map(Vec::len)}))
}

/// The tray global, or the error every setter reports when there is none.
fn installed(cx: &App) -> Result<&TrayGlobal, DesktopError> {
    cx.try_global::<TrayGlobal>()
        .ok_or_else(|| DesktopError::not_found("no tray icon is installed"))
}

pub fn state(cx: &App) -> Value {
    let Some(tray) = cx.try_global::<TrayGlobal>() else {
        return json!({"installed": false});
    };
    let tray = tray.0.borrow();
    json!({
        "installed": true,
        "id": tray.config.id,
        "tooltip": tray.config.tooltip,
        "visible": tray.visible,
        "component": tray.config.component,
        "popover": tray.popover,
        "clicks": tray.clicks,
        "hasMenu": tray.config.menu.is_some(),
        "hideWindowOnClose": tray.config.hide_window_on_close,
        "title": tray.config.title,
        "icon": tray.config.icon.as_ref().map(|(_, width, height)| json!({
            "width": width,
            "height": height,
            "template": tray.config.icon_is_template,
        })),
        // Whether a StatusNotifier host is watching the session bus, so a caller
        // can tell "the icon is there and the panel is showing it" from "the app
        // is publishing an icon that this desktop has nowhere to draw". Only
        // Linux has the distinction; elsewhere it is always true.
        "hostAvailable": tray_host_available(),
        "menuItems": tray
            .config
            .menu
            .as_ref()
            .map(|menu| crate::desktop::context_menu::nodes_json(&menu.items))
            .unwrap_or_default(),
    })
}

/// Whether a StatusNotifier host owns `org.kde.StatusNotifierWatcher`.
///
/// The tray icon is published over StatusNotifierItem; a panel (or a
/// GNOME AppIndicator extension) has to be *hosting* that protocol for anything
/// to appear. A desktop that does not host it — stock GNOME, or an LXQt panel
/// built without its `statusnotifier` plugin — shows no icon for any
/// StatusNotifierItem app (ours, rustdesk, an Electron app), which is worth
/// reporting rather than looking like a failure in the app. Some desktops
/// (Electron included) additionally keep the retired XEmbed tray, but no
/// maintained crate offers that without GTK, and it is absent from GNOME 3.26+
/// and from the X11-less Wayland sessions.
///
/// Reads the session bus with `zbus` (already a dependency, via `ksni`). The
/// query is synchronous and cheap, but only consulted when a caller asks for
/// the tray state, never on a timer.
#[cfg(target_os = "linux")]
fn tray_host_available() -> bool {
    use zbus::blocking::Connection;
    let Ok(connection) = Connection::session() else {
        return false;
    };
    connection
        .call_method(
            Some("org.freedesktop.DBus"),
            "/org/freedesktop/DBus",
            Some("org.freedesktop.DBus"),
            "NameHasOwner",
            &("org.kde.StatusNotifierWatcher",),
        )
        .ok()
        .and_then(|reply| reply.body().deserialize::<bool>().ok())
        .unwrap_or(false)
}

#[cfg(not(target_os = "linux"))]
fn tray_host_available() -> bool {
    true
}

#[derive(Clone, Copy, Debug, Default)]
pub struct TrayRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrayButton {
    Left,
    Right,
    Middle,
}

fn build_icon(config: &TrayConfig) -> Result<tray_icon::TrayIcon, String> {
    use tray_icon::{TrayIconBuilder, TrayIconEvent};

    let icon = match &config.icon {
        Some((rgba, width, height)) => tray_icon::Icon::from_rgba(rgba.clone(), *width, *height)
            .map_err(|error| error.to_string())?,
        None => fallback_icon()?,
    };
    let mut builder = TrayIconBuilder::new()
        .with_id(config.id.clone())
        .with_menu_on_left_click(false);
    // Template mode is a macOS menu-bar concept; every other platform draws
    // the icon as-is. The built-in glyph is always a template.
    #[cfg(target_os = "macos")]
    {
        builder = if config.icon.is_none() || config.icon_is_template {
            builder.with_icon_templated(icon)
        } else {
            builder.with_icon(icon)
        };
    }
    #[cfg(not(target_os = "macos"))]
    {
        builder = builder.with_icon(icon);
    }
    if let Some(tooltip) = &config.tooltip {
        builder = builder.with_tooltip(tooltip.clone());
    }
    if let Some(title) = &config.title {
        builder = builder.with_title(title.clone());
    }
    let tray = builder.build().map_err(|error| error.to_string())?;

    // The handler runs on the platform's event thread; the click is forwarded
    // to the GPUI main thread through the shared queue.
    TrayIconEvent::set_event_handler(Some(move |event| {
        // One click is a press and a release, and each is its own event; acting
        // on both would open the popover and close it again.
        let (rect, position, button) = match event {
            TrayIconEvent::Click {
                rect,
                position,
                button,
                button_state: tray_icon::MouseButtonState::Up,
                ..
            } => (rect, position, button),
            _ => return,
        };
        let button = match button {
            tray_icon::MouseButton::Left => TrayButton::Left,
            tray_icon::MouseButton::Right => TrayButton::Right,
            tray_icon::MouseButton::Middle => TrayButton::Middle,
        };
        // The status item shows an attached menu itself, anchored to the icon;
        // forwarding that click as well would show it a second time. The Linux
        // backend also reports a right-click, but the panel has already put the
        // D-Bus menu up by then, so it is dropped for the same reason.
        let native_menu = NATIVE_MENU.load(std::sync::atomic::Ordering::Relaxed);
        if native_menu & MENU_ATTACHED != 0
            && (button == TrayButton::Right || native_menu & MENU_ON_LEFT_CLICK != 0)
        {
            return;
        }
        // `tray-icon` reports physical pixels; everything here is in points.
        let scale = f64::from(crate::desktop::platform_window::primary_screen_scale());
        let rect = tray_click_rect(rect, position, scale);
        if let Some(handler) = rn_gpui_sys::TRAY_CLICK_HANDLER.get() {
            handler(rect.x, rect.y, rect.width, rect.height, button as u8);
        }
    }));
    Ok(tray)
}

/// The icon's rectangle in points, from what a backend reported.
///
/// macOS and Windows report the icon's own rect, so it is used directly. The
/// Linux `ksni` backend has no rect to report — the panel owns the icon — so it
/// fills `rect` with zeros and puts the click's screen position in `position`
/// (`platform_impl/ksni/mod.rs`). Falling back to the position keeps the popover
/// at the click instead of centred on the top-left corner (0,0). Some panels
/// report `(0,0)` even then; the pointer's own position is the last resort.
fn tray_click_rect(
    rect: tray_icon::Rect,
    position: tray_icon::dpi::PhysicalPosition<f64>,
    scale: f64,
) -> TrayRect {
    if rect.size.width > 0 || rect.size.height > 0 {
        return TrayRect {
            x: (rect.position.x / scale) as f32,
            y: (rect.position.y / scale) as f32,
            width: (f64::from(rect.size.width) / scale) as f32,
            height: (f64::from(rect.size.height) / scale) as f32,
        };
    }
    let (x, y) = if position.x != 0.0 || position.y != 0.0 {
        (position.x, position.y)
    } else {
        pointer_position().unwrap_or((0.0, 0.0))
    };
    TrayRect {
        x: (x / scale) as f32,
        y: (y / scale) as f32,
        width: 0.0,
        height: 0.0,
    }
}

/// The pointer's screen position in physical pixels, where the platform can
/// answer. Only X11 needs it (see `tray_click_rect`); elsewhere the backend
/// always reports a real rect.
#[cfg(target_os = "linux")]
fn pointer_position() -> Option<(f64, f64)> {
    let xlib = x11_dl::xlib::Xlib::open().ok()?;
    // SAFETY: the display from `XOpenDisplay` is null-checked before use and closed before returning.
    unsafe {
        let display = (xlib.XOpenDisplay)(std::ptr::null());
        if display.is_null() {
            return None;
        }
        let root = (xlib.XDefaultRootWindow)(display);
        let mut root_return = 0;
        let mut child_return = 0;
        let mut root_x = 0;
        let mut root_y = 0;
        let mut win_x = 0;
        let mut win_y = 0;
        let mut mask = 0;
        let found = (xlib.XQueryPointer)(
            display,
            root,
            &mut root_return,
            &mut child_return,
            &mut root_x,
            &mut root_y,
            &mut win_x,
            &mut win_y,
            &mut mask,
        );
        (xlib.XCloseDisplay)(display);
        if found != 0 {
            Some((root_x as f64, root_y as f64))
        } else {
            None
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn pointer_position() -> Option<(f64, f64)> {
    None
}

/// Whether the status item has a native menu, and which button opens it. Read
/// by the click handler, which runs on the platform's event thread.
static NATIVE_MENU: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);
const MENU_ATTACHED: u8 = 1;
const MENU_ON_LEFT_CLICK: u8 = 2;

/// Attaches the menu the platform shows itself, anchored to the icon.
///
/// Every platform does this through `tray-icon`: macOS and Windows build a
/// native menu, and Linux's `ksni` backend turns the *same* `muda` menu into a
/// D-Bus `com.canonical.dbusmenu` the panel draws (the panel owns the popup, so
/// there is no separate window for us to place). `tray-icon` re-exports the
/// matching `muda`, so one builder serves all three.
fn attach_native_menu(icon: &tray_icon::TrayIcon, config: &TrayConfig) {
    use std::sync::atomic::Ordering;
    use tray_icon::menu::Menu;

    let fallback = default_menu();
    let model = match &config.menu {
        Some(model) => Some(model),
        None if default_menu_applies() => Some(&fallback),
        None => None,
    };
    let Some(model) = model else {
        icon.set_menu(None);
        *TRAY_MENU_IDS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = HashSet::new();
        NATIVE_MENU.store(0, Ordering::Relaxed);
        return;
    };
    let menu = Menu::new();
    if let Err(error) = build_tray_menu(&menu, &model.items) {
        log::error!("[desktop][tray] could not build the menu: {error}");
        icon.set_menu(None);
        *TRAY_MENU_IDS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = HashSet::new();
        NATIVE_MENU.store(0, Ordering::Relaxed);
        return;
    }
    icon.set_menu(Some(Box::new(menu)));
    icon.set_show_menu_on_left_click(config.menu_on_left_click);
    NATIVE_MENU.store(
        MENU_ATTACHED
            | if config.menu_on_left_click {
                MENU_ON_LEFT_CLICK
            } else {
                0
            },
        Ordering::Relaxed,
    );
    // The ids this menu answers for, so the app's single `muda` event route can
    // tell a tray selection from a menu-bar one. `tray_icon` forwards mudas
    // events, and the app installs one handler on that channel for every menu it
    // builds; a second installer here would be ignored (the setter is
    // first-caller-wins) and the tray would then never be called.
    let mut ids = HashSet::new();
    collect_menu_ids(&model.items, &mut ids);
    *TRAY_MENU_IDS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = ids;
    crate::desktop::menu_events::register(Box::new(|id| {
        let owned = TRAY_MENU_IDS
            .lock()
            .map(|ids| ids.contains(id))
            .unwrap_or(false);
        if !owned {
            return false;
        }
        if let Some(handler) = rn_gpui_sys::TRAY_MENU_PERFORM_HANDLER.get() {
            handler(id.to_string());
            return true;
        }
        false
    }));
}

/// Every id the tray menu answers for, so a tray selection can be told from a
/// menu-bar one on the shared event route.
fn collect_menu_ids(items: &[menu_model::MenuNode], ids: &mut HashSet<String>) {
    use menu_model::MenuNode;
    for node in items {
        match node {
            MenuNode::Item(item) => {
                ids.insert(item.id.clone());
            }
            MenuNode::Submenu(submenu) => collect_menu_ids(&submenu.items, ids),
            MenuNode::Separator | MenuNode::StandardMenu(_) => {}
        }
    }
}

/// The ids of the tray menu currently attached, if any.
static TRAY_MENU_IDS: std::sync::LazyLock<std::sync::Mutex<HashSet<String>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(HashSet::new()));

trait TrayMenuAppend {
    fn append_all(&self, items: &[&dyn tray_icon::menu::IsMenuItem])
        -> tray_icon::menu::Result<()>;
}

impl TrayMenuAppend for tray_icon::menu::Menu {
    fn append_all(
        &self,
        items: &[&dyn tray_icon::menu::IsMenuItem],
    ) -> tray_icon::menu::Result<()> {
        self.append_items(items)
    }
}

impl TrayMenuAppend for tray_icon::menu::Submenu {
    fn append_all(
        &self,
        items: &[&dyn tray_icon::menu::IsMenuItem],
    ) -> tray_icon::menu::Result<()> {
        self.append_items(items)
    }
}

/// The tray's menu in `tray-icon`'s own menu types. It bundles a newer `muda`
/// than the context menus use, so `context_menu`'s builder cannot be shared.
fn build_tray_menu(
    menu: &impl TrayMenuAppend,
    items: &[menu_model::MenuNode],
) -> Result<(), String> {
    use menu_model::MenuNode;
    use tray_icon::menu::{
        CheckMenuItem, IconMenuItem, IsMenuItem, MenuItem, PredefinedMenuItem, Submenu,
    };
    let icon = |uri: &Option<String>| {
        let icon = crate::desktop::icon::cached(uri.as_deref()?)?;
        tray_icon::menu::Icon::from_rgba(icon.rgba.clone(), icon.width, icon.height).ok()
    };

    let mut children: Vec<Box<dyn IsMenuItem>> = Vec::new();
    for node in items {
        match node {
            MenuNode::Separator => children.push(Box::new(PredefinedMenuItem::separator())),
            MenuNode::StandardMenu(_) => {}
            MenuNode::Item(item) if item.checked => {
                children.push(Box::new(CheckMenuItem::with_id(
                    item.id.clone(),
                    item.label.clone(),
                    item.enabled,
                    true,
                    None,
                )))
            }
            MenuNode::Item(item) => match icon(&item.icon) {
                Some(icon) => children.push(Box::new(IconMenuItem::with_id(
                    item.id.clone(),
                    item.label.clone(),
                    item.enabled,
                    Some(icon),
                    None,
                ))),
                None => children.push(Box::new(MenuItem::with_id(
                    item.id.clone(),
                    item.label.clone(),
                    item.enabled,
                    None,
                ))),
            },
            MenuNode::Submenu(submenu) => {
                let child = Submenu::new(submenu.label.clone(), submenu.enabled);
                if let Some(icon) = icon(&submenu.icon) {
                    child.set_icon(Some(icon));
                }
                build_tray_menu(&child, &submenu.items)?;
                children.push(Box::new(child));
            }
        }
    }
    let refs: Vec<&dyn IsMenuItem> = children.iter().map(|item| item.as_ref()).collect();
    menu.append_all(&refs).map_err(|error| error.to_string())
}

/// The icon for a tray that was not given one: the app's own where the platform
/// draws a tray icon as-is, and the built-in glyph where it does not.
///
/// The glyph is a macOS template — a black outline the menu bar tints for light
/// and dark — so anywhere else it is an empty black rectangle, which on a dark
/// taskbar is hardly there at all. The app's icon is what a user expects to see
/// for the app.
fn fallback_icon() -> Result<tray_icon::Icon, String> {
    #[cfg(not(target_os = "macos"))]
    if let Some(icon) = crate::desktop::icon::app_icon() {
        return tray_icon::Icon::from_rgba(icon.rgba.clone(), icon.width, icon.height)
            .map_err(|error| error.to_string());
    }
    default_icon()
}

fn default_icon() -> Result<tray_icon::Icon, String> {
    const SIZE: u32 = 22;
    let mut rgba = vec![0u8; (SIZE * SIZE * 4) as usize];
    for y in 0..SIZE {
        for x in 0..SIZE {
            let outer = x >= 3 && x < SIZE - 3 && y >= 4 && y < SIZE - 4;
            let inner = x >= 6 && x < SIZE - 6 && y >= 7 && y < SIZE - 7;
            if outer && !inner {
                let index = ((y * SIZE + x) * 4) as usize;
                rgba[index] = 0;
                rgba[index + 1] = 0;
                rgba[index + 2] = 0;
                rgba[index + 3] = 255;
            }
        }
    }
    tray_icon::Icon::from_rgba(rgba, SIZE, SIZE).map_err(|error| error.to_string())
}

fn wants_menu(has_menu: bool, menu_on_left_click: bool, button: TrayButton) -> bool {
    has_menu && (button == TrayButton::Right || menu_on_left_click)
}

/// Whether the installed tray asked for the last window to be hidden, not
/// destroyed, when it is closed.
pub fn hides_window_on_close(cx: &App) -> bool {
    cx.try_global::<TrayGlobal>()
        .is_some_and(|tray| tray.0.borrow().config.hide_window_on_close)
}

/// The id of the built-in menu's "Open" item.
const DEFAULT_OPEN_ID: &str = "rn-gpui:tray:open";
/// The id of the built-in menu's "Exit" item.
const DEFAULT_EXIT_ID: &str = "rn-gpui:tray:exit";

/// What a right-click on a tray icon shows when the app gave it no menu: Open and
/// Exit, which is what users expect of a tray icon on Windows and Linux. Without
/// it there is no way to bring a closed window back, or to end an app that keeps
/// running in the background, short of the task manager.
fn default_menu() -> MenuModel {
    use menu_model::{MenuItemDef, MenuNode};
    let item = |id: &str, label: &str| {
        MenuNode::Item(MenuItemDef {
            id: id.to_string(),
            label: label.to_string(),
            accelerator: None,
            enabled: true,
            checked: false,
            role: None,
            icon: None,
        })
    };
    MenuModel {
        items: vec![
            item(DEFAULT_OPEN_ID, "Open"),
            MenuNode::Separator,
            item(DEFAULT_EXIT_ID, "Exit"),
        ],
    }
}

/// macOS status items do not carry an Open/Exit menu by convention — the Dock and
/// the app menu do that — so only the other platforms get the built-in one.
fn default_menu_applies() -> bool {
    cfg!(not(target_os = "macos"))
}

/// A selection from the tray's menu. The built-in items act here; everything else
/// is the app's, and reaches JavaScript.
pub fn perform_menu(cx: &mut App, id: &str) {
    match id {
        DEFAULT_OPEN_ID => windows::reopen(cx),
        DEFAULT_EXIT_ID => cx.quit(),
        _ => emit_menu_press(cx, id),
    }
}

pub fn emit_menu_press(cx: &App, id: &str) {
    let Some(store) = crate::store::store_from(cx) else {
        return;
    };
    store
        .read(cx)
        .host
        .emit_device_event_json("gpuiDesktop:trayMenuPress", &json!({"id": id}).to_string());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_icon_is_a_valid_template() {
        let icon = default_icon().expect("the built-in glyph is valid");
        let _ = icon;
    }

    #[test]
    fn a_tray_config_defaults_to_a_popover_with_no_menu() {
        let config = TrayConfig::default();
        assert!(config.component.is_none());
        assert!(config.menu.is_none());
        assert!(!config.quit_on_last_window_closed);
        assert_eq!(config.id, "tray");
    }

    #[test]
    fn a_right_click_opens_the_menu_only_when_one_exists() {
        assert!(wants_menu(true, false, TrayButton::Right));
        assert!(!wants_menu(false, false, TrayButton::Right));
        assert!(!wants_menu(true, false, TrayButton::Left));
        assert!(!wants_menu(true, false, TrayButton::Middle));
    }

    #[test]
    fn menu_on_left_click_moves_the_menu_to_the_primary_button() {
        assert!(wants_menu(true, true, TrayButton::Left));
        assert!(wants_menu(true, true, TrayButton::Right));
        assert!(!wants_menu(false, true, TrayButton::Left));
    }

    #[test]
    fn the_built_in_menu_offers_open_and_exit() {
        let menu = default_menu();
        assert_eq!(menu.ids(), [DEFAULT_OPEN_ID, DEFAULT_EXIT_ID]);
        assert_eq!(
            menu.find(DEFAULT_OPEN_ID).map(|i| i.label.as_str()),
            Some("Open")
        );
        assert_eq!(
            menu.find(DEFAULT_EXIT_ID).map(|i| i.label.as_str()),
            Some("Exit")
        );
        assert!(menu.find(DEFAULT_OPEN_ID).is_some_and(|item| item.enabled));
    }

    #[test]
    fn the_built_in_ids_cannot_be_an_apps_own() {
        // They would be swallowed by `perform_menu` instead of reaching the app.
        assert!(DEFAULT_OPEN_ID.starts_with("rn-gpui:"));
        assert!(DEFAULT_EXIT_ID.starts_with("rn-gpui:"));
        assert_ne!(DEFAULT_OPEN_ID, DEFAULT_EXIT_ID);
    }

    const ICON: TrayRect = TrayRect {
        x: 1200.0,
        y: 740.0,
        width: 24.0,
        height: 28.0,
    };
    // A 1280x768 display whose bottom 40 points are the taskbar.
    const WORK_AREA: Option<(f32, f32, f32, f32)> = Some((0.0, 0.0, 1280.0, 728.0));

    #[test]
    fn without_a_work_area_a_popover_goes_below_and_centred_as_before() {
        assert_eq!(
            popover_origin(ICON, 320.0, 200.0, None),
            (1200.0 + 12.0 - 160.0, 768.0)
        );
    }

    #[test]
    fn a_taskbar_at_the_bottom_puts_the_popover_above_it() {
        // Below the icon is the bottom of the screen; above has room. The icon
        // is inside the taskbar, so the popover rests on the work area's edge
        // (728), not on the icon (740) — that would overlap the taskbar.
        let (_, y) = popover_origin(ICON, 320.0, 200.0, WORK_AREA);
        assert_eq!(y, 728.0 - 200.0);
    }

    #[test]
    fn a_menu_bar_at_the_top_puts_the_popover_below_its_icon() {
        let icon = TrayRect {
            x: 600.0,
            y: 0.0,
            width: 24.0,
            height: 24.0,
        };
        let (x, y) = popover_origin(icon, 320.0, 200.0, Some((0.0, 24.0, 1280.0, 744.0)));
        assert_eq!((x, y), (600.0 + 12.0 - 160.0, 24.0));
    }

    #[test]
    fn the_popover_stays_inside_the_work_area_at_a_corner() {
        let (x, _) = popover_origin(ICON, 320.0, 200.0, WORK_AREA);
        // Centring on an icon 76 points from the right edge would overhang it.
        assert_eq!(x, 1280.0 - 320.0);
        let corner = TrayRect {
            x: 0.0,
            y: 0.0,
            width: 20.0,
            height: 20.0,
        };
        assert_eq!(
            popover_origin(corner, 320.0, 200.0, Some((0.0, 0.0, 1280.0, 768.0))),
            (0.0, 20.0)
        );
    }

    #[test]
    fn a_popover_taller_than_the_room_is_kept_at_the_top_of_the_area() {
        let (_, y) = popover_origin(ICON, 320.0, 900.0, WORK_AREA);
        assert_eq!(y, 0.0);
    }

    #[test]
    fn the_builder_sizes_are_clamped() {
        let config = TrayConfig::default().size(10.0, 10.0);
        assert_eq!(config.width, 120.0);
        assert_eq!(config.height, 120.0);
    }
}
