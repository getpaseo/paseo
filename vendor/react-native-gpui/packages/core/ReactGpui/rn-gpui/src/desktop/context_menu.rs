use crate::desktop::errors::DesktopError;
use crate::desktop::menu_model::{self, MenuModel, MenuNode};
use crate::desktop::windows::DesktopWindowsGlobal;
use gpui::{AnyWindowHandle, App};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::rc::Rc;

pub struct ContextMenuRequest {
    pub window: AnyWindowHandle,
    pub x: f32,
    pub y: f32,
    pub model: MenuModel,
    pub native_view: isize,
}

/// Settles one context menu: the module's promise, or a caller's callback.
#[derive(Clone)]
pub enum Responder {
    Desktop { reply: Rc<RefCell<Option<Reply>>> },
    Callback(Rc<RefCell<Option<Box<dyn FnMut(Option<String>)>>>>),
}

/// Answers the promise a `contextMenuShow` call is waiting on.
pub type Reply = futures::channel::oneshot::Sender<Result<serde_json::Value, DesktopError>>;

impl Responder {
    pub fn desktop(reply: Reply) -> Self {
        Self::Desktop {
            reply: Rc::new(RefCell::new(Some(reply))),
        }
    }

    pub fn callback(callback: Box<dyn FnMut(Option<String>)>) -> Self {
        Self::Callback(Rc::new(RefCell::new(Some(callback))))
    }

    pub fn resolve(&self, selection: Option<&str>) {
        match self {
            Self::Desktop { reply } => {
                if let Some(reply) = reply.borrow_mut().take() {
                    let _ = reply.send(Ok(json!({"id": selection})));
                }
            }
            Self::Callback(callback) => {
                if let Some(mut callback) = callback.borrow_mut().take() {
                    callback(selection.map(str::to_string));
                }
            }
        }
    }

    pub fn reject(&self, error: DesktopError) {
        match self {
            Self::Desktop { reply } => {
                if let Some(reply) = reply.borrow_mut().take() {
                    let _ = reply.send(Err(error));
                }
            }
            Self::Callback(callback) => {
                if let Some(mut callback) = callback.borrow_mut().take() {
                    callback(None);
                }
            }
        }
    }
}

pub fn target_window(cx: &mut App) -> Result<(AnyWindowHandle, isize), DesktopError> {
    let window = cx
        .active_window()
        .or_else(|| {
            cx.global::<DesktopWindowsGlobal>()
                .0
                .get(crate::desktop::windows::MAIN_WINDOW_KEY)
                .map(|entry| entry.handle)
        })
        .ok_or_else(|| DesktopError::failed("no window for the context menu"))?;
    let native_view = native_view_of(cx, window);
    Ok((window, native_view))
}

pub trait ContextMenuPresenter: 'static {
    fn show(&self, cx: &mut App, request: ContextMenuRequest, responder: Responder);

    fn name(&self) -> &'static str;
}

pub struct ContextMenuPresenterGlobal(pub Rc<dyn ContextMenuPresenter>);
impl gpui::Global for ContextMenuPresenterGlobal {}

pub fn install(cx: &mut App) {
    let fake = cfg!(feature = "test-driver")
        && std::env::var("RN_GPUI_TEST_FAKE_NATIVE_UI").as_deref() == Ok("1");
    if fake {
        let fake = Rc::new(FakeContextMenu::new());
        cx.set_global(FakeContextMenuGlobal(fake.clone()));
        cx.set_global(ContextMenuPresenterGlobal(fake));
    } else if crate::desktop::gpui_menu::should_use_gpui() {
        cx.set_global(ContextMenuPresenterGlobal(Rc::new(GpuiContextMenu)));
    } else {
        cx.set_global(ContextMenuPresenterGlobal(Rc::new(NativeContextMenu)));
    }
}

/// Answers through `reply` when the menu closes.
pub fn show(
    cx: &mut App,
    items: Value,
    x: Option<f64>,
    y: Option<f64>,
    window_id: Option<u32>,
    responder: Responder,
) -> Result<(), DesktopError> {
    let model = menu_model::parse_menu(&items)?;
    let window = match window_id {
        Some(key) => cx
            .global::<DesktopWindowsGlobal>()
            .0
            .get(key)
            .map(|entry| entry.handle)
            .ok_or_else(|| DesktopError::not_found(format!("window {key} is not open")))?,
        // A hidden or off-screen window is not the platform's active window, so
        // fall back to the main window rather than failing.
        None => cx
            .active_window()
            .or_else(|| {
                cx.global::<DesktopWindowsGlobal>()
                    .0
                    .get(crate::desktop::windows::MAIN_WINDOW_KEY)
                    .map(|entry| entry.handle)
            })
            .ok_or_else(|| DesktopError::failed("no window for the context menu"))?,
    };
    let native_view = native_view_of(cx, window);
    let (x, y) = match (x, y) {
        (Some(x), Some(y)) => (x as f32, y as f32),
        _ => cursor_position(cx, window),
    };
    let request = ContextMenuRequest {
        window,
        x,
        y,
        model,
        native_view,
    };
    let presenter = cx.global::<ContextMenuPresenterGlobal>().0.clone();
    presenter.show(cx, request, responder);
    Ok(())
}

/// Presents an already-parsed model at a position in a known window.
///
/// The split exists for the native `ContextMenuView`, which parses its own props
/// before it gets here and knows which window the press arrived in. Sharing the
/// tail means the JS command and the native path cannot disagree about which
/// window hosts the menu or how the platform view is found.
pub fn present(
    cx: &mut App,
    model: MenuModel,
    window: AnyWindowHandle,
    position: (f32, f32),
    responder: Responder,
) {
    let request = ContextMenuRequest {
        window,
        x: position.0,
        y: position.1,
        model,
        native_view: native_view_of(cx, window),
    };
    let presenter = cx.global::<ContextMenuPresenterGlobal>().0.clone();
    presenter.show(cx, request, responder);
}

fn native_view_of(cx: &mut App, window: AnyWindowHandle) -> isize {
    window
        .update(cx, |_root, window, _cx| raw_view(window))
        .unwrap_or(0)
}

#[cfg(target_os = "macos")]
fn raw_view(window: &gpui::Window) -> isize {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    match HasWindowHandle::window_handle(window) {
        Ok(handle) => match handle.as_raw() {
            RawWindowHandle::AppKit(appkit) => appkit.ns_view.as_ptr() as isize,
            _ => 0,
        },
        Err(_) => 0,
    }
}

#[cfg(target_os = "windows")]
fn raw_view(window: &gpui::Window) -> isize {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    match HasWindowHandle::window_handle(window) {
        Ok(handle) => match handle.as_raw() {
            RawWindowHandle::Win32(win32) => win32.hwnd.get() as isize,
            _ => 0,
        },
        Err(_) => 0,
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn raw_view(_window: &gpui::Window) -> isize {
    0
}

fn cursor_position(cx: &mut App, window: AnyWindowHandle) -> (f32, f32) {
    window
        .update(cx, |_root, window, _cx| {
            let position = window.mouse_position();
            (f32::from(position.x), f32::from(position.y))
        })
        .unwrap_or((0.0, 0.0))
}

struct NativeContextMenu;

impl ContextMenuPresenter for NativeContextMenu {
    fn name(&self) -> &'static str {
        "native"
    }

    fn show(&self, cx: &mut App, request: ContextMenuRequest, responder: Responder) {
        // The native call runs a modal tracking loop, so it is deferred: GPUI
        // must not be inside an update while the menu is open.
        cx.defer(move |_cx| {
            if let Err(error) = native_show(&request, &responder) {
                responder.reject(error);
            }
        });
    }
}

struct GpuiContextMenu;

impl ContextMenuPresenter for GpuiContextMenu {
    fn name(&self) -> &'static str {
        "gpui"
    }

    fn show(&self, cx: &mut App, request: ContextMenuRequest, responder: Responder) {
        if let Err(error) = crate::desktop::gpui_menu::present(cx, request, responder.clone()) {
            responder.reject(DesktopError::failed(error));
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn native_show(request: &ContextMenuRequest, responder: &Responder) -> Result<(), DesktopError> {
    use muda::ContextMenu as _;

    let menu = muda::Menu::new();
    build_muda_menu(&menu, &request.model.items)?;
    let position = muda::dpi::Position::Logical(muda::dpi::LogicalPosition::new(
        f64::from(request.x),
        f64::from(request.y),
    ));
    if request.native_view == 0 {
        return Err(DesktopError::failed(
            "the window has no platform view for a context menu",
        ));
    }
    // `muda` has one event channel and the app installs a handler on it (the
    // menu bar and the tray both need one), so a handler-displaced receiver
    // would never see this selection. `with_context_menu` reserves the channel
    // for the duration of the menu instead, and `show` blocks until the menu
    // closes, so the id is already in hand when it returns.
    let selection = crate::desktop::menu_events::with_context_menu(|| {
        #[cfg(target_os = "macos")]
        // SAFETY: `request.native_view` is the live `NSView` the request was made for, and this runs on the main thread.
        unsafe {
            menu.show_context_menu_for_nsview(
                request.native_view as *const std::ffi::c_void,
                Some(position),
            )
        };
        #[cfg(target_os = "windows")]
        // SAFETY: `request.native_view` is the live `HWND` the request was made for, and this runs on the window's thread.
        unsafe {
            menu.show_context_menu_for_hwnd(request.native_view, Some(position))
        };
    });
    responder.resolve(selection.as_deref());
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn native_show(_request: &ContextMenuRequest, _responder: &Responder) -> Result<(), DesktopError> {
    Err(DesktopError::unsupported(
        "native context menus are not implemented on this platform yet",
    ))
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
/// `Menu` and `Submenu` both append items, but the `ContextMenu` trait does not
/// cover it, so builders (context menus and the Windows menu bar) are generic
/// over this.
pub(crate) trait MudaAppend {
    fn append_all(&self, items: &[&dyn muda::IsMenuItem]) -> muda::Result<()>;
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
impl MudaAppend for muda::Menu {
    fn append_all(&self, items: &[&dyn muda::IsMenuItem]) -> muda::Result<()> {
        self.append_items(items)
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
impl MudaAppend for muda::Submenu {
    fn append_all(&self, items: &[&dyn muda::IsMenuItem]) -> muda::Result<()> {
        self.append_items(items)
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn build_muda_menu(menu: &impl MudaAppend, items: &[MenuNode]) -> Result<(), DesktopError> {
    use muda::{CheckMenuItem, IconMenuItem, MenuItem, PredefinedMenuItem, Submenu};

    let mut children: Vec<Box<dyn muda::IsMenuItem>> = Vec::new();
    for node in items {
        match node {
            MenuNode::Separator => {
                children.push(Box::new(PredefinedMenuItem::separator()));
            }
            MenuNode::StandardMenu(_) => {}
            MenuNode::Item(item) => {
                if item.checked {
                    children.push(Box::new(CheckMenuItem::with_id(
                        item.id.clone(),
                        item.label.clone(),
                        item.enabled,
                        true,
                        None,
                    )));
                } else if let Some(icon) = item.icon.as_deref().and_then(muda_icon) {
                    children.push(Box::new(IconMenuItem::with_id(
                        item.id.clone(),
                        item.label.clone(),
                        item.enabled,
                        Some(icon),
                        None,
                    )));
                } else {
                    children.push(Box::new(MenuItem::with_id(
                        item.id.clone(),
                        item.label.clone(),
                        item.enabled,
                        None,
                    )));
                }
            }
            MenuNode::Submenu(submenu) => {
                let child = Submenu::new(submenu.label.clone(), submenu.enabled);
                build_muda_menu(&child, &submenu.items)?;
                children.push(Box::new(child));
            }
        }
    }
    let refs: Vec<&dyn muda::IsMenuItem> = children.iter().map(|item| item.as_ref()).collect();
    menu.append_all(&refs)
        .map_err(|error| DesktopError::failed(format!("could not build the context menu: {error}")))
}

/// A menu item's icon, if `desktop::icon` has loaded it.
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub(crate) fn muda_icon(uri: &str) -> Option<muda::Icon> {
    let icon = crate::desktop::icon::cached(uri)?;
    muda::Icon::from_rgba(icon.rgba.clone(), icon.width, icon.height).ok()
}

pub struct FakeContextMenu {
    state: RefCell<FakeContextMenuState>,
}

#[derive(Default)]
struct FakeContextMenuState {
    model: Option<Value>,
    responder: Option<Responder>,
    position: (f32, f32),
    shown: u32,
}

pub struct FakeContextMenuGlobal(pub Rc<FakeContextMenu>);
impl gpui::Global for FakeContextMenuGlobal {}

impl FakeContextMenu {
    pub fn new() -> Self {
        Self {
            state: RefCell::new(FakeContextMenuState::default()),
        }
    }
}

impl ContextMenuPresenter for FakeContextMenu {
    fn name(&self) -> &'static str {
        "fake"
    }

    fn show(&self, _cx: &mut App, request: ContextMenuRequest, responder: Responder) {
        let mut state = self.state.borrow_mut();
        // A second show dismisses the first with `null`.
        if let Some(previous) = state.responder.take() {
            previous.resolve(None);
        }
        state.model = Some(json!({"items": nodes_json(&request.model.items)}));
        state.position = (request.x, request.y);
        state.shown += 1;
        state.responder = Some(responder);
    }
}

pub fn nodes_json(items: &[MenuNode]) -> Vec<Value> {
    items
        .iter()
        .map(|node| match node {
            MenuNode::Separator => json!({"type": "separator"}),
            MenuNode::StandardMenu(role) => json!({"type": "role", "role": format!("{role:?}")}),
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
                "enabled": item.enabled,
                "checked": item.checked,
                "icon": item.icon,
                "iconLoaded": item
                    .icon
                    .as_deref()
                    .is_some_and(|uri| crate::desktop::icon::cached(uri).is_some()),
            }),
        })
        .collect()
}

pub fn presenter_name(cx: &App) -> &'static str {
    cx.try_global::<ContextMenuPresenterGlobal>()
        .map(|presenter| presenter.0.name())
        .unwrap_or("none")
}

pub fn fake_model(cx: &App) -> Option<Value> {
    let fake = cx.try_global::<FakeContextMenuGlobal>()?;
    let state = fake.0.state.borrow();
    Some(json!({
        "items": state.model.as_ref().and_then(|value| value.get("items")).cloned().unwrap_or(Value::Null),
        "x": state.position.0,
        "y": state.position.1,
        "shown": state.shown,
    }))
}

pub fn fake_select(cx: &App, id: &str) -> bool {
    let Some(fake) = cx.try_global::<FakeContextMenuGlobal>() else {
        return false;
    };
    let responder = fake.0.state.borrow_mut().responder.take();
    match responder {
        Some(responder) => {
            responder.resolve(Some(id));
            true
        }
        None => false,
    }
}

pub fn fake_dismiss(cx: &App) -> bool {
    let Some(fake) = cx.try_global::<FakeContextMenuGlobal>() else {
        return false;
    };
    let responder = fake.0.state.borrow_mut().responder.take();
    match responder {
        Some(responder) => {
            responder.resolve(None);
            true
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rejects_a_malformed_model_before_presenting() {
        let error = menu_model::parse_menu(&json!([{"id": "a"}])).expect_err("label is required");
        assert_eq!(error.code, crate::desktop::errors::codes::INVALID_ARGUMENT);
    }

    #[test]
    fn nodes_json_keeps_ids_and_checks() {
        let model = menu_model::parse_menu(&json!([
            {"id": "open", "label": "Open"},
            {"type": "separator"},
            {"id": "pin", "label": "Pin", "checked": true}
        ]))
        .expect("valid");
        let value = nodes_json(&model.items);
        assert_eq!(value.len(), 3);
        assert_eq!(value[2]["checked"], json!(true));
    }
}
