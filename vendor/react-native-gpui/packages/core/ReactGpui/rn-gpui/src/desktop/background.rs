//! A run that must not disturb the person using the machine.
//!
//! With the test driver on, or `RN_GPUI_BACKGROUND=1`, the app never activates
//! itself, never becomes the frontmost application, and puts its windows behind
//! everything else instead of in front. Focus is logical: `setWindowActive`
//! gives a window focus and key events without the operating system's help.
//! `RN_GPUI_BACKGROUND=0` turns it off for a test run someone is watching.

use gpui::WindowOptions;
use std::sync::OnceLock;

/// Whether this run stays in the background.
pub fn enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        resolve(
            std::env::var("RN_GPUI_BACKGROUND").ok().as_deref(),
            cfg!(feature = "test-driver")
                && std::env::var_os("RN_GPUI_TEST_DRIVER").is_some_and(|value| value != "0"),
        )
    })
}

fn resolve(background: Option<&str>, driver: bool) -> bool {
    match background {
        Some(value) => !matches!(value, "" | "0" | "false" | "no"),
        None => driver,
    }
}

#[cfg(test)]
mod tests {
    use super::resolve;

    #[test]
    fn the_test_driver_turns_it_on_and_the_variable_decides_either_way() {
        assert!(resolve(None, true));
        assert!(!resolve(None, false));
        assert!(resolve(Some("1"), false));
        assert!(!resolve(Some("0"), true));
    }
}

/// Changes a window's options so that opening it takes no focus and shows
/// nothing in front. Returns whether the window is to be shown behind the
/// others once it is open (see [`show_behind`]).
pub fn prepare(options: &mut WindowOptions) -> bool {
    if !enabled() {
        return false;
    }
    options.focus = false;
    if cfg!(target_os = "macos") {
        let visible = options.show;
        options.show = false;
        return visible;
    }
    false
}

/// Shows a window that [`prepare`] opened hidden, behind the others.
pub fn show_behind(window: &mut gpui::Window) {
    if let Err(error) = super::platform_window::show_behind(window) {
        log::debug!("[background] could not show a window behind the others: {error}");
    }
}

/// The backing scale factor of the display with this id, where the platform can
/// say: how many device pixels a point is on that display.
#[cfg(target_os = "macos")]
pub(crate) fn display_scale(id: u64) -> Option<f32> {
    use cocoa::base::{id as object, nil};
    use cocoa::foundation::{NSArray, NSString};
    use objc::{class, msg_send, sel, sel_impl};
    // SAFETY: AppKit is read on the main thread, where displays are chosen; the
    // objects are autoreleased and only read here.
    unsafe {
        let displays: object = msg_send![class!(NSScreen), screens];
        let key = NSString::alloc(nil).init_str("NSScreenNumber");
        for index in 0..NSArray::count(displays) {
            let screen: object = NSArray::objectAtIndex(displays, index);
            let description: object = msg_send![screen, deviceDescription];
            let number: object = msg_send![description, objectForKey: key];
            if number == nil {
                continue;
            }
            let screen_id: u32 = msg_send![number, unsignedIntValue];
            if u64::from(screen_id) == id {
                let scale: f64 = msg_send![screen, backingScaleFactor];
                return Some(scale as f32);
            }
        }
    }
    None
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn display_scale(_id: u64) -> Option<f32> {
    None
}

/// The display a test window opens on: `RN_GPUI_TEST_DISPLAY` names an index
/// into the platform's list of displays, `main`, `secondary`, or `retina`, the
/// display with the highest scale factor when that is at least 2. A background
/// run opens on the secondary display when there is one. A display that does
/// not exist falls back to the main one, with a log line.
pub fn test_display(cx: &gpui::App) -> Option<std::rc::Rc<dyn gpui::PlatformDisplay>> {
    let requested = std::env::var("RN_GPUI_TEST_DISPLAY").ok();
    if requested.is_none() && !enabled() {
        return None;
    }
    // The test platform has its one display, and AppKit is not asked.
    #[cfg(feature = "test-driver")]
    if crate::headless::enabled() {
        return None;
    }
    let displays = cx.displays();
    let primary = cx.primary_display()?;
    let wanted = requested.as_deref().unwrap_or("secondary");
    let chosen = match wanted {
        "main" | "primary" => Some(primary.clone()),
        "retina" => displays
            .iter()
            .filter_map(|display| {
                let scale = display_scale(display.id().into())?;
                (scale >= 2.0).then_some((scale, display.clone()))
            })
            .max_by(|a, b| a.0.total_cmp(&b.0))
            .map(|(_, display)| display),
        "secondary" => displays
            .iter()
            .find(|display| display.id() != primary.id())
            .cloned(),
        index => index
            .parse::<usize>()
            .ok()
            .and_then(|index| displays.get(index).cloned()),
    };
    match chosen {
        Some(display) => Some(display),
        None => {
            if requested.is_some() {
                log::info!(
                    "[background] RN_GPUI_TEST_DISPLAY={wanted} names no display of {}; using the main display",
                    displays.len()
                );
            }
            Some(primary)
        }
    }
}
