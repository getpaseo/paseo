//! Dragging a view to another view inside the app.
//!
//! A left press on a `draggable` view is remembered. Once the pointer has moved
//! `THRESHOLD` points the drag starts: the press is cancelled for React, the
//! source gets `onDragStart`, and from then on every pointer move retargets the
//! drag, wherever the pointer is. The nearest `droppable` view on the path under
//! the pointer gets `onDragEnter`, `onDragOver` and `onDragLeave`, and the
//! release sends it `onDrop`. The source gets `onDrag` with each move and
//! `onDragEnd` at the end.
//!
//! The payload lives in JavaScript: it is set in `onDragStart`, and the events
//! here arrive in order, so it is there before the first enter. The same moves
//! are emitted as `gpuiDesktop:dragStart`, `gpuiDesktop:dragMove` and
//! `gpuiDesktop:dragEnd` device events, which is what a drag preview and
//! auto-scrolling follow.

use crate::events::Target;
use crate::store::StoreGlobal;
use gpui::{App, Pixels, Point, Window};
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};

const THRESHOLD: f32 = 4.0;

struct Pending {
    source: i32,
    start: Point<Pixels>,
    origin: Target,
}

struct Active {
    source: i32,
    id: u64,
    origin: Target,
    target: Option<i32>,
    last_target: Option<Target>,
    position: Point<Pixels>,
}

enum Session {
    Pending(Pending),
    Active(Active),
}

thread_local! {
    static SESSION: RefCell<Option<Session>> = const { RefCell::new(None) };
    static NEXT_ID: Cell<u64> = const { Cell::new(1) };
}

/// Whether a press on a draggable view is held, started dragging or not.
pub(crate) fn tracking() -> bool {
    SESSION.with_borrow(Option::is_some)
}

/// A left press landed on `target`. The nearest draggable view on its path, the
/// target first, becomes the source if the pointer moves.
pub(crate) fn press(cx: &App, target: &Target, position: Point<Pixels>) {
    let source = target
        .chain
        .iter()
        .copied()
        .find(|tag| node_flag(cx, *tag, |node| node.draggable()));
    SESSION.with_borrow_mut(|session| {
        *session = source.map(|source| {
            Session::Pending(Pending {
                source,
                start: position,
                origin: target.clone(),
            })
        });
    });
}

fn node_flag(cx: &App, tag: i32, flag: impl Fn(&crate::node_view::RNNodeView) -> bool) -> bool {
    cx.try_global::<StoreGlobal>().is_some_and(|store| {
        store
            .0
            .read(cx)
            .nodes
            .get(&tag)
            .is_some_and(|node| flag(node.read(cx)))
    })
}

fn droppable_view(cx: &App, target: &Target) -> Option<i32> {
    target
        .chain
        .iter()
        .copied()
        .find(|tag| node_flag(cx, *tag, |node| node.droppable()))
}

/// The pointer moved with the button held. `target` is the node under it, if
/// any node answered.
pub(crate) fn moved(
    window: &mut Window,
    cx: &mut App,
    target: Option<&Target>,
    position: Point<Pixels>,
    pressed: bool,
) {
    if !pressed {
        return;
    }
    let start = SESSION.with_borrow_mut(|session| match session {
        Some(Session::Pending(pending)) => {
            let dx = f32::from(position.x - pending.start.x);
            let dy = f32::from(position.y - pending.start.y);
            if (dx * dx + dy * dy).sqrt() < THRESHOLD {
                return None;
            }
            let id = NEXT_ID.replace(NEXT_ID.get() + 1);
            let active = Active {
                source: pending.source,
                id,
                origin: pending.origin.clone(),
                target: None,
                last_target: None,
                position,
            };
            let started = (active.source, id, active.origin.clone());
            *session = Some(Session::Active(active));
            Some(started)
        }
        _ => None,
    });
    if let Some((source, id, origin)) = start {
        crate::events::cancel_active_touch(window, cx, position);
        let page = origin.page(position);
        notify(window, cx, "topDragStart", source, &origin, position, None);
        emit(
            cx,
            "gpuiDesktop:dragStart",
            json!({ "source": source, "id": id, "x": f32::from(page.x), "y": f32::from(page.y) }),
        );
    }
    let Some((source, id, origin)) = SESSION.with_borrow(|session| match session {
        Some(Session::Active(active)) => Some((active.source, active.id, active.origin.clone())),
        _ => None,
    }) else {
        return;
    };
    retarget(window, cx, target, position, true);
    notify(window, cx, "topDrag", source, &origin, position, None);
    let page = origin.page(position);
    let over = SESSION.with_borrow(|session| match session {
        Some(Session::Active(active)) => active.target,
        _ => None,
    });
    emit(
        cx,
        "gpuiDesktop:dragMove",
        json!({
            "source": source,
            "id": id,
            "x": f32::from(page.x),
            "y": f32::from(page.y),
            "over": over,
        }),
    );
}

/// The left button was released over `target`, if a node answered.
/// Whether a drag was under way and this ended it. A press that never became a
/// drag is only forgotten, and the release still belongs to the touch.
pub(crate) fn released(
    window: &mut Window,
    cx: &mut App,
    target: Option<&Target>,
    position: Point<Pixels>,
) -> bool {
    let Some(session) = SESSION.with_borrow_mut(Option::take) else {
        return false;
    };
    let Session::Active(active) = session else {
        return false;
    };
    let accepting = target.and_then(|target| droppable_view(cx, target));
    if let (Some(tag), Some(target)) = (accepting, target) {
        deliver(
            window,
            cx,
            "topDrop",
            tag,
            target,
            position,
            Some(active.source),
        );
    }
    crate::interaction::set_drag(None, cx);
    finish(window, cx, active, position, accepting.is_some());
    true
}

/// The drag ended without a drop.
pub(crate) fn cancel(window: &mut Window, cx: &mut App) -> bool {
    let Some(session) = SESSION.with_borrow_mut(Option::take) else {
        return false;
    };
    let Session::Active(active) = session else {
        return false;
    };
    let position = active.position;
    let last = active.last_target.clone();
    if let (Some(tag), Some(last)) = (active.target, last.as_ref()) {
        deliver(
            window,
            cx,
            "topDragLeave",
            tag,
            last,
            position,
            Some(active.source),
        );
    }
    crate::interaction::set_drag(None, cx);
    finish(window, cx, active, position, false);
    true
}

fn finish(
    window: &mut Window,
    cx: &mut App,
    active: Active,
    position: Point<Pixels>,
    dropped: bool,
) {
    notify(
        window,
        cx,
        "topDragEnd",
        active.source,
        &active.origin,
        position,
        Some(dropped),
    );
    let page = active.origin.page(position);
    emit(
        cx,
        "gpuiDesktop:dragEnd",
        json!({
            "source": active.source,
            "id": active.id,
            "x": f32::from(page.x),
            "y": f32::from(page.y),
            "dropped": dropped,
        }),
    );
}

fn retarget(
    window: &mut Window,
    cx: &mut App,
    target: Option<&Target>,
    position: Point<Pixels>,
    over: bool,
) {
    let accepting = target.and_then(|target| droppable_view(cx, target));
    let Some((previous, last, source)) = SESSION.with_borrow_mut(|session| match session {
        Some(Session::Active(active)) => {
            active.position = position;
            let previous = std::mem::replace(&mut active.target, accepting);
            let last = active.last_target.clone();
            if let Some(target) = target {
                active.last_target = Some(target.clone());
            }
            Some((previous, last, active.source))
        }
        _ => None,
    }) else {
        return;
    };
    if previous != accepting {
        if let (Some(tag), Some(from)) = (previous, last.as_ref().or(target)) {
            deliver(
                window,
                cx,
                "topDragLeave",
                tag,
                from,
                position,
                Some(source),
            );
        }
        if let (Some(tag), Some(target)) = (accepting, target) {
            deliver(
                window,
                cx,
                "topDragEnter",
                tag,
                target,
                position,
                Some(source),
            );
        }
        crate::interaction::set_drag(accepting, cx);
    }
    if let (true, Some(tag), Some(target)) = (over, accepting, target) {
        deliver(
            window,
            cx,
            "topDragOver",
            tag,
            target,
            position,
            Some(source),
        );
    }
}

fn deliver(
    window: &mut Window,
    cx: &mut App,
    name: &str,
    tag: i32,
    target: &Target,
    position: Point<Pixels>,
    source: Option<i32>,
) {
    let Some(store) = cx.try_global::<StoreGlobal>().map(|store| store.0.clone()) else {
        return;
    };
    let page = target.page(position);
    let local = target.local_position(page);
    let payload = json!({
        "target": tag,
        "x": f32::from(local.x),
        "y": f32::from(local.y),
        "pageX": f32::from(page.x),
        "pageY": f32::from(page.y),
        "files": Vec::<Value>::new(),
        "source": source,
    });
    let store = store.read(cx);
    store.host.dispatch_event(tag, name, &payload);
    store.frame_hook.arm(window);
}

fn notify(
    window: &mut Window,
    cx: &mut App,
    name: &str,
    source: i32,
    origin: &Target,
    position: Point<Pixels>,
    dropped: Option<bool>,
) {
    let Some(store) = cx.try_global::<StoreGlobal>().map(|store| store.0.clone()) else {
        return;
    };
    let page = origin.page(position);
    let mut payload = json!({
        "target": source,
        "pageX": f32::from(page.x),
        "pageY": f32::from(page.y),
    });
    if let Some(dropped) = dropped {
        payload["dropped"] = json!(dropped);
    }
    let store = store.read(cx);
    store.host.dispatch_event(source, name, &payload);
    store.frame_hook.arm(window);
}

fn emit(cx: &App, name: &str, payload: Value) {
    if let Some(store) = cx.try_global::<StoreGlobal>() {
        store
            .0
            .read(cx)
            .host
            .emit_device_event_json(name, &payload.to_string());
    }
}
