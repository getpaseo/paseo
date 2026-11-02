//! Linux has no native menu GPUI can use (`muda` needs a GTK window), so GPUI
//! draws it. `RN_GPUI_CONTEXT_MENU=gpui` / `RN_GPUI_MENU_BAR=gpui` select it
//! on other platforms, for tests.

use crate::desktop::context_menu::{ContextMenuRequest, Responder};
use crate::desktop::menu_model::{MenuModel, MenuNode};
use gpui::prelude::FluentBuilder as _;
use gpui::{
    point, px, size, App, AppContext, Bounds, Context, InteractiveElement, IntoElement,
    ParentElement, Render, SharedString, Styled, Window, WindowBounds, WindowKind, WindowOptions,
};
use std::cell::RefCell;

pub const MENU_BAR_HEIGHT: f32 = 26.0;

const ROW_HEIGHT: f32 = 26.0;
const PADDING: f32 = 6.0;
const MIN_WIDTH: f32 = 160.0;
const MAX_WIDTH: f32 = 420.0;

/// A GPUI popup's elements are not RN nodes, so the test driver drives the
/// open popup through this.
pub struct PendingMenu {
    pub window: gpui::AnyWindowHandle,
    pub items: Vec<MenuNode>,
    pub responder: Responder,
}

pub struct PendingMenuGlobal(pub RefCell<Option<PendingMenu>>);
impl gpui::Global for PendingMenuGlobal {}

/// Closes the menu currently tracked in `PendingMenuGlobal`, if any.
///
/// Only one top-level GPUI menu is meant to be up at a time. Opening a second
/// one used to overwrite the global and orphan the first window: nothing else
/// reaps a popup, so it stayed on screen (and on top) until the process exited,
/// and a repeated right-click left a stack of them. Every opener runs this
/// first, so a new menu replaces the old one instead of joining it.
fn close_open_menu(cx: &mut App) {
    let Some(pending) = cx.try_global::<PendingMenuGlobal>() else {
        return;
    };
    let taken = pending.0.borrow_mut().take();
    if let Some(menu) = taken {
        let _ = menu
            .window
            .update(cx, |_root, window, _cx| window.remove_window());
    }
}

pub fn should_use_gpui() -> bool {
    match std::env::var("RN_GPUI_CONTEXT_MENU").ok().as_deref() {
        Some("gpui") => true,
        Some("native") => false,
        _ => cfg!(target_os = "linux"),
    }
}

pub fn should_use_gpui_menu_bar() -> bool {
    match std::env::var("RN_GPUI_MENU_BAR").ok().as_deref() {
        Some("gpui") => true,
        Some("native") => false,
        _ => cfg!(target_os = "linux"),
    }
}

/// The inset the React surface leaves at the top of a window for the menu bar.
///
/// This is the process-wide answer, for callers with no window in hand. A caller
/// that knows its window must use [`menu_bar_inset_for`], because the bar can be
/// hidden for one window and shown in another — the main window and a popover can
/// disagree, and the surface size has to follow the window it belongs to.
pub fn menu_bar_inset() -> f32 {
    if should_use_gpui_menu_bar() {
        MENU_BAR_HEIGHT
    } else {
        0.0
    }
}

/// The inset for one window, honouring a runtime hide.
pub fn menu_bar_inset_for(_cx: &gpui::App, window_id: u32) -> f32 {
    menu_bar_inset_for_window_id(window_id)
}

/// The inset for a window id, for callers with no `Context`.
///
/// `ViewStore::resize_window` is one: it is handed an `AnyWindowHandle` and the
/// surface id, and the thread local holds the answer without needing `cx`.
pub fn menu_bar_inset_for_window_id(window_id: u32) -> f32 {
    if !should_use_gpui_menu_bar() || menu_bar_hidden(window_id) {
        0.0
    } else {
        MENU_BAR_HEIGHT
    }
}

/// Whether this window draws its menu bar.
///
/// macOS answers `false` always: its menu bar is the system's, and there is
/// nothing in the window to hide. The capability `menuBarInWindow` reports the
/// same thing to JS, so an app can hide its own UI on the one platform where
/// hiding does nothing.
pub fn menu_bar_in_window(window_id: u32) -> bool {
    should_use_gpui_menu_bar() && !menu_bar_hidden(window_id)
}

pub fn menu_bar_hidden(window_id: u32) -> bool {
    HIDDEN_MENU_BARS.with(|hidden| hidden.borrow().contains(&window_id))
}

thread_local! {
    /// Windows whose bar was hidden, mirrored here so the answer is available
    /// without a `Context` — `menu_bar_inset` is called from window plumbing that
    /// has one, but the JS getter and the tests do not.
    static HIDDEN_MENU_BARS: std::cell::RefCell<std::collections::HashSet<u32>> =
        std::cell::RefCell::new(std::collections::HashSet::new());
}

/// Re-applies the surface size after the inset changed.
///
/// The React surface is laid out to the window's size minus the inset, and the
/// window will not send a resize of its own just because the bar went away, so
/// the store has to be told the new answer.
pub fn resize_surfaces_for_menu_bar(cx: &mut gpui::App, window_id: u32) {
    let Some(store) = cx.try_global::<crate::store::StoreGlobal>() else {
        return;
    };
    let store = store.0.clone();
    let handle = {
        let windows = cx.global::<crate::desktop::windows::DesktopWindowsGlobal>();
        windows.0.get(window_id).map(|entry| entry.handle)
    };
    let Some(handle) = handle else {
        return;
    };
    let size = handle
        .update(cx, |_, window, _| window.viewport_size())
        .ok();
    let Some(size) = size else {
        return;
    };
    let scale = handle
        .update(cx, |_, window, _| window.scale_factor())
        .unwrap_or(1.0);
    store.update(cx, |store, _| {
        store.resize_window(handle, f32::from(size.width), f32::from(size.height), scale);
    });
}

/// Shows or hides the menu bar of one window.
///
/// The set lives in a thread local rather than in `AppMenuGlobal` because a global
/// is handed out by shared reference and the attached `muda::Menu` on Windows
/// makes the state impossible to clone and replace. One set, one source of truth:
/// the inset and the JS getter both read it.
pub fn set_menu_bar_visible(window_id: u32, visible: bool) {
    HIDDEN_MENU_BARS.with(|hidden| {
        let mut hidden = hidden.borrow_mut();
        if visible {
            hidden.remove(&window_id);
        } else {
            hidden.insert(window_id);
        }
    });
}

pub struct MenuBar {
    #[allow(dead_code)]
    window_id: u32,
}

impl MenuBar {
    pub fn new(window_id: u32) -> Self {
        Self { window_id }
    }
}

/// Creates the menu bar and its activation observer, without touching the root.
///
/// Called from inside a `window.update` whose closure has already leased the
/// surface root, so this must not update the root: that panics with "cannot
/// update SurfaceRootView while it is already being updated". The observer is
/// registered on the menu bar entity (a fresh entity, safe to update here) and
/// its callback only dismisses the popup.
///
/// The observer closes a menu left up when the user moves on: clicking anywhere
/// outside the app, another window taking focus, or the app being backgrounded.
/// The popup is an override-redirect window on X11, so it never receives that
/// click itself and there is no global grab to catch it; window activation is
/// the signal that is actually delivered (an X11 `FocusOut` calls
/// `set_active(false)`, which runs these observers).
pub fn prepare(window: &mut gpui::Window, cx: &mut App, window_id: u32) -> Option<PreparedMenuBar> {
    if !should_use_gpui_menu_bar() {
        return None;
    }
    let menu_bar = cx.new(|_| MenuBar::new(window_id));
    let subscription = menu_bar.update(cx, |_menu_bar, cx| {
        cx.observe_window_activation(window, |_menu_bar, window, cx| {
            if window.is_window_active() {
                return;
            }
            // On Windows the popup (and any submenu) is its own top-level
            // window, so opening it can deactivate this one. Only dismiss once
            // activation has left the app entirely. The popup's activation can
            // arrive after this window's deactivation, so check a moment later.
            cx.spawn(async move |_menu_bar, cx| {
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(100))
                    .await;
                let _ = cx.update(|cx| {
                    if cx.active_window().is_none() {
                        let _ = MenuPopup::dismiss(cx);
                    }
                });
            })
            .detach();
        })
    });
    Some(PreparedMenuBar {
        menu_bar,
        subscription,
    })
}

/// The menu bar `prepare` built, handed to `attach` once the root is free.
pub struct PreparedMenuBar {
    pub menu_bar: gpui::Entity<MenuBar>,
    pub subscription: gpui::Subscription,
}

pub fn attach(
    cx: &mut App,
    root: &gpui::Entity<crate::store::SurfaceRootView>,
    prepared: PreparedMenuBar,
) {
    root.update(cx, |root, cx| {
        root.menu_bar = Some(prepared.menu_bar);
        root.menu_bar_activation_subscription = Some(prepared.subscription);
        cx.notify();
    });
}

pub fn menu_bar_entries(cx: &App) -> Vec<(String, Vec<MenuNode>)> {
    use crate::desktop::app_menu;
    use crate::desktop::menu_model::MenuRole;

    let model = app_menu::current_model(cx);
    let app_name = app_menu::app_name(cx);
    let dev_menu = crate::desktop::dev_menu::is_installed(cx);
    let mut titles: Vec<(String, Vec<MenuNode>)> = Vec::new();
    for node in &model.items {
        match node {
            MenuNode::StandardMenu(role) => {
                let label = match role {
                    MenuRole::AppMenu => app_name.clone(),
                    other => other.default_label().to_string(),
                };
                titles.push((
                    label,
                    app_menu::standard_menu_nodes(*role, &app_name, dev_menu),
                ));
            }
            MenuNode::Submenu(submenu) => {
                titles.push((submenu.label.clone(), submenu.items.clone()));
            }
            _ => {}
        }
    }
    titles
}

fn menu_bar_responder() -> Responder {
    Responder::callback(Box::new(|selection| {
        if let Some(id) = selection {
            if let Some(handler) = rn_gpui_sys::MENU_BAR_PERFORM_HANDLER.get() {
                handler(id);
            }
        }
    }))
}

/// Opens a top-level menu and makes it the one `PendingMenuGlobal` tracks.
///
/// The single place a root menu is opened: it first closes whatever menu is
/// already up, so a second open replaces the first instead of leaving its window
/// on screen, then records the new window so it can be closed or dismissed
/// later. A submenu (`depth > 0`) is opened with `open_menu_window` directly; it
/// belongs to the menu already up and must not close it.
fn open_tracked_menu(
    cx: &mut App,
    parent: gpui::AnyWindowHandle,
    anchor: (f32, f32),
    items: Vec<MenuNode>,
    responder: Responder,
) -> Result<gpui::AnyWindowHandle, String> {
    close_open_menu(cx);
    let window = open_menu_window(cx, parent, anchor, items.clone(), responder.clone(), 0)?;
    cx.set_global(PendingMenuGlobal(RefCell::new(Some(PendingMenu {
        window,
        items,
        responder,
    }))));
    Ok(window)
}

pub fn open_menu_bar_menu(cx: &mut App, title: &str) -> bool {
    let entries = menu_bar_entries(cx);
    let Some((_, items)) = entries.into_iter().find(|(label, _)| label == title) else {
        return false;
    };
    let (window, _) = match crate::desktop::context_menu::target_window(cx) {
        Ok(target) => target,
        Err(error) => {
            log::error!("[gpui-menu] {error}");
            return false;
        }
    };
    match open_tracked_menu(
        cx,
        window,
        (0.0, MENU_BAR_HEIGHT),
        items,
        menu_bar_responder(),
    ) {
        Ok(_) => true,
        Err(error) => {
            log::error!("[gpui-menu] {error}");
            false
        }
    }
}

impl Render for MenuBar {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let titles = menu_bar_entries(cx);
        let mut rows: Vec<gpui::AnyElement> = Vec::new();
        for (label, items) in titles {
            let id = label.clone();
            rows.push(
                gpui::div()
                    .id(SharedString::from(format!("menu-bar-{id}")))
                    .px_2()
                    .h(px(MENU_BAR_HEIGHT))
                    .flex()
                    .items_center()
                    .text_size(px(13.0))
                    .cursor_pointer()
                    .hover(|style| style.bg(gpui::rgba(0x00000014)))
                    .on_mouse_down(
                        gpui::MouseButton::Left,
                        cx.listener(move |this, event: &gpui::MouseDownEvent, window, cx| {
                            let parent: gpui::AnyWindowHandle = window.window_handle();
                            let responder = menu_bar_responder();
                            let anchor = (f32::from(event.position.x), f32::from(event.position.y));
                            let menu_items = items.clone();
                            let _ = this;
                            // Deferred, not opened here: this handler runs inside the
                            // menu-bar window's own update, and the popup's fallback
                            // reads the parent's bounds with `parent.update(...)`. A
                            // re-entrant update of the window already on the stack is
                            // refused and reported as `WindowRemoved` ("window not
                            // found"), so the menu never opened. Deferring runs after
                            // the effect cycle, when the window is off the stack.
                            cx.defer(move |cx| {
                                if let Err(error) =
                                    open_tracked_menu(cx, parent, anchor, menu_items, responder)
                                {
                                    log::error!("[gpui-menu] {error}");
                                }
                            });
                        }),
                    )
                    .child(label)
                    .into_any_element(),
            );
        }

        gpui::div()
            .id(SharedString::from("gpui-menu-bar"))
            .w_full()
            .h(px(MENU_BAR_HEIGHT))
            .flex()
            .flex_row()
            .items_center()
            .gap_0p5()
            .px_1()
            .bg(gpui::rgba(0xf4f5f7ff))
            .border_b_1()
            .border_color(gpui::rgba(0x00000022))
            .text_color(gpui::rgb(0x18212f))
            .child(
                gpui::div()
                    .text_size(px(11.0))
                    .text_color(gpui::rgba(0x00000055))
                    .px_1()
                    .child("‹window›"),
            )
            .children(rows)
    }
}

pub fn present(
    cx: &mut App,
    request: ContextMenuRequest,
    responder: Responder,
) -> Result<(), String> {
    open_tracked_menu(
        cx,
        request.window,
        (request.x, request.y),
        request.model.items,
        responder,
    )
    .map(|_| ())
}

/// Open one dropdown.
///
/// `AnchoredPopup` is the right window kind — the platform places it next to the
/// anchor and keeps it on screen — but macOS rejects it ("native popups are not
/// implemented on macOS yet"), so the fallback is a floating window placed at
/// the anchor's screen position. Linux (X11 and Wayland) and Windows take the
/// anchored path, which is what the plan asks for there.
fn open_menu_window(
    cx: &mut App,
    parent: gpui::AnyWindowHandle,
    anchor: (f32, f32),
    items: Vec<MenuNode>,
    responder: Responder,
    depth: usize,
) -> Result<gpui::AnyWindowHandle, String> {
    let (width, height) = popup_size(&MenuModel {
        items: items.clone(),
    });
    let popup_options = gpui::popup::PopupOptions {
        parent,
        anchor_rect: Bounds::new(point(px(anchor.0), px(anchor.1)), size(px(1.0), px(1.0))),
        anchor: if depth == 0 {
            gpui::popup::PopupAnchor::BottomLeft
        } else {
            gpui::popup::PopupAnchor::TopRight
        },
        gravity: gpui::popup::PopupGravity::BottomRight,
        constraint_adjustment: gpui::popup::PopupConstraintAdjustment::SLIDE_X
            | gpui::popup::PopupConstraintAdjustment::SLIDE_Y
            | gpui::popup::PopupConstraintAdjustment::FLIP_X
            | gpui::popup::PopupConstraintAdjustment::FLIP_Y,
        offset: point(px(0.0), px(0.0)),
        // Only the outermost menu grabs input; a submenu is dismissed with its
        // parent.
        grab: depth == 0,
    };
    let anchored_items = items.clone();
    let anchored_responder = responder.clone();
    let anchored = cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                point(px(0.0), px(0.0)),
                size(px(width), px(height)),
            ))),
            kind: WindowKind::AnchoredPopup(popup_options),
            is_resizable: false,
            ..Default::default()
        },
        move |_window, cx| cx.new(|_| MenuPopup::new(anchored_items, anchored_responder, depth)),
    );
    if let Ok(handle) = anchored {
        let window: gpui::AnyWindowHandle = handle.into();
        log::info!("[gpui-menu] anchored popup {window:?} ({width}x{height})");
        return Ok(window);
    }

    let origin = parent
        .update(cx, |_root: gpui::AnyView, window, _cx| {
            let bounds = window.bounds();
            (
                f32::from(bounds.origin.x) + anchor.0,
                f32::from(bounds.origin.y) + anchor.1,
            )
        })
        .map_err(|error| format!("the menu's window is gone: {error}"))?;
    let floating = cx
        .open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    point(px(origin.0), px(origin.1)),
                    size(px(width), px(height)),
                ))),
                kind: WindowKind::PopUp,
                is_resizable: false,
                ..Default::default()
            },
            move |_window, cx| cx.new(|_| MenuPopup::new(items, responder, depth)),
        )
        .map_err(|error| format!("could not open the menu popup: {error}"))?;
    let window: gpui::AnyWindowHandle = floating.into();
    log::info!("[gpui-menu] floating popup {window:?} at {origin:?}");
    Ok(window)
}

fn popup_size(model: &MenuModel) -> (f32, f32) {
    let mut rows = 0usize;
    let mut widest = 0usize;
    fn walk(items: &[MenuNode], rows: &mut usize, widest: &mut usize) {
        for node in items {
            *rows += 1;
            match node {
                MenuNode::Item(item) => {
                    let mut width = item.label.chars().count();
                    if let Some(accelerator) = &item.accelerator {
                        width += accelerator.chars().count() + 4;
                    }
                    *widest = (*widest).max(width);
                }
                MenuNode::Submenu(submenu) => {
                    *widest = (*widest).max(submenu.label.chars().count() + 2);
                }
                _ => {}
            }
        }
    }
    walk(&model.items, &mut rows, &mut widest);
    let width = (widest as f32 * 8.0 + PADDING * 2.0 + 28.0).clamp(MIN_WIDTH, MAX_WIDTH);
    let height = (rows as f32 * ROW_HEIGHT + PADDING * 2.0).max(ROW_HEIGHT);
    (width, height)
}

pub struct MenuPopup {
    items: Vec<MenuNode>,
    responder: Responder,
    depth: usize,
    /// Set when this popup resolved the request, so a parent popup does not
    /// resolve it a second time.
    resolved: bool,
}

impl MenuPopup {
    fn new(items: Vec<MenuNode>, responder: Responder, depth: usize) -> Self {
        Self {
            items,
            responder,
            depth,
            resolved: false,
        }
    }

    fn close(window: &mut Window) {
        window.remove_window();
    }

    fn choose(&mut self, id: &str, window: &mut Window, cx: &mut App) {
        if self.resolved {
            return;
        }
        self.resolved = true;
        self.responder.resolve(Some(id));
        self.forget_if_tracked(cx);
        Self::close(window);
    }

    /// Forgets the tracked root menu if this popup *is* it.
    ///
    /// Called from a root popup as it resolves so `PendingMenuGlobal` does not
    /// keep a removed window: a later `close_open_menu` would then try to update
    /// a window that is already gone, and `pending()` would report a menu that
    /// is no longer on screen. A submenu (`depth > 0`) is not the tracked window
    /// and leaves the root alone.
    fn forget_if_tracked(&self, cx: &mut App) {
        if self.depth != 0 {
            return;
        }
        if let Some(pending) = cx.try_global::<PendingMenuGlobal>() {
            *pending.0.borrow_mut() = None;
        }
    }

    pub fn pending(cx: &App) -> Option<(gpui::AnyWindowHandle, Vec<MenuNode>)> {
        cx.try_global::<PendingMenuGlobal>().and_then(|pending| {
            pending
                .0
                .borrow()
                .as_ref()
                .map(|menu| (menu.window, menu.items.clone()))
        })
    }

    pub fn select(cx: &mut App, id: &str) -> bool {
        let Some(pending) = cx.try_global::<PendingMenuGlobal>() else {
            return false;
        };
        let taken = pending.0.borrow_mut().take();
        let Some(menu) = taken else {
            return false;
        };
        menu.responder.resolve(Some(id));
        let _ = menu
            .window
            .update(cx, |_root, window, _cx| window.remove_window());
        true
    }

    pub fn dismiss(cx: &mut App) -> bool {
        let Some(pending) = cx.try_global::<PendingMenuGlobal>() else {
            return false;
        };
        let taken = pending.0.borrow_mut().take();
        let Some(menu) = taken else {
            return false;
        };
        menu.responder.resolve(None);
        let _ = menu
            .window
            .update(cx, |_root, window, _cx| window.remove_window());
        true
    }

    fn open_submenu(
        &self,
        items: Vec<MenuNode>,
        x: f32,
        y: f32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let parent: gpui::AnyWindowHandle = window.window_handle();
        let responder = self.responder.clone();
        let depth = self.depth + 1;
        // Deferred for the same reason as the menu bar's handler: this runs
        // inside the popup window's update, and the submenu's fallback reads the
        // parent's bounds with a re-entrant `parent.update(...)`.
        cx.defer(move |cx| {
            if let Err(error) = open_menu_window(cx, parent, (x, y), items, responder, depth) {
                log::error!("[gpui-menu] {error}");
            }
        });
    }
}

impl Render for MenuPopup {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let mut rows: Vec<gpui::AnyElement> = Vec::new();
        // One icon gives every row the same leading column, so the labels stay
        // aligned.
        let icon_column = self.items.iter().any(|node| match node {
            MenuNode::Item(item) => item.icon.is_some(),
            MenuNode::Submenu(submenu) => submenu.icon.is_some(),
            _ => false,
        });
        for (index, node) in self.items.clone().into_iter().enumerate() {
            match node {
                MenuNode::Separator => {
                    rows.push(
                        gpui::div()
                            .h(px(1.0))
                            .mx_2()
                            .my_1()
                            .bg(gpui::rgba(0x00000022))
                            .into_any_element(),
                    );
                }
                MenuNode::StandardMenu(_) => {}
                MenuNode::Item(item) => {
                    let id = item.id.clone();
                    let enabled = item.enabled;
                    // A stable id is what gives the row a hitbox: without it the
                    // `hover` style has no state to key on and only ever applied
                    // to the first row the pointer entered.
                    let mut row = gpui::div()
                        .id(SharedString::from(format!("menu-item-{id}")))
                        .flex()
                        .flex_row()
                        .items_center()
                        .justify_between()
                        .gap_4()
                        .px_2()
                        .h(px(ROW_HEIGHT))
                        .text_size(px(13.0))
                        .child(
                            gpui::div()
                                .flex()
                                .flex_row()
                                .items_center()
                                .gap_1()
                                .child(leading(item.checked, item.icon.as_deref(), icon_column))
                                .child(item.label.clone()),
                        )
                        .child(
                            gpui::div()
                                .text_color(gpui::rgba(0x00000088))
                                .child(item.accelerator.clone().unwrap_or_default()),
                        );
                    if !enabled {
                        row = row.text_color(gpui::rgba(0x00000066));
                    } else {
                        row = row
                            .cursor_pointer()
                            .hover(|style| style.bg(gpui::rgba(0x00000011)))
                            .on_mouse_down(
                                gpui::MouseButton::Left,
                                cx.listener(move |this, _event, window, cx| {
                                    this.choose(&id, window, cx);
                                }),
                            );
                    }
                    let _ = index;
                    rows.push(row.into_any_element());
                }
                MenuNode::Submenu(submenu) => {
                    let items = submenu.items.clone();
                    let enabled = submenu.enabled;
                    // An id for the same reason as a menu item's row: the hover
                    // style needs a hitbox to track.
                    let mut row = gpui::div()
                        .id(SharedString::from(format!(
                            "menu-submenu-{}",
                            submenu.label
                        )))
                        .flex()
                        .flex_row()
                        .items_center()
                        .justify_between()
                        .px_2()
                        .h(px(ROW_HEIGHT))
                        .text_size(px(13.0))
                        .child(
                            gpui::div()
                                .flex()
                                .flex_row()
                                .items_center()
                                .gap_1()
                                .when(icon_column, |label| {
                                    label.child(leading(false, submenu.icon.as_deref(), true))
                                })
                                .child(submenu.label.clone()),
                        )
                        .child("›");
                    if enabled {
                        row = row
                            .cursor_pointer()
                            .hover(|style| style.bg(gpui::rgba(0x00000011)))
                            .on_mouse_down(
                                gpui::MouseButton::Left,
                                cx.listener(
                                    move |this, event: &gpui::MouseDownEvent, window, cx| {
                                        this.open_submenu(
                                            items.clone(),
                                            f32::from(event.position.x),
                                            f32::from(event.position.y),
                                            window,
                                            cx,
                                        );
                                    },
                                ),
                            );
                    }
                    rows.push(row.into_any_element());
                }
            }
        }

        let responder = self.responder.clone();
        let resolved = self.resolved;
        let depth = self.depth;
        let _ = window;

        gpui::div()
            .flex()
            .flex_col()
            .py(px(PADDING))
            .bg(gpui::white())
            .border_1()
            .border_color(gpui::rgba(0x00000033))
            .rounded(px(6.0))
            .shadow_md()
            .text_color(gpui::rgb(0x18212f))
            .on_key_down(move |event, window, cx| {
                if event.keystroke.key == "escape" {
                    if !resolved {
                        responder.resolve(None);
                    }
                    // A root popup is the one `PendingMenuGlobal` tracks; clear
                    // it so a later open/dismiss does not touch a removed window.
                    if depth == 0 {
                        if let Some(pending) = cx.try_global::<PendingMenuGlobal>() {
                            *pending.0.borrow_mut() = None;
                        }
                    }
                    window.remove_window();
                }
            })
            .children(rows)
    }
}

const ICON_SIZE: f32 = 16.0;

/// The slot before a row's label: its check mark, else its icon. With
/// `icon_column` the slot is icon-wide on every row.
fn leading(checked: bool, icon: Option<&str>, icon_column: bool) -> gpui::AnyElement {
    let image = (!checked)
        .then(|| icon.and_then(crate::desktop::icon::cached))
        .flatten()
        .and_then(|icon| icon.image.clone());
    if !icon_column {
        return gpui::div()
            .child(if checked { "✓" } else { " " })
            .into_any_element();
    }
    let slot = gpui::div()
        .flex()
        .items_center()
        .justify_center()
        .size(px(ICON_SIZE));
    match image {
        Some(image) => slot
            .child(gpui::img(image).size(px(ICON_SIZE)))
            .into_any_element(),
        None => slot
            .child(if checked { "✓" } else { "" })
            .into_any_element(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desktop::menu_model;
    use serde_json::json;

    #[test]
    fn hiding_one_windows_bar_leaves_the_others_alone() {
        // The inset is per window: a hidden bar in one window must not shrink
        // another window's surface, which is why this is a set of ids rather than
        // one flag.
        set_menu_bar_visible(7, false);
        assert!(menu_bar_hidden(7));
        assert!(!menu_bar_hidden(8));
        set_menu_bar_visible(7, true);
        assert!(!menu_bar_hidden(7));
    }

    #[test]
    fn the_inset_follows_the_windows_own_visibility() {
        // Both ids are put into a known state first: the hidden set is process
        // wide, so another test may have hidden either of them already.
        set_menu_bar_visible(9, true);
        set_menu_bar_visible(10, true);

        set_menu_bar_visible(9, false);
        assert_eq!(menu_bar_inset_for_window_id(9), 0.0);
        assert_eq!(
            menu_bar_inset_for_window_id(10),
            if should_use_gpui_menu_bar() {
                MENU_BAR_HEIGHT
            } else {
                0.0
            },
            "hiding one window's bar must not shrink another window",
        );
        set_menu_bar_visible(9, true);
    }

    #[test]
    fn popup_size_grows_with_the_items() {
        let one = menu_model::parse_menu(&json!([{"id": "a", "label": "A"}])).expect("valid");
        let two = menu_model::parse_menu(&json!([
            {"id": "a", "label": "A"},
            {"type": "separator"},
            {"id": "b", "label": "B"}
        ]))
        .expect("valid");
        let (_, one_height) = popup_size(&one);
        let (_, two_height) = popup_size(&two);
        assert!(two_height > one_height);
    }

    #[test]
    fn popup_width_is_clamped() {
        let wide = menu_model::parse_menu(&json!([{
            "id": "a",
            "label": "a very long label that would otherwise make the popup enormous indeed"
        }]))
        .expect("valid");
        let (width, _) = popup_size(&wide);
        assert_eq!(width, MAX_WIDTH);
    }

    #[test]
    fn the_edit_menu_spells_out_its_roles() {
        let nodes = crate::desktop::app_menu::standard_menu_nodes(
            crate::desktop::menu_model::MenuRole::EditMenu,
            "Tester",
            false,
        );
        let ids: Vec<String> = nodes
            .iter()
            .filter_map(|node| match node {
                MenuNode::Item(item) => Some(item.id.clone()),
                _ => None,
            })
            .collect();
        assert!(ids.contains(&"role:copy".to_string()));
        assert!(ids.contains(&"role:selectAll".to_string()));
        let copy = nodes
            .iter()
            .find_map(|node| match node {
                MenuNode::Item(item) if item.id == "role:copy" => Some(item.clone()),
                _ => None,
            })
            .expect("copy is in the Edit menu");
        assert_eq!(copy.accelerator.as_deref(), Some("secondary-c"));
    }

    #[test]
    fn the_app_menu_is_labelled_with_the_app_name() {
        let nodes = crate::desktop::app_menu::standard_menu_nodes(
            crate::desktop::menu_model::MenuRole::AppMenu,
            "Tester",
            false,
        );
        let about = nodes
            .iter()
            .find_map(|node| match node {
                MenuNode::Item(item)
                    if item.role == Some(crate::desktop::menu_model::MenuRole::About) =>
                {
                    Some(item.label.clone())
                }
                _ => None,
            })
            .expect("the app menu has About");
        assert_eq!(about, "About Tester");
    }

    #[test]
    fn the_help_menu_only_grows_a_developer_group_in_a_dev_build() {
        use crate::desktop::menu_model::MenuRole;
        let without = crate::desktop::app_menu::standard_menu_nodes(MenuRole::HelpMenu, "T", false);
        assert!(without.is_empty());
        let with = crate::desktop::app_menu::standard_menu_nodes(MenuRole::HelpMenu, "T", true);
        assert_eq!(with.len(), 1);
        match &with[0] {
            MenuNode::Submenu(submenu) => {
                assert_eq!(submenu.label, "Developer");
                assert_eq!(submenu.items.len(), 5);
            }
            other => panic!("expected a submenu, got {other:?}"),
        }
    }

    #[test]
    fn the_menu_bar_inset_follows_the_mode() {
        std::env::set_var("RN_GPUI_MENU_BAR", "gpui");
        assert_eq!(menu_bar_inset(), MENU_BAR_HEIGHT);
        std::env::set_var("RN_GPUI_MENU_BAR", "native");
        assert_eq!(menu_bar_inset(), 0.0);
        std::env::remove_var("RN_GPUI_MENU_BAR");
    }

    #[test]
    fn the_mode_follows_the_environment() {
        std::env::set_var("RN_GPUI_CONTEXT_MENU", "gpui");
        assert!(should_use_gpui());
        std::env::set_var("RN_GPUI_CONTEXT_MENU", "native");
        assert!(!should_use_gpui());
        std::env::remove_var("RN_GPUI_CONTEXT_MENU");
    }
}
