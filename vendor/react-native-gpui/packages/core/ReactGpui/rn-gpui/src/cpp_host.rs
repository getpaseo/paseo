//! The Rust half of a host component implemented in C++ (`cpp: true` in
//! `hostComponents`): it forwards the node's props and lifecycle to the C++
//! view and hands core the native view it creates.

use crate::host_component::{HostArg, HostContext, HostObject, PropsHandle};
use crate::native_surface::{NativeViewHandle, NativeViewParent, Result};
use gpui::{div, prelude::*, AnyElement, Window};

pub(crate) struct CppHostObject {
    id: u64,
    /// Keeps the props the C++ view last saw alive.
    props: PropsHandle,
}

impl CppHostObject {
    /// Creates the C++ view of component `index`, or `None` when no C++
    /// implementation is registered for it.
    pub(crate) fn create(index: u32, tag: i32, props: PropsHandle) -> Option<Self> {
        let id = rn_gpui_sys::ffi::rn_gpui_cpp_host_create(index, tag, props.as_ptr() as usize);
        (id != 0).then_some(Self { id, props })
    }
}

impl Drop for CppHostObject {
    fn drop(&mut self) {
        rn_gpui_sys::ffi::rn_gpui_cpp_host_destroy(self.id);
    }
}

impl HostObject for CppHostObject {
    fn update(&mut self, props: PropsHandle, _changed: &[u64], _cx: HostContext) {
        rn_gpui_sys::ffi::rn_gpui_cpp_host_update(self.id, props.as_ptr() as usize);
        self.props = props;
    }

    fn render(&mut self, _window: &mut Window, _cx: HostContext) -> AnyElement {
        div().size_full().into_any_element()
    }

    fn render_overlay(&mut self, _window: &mut Window, _cx: HostContext) -> Option<AnyElement> {
        None
    }

    fn command(&mut self, _index: u32, _args: &[HostArg], _cx: HostContext) {}

    fn create_view(
        &mut self,
        parent: &NativeViewParent<'_>,
        window: &mut Window,
        _cx: HostContext,
    ) -> Result<NativeViewHandle> {
        let mut raw = RawParent::default();
        fill_parent(&mut raw, parent, window)?;
        let mut kind = 0u8;
        let value = rn_gpui_sys::ffi::rn_gpui_cpp_host_create_view(
            self.id,
            raw.windows_visual,
            raw.wayland,
            raw.x11_window,
            raw.xcb_connection,
            raw.wayland_display,
            raw.wayland_surface,
            &mut kind,
        );
        Ok(match kind {
            #[cfg(target_os = "macos")]
            // SAFETY: the C++ view returned an owned (+1) NSView.
            1 if value != 0 => unsafe {
                NativeViewHandle::from_owned_nsview(value as usize as *mut std::ffi::c_void)
            },
            #[cfg(target_os = "linux")]
            2 if value != 0 => NativeViewHandle::from_x11_window(value as u32),
            _ => NativeViewHandle::composited(),
        })
    }
}

#[derive(Default)]
struct RawParent {
    windows_visual: usize,
    wayland: bool,
    x11_window: u32,
    xcb_connection: usize,
    wayland_display: usize,
    wayland_surface: usize,
}

#[cfg(target_os = "macos")]
fn fill_parent(
    _raw: &mut RawParent,
    _parent: &NativeViewParent<'_>,
    _window: &Window,
) -> Result<()> {
    Ok(())
}

#[cfg(target_os = "windows")]
fn fill_parent(raw: &mut RawParent, parent: &NativeViewParent<'_>, _window: &Window) -> Result<()> {
    use windows::core::{IUnknown, Interface as _};
    let visual = parent
        .visual()?
        .downcast::<IUnknown>()
        .map_err(|_| anyhow::anyhow!("the composition visual is not an IUnknown"))?;
    // The raw pointer is borrowed for the call only; the surface keeps the
    // visual alive.
    raw.windows_visual = visual.as_raw() as usize;
    Ok(())
}

#[cfg(target_os = "linux")]
fn fill_parent(raw: &mut RawParent, parent: &NativeViewParent<'_>, window: &Window) -> Result<()> {
    use raw_window_handle::{HasDisplayHandle as _, RawDisplayHandle, RawWindowHandle};
    let display = window
        .display_handle()
        .map_err(|error| anyhow::anyhow!("no display handle: {error}"))?
        .as_raw();
    match parent.raw_window_handle()? {
        RawWindowHandle::Xcb(handle) => {
            raw.x11_window = handle.window.get();
            if let RawDisplayHandle::Xcb(display) = display {
                raw.xcb_connection = display.connection.map_or(0, |c| c.as_ptr() as usize);
            }
        }
        RawWindowHandle::Xlib(handle) => raw.x11_window = handle.window as u32,
        RawWindowHandle::Wayland(handle) => {
            raw.wayland = true;
            raw.wayland_surface = handle.surface.as_ptr() as usize;
            if let RawDisplayHandle::Wayland(display) = display {
                raw.wayland_display = display.display.as_ptr() as usize;
            }
        }
        other => anyhow::bail!("a C++ host component cannot draw into a {other:?} surface"),
    }
    Ok(())
}
