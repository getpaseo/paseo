//! Whether scroll bars are drawn the way a mouse-driven desktop draws them: always
//! shown, with a track, instead of the overlay bars of a trackpad.
//!
//! macOS decides from the connected pointing devices, or from the user's choice in
//! System Settings, and tells apps when that changes. `RN_GPUI_SCROLLER_STYLE`
//! (`legacy` or `overlay`) overrides it on every platform, so a test does not
//! depend on the machine.

use std::sync::atomic::{AtomicBool, Ordering};

static LEGACY: AtomicBool = AtomicBool::new(false);

/// Whether scroll bars are drawn as legacy, always visible, scrollers.
pub(crate) fn legacy() -> bool {
    LEGACY.load(Ordering::Relaxed)
}

fn forced() -> Option<bool> {
    match std::env::var("RN_GPUI_SCROLLER_STYLE").as_deref() {
        Ok("legacy") => Some(true),
        Ok("overlay") => Some(false),
        _ => None,
    }
}

/// Tells JavaScript and the windows that the style changed.
pub(crate) fn announce(cx: &mut gpui::App) {
    cx.refresh_windows();
    if let Some(store) = crate::store::store_from(cx) {
        store.read(cx).host.emit_device_event_json(
            "gpuiDesktop:scrollerStyle",
            &serde_json::json!({ "legacy": legacy() }).to_string(),
        );
    }
}

/// Sets the style, as a change of the system setting does, for tests.
#[cfg(feature = "test-driver")]
pub(crate) fn set_for_test(value: bool, cx: &mut gpui::App) {
    LEGACY.store(value, Ordering::Relaxed);
    announce(cx);
}

/// Reads the style, and on macOS calls `changed` whenever it changes.
pub(crate) fn install(changed: impl Fn() + Send + Sync + 'static) {
    if let Some(forced) = forced() {
        LEGACY.store(forced, Ordering::Relaxed);
        return;
    }
    #[cfg(target_os = "macos")]
    mac::install(changed);
    #[cfg(not(target_os = "macos"))]
    let _ = changed;
}

#[cfg(target_os = "macos")]
mod mac {
    use super::LEGACY;
    use block::ConcreteBlock;
    use cocoa::base::{id, nil};
    use cocoa::foundation::NSString;
    use objc::{class, msg_send, sel, sel_impl};
    use std::sync::atomic::Ordering;

    const LEGACY_STYLE: isize = 0;

    fn read() -> bool {
        // SAFETY: a class method of AppKit with no arguments.
        let style: isize = unsafe { msg_send![class!(NSScroller), preferredScrollerStyle] };
        style == LEGACY_STYLE
    }

    pub(super) fn install(changed: impl Fn() + Send + Sync + 'static) {
        LEGACY.store(read(), Ordering::Relaxed);
        // SAFETY: the observer block lives as long as the process and runs on the
        // main queue, which is where AppKit posts the notification.
        unsafe {
            let center: id = msg_send![class!(NSNotificationCenter), defaultCenter];
            let name =
                NSString::alloc(nil).init_str("NSPreferredScrollerStyleDidChangeNotification");
            let block = ConcreteBlock::new(move |_notification: id| {
                LEGACY.store(read(), Ordering::Relaxed);
                changed();
            })
            .copy();
            let queue: id = msg_send![class!(NSOperationQueue), mainQueue];
            let _: id = msg_send![center, addObserverForName: name object: nil queue: queue usingBlock: &*block];
            std::mem::forget(block);
        }
    }
}
