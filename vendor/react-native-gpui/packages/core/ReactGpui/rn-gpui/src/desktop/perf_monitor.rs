//! A host-drawn GPUI overlay, not React Native views, so it does not disturb
//! what it measures.

use crate::store::{store_from, SurfaceRootView};
use gpui::{
    px, App, AppContext, Context, Entity, Global, IntoElement, ParentElement, Render, Styled,
    Window,
};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::VecDeque;
use std::time::{Duration, Instant};

const WINDOW: Duration = Duration::from_secs(1);
const TEXT_REFRESH: Duration = Duration::from_millis(500);

#[derive(Default)]
pub struct PerfMonitorState {
    pub enabled: bool,
    ui_frames: VecDeque<Instant>,
    js_ticks: VecDeque<Instant>,
    pub last_mount_ms: f32,
    pub js_fps: f32,
    js_probes_seen: u64,
    js_probes_primed: bool,
    memory: Option<(Instant, u64)>,
    last_frame: Option<Instant>,
    /// The best rate seen since the monitor was enabled: the display's rate,
    /// which is what a frame is late against.
    peak_fps: f32,
    dropped_frames: u64,
    stutters: u64,
}

const MIN_PEAK_FPS: f32 = 30.0;
/// React Native counts a stutter when at least this many frames drop at once.
const STUTTER_FRAMES: u64 = 4;

fn missed_frames(gap: Duration, display_fps: f32) -> u64 {
    if display_fps < MIN_PEAK_FPS {
        return 0;
    }
    let refreshes = (gap.as_secs_f32() * display_fps).round();
    (refreshes - 1.0).max(0.0) as u64
}

pub struct PerfMonitorGlobal(pub RefCell<PerfMonitorState>);
impl Global for PerfMonitorGlobal {}

impl PerfMonitorState {
    fn prune(&mut self, now: Instant) {
        while self
            .ui_frames
            .front()
            .is_some_and(|at| now.duration_since(*at) > WINDOW)
        {
            self.ui_frames.pop_front();
        }
        while self
            .js_ticks
            .front()
            .is_some_and(|at| now.duration_since(*at) > WINDOW)
        {
            self.js_ticks.pop_front();
        }
    }
}

pub fn install(cx: &mut App) {
    cx.set_global(PerfMonitorGlobal(RefCell::new(PerfMonitorState::default())));
}

pub fn set_enabled(cx: &mut App, enabled: bool) -> Value {
    let was_enabled = {
        let mut state = cx.global_mut::<PerfMonitorGlobal>().0.borrow_mut();
        let previous = state.enabled;
        state.enabled = enabled;
        if !enabled {
            state.ui_frames.clear();
            state.js_ticks.clear();
            state.js_fps = 0.0;
            state.js_probes_primed = false;
            state.last_frame = None;
            state.dropped_frames = 0;
            state.stutters = 0;
        }
        previous
    };
    if enabled && !was_enabled {
        cx.spawn(async move |cx| loop {
            cx.background_executor().timer(TEXT_REFRESH).await;
            let mut stop = false;
            let _ = cx.update(|cx| {
                if !is_enabled(cx) {
                    stop = true;
                    return;
                }
                let Some(store) = store_from(cx) else {
                    stop = true;
                    return;
                };
                let monitor = store
                    .read(cx)
                    .roots
                    .get(&crate::store::APP_SURFACE_ID)
                    .and_then(|root| root.read(cx).perf_monitor.clone());
                if let Some(monitor) = monitor {
                    monitor.update(cx, |_monitor, cx| cx.notify());
                }
            });
            if stop {
                break;
            }
        })
        .detach();
    }
    emit_enabled(cx, enabled);
    let state = cx.global::<PerfMonitorGlobal>().0.borrow();
    json!({"enabled": state.enabled})
}

fn emit_enabled(cx: &App, enabled: bool) {
    let Some(store) = store_from(cx) else {
        return;
    };
    store.read(cx).host.emit_device_event_json(
        "gpuiDesktop:perfMonitor",
        &json!({"enabled": enabled}).to_string(),
    );
}

pub fn is_enabled(cx: &App) -> bool {
    cx.try_global::<PerfMonitorGlobal>()
        .is_some_and(|state| state.0.borrow().enabled)
}

/// A presented frame. The overlay calls this once each time it is drawn, and
/// it is drawn once per frame while it is visible, so nothing else may call it:
/// a second caller would double the rate.
fn record_frame(cx: &App) {
    let Some(global) = cx.try_global::<PerfMonitorGlobal>() else {
        return;
    };
    let js_probes = store_from(cx).map(|store| store.read(cx).host.js_frame_probe());
    let mut state = global.0.borrow_mut();
    if !state.enabled {
        return;
    }
    let now = Instant::now();
    state.prune(now);
    state.ui_frames.push_back(now);
    state.peak_fps = state.peak_fps.max(state.ui_frames.len() as f32);
    if let Some(previous) = state.last_frame.replace(now) {
        let missed = missed_frames(now.duration_since(previous), state.peak_fps);
        state.dropped_frames += missed;
        if missed >= STUTTER_FRAMES {
            state.stutters += 1;
        }
    }
    // One probe is posted to the JS thread per frame, and none while the
    // previous one waits. Counting the ones that ran gives the rate the JS
    // thread keeps up with: the frame rate when idle, less when it is busy.
    if let Some(total) = js_probes {
        let ran = total.saturating_sub(state.js_probes_seen);
        state.js_probes_seen = total;
        if state.js_probes_primed {
            for _ in 0..ran.min(1000) {
                state.js_ticks.push_back(now);
            }
        }
        state.js_probes_primed = true;
    }
    state.js_fps = state.js_ticks.len() as f32;
}

pub fn record_js_ticks(_cx: &App, _count: u32) {}

pub fn record_mount(cx: &App, millis: f32) {
    let Some(global) = cx.try_global::<PerfMonitorGlobal>() else {
        return;
    };
    let mut state = global.0.borrow_mut();
    if state.enabled {
        state.last_mount_ms = millis;
    }
}

pub fn metrics(cx: &App) -> Value {
    let now = Instant::now();
    let (ui_fps, js_fps, mount_ms, enabled, dropped, stutters) = {
        let Some(global) = cx.try_global::<PerfMonitorGlobal>() else {
            // The spec's metrics carry every field, so an app that never enabled
            // the monitor reads zeros rather than a missing field.
            return json!({
                "enabled": false,
                "uiFps": 0.0,
                "jsFps": 0.0,
                "memoryBytes": 0,
                "jsHeapBytes": 0,
                "droppedFrames": 0,
                "stutters": 0,
                "mountedViews": 0,
                "lastMountMs": 0.0,
            });
        };
        let mut state = global.0.borrow_mut();
        state.prune(now);
        // A JS thread that stopped running probes has no ticks left once the
        // window passes; the stored rate would otherwise freeze at its last value.
        state.js_fps = state.js_ticks.len() as f32;
        (
            state.ui_frames.len() as f32,
            state.js_fps,
            state.last_mount_ms,
            state.enabled,
            state.dropped_frames,
            state.stutters,
        )
    };
    let memory = {
        let global = cx.global::<PerfMonitorGlobal>();
        let mut state = global.0.borrow_mut();
        match state.memory {
            Some((at, bytes)) if now.duration_since(at) < TEXT_REFRESH => bytes,
            _ => {
                let bytes = resident_memory_bytes();
                state.memory = Some((now, bytes));
                bytes
            }
        }
    };
    let (views, js_heap) = store_from(cx)
        .map(|store| {
            let store = store.read(cx);
            (store.nodes.len(), store.host.js_heap_bytes())
        })
        .unwrap_or((0, 0));
    json!({
        "enabled": enabled,
        "uiFps": ui_fps,
        "jsFps": js_fps,
        "memoryBytes": memory,
        "jsHeapBytes": js_heap,
        "droppedFrames": dropped,
        "stutters": stutters,
        "mountedViews": views,
        "lastMountMs": mount_ms,
    })
}

#[cfg(target_os = "macos")]
pub fn resident_memory_bytes() -> u64 {
    // `task_info(TASK_BASIC_INFO)` reports `resident_size` in bytes.
    #[repr(C)]
    #[derive(Default)]
    struct TaskBasicInfo {
        virtual_size: u64,
        resident_size: u64,
        resident_size_max: u64,
        user_time: [u32; 2],
        system_time: [u32; 2],
        policy: i32,
        suspend_count: i32,
    }
    const TASK_BASIC_INFO: u32 = 4;
    extern "C" {
        fn mach_task_self() -> u32;
        fn task_info(task: u32, flavor: u32, info: *mut TaskBasicInfo, count: *mut u32) -> i32;
    }
    let mut info = TaskBasicInfo::default();
    let mut count = (std::mem::size_of::<TaskBasicInfo>() / std::mem::size_of::<u32>()) as u32;
    // SAFETY: `info` and `count` are valid for `task_info` to write, and `count` is the buffer size in `u32`s.
    let result = unsafe { task_info(mach_task_self(), TASK_BASIC_INFO, &mut info, &mut count) };
    if result == 0 {
        info.resident_size
    } else {
        0
    }
}

#[cfg(target_os = "linux")]
pub fn resident_memory_bytes() -> u64 {
    // `/proc/self/statm` field 2 is resident pages.
    std::fs::read_to_string("/proc/self/statm")
        .ok()
        .and_then(|contents| {
            contents
                .split_whitespace()
                .nth(1)
                .and_then(|pages| pages.parse::<u64>().ok())
        })
        .map(|pages| pages * 4096)
        .unwrap_or(0)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn resident_memory_bytes() -> u64 {
    // TODO: read `GetProcessMemoryInfo` on Windows.
    0
}

pub struct PerfMonitor {
    window_id: u32,
}

impl PerfMonitor {
    pub fn new(window_id: u32) -> Self {
        Self { window_id }
    }
}

fn format_bytes(bytes: u64) -> String {
    const MB: f64 = 1024.0 * 1024.0;
    if bytes == 0 {
        "n/a".to_string()
    } else {
        format!("{:.0} MB", bytes as f64 / MB)
    }
}

impl Render for PerfMonitor {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if !is_enabled(cx) {
            // Kept absolute so the hidden overlay is exactly 0x0 and cannot
            // swallow input meant for the app behind it.
            return gpui::div().absolute().top_0().left_0();
        }
        // This runs once per presented frame while the overlay is visible. Asking
        // for the next frame here is what keeps them coming, and it is legal
        // from the paint phase (unlike from a timer).
        record_frame(cx);
        window.request_animation_frame();
        let value = metrics(cx);
        let line = |label: &str, text: String| {
            gpui::div()
                .flex()
                .gap_2()
                .child(gpui::div().w(px(74.0)).child(label.to_string()))
                .child(text)
        };
        gpui::div()
            .absolute()
            .top(px(6.0))
            .right(px(6.0))
            .px_2()
            .py_1()
            .rounded(px(4.0))
            .bg(gpui::rgba(0x00000099))
            .text_color(gpui::white())
            .text_size(px(11.0))
            .flex()
            .flex_col()
            .gap_0p5()
            .child(line(
                "UI FPS",
                format!("{:.0}", value["uiFps"].as_f64().unwrap_or(0.0)),
            ))
            .child(line(
                "JS FPS",
                format!("{:.0}", value["jsFps"].as_f64().unwrap_or(0.0)),
            ))
            .child(line(
                "Dropped",
                format!(
                    "{} ({} stutters)",
                    value["droppedFrames"].as_u64().unwrap_or(0),
                    value["stutters"].as_u64().unwrap_or(0)
                ),
            ))
            .child(line("Views", format!("{}", value["mountedViews"])))
            .child(line(
                "Mount",
                format!("{:.1} ms", value["lastMountMs"].as_f64().unwrap_or(0.0)),
            ))
            .child(line(
                "Memory",
                format_bytes(value["memoryBytes"].as_u64().unwrap_or(0)),
            ))
            .child(line(
                "JS heap",
                format_bytes(value["jsHeapBytes"].as_u64().unwrap_or(0)),
            ))
            .child(line("Window", format!("#{}", self.window_id)))
    }
}

pub fn attach(cx: &mut App, root: &Entity<SurfaceRootView>, window_id: u32) {
    let monitor = cx.new(|_| PerfMonitor::new(window_id));
    root.update(cx, |root, cx| {
        root.perf_monitor = Some(monitor);
        cx.notify();
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missed_frames_counts_refreshes_without_a_frame() {
        let frame = Duration::from_secs_f32(1.0 / 120.0);
        assert_eq!(missed_frames(frame, 120.0), 0);
        assert_eq!(missed_frames(frame * 2, 120.0), 1);
        assert_eq!(missed_frames(frame * 5, 120.0), 4);
        assert_eq!(missed_frames(frame * 5, 0.0), 0);
    }

    #[test]
    fn format_bytes_reports_megabytes() {
        assert_eq!(format_bytes(0), "n/a");
        assert_eq!(format_bytes(64 * 1024 * 1024), "64 MB");
    }
}
