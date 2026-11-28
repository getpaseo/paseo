//! The screen's work area on Linux: what is left once panels and docks have
//! taken their space.
//!
//! The X11 window manager publishes it on the root window as `_NET_WORKAREA`,
//! and the compositor's XWayland does the same on Wayland, where a client has no
//! other way to learn it. Reading it needs no window of our own.

use std::os::raw::{c_int, c_long, c_uchar, c_ulong};

/// The whole screen and the work area inside it, in the units X reports, which
/// are points at a scale of one.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WorkArea {
    pub screen: (f32, f32),
    /// `(x, y, width, height)`.
    pub area: (f32, f32, f32, f32),
}

pub fn read() -> Option<WorkArea> {
    let xlib = x11_dl::xlib::Xlib::open().ok()?;
    // SAFETY: the display is opened and closed within this function, the atoms and
    // properties are read through the library's own calls, and every pointer the
    // calls fill in is freed with `XFree`.
    unsafe {
        let display = (xlib.XOpenDisplay)(std::ptr::null());
        if display.is_null() {
            return None;
        }
        let root = (xlib.XDefaultRootWindow)(display);
        let area = cardinals(&xlib, display, root, "_NET_WORKAREA", 4);
        let screen = cardinals(&xlib, display, root, "_NET_DESKTOP_GEOMETRY", 2);
        (xlib.XCloseDisplay)(display);
        let (area, screen) = (area?, screen?);
        let result = WorkArea {
            screen: (screen[0] as f32, screen[1] as f32),
            area: (
                area[0] as f32,
                area[1] as f32,
                area[2] as f32,
                area[3] as f32,
            ),
        };
        (result.area.2 > 0.0 && result.area.3 > 0.0 && result.screen.0 > 0.0).then_some(result)
    }
}

/// The first `count` values of a 32-bit property of a window.
unsafe fn cardinals(
    xlib: &x11_dl::xlib::Xlib,
    display: *mut x11_dl::xlib::Display,
    window: c_ulong,
    name: &str,
    count: usize,
) -> Option<Vec<c_long>> {
    let name = std::ffi::CString::new(name).ok()?;
    let atom = (xlib.XInternAtom)(display, name.as_ptr(), 1);
    if atom == 0 {
        return None;
    }
    let mut actual_type: c_ulong = 0;
    let mut actual_format: c_int = 0;
    let mut items: c_ulong = 0;
    let mut remaining: c_ulong = 0;
    let mut data: *mut c_uchar = std::ptr::null_mut();
    let status = (xlib.XGetWindowProperty)(
        display,
        window,
        atom,
        0,
        count as c_long,
        0,
        0,
        &mut actual_type,
        &mut actual_format,
        &mut items,
        &mut remaining,
        &mut data,
    );
    let values = if status == 0 && actual_format == 32 && items as usize >= count && !data.is_null()
    {
        Some(std::slice::from_raw_parts(data as *const c_long, count).to_vec())
    } else {
        None
    };
    if !data.is_null() {
        (xlib.XFree)(data as *mut _);
    }
    values
}
