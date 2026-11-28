//! Headless test runs: `RN_GPUI_TEST_HEADLESS=1` in a `test-driver` build.
//!
//! The app starts exactly as it does on the real platform (same bundle, same
//! bootstrap, same test driver on the same socket), but on GPUI's test
//! platform instead of AppKit, X11/Wayland or Win32: no window is created, no
//! display or window server is asked for, and nothing reaches the GPU. Windows
//! are GPUI test windows that draw their scenes with the offscreen renderer
//! from `gpui_platform`'s test rendering: the CPU (tiny-skia) one where no GPU
//! renderer can be made, or always with `GPUI_TEST_RENDERER=cpu`. That is what
//! the driver's `screenshot` reads through `Window::render_to_image`.
//!
//! The test platform has no run loop of its own, so [`run`] is one: it runs
//! the tasks that are ready, moves the scheduler's clock along with the wall
//! clock (GPUI timers fire on it), and delivers a frame to every window every
//! [`FRAME`], which is what animations and the per-frame hook wait for. Work
//! from other threads (the JS thread, the driver's socket) wakes it.
//!
//! What the test platform does not have is listed in `docs/desktop-testing.md`.

use gpui::{App, AppContext as _, TestAppContext, TestDispatcher};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

/// The environment variable that turns headless runs on.
pub(crate) const ENV: &str = "RN_GPUI_TEST_HEADLESS";

/// How often a window gets a frame: the display tick of a 60 Hz screen.
const FRAME: Duration = Duration::from_millis(16);

/// Whether this run is headless.
pub(crate) fn enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var(ENV).is_ok_and(|value| matches!(value.trim(), "1" | "true" | "yes"))
    })
}

/// Starts the app on GPUI's test platform with `launch`, the closure the real
/// platform's `Application::run` is given, and runs it until its last window
/// closes or the process is stopped. Never returns.
pub(crate) fn run(
    http_client: Arc<dyn ::http_client::HttpClient>,
    launch: impl FnOnce(&mut App),
) -> ! {
    // Built on this thread, which the scheduler then treats as the main one.
    let dispatcher = TestDispatcher::new(0);
    // Wakes from other threads are the point here, not a determinism bug.
    dispatcher.allow_parking();
    let mut cx = TestAppContext::build(dispatcher.clone(), None);
    cx.enable_rendering(gpui_platform::test_rendering());
    if let Some(assets) = crate::app_hooks::registered_assets() {
        cx.set_asset_source(assets);
    }
    log::info!(
        "headless test run on GPUI's test platform (GPUI_TEST_RENDERER={})",
        std::env::var("GPUI_TEST_RENDERER").unwrap_or_default()
    );
    cx.update(|cx| {
        cx.set_http_client(http_client);
        launch(cx);
    });

    let mut last_tick = Instant::now();
    let mut next_frame = last_tick + FRAME;
    let mut had_window = false;
    loop {
        dispatcher.run_until_parked();
        let now = Instant::now();
        // Runs every timer that came due in the time that passed, in order.
        dispatcher.advance_clock(now - last_tick);
        last_tick = now;
        if now >= next_frame {
            next_frame = now + FRAME;
            for window in cx.windows() {
                let _ = cx.update_window(window, |_, window, cx| {
                    window.simulate_next_frame(cx);
                });
            }
        }
        if cx.windows().is_empty() {
            if had_window {
                log::info!("last headless window closed; exiting");
                break;
            }
        } else {
            had_window = true;
        }
        // Another thread's work unparks this one through the scheduler.
        std::thread::park_timeout(
            next_frame
                .saturating_duration_since(Instant::now())
                .min(Duration::from_millis(4)),
        );
    }
    cx.quit();
    std::process::exit(0);
}
