use crate::events::{self, ModifierState, Target};
use crate::node_view::RNNodeView;
use crate::store::store_from;
use gpui::{
    px, AnyWindowHandle, App, AppContext as _, AsyncApp, DispatchPhase, Entity, PinchEvent,
    PlatformInput, Point, ScrollDelta, ScrollEvent, TouchPhase, Window,
};
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    collections::VecDeque,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const REPLY_TIMEOUT: Duration = Duration::from_millis(250);
const PINCH_DELTA_SCALE: f32 = 100.0;

#[derive(Clone)]
enum Wheel {
    Scroll(ScrollEvent),
    Pinch(PinchEvent),
}

impl Wheel {
    fn position(&self) -> Point<gpui::Pixels> {
        match self {
            Wheel::Scroll(event) => event.position,
            Wheel::Pinch(event) => event.position,
        }
    }
}

struct Queued {
    wheel: Wheel,
    momentum: bool,
    received: f64,
}

struct InFlight {
    id: u64,
    queued: Queued,
}

#[derive(Default)]
struct State {
    next_id: u64,
    in_flight: Option<InFlight>,
    queue: VecDeque<Queued>,
    replaying: bool,
    after_lift: bool,
    window: Option<AnyWindowHandle>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

fn epoch_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |elapsed| elapsed.as_secs_f64() * 1000.0)
}

/// Whether an event is waiting for its handlers, which the test driver counts as work.
pub(crate) fn pending() -> bool {
    STATE.with_borrow(|state| state.in_flight.is_some() || !state.queue.is_empty())
}

/// Listens, before the views below it scroll, for the wheel and the pinch.
static LAST_SCROLL_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Whether a scroll event arrived within `within`, so a window is being
/// scrolled, momentum included.
pub(crate) fn scrolled_within(within: Duration) -> bool {
    let last = LAST_SCROLL_MS.load(std::sync::atomic::Ordering::Relaxed);
    last != 0 && epoch_ms() - (last as f64) < within.as_secs_f64() * 1000.0
}

pub(crate) fn install(window: &mut Window) {
    window.on_mouse_event(|event: &ScrollEvent, phase, window, cx| {
        if phase == DispatchPhase::Capture {
            LAST_SCROLL_MS.store(epoch_ms() as u64, std::sync::atomic::Ordering::Relaxed);
            note_scroll_delta(event, window.scale_factor());
        }
        if phase == DispatchPhase::Capture && intercept(Wheel::Scroll(event.clone()), window, cx) {
            cx.stop_propagation();
        }
    });
    window.on_mouse_event(|event: &PinchEvent, phase, window, cx| {
        if phase == DispatchPhase::Capture && intercept(Wheel::Pinch(event.clone()), window, cx) {
            cx.stop_propagation();
        }
    });
}

fn intercept(wheel: Wheel, window: &mut Window, cx: &mut App) -> bool {
    if STATE.with_borrow(|state| state.replaying) {
        return false;
    }
    let busy = pending();
    if !busy && !any_handler(cx) {
        return false;
    }
    let momentum = STATE.with_borrow_mut(|state| {
        state.window = Some(window.window_handle());
        match &wheel {
            Wheel::Scroll(event) if is_precise(event) => match event.touch_phase {
                TouchPhase::Started => {
                    state.after_lift = false;
                    false
                }
                TouchPhase::Ended | TouchPhase::Cancelled => {
                    state.after_lift = true;
                    false
                }
                TouchPhase::Moved => state.after_lift,
            },
            _ => false,
        }
    });
    let queued = Queued {
        wheel,
        momentum,
        received: epoch_ms(),
    };
    if busy {
        STATE.with_borrow_mut(|state| state.queue.push_back(queued));
        return true;
    }
    match target_with_handler(window, cx, queued.wheel.position()) {
        Some(target) => {
            send(queued, target, window, cx);
            true
        }
        None => false,
    }
}

fn is_precise(event: &ScrollEvent) -> bool {
    matches!(event.delta, ScrollDelta::Pixels(_))
}

fn any_handler(cx: &App) -> bool {
    let Some(store) = store_from(cx) else {
        return false;
    };
    let store = store.read(cx);
    store.nodes.values().any(|node| node.read(cx).view.on_wheel)
}

fn contains(node: &RNNodeView, page: Point<gpui::Pixels>, cx: &App) -> bool {
    let origin = node.absolute_origin(cx);
    let (scale_x, scale_y) = node.cumulative_scale(cx);
    page.x >= origin.x
        && page.y >= origin.y
        && page.x < origin.x + px(node.frame.w * scale_x)
        && page.y < origin.y + px(node.frame.h * scale_y)
}

fn clipped_out(node: &Entity<RNNodeView>, page: Point<gpui::Pixels>, cx: &App) -> bool {
    let mut parent = node.read(cx).parent.clone();
    while let Some(next) = parent.and_then(|weak| weak.upgrade()) {
        let ancestor = next.read(cx);
        if (ancestor.view.overflow_hidden || ancestor.scroll.is_some())
            && !contains(ancestor, page, cx)
        {
            return true;
        }
        parent = ancestor.parent.clone();
    }
    false
}

/// Where a node sits in paint order: its index among its siblings at each level,
/// from the root. A later sibling paints over an earlier one, and a node over its
/// ancestors, which is how the vectors compare.
fn paint_path(node: &Entity<RNNodeView>, cx: &App) -> Vec<usize> {
    let mut path = Vec::new();
    let mut current = node.clone();
    loop {
        let parent = current
            .read(cx)
            .parent
            .clone()
            .and_then(|weak| weak.upgrade());
        let Some(parent) = parent else {
            break;
        };
        let tag = current.read(cx).tag;
        let index = parent
            .read(cx)
            .children
            .iter()
            .position(|(child, _)| *child == tag)
            .unwrap_or(0);
        path.push(index);
        current = parent;
    }
    path.reverse();
    path
}

static SCROLL_EVENTS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static SCROLL_EVENTS_WHOLE_PIXEL: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

fn note_scroll_delta(event: &ScrollEvent, scale: f32) {
    use std::sync::atomic::Ordering::Relaxed;
    let ScrollDelta::Pixels(delta) = event.delta else {
        return;
    };
    SCROLL_EVENTS.fetch_add(1, Relaxed);
    let whole = |value: f32| ((value * scale) - (value * scale).round()).abs() < 0.001;
    if whole(f32::from(delta.x)) && whole(f32::from(delta.y)) {
        SCROLL_EVENTS_WHOLE_PIXEL.fetch_add(1, Relaxed);
    }
}

/// The precise scroll events seen since the last reset, and how many moved by a
/// whole number of device pixels on both axes.
pub(crate) fn scroll_delta_stats(reset: bool) -> (u64, u64) {
    use std::sync::atomic::Ordering::Relaxed;
    if reset {
        (
            SCROLL_EVENTS.swap(0, Relaxed),
            SCROLL_EVENTS_WHOLE_PIXEL.swap(0, Relaxed),
        )
    } else {
        (
            SCROLL_EVENTS.load(Relaxed),
            SCROLL_EVENTS_WHOLE_PIXEL.load(Relaxed),
        )
    }
}

static TARGET_AT_CALLS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static TARGET_AT_NANOS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// The calls to `target_at` and the time they took, in milliseconds, since the
/// last reset.
pub(crate) fn target_at_stats(reset: bool) -> (u64, f64) {
    use std::sync::atomic::Ordering::Relaxed;
    let (calls, nanos) = if reset {
        (
            TARGET_AT_CALLS.swap(0, Relaxed),
            TARGET_AT_NANOS.swap(0, Relaxed),
        )
    } else {
        (TARGET_AT_CALLS.load(Relaxed), TARGET_AT_NANOS.load(Relaxed))
    };
    (calls, nanos as f64 / 1_000_000.0)
}

/// The target under a window position, found from the nodes' frames, their
/// scroll offsets and the clips of their ancestors.
pub(crate) fn target_at(cx: &App, position: Point<gpui::Pixels>) -> Option<Target> {
    use std::sync::atomic::Ordering::Relaxed;
    let started = std::time::Instant::now();
    let target = find_target(cx, position);
    TARGET_AT_CALLS.fetch_add(1, Relaxed);
    TARGET_AT_NANOS.fetch_add(started.elapsed().as_nanos() as u64, Relaxed);
    target
}

fn find_target(cx: &App, position: Point<gpui::Pixels>) -> Option<Target> {
    let store = store_from(cx)?;
    let store = store.read(cx);
    let conversion = store
        .nodes
        .values()
        .find_map(|node| events::target(cx, node.read(cx)))?;
    let page = conversion.page(position);
    let mut hit: Option<(Vec<usize>, Entity<RNNodeView>)> = None;
    for entity in store.nodes.values() {
        let node = entity.read(cx);
        if node.view.display_none {
            continue;
        }
        if !contains(node, page, cx) || clipped_out(entity, page, cx) {
            continue;
        }
        let path = paint_path(entity, cx);
        if hit.as_ref().map_or(true, |(best, _)| path > *best) {
            hit = Some((path, entity.clone()));
        }
    }
    let (_, entity) = hit?;
    events::target(cx, entity.read(cx))
}

fn target_with_handler(
    _window: &Window,
    cx: &App,
    position: Point<gpui::Pixels>,
) -> Option<Target> {
    let store = store_from(cx)?;
    let store = store.read(cx);
    let target = target_at(cx, position)?;
    let wants = target.chain.iter().any(|tag| {
        store
            .nodes
            .get(tag)
            .is_some_and(|node| node.read(cx).view.on_wheel)
    });
    wants.then_some(target)
}

fn payload(queued: &Queued, target: &Target) -> Value {
    let position = target.page(queued.wheel.position());
    let location = target.local_position(position);
    let (x, y) = (f32::from(position.x), f32::from(position.y));
    let (modifiers, delta_x, delta_y, mode, trackpad, phase, momentum, pinch) = match &queued.wheel
    {
        Wheel::Scroll(event) => {
            let modifiers = ModifierState::from_gpui(&event.modifiers);
            let (mut delta_x, mut delta_y, mode, trackpad) = match event.delta {
                ScrollDelta::Pixels(delta) => (-f32::from(delta.x), -f32::from(delta.y), 0, true),
                ScrollDelta::Lines(delta) => (-delta.x, -delta.y, 1, false),
            };
            if !trackpad && modifiers.shift && delta_x == 0.0 {
                delta_x = delta_y;
                delta_y = 0.0;
            }
            let phase = if !trackpad {
                "none"
            } else if queued.momentum {
                "changed"
            } else {
                match event.touch_phase {
                    TouchPhase::Started => "began",
                    TouchPhase::Moved => "changed",
                    TouchPhase::Ended => "ended",
                    TouchPhase::Cancelled => "cancelled",
                }
            };
            (
                modifiers,
                delta_x,
                delta_y,
                mode,
                trackpad,
                phase,
                queued.momentum,
                false,
            )
        }
        Wheel::Pinch(event) => {
            let mut modifiers = ModifierState::from_gpui(&event.modifiers);
            modifiers.ctrl = true;
            let phase = match event.phase {
                TouchPhase::Started => "began",
                TouchPhase::Moved => "changed",
                TouchPhase::Ended => "ended",
                TouchPhase::Cancelled => "cancelled",
            };
            (
                modifiers,
                0.0,
                -event.delta * PINCH_DELTA_SCALE,
                0,
                true,
                phase,
                false,
                true,
            )
        }
    };
    json!({
        "target": target.tag,
        "deltaX": delta_x,
        "deltaY": delta_y,
        "deltaZ": 0.0,
        "deltaMode": mode,
        "isTrackpad": trackpad,
        "phase": phase,
        "momentum": momentum,
        "isPinch": pinch,
        "ctrlKey": modifiers.ctrl,
        "shiftKey": modifiers.shift,
        "altKey": modifiers.alt,
        "metaKey": modifiers.meta,
        "clientX": x,
        "clientY": y,
        "x": x,
        "y": y,
        "pageX": x,
        "pageY": y,
        "screenX": x,
        "screenY": y,
        "offsetX": f32::from(location.x),
        "offsetY": f32::from(location.y),
        "timestamp": queued.received,
    })
}

fn send(queued: Queued, target: Target, window: &mut Window, cx: &mut App) {
    let Some(store) = store_from(cx) else {
        replay(queued, window, cx);
        return;
    };
    let host = store.read(cx).host.clone();
    let body = payload(&queued, &target);
    let id = STATE.with_borrow_mut(|state| {
        state.next_id += 1;
        let id = state.next_id;
        state.in_flight = Some(InFlight { id, queued });
        id
    });
    host.dispatch_wheel(target.tag, id, &body);
    let handle = window.window_handle();
    cx.spawn(async move |cx| {
        cx.background_executor().timer(REPLY_TIMEOUT).await;
        let _ = cx.update_window(handle, |_, window, cx| finish(id, false, window, cx));
    })
    .detach();
}

/// The handlers of the wheel event `id` have run.
pub(crate) fn done(id: u64, prevented: bool, cx: &mut AsyncApp) {
    let Some(handle) = STATE.with_borrow(|state| state.window) else {
        return;
    };
    let _ = cx.update_window(handle, |_, window, cx| finish(id, prevented, window, cx));
}

fn finish(id: u64, prevented: bool, window: &mut Window, cx: &mut App) {
    let current = STATE.with_borrow_mut(|state| {
        if state
            .in_flight
            .as_ref()
            .is_some_and(|flight| flight.id == id)
        {
            state.in_flight.take()
        } else {
            None
        }
    });
    let Some(flight) = current else {
        return;
    };
    if !prevented {
        replay(flight.queued, window, cx);
    }
    loop {
        let Some(next) = STATE.with_borrow_mut(|state| state.queue.pop_front()) else {
            break;
        };
        match target_with_handler(window, cx, next.wheel.position()) {
            Some(target) => {
                send(next, target, window, cx);
                break;
            }
            None => replay(next, window, cx),
        }
    }
}

fn replay(queued: Queued, window: &mut Window, cx: &mut App) {
    let Wheel::Scroll(event) = queued.wheel else {
        return;
    };
    STATE.with_borrow_mut(|state| state.replaying = true);
    window.dispatch_event(PlatformInput::Scroll(event), cx);
    STATE.with_borrow_mut(|state| state.replaying = false);
}
