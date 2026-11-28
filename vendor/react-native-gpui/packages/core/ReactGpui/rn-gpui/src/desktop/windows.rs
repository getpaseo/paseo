//! One `ViewStore` owns every window: Fabric tags are unique across the
//! surfaces of a React instance, so nodes stay in one map.

use crate::bootstrap::{WindowBackground, WindowTitleBar};
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
    pub background: WindowBackground,
    /// `None` keeps the traffic lights and the shadow.
    pub window_buttons: Option<bool>,
    pub shadow: Option<bool>,
    pub traffic_light_position: Option<(f32, f32)>,
    pub role: WindowRoleOverride,
    pub popup: bool,
    /// Draw a popover at a corner of a window that covers the work area, for a
    /// compositor that will not place it (Wayland).
    #[cfg(target_os = "linux")]
    pub overlay: Option<crate::desktop::window_frame::Placement>,
}

/// A window that is nothing but its own content (no system chrome, a see-through
/// background) and asks for no position is a launcher or a palette: it belongs in
/// the middle of the screen, and it goes away when the user turns to something
/// else.
#[cfg(target_os = "linux")]
fn is_launcher(options: &OpenWindowOptions) -> bool {
    !options.popup
        && options.x.is_none()
        && options.y.is_none()
        && options.title_bar == crate::bootstrap::WindowTitleBar::Borderless
        && !matches!(
            options.background,
            crate::bootstrap::WindowBackground::Opaque
        )
}

/// Wayland will not place a window, so a launcher is drawn in the middle of a
/// window covering the work area, which the compositor puts on the monitor it
/// chooses for a new window.
#[cfg(target_os = "linux")]
fn launcher_overlay(
    options: &OpenWindowOptions,
) -> Option<crate::desktop::window_frame::Placement> {
    use crate::desktop::popover_placement::{Anchor, Reserved};
    if !is_launcher(options) || !crate::desktop::capabilities::is_wayland() {
        return None;
    }
    Some(crate::desktop::window_frame::Placement {
        anchor: Anchor::Center,
        offset: (0.0, 0.0),
        reserved: Reserved::default(),
        size: (
            options.width.unwrap_or(800.0).max(120.0),
            options.height.unwrap_or(600.0).max(120.0),
        ),
        click: None,
        work_origin: (0.0, 0.0),
        bare: true,
    })
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
    set_custom_title_bar(key, options.title_bar.is_custom());
    #[cfg(target_os = "linux")]
    {
        if options.overlay.is_none() {
            options.overlay = launcher_overlay(&options);
        }
        if is_launcher(&options) {
            crate::desktop::window_frame::mark_launcher(surface_id);
        }
    }
    let framed = crate::desktop::window_frame::wanted(
        matches!(
            options.background,
            crate::bootstrap::WindowBackground::Opaque
        ),
        options.shadow.unwrap_or(true),
        options.title_bar == crate::bootstrap::WindowTitleBar::Borderless,
    );
    #[cfg(target_os = "linux")]
    match options.overlay {
        Some(placement) => crate::desktop::window_frame::place(surface_id, placement),
        None if framed || options.popup => crate::desktop::window_frame::enroll(surface_id),
        None => {}
    }

    let width = options.width.unwrap_or(800.0).max(120.0);
    let height = options.height.unwrap_or(600.0).max(120.0);
    // A popover's content is the size the app asked for, so on Linux the window
    // is grown by the margin its frame needs, and placed that much earlier.
    #[cfg(target_os = "linux")]
    let overlay = options.overlay;
    #[cfg(not(target_os = "linux"))]
    let overlay: Option<()> = None;
    let margin = if cfg!(target_os = "linux") && options.popup && overlay.is_none() {
        crate::desktop::window_frame::frame().shadow_extent
    } else {
        0.0
    };
    let (window_width, window_height) = if overlay.is_some() {
        // Only a size to restore to: the window is maximized to the work area.
        (1024.0, 768.0)
    } else {
        (width + 2.0 * margin, height + 2.0 * margin)
    };
    let bounds = match (options.x, options.y) {
        (Some(x), Some(y)) => Bounds::new(
            point(px(x - margin), px(y - margin)),
            size(px(window_width), px(window_height)),
        ),
        _ => Bounds::centered(None, size(px(window_width), px(window_height)), cx),
    };
    // The placed origin, in points: what the popover's own window hints use.
    let placed_origin = (f32::from(bounds.origin.x), f32::from(bounds.origin.y));
    let title = options
        .title
        .clone()
        .unwrap_or_else(|| options.component.clone());
    let window_options = WindowOptions {
        window_bounds: Some(if overlay.is_some() {
            WindowBounds::Maximized(bounds)
        } else {
            WindowBounds::Windowed(bounds)
        }),
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
        window_background: if cfg!(target_os = "linux")
            && (options.title_bar.is_custom() || options.popup)
            && (framed || options.popup)
            && matches!(
                options.background,
                crate::bootstrap::WindowBackground::Opaque
            ) {
            gpui::WindowBackgroundAppearance::Transparent
        } else {
            options.background.appearance()
        },
        is_movable: !options.popup && overlay.is_none(),
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
        show: !options.popup || overlay.is_some(),
        // A custom title bar means the app draws and moves the bar itself.
        app_owns_titlebar_drag: options.title_bar.is_custom(),
        ..Default::default()
    };

    let mut window_options = window_options;
    let show_behind = crate::desktop::background::prepare(&mut window_options);
    if !options.popup {
        if let Some(display) = crate::desktop::background::test_display(cx) {
            window_options.display_id = Some(display.id());
            window_options.window_bounds = Some(WindowBounds::Windowed(Bounds::centered(
                Some(display.id()),
                bounds.size,
                cx,
            )));
        }
    }
    let store_for_root = store;
    crate::app_hooks::run_app_init(cx);
    let handle = crate::app_hooks::open_root_window(cx, window_options, move |window, cx| {
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
    if show_behind {
        let _ = handle.update(cx, |_root, window, _cx| {
            crate::desktop::background::show_behind(window);
        });
    }

    let (w, h, scale, gave_back) = handle
        .update(cx, |_root, window, _cx| {
            #[cfg_attr(not(target_os = "linux"), allow(unused_mut))]
            let mut gave_back = false;
            // A compositor can refuse the decorations request for one window and
            // grant it for another, so the capability follows the newest window.
            crate::desktop::capabilities::note_window_decorations(window.window_decorations());
            #[cfg(target_os = "linux")]
            {
                // X11 window managers place a window as they like unless told its
                // position was the user's, so the position asked for (or centred)
                // is applied directly. Wayland has no such thing, and the call
                // is refused there.
                if !options.popup {
                    let _ = platform_window::set_position(window, placed_origin.0, placed_origin.1);
                }
                if is_launcher(&options) {
                    let _ = platform_window::skip_taskbar(window);
                }
                crate::desktop::window_frame::sync(window, surface_id);
                // A compositor that left the decorations to itself draws no
                // frame, so the margin the popover was grown by is given back.
                if options.popup
                    && margin > 0.0
                    && crate::desktop::window_frame::insets_of(surface_id).horizontal() == 0.0
                {
                    window.resize(size(px(width), px(height)));
                    if let (Some(x), Some(y)) = (options.x, options.y) {
                        // The window was created `margin` up and to the left.
                        let _ = platform_window::set_position(window, x, y);
                    }
                    gave_back = true;
                }
            }
            let size = window.viewport_size();
            let frame = crate::desktop::window_frame::insets_of(surface_id);
            (
                (f32::from(size.width) - frame.horizontal()).max(1.0),
                (f32::from(size.height) - frame.vertical()).max(1.0),
                window.scale_factor(),
                gave_back,
            )
        })
        .unwrap_or((width, height, 2.0, false));
    // A popover is created hidden, and a window that has not been shown has not
    // had its first `WM_SIZE`, so what `viewport_size` reports for it is not
    // something to start a surface from. The popover's own size is known, so the
    // surface starts at that, and `prepare_popover` gives the window the same one.
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    let (w, h) = if options.popup || overlay.is_some() {
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
            if !options.popup {
                crate::desktop::platform_window::style_window(
                    window,
                    options.window_buttons.unwrap_or(true),
                    options.shadow.unwrap_or(true),
                    options.title_bar,
                );
            }
            if options.popup {
                crate::desktop::platform_window::style_as_popover(window);
                // Set the popover's window hints while it is still unmapped,
                // then ask the window manager to map and focus it. Failures are
                // not fatal: a platform that needs none of this (or a Wayland
                // session, which has no absolute placement) still gets a working
                // window, just placed by the compositor.
                // A popover whose frame margin was given back is placed by its
                // content, which is where the margin had put the window's corner.
                let (hint_x, hint_y, hint_width, hint_height) = if gave_back {
                    (
                        placed_origin.0 + margin,
                        placed_origin.1 + margin,
                        width,
                        height,
                    )
                } else {
                    (
                        placed_origin.0,
                        placed_origin.1,
                        window_width,
                        window_height,
                    )
                };
                if let Err(error) = crate::desktop::platform_window::prepare_popover(
                    window,
                    hint_x,
                    hint_y,
                    hint_width,
                    hint_height,
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
            let ((bounds, state, activation), keep_alive) =
                crate::app_hooks::observer_context(cx, |observers| {
                    let bounds = install_bounds_observer(window, observers, surface_id);
                    let state = install_state_observer(window, observers);
                    let activation = install_activation_observer(window, observers, key);
                    install_close_hook(window, observers, key);
                    (bounds, state, activation)
                });
            subscriptions.extend([bounds, state, activation, keep_alive]);
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
    if let Ok(state) = window_state(cx, key) {
        super::window_mirror::set(key, &state);
    }
    super::app_state::schedule(cx);
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
    set_custom_title_bar(key, false);
    super::window_mirror::remove(key);
    super::app_state::schedule(cx);
    let surface_id = entry.surface_id;
    super::zoom::forget(surface_id);
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
    let _ = handle.update(cx, |_root, window, cx| {
        crate::app_hooks::observer_context_for_good(cx, |observers| {
            install_close_hook(window, observers, key);
        });
    });
}

/// Reports the main window's bounds, state and focus to JS and to the state
/// mirror, as `open_window` does for the windows it creates. The main window
/// resizes the store through its own observer in `bootstrap`, so this only
/// reports.
static MAIN_STARTED_HIDDEN: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// The main window was opened without being shown (`window.visible: false` or
/// `--hidden`), so it reports itself as not visible until it is shown.
pub fn note_main_started_hidden() {
    MAIN_STARTED_HIDDEN.store(true, std::sync::atomic::Ordering::Relaxed);
}

pub fn install_main_window_events(cx: &mut App, handle: AnyWindowHandle, key: u32) {
    if let Ok(state) = window_state(cx, key) {
        super::window_mirror::set(key, &state);
    }
    if MAIN_STARTED_HIDDEN.load(std::sync::atomic::Ordering::Relaxed) {
        super::window_mirror::patch(key, &[("isVisible", json!(false))]);
    }
    super::app_state::schedule(cx);
    let _ = handle.update(cx, |_root, window, app| {
        crate::app_hooks::observer_context_for_good(app, |cx| {
            let last = std::rc::Rc::new(std::cell::Cell::new(None::<(f32, f32, f32, f32)>));
            cx.observe_window_bounds(window, move |_root, window, cx| {
                let bounds = window.bounds();
                let now = (
                    f32::from(bounds.origin.x),
                    f32::from(bounds.origin.y),
                    f32::from(bounds.size.width),
                    f32::from(bounds.size.height),
                );
                let previous = last.replace(Some(now));
                if previous == Some(now) {
                    return;
                }
                super::window_mirror::patch(
                    key,
                    &[
                        (
                            "bounds",
                            json!({"x": now.0, "y": now.1, "width": now.2, "height": now.3}),
                        ),
                        ("scaleFactor", json!(window.scale_factor())),
                        ("topInset", json!(top_inset(window, key))),
                    ],
                );
                let Some(store) = cx.try_global::<StoreGlobal>() else {
                    return;
                };
                let host = store.0.read(cx).host.clone();
                if key == MAIN_WINDOW_KEY {
                    super::display::report(window, cx, &host);
                }
                emit_geometry(&host, key, previous, now);
            })
            .detach();
            install_activation_observer(window, cx, key).detach();
            #[cfg(target_os = "windows")]
            if let Some(store) = cx.try_global::<StoreGlobal>() {
                let host = store.0.read(cx).host.clone();
                super::keyboard::watch(window, host);
            }
            // Windows installs its own state observer for the main window.
            if !cfg!(windows) {
                install_state_observer(window, cx).detach();
            }
        });
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
    if crate::desktop::background::enabled() {
        #[cfg(feature = "test-driver")]
        return simulate_activation(cx, key, true);
        #[cfg(not(feature = "test-driver"))]
        return Ok(json!({"windowId": key, "focused": false}));
    }
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
    let changed = json!(title);
    let result = with_window(cx, key, move |window| {
        window.set_window_title(&title);
        Ok(())
    });
    if result.is_ok() {
        report_state_change(cx, key, &[("title", changed)]);
    }
    result
}

/// Records fields of a window's state that no platform observer reports, and
/// tells JS they changed.
fn report_state_change(cx: &mut App, key: u32, fields: &[(&str, Value)]) {
    super::window_mirror::patch(key, fields);
    let mut payload = serde_json::Map::new();
    payload.insert("windowId".to_string(), json!(key));
    for (name, value) in fields {
        payload.insert((*name).to_string(), value.clone());
    }
    emit_window_event(cx, "gpuiDesktop:windowStateChange", Value::Object(payload));
}

const ZOOM_STEPS: [f32; 17] = [
    0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0,
];

/// The factor one step from `current` in `direction`: `zoomIn`, `zoomOut`, or
/// `resetZoom` for 1. The steps are the ones a browser offers.
pub(crate) fn zoom_step(current: f32, direction: &str) -> f32 {
    match direction {
        "zoomIn" => ZOOM_STEPS
            .iter()
            .copied()
            .find(|step| *step > current + 0.001)
            .unwrap_or(5.0),
        "zoomOut" => ZOOM_STEPS
            .iter()
            .rev()
            .copied()
            .find(|step| *step < current - 0.001)
            .unwrap_or(0.25),
        _ => 1.0,
    }
}

/// Zooms a window in or out by a step, or back to its natural size.
pub fn main_window_handle(cx: &App) -> Option<AnyWindowHandle> {
    cx.global::<DesktopWindowsGlobal>()
        .0
        .get(MAIN_WINDOW_KEY)
        .map(|entry| entry.handle)
}

pub fn step_zoom(cx: &mut App, key: u32, direction: &str) -> DesktopResult {
    let Some(entry) = cx.global::<DesktopWindowsGlobal>().0.get(key) else {
        return Err(DesktopError::not_found(format!("window {key} is not open")));
    };
    let factor = zoom_step(super::zoom::get(entry.surface_id), direction);
    set_zoom_factor(cx, key, factor)
}

/// Scales a window's content, `1.0` being its natural size. The factor is
/// clamped to 0.25 to 5 and lasts until the window closes: remembering it across
/// launches is up to the app.
pub fn set_zoom_factor(cx: &mut App, key: u32, factor: f32) -> DesktopResult {
    let Some(entry) = cx.global::<DesktopWindowsGlobal>().0.get(key) else {
        return Err(DesktopError::not_found(format!("window {key} is not open")));
    };
    let (handle, surface_id) = (entry.handle, entry.surface_id);
    let factor = super::zoom::set(surface_id, factor);
    let Some(store) = store_from(cx) else {
        return Ok(json!({"windowId": key}));
    };
    handle
        .update(cx, |_root, window, cx| {
            let (size, scale) = (window.viewport_size(), window.scale_factor());
            store.update(cx, |store, cx| {
                store.resize_window(
                    window.window_handle().into(),
                    f32::from(size.width),
                    f32::from(size.height),
                    scale,
                    cx,
                );
                if let Some(root) = store.roots.get(&surface_id) {
                    root.update(cx, |_, cx| cx.notify());
                }
                store.frame_hook.arm(window);
            });
        })
        .map_err(|error| DesktopError::failed(format!("window {key} is gone: {error}")))?;
    report_state_change(cx, key, &[("zoomFactor", json!(factor))]);
    Ok(json!({"windowId": key}))
}

/// Paints the window's own background, behind the content.
pub fn set_background_color(cx: &mut App, key: u32, argb: u32) -> DesktopResult {
    with_window(cx, key, move |window| {
        platform_window::set_background_color(window, argb).map_err(DesktopError::unsupported)
    })
}

/// Gives the window's native chrome a light or dark look; `None` follows the system.
pub fn set_chrome_appearance(cx: &mut App, key: u32, dark: Option<bool>) -> DesktopResult {
    with_window(cx, key, move |window| {
        platform_window::set_chrome_appearance(window, dark).map_err(DesktopError::unsupported)
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

pub fn set_visible_on_all_workspaces(cx: &mut App, key: u32, visible: bool) -> DesktopResult {
    with_window(cx, key, move |window| {
        platform_window::set_visible_on_all_workspaces(window, visible)
            .map_err(DesktopError::unsupported)
    })
}

pub fn minimize(cx: &mut App, key: u32) -> DesktopResult {
    let result = with_window(cx, key, |window| {
        window.minimize_window();
        Ok(())
    });
    recheck_window_state_later(cx, key);
    result
}

pub fn move_focus(cx: &mut App, key: u32, backwards: bool) -> DesktopResult {
    let Some(entry) = cx.global::<DesktopWindowsGlobal>().0.get(key) else {
        return Err(DesktopError::not_found(format!("window {key} is not open")));
    };
    entry
        .handle
        .update(cx, |_root, window, cx| {
            if backwards {
                window.focus_prev(cx);
            } else {
                window.focus_next(cx);
            }
        })
        .map_err(|error| DesktopError::failed(format!("window {key} is gone: {error}")))?;
    Ok(json!({"windowId": key}))
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

/// Runs a native window operation once the update that asked for it has ended.
/// The operating system reports the change while it makes it, and GPUI's window
/// callbacks need the `App` that the update still holds.
fn run_outside_update(cx: &mut App, run: Box<dyn FnOnce()>) {
    cx.spawn(async move |_| run()).detach();
}

pub fn show(cx: &mut App, key: u32) -> DesktopResult {
    let later = std::cell::RefCell::new(None);
    let result = with_window(cx, key, |window| {
        *later.borrow_mut() =
            Some(platform_window::show_later(window).map_err(DesktopError::unsupported)?);
        Ok(())
    });
    if let Some(run) = later.take() {
        run_outside_update(cx, run);
        recheck_window_state_later(cx, key);
        reveal_later(cx, key);
    }
    if result.is_ok() {
        report_state_change(cx, key, &[("isVisible", json!(true))]);
        super::app_state::schedule(cx);
    }
    result
}

/// The longest a window that was hidden is kept clear after it is shown. It is
/// revealed sooner, when the frames that follow the show have been drawn.
const REVEAL_LIMIT: std::time::Duration = std::time::Duration::from_millis(80);

static LAST_REVEAL: std::sync::Mutex<Option<&'static str>> = std::sync::Mutex::new(None);

/// What made the last revealed window opaque: `frame` when the frames after the
/// show had been drawn, `timeout` when the limit came first.
pub fn last_reveal() -> Option<&'static str> {
    *LAST_REVEAL.lock().expect("reveal state poisoned")
}

/// Makes a window that was shown clear opaque once its first frame has been
/// drawn and handed to the compositor. The first frame callback runs as the
/// first frame after the show begins, the second as the next one begins, so the
/// first has been drawn by then. The limit covers a window that gets no frames,
/// such as one that other windows cover.
fn reveal_later(cx: &mut App, key: u32) {
    *LAST_REVEAL.lock().expect("reveal state poisoned") = None;
    let done = std::rc::Rc::new(std::cell::Cell::new(false));
    let reveal = {
        let done = done.clone();
        move |window: &mut gpui::Window, reason: &'static str| {
            if done.replace(true) {
                return;
            }
            let _ = platform_window::reveal_window(window);
            *LAST_REVEAL.lock().expect("reveal state poisoned") = Some(reason);
        }
    };
    let _ = with_window(cx, key, {
        let reveal = reveal.clone();
        move |window| {
            window.refresh();
            window.on_next_frame(move |window, _| {
                window.on_next_frame(move |window, _| reveal(window, "frame"));
                window.refresh();
            });
            Ok(())
        }
    });
    cx.spawn(async move |cx| {
        cx.background_executor().timer(REVEAL_LIMIT).await;
        let _ = cx.update(|cx| {
            let _ = with_window(cx, key, |window| {
                reveal(window, "timeout");
                Ok(())
            });
        });
    })
    .detach();
}

pub fn hide(cx: &mut App, key: u32) -> DesktopResult {
    let later = std::cell::RefCell::new(None);
    let result = with_window(cx, key, |window| {
        *later.borrow_mut() =
            Some(platform_window::hide_later(window).map_err(DesktopError::unsupported)?);
        Ok(())
    });
    if let Some(run) = later.take() {
        run_outside_update(cx, run);
    }
    if result.is_ok() {
        report_state_change(cx, key, &[("isVisible", json!(false))]);
        super::app_state::schedule(cx);
    }
    result
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
    let surface_id = entry.surface_id;
    let title = entry.title.clone();
    let visible = super::window_mirror::get(key)
        .and_then(|state| state["isVisible"].as_bool())
        .unwrap_or(true);
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
                "isFocused": is_active(window, key),
                "isMinimized": platform_window::is_minimized(window),
                "isVisible": visible,
                "title": title,
                "zoomFactor": super::zoom::get(surface_id),
                "scaleFactor": window.scale_factor(),
                "topInset": top_inset(window, key),
            })
        })
        .map_err(|error| DesktopError::failed(format!("window {key} is gone: {error}")))
}

/// Windows whose title bar the app draws, by key.
static CUSTOM_TITLE_BARS: std::sync::Mutex<std::collections::BTreeSet<u32>> =
    std::sync::Mutex::new(std::collections::BTreeSet::new());

pub fn set_custom_title_bar(key: u32, custom: bool) {
    let mut keys = CUSTOM_TITLE_BARS.lock().expect("title bars poisoned");
    if custom {
        keys.insert(key);
    } else {
        keys.remove(&key);
    }
}

/// The height of the `TitleBar` component, which is the bar an app draws under
/// a window without the platform's own.
const TITLE_BAR_HEIGHT: f32 = 38.0;

/// How far the title bar reaches into the content area. On macOS that is the
/// system bar under a transparent title bar. Elsewhere it is the bar the app
/// draws: nonzero for a custom title bar, and on Linux only once the
/// compositor has agreed to client-side decorations.
pub fn top_inset(window: &gpui::Window, key: u32) -> f32 {
    #[cfg(target_os = "macos")]
    {
        let _ = key;
        crate::native_view::window_top_inset(window)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let custom = CUSTOM_TITLE_BARS
            .lock()
            .expect("title bars poisoned")
            .contains(&key);
        #[cfg(target_os = "linux")]
        let drawn_by_app = matches!(
            window.window_decorations(),
            gpui::Decorations::Client { .. }
        );
        #[cfg(not(target_os = "linux"))]
        let drawn_by_app = {
            let _ = window;
            true
        };
        app_bar_inset(custom, drawn_by_app)
    }
}

#[cfg_attr(target_os = "macos", allow(dead_code))]
fn app_bar_inset(custom: bool, drawn_by_app: bool) -> f32 {
    if custom && drawn_by_app {
        TITLE_BAR_HEIGHT
    } else {
        0.0
    }
}

#[cfg(test)]
mod inset_tests {
    use super::*;

    #[test]
    fn only_a_bar_the_app_draws_takes_room() {
        assert_eq!(app_bar_inset(true, true), TITLE_BAR_HEIGHT);
        assert_eq!(app_bar_inset(true, false), 0.0);
        assert_eq!(app_bar_inset(false, true), 0.0);
    }

    #[test]
    fn a_closed_window_forgets_its_bar() {
        set_custom_title_bar(9_001, true);
        assert!(CUSTOM_TITLE_BARS.lock().unwrap().contains(&9_001));
        set_custom_title_bar(9_001, false);
        assert!(!CUSTOM_TITLE_BARS.lock().unwrap().contains(&9_001));
    }
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

fn install_bounds_observer<T: 'static>(
    window: &mut gpui::Window,
    cx: &mut gpui::Context<T>,
    surface_id: i32,
) -> Subscription {
    let last = std::rc::Rc::new(std::cell::Cell::new(None::<(f32, f32, f32, f32)>));
    cx.observe_window_bounds(window, move |_root, window, cx| {
        let size = window.viewport_size();
        let bounds = window.bounds();
        let (width, height) = (f32::from(size.width), f32::from(size.height));
        let (x, y) = (f32::from(bounds.origin.x), f32::from(bounds.origin.y));
        let scale = window.scale_factor();
        #[cfg(target_os = "linux")]
        let frame_changed = crate::desktop::window_frame::sync(window, surface_id);
        #[cfg(not(target_os = "linux"))]
        let frame_changed = {
            let _ = surface_id;
            false
        };
        let previous = last.replace(Some((x, y, width, height)));
        if !frame_changed && previous == Some((x, y, width, height)) {
            return;
        }
        let handle: AnyWindowHandle = window.window_handle().into();
        let Some(store) = cx.try_global::<StoreGlobal>() else {
            return;
        };
        let store = store.0.clone();
        store.update(cx, |store, cx| {
            store.resize_window(handle, width, height, scale, cx)
        });
        let frame_hook = store.read(cx).frame_hook.clone();
        frame_hook.arm(window);
        if let Some(key) = window_key_for_handle(cx, handle) {
            super::window_mirror::patch(
                key,
                &[
                    (
                        "bounds",
                        json!({
                            "x": x,
                            "y": y,
                            "width": f32::from(bounds.size.width),
                            "height": f32::from(bounds.size.height),
                        }),
                    ),
                    ("scaleFactor", json!(scale)),
                    ("topInset", json!(top_inset(window, key))),
                ],
            );
            let host = store.read(cx).host.clone();
            emit_geometry(&host, key, previous, (x, y, width, height));
        }
    })
}

/// Sends `windowResize` and `windowMove` for what changed between two
/// `(x, y, width, height)` bounds: a drag only moves, a resize from the
/// bottom-right edge only resizes.
fn emit_geometry(
    host: &crate::host::Host,
    key: u32,
    previous: Option<(f32, f32, f32, f32)>,
    now: (f32, f32, f32, f32),
) {
    let (x, y, width, height) = now;
    if previous.is_none_or(|(_, _, w, h)| (w, h) != (width, height)) {
        host.emit_device_event_json(
            "gpuiDesktop:windowResize",
            &json!({"windowId": key, "width": width, "height": height}).to_string(),
        );
    }
    if previous.is_none_or(|(px, py, _, _)| (px, py) != (x, y)) {
        host.emit_device_event_json(
            "gpuiDesktop:windowMove",
            &json!({"windowId": key, "x": x, "y": y}).to_string(),
        );
    }
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
        publish_window_state(cx, key, state);
    })
}

fn publish_window_state(cx: &mut App, key: u32, state: (bool, bool, bool)) {
    super::window_mirror::patch(
        key,
        &[
            ("isMaximized", json!(state.0)),
            ("isMinimized", json!(state.1)),
            ("isFullscreen", json!(state.2)),
        ],
    );
    super::app_state::schedule(cx);
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
}

/// Reads the window's maximized, minimized and fullscreen state again a moment
/// after a command, and publishes it if it changed. A window that is not key,
/// as in a background run, does not always send the bounds change that the
/// observer waits for when it is minimized or brought back.
fn recheck_window_state_later(cx: &mut App, key: u32) {
    cx.spawn(async move |cx| {
        for delay in [250u64, 750, 1500] {
            cx.background_executor()
                .timer(std::time::Duration::from_millis(delay))
                .await;
            let _ = cx.update(|cx| {
                let Some(handle) = cx
                    .global::<DesktopWindowsGlobal>()
                    .0
                    .get(key)
                    .map(|entry| entry.handle)
                else {
                    return;
                };
                let state = handle
                    .update(cx, |_root, window, _cx| {
                        (
                            platform_window::is_maximized(window),
                            platform_window::is_minimized(window),
                            window.is_fullscreen(),
                        )
                    })
                    .ok();
                let Some(state) = state else {
                    return;
                };
                let known = super::window_mirror::get(key);
                let flag = |name: &str| {
                    known
                        .as_ref()
                        .and_then(|value| value.get(name))
                        .and_then(Value::as_bool)
                };
                if flag("isMaximized") != Some(state.0)
                    || flag("isMinimized") != Some(state.1)
                    || flag("isFullscreen") != Some(state.2)
                {
                    publish_window_state(cx, key, state);
                }
            });
        }
    })
    .detach();
}

/// Reports focus changes to the mirror and to JS. JS can mount before the
/// window's state is published and then holds no state, so the window counts as
/// not focused until it is reported: one check runs once the install has
/// finished and reports a window that is already active.
fn install_activation_observer<T: 'static>(
    window: &mut gpui::Window,
    cx: &mut gpui::Context<T>,
    key: u32,
) -> Subscription {
    let last = std::rc::Rc::new(std::cell::Cell::new(false));
    window.defer(cx, {
        let last = last.clone();
        move |window, cx| report_activation(window, cx, key, &last)
    });
    cx.observe_window_activation(window, move |_root, window, cx| {
        if !window.is_window_active() {
            crate::tooltip::dismiss(window, cx);
        }
        report_activation(window, cx, key, &last);
    })
}

/// What a test says a window's activation is, in place of the operating
/// system's answer.
#[cfg(feature = "test-driver")]
fn simulated_activation(key: u32) -> Option<bool> {
    SIMULATED_ACTIVATION
        .lock()
        .expect("simulated activation poisoned")
        .get(&key)
        .copied()
}

#[cfg(not(feature = "test-driver"))]
fn simulated_activation(_key: u32) -> Option<bool> {
    None
}

#[cfg(feature = "test-driver")]
static SIMULATED_ACTIVATION: std::sync::Mutex<BTreeMap<u32, bool>> =
    std::sync::Mutex::new(BTreeMap::new());

fn is_active(window: &gpui::Window, key: u32) -> bool {
    simulated_activation(key).unwrap_or_else(|| window.is_window_active())
}

/// Makes a window active or inactive as far as the app can tell, whatever the
/// operating system thinks, so a test does not depend on which application is in
/// front. The window then ignores real activation changes.
#[cfg(feature = "test-driver")]
pub fn simulate_activation(cx: &mut App, key: u32, active: bool) -> DesktopResult {
    SIMULATED_ACTIVATION
        .lock()
        .expect("simulated activation poisoned")
        .insert(key, active);
    let Some(entry) = cx.global::<DesktopWindowsGlobal>().0.get(key) else {
        return Err(DesktopError::not_found(format!("window {key} is not open")));
    };
    let handle = entry.handle;
    handle
        .update(cx, |_root, window, cx| {
            report_activation(window, cx, key, &std::cell::Cell::new(!active));
        })
        .map_err(|error| DesktopError::failed(format!("window {key} is gone: {error}")))?;
    Ok(json!({"windowId": key}))
}

fn report_activation(
    window: &mut gpui::Window,
    cx: &mut App,
    key: u32,
    last: &std::cell::Cell<bool>,
) {
    let active = is_active(window, key);
    if active == last.get() {
        return;
    }
    last.set(active);
    if !active {
        crate::events::cancel_presses(window, cx);
    }
    super::window_mirror::patch(key, &[("isFocused", json!(active))]);
    super::app_state::schedule(cx);
    let Some(store) = cx.try_global::<StoreGlobal>() else {
        return;
    };
    let host = store.0.read(cx).host.clone();
    if active && key == MAIN_WINDOW_KEY {
        // The text scale is changed in system settings, outside the app.
        super::display::report(window, cx, &host);
    }
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
        // A launcher closes when the user turns to another window. On Wayland it
        // could not stay above that window anyway, and would be left behind it,
        // invisible and still open.
        #[cfg(target_os = "linux")]
        let is_launcher = cx
            .try_global::<DesktopWindowsGlobal>()
            .and_then(|windows| windows.0.get(key))
            .is_some_and(|entry| crate::desktop::window_frame::is_launcher(entry.surface_id));
        #[cfg(not(target_os = "linux"))]
        let is_launcher = false;
        if is_popover || is_launcher {
            // Deferred: this runs inside the activation change's window update,
            // and closing a window from there re-enters it, which GPUI reports
            // as "RefCell already borrowed".
            cx.defer(move |cx| {
                let _ = close_window(cx, key, true);
            });
        }
    }
}

/// Asks the Modal shown last to close itself, as `onRequestClose`, and says
/// whether one was shown.
pub(crate) fn request_modal_close(window: &mut gpui::Window, cx: &mut gpui::App) -> bool {
    let Some(store) = crate::store::store_from(cx) else {
        return false;
    };
    let target = {
        let store = store.read(cx);
        store
            .nodes
            .iter()
            .filter_map(|(tag, node)| {
                let node = node.read(cx);
                let portal =
                    crate::extensions::component_portal(&node.component, node.extension_props())?;
                portal
                    .visible
                    .then_some(portal.close_request_event)
                    .flatten()
                    .map(|event| (*tag, event))
            })
            .max_by_key(|(tag, _)| *tag)
    };
    let Some((tag, event)) = target else {
        return false;
    };
    let store = store.read(cx);
    store
        .host
        .dispatch_event(tag, &event, &serde_json::json!({}));
    store.frame_hook.arm(window);
    true
}

fn install_close_hook<T: 'static>(window: &mut gpui::Window, cx: &mut gpui::Context<T>, key: u32) {
    let last_request: std::rc::Rc<std::cell::Cell<Option<std::time::Instant>>> =
        std::rc::Rc::new(std::cell::Cell::new(None));
    window.on_window_should_close(cx, move |window, cx| {
        // A visible Modal answers the close button first, as it answers the
        // Escape key: `onRequestClose` decides, and the window stays.
        if request_modal_close(window, cx) {
            return false;
        }
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
    #[test]
    fn zoom_steps_follow_the_browser_levels() {
        assert_eq!(zoom_step(1.0, "zoomIn"), 1.1);
        assert_eq!(zoom_step(1.0, "zoomOut"), 0.9);
        assert_eq!(zoom_step(1.3, "zoomIn"), 1.5);
        assert_eq!(zoom_step(5.0, "zoomIn"), 5.0);
        assert_eq!(zoom_step(0.25, "zoomOut"), 0.25);
        assert_eq!(zoom_step(2.0, "resetZoom"), 1.0);
    }

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
