//! One `ViewStore` owns every window: Fabric tags are unique across the
//! surfaces of a React instance, so nodes stay in one map.

use crate::bootstrap::WindowTitleBar;
use crate::desktop::errors::{DesktopError, DesktopResult};
use crate::desktop::platform_window;
use crate::store::{store_from, StoreGlobal, SurfaceRootView};
use gpui::{
    point, px, size, AnyWindowHandle, App, AppContext, Bounds, Global, Subscription,
    TitlebarOptions, WindowBounds, WindowDecorations, WindowKind, WindowOptions,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::collections::HashMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowRole {
    Main,
    Secondary,
    TrayPopover,
}

pub struct WindowEntry {
    pub key: u32,
    pub handle: AnyWindowHandle,
    pub surface_id: i32,
    pub component: String,
    pub props: Value,
    pub role: WindowRole,
    pub intercept_close: bool,
    pub title: String,
    pub subscriptions: Vec<Subscription>,
}

pub struct DesktopWindows {
    by_key: BTreeMap<u32, WindowEntry>,
    by_surface: HashMap<i32, u32>,
    next_key: u32,
    next_surface: i32,
}

pub struct DesktopWindowsGlobal(pub DesktopWindows);
impl Global for DesktopWindowsGlobal {}

impl DesktopWindows {
    pub fn new() -> Self {
        Self {
            by_key: BTreeMap::new(),
            by_surface: HashMap::new(),
            next_key: 2,
            next_surface: 3,
        }
    }

    fn alloc_key(&mut self) -> u32 {
        let key = self.next_key;
        self.next_key += 1;
        key
    }

    /// Surface ids are odd. A surface id is also the tag of its root view, and
    /// React numbers the views it creates 2, 4, 6…: an even surface id is the
    /// tag of some view of another surface, and the new window's content is
    /// then mounted inside that view instead of in its own window.
    fn alloc_surface(&mut self) -> i32 {
        let surface = self.next_surface;
        self.next_surface += 2;
        surface
    }

    pub fn get(&self, key: u32) -> Option<&WindowEntry> {
        self.by_key.get(&key)
    }

    pub fn get_mut(&mut self, key: u32) -> Option<&mut WindowEntry> {
        self.by_key.get_mut(&key)
    }

    pub fn entry_for_surface(&self, surface_id: i32) -> Option<&WindowEntry> {
        self.by_surface
            .get(&surface_id)
            .and_then(|key| self.by_key.get(key))
    }

    pub fn keys(&self) -> Vec<u32> {
        self.by_key.keys().copied().collect()
    }

    pub fn len(&self) -> usize {
        self.by_key.len()
    }

    pub fn adopt(
        &mut self,
        key: u32,
        handle: AnyWindowHandle,
        surface_id: i32,
        component: String,
        props: Value,
        role: WindowRole,
    ) {
        self.by_key.insert(
            key,
            WindowEntry {
                key,
                handle,
                surface_id,
                component,
                props,
                role,
                intercept_close: false,
                title: String::new(),
                subscriptions: Vec::new(),
            },
        );
        self.by_surface.insert(surface_id, key);
    }

    fn insert(&mut self, entry: WindowEntry) {
        self.by_surface.insert(entry.surface_id, entry.key);
        self.by_key.insert(entry.key, entry);
    }

    fn remove(&mut self, key: u32) -> Option<WindowEntry> {
        let entry = self.by_key.remove(&key)?;
        self.by_surface.remove(&entry.surface_id);
        Some(entry)
    }
}

impl Default for DesktopWindows {
    fn default() -> Self {
        Self::new()
    }
}

pub const MAIN_WINDOW_KEY: u32 = 1;

#[derive(Clone, Debug, Default)]
pub struct OpenWindowOptions {
    pub component: String,
    pub props: Option<Value>,
    pub title: Option<String>,
    pub width: Option<f32>,
    pub height: Option<f32>,
    pub x: Option<f32>,
    pub y: Option<f32>,
    pub resizable: bool,
    /// What kind of title bar the window asks for. `Default` keeps the
    /// platform's, which is what a secondary window gets unless it says
    /// otherwise.
    pub title_bar: WindowTitleBar,
    pub traffic_light_position: Option<(f32, f32)>,
    pub role: WindowRoleOverride,
    pub popup: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum WindowRoleOverride {
    #[default]
    Secondary,
    TrayPopover,
}

impl OpenWindowOptions {
    fn role(&self) -> WindowRole {
        match self.role {
            WindowRoleOverride::Secondary => WindowRole::Secondary,
            WindowRoleOverride::TrayPopover => WindowRole::TrayPopover,
        }
    }
}

pub fn open_window(cx: &mut App, mut options: OpenWindowOptions) -> Result<u32, DesktopError> {
    if options.component.is_empty() {
        return Err(DesktopError::invalid_argument(
            "window.open requires a component name",
        ));
    }
    let store =
        store_from(cx).ok_or_else(|| DesktopError::failed("the view store is not initialized"))?;
    let (host, frame_hook) = {
        let store = store.read(cx);
        (store.host.clone(), store.frame_hook.clone())
    };
    let (key, surface_id) = {
        let windows = &mut cx.global_mut::<DesktopWindowsGlobal>().0;
        (windows.alloc_key(), windows.alloc_surface())
    };

    let width = options.width.unwrap_or(800.0).max(120.0);
    let height = options.height.unwrap_or(600.0).max(120.0);
    let bounds = match (options.x, options.y) {
        (Some(x), Some(y)) => Bounds::new(point(px(x), px(y)), size(px(width), px(height))),
        _ => Bounds::centered(None, size(px(width), px(height)), cx),
    };
    // The placed origin, in points: what the popover's own window hints use.
    let placed_origin = (f32::from(bounds.origin.x), f32::from(bounds.origin.y));
    let title = options
        .title
        .clone()
        .unwrap_or_else(|| options.component.clone());
    let window_options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(bounds)),
        // A popup (a tray popover) is a bare panel: with a title bar it is
        // just another window that happens to open under the icon.
        titlebar: (!options.popup).then(|| TitlebarOptions {
            title: Some(title.clone().into()),
            // macOS and Windows express "the app draws the bar" as a transparent
            // title bar. Linux has no such flag and uses the decorations request
            // below instead.
            appears_transparent: options.title_bar.is_custom(),
            traffic_light_position: options.traffic_light_position.map(|(x, y)| {
                let (x, y) = crate::bootstrap::clamp_traffic_light_position(x, y, width, height);
                point(px(x), px(y))
            }),
        }),
        is_resizable: options.resizable,
        is_movable: !options.popup,
        window_min_size: Some(size(px(120.0), px(120.0))),
        // The tray popover is a normal, undecorated window on every platform,
        // not `WindowKind::PopUp`: GPUI makes that override-redirect on X11, so
        // the window manager never focuses it and it can never see the
        // deactivation that dismisses it (see `platform_window::prepare_popover`).
        // A frameless window with no decorations is what Electron's Linux tray
        // menu uses too. `WindowDecorations::Client` is GPUI's frameless mode.
        // A custom title bar asks for the same thing: on X11 and Wayland it is
        // what removes the window manager's frame, and the app draws both the bar
        // and the resize border itself.
        kind: WindowKind::Normal,
        window_decorations: (options.popup || options.title_bar.is_custom())
            .then_some(WindowDecorations::Client),
        // The popover is mapped after it is prepared: the X11 window manager
        // reads `_NET_WM_WINDOW_TYPE`, `_NET_WM_STATE` and the size hints when
        // the window is mapped, so they are set on it while it is still hidden.
        show: !options.popup,
        // A custom title bar means the app draws and moves the bar itself.
        app_owns_titlebar_drag: options.title_bar.is_custom(),
        ..Default::default()
    };

    let store_for_root = store;
    let handle = cx
        .open_window(window_options, move |window, cx| {
            let root = cx.new(|_| SurfaceRootView::new(surface_id));
            let window_handle: AnyWindowHandle = window.window_handle().into();
            store_for_root.update(cx, |store, cx| {
                store.register_root(surface_id, root.clone());
                store.register_window(surface_id, window_handle);
                cx.notify();
            });
            root
        })
        .map_err(|error| DesktopError::failed(format!("could not open the window: {error}")))?;

    let (w, h, scale) = handle
        .update(cx, |_root, window, _cx| {
            // A compositor can refuse the decorations request for one window and
            // grant it for another, so the capability follows the newest window.
            crate::desktop::capabilities::note_window_decorations(window.window_decorations());
            let size = window.viewport_size();
            (
                f32::from(size.width),
                f32::from(size.height),
                window.scale_factor(),
            )
        })
        .unwrap_or((width, height, 2.0));
    // A popover is created hidden, and a window that has not been shown has not
    // had its first `WM_SIZE`, so what `viewport_size` reports for it is not
    // something to start a surface from. The popover's own size is known, so the
    // surface starts at that, and `prepare_popover` gives the window the same one.
    #[cfg(target_os = "windows")]
    let (w, h) = if options.popup {
        (width, height)
    } else {
        (w, h)
    };

    let mut props = options.props.clone().unwrap_or_else(|| json!({}));
    if !props.is_object() {
        return Err(DesktopError::invalid_argument(
            "window.open props must be an object",
        ));
    }
    if let Some(object) = props.as_object_mut() {
        object.insert("windowId".to_string(), json!(key));
    }
    host.start_surface_with_props(
        surface_id,
        &options.component,
        &props.to_string(),
        w,
        h,
        scale,
    );

    let subscriptions = handle
        .update(cx, |_root, window, cx| {
            let mut subscriptions = Vec::new();
            if options.popup {
                crate::desktop::platform_window::style_as_popover(window);
                // Set the popover's window hints while it is still unmapped,
                // then ask the window manager to map and focus it. Failures are
                // not fatal: a platform that needs none of this (or a Wayland
                // session, which has no absolute placement) still gets a working
                // window, just placed by the compositor.
                if let Err(error) = crate::desktop::platform_window::prepare_popover(
                    window,
                    placed_origin.0,
                    placed_origin.1,
                    width,
                    height,
                ) {
                    log::debug!("[desktop] popover window hints: {error}");
                }
            } else {
                // Every window of the app carries its icon, not only the first:
                // on Windows it belongs to the window, so one opened later — a
                // reopen from the tray, a secondary window — would show the
                // default on its taskbar button. A popover has no button.
                platform_window::apply_app_icon(window);
            }
            frame_hook.arm(window);
            subscriptions.push(install_bounds_observer(window, cx));
            subscriptions.push(install_state_observer(window, cx));
            subscriptions.push(install_activation_observer(window, cx, key));
            install_close_hook(window, cx, key);
            subscriptions
        })
        .map_err(|error| {
            DesktopError::failed(format!("could not configure the window: {error}"))
        })?;

    if options.popup {
        // Map the popover and make it active, so it takes focus (and therefore
        // can be dismissed when it loses it). The tray's own `focus` call
        // already activates; this uses the pager source indication the window
        // manager trusts, which is needed because a tray click arrives over
        // D-Bus and carries no X timestamp.
        let _ = handle.update(cx, |_root, window, _cx| {
            window.activate_window();
            if let Err(error) = crate::desktop::platform_window::activate_popover(window) {
                log::debug!("[desktop] popover activation: {error}");
            }
        });
    }

    let role = options.role();
    let component = options.component.clone();
    let entry = WindowEntry {
        key,
        handle: handle.into(),
        surface_id,
        component,
        props: options.props.take().unwrap_or_else(|| json!({})),
        role,
        intercept_close: false,
        title,
        subscriptions,
    };
    cx.global_mut::<DesktopWindowsGlobal>().0.insert(entry);
    log::info!(
        "[desktop] opened window {key} (surface {surface_id}, {})",
        options.component
    );
    emit_window_event(cx, "gpuiDesktop:windowOpened", json!({"windowId": key}));
    Ok(key)
}

/// Without `force`, a window whose JS listener registered a veto emits
/// `closeRequested` and stays open.
pub fn close_window(cx: &mut App, key: u32, force: bool) -> DesktopResult {
    let entry = {
        let windows = &mut cx.global_mut::<DesktopWindowsGlobal>().0;
        windows.remove(key)
    };
    let Some(entry) = entry else {
        return Err(DesktopError::not_found(format!("window {key} is not open")));
    };
    if !force && entry.intercept_close && entry.role != WindowRole::TrayPopover {
        // Put it back and ask JS: the veto listener answers with
        // `DesktopWindow.close({force: true})` or does nothing to keep it open.
        let surface_id = entry.surface_id;
        cx.global_mut::<DesktopWindowsGlobal>().0.insert(entry);
        if let Some(store) = store_from(cx) {
            let store = store.read(cx);
            store.host.emit_device_event_json(
                "gpuiDesktop:closeRequested",
                &json!({"windowId": key}).to_string(),
            );
            log::info!("[desktop] window {key} close deferred to JS (surface {surface_id})");
        }
        return Ok(json!({"windowId": key, "deferred": true}));
    }
    finish_close(cx, key, entry, true);
    Ok(json!({"windowId": key}))
}

/// `remove_window` is false when the platform is already closing the window:
/// GPUI must not be asked to remove it again from inside that callback.
fn finish_close(cx: &mut App, key: u32, entry: WindowEntry, remove_window: bool) {
    let surface_id = entry.surface_id;
    let handle = entry.handle;
    if let Some(store) = store_from(cx) {
        // Only the registry entry is dropped here. `stop_surface` goes through
        // Fabric's `SurfaceManager`, which can re-enter the JS thread while this
        // update holds the store's lease; a mount batch for the surface that is
        // still in the channel then has to wait for a lease that cannot be
        // released until the stop returns. Deferring the stop lets queued
        // batches apply first, which is also the order React Native expects:
        // stop is the last thing a closing surface sees.
        store.update(cx, |store, _cx| store.unregister_window(surface_id));
        let host = store.read(cx).host.clone();
        cx.defer(move |_cx| host.stop_surface(surface_id));
    }
    if remove_window {
        let _ = handle.update(cx, |_root, window, _cx| window.remove_window());
    }
    log::info!("[desktop] closed window {key} (surface {surface_id})");
    emit_window_event(cx, "gpuiDesktop:windowClosed", json!({"windowId": key}));
    // The closed window may have been covering its siblings; repaint them so no
    // stale pixels are left where it used to be.
    cx.refresh_windows();
    maybe_quit(cx);
}

pub(crate) fn maybe_quit(cx: &mut App) {
    if !quit_on_last_window_closed(cx) {
        return;
    }
    let remaining = cx
        .try_global::<DesktopWindowsGlobal>()
        .map(|windows| windows.0.len())
        .unwrap_or(0);
    if remaining == 0 {
        cx.quit();
    }
}

pub fn os_close(cx: &mut App, key: u32) -> bool {
    let entry = if cx.has_global::<DesktopWindowsGlobal>() {
        cx.global_mut::<DesktopWindowsGlobal>().0.remove(key)
    } else {
        None
    };
    let Some(entry) = entry else {
        return false;
    };
    finish_close(cx, key, entry, false);
    true
}

pub fn install_close_hook_for(cx: &mut App, handle: AnyWindowHandle, key: u32) {
    // `AnyWindowHandle::update` hands back an `AnyView`; the hook needs the
    // window's own context, so the handle is downcast to the root view first.
    let Some(handle) = handle.downcast::<SurfaceRootView>() else {
        return;
    };
    let _ = handle.update(cx, |_root, window, cx| {
        install_close_hook(window, cx, key);
    });
}

fn quit_on_last_window_closed(cx: &App) -> bool {
    !cx.try_global::<QuitOnLastWindowClosed>()
        .is_some_and(|flag| !flag.0)
}

pub struct QuitOnLastWindowClosed(pub bool);
impl Global for QuitOnLastWindowClosed {}

/// The window reopening the app opens once its last window is gone: the main
/// component, as the main window was configured.
pub struct ReopenWindow(pub OpenWindowOptions);
impl Global for ReopenWindow {}

/// The Dock icon was clicked (or the app launched again) with no visible
/// window. A window that is only hidden or minimized is brought back; with none
/// left, the main component opens in a new one.
pub fn reopen(cx: &mut App) {
    let existing = cx.try_global::<DesktopWindowsGlobal>().and_then(|windows| {
        windows
            .0
            .by_key
            .values()
            .find(|entry| entry.role != WindowRole::TrayPopover)
            .map(|entry| entry.key)
    });
    if let Some(key) = existing {
        let _ = show(cx, key);
        let _ = focus(cx, key);
        return;
    }
    let Some(options) = cx.try_global::<ReopenWindow>().map(|spec| spec.0.clone()) else {
        return;
    };
    match open_window(cx, options) {
        Ok(key) => {
            let _ = focus(cx, key);
        }
        Err(error) => log::error!("[desktop] reopen: {}", error.message),
    }
}

pub fn close(cx: &mut App, key: u32, force: bool) -> DesktopResult {
    close_window(cx, key, force)
}

pub fn focus(cx: &mut App, key: u32) -> DesktopResult {
    let Some(entry) = cx.global::<DesktopWindowsGlobal>().0.get(key) else {
        return Err(DesktopError::not_found(format!("window {key} is not open")));
    };
    let handle = entry.handle;
    handle
        .update(cx, |_root, window, _cx| window.activate_window())
        .map_err(|error| DesktopError::failed(format!("window {key} is gone: {error}")))?;
    Ok(json!({"windowId": key, "focused": true}))
}

pub(crate) fn with_window(
    cx: &mut App,
    key: u32,
    action: impl FnOnce(&mut gpui::Window) -> Result<(), DesktopError>,
) -> DesktopResult {
    let Some(entry) = cx.global::<DesktopWindowsGlobal>().0.get(key) else {
        return Err(DesktopError::not_found(format!("window {key} is not open")));
    };
    let handle = entry.handle;
    handle
        .update(cx, |_root, window, _cx| action(window))
        .map_err(|error| DesktopError::failed(format!("window {key} is gone: {error}")))??;
    Ok(json!({"windowId": key}))
}

pub fn set_title(cx: &mut App, key: u32, title: String) -> DesktopResult {
    if let Some(entry) = cx.global_mut::<DesktopWindowsGlobal>().0.get_mut(key) {
        entry.title.clone_from(&title);
    }
    with_window(cx, key, move |window| {
        window.set_window_title(&title);
        Ok(())
    })
}

pub fn set_size(cx: &mut App, key: u32, width: f32, height: f32) -> DesktopResult {
    with_window(cx, key, move |window| {
        window.resize(gpui::size(px(width), px(height)));
        Ok(())
    })
}

pub fn set_position(cx: &mut App, key: u32, x: f32, y: f32) -> DesktopResult {
    if !platform_window::supports_position() {
        return Err(DesktopError::unsupported(
            "this session cannot position windows (Wayland has no absolute placement)",
        ));
    }
    with_window(cx, key, move |window| {
        platform_window::set_position(window, x, y).map_err(DesktopError::failed)
    })
}

pub fn set_min_size(cx: &mut App, key: u32, width: f32, height: f32) -> DesktopResult {
    with_window(cx, key, move |window| {
        platform_window::set_min_size(window, width, height).map_err(DesktopError::unsupported)
    })
}

pub fn set_max_size(cx: &mut App, key: u32, width: f32, height: f32) -> DesktopResult {
    with_window(cx, key, move |window| {
        platform_window::set_max_size(window, width, height).map_err(DesktopError::unsupported)
    })
}

pub fn set_resizable(cx: &mut App, key: u32, resizable: bool) -> DesktopResult {
    with_window(cx, key, move |window| {
        platform_window::set_resizable(window, resizable).map_err(DesktopError::unsupported)
    })
}

pub fn set_always_on_top(cx: &mut App, key: u32, on: bool) -> DesktopResult {
    with_window(cx, key, move |window| {
        platform_window::set_always_on_top(window, on).map_err(DesktopError::unsupported)
    })
}

pub fn minimize(cx: &mut App, key: u32) -> DesktopResult {
    with_window(cx, key, |window| {
        window.minimize_window();
        Ok(())
    })
}

pub fn maximize(cx: &mut App, key: u32) -> DesktopResult {
    with_window(cx, key, |window| {
        if !platform_window::is_maximized(window) {
            window.zoom_window();
        }
        Ok(())
    })
}

pub fn unmaximize(cx: &mut App, key: u32) -> DesktopResult {
    with_window(cx, key, |window| {
        if platform_window::is_maximized(window) {
            window.zoom_window();
        }
        Ok(())
    })
}

pub fn toggle_maximize(cx: &mut App, key: u32) -> DesktopResult {
    with_window(cx, key, |window| {
        window.zoom_window();
        Ok(())
    })
}

pub fn set_fullscreen(cx: &mut App, key: u32, fullscreen: bool) -> DesktopResult {
    with_window(cx, key, move |window| {
        if window.is_fullscreen() != fullscreen {
            window.toggle_fullscreen();
        }
        Ok(())
    })
}

pub fn show(cx: &mut App, key: u32) -> DesktopResult {
    with_window(cx, key, |window| {
        platform_window::show(window).map_err(DesktopError::unsupported)
    })
}

pub fn hide(cx: &mut App, key: u32) -> DesktopResult {
    with_window(cx, key, |window| {
        platform_window::hide(window).map_err(DesktopError::unsupported)
    })
}

pub fn start_dragging(cx: &mut App, key: u32) -> DesktopResult {
    with_window(cx, key, |window| {
        window.start_window_move();
        Ok(())
    })
}

pub fn emit_window_event(cx: &App, name: &str, payload: Value) {
    let Some(store) = store_from(cx) else {
        return;
    };
    let host = store.read(cx).host.clone();
    host.emit_device_event_json(name, &payload.to_string());
}

pub fn window_state(cx: &mut App, key: u32) -> DesktopResult {
    let Some(entry) = cx.global::<DesktopWindowsGlobal>().0.get(key) else {
        return Err(DesktopError::not_found(format!("window {key} is not open")));
    };
    let handle = entry.handle;
    handle
        .update(cx, |_root, window, _cx| {
            let bounds = window.bounds();
            json!({
                "windowId": key,
                "bounds": {
                    "x": f32::from(bounds.origin.x),
                    "y": f32::from(bounds.origin.y),
                    "width": f32::from(bounds.size.width),
                    "height": f32::from(bounds.size.height),
                },
                "isMaximized": platform_window::is_maximized(window),
                "isFullscreen": window.is_fullscreen(),
                "isFocused": window.is_window_active(),
                "isMinimized": platform_window::is_minimized(window),
                "scaleFactor": window.scale_factor(),
            })
        })
        .map_err(|error| DesktopError::failed(format!("window {key} is gone: {error}")))
}

/// The OS's own frame for a window, in physical pixels, for the test driver:
/// `{left, top, right, bottom, visible}`, or `null` where the platform cannot say.
#[cfg(feature = "test-driver")]
pub fn native_frame_json(cx: &mut App, key: u32) -> Value {
    #[cfg(target_os = "windows")]
    {
        let Some(entry) = cx.global::<DesktopWindowsGlobal>().0.get(key) else {
            return Value::Null;
        };
        let handle = entry.handle;
        return handle
            .update(cx, |_root, window, _cx| {
                platform_window::native_frame(window).map(|(left, top, right, bottom, visible)| {
                    json!({
                        "left": left,
                        "top": top,
                        "right": right,
                        "bottom": bottom,
                        "visible": visible,
                    })
                })
            })
            .ok()
            .flatten()
            .unwrap_or(Value::Null);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (cx, key);
        Value::Null
    }
}

pub fn list_windows(cx: &App) -> DesktopResult {
    let windows = &cx.global::<DesktopWindowsGlobal>().0;
    let list: Vec<Value> = windows
        .keys()
        .into_iter()
        .filter_map(|key| {
            let entry = windows.get(key)?;
            Some(json!({
                "windowId": key,
                "component": entry.component,
                "role": match entry.role {
                    WindowRole::Main => "main",
                    WindowRole::Secondary => "secondary",
                    WindowRole::TrayPopover => "trayPopover",
                },
            }))
        })
        .collect();
    Ok(json!({"windows": list}))
}

fn install_bounds_observer(
    window: &mut gpui::Window,
    cx: &mut gpui::Context<SurfaceRootView>,
) -> Subscription {
    let last = std::rc::Rc::new(std::cell::Cell::new(None::<(f32, f32, f32, f32)>));
    cx.observe_window_bounds(window, move |_root, window, cx| {
        let size = window.viewport_size();
        let bounds = window.bounds();
        let (width, height) = (f32::from(size.width), f32::from(size.height));
        let (x, y) = (f32::from(bounds.origin.x), f32::from(bounds.origin.y));
        let scale = window.scale_factor();
        if last.get() == Some((x, y, width, height)) {
            return;
        }
        last.set(Some((x, y, width, height)));
        let handle: AnyWindowHandle = window.window_handle().into();
        let Some(store) = cx.try_global::<StoreGlobal>() else {
            return;
        };
        let store = store.0.clone();
        store.update(cx, |store, _cx| {
            store.resize_window(handle, width, height, scale)
        });
        let frame_hook = store.read(cx).frame_hook.clone();
        frame_hook.arm(window);
        if let Some(key) = window_key_for_handle(cx, handle) {
            let host = store.read(cx).host.clone();
            host.emit_device_event_json(
                "gpuiDesktop:windowResize",
                &json!({"windowId": key, "width": width, "height": height}).to_string(),
            );
            host.emit_device_event_json(
                "gpuiDesktop:windowMove",
                &json!({"windowId": key, "x": x, "y": y}).to_string(),
            );
        }
    })
}

pub(crate) fn window_key_for_handle(cx: &gpui::App, handle: AnyWindowHandle) -> Option<u32> {
    let windows = cx.try_global::<DesktopWindowsGlobal>()?;
    windows
        .0
        .keys()
        .into_iter()
        .find(|key| windows.0.get(*key).map(|entry| entry.handle) == Some(handle))
}

/// Sends `gpuiDesktop:windowStateChange` when the window is maximized, restored,
/// minimized or made fullscreen.
///
/// `DesktopWindow`'s `stateChange` listeners wait on it, and so does a caption
/// button's maximize glyph, which has to turn into the restore glyph however the
/// window got maximized — a double click on the title bar, Win+Up, a snap — not
/// only when the button itself was pressed. Every one of those resizes the
/// window, so the bounds observer is where the change is seen.
pub(crate) fn install_state_observer<T: 'static>(
    window: &mut gpui::Window,
    cx: &mut gpui::Context<T>,
) -> Subscription {
    let state_of = |window: &gpui::Window| {
        (
            platform_window::is_maximized(window),
            platform_window::is_minimized(window),
            window.is_fullscreen(),
        )
    };
    let mut last = state_of(window);
    cx.observe_window_bounds(window, move |_root, window, cx| {
        let state = state_of(window);
        if state == last {
            return;
        }
        last = state;
        let handle: AnyWindowHandle = window.window_handle().into();
        let Some(key) = window_key_for_handle(cx, handle) else {
            return;
        };
        let Some(store) = cx.try_global::<StoreGlobal>() else {
            return;
        };
        let host = store.0.read(cx).host.clone();
        host.emit_device_event_json(
            "gpuiDesktop:windowStateChange",
            &json!({
                "windowId": key,
                "isMaximized": state.0,
                "isMinimized": state.1,
                "isFullscreen": state.2,
            })
            .to_string(),
        );
    })
}

fn install_activation_observer(
    window: &mut gpui::Window,
    cx: &mut gpui::Context<SurfaceRootView>,
    key: u32,
) -> Subscription {
    let mut last = window.is_window_active();
    cx.observe_window_activation(window, move |_root, window, cx| {
        let active = window.is_window_active();
        if active == last {
            return;
        }
        last = active;
        let Some(store) = cx.try_global::<StoreGlobal>() else {
            return;
        };
        let host = store.0.read(cx).host.clone();
        let name = if active {
            "gpuiDesktop:windowFocus"
        } else {
            "gpuiDesktop:windowBlur"
        };
        host.emit_device_event_json(name, &json!({"windowId": key}).to_string());
        if !active {
            let is_popover = cx
                .try_global::<crate::desktop::tray::TrayGlobal>()
                .is_some_and(|tray| {
                    let mut tray = tray.0.borrow_mut();
                    if tray.popover == Some(key) {
                        tray.popover = None;
                        tray.popover_dismissed_at = Some(std::time::Instant::now());
                        true
                    } else {
                        false
                    }
                });
            if is_popover {
                // Deferred: this observer runs inside the activation change's
                // window update, and closing a window from there re-enters it,
                // which GPUI reports as "RefCell already borrowed".
                cx.defer(move |cx| {
                    let _ = close_window(cx, key, true);
                });
            }
        }
    })
}

fn install_close_hook(
    window: &mut gpui::Window,
    cx: &mut gpui::Context<SurfaceRootView>,
    key: u32,
) {
    let last_request: std::rc::Rc<std::cell::Cell<Option<std::time::Instant>>> =
        std::rc::Rc::new(std::cell::Cell::new(None));
    window.on_window_should_close(cx, move |window, cx| {
        let intercept = cx
            .try_global::<DesktopWindowsGlobal>()
            .and_then(|windows| windows.0.get(key).map(|entry| entry.intercept_close))
            .unwrap_or(false);
        // A second close request within three seconds closes the window even if
        // JS never answered, so a hung or mid-reload app can always be quit.
        let unanswered = intercept
            && last_request.get().is_some_and(|previous| {
                std::time::Instant::now().duration_since(previous)
                    < std::time::Duration::from_secs(3)
            });
        // A tray that asked for it keeps the last window: hidden, not destroyed, so
        // that opening the app again shows it with its state. JavaScript's own
        // veto (`closeRequested`) comes first, below, and decides for itself.
        if !intercept && hides_on_close(cx, key) {
            if let Err(error) = platform_window::hide(window) {
                log::warn!("[desktop] could not hide window {key}: {error}");
            } else {
                log::info!("[desktop] hid window {key} instead of closing it");
                return false;
            }
        }
        if !intercept || unanswered {
            if unanswered {
                log::warn!("[desktop] window {key} close was not answered by JS; closing");
            }
            // The OS is closing it: run the same teardown as `close_window`,
            // without asking GPUI to remove a window it is already removing.
            let entry = if cx.has_global::<DesktopWindowsGlobal>() {
                cx.global_mut::<DesktopWindowsGlobal>().0.remove(key)
            } else {
                None
            };
            if let Some(entry) = entry {
                finish_close(cx, key, entry, false);
            }
            return true;
        }
        last_request.set(Some(std::time::Instant::now()));
        emit_close_requested(cx, window, key);
        false
    });
}

/// Whether closing window `key` should hide it instead.
fn hides_on_close(cx: &App, key: u32) -> bool {
    let Some(windows) = cx.try_global::<DesktopWindowsGlobal>() else {
        return false;
    };
    let Some(entry) = windows.0.get(key) else {
        return false;
    };
    let other_windows_open = windows
        .0
        .by_key
        .values()
        .any(|other| other.key != key && other.role != WindowRole::TrayPopover);
    should_hide_on_close(
        crate::desktop::tray::hides_window_on_close(cx),
        quit_on_last_window_closed(cx),
        entry.role,
        other_windows_open,
    )
}

/// The decision, apart from where its inputs come from.
///
/// Only the last window the user can close is hidden: closing one of several
/// closes it, as it always did. A popover is never hidden — it is closed so each
/// show opens a fresh one. And an app that quits when its last window closes is
/// not asking for a window to be kept, whatever else it set.
fn should_hide_on_close(
    hide_requested: bool,
    quits_on_last_window: bool,
    role: WindowRole,
    other_windows_open: bool,
) -> bool {
    hide_requested
        && !quits_on_last_window
        && role != WindowRole::TrayPopover
        && !other_windows_open
}

fn emit_close_requested(cx: &mut App, window: &mut gpui::Window, key: u32) {
    let Some(store) = cx.try_global::<StoreGlobal>() else {
        return;
    };
    let host = store.0.read(cx).host.clone();
    host.emit_device_event_json(
        "gpuiDesktop:closeRequested",
        &json!({"windowId": key}).to_string(),
    );
    store.0.read(cx).frame_hook.arm(window);
}

pub fn window_id_for_surface(cx: &App, surface_id: i32) -> Option<u32> {
    cx.try_global::<DesktopWindowsGlobal>().and_then(|windows| {
        windows
            .0
            .entry_for_surface(surface_id)
            .map(|entry| entry.key)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_and_surfaces_are_allocated_without_collisions() {
        let mut windows = DesktopWindows::new();
        assert_eq!(windows.alloc_key(), 2);
        assert_eq!(windows.alloc_key(), 3);
        assert_eq!(windows.alloc_surface(), 3);
        assert_eq!(windows.alloc_surface(), 5);
        assert_eq!(windows.alloc_surface(), 7);
        assert!(windows.keys().is_empty());
        assert!(windows.get(1).is_none());
        assert!(windows.entry_for_surface(1).is_none());
    }

    #[test]
    fn the_last_window_is_hidden_when_the_tray_asked_for_it() {
        assert!(should_hide_on_close(true, false, WindowRole::Main, false));
        assert!(should_hide_on_close(
            true,
            false,
            WindowRole::Secondary,
            false
        ));
    }

    #[test]
    fn nothing_is_hidden_unless_it_was_asked_for() {
        assert!(!should_hide_on_close(false, false, WindowRole::Main, false));
    }

    #[test]
    fn closing_one_of_several_windows_still_closes_it() {
        assert!(!should_hide_on_close(true, false, WindowRole::Main, true));
    }

    #[test]
    fn a_popover_is_closed_never_hidden() {
        assert!(!should_hide_on_close(
            true,
            false,
            WindowRole::TrayPopover,
            false
        ));
    }

    #[test]
    fn an_app_that_quits_with_its_last_window_keeps_none() {
        assert!(!should_hide_on_close(true, true, WindowRole::Main, false));
    }
}
