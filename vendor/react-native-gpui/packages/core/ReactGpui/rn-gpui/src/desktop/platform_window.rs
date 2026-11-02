pub fn supports_position() -> bool {
    crate::desktop::capabilities::window_position()
}

#[cfg(target_os = "macos")]
mod imp {
    use cocoa::base::id;
    use cocoa::foundation::{NSPoint, NSSize};
    use objc::{msg_send, sel, sel_impl};
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    const FLOATING_WINDOW_LEVEL: i64 = 3;
    const NORMAL_WINDOW_LEVEL: i64 = 0;

    fn ns_window(window: &gpui::Window) -> Result<id, String> {
        let handle = HasWindowHandle::window_handle(window)
            .map_err(|error| format!("no platform window handle: {error}"))?;
        match handle.as_raw() {
            // SAFETY: `ns_view` comes from the window's raw handle, which GPUI keeps valid while the window lives.
            RawWindowHandle::AppKit(appkit) => unsafe {
                let ns_view = appkit.ns_view.as_ptr() as id;
                let native: id = msg_send![ns_view, window];
                if native.is_null() {
                    Err("the AppKit window is gone".to_string())
                } else {
                    Ok(native)
                }
            },
            _ => Err("unexpected platform window handle".to_string()),
        }
    }

    /// Convert a GPUI top-left-origin screen point into an AppKit top-left point.
    ///
    /// GPUI's `bounds()` reports `x - screen.origin.x` and
    /// `screen.height - appkit_y - frame_height + screen.origin.y`; this is the
    /// inverse, so `set_position` round-trips through `window.bounds()`.
    fn appkit_top_left(window: &gpui::Window, native: id, x: f32, y: f32) -> NSPoint {
        // SAFETY: `native` is the live `NSWindow` from `ns_window`, and AppKit is only messaged from the main thread.
        unsafe {
            let screen: id = msg_send![native, screen];
            let frame_height = f32::from(window.bounds().size.height);
            if screen.is_null() {
                return NSPoint::new(f64::from(x), f64::from(y));
            }
            let screen_frame: cocoa::foundation::NSRect = msg_send![screen, frame];
            let appkit_x = x + screen_frame.origin.x as f32;
            let appkit_y = screen_frame.size.height as f32 - (y - screen_frame.origin.y as f32);
            NSPoint::new(f64::from(appkit_x), f64::from(appkit_y + frame_height))
        }
    }

    pub fn set_position(window: &mut gpui::Window, x: f32, y: f32) -> Result<(), String> {
        let native = ns_window(window)?;
        let point = appkit_top_left(window, native, x, y);
        // SAFETY: `native` is the live `NSWindow` from `ns_window`, and AppKit is only messaged from the main thread.
        unsafe {
            let _: () = msg_send![native, setFrameTopLeftPoint: point];
        }
        Ok(())
    }

    pub fn set_always_on_top(window: &mut gpui::Window, on: bool) -> Result<(), String> {
        let native = ns_window(window)?;
        let level = if on {
            FLOATING_WINDOW_LEVEL
        } else {
            NORMAL_WINDOW_LEVEL
        };
        // SAFETY: `native` is the live `NSWindow` from `ns_window`, and AppKit is only messaged from the main thread.
        unsafe {
            let _: () = msg_send![native, setLevel: level];
        }
        Ok(())
    }

    pub fn set_min_size(window: &mut gpui::Window, width: f32, height: f32) -> Result<(), String> {
        let native = ns_window(window)?;
        let size = NSSize::new(f64::from(width), f64::from(height));
        // SAFETY: `native` is the live `NSWindow` from `ns_window`, and AppKit is only messaged from the main thread.
        unsafe {
            let _: () = msg_send![native, setContentMinSize: size];
        }
        Ok(())
    }

    pub fn set_max_size(window: &mut gpui::Window, width: f32, height: f32) -> Result<(), String> {
        let native = ns_window(window)?;
        let size = NSSize::new(f64::from(width), f64::from(height));
        // SAFETY: `native` is the live `NSWindow` from `ns_window`, and AppKit is only messaged from the main thread.
        unsafe {
            let _: () = msg_send![native, setContentMaxSize: size];
        }
        Ok(())
    }

    const STYLE_MASK_RESIZABLE: u64 = 1 << 3;

    pub fn set_resizable(window: &mut gpui::Window, resizable: bool) -> Result<(), String> {
        let native = ns_window(window)?;
        // SAFETY: `native` is the live `NSWindow` from `ns_window`, and AppKit is only messaged from the main thread.
        unsafe {
            let mask: u64 = msg_send![native, styleMask];
            let next = if resizable {
                mask | STYLE_MASK_RESIZABLE
            } else {
                mask & !STYLE_MASK_RESIZABLE
            };
            if next != mask {
                let _: () = msg_send![native, setStyleMask: next];
            }
        }
        Ok(())
    }

    pub fn show(window: &mut gpui::Window) -> Result<(), String> {
        let native = ns_window(window)?;
        // SAFETY: `native` is the live `NSWindow` from `ns_window`, and AppKit is only messaged from the main thread.
        unsafe {
            let _: () = msg_send![native, orderFront: std::ptr::null::<id>()];
        }
        Ok(())
    }

    pub fn hide(window: &mut gpui::Window) -> Result<(), String> {
        let native = ns_window(window)?;
        // SAFETY: `native` is the live `NSWindow` from `ns_window`, and AppKit is only messaged from the main thread.
        unsafe {
            let _: () = msg_send![native, orderOut: std::ptr::null::<id>()];
        }
        Ok(())
    }

    pub fn is_minimized(window: &gpui::Window) -> bool {
        let Ok(native) = ns_window(window) else {
            return false;
        };
        // SAFETY: `native` is the live `NSWindow` from `ns_window`, and AppKit is only messaged from the main thread.
        unsafe {
            let minimized: bool = msg_send![native, isMiniaturized];
            minimized
        }
    }

    /// `[NSWindow isZoomed]`.
    ///
    /// GPUI's own `Window::is_maximized` reads `NSScreen.visibleFrame` and
    /// panics when the window has no screen (a hidden or off-screen window),
    /// which the test driver creates, so the desktop shell asks AppKit instead.
    pub fn is_maximized(window: &gpui::Window) -> bool {
        let Ok(native) = ns_window(window) else {
            return false;
        };
        // SAFETY: `native` is the live `NSWindow` from `ns_window`, and AppKit is only messaged from the main thread.
        unsafe {
            let screen: id = msg_send![native, screen];
            if screen.is_null() {
                return false;
            }
            let zoomed: bool = msg_send![native, isZoomed];
            zoomed
        }
    }

    /// `style_as_popover` already configures the panel; nothing to set before
    /// it is shown.
    pub fn prepare_popover(
        _window: &mut gpui::Window,
        _x: f32,
        _y: f32,
        _width: f32,
        _height: f32,
    ) -> Result<(), String> {
        Ok(())
    }

    pub fn activate_popover(_window: &gpui::Window) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(target_os = "macos")]
pub use imp::*;

/// Windows: `SetWindowPos` / `ShowWindow` / `IsIconic` / `IsZoomed` on the
/// HWND.
///
/// TODO: never built or run on Windows.
#[cfg(target_os = "windows")]
mod imp {
    use gpui::Window;
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        IsIconic, IsWindowVisible, IsZoomed, SetWindowPos, ShowWindowAsync, HWND_NOTOPMOST,
        HWND_TOPMOST, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
        SW_HIDE, SW_SHOW,
    };

    const UNSUPPORTED_MIN_MAX: &str =
        "a runtime minimum/maximum size needs a WM_GETMINMAXINFO handler in GPUI's window procedure";

    fn hwnd(window: &Window) -> Result<HWND, String> {
        let handle = HasWindowHandle::window_handle(window)
            .map_err(|error| format!("no platform window handle: {error}"))?;
        match handle.as_raw() {
            RawWindowHandle::Win32(win32) => Ok(win32.hwnd.get() as HWND),
            _ => Err("unexpected platform window handle".to_string()),
        }
    }

    pub fn set_position(window: &mut Window, x: f32, y: f32) -> Result<(), String> {
        let hwnd = hwnd(window)?;
        // GPUI's bounds are physical pixels, which is what SetWindowPos takes.
        // SAFETY: `hwnd` is the live window handle `hwnd()` just returned, used on the window's own thread.
        let result = unsafe {
            SetWindowPos(
                hwnd,
                std::ptr::null_mut(),
                x.round() as i32,
                y.round() as i32,
                0,
                0,
                SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            )
        };
        if result == 0 {
            Err("SetWindowPos failed".to_string())
        } else {
            Ok(())
        }
    }

    pub fn set_always_on_top(window: &mut Window, on: bool) -> Result<(), String> {
        let hwnd = hwnd(window)?;
        let insert_after = if on { HWND_TOPMOST } else { HWND_NOTOPMOST };
        // SAFETY: `hwnd` is the live window handle `hwnd()` just returned, used on the window's own thread.
        let result = unsafe {
            SetWindowPos(
                hwnd,
                insert_after,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            )
        };
        if result == 0 {
            Err("SetWindowPos failed".to_string())
        } else {
            Ok(())
        }
    }

    pub fn set_min_size(_window: &mut Window, _width: f32, _height: f32) -> Result<(), String> {
        Err(UNSUPPORTED_MIN_MAX.to_string())
    }

    pub fn set_max_size(_window: &mut Window, _width: f32, _height: f32) -> Result<(), String> {
        Err(UNSUPPORTED_MIN_MAX.to_string())
    }

    /// Toggle the resize frame. GPUI applies the style flags it knows at
    /// creation, so the change is pushed with `SWP_FRAMECHANGED`.
    pub fn set_resizable(window: &mut Window, resizable: bool) -> Result<(), String> {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetWindowLongPtrW, SetWindowLongPtrW, GWL_STYLE, WS_MAXIMIZEBOX, WS_THICKFRAME,
        };
        let hwnd = hwnd(window)?;
        // SAFETY: `hwnd` is the live window handle `hwnd()` just returned, used on the window's own thread.
        unsafe {
            let style = GetWindowLongPtrW(hwnd, GWL_STYLE) as u32;
            let style = if resizable {
                style | WS_THICKFRAME | WS_MAXIMIZEBOX
            } else {
                style & !(WS_THICKFRAME | WS_MAXIMIZEBOX)
            };
            SetWindowLongPtrW(hwnd, GWL_STYLE, style as isize);
            SetWindowPos(
                hwnd,
                std::ptr::null_mut(),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
            );
        }
        Ok(())
    }

    /// `ShowWindowAsync` rather than `ShowWindow`: the synchronous call delivers
    /// `WM_SHOWWINDOW`/`WM_SIZE`/`WM_MOVE` before it returns, and GPUI's window
    /// procedure re-enters the window state that the caller is inside, which
    /// logs "RefCell already borrowed" (and drops the notification). The async
    /// form queues the same messages and returns, which is what GPUI's own
    /// `minimize` and `zoom` use.
    pub fn show(window: &mut Window) -> Result<(), String> {
        let hwnd = hwnd(window)?;
        // SAFETY: `hwnd` is the live window handle `hwnd()` just returned, used on the window's own thread.
        unsafe { ShowWindowAsync(hwnd, SW_SHOW) };
        Ok(())
    }

    pub fn hide(window: &mut Window) -> Result<(), String> {
        let hwnd = hwnd(window)?;
        // SAFETY: `hwnd` is the live window handle `hwnd()` just returned, used on the window's own thread.
        unsafe { ShowWindowAsync(hwnd, SW_HIDE) };
        Ok(())
    }

    pub fn is_minimized(window: &Window) -> bool {
        match hwnd(window) {
            // SAFETY: `hwnd` is the live window handle `hwnd()` just returned, used on the window's own thread.
            Ok(hwnd) => unsafe { IsIconic(hwnd) != 0 },
            Err(_) => false,
        }
    }

    /// Whether the window is not being presented. `IsWindowVisible` is false
    /// for a window created with `show: false` (the offscreen test windows) and
    /// after `ShowWindow(SW_HIDE)`, and stays true for a window that is merely
    /// covered, which is what the test driver wants to distinguish.
    pub fn is_hidden(window: &Window) -> bool {
        match hwnd(window) {
            // SAFETY: `hwnd` is the live window handle `hwnd()` just returned, used on the window's own thread.
            Ok(hwnd) => unsafe { IsWindowVisible(hwnd) == 0 },
            Err(_) => false,
        }
    }

    pub fn is_maximized(window: &Window) -> bool {
        match hwnd(window) {
            // SAFETY: `hwnd` is the live window handle `hwnd()` just returned, used on the window's own thread.
            Ok(hwnd) => unsafe { IsZoomed(hwnd) != 0 },
            Err(_) => false,
        }
    }

    /// Sets the popover up while it is still hidden: out of the taskbar and the
    /// Alt+Tab list, above the other topmost windows, placed under (or over) its
    /// tray icon, and at its own size.
    ///
    /// `x`, `y`, `width` and `height` are in points; `SetWindowPos` takes physical
    /// pixels, so they are scaled by the window's own scale factor.
    pub fn prepare_popover(
        window: &mut Window,
        x: f32,
        y: f32,
        width: f32,
        height: f32,
    ) -> Result<(), String> {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
        };
        let hwnd = hwnd(window)?;
        let scale = window.scale_factor();
        // SAFETY: `hwnd` is the live window handle `hwnd()` just returned, used on the window's own thread.
        let placed = unsafe {
            // A tool window has no taskbar button, which is also what a popover
            // that shows the app's icon there would otherwise leave behind.
            let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            SetWindowLongPtrW(
                hwnd,
                GWL_EXSTYLE,
                ((style | WS_EX_TOOLWINDOW) & !WS_EX_APPWINDOW) as isize,
            );
            // Topmost, because the windows a tray click leaves open are: the
            // taskbar's hidden-icons flyout is a topmost window, and a normal
            // window opened from an icon inside it would appear behind it. A
            // topmost window shown later goes above the topmost ones already
            // there.
            SetWindowPos(
                hwnd,
                HWND_TOPMOST,
                (x * scale).round() as i32,
                (y * scale).round() as i32,
                (width * scale).round() as i32,
                (height * scale).round() as i32,
                SWP_NOACTIVATE | SWP_FRAMECHANGED,
            )
        };
        if placed == 0 {
            Err("SetWindowPos failed".to_string())
        } else {
            Ok(())
        }
    }

    /// Shows the popover, which activates it, so it takes focus — and so loses it
    /// when the user clicks elsewhere, which is what dismisses it. A window that
    /// was created hidden stays hidden until this.
    ///
    /// `ShowWindowAsync`, like `show`: the synchronous calls (`ShowWindow`,
    /// `SetForegroundWindow`) deliver the activation messages before they return,
    /// into a window procedure that is already inside GPUI's window state, which
    /// logs "RefCell already borrowed".
    pub fn activate_popover(window: &Window) -> Result<(), String> {
        let hwnd = hwnd(window)?;
        // SAFETY: `hwnd` is the live window handle `hwnd()` just returned, used on the window's own thread.
        unsafe { ShowWindowAsync(hwnd, SW_SHOW) };
        Ok(())
    }
}

/// X11: the window calls GPUI does not expose, over a second X connection.
/// Wayland has no absolute positioning or raise, so a Wayland session reports
/// `unsupported`.
///
/// TODO: never built or run on Linux.
#[cfg(target_os = "linux")]
mod imp {
    use gpui::Window;
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use x11_dl::xlib;

    const UNSUPPORTED_WAYLAND: &str =
        "Wayland has no absolute window positioning or raise; use X11 for these calls";

    fn wayland() -> bool {
        crate::desktop::capabilities::is_wayland()
    }

    fn window_id(window: &Window) -> Result<u64, String> {
        let handle = HasWindowHandle::window_handle(window)
            .map_err(|error| format!("no platform window handle: {error}"))?;
        match handle.as_raw() {
            RawWindowHandle::Xlib(xlib_handle) => Ok(xlib_handle.window as u64),
            RawWindowHandle::Xcb(xcb) => Ok(xcb.window.get() as u64),
            _ => Err("the session is not X11".to_string()),
        }
    }

    /// Run `f` with a fresh X connection. GPUI owns its own connection and does
    /// not expose it, and the X protocol allows a second client to move and
    /// raise another client's window.
    fn with_display<R>(f: impl FnOnce(&xlib::Xlib, *mut xlib::Display) -> R) -> Result<R, String> {
        if wayland() {
            return Err(UNSUPPORTED_WAYLAND.to_string());
        }
        let xlib = xlib::Xlib::open().map_err(|error| format!("no X11 library: {error}"))?;
        // SAFETY: the display from `XOpenDisplay` is null-checked before use and closed once, after `f` returns.
        unsafe {
            let display = (xlib.XOpenDisplay)(std::ptr::null());
            if display.is_null() {
                return Err("could not open an X11 display".to_string());
            }
            let result = f(&xlib, display);
            (xlib.XCloseDisplay)(display);
            Ok(result)
        }
    }

    /// Xlib's functions live on the loaded library, so every call goes through
    /// the `xlib` instance `with_display` hands to the closure.
    fn with_window<R>(
        window: &Window,
        f: impl FnOnce(&xlib::Xlib, *mut xlib::Display, xlib::Window) -> R,
    ) -> Result<R, String> {
        let id = window_id(window)?;
        with_display(|xlib, display| f(xlib, display, id as xlib::Window))
    }

    pub fn set_position(window: &mut Window, x: f32, y: f32) -> Result<(), String> {
        // SAFETY: `display` is an open connection and `id` a window id for the whole closure; `with_display` closes the connection afterwards.
        with_window(window, |xlib, display, id| unsafe {
            (xlib.XMoveWindow)(display, id, x.round() as i32, y.round() as i32);
            (xlib.XFlush)(display);
        })
    }

    /// Raising is the part of always-on-top X11 itself can do, so `on == true`
    /// only raises the window once and `on == false` is a no-op.
    ///
    /// TODO: set the `_NET_WM_STATE_ABOVE` hint so the window stays above.
    pub fn set_always_on_top(window: &mut Window, on: bool) -> Result<(), String> {
        // SAFETY: `display` is an open connection and `id` a window id for the whole closure; `with_display` closes the connection afterwards.
        with_window(window, |xlib, display, id| unsafe {
            if on {
                (xlib.XRaiseWindow)(display, id);
                (xlib.XFlush)(display);
            }
        })
    }

    pub fn set_min_size(window: &mut Window, width: f32, height: f32) -> Result<(), String> {
        // SAFETY: `display` is an open connection and `id` a window id for the whole closure; `with_display` closes the connection afterwards.
        with_window(window, |xlib, display, id| unsafe {
            let mut hints: xlib::XSizeHints = std::mem::zeroed();
            hints.flags = xlib::PMinSize;
            hints.min_width = width.round() as i32;
            hints.min_height = height.round() as i32;
            (xlib.XSetWMNormalHints)(display, id, &mut hints);
            (xlib.XFlush)(display);
        })
    }

    pub fn set_max_size(window: &mut Window, width: f32, height: f32) -> Result<(), String> {
        // SAFETY: `display` is an open connection and `id` a window id for the whole closure; `with_display` closes the connection afterwards.
        with_window(window, |xlib, display, id| unsafe {
            let mut hints: xlib::XSizeHints = std::mem::zeroed();
            hints.flags = xlib::PMaxSize;
            hints.max_width = width.round() as i32;
            hints.max_height = height.round() as i32;
            (xlib.XSetWMNormalHints)(display, id, &mut hints);
            (xlib.XFlush)(display);
        })
    }

    pub fn set_resizable(_window: &mut Window, _resizable: bool) -> Result<(), String> {
        // TODO: GPUI sets the size hints from `WindowOptions::is_resizable`;
        // changing them at runtime needs the WM_NORMAL_HINTS pair above plus a
        // `_MOTIF_WM_HINTS` update.
        Err("changing resizability at runtime is not implemented on X11 yet".to_string())
    }

    pub fn show(window: &mut Window) -> Result<(), String> {
        // SAFETY: `display` is an open connection and `id` a window id for the whole closure; `with_display` closes the connection afterwards.
        with_window(window, |xlib, display, id| unsafe {
            (xlib.XMapWindow)(display, id);
            (xlib.XFlush)(display);
        })
    }

    pub fn hide(window: &mut Window) -> Result<(), String> {
        // SAFETY: `display` is an open connection and `id` a window id for the whole closure; `with_display` closes the connection afterwards.
        with_window(window, |xlib, display, id| unsafe {
            (xlib.XUnmapWindow)(display, id);
            (xlib.XFlush)(display);
        })
    }

    pub fn is_minimized(window: &Window) -> bool {
        // `XGetWindowAttributes` reports `IsUnmapped` for a hidden window, but
        // X11 has no "minimized" state of its own (the WM owns it).
        // SAFETY: `display` is an open connection and `id` a window id for the whole closure; `with_display` closes the connection afterwards.
        with_window(window, |xlib, display, id| unsafe {
            let mut attributes: xlib::XWindowAttributes = std::mem::zeroed();
            if (xlib.XGetWindowAttributes)(display, id, &mut attributes) == 0 {
                return false;
            }
            attributes.map_state == xlib::IsUnmapped
        })
        .unwrap_or(false)
    }

    pub fn is_maximized(_window: &Window) -> bool {
        // Only the window manager knows; it would need a `_NET_WM_STATE` read.
        false
    }

    /// Turns a just-created, still-unmapped window into a tray popover.
    ///
    /// The tray popover cannot be `WindowKind::PopUp`: GPUI makes that
    /// override-redirect, so the window manager never focuses it, its
    /// `install_activation_observer` never sees a deactivation, and it cannot be
    /// dismissed by clicking away. It is instead an ordinary undecorated window
    /// that the window manager manages — the same shape Electron's Linux tray
    /// menu uses (a frameless window with skip-taskbar and always-on-top). The
    /// properties below are set on the still-unmapped window so nothing flashes
    /// in the taskbar or appears decorated first.
    ///
    /// Call before the window is mapped (see `windows::open_window`, which opens
    /// the popover with `show: false` and maps it afterwards); `_NET_WM_STATE`
    /// and `_NET_WM_WINDOW_TYPE` are read when the window is mapped.
    pub fn prepare_popover(
        window: &mut Window,
        x: f32,
        y: f32,
        width: f32,
        height: f32,
    ) -> Result<(), String> {
        // SAFETY: `display` is an open connection and `id` a window id for the whole closure; `with_display` closes the connection afterwards.
        with_window(window, |xlib, display, id| unsafe {
            // A hidden window is placed by the user, not the window manager:
            // USPosition with the exact origin, so a WM that honours hints maps
            // it where the tray icon is instead of centring it.
            let mut hints: xlib::XSizeHints = std::mem::zeroed();
            hints.flags = xlib::USPosition | xlib::PSize;
            hints.x = x.round() as i32;
            hints.y = y.round() as i32;
            hints.width = width.round() as i32;
            hints.height = height.round() as i32;
            (xlib.XSetWMNormalHints)(display, id, &mut hints);

            // `_NET_WM_WINDOW_TYPE_UTILITY`: a small tool window, which window
            // managers keep out of the taskbar and alt-tab. `DIALOG` would want
            // a `WM_TRANSIENT_FOR` parent and a tray-only app has none.
            set_atoms(
                xlib,
                display,
                id,
                "_NET_WM_WINDOW_TYPE",
                &["_NET_WM_WINDOW_TYPE_UTILITY"],
            );

            // `_NET_WM_STATE`: never in the taskbar or pager, always above.
            set_atoms(
                xlib,
                display,
                id,
                "_NET_WM_STATE",
                &[
                    "_NET_WM_STATE_SKIP_TASKBAR",
                    "_NET_WM_STATE_SKIP_PAGER",
                    "_NET_WM_STATE_ABOVE",
                ],
            );

            // Decorations off. GPUI's `request_decorations(Client)` already sets
            // the motif hint for a frameless window; this is idempotent and also
            // covers a server-decorations fallback. The five words are
            // flags=MWM_HINTS_DECORATIONS, functions=0, decorations=0, ...
            let motif = (xlib.XInternAtom)(display, b"_MOTIF_WM_HINTS\0".as_ptr() as *const _, 0);
            if motif != 0 {
                let data: [u32; 5] = [1 << 1, 0, 0, 0, 0];
                (xlib.XChangeProperty)(
                    display,
                    id,
                    motif,
                    motif,
                    32,
                    xlib::PropModeReplace,
                    data.as_ptr() as *const std::os::raw::c_uchar,
                    5,
                );
            }

            (xlib.XFlush)(display);
        })
    }

    /// Sets an `ATOM[]` property to the interned atoms named in `values`.
    ///
    /// Replaces the property (`PropModeReplace`), which is what the window
    /// manager reads once, when the window is mapped.
    ///
    /// # Safety
    ///
    /// `display` must be an open X connection and `window` a valid window id on it.
    unsafe fn set_atoms(
        xlib: &xlib::Xlib,
        display: *mut xlib::Display,
        window: xlib::Window,
        property: &str,
        values: &[&str],
    ) {
        let property_atom =
            (xlib.XInternAtom)(display, format!("{property}\0").as_ptr() as *const _, 0);
        if property_atom == 0 {
            return;
        }
        let atoms: Vec<u64> = values
            .iter()
            .map(|value| (xlib.XInternAtom)(display, format!("{value}\0").as_ptr() as *const _, 0))
            .filter(|atom| *atom != 0)
            .collect();
        if atoms.is_empty() {
            return;
        }
        (xlib.XChangeProperty)(
            display,
            window,
            property_atom,
            xlib::XA_ATOM,
            32,
            xlib::PropModeReplace,
            atoms.as_ptr() as *const std::os::raw::c_uchar,
            atoms.len() as i32,
        );
    }

    /// Asks the window manager to make `window` the active window.
    ///
    /// `activate_window()` sends `_NET_ACTIVE_WINDOW` with source indication 1
    /// (a normal application request) and `CurrentTime`. Both are the parts a
    /// focus stealing prevention check distrusts: the request carries no
    /// timestamp from the event that caused it (a tray click arrives over D-Bus,
    /// which has no X timestamp), so a strict window manager may map the popover
    /// without focusing it — and without focus the popover can never see the
    /// deactivation that dismisses it. Source indication 2 (a pager / taskbar)
    /// is trusted to set focus, and a fresh server timestamp avoids the
    /// "timestamp in the past" rejection.
    pub fn activate_popover(window: &Window) -> Result<(), String> {
        // SAFETY: `display` is an open connection and `id` a window id for the whole closure; `with_display` closes the connection afterwards.
        with_window(window, |xlib, display, id| unsafe {
            let root = (xlib.XDefaultRootWindow)(display);
            let atom = (xlib.XInternAtom)(display, b"_NET_ACTIVE_WINDOW\0".as_ptr() as *const _, 0);
            let mut event: xlib::XEvent = std::mem::zeroed();
            {
                let message = &mut event.client_message;
                message.type_ = xlib::ClientMessage;
                message.display = display;
                message.window = id;
                message.message_type = atom;
                message.format = 32;
                // data = [source indication, timestamp, requestor, 0, 0]
                message.data.set_long(0, 2);
                message.data.set_long(1, xlib::CurrentTime as i64);
                message.data.set_long(2, id as i64);
            }
            (xlib.XSendEvent)(
                display,
                root,
                0,
                xlib::SubstructureRedirectMask | xlib::SubstructureNotifyMask,
                &mut event,
            );
            (xlib.XFlush)(display);
        })
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
mod imp {
    use gpui::Window;

    const UNSUPPORTED: &str =
        "window positioning and raising are not implemented on this platform yet";

    pub fn set_position(_window: &mut Window, _x: f32, _y: f32) -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }
    pub fn set_always_on_top(_window: &mut Window, _on: bool) -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }
    pub fn set_min_size(_window: &mut Window, _w: f32, _h: f32) -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }
    pub fn set_max_size(_window: &mut Window, _w: f32, _h: f32) -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }
    pub fn set_resizable(_window: &mut Window, _resizable: bool) -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }
    pub fn show(_window: &mut Window) -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }
    pub fn hide(_window: &mut Window) -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }
    pub fn is_minimized(_window: &Window) -> bool {
        false
    }
    pub fn is_maximized(window: &Window) -> bool {
        window.is_maximized()
    }
    pub fn prepare_popover(
        _window: &mut Window,
        _x: f32,
        _y: f32,
        _width: f32,
        _height: f32,
    ) -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }
    pub fn activate_popover(_window: &Window) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(not(target_os = "macos"))]
pub use imp::*;

#[cfg(target_os = "macos")]
pub fn set_accessory_app(accessory: bool) {
    use objc::{class, msg_send, sel, sel_impl};
    const REGULAR: isize = 0;
    const ACCESSORY: isize = 1;
    // SAFETY: the shared `NSApplication` is messaged from the main thread.
    unsafe {
        let app: cocoa::base::id = msg_send![class!(NSApplication), sharedApplication];
        let policy = if accessory { ACCESSORY } else { REGULAR };
        let _: bool = msg_send![app, setActivationPolicy: policy];
    }
}

#[cfg(not(target_os = "macos"))]
pub fn set_accessory_app(_accessory: bool) {}

/// Gives an unbundled run (`cargo run`) a Dock icon. A `.app` takes its icon
/// from its bundle, so a bundled run is left alone.
#[cfg(target_os = "macos")]
pub fn set_dock_icon(path: &std::path::Path) {
    use cocoa::base::{id, nil};
    use cocoa::foundation::NSString;
    use objc::{class, msg_send, sel, sel_impl};
    let Some(path) = path.to_str() else {
        return;
    };
    // SAFETY: the shared `NSApplication` and `NSBundle` are messaged from the
    // main thread; the image is retained by the application once set.
    unsafe {
        let bundle: id = msg_send![class!(NSBundle), mainBundle];
        let bundle_path: id = msg_send![bundle, bundlePath];
        let suffix = NSString::alloc(nil).init_str(".app");
        let bundled: bool = msg_send![bundle_path, hasSuffix: suffix];
        let _: () = msg_send![suffix, release];
        if bundled {
            return;
        }
        let file = NSString::alloc(nil).init_str(path);
        let image: id = msg_send![class!(NSImage), alloc];
        let image: id = msg_send![image, initWithContentsOfFile: file];
        let _: () = msg_send![file, release];
        if image.is_null() {
            log::warn!("[desktop] could not load the Dock icon {path}");
            return;
        }
        let app: id = msg_send![class!(NSApplication), sharedApplication];
        let _: () = msg_send![app, setApplicationIconImage: image];
        let _: () = msg_send![image, release];
    }
}

#[cfg(not(target_os = "macos"))]
pub fn set_dock_icon(_path: &std::path::Path) {}

/// Gives a window its icon on Windows, which is what the title bar and the
/// taskbar show. The executable carries no icon of its own in a dev build, so
/// without this the window keeps the default one.
///
/// `WM_SETICON` takes an `HICON`, and Windows (Vista and later) builds one from
/// PNG bytes directly, so the file is passed through unchanged. One icon is
/// made per size: the large one for the taskbar, the small one for the title
/// bar.
#[cfg(target_os = "windows")]
pub fn set_window_icon(window: &gpui::Window, path: &std::path::Path) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateIconFromResourceEx, GetSystemMetrics, SendMessageW, ICON_BIG, ICON_SMALL,
        LR_DEFAULTCOLOR, SM_CXICON, SM_CXSMICON, WM_SETICON,
    };

    let Ok(bytes) = std::fs::read(path) else {
        log::warn!(
            "[desktop] could not read the window icon {}",
            path.display()
        );
        return;
    };
    let Ok(handle) = HasWindowHandle::window_handle(window) else {
        return;
    };
    let RawWindowHandle::Win32(win32) = handle.as_raw() else {
        return;
    };
    let hwnd = win32.hwnd.get() as _;
    // The icon resource version `CreateIconFromResourceEx` expects for an icon.
    const ICON_VERSION: u32 = 0x0003_0000;
    for (metric, which) in [(SM_CXICON, ICON_BIG), (SM_CXSMICON, ICON_SMALL)] {
        // SAFETY: `bytes` is alive for the call and the length matches it; `hwnd`
        // comes from the window's raw handle, which GPUI keeps valid while the
        // window lives. The icon is handed to the window, which owns it after that.
        unsafe {
            let edge = GetSystemMetrics(metric);
            let icon = CreateIconFromResourceEx(
                bytes.as_ptr(),
                bytes.len() as u32,
                1,
                ICON_VERSION,
                edge,
                edge,
                LR_DEFAULTCOLOR,
            );
            if icon.is_null() {
                log::warn!(
                    "[desktop] could not build the window icon from {}",
                    path.display()
                );
                continue;
            }
            SendMessageW(hwnd, WM_SETICON, which as usize, icon as isize);
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn set_window_icon(_window: &gpui::Window, _path: &std::path::Path) {}

/// Gives a window the app's icon, as a dev run is told it through
/// `RN_GPUI_APP_ICON`. For every window the app opens: the icon is per window on
/// Windows, so the one opened at startup is not enough. A packaged app has its
/// icon in its executable, and the variable is unset.
pub fn apply_app_icon(window: &gpui::Window) {
    if let Some(icon) = std::env::var_os("RN_GPUI_APP_ICON") {
        set_window_icon(window, std::path::Path::new(&icon));
    }
}

#[cfg(target_os = "macos")]
pub fn disable_window_animation(window: &mut gpui::Window) {
    use cocoa::base::id;
    use objc::{msg_send, sel, sel_impl};
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    const NONE: i64 = 2;
    let Ok(handle) = HasWindowHandle::window_handle(window) else {
        return;
    };
    if let RawWindowHandle::AppKit(appkit) = handle.as_raw() {
        // SAFETY: `ns_view` comes from the window's raw handle, which GPUI keeps valid while the window lives.
        unsafe {
            let ns_view = appkit.ns_view.as_ptr() as id;
            let native: id = msg_send![ns_view, window];
            if !native.is_null() {
                let _: () = msg_send![native, setAnimationBehavior: NONE];
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn disable_window_animation(_window: &mut gpui::Window) {}

#[cfg(target_os = "macos")]
pub fn style_as_popover(window: &mut gpui::Window) {
    use cocoa::base::{id, NO, YES};
    use objc::{msg_send, sel, sel_impl};
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    let Ok(handle) = HasWindowHandle::window_handle(window) else {
        return;
    };
    if let RawWindowHandle::AppKit(appkit) = handle.as_raw() {
        // SAFETY: `ns_view` comes from the window's raw handle, which GPUI keeps valid while the window lives.
        unsafe {
            let ns_view = appkit.ns_view.as_ptr() as id;
            let native: id = msg_send![ns_view, window];
            if native.is_null() {
                return;
            }
            let _: () = msg_send![native, setMovable: NO];
            let _: () = msg_send![native, setMovableByWindowBackground: NO];
            let _: () = msg_send![native, setHasShadow: YES];
            // NSWindowCloseButton, NSWindowMiniaturizeButton, NSWindowZoomButton.
            for button in 0..3u64 {
                let button: id = msg_send![native, standardWindowButton: button];
                if !button.is_null() {
                    let _: () = msg_send![button, setHidden: YES];
                }
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn style_as_popover(_window: &mut gpui::Window) {}

/// `tray-icon` reports physical pixels; windows and menus are placed in points.
#[cfg(target_os = "macos")]
pub fn primary_screen_scale() -> f32 {
    use cocoa::base::id;
    use objc::{class, msg_send, sel, sel_impl};

    // SAFETY: `NSScreen` class messages return objects that are null-checked before use.
    unsafe {
        let screens: id = msg_send![class!(NSScreen), screens];
        let screen: id = msg_send![screens, firstObject];
        if screen.is_null() {
            return 1.0;
        }
        let scale: f64 = msg_send![screen, backingScaleFactor];
        if scale > 0.0 {
            scale as f32
        } else {
            1.0
        }
    }
}

/// Windows reports the tray icon's rectangle in physical pixels as well, and the
/// popover is placed in points, so the rectangle has to be divided by the scale
/// of the display the taskbar is on — the primary one.
#[cfg(target_os = "windows")]
pub fn primary_screen_scale() -> f32 {
    use windows_sys::Win32::UI::HiDpi::GetDpiForSystem;
    // SAFETY: `GetDpiForSystem` takes no arguments and only reads the process's DPI state.
    let dpi = unsafe { GetDpiForSystem() };
    if dpi == 0 {
        1.0
    } else {
        dpi as f32 / 96.0
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn primary_screen_scale() -> f32 {
    1.0
}

/// The usable area of the display holding the point `(x, y)` — the screen minus
/// the taskbar — as `(x, y, width, height)` in points. `None` where it cannot be
/// asked, and the popover is then left where the icon puts it.
#[cfg(target_os = "windows")]
pub fn work_area_at(x: f32, y: f32) -> Option<(f32, f32, f32, f32)> {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    let scale = primary_screen_scale();
    let point = POINT {
        x: (x * scale).round() as i32,
        y: (y * scale).round() as i32,
    };
    // SAFETY: `monitor` comes from `MonitorFromPoint` and is checked for null; `info` is a
    // properly sized, initialised `MONITORINFO` that `GetMonitorInfoW` fills in.
    unsafe {
        let monitor = MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST);
        if monitor.is_null() {
            return None;
        }
        let mut info: MONITORINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(monitor, &mut info) == 0 {
            return None;
        }
        let work = info.rcWork;
        Some((
            work.left as f32 / scale,
            work.top as f32 / scale,
            (work.right - work.left) as f32 / scale,
            (work.bottom - work.top) as f32 / scale,
        ))
    }
}

#[cfg(not(target_os = "windows"))]
pub fn work_area_at(_x: f32, _y: f32) -> Option<(f32, f32, f32, f32)> {
    None
}

/// What the OS itself has for a window: `(left, top, right, bottom, visible)`, in
/// physical pixels. GPUI's own bounds are what it believes, and for a window
/// created hidden on Windows the two have differed, so a test that wants to know
/// what a user sees asks the OS.
#[cfg(all(target_os = "windows", feature = "test-driver"))]
pub fn native_frame(window: &gpui::Window) -> Option<(i32, i32, i32, i32, bool)> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowRect, IsWindowVisible};
    let handle = HasWindowHandle::window_handle(window).ok()?;
    let RawWindowHandle::Win32(win32) = handle.as_raw() else {
        return None;
    };
    let hwnd = win32.hwnd.get() as _;
    let mut rect = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    // SAFETY: `hwnd` comes from the window's raw handle, which GPUI keeps valid while the window
    // lives, and `rect` is a properly initialised `RECT` the call fills in.
    unsafe {
        if GetWindowRect(hwnd, &mut rect) == 0 {
            return None;
        }
        Some((
            rect.left,
            rect.top,
            rect.right,
            rect.bottom,
            IsWindowVisible(hwnd) != 0,
        ))
    }
}
