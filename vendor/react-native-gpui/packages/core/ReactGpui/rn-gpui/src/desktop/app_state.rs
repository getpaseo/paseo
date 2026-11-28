//! `AppState`: whether the app is in front, behind other apps, or out of sight.
//!
//! Derived from the window state mirror. A change is reported a short moment
//! after the window that caused it, so moving focus from one app window to
//! another, which blurs the first before it focuses the second, reports
//! nothing.

use gpui::App;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WindowFacts {
    pub focused: bool,
    pub minimized: bool,
    pub visible: bool,
}

pub fn state_from(windows: &[WindowFacts]) -> &'static str {
    if windows.iter().any(|window| window.focused) {
        "active"
    } else if windows
        .iter()
        .any(|window| window.visible && !window.minimized)
    {
        "inactive"
    } else {
        "background"
    }
}

static PENDING: AtomicBool = AtomicBool::new(false);
static LAST: Mutex<&'static str> = Mutex::new("active");

/// How long window changes are gathered before the state is re-evaluated. The
/// system delivers the blur of one window and the focus of the next separately,
/// and under load they can be several frames apart.
const SETTLE: Duration = Duration::from_millis(80);

/// Re-evaluates the state once the windows have settled, however many changed.
pub fn schedule(cx: &mut App) {
    if PENDING.swap(true, Ordering::AcqRel) {
        return;
    }
    let timer = cx.background_executor().timer(SETTLE);
    cx.spawn(async move |cx| {
        timer.await;
        PENDING.store(false, Ordering::Release);
        cx.update(apply);
    })
    .detach();
}

fn apply(cx: &mut App) {
    let state = state_from(&super::window_mirror::facts());
    {
        let mut last = LAST.lock().expect("app state poisoned");
        if *last == state {
            return;
        }
        *last = state;
    }
    if let Some(store) = crate::store::store_from(cx) {
        store.read(cx).host.set_app_state(state);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(focused: bool, minimized: bool, visible: bool) -> WindowFacts {
        WindowFacts {
            focused,
            minimized,
            visible,
        }
    }

    #[test]
    fn a_focused_window_makes_the_app_active() {
        assert_eq!(
            state_from(&[window(false, false, true), window(true, false, true)]),
            "active"
        );
    }

    #[test]
    fn visible_windows_without_focus_make_it_inactive() {
        assert_eq!(state_from(&[window(false, false, true)]), "inactive");
    }

    #[test]
    fn minimised_or_hidden_windows_make_it_background() {
        assert_eq!(state_from(&[window(false, true, true)]), "background");
        assert_eq!(state_from(&[window(false, false, false)]), "background");
        assert_eq!(state_from(&[]), "background");
    }
}
