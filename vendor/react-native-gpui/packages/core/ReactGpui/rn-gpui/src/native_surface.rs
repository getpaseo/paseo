//! A native view inside a React Native tree, on every platform.

use anyhow::Context as _;
use gpui::{
    relative, AnyElement, AnyWindowHandle, App, AsyncApp, Bounds, CompositionSurfaceId, Element,
    ElementId, GlobalElementId, IntoElement, LayoutId, Style, Window, WindowCompositionSurface,
};

pub use anyhow::{Error, Result};

/// What a host component hands core as its native view.
///
/// How a view is placed differs per platform, because each compositor takes
/// native content differently: macOS adds an `NSView` to the node's container,
/// X11 and Wayland give the component the surface to draw into, Windows takes
/// composition content on the surface's visual.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NativeViewHandle(Repr);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Repr {
    Composited,
    #[cfg(target_os = "macos")]
    Nsview(usize),
    #[cfg(target_os = "linux")]
    X11Window(u32),
}

impl NativeViewHandle {
    /// The component put its content on the [`NativeViewParent`] itself: on
    /// Windows a DirectComposition visual, on Linux the surface's window or
    /// `wl_surface`. Core places and shows the surface; there is no view to
    /// attach or release.
    pub fn composited() -> Self {
        Self(Repr::Composited)
    }

    /// Transfer one owned `NSView` reference to the runtime. The view must have
    /// been created with AppKit's `alloc`/`init` convention and remain valid
    /// until the runtime releases it when the Fabric node unmounts.
    ///
    /// # Safety
    ///
    /// `view` must be an owned `NSView` reference, created with `alloc`/`init`, that stays valid until the runtime releases it.
    #[cfg(target_os = "macos")]
    pub unsafe fn from_owned_nsview(view: *mut std::ffi::c_void) -> Self {
        Self(Repr::Nsview(view as usize))
    }

    /// The `NSView` the handle names, or null when it names none.
    #[cfg(target_os = "macos")]
    pub fn as_nsview(&self) -> *mut std::ffi::c_void {
        match self.0 {
            Repr::Nsview(view) => view as *mut std::ffi::c_void,
            Repr::Composited => std::ptr::null_mut(),
        }
    }

    /// A child window the component created under the surface window. The
    /// component keeps ownership and destroys it after the node unmounts.
    #[cfg(target_os = "linux")]
    pub fn from_x11_window(window: u32) -> Self {
        Self(Repr::X11Window(window))
    }

    /// The X11 window the handle names, or zero when it names none.
    #[cfg(target_os = "linux")]
    pub fn as_x11_window(&self) -> u32 {
        match self.0 {
            Repr::X11Window(window) => window,
            Repr::Composited => 0,
        }
    }

    /// Whether the content is on the parent rather than a view of its own.
    pub fn is_composited(&self) -> bool {
        matches!(self.0, Repr::Composited)
    }
}

/// The composition surface core made for a native view node, which the
/// component puts its content in. It exists before the component is asked for
/// its view, so a platform that needs the parent to create the view has it.
pub struct NativeViewParent<'a> {
    surface: &'a NativeSurface,
}

impl NativeViewParent<'_> {
    /// The surface's DirectComposition visual, as the `IUnknown` that casts to
    /// `IDCompositionVisual3`. Content set on it is placed, clipped and hidden
    /// with the node.
    #[cfg(target_os = "windows")]
    pub fn visual(&self) -> Result<Box<dyn std::any::Any>> {
        self.surface.surface.platform_surface()?.platform_handle()
    }

    /// The window the surface draws in: an XCB window on X11, a `wl_surface`
    /// subsurface on Wayland. Create a child window under it or draw into it.
    #[cfg(target_os = "linux")]
    pub fn raw_window_handle(&self) -> Result<raw_window_handle::RawWindowHandle> {
        self.surface
            .surface
            .platform_surface()?
            .platform_handle()?
            .downcast::<raw_window_handle::RawWindowHandle>()
            .map(|handle| *handle)
            .map_err(|_| anyhow::anyhow!("composition surface did not return a RawWindowHandle"))
    }
}

/// A native view attached to a window's composition surface, with a GPUI
/// surface stacked directly above it for the views painted after it.
pub struct NativeSurface {
    surface: WindowCompositionSurface,
    above: WindowCompositionSurface,
    window: AnyWindowHandle,
    app: AsyncApp,
    view: std::cell::Cell<NativeViewHandle>,
    last_bounds: std::cell::Cell<Option<Bounds<gpui::DevicePixels>>>,
    visible: std::cell::Cell<bool>,
}

impl NativeSurface {
    /// Creates the composition surfaces of a native view node. The view comes
    /// later, from [`attach`](Self::attach), once the component has the
    /// [`parent`](Self::parent) to create it in.
    pub fn new(window: &Window, cx: &App) -> Result<Self> {
        let composition = window.enable_window_composition()?;
        let surface = composition.create_native_surface()?;
        // A root above the view, not a child of its container: the container
        // clips to the view's bounds, and what is painted after the view
        // reaches outside them.
        let above = composition.create_gpui_surface(None)?;
        composition.place_above(above.id(), surface.id())?;
        Ok(Self {
            surface,
            above,
            window: window.window_handle(),
            app: cx.to_async(),
            view: std::cell::Cell::new(NativeViewHandle::composited()),
            last_bounds: std::cell::Cell::new(None),
            visible: std::cell::Cell::new(true),
        })
    }

    /// What a component creates its view in.
    pub fn parent(&self) -> NativeViewParent<'_> {
        NativeViewParent { surface: self }
    }

    /// Takes `view` into the surface. The surface owns it from here on.
    pub fn attach(&self, view: NativeViewHandle) -> Result<()> {
        imp::attach(&self.surface, view)?;
        self.view.set(view);
        Ok(())
    }

    /// The GPUI surface drawn directly above this view.
    pub fn above(&self) -> CompositionSurfaceId {
        self.above.id()
    }

    /// The platform view, as the factory returned it.
    pub fn view(&self) -> NativeViewHandle {
        self.view.get()
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

    /// What the surface and its view look like now, for the test driver.
    #[cfg(feature = "test-driver")]
    pub fn test_state(&self, scale_factor: f32) -> serde_json::Value {
        let bounds = self.last_bounds.get().map(|bounds| {
            serde_json::json!({
                "x": bounds.origin.x.0 as f32 / scale_factor,
                "y": bounds.origin.y.0 as f32 / scale_factor,
                "width": bounds.size.width.0 as f32 / scale_factor,
                "height": bounds.size.height.0 as f32 / scale_factor,
            })
        });
        #[cfg(target_os = "macos")]
        let view = {
            use cocoa::{base::id, foundation::NSRect};
            use objc::{msg_send, sel, sel_impl};
            let view = self.view.get().as_nsview() as id;
            // SAFETY: the view is owned by this surface and read on the main thread.
            unsafe {
                if view.is_null() {
                    return serde_json::json!({"bounds": bounds, "visible": self.visible.get(), "view": null});
                }
                let frame: NSRect = msg_send![view, frame];
                let superview: id = msg_send![view, superview];
                let hidden: bool = !superview.is_null() && msg_send![superview, isHidden];
                let layer: id = msg_send![view, layer];
                let color: *const std::ffi::c_void = msg_send![layer, backgroundColor];
                let components = if color.is_null() {
                    Vec::new()
                } else {
                    let count = CGColorGetNumberOfComponents(color);
                    std::slice::from_raw_parts(CGColorGetComponents(color), count).to_vec()
                };
                serde_json::json!({
                    "width": frame.size.width,
                    "height": frame.size.height,
                    "attached": !superview.is_null(),
                    "hidden": hidden,
                    "background": components,
                })
            }
        };
        #[cfg(not(target_os = "macos"))]
        let view = serde_json::Value::Null;
        serde_json::json!({"bounds": bounds, "visible": self.visible.get(), "view": view})
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
        imp::detach(self.view.get());
        // Removing the composition surfaces needs the window, which a drop does
        // not have, and may land inside an update; do it on a later turn.
        let app = self.app.clone();
        let window = self.window;
        let surfaces = [self.above.id(), self.surface.id()];
        self.app
            .foreground_executor()
            .spawn(async move {
                app.update(|cx| {
                    let _ = window.update(cx, |_, window, _| {
                        let Ok(composition) = window.enable_window_composition() else {
                            return;
                        };
                        for surface in surfaces {
                            if let Err(error) = composition.remove_surface(surface) {
                                log::error!(
                                    "[native-surface] removing a composition surface: {error:#}"
                                );
                            }
                        }
                    });
                });
            })
            .detach();
    }
}

#[cfg(all(feature = "test-driver", target_os = "macos"))]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGColorGetNumberOfComponents(color: *const std::ffi::c_void) -> usize;
    fn CGColorGetComponents(color: *const std::ffi::c_void) -> *const f64;
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
        let Repr::Nsview(view) = view.0 else {
            return Ok(());
        };
        let view = view as id;
        // SAFETY: `view` is the owned `NSView` the factory returned, and `container` is the live composition surface view; both are used on the main thread.
        unsafe {
            let _: () =
                msg_send![view, setAutoresizingMask: NSViewWidthSizable | NSViewHeightSizable];
            let _: () = msg_send![
                view,
                setFrame: NSRect::new(NSPoint::new(0., 0.), NSSize::new(0., 0.))
            ];
            // Below the GPUI surface that was stacked on this container first,
            // so that what is painted after the view covers it.
            const NS_WINDOW_BELOW: isize = -1;
            let _: () = msg_send![
                container,
                addSubview: view
                positioned: NS_WINDOW_BELOW
                relativeTo: cocoa::base::nil
            ];
        }
        Ok(())
    }

    #[cfg(target_os = "macos")]
    pub(super) fn detach(view: NativeViewHandle) {
        use cocoa::{appkit::NSView, base::id};
        use objc::{msg_send, sel, sel_impl};
        let Repr::Nsview(view) = view.0 else {
            return;
        };
        let view = view as id;
        // SAFETY: `view` is the owned `NSView` attached by `attach`; it is detached and released once, on drop.
        unsafe {
            NSView::removeFromSuperview(view);
            let _: () = msg_send![view, release];
        }
    }

    /// Windows: the content is composition content on the surface's visual,
    /// which DirectComposition clips and offsets, so core has nothing to do.
    #[cfg(target_os = "windows")]
    pub(super) fn attach(
        _surface: &WindowCompositionSurface,
        _view: NativeViewHandle,
    ) -> Result<()> {
        Ok(())
    }

    #[cfg(target_os = "windows")]
    pub(super) fn detach(_view: NativeViewHandle) {}

    /// Linux: the component made its window under the surface window, or draws
    /// into the surface; the server clips and moves it with the surface, so
    /// core has nothing to do.
    #[cfg(target_os = "linux")]
    pub(super) fn attach(
        _surface: &WindowCompositionSurface,
        _view: NativeViewHandle,
    ) -> Result<()> {
        Ok(())
    }

    #[cfg(target_os = "linux")]
    pub(super) fn detach(_view: NativeViewHandle) {}
}

/// An element that paints its child onto a GPUI composition surface instead of
/// the one being painted: how views drawn after a native view end up above it.
pub(crate) struct OnSurface {
    child: AnyElement,
    surface: CompositionSurfaceId,
}

impl OnSurface {
    pub(crate) fn new(child: AnyElement, surface: CompositionSurfaceId) -> Self {
        Self { child, surface }
    }
}

impl IntoElement for OnSurface {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for OnSurface {
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
        (self.child.request_layout(window, cx), ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&gpui::InspectorElementId>,
        _bounds: Bounds<gpui::Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        self.child.prepaint(window, cx);
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&gpui::InspectorElementId>,
        _bounds: Bounds<gpui::Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        _prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let child = &mut self.child;
        let painted = window.with_composition_surface(self.surface, |window| {
            child.paint(window, cx);
        });
        if let Err(error) = painted {
            log::error!("[native-surface] painting above a native view: {error:#}");
            self.child.paint(window, cx);
        }
    }
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
        bounds: Bounds<gpui::Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        _prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        _cx: &mut App,
    ) {
        // Over the native view the pointer belongs to it, so the nodes under it
        // hear nothing more and the one the pointer came from stays hovered.
        let surface = self.surface.clone();
        window.on_mouse_event(move |event: &gpui::MouseMoveEvent, phase, window, cx| {
            if phase == gpui::DispatchPhase::Capture
                && event.pressed_button.is_none()
                && surface.is_visible()
                && bounds.contains(&event.position)
            {
                crate::events::leave_root(window, cx);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{point, px, size};

    #[test]
    fn a_handle_that_names_no_view_is_composited() {
        assert!(NativeViewHandle::composited().is_composited());
        #[cfg(target_os = "macos")]
        {
            let view = std::ptr::NonNull::<std::ffi::c_void>::dangling().as_ptr();
            // SAFETY: the handle is only inspected, never attached or released.
            let handle = unsafe { NativeViewHandle::from_owned_nsview(view) };
            assert!(!handle.is_composited());
            assert_eq!(handle.as_nsview(), view);
        }
        #[cfg(target_os = "linux")]
        assert!(!NativeViewHandle::from_x11_window(7).is_composited());
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
