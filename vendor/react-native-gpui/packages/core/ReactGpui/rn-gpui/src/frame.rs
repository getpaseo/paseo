//! GPUI's frame hook is one-shot (`Window::on_next_frame`), so the chain
//! re-arms itself from inside the callback, only while React Native has work.
//! A platform can go idle with an outstanding one-shot callback, so
//! NativeAnimated also has a 16 ms foreground timer.

use crate::host::Host;
use gpui::Window;
use std::cell::Cell;
use std::rc::Rc;
use std::time::{Duration, Instant};

const ACTIVITY_WINDOW: Duration = Duration::from_millis(500);

#[derive(Clone)]
pub struct FrameHook {
    host: Host,
    state: Rc<State>,
}

struct State {
    epoch: Instant,
    active_until_ms: Cell<u64>,
    armed: Cell<bool>,
    /// Identifies the newest scheduled callback. A callback whose generation
    /// was superseded (because `arm` had to re-schedule a stalled chain) stops
    /// instead of re-arming, so at most one chain is ever ticking.
    generation: Cell<u64>,
    animation_active: Cell<bool>,
    animation_ticker_running: Cell<bool>,
    gesture_active: Cell<bool>,
    /// When the outstanding callback was last run, in milliseconds since
    /// `epoch`. Used to detect a chain the platform never delivered a frame
    /// for.
    last_tick_ms: Cell<u64>,
}

impl FrameHook {
    pub fn new(host: Host) -> Self {
        Self {
            host,
            state: Rc::new(State {
                epoch: Instant::now(),
                active_until_ms: Cell::new(0),
                armed: Cell::new(false),
                generation: Cell::new(0),
                animation_active: Cell::new(false),
                animation_ticker_running: Cell::new(false),
                gesture_active: Cell::new(false),
                last_tick_ms: Cell::new(0),
            }),
        }
    }

    fn note_activity(&self) {
        self.state
            .active_until_ms
            .set(self.now_ms() + ACTIVITY_WINDOW.as_millis() as u64);
    }

    /// Arms the chain if it is not already running, and notes RN activity.
    ///
    /// `armed` alone is not enough to decide that the chain is running: GPUI
    /// can decline to deliver the frame a callback asked for (observed in this
    /// project's headless capture runs), and then the outstanding callback
    /// would never run, never clear `armed`, and silently block every later
    /// `arm`. If nothing has ticked for a whole activity window, re-schedule;
    /// the superseded callback stops when it eventually runs.
    pub fn arm(&self, window: &mut Window) {
        self.note_activity();
        let stalled = self.now_ms().saturating_sub(self.state.last_tick_ms.get())
            >= ACTIVITY_WINDOW.as_millis() as u64;
        if self.state.armed.get() && !stalled {
            return;
        }
        self.schedule(window);
    }

    pub fn set_animation_active(&self, active: bool, window: &mut Window, cx: &mut gpui::App) {
        let was_active = self.state.animation_active.replace(active);
        if std::env::var_os("RN_GPUI_DEBUG_ANIMATION").is_some() {
            log::info!("[frame] animation_active={active} was_active={was_active}");
        }
        if active && !was_active {
            self.note_activity();
            self.start_animation_ticker(window, cx);
            // NativeAnimated may become active while a prior one-shot GPUI
            // frame is still marked armed but will never be delivered. Force a
            // fresh request so the persistent animation loop can start.
            self.schedule(window);
        } else if active {
            self.start_animation_ticker(window, cx);
            self.arm(window);
        }
    }

    fn start_animation_ticker(&self, window: &mut Window, cx: &mut gpui::App) {
        if self.state.animation_ticker_running.replace(true) {
            return;
        }

        let host = self.host.clone();
        let state = self.state.clone();
        window
            .spawn(cx, async move |cx| loop {
                cx.background_executor()
                    .timer(Duration::from_millis(16))
                    .await;

                if !state.animation_active.get() {
                    state.animation_ticker_running.set(false);
                    let hook = FrameHook {
                        host: host.clone(),
                        state: state.clone(),
                    };
                    let _ = cx.update(|window, _| hook.arm(window));
                    break;
                }

                state.active_until_ms.set(
                    state.epoch.elapsed().as_millis() as u64 + ACTIVITY_WINDOW.as_millis() as u64,
                );
                if cx
                    .update(|_window, _| {
                        host.on_frame(crate::events::now_ms());
                    })
                    .is_err()
                {
                    state.animation_ticker_running.set(false);
                    break;
                }
            })
            .detach();
    }

    pub fn set_gesture_active(&self, active: bool, window: &mut Window) {
        let was_active = self.state.gesture_active.replace(active);
        if active && !was_active {
            self.note_activity();
            self.schedule(window);
        } else if active {
            self.arm(window);
        }
    }

    fn schedule(&self, window: &mut Window) {
        let hook = self.clone();
        let generation = self.state.generation.get().wrapping_add(1);
        self.state.generation.set(generation);
        self.state.armed.set(true);
        if std::env::var_os("RN_GPUI_DEBUG_ANIMATION").is_some() {
            log::info!(
                "[frame] schedule generation={generation} active={}",
                self.is_active()
            );
        }
        window.on_next_frame(move |window, _cx| {
            if hook.state.generation.get() != generation {
                if std::env::var_os("RN_GPUI_DEBUG_ANIMATION").is_some() {
                    log::info!(
                        "[frame] discard generation={generation} current={}",
                        hook.state.generation.get()
                    );
                }
                return;
            }
            hook.state.last_tick_ms.set(hook.now_ms());
            if std::env::var_os("RN_GPUI_DEBUG_ANIMATION").is_some() {
                log::info!(
                    "[frame] callback generation={generation} active={}",
                    hook.is_active()
                );
            }
            if hook.state.animation_active.get() {
                // The foreground timer is the frame source while native
                // animation is active. Avoid double-ticking if GPUI also
                // delivers this outstanding display callback.
                hook.state.armed.set(false);
                return;
            }
            let gesture_only_tick = hook.state.gesture_active.get()
                && !hook.state.animation_active.get()
                && hook.now_ms() >= hook.state.active_until_ms.get();
            if gesture_only_tick {
                hook.host.on_pointer_frame(crate::events::now_ms());
            } else {
                hook.host.on_frame(crate::events::now_ms());
            }
            if hook.is_active() {
                hook.schedule(window);
            } else {
                hook.state.armed.set(false);
            }
        });
        // on_next_frame requests the platform tick without invalidating every
        // retained RN sibling. Mount notifications dirty the changed views;
        // the foreground ticker still handles missed animation callbacks.
    }

    fn is_active(&self) -> bool {
        self.state.animation_active.get()
            || self.state.gesture_active.get()
            || self.now_ms() < self.state.active_until_ms.get()
    }

    pub fn gesture_is_active(&self) -> bool {
        self.state.gesture_active.get()
    }

    fn now_ms(&self) -> u64 {
        self.state.epoch.elapsed().as_millis() as u64
    }
}
