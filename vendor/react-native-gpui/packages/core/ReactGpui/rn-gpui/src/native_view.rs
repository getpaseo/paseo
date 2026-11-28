//! The macOS-only window helpers.

use cocoa::{base::id, foundation::NSRect};
use gpui::Window;
use objc::{msg_send, sel, sel_impl};

pub use crate::native_surface::{NativeSurface, NativeSurfaceElement, NativeViewHandle, Result};
pub use cocoa as appkit;
pub use objc as objective_c;

/// AppKit's content layout rectangle excludes the actual title-bar region.
/// Read it on the GPUI thread; ordinary decorated windows return zero.
pub(crate) fn window_top_inset(window: &Window) -> f32 {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    if window.is_fullscreen() || window.is_simple_fullscreen() {
        return 0.0;
    }
    let Ok(handle) = HasWindowHandle::window_handle(window) else {
        return 0.0;
    };
    let RawWindowHandle::AppKit(handle) = handle.as_raw() else {
        return 0.0;
    };
    // SAFETY: `ns_view` comes from the window's raw handle, which GPUI keeps valid while the window lives.
    unsafe {
        let view = handle.ns_view.as_ptr() as id;
        let native_window: id = msg_send![view, window];
        if native_window.is_null() {
            return 0.0;
        }
        let content: id = msg_send![native_window, contentView];
        let bounds: NSRect = msg_send![content, bounds];
        let layout: NSRect = msg_send![native_window, contentLayoutRect];
        (bounds.size.height - layout.origin.y - layout.size.height).max(0.0) as f32
    }
}

#[cfg(feature = "visual-capture")]
pub(crate) fn activate_accessibility_probe(window: &Window) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    let Ok(handle) = HasWindowHandle::window_handle(window) else {
        return;
    };
    let RawWindowHandle::AppKit(handle) = handle.as_raw() else {
        return;
    };
    // SAFETY: `ns_view` comes from the window's raw handle, which GPUI keeps valid while the window lives.
    unsafe {
        let native_window: id = msg_send![handle.ns_view.as_ptr() as id, window];
        let content: id = msg_send![native_window, contentView];
        let _: id = msg_send![content, accessibilityChildren];
    }
}

#[cfg(feature = "visual-capture")]
pub(crate) fn set_probe_titlebar_transparent(window: &Window, transparent: bool) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    let Ok(handle) = HasWindowHandle::window_handle(window) else {
        return;
    };
    let RawWindowHandle::AppKit(handle) = handle.as_raw() else {
        return;
    };
    // SAFETY: `ns_view` comes from the window's raw handle, which GPUI keeps valid while the window lives.
    unsafe {
        let native_window: id = msg_send![handle.ns_view.as_ptr() as id, window];
        let mask: u64 = msg_send![native_window, styleMask];
        let full_size = cocoa::appkit::NSWindowStyleMask::NSFullSizeContentViewWindowMask.bits();
        let next = if transparent {
            mask | full_size
        } else {
            mask & !full_size
        };
        let _: () = msg_send![native_window, setStyleMask: next];
        let _: () = msg_send![native_window, setTitlebarAppearsTransparent: if transparent {cocoa::base::YES} else {cocoa::base::NO}];
    }
}

#[cfg(feature = "test-driver")]
pub(crate) fn test_accessibility_node(
    window: &Window,
    identifier: &str,
) -> Option<serde_json::Value> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    /// # Safety
    ///
    /// `value` must be a valid `NSString` or nil.
    unsafe fn string(value: id) -> String {
        if value.is_null() {
            return String::new();
        }
        let utf8: *const std::ffi::c_char = msg_send![value, UTF8String];
        if utf8.is_null() {
            String::new()
        } else {
            std::ffi::CStr::from_ptr(utf8)
                .to_string_lossy()
                .into_owned()
        }
    }
    /// # Safety
    ///
    /// `element` must be a valid accessibility element or nil.
    unsafe fn find(element: id, identifier: &str, budget: &mut usize) -> Option<serde_json::Value> {
        if element.is_null() || *budget == 0 {
            return None;
        }
        *budget -= 1;
        let responds: bool = msg_send![element, respondsToSelector: sel!(accessibilityIdentifier)];
        if responds {
            let author: id = msg_send![element, accessibilityIdentifier];
            if string(author) == identifier {
                let label: id = msg_send![element, accessibilityLabel];
                let title: id = msg_send![element, accessibilityTitle];
                let role: id = msg_send![element, accessibilityRole];
                let help: id = msg_send![element, accessibilityHelp];
                let enabled: bool = msg_send![element, isAccessibilityEnabled];
                let name = string(label);
                return Some(
                    serde_json::json!({"identifier":identifier,"name":if name.is_empty(){string(title)}else{name},"role":string(role),"hint":string(help),"enabled":enabled}),
                );
            }
        }
        let responds: bool = msg_send![element, respondsToSelector: sel!(accessibilityChildren)];
        if responds {
            let children: id = msg_send![element, accessibilityChildren];
            if !children.is_null() {
                let count: usize = msg_send![children, count];
                for index in 0..count.min(*budget) {
                    let child: id = msg_send![children, objectAtIndex:index];
                    if let Some(node) = find(child, identifier, budget) {
                        return Some(node);
                    }
                }
            }
        }
        None
    }
    let handle = HasWindowHandle::window_handle(window).ok()?;
    let RawWindowHandle::AppKit(handle) = handle.as_raw() else {
        return None;
    };
    // SAFETY: `ns_view` comes from the window's raw handle, which GPUI keeps valid while the window lives.
    unsafe {
        let native_window: id = msg_send![handle.ns_view.as_ptr() as id, window];
        let content: id = msg_send![native_window, contentView];
        find(content, identifier, &mut 10000)
    }
}

#[cfg(feature = "test-driver")]
pub(crate) fn test_window_visible(window: &Window) -> bool {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    let Ok(handle) = HasWindowHandle::window_handle(window) else {
        return false;
    };
    let RawWindowHandle::AppKit(handle) = handle.as_raw() else {
        return false;
    };
    // SAFETY: `ns_view` comes from the window's raw handle, which GPUI keeps valid while the window lives.
    unsafe {
        let native_window: id = msg_send![handle.ns_view.as_ptr() as id, window];
        msg_send![native_window, isVisible]
    }
}

/// The window as the compositor shows it, native views included, as PNG bytes
/// with its size in pixels. Capturing a window of this process needs no
/// permission. The window must be on screen.
#[cfg(feature = "test-driver")]
pub(crate) fn test_composite_png(window: &Window) -> Result<(Vec<u8>, usize, usize), String> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    #[repr(C)]
    struct CGPoint {
        x: f64,
        y: f64,
    }
    #[repr(C)]
    struct CGSize {
        width: f64,
        height: f64,
    }
    #[repr(C)]
    struct CGRect {
        origin: CGPoint,
        size: CGSize,
    }
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGWindowListCreateImage(
            bounds: CGRect,
            list_option: u32,
            window: u32,
            image_option: u32,
        ) -> *mut std::ffi::c_void;
        fn CGImageRelease(image: *mut std::ffi::c_void);
        fn CGImageGetWidth(image: *const std::ffi::c_void) -> usize;
        fn CGImageGetHeight(image: *const std::ffi::c_void) -> usize;
    }
    const INCLUDING_WINDOW: u32 = 1 << 3;
    const BOUNDS_IGNORE_FRAMING: u32 = 1 << 0;
    const PNG_FILE_TYPE: usize = 4;

    let handle = HasWindowHandle::window_handle(window).map_err(|error| error.to_string())?;
    let RawWindowHandle::AppKit(handle) = handle.as_raw() else {
        return Err("the window is not an AppKit window".into());
    };
    // SAFETY: `ns_view` comes from the window's raw handle, which GPUI keeps valid while the window lives; the image and the bitmap are released once, and everything runs on the main thread.
    unsafe {
        let native_window: id = msg_send![handle.ns_view.as_ptr() as id, window];
        let number: i64 = msg_send![native_window, windowNumber];
        let null = CGRect {
            origin: CGPoint {
                x: f64::INFINITY,
                y: f64::INFINITY,
            },
            size: CGSize {
                width: 0.0,
                height: 0.0,
            },
        };
        let image =
            CGWindowListCreateImage(null, INCLUDING_WINDOW, number as u32, BOUNDS_IGNORE_FRAMING);
        if image.is_null() {
            return Err("the window could not be captured; is it on screen?".into());
        }
        let (width, height) = (CGImageGetWidth(image), CGImageGetHeight(image));
        let allocated: id = msg_send![objc::class!(NSBitmapImageRep), alloc];
        let representation: id = msg_send![allocated, initWithCGImage: image];
        let data: id = msg_send![representation, representationUsingType: PNG_FILE_TYPE properties: cocoa::base::nil];
        let length: usize = msg_send![data, length];
        let bytes: *const u8 = msg_send![data, bytes];
        let png = std::slice::from_raw_parts(bytes, length).to_vec();
        let _: () = msg_send![representation, release];
        CGImageRelease(image);
        Ok((png, width, height))
    }
}
