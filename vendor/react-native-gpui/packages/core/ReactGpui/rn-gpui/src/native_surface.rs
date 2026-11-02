//! A native view inside a React Native tree, on every platform.

use anyhow::Context as _;
use gpui::{
    relative, App, Bounds, Element, ElementId, GlobalElementId, IntoElement, LayoutId, Style,
    Window, WindowCompositionSurface,
};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

pub use anyhow::Result;

/// What a native view factory is given when a view is created.
pub struct NativeViewContext {
    /// The `nativeProps` JSON of the `NativeViewHost`, parsed.
    pub native_props: Value,
}

/// A package's factory for one kind of native view.
pub trait NativeViewFactory: Send + Sync + 'static {
    fn create_view(&self, context: &NativeViewContext) -> Result<NativeViewHandle>;
}

/// One native view, as a factory hands it back.
#[derive(Clone, Copy, Debug)]
pub struct NativeViewHandle {
    #[cfg(target_os = "macos")]
    view: usize,
    #[cfg(target_os = "windows")]
    hwnd: isize,
    #[cfg(target_os = "linux")]
    window: u32,
}

impl NativeViewHandle {
    /// Transfer one owned `NSView` reference to the runtime. The view must have
    /// been created with AppKit's `alloc`/`init` convention and remain valid
    /// until the runtime releases it when the Fabric node unmounts.
    #[cfg(target_os = "macos")]
    ///
    /// # Safety
    ///
    /// `view` must be an owned `NSView` reference, created with `alloc`/`init`, that stays valid until the runtime releases it.
    pub unsafe fn from_owned_nsview(view: *mut std::ffi::c_void) -> Self {
        Self {
            view: view as usize,
        }
    }

    /// Transfer an `HWND` to the runtime. The factory keeps ownership and is
    /// responsible for destroying the window.
    #[cfg(target_os = "windows")]
    pub fn from_hwnd(hwnd: isize) -> Self {
        Self { hwnd }
    }

    /// Transfer an X11 window id to the runtime. The factory keeps ownership
    /// and is responsible for destroying the window.
    #[cfg(target_os = "linux")]
    pub fn from_x11_window(window: u32) -> Self {
        Self { window }
    }

    /// Whether the handle is null, on any platform.
    pub fn is_null(&self) -> bool {
        #[cfg(target_os = "macos")]
        {
            self.view == 0
        }
        #[cfg(target_os = "windows")]
        {
            self.hwnd == 0
        }
        #[cfg(target_os = "linux")]
        {
            self.window == 0
        }
    }
}

#[derive(Clone, Default)]
struct NativeViewFactories(Arc<Mutex<HashMap<String, Arc<dyn NativeViewFactory>>>>);

impl gpui::Global for NativeViewFactories {}

/// Registers a factory under `name`, which a `NativeViewHost`'s `viewName`
/// selects. Registering the same name twice replaces the factory.
pub fn register_native_view_factory(
    cx: &mut App,
    name: impl Into<String>,
    factory: impl NativeViewFactory,
) {
    let registry = if let Some(registry) = cx.try_global::<NativeViewFactories>() {
        registry.clone()
    } else {
        let registry = NativeViewFactories::default();
        cx.set_global(registry.clone());
        registry
    };
    registry
        .0
        .lock()
        .expect("native view registry poisoned")
        .insert(name.into(), Arc::new(factory));
}

/// Whether a factory is registered under `name`.
pub fn has_native_view_factory(cx: &App, name: &str) -> bool {
    cx.try_global::<NativeViewFactories>()
        .is_some_and(|registry| {
            registry
                .0
                .lock()
                .expect("native view registry poisoned")
                .contains_key(name)
        })
}

/// What a [`NativeSurface`] is created from: a registered factory, or a view
/// the caller already made.
pub enum NativeSurfaceContent {
    /// Look the view up in the factory registry by name.
    Factory {
        name: String,
        /// The `nativeProps` JSON handed to the factory; empty means `null`.
        props: String,
    },
    /// Use a view the caller already created.
    Handle(NativeViewHandle),
}

/// A native view attached to a window's composition surface.
pub struct NativeSurface {
    surface: WindowCompositionSurface,
    view: NativeViewHandle,
    last_bounds: std::cell::Cell<Option<Bounds<gpui::DevicePixels>>>,
    visible: std::cell::Cell<bool>,
}

impl NativeSurface {
    /// Creates the composition surface and attaches the view to it.
    pub fn create(content: NativeSurfaceContent, window: &Window, cx: &App) -> Result<Self> {
        let surface = window
            .enable_window_composition()?
            .create_native_surface()?;
        let view = match content {
            NativeSurfaceContent::Factory { name, props } => {
                let registry = cx
                    .try_global::<NativeViewFactories>()
                    .context("no native view factories have been registered")?;
                let factory = registry
                    .0
                    .lock()
                    .expect("native view registry poisoned")
                    .get(&name)
                    .cloned()
                    .with_context(|| format!("no NativeViewFactory is registered for '{name}'"))?;
                let native_props = if props.is_empty() {
                    Value::Null
                } else {
                    serde_json::from_str(&props).context("parsing NativeViewHost nativeProps")?
                };
                let handle = factory.create_view(&NativeViewContext { native_props })?;
                anyhow::ensure!(
                    !handle.is_null(),
                    "NativeViewFactory '{name}' returned a null view"
                );
                handle
            }
            NativeSurfaceContent::Handle(handle) => {
                anyhow::ensure!(
                    !handle.is_null(),
                    "NativeSurfaceContent::Handle was given a null view"
                );
                handle
            }
        };
        let surface = Self {
            surface,
            view,
            last_bounds: std::cell::Cell::new(None),
            visible: std::cell::Cell::new(true),
        };
        imp::attach(&surface.surface, view)?;
        log::info!("[native-surface] attached native view");
        Ok(surface)
    }

    /// The macOS `NSView` this surface hosts.
    #[cfg(target_os = "macos")]
    pub fn macos_view(&self) -> *mut std::ffi::c_void {
        self.view.view as *mut std::ffi::c_void
    }

    /// The Windows composition visual this surface hosts: the `IUnknown` the
    /// attachment returned, ready to cast to `IDCompositionVisual3`.
    #[cfg(target_os = "windows")]
    pub fn windows_visual(&self) -> Result<Box<dyn std::any::Any>> {
        self.surface.platform_surface()?.platform_handle()
    }

    /// The Linux `RawWindowHandle` of the surface the view presents into.
    #[cfg(target_os = "linux")]
    pub fn raw_window_handle(&self) -> Result<Box<dyn std::any::Any>> {
        self.surface.platform_surface()?.platform_handle()
    }

    /// The platform view, as the factory returned it.
    pub fn view(&self) -> NativeViewHandle {
        self.view
    }

    /// Places the native view at `bounds`, in the window's pixels.
    pub fn set_bounds(&self, bounds: Bounds<gpui::Pixels>, scale_factor: f32) -> Result<()> {
        let device_bounds = bounds.to_device_pixels(scale_factor);
        if self.last_bounds.get() != Some(device_bounds) {
            self.last_bounds.set(Some(device_bounds));
        }
        self.surface
            .platform_surface()?
            .set_bounds(device_bounds)
            .context("setting native view composition bounds")
    }

    /// Whether the native view participates in composition.
    pub fn set_visible(&self, visible: bool) -> Result<()> {
        if self.visible.get() == visible {
            return Ok(());
        }
        self.visible.set(visible);
        self.surface
            .platform_surface()?
            .set_visible(visible)
            .context("setting native view visibility")
    }

    /// The bounds last sent, in device pixels.
    pub fn last_bounds(&self) -> Option<Bounds<gpui::DevicePixels>> {
        self.last_bounds.get()
    }

    /// Whether the surface is currently told to participate in composition.
    pub fn is_visible(&self) -> bool {
        self.visible.get()
    }
}

impl Drop for NativeSurface {
    fn drop(&mut self) {
        imp::detach(self.view);
    }
}

/// The one genuinely platform-specific step: putting the view into the
/// composition surface's container, and taking it out again.
mod imp {
    use super::*;

    #[cfg(target_os = "macos")]
    pub(super) fn attach(surface: &WindowCompositionSurface, view: NativeViewHandle) -> Result<()> {
        use cocoa::{
            appkit::{NSViewHeightSizable, NSViewWidthSizable},
            base::id,
            foundation::{NSPoint, NSRect, NSSize},
        };
        use objc::{msg_send, sel, sel_impl};
        let container = surface
            .platform_surface()?
            .platform_handle()?
            .downcast::<usize>()
            .map(|handle| *handle as id)
            .map_err(|_| anyhow::anyhow!("native composition surface is not an AppKit view"))?;
        let view = view.view as id;
        // SAFETY: `view` is the owned `NSView` the factory returned, and `container` is the live composition surface view; both are used on the main thread.
        unsafe {
            let _: () =
                msg_send![view, setAutoresizingMask: NSViewWidthSizable | NSViewHeightSizable];
            let _: () = msg_send![
                view,
                setFrame: NSRect::new(NSPoint::new(0., 0.), NSSize::new(0., 0.))
            ];
            let _: () = msg_send![container, addSubview: view];
        }
        Ok(())
    }

    #[cfg(target_os = "macos")]
    pub(super) fn detach(view: NativeViewHandle) {
        use cocoa::{appkit::NSView, base::id};
        use objc::{msg_send, sel, sel_impl};
        let view = view.view as id;
        // SAFETY: `view` is the owned `NSView` attached by `attach`; it is detached and released once, on drop.
        unsafe {
            NSView::removeFromSuperview(view);
            let _: () = msg_send![view, release];
        }
    }

    /// Windows: the view is a child window, and DirectComposition's clip and
    /// offset already place it. The factory owns the `HWND`; the runtime only
    /// styles it as a child and hides it when the surface does.
    #[cfg(target_os = "windows")]
    pub(super) fn attach(
        _surface: &WindowCompositionSurface,
        view: NativeViewHandle,
    ) -> Result<()> {
        use windows_sys::Win32::{
            Foundation::HWND,
            UI::WindowsAndMessaging::{GetWindowLongW, SetWindowLongW, GWL_STYLE, WS_CHILD},
        };
        let hwnd = view.hwnd as HWND;
        // SAFETY: the factory keeps the `HWND` alive for the surface's lifetime.
        unsafe {
            let style = GetWindowLongW(hwnd, GWL_STYLE);
            SetWindowLongW(hwnd, GWL_STYLE, style | WS_CHILD as i32);
        }
        Ok(())
    }

    #[cfg(target_os = "windows")]
    pub(super) fn detach(_view: NativeViewHandle) {}

    /// Linux: on X11 the view is a child window of the composition surface's
    /// window, so X clips and moves it with the surface; on Wayland the surface
    /// is a subsurface the producer presents into directly. Neither needs the
    /// runtime to reparent anything, because the parent is known when the view
    /// is created from the handle.
    #[cfg(target_os = "linux")]
    pub(super) fn attach(surface: &WindowCompositionSurface, view: NativeViewHandle) -> Result<()> {
        use raw_window_handle::RawWindowHandle;
        let handle = surface.platform_surface()?.platform_handle()?;
        let raw = handle
            .downcast::<RawWindowHandle>()
            .map_err(|_| anyhow::anyhow!("composition surface did not return a RawWindowHandle"))?;
        match *raw {
            RawWindowHandle::Xcb(xcb) => {
                log::info!(
                    "[native-surface] x11 view {} under {}",
                    view.window,
                    xcb.window.get()
                );
                Ok(())
            }
            RawWindowHandle::Xlib(xlib) => {
                log::info!(
                    "[native-surface] xlib view {} under {}",
                    view.window,
                    xlib.window
                );
                Ok(())
            }
            RawWindowHandle::Wayland(_) => Ok(()),
            _ => anyhow::bail!("unsupported native surface handle on Linux"),
        }
    }

    #[cfg(target_os = "linux")]
    pub(super) fn detach(_view: NativeViewHandle) {}
}

/// An element that places a [`NativeSurface`] at its bounds.
pub struct NativeSurfaceElement {
    pub surface: std::rc::Rc<NativeSurface>,
}

impl IntoElement for NativeSurfaceElement {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for NativeSurfaceElement {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&gpui::InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        style.size.height = relative(1.).into();
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&gpui::InspectorElementId>,
        bounds: Bounds<gpui::Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        window: &mut Window,
        _cx: &mut App,
    ) -> Self::PrepaintState {
        if let Err(error) = self.surface.set_bounds(bounds, window.scale_factor()) {
            log::error!("[native-surface] updating composition bounds failed: {error:#}");
        }
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&gpui::InspectorElementId>,
        _bounds: Bounds<gpui::Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        _prepaint: &mut Self::PrepaintState,
        _window: &mut Window,
        _cx: &mut App,
    ) {
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{point, px, size};

    #[test]
    fn a_surface_handle_reads_null_before_it_is_given_a_view() {
        #[cfg(target_os = "macos")]
        let null = unsafe { NativeViewHandle::from_owned_nsview(std::ptr::null_mut()) };
        #[cfg(target_os = "windows")]
        let null = NativeViewHandle::from_hwnd(0);
        #[cfg(target_os = "linux")]
        let null = NativeViewHandle::from_x11_window(0);
        assert!(null.is_null());
    }

    #[test]
    fn bounds_are_converted_to_device_pixels_at_the_window_scale() {
        let bounds = Bounds {
            origin: point(px(10.), px(20.)),
            size: size(px(100.), px(50.)),
        };
        let device = bounds.to_device_pixels(2.0);
        assert_eq!(device.origin.x.0, 20);
        assert_eq!(device.origin.y.0, 40);
        assert_eq!(device.size.width.0, 200);
        assert_eq!(device.size.height.0, 100);
    }
}
