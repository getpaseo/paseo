//! Pointer, touch and hover events.
//!
//! `Pressable` consumes touch events (`ResponderEventPlugin`); pointer events
//! are sent alongside. Hover enter/leave and `pointerEvents` are implemented
//! here: RN's `PointerEventsProcessor` only runs for typed `PointerEvent`
//! payloads and never reads `pointerEvents`.

use crate::node_view::RNNodeView;
use crate::store::{store_from, StoreGlobal};
use gpui::{point, px, App, Pixels, Point, WeakEntity, Window};
use serde_json::{json, Map, Value};

const POINTER_ID: i32 = 1;

pub const POINTER_EVENTS_AUTO: u8 = 0;
pub const POINTER_EVENTS_NONE: u8 = 1;
pub const POINTER_EVENTS_BOX_NONE: u8 = 2;
pub const POINTER_EVENTS_BOX_ONLY: u8 = 3;

thread_local! {
    /// Whether the press (or release) being dispatched belongs to the window:
    /// it landed in a title bar's drag area or on a caption button. On Windows
    /// the OS only moves the window, maximizes it on a double click or presses
    /// the button when no node consumes the press — and a press bubbles from
    /// the node under the pointer to every ancestor, each of which would
    /// otherwise start a touch of its own and consume it.
    static WINDOW_OWNS_PRESS: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Clears the mark before a press or release reaches any node: the surface's
/// root calls it in the capture phase, which runs ahead of every node's own
/// listener.
pub(crate) fn begin_press_dispatch() {
    WINDOW_OWNS_PRESS.with(|owned| owned.set(false));
}

/// Marks the press as the window's. The node under the pointer is the first to
/// see a press in the bubble phase, so its ancestors read this afterwards.
pub(crate) fn hand_press_to_window() {
    WINDOW_OWNS_PRESS.with(|owned| owned.set(true));
}

/// Whether a node nearer the pointer already handed this press to the window.
pub(crate) fn press_belongs_to_window() -> bool {
    WINDOW_OWNS_PRESS.with(std::cell::Cell::get)
}

#[derive(Clone, Copy, Debug)]
pub enum Phase {
    Start,
    Move,
    End,
    Cancel,
}

/// Process-relative, like the typed `TouchEventEmitter` path: RN only uses
/// differences.
pub fn now_ms() -> f64 {
    use std::sync::OnceLock;
    static START: OnceLock<std::time::Instant> = OnceLock::new();
    START
        .get_or_init(std::time::Instant::now)
        .elapsed()
        .as_secs_f64()
        * 1000.0
}

/// Precomputed because the node whose handler is running is being updated by
/// GPUI, and reading it from the entity map panics.
#[derive(Clone, Debug)]
pub struct Target {
    pub tag: i32,
    pub origin: Point<Pixels>,
    scale_x: f32,
    scale_y: f32,
    /// The target and its ancestors, innermost first: RN's hover path
    /// (`PointerHoverTracker::getEventPathTargets`), the surface root excluded.
    pub chain: Vec<i32>,
}

pub fn active_touch_target(cx: &App) -> Option<Target> {
    store_from(cx).and_then(|store| store.read(cx).active_touch_target.clone())
}

impl Target {
    fn local_position(&self, position: Point<Pixels>) -> Point<Pixels> {
        point(
            px(f32::from(position.x - self.origin.x) / self.scale_x.max(0.0001)),
            px(f32::from(position.y - self.origin.y) / self.scale_y.max(0.0001)),
        )
    }
}

#[cfg(test)]
mod transform_tests {
    use super::Target;
    use gpui::{point, px};

    #[test]
    fn pointer_location_is_reported_in_untransformed_target_coordinates() {
        let target = Target {
            tag: 7,
            origin: point(px(30.0), px(40.0)),
            scale_x: 2.0,
            scale_y: 0.5,
            chain: vec![7],
        };
        let local = target.local_position(point(px(70.0), px(60.0)));
        assert_eq!(f32::from(local.x), 20.0);
        assert_eq!(f32::from(local.y), 40.0);
    }
}

struct Step {
    tag: i32,
    pointer_events: u8,
    entity: Option<WeakEntity<RNNodeView>>,
    parent: Option<WeakEntity<RNNodeView>>,
}

/// Mirrors RN's native `hitTest`: `auto` is a candidate (the deepest wins),
/// `box-none` is never a target but its children are, `box-only` overrides any
/// deeper candidate, `none` kills the whole subtree.
/// The node that owns the context menu for a press on `hit_node`.
///
/// Right-clicking a `Text` inside a `View` with `onContextMenu` must open that
/// view's menu. GPUI bubbles mouse events from the innermost hitbox outwards, so
/// relying on bubbling means every node between the two needs a listener — and a
/// node that takes pointer input stops the press before it reaches the owner.
/// That is what made a right click on the text stop working.
///
/// So the innermost node that handles the press walks its ancestors instead. The
/// walk follows the same `pointerEvents` rules as `target`: `none` ends it, and
/// `box-only` is a candidate but its ancestors are not.
///
/// The result is the nearest ancestor-or-self that asked for a context menu —
/// either a `View` with the prop or an extension component whose `InputSpec`
/// does. `None` means nothing in the chain wants one, and the press is only a
/// pointer event.
pub fn context_menu_owner(cx: &App, hit_node: &RNNodeView) -> Option<ContextMenuOwner> {
    let mut tag = hit_node.tag;
    let mut wants = node_wants_context_menu(cx, hit_node);
    let mut pointer_events = hit_node.view.pointer_events;
    let mut parent = hit_node.parent.clone();
    // `None` for the hit node itself, which the caller already has.
    let mut entity: Option<WeakEntity<RNNodeView>> = None;
    loop {
        if pointer_events == POINTER_EVENTS_NONE {
            return None;
        }
        if wants {
            return Some(ContextMenuOwner { tag, entity });
        }
        // `box-only` claims the press for itself, so the search ends with it
        // whether or not it wants a menu.
        if pointer_events == POINTER_EVENTS_BOX_ONLY {
            return None;
        }
        let Some(next) = parent.clone() else {
            return None;
        };
        let Some(node) = next.upgrade() else {
            return None;
        };
        let node = node.read(cx);
        tag = node.tag;
        wants = node_wants_context_menu(cx, node);
        pointer_events = node.view.pointer_events;
        parent = node.parent.clone();
        entity = Some(next);
    }
}

/// Whether this node wants a context menu: the View prop, or an extension
/// component whose `InputSpec` asks for one.
fn node_wants_context_menu(cx: &App, node: &RNNodeView) -> bool {
    if node.view.on_context_menu {
        return true;
    }
    let Some(renderer) = crate::extensions::component_renderer(&node.component) else {
        return false;
    };
    let component_node = node.component_node(cx);
    renderer.input(&component_node).context_menu
}

/// Who owns a context menu for a press.
#[derive(Clone)]
pub struct ContextMenuOwner {
    pub tag: i32,
    /// The owning node, or `None` when it is the hit node itself.
    pub entity: Option<WeakEntity<RNNodeView>>,
}

pub fn target(cx: &App, hit_node: &RNNodeView) -> Option<Target> {
    let mut steps = vec![Step {
        tag: hit_node.tag,
        pointer_events: hit_node.view.pointer_events,
        entity: None,
        parent: hit_node.parent.clone(),
    }];
    loop {
        let Some(ancestor) = steps.last().and_then(|step| step.parent.clone()) else {
            break;
        };
        let Some(node) = ancestor.upgrade() else {
            break;
        };
        let (tag, pointer_events, parent) = {
            let node = node.read(cx);
            (node.tag, node.view.pointer_events, node.parent.clone())
        };
        steps.push(Step {
            tag,
            pointer_events,
            entity: Some(ancestor),
            parent,
        });
    }
    let mut chosen: Option<usize> = None;
    for (index, step) in steps.iter().enumerate() {
        match step.pointer_events {
            POINTER_EVENTS_NONE => return None,
            POINTER_EVENTS_AUTO => {
                if chosen.is_none() {
                    chosen = Some(index);
                }
            }
            POINTER_EVENTS_BOX_NONE => {}
            POINTER_EVENTS_BOX_ONLY => chosen = Some(index),
            other => {
                log::warn!("[events] unknown pointerEvents {other}; treating it as auto");
                if chosen.is_none() {
                    chosen = Some(index);
                }
            }
        }
    }
    let index = chosen?;
    let (origin, scale_x, scale_y) = if index == 0 {
        let (scale_x, scale_y) = hit_node.cumulative_scale(cx);
        (hit_node.absolute_origin(cx), scale_x, scale_y)
    } else {
        let node = steps[index].entity.as_ref()?.upgrade()?;
        let node = node.read(cx);
        let (scale_x, scale_y) = node.cumulative_scale(cx);
        (node.absolute_origin(cx), scale_x, scale_y)
    };
    let chain = steps[index..].iter().map(|step| step.tag).collect();
    Some(Target {
        tag: steps[index].tag,
        origin,
        scale_x,
        scale_y,
        chain,
    })
}

/// One touch object: exactly the keys `setTouchPayloadOnObject` writes
/// (`ReactCommon/react/renderer/components/view/BaseTouch.cpp`).
fn touch_json(tag: i32, page: Point<Pixels>, location: Point<Pixels>, timestamp: f64) -> Value {
    let (x, y) = (f32::from(page.x), f32::from(page.y));
    json!({
        "identifier": POINTER_ID,
        "target": tag,
        "pageX": x,
        "pageY": y,
        "locationX": f32::from(location.x),
        "locationY": f32::from(location.y),
        "screenX": x,
        "screenY": y,
        "timestamp": timestamp,
        "force": 0.0,
    })
}

/// `touches` must be empty for `topTouchEnd`: `ResponderTouchHistoryStore`
/// reads its length as the number of active touches.
fn touch_payload(tag: i32, page: Point<Pixels>, location: Point<Pixels>, active: bool) -> Value {
    let touch = touch_json(tag, page, location, now_ms());
    let mut payload = touch.as_object().cloned().unwrap_or_else(Map::new);
    let list = |touch: &Value| Value::Array(if active { vec![touch.clone()] } else { vec![] });
    payload.insert("touches".into(), list(&touch));
    payload.insert("changedTouches".into(), Value::Array(vec![touch.clone()]));
    payload.insert("targetTouches".into(), list(&touch));
    Value::Object(payload)
}

/// Delivers only the DOM pointer events for a button, with no touch or responder
/// side effects.
///
/// This is the path a middle or right press takes. `send` also dispatches
/// `topTouchStart` and feeds RN's responder system, which would make a
/// `Pressable` react to a right click; a non-primary button must not do that.
pub fn send_pointer(
    window: &mut Window,
    cx: &mut App,
    target: &Target,
    position: Point<Pixels>,
    phase: Phase,
    button: Option<Button>,
    buttons: i32,
    modifiers: ModifierState,
) {
    let Some(store_global) = cx.try_global::<StoreGlobal>() else {
        log::warn!("[events] no store global yet; dropping {phase:?}");
        return;
    };
    let store = store_global.0.clone();
    let (host, frame_hook) = {
        let store = store.read(cx);
        (store.host.clone(), store.frame_hook.clone())
    };
    let tag = target.tag;
    let location = target.local_position(position);
    let (name, event) = match phase {
        Phase::Start => (
            "topPointerDown",
            pointer_payload(tag, position, location, button, buttons, modifiers),
        ),
        Phase::Move => (
            "topPointerMove",
            pointer_payload(tag, position, location, None, buttons, modifiers),
        ),
        Phase::End => (
            "topPointerUp",
            pointer_payload(tag, position, location, button, buttons, modifiers),
        ),
        Phase::Cancel => (
            "topPointerCancel",
            pointer_payload(tag, position, location, None, buttons, modifiers),
        ),
    };
    host.dispatch_event(tag, name, &event);
    frame_hook.arm(window);
}

/// The W3C number for a mouse button.
///
/// The order is W3C's, not the order the platform reports them in: 0 primary,
/// 1 auxiliary (middle), 2 secondary (right), then the two side buttons.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Button {
    Left = 0,
    Middle = 1,
    Right = 2,
    Back = 3,
    Forward = 4,
}

impl Button {
    pub fn number(self) -> i32 {
        self as i32
    }

    /// The bit this button contributes to `buttons`, matching
    /// `PointerEvent::buttons` and `MouseEvent.button`: 1 left, 2 right,
    /// 4 middle, 8 back, 16 forward. Note that the *bit* order differs from the
    /// *number* order — middle is 4 here and 1 there — because the DOM's mask
    /// predates its numbering.
    pub fn mask(self) -> i32 {
        match self {
            Button::Left => 1,
            Button::Middle => 4,
            Button::Right => 2,
            Button::Back => 8,
            Button::Forward => 16,
        }
    }
}

/// Which modifier keys were held: the four flags React Native reports on an
/// event, and the CSS-style `altKey` rather than GPUI's platform spelling.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ModifierState {
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
    pub meta: bool,
}

impl ModifierState {
    pub fn none() -> Self {
        Self::default()
    }

    /// From GPUI's modifier set.
    ///
    /// GPUI spells the platform key `platform` — Command on macOS, Windows on
    /// Windows, Super on Linux — and the DOM calls the same key `metaKey`, so that
    /// is the mapping. `function` has no DOM equivalent and is dropped.
    pub fn from_gpui(modifiers: &gpui::Modifiers) -> Self {
        Self {
            ctrl: modifiers.control,
            shift: modifiers.shift,
            alt: modifiers.alt,
            meta: modifiers.platform,
        }
    }
}

/// `button` is the button that changed, and -1 for a move, as the DOM reports it.
/// `buttons` is the mask of everything currently held. `modifiers` are the keys
/// held at the time.
fn pointer_payload(
    tag: i32,
    page: Point<Pixels>,
    location: Point<Pixels>,
    button: Option<Button>,
    buttons: i32,
    modifiers: ModifierState,
) -> Value {
    let (x, y) = (f32::from(page.x), f32::from(page.y));
    json!({
        "pointerId": POINTER_ID,
        "pointerType": "mouse",
        "isPrimary": true,
        "pressure": if buttons == 0 { 0.0 } else { 0.5 },
        "button": button.map_or(-1, Button::number),
        "buttons": buttons,
        "ctrlKey": modifiers.ctrl,
        "shiftKey": modifiers.shift,
        "altKey": modifiers.alt,
        "metaKey": modifiers.meta,
        "clientX": x,
        "clientY": y,
        // `x`/`y` are aliases of `clientX`/`clientY`, and `pageX`/`pageY` equal
        // them because the root does not scroll (see `PointerEvent.cpp`).
        "x": x,
        "y": y,
        "pageX": x,
        "pageY": y,
        "screenX": x,
        "screenY": y,
        "offsetX": f32::from(location.x),
        "offsetY": f32::from(location.y),
        "target": tag,
        "width": 0.0,
        "height": 0.0,
        "detail": 0,
        "timestamp": now_ms(),
    })
}

/// Delivers a pointer/touch sequence for one button.
///
/// Touch events and the responder system stay left-button only, so a right click
/// never makes a `Pressable` fire: the DOM's pointer events are the only channel
/// that reports the other buttons.
pub fn send(
    window: &mut Window,
    cx: &mut App,
    target: &Target,
    position: Point<Pixels>,
    phase: Phase,
    button: Option<Button>,
    modifiers: ModifierState,
) {
    let Some(store_global) = cx.try_global::<StoreGlobal>() else {
        log::warn!("[events] no store global yet; dropping {phase:?}");
        return;
    };
    let store = store_global.0.clone();
    let (host, frame_hook) = {
        let store = store.read(cx);
        (store.host.clone(), store.frame_hook.clone())
    };
    match phase {
        Phase::Start => frame_hook.set_gesture_active(true, window),
        Phase::End | Phase::Cancel => frame_hook.set_gesture_active(false, window),
        Phase::Move => {}
    }
    if matches!(phase, Phase::Start) {
        store.update(cx, |store, _| {
            store.active_touch_target = Some(target.clone())
        });
    }
    let tag = target.tag;
    let location = target.local_position(position);
    log::debug!(
        "[events] {phase:?} tag={tag} position=({:.1},{:.1}) location=({:.1},{:.1})",
        f32::from(position.x),
        f32::from(position.y),
        f32::from(location.x),
        f32::from(location.y),
    );
    host.dispatch_pointer_event(
        &target.chain,
        f32::from(position.x),
        f32::from(position.y),
        match phase {
            Phase::Start => 0,
            Phase::Move => 1,
            Phase::End => 2,
            Phase::Cancel => 3,
        },
        now_ms(),
    );
    match phase {
        Phase::Start => {
            host.dispatch_event(
                tag,
                "topTouchStart",
                &touch_payload(tag, position, location, true),
            );
            host.dispatch_event(
                tag,
                "topPointerDown",
                &pointer_payload(
                    tag,
                    position,
                    location,
                    button,
                    button.map_or(0, Button::mask),
                    modifiers,
                ),
            );
        }
        Phase::Move => {
            host.dispatch_event(
                tag,
                "topTouchMove",
                &touch_payload(tag, position, location, true),
            );
            host.dispatch_event(
                tag,
                "topPointerMove",
                &pointer_payload(
                    tag,
                    position,
                    location,
                    button,
                    button.map_or(0, Button::mask),
                    modifiers,
                ),
            );
        }
        Phase::End => {
            host.dispatch_event(
                tag,
                "topTouchEnd",
                &touch_payload(tag, position, location, false),
            );
            host.dispatch_event(
                tag,
                "topPointerUp",
                &pointer_payload(tag, position, location, button, 0, modifiers),
            );
        }
        Phase::Cancel => {
            host.dispatch_event(
                tag,
                "topTouchCancel",
                &touch_payload(tag, position, location, false),
            );
            host.dispatch_event(
                tag,
                "topPointerCancel",
                &pointer_payload(tag, position, location, button, 0, modifiers),
            );
        }
    }
    if matches!(phase, Phase::End | Phase::Cancel) {
        store.update(cx, |store, _| store.active_touch_target = None);
    }
    // dispatchEvent queues React work; the frame hook is what calls RN's
    // RunLoopObserverManager::onRender and lets the JS scheduler consume it.
    frame_hook.arm(window);
}

pub fn cancel_active_touch(window: &mut Window, cx: &mut App, position: Point<Pixels>) {
    if let Some(target) = active_touch_target(cx) {
        send(
            window,
            cx,
            &target,
            position,
            Phase::Cancel,
            Some(Button::Left),
            ModifierState::none(),
        );
    }
}

fn shared_root_len(previous: &[i32], next: &[i32]) -> usize {
    let mut shared = 0;
    while shared < previous.len()
        && shared < next.len()
        && previous[previous.len() - 1 - shared] == next[next.len() - 1 - shared]
    {
        shared += 1;
    }
    shared
}

/// `target` is `None` over a subtree `pointerEvents` made untouchable, which
/// leaves the old chain.
pub fn hover(window: &mut Window, cx: &mut App, target: Option<&Target>, position: Point<Pixels>) {
    let Some(store) = store_from(cx) else {
        return;
    };
    let next = target
        .map(|target| target.chain.clone())
        .unwrap_or_default();
    // RN reuses the *target's* offset for every node in the hover path
    // (`handleIncomingPointerEventOnNode` re-dispatches the same PointerEvent),
    // so `offsetX/Y` of an ancestor's enter/leave is the target-relative offset.
    let location = target
        .map(|target| target.local_position(position))
        .unwrap_or_else(|| point(px(0.), px(0.)));
    let (host, previous) = {
        let store = store.read(cx);
        store.pointer.set(position);
        (store.host.clone(), store.hovered.replace(next.clone()))
    };
    let shared = shared_root_len(&previous, &next);
    log::trace!(
        "[events] hover at ({:.1},{:.1}) chain={next:?} was={previous:?}",
        f32::from(position.x),
        f32::from(position.y),
    );
    // Leave, deepest first, then enter, root first: the order
    // `PointerEventsProcessor` uses, so JS sees the same sequence.
    for tag in previous.iter().take(previous.len() - shared) {
        host.dispatch_event(
            *tag,
            "topPointerOut",
            &pointer_payload(*tag, position, location, None, 0, ModifierState::none()),
        );
        host.dispatch_event(
            *tag,
            "topPointerLeave",
            &pointer_payload(*tag, position, location, None, 0, ModifierState::none()),
        );
    }
    for tag in next[..next.len() - shared].iter().rev() {
        host.dispatch_event(
            *tag,
            "topPointerOver",
            &pointer_payload(*tag, position, location, None, 0, ModifierState::none()),
        );
        host.dispatch_event(
            *tag,
            "topPointerEnter",
            &pointer_payload(*tag, position, location, None, 0, ModifierState::none()),
        );
    }
    if previous != next {
        store.read(cx).frame_hook.arm(window);
    }
}

pub fn leave_root(window: &mut Window, cx: &mut App) {
    let Some(store) = store_from(cx) else {
        return;
    };
    let (host, previous, position) = {
        let store = store.read(cx);
        (
            store.host.clone(),
            store.hovered.take(),
            store.pointer.get(),
        )
    };
    for tag in previous.iter() {
        let location = store
            .read(cx)
            .nodes
            .get(tag)
            .map(|node| {
                let node = node.read(cx);
                Target {
                    tag: *tag,
                    origin: node.absolute_origin(cx),
                    scale_x: node.cumulative_scale(cx).0,
                    scale_y: node.cumulative_scale(cx).1,
                    chain: Vec::new(),
                }
                .local_position(position)
            })
            .unwrap_or_else(|| point(px(0.), px(0.)));
        host.dispatch_event(
            *tag,
            "topPointerOut",
            &pointer_payload(*tag, position, location, None, 0, ModifierState::none()),
        );
        host.dispatch_event(
            *tag,
            "topPointerLeave",
            &pointer_payload(*tag, position, location, None, 0, ModifierState::none()),
        );
    }
    if !previous.is_empty() {
        store.read(cx).frame_hook.arm(window);
    }
}

/// How a context menu was requested, for the `trigger` field.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ContextMenuTriggerSource {
    /// A pointer: a right click, or Ctrl + click on macOS.
    Mouse,
    /// The Menu key or Shift+F10, which only Windows and Linux report.
    Keyboard,
}

/// When a mouse-down should open a context menu.
///
/// Right-click is the obvious case. The others exist because the platforms
/// disagree on the rest: macOS has no Menu key, so Ctrl + click is the keyboard
/// alternative there, while Windows and Linux have both the Menu key and
/// Shift+F10. A right-click opens on press rather than release because that is
/// what macOS and most Linux desktops do.
///
/// `platform` is a `std::env::consts::OS` value so this stays testable without a
/// window.
pub fn mouse_context_menu_trigger(
    button: Button,
    modifiers: ModifierState,
    platform: &str,
) -> Option<ContextMenuTriggerSource> {
    match button {
        Button::Right => Some(ContextMenuTriggerSource::Mouse),
        // Ctrl + click, on macOS only: elsewhere Ctrl + click is a right click at
        // the window-manager level and never arrives as a left press.
        Button::Left if platform == "macos" && modifiers.ctrl => {
            Some(ContextMenuTriggerSource::Mouse)
        }
        _ => None,
    }
}

/// Whether a key event is the keyboard way to open a context menu.
///
/// The Menu key is `ContextMenu` on Windows and Linux; Shift+F10 is the older
/// equivalent that both also accept. macOS has neither, so it returns `false`
/// there — Ctrl + click covers it.
pub fn keyboard_context_menu_trigger(key: &str, shift: bool, platform: &str) -> bool {
    if platform == "macos" {
        return false;
    }
    key == "contextmenu" || (shift && key == "f10")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_right_click_is_a_mouse_trigger_everywhere() {
        for platform in ["macos", "windows", "linux"] {
            assert_eq!(
                mouse_context_menu_trigger(Button::Right, ModifierState::none(), platform),
                Some(ContextMenuTriggerSource::Mouse),
                "{platform}"
            );
        }
    }

    #[test]
    fn ctrl_click_is_only_a_trigger_on_macos() {
        let ctrl = ModifierState {
            ctrl: true,
            ..ModifierState::none()
        };
        assert_eq!(
            mouse_context_menu_trigger(Button::Left, ctrl, "macos"),
            Some(ContextMenuTriggerSource::Mouse)
        );
        // Elsewhere the window manager turns it into a right click, so a left
        // press with Ctrl is an ordinary press.
        assert_eq!(
            mouse_context_menu_trigger(Button::Left, ctrl, "windows"),
            None
        );
        assert_eq!(
            mouse_context_menu_trigger(Button::Left, ctrl, "linux"),
            None
        );
    }

    #[test]
    fn a_plain_left_click_is_never_a_trigger() {
        assert_eq!(
            mouse_context_menu_trigger(Button::Left, ModifierState::none(), "macos"),
            None
        );
        // Other modifiers do not make a left press a context menu on their own.
        for modifiers in [
            ModifierState {
                shift: true,
                ..ModifierState::none()
            },
            ModifierState {
                alt: true,
                ..ModifierState::none()
            },
            ModifierState {
                meta: true,
                ..ModifierState::none()
            },
        ] {
            assert_eq!(
                mouse_context_menu_trigger(Button::Left, modifiers, "macos"),
                None
            );
        }
    }

    #[test]
    fn the_keyboard_trigger_is_the_menu_key_or_shift_f10() {
        assert!(keyboard_context_menu_trigger(
            "contextmenu",
            false,
            "windows"
        ));
        assert!(keyboard_context_menu_trigger("contextmenu", false, "linux"));
        assert!(keyboard_context_menu_trigger("f10", true, "windows"));
        assert!(keyboard_context_menu_trigger("f10", true, "linux"));
        // Shift+F10 only; plain F10 must not open a menu.
        assert!(!keyboard_context_menu_trigger("f10", false, "windows"));
        // macOS has neither key.
        assert!(!keyboard_context_menu_trigger(
            "contextmenu",
            false,
            "macos"
        ));
    }

    #[test]
    fn buttons_use_the_w3c_numbers_and_the_dom_mask() {
        assert_eq!(Button::Left.number(), 0);
        assert_eq!(Button::Middle.number(), 1);
        assert_eq!(Button::Right.number(), 2);
        assert_eq!(Button::Back.number(), 3);
        assert_eq!(Button::Forward.number(), 4);

        // The mask is not the number shifted: the DOM's bit order predates its
        // numbering, so middle is 4 in the mask and 1 in the number.
        assert_eq!(Button::Left.mask(), 1);
        assert_eq!(Button::Right.mask(), 2);
        assert_eq!(Button::Middle.mask(), 4);
        assert_eq!(Button::Back.mask(), 8);
        assert_eq!(Button::Forward.mask(), 16);
    }

    #[test]
    fn modifiers_map_from_gpui_with_platform_keys_as_meta() {
        // GPUI spells the platform key `platform`: Command, Windows or Super. The
        // DOM calls all of those `metaKey`.
        let state = ModifierState::from_gpui(&gpui::Modifiers {
            control: true,
            alt: true,
            shift: true,
            platform: true,
            function: true,
        });
        assert!(state.ctrl && state.alt && state.shift && state.meta);
        // Start all-false and set one at a time, so a mistake in the mapping shows.
        assert_eq!(
            ModifierState::from_gpui(&gpui::Modifiers::default()),
            ModifierState::none()
        );
        assert_eq!(
            ModifierState::from_gpui(&gpui::Modifiers {
                platform: true,
                ..gpui::Modifiers::default()
            }),
            ModifierState {
                meta: true,
                ..ModifierState::none()
            }
        );
        assert_eq!(
            ModifierState::from_gpui(&gpui::Modifiers {
                control: true,
                ..gpui::Modifiers::default()
            }),
            ModifierState {
                ctrl: true,
                ..ModifierState::none()
            }
        );
    }
}
