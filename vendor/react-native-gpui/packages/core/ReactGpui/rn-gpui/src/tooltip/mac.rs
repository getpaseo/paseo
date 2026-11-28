//! The system tooltip: a tooltip rectangle on the window's view.

use super::Active;
use cocoa::base::{id, nil};
use cocoa::foundation::{NSPoint, NSRect, NSSize, NSString};
use objc::declare::ClassDecl;
use objc::runtime::{Class, Object, Sel};
use objc::{class, msg_send, sel, sel_impl};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use std::ffi::c_void;
use std::sync::Once;

fn owner_class() -> &'static Class {
    static REGISTER: Once = Once::new();
    REGISTER.call_once(|| {
        let mut declaration = ClassDecl::new("RNGpuiToolTipOwner", class!(NSObject))
            .expect("the tooltip owner class is registered once");
        // SAFETY: the signature matches the `NSToolTipOwner` informal protocol.
        unsafe {
            declaration.add_method(
                sel!(view:stringForToolTip:point:userData:),
                string_for_tool_tip
                    as extern "C" fn(&Object, Sel, id, isize, NSPoint, *mut c_void) -> id,
            );
        }
        declaration.register();
    });
    Class::get("RNGpuiToolTipOwner").expect("the tooltip owner class exists")
}

extern "C" fn string_for_tool_tip(
    _this: &Object,
    _selector: Sel,
    _view: id,
    _tag: isize,
    _point: NSPoint,
    data: *mut c_void,
) -> id {
    let tag = data as isize as i32;
    let Some(active) = super::active().filter(|active| active.tag == tag) else {
        return nil;
    };
    // SAFETY: the string is autoreleased, as AppKit expects of a returned object.
    unsafe {
        let string = NSString::alloc(nil).init_str(&active.text);
        msg_send![string, autorelease]
    }
}

fn owner() -> id {
    thread_local! {
        static OWNER: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    }
    OWNER.with(|owner| {
        if owner.get() == 0 {
            // SAFETY: the owner is allocated once and kept for the process.
            let object: id = unsafe { msg_send![owner_class(), new] };
            owner.set(object as usize);
        }
        owner.get() as id
    })
}

fn ns_view(window: &gpui::Window) -> Option<id> {
    let handle = HasWindowHandle::window_handle(window).ok()?;
    match handle.as_raw() {
        RawWindowHandle::AppKit(appkit) => Some(appkit.ns_view.as_ptr() as id),
        _ => None,
    }
}

/// The system tooltip text for a view, as AppKit's call to the owner gets it, and
/// how many tracking areas the window's view has.
pub(crate) fn probe(window: &gpui::Window, tag: i32) -> (Option<String>, usize) {
    let Some(view) = ns_view(window) else {
        return (None, 0);
    };
    // SAFETY: AppKit is messaged on the main thread with the window's view and
    // the tooltip owner; the string is read before the autorelease pool drains.
    unsafe {
        let areas: id = msg_send![view, trackingAreas];
        let count: usize = msg_send![areas, count];
        let string: id = msg_send![owner(), view: view
            stringForToolTip: 0isize
            point: NSPoint::new(0.0, 0.0)
            userData: tag as isize as *mut c_void];
        let text = if string.is_null() {
            None
        } else {
            let bytes: *const std::os::raw::c_char = msg_send![string, UTF8String];
            Some(
                std::ffi::CStr::from_ptr(bytes)
                    .to_string_lossy()
                    .into_owned(),
            )
        };
        (text, count)
    }
}

/// Replaces the window's tooltip rectangle with the one for `active`, or none.
pub(super) fn apply(window: &mut gpui::Window, active: Option<&Active>) {
    let Some(view) = ns_view(window) else {
        return;
    };
    // SAFETY: AppKit is messaged on the main thread, with the window's own view.
    unsafe {
        let _: () = msg_send![view, removeAllToolTips];
        let Some(active) = active else {
            return;
        };
        let bounds: NSRect = msg_send![view, bounds];
        let (x, y, width, height) = active.rect;
        let rect = NSRect::new(
            NSPoint::new(x as f64, bounds.size.height - (y + height) as f64),
            NSSize::new(width as f64, height as f64),
        );
        let _: isize = msg_send![view, addToolTipRect: rect
            owner: owner()
            userData: active.tag as isize as *mut c_void];
    }
}
