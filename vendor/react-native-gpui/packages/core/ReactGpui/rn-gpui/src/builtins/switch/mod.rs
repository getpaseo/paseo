//! `Switch`: a track and a thumb in the style of the host OS.
//!
//! The value shown is native: a click or Space flips it, redraws and reports
//! `onChange`; React Native's JS answers a refusal with `setValue`. A new `value`
//! prop from JS replaces it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use gpui::{div, prelude::*, px, AnyElement, App, Window};
use serde_json::Value;

use crate::extensions::input::{
    ButtonSet, CursorStyle, InputContext, InputSpec, MouseEvent, Propagation,
};
use crate::extensions::{
    register_component_renderer, ComponentNode, ComponentRenderer, StoreHandle,
};
use crate::style::color;

const SLIDE: Duration = Duration::from_millis(150);

struct State {
    value: bool,
    last_prop: bool,
    from: f32,
    started: Instant,
}

fn states() -> &'static Mutex<HashMap<i32, State>> {
    static STATES: OnceLock<Mutex<HashMap<i32, State>>> = OnceLock::new();
    STATES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn eased(elapsed: Duration) -> f32 {
    let t = (elapsed.as_secs_f32() / SLIDE.as_secs_f32()).clamp(0.0, 1.0);
    1.0 - (1.0 - t) * (1.0 - t)
}

impl State {
    fn position(&self, now: Instant) -> f32 {
        let target = if self.value { 1.0 } else { 0.0 };
        self.from + (target - self.from) * eased(now.saturating_duration_since(self.started))
    }

    fn animating(&self, now: Instant) -> bool {
        now.saturating_duration_since(self.started) < SLIDE
    }

    fn set(&mut self, value: bool, animate: bool, now: Instant) {
        if self.value == value {
            return;
        }
        let from = self.position(now);
        self.value = value;
        self.from = from;
        self.started = if animate { now } else { now - SLIDE };
    }
}

fn prop_value(props: &Value) -> bool {
    props.get("value").and_then(Value::as_bool).unwrap_or(false)
}

fn disabled(props: &Value) -> bool {
    props
        .get("disabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn argb(props: &Value, keys: &[&str]) -> Option<u32> {
    keys.iter().find_map(|key| {
        props
            .get(*key)
            .and_then(Value::as_u64)
            .map(|value| value as u32)
            .filter(|value| *value != 0)
    })
}

/// The value now shown and where the thumb is, after folding in a new `value`
/// prop from JS.
fn sync(tag: i32, props: &Value, animate: bool, now: Instant) -> (bool, f32, bool) {
    let prop = prop_value(props);
    let mut states = states().lock().expect("switch states poisoned");
    let state = states.entry(tag).or_insert_with(|| State {
        value: prop,
        last_prop: prop,
        from: if prop { 1.0 } else { 0.0 },
        started: now - SLIDE,
    });
    if state.last_prop != prop {
        state.last_prop = prop;
        state.set(prop, animate, now);
    }
    (state.value, state.position(now), state.animating(now))
}

fn accent() -> u32 {
    if cfg!(target_os = "macos") {
        0xFF0A84FF
    } else if cfg!(target_os = "windows") {
        0xFF0067C0
    } else {
        0xFF3584E4
    }
}

fn off_track() -> u32 {
    if cfg!(target_os = "macos") {
        0xFFD1D1D6
    } else if cfg!(target_os = "windows") {
        0xFF8A8A8A
    } else {
        0xFFC0BFBC
    }
}

struct SwitchRenderer;

impl ComponentRenderer for SwitchRenderer {
    fn render(&self, _: &ComponentNode, _: &mut Window, _: &mut App) -> Option<AnyElement> {
        None
    }

    fn content(
        &self,
        node: &ComponentNode,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<AnyElement> {
        let now = Instant::now();
        let animate = !cx.reduce_motion() && !crate::animation_policy::animations_disabled();
        let (value, position, animating) = sync(node.tag, &node.props, animate, now);
        if animating {
            window.request_animation_frame();
        }
        let (width, height) = (node.frame.w, node.frame.h);
        let inset = 2.0_f32;
        let diameter = (height - 2.0 * inset).max(0.0);
        let travel = (width - height).max(0.0);
        let on = argb(&node.props, &["onTintColor", "trackColorForTrue"]).unwrap_or_else(accent);
        let off = argb(&node.props, &["tintColor", "trackColorForFalse"]).unwrap_or_else(off_track);
        let thumb = argb(&node.props, &["thumbTintColor", "thumbColor"]).unwrap_or(0xFFFFFFFF);
        let track = if value || position > 0.5 { on } else { off };
        let mut track_color = color(track);
        if disabled(&node.props) {
            track_color.a *= 0.5;
        }
        let mut thumb_color = color(thumb);
        if disabled(&node.props) {
            thumb_color.a *= 0.7;
        }
        Some(
            div()
                .absolute()
                .size_full()
                .child(
                    div()
                        .absolute()
                        .size_full()
                        .rounded(px(height / 2.0))
                        .bg(track_color),
                )
                .child(
                    div()
                        .absolute()
                        .top(px(inset))
                        .left(px(inset + travel * position))
                        .size(px(diameter))
                        .rounded(px(diameter / 2.0))
                        .bg(thumb_color),
                )
                .into_any_element(),
        )
    }

    fn input(&self, node: &ComponentNode) -> InputSpec {
        if disabled(&node.props) {
            return InputSpec::default();
        }
        InputSpec {
            mouse_buttons: ButtonSet::one(crate::events::Button::Left),
            cursor: Some(CursorStyle::Pointer),
            ..InputSpec::default()
        }
    }

    fn focusable_by_default(&self) -> bool {
        true
    }

    fn claims_press(&self, node: &ComponentNode) -> bool {
        !disabled(&node.props)
    }

    fn on_mouse_down(
        &self,
        _node: &ComponentNode,
        _event: &MouseEvent,
        cx: &mut InputContext<'_>,
    ) -> Propagation {
        // Capture so the release arrives even if the pointer drifted off.
        cx.capture_pointer();
        Propagation::Stop
    }

    fn on_mouse_up(
        &self,
        node: &ComponentNode,
        _event: &MouseEvent,
        cx: &mut InputContext<'_>,
    ) -> Propagation {
        cx.release_pointer();
        // A press that began here and ended anywhere acts: `event.local` is
        // measured from the frame, which is relative to the parent, so the
        // release point cannot be tested against the box reliably.
        let value = flip(node, true);
        cx.dispatch_event(
            "topChange",
            &serde_json::json!({"value": value, "target": node.tag}),
        );
        cx.request_frame();
        Propagation::Stop
    }

    fn activate(
        &self,
        node: &ComponentNode,
        handle: &StoreHandle,
        window: &mut Window,
        cx: &mut App,
    ) -> bool {
        if disabled(&node.props) {
            return true;
        }
        let value = flip(node, !cx.reduce_motion());
        handle.dispatch_event(
            node.tag,
            "topChange",
            &serde_json::json!({"value": value, "target": node.tag}),
            cx,
        );
        window.refresh();
        true
    }

    fn command(
        &self,
        node: &ComponentNode,
        name: &str,
        args: &Value,
        _handle: &StoreHandle,
        cx: &mut App,
    ) -> bool {
        if name != "setValue" {
            return false;
        }
        let Some(value) = args.get(0).and_then(Value::as_bool) else {
            return false;
        };
        let animate = !cx.reduce_motion() && !crate::animation_policy::animations_disabled();
        let mut states = states().lock().expect("switch states poisoned");
        if let Some(state) = states.get_mut(&node.tag) {
            state.set(value, animate, Instant::now());
        }
        true
    }
}

/// Flips the shown value and returns the new one.
fn flip(node: &ComponentNode, animate: bool) -> bool {
    let now = Instant::now();
    let animate = animate && !crate::animation_policy::animations_disabled();
    let mut states = states().lock().expect("switch states poisoned");
    let prop = prop_value(&node.props);
    let state = states.entry(node.tag).or_insert_with(|| State {
        value: prop,
        last_prop: prop,
        from: if prop { 1.0 } else { 0.0 },
        started: now - SLIDE,
    });
    let next = !state.value;
    state.set(next, animate, now);
    next
}

pub fn register() {
    register_component_renderer("Switch", Arc::new(SwitchRenderer));
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_flip_slides_from_where_the_thumb_is() {
        let start = Instant::now();
        let mut state = State {
            value: false,
            last_prop: false,
            from: 0.0,
            started: start - SLIDE,
        };
        assert_eq!(state.position(start), 0.0);
        state.set(true, true, start);
        assert!(state.animating(start));
        assert_eq!(state.position(start), 0.0);
        assert_eq!(state.position(start + SLIDE), 1.0);
        // Reversed halfway: it starts from the middle, not from an end.
        let halfway = start + SLIDE / 2;
        let middle = state.position(halfway);
        state.set(false, true, halfway);
        assert!((state.position(halfway) - middle).abs() < 1e-6);
        assert_eq!(state.position(halfway + SLIDE), 0.0);
    }

    #[test]
    fn without_animation_the_thumb_jumps() {
        let now = Instant::now();
        let mut state = State {
            value: false,
            last_prop: false,
            from: 0.0,
            started: now - SLIDE,
        };
        state.set(true, false, now);
        assert_eq!(state.position(now), 1.0);
        assert!(!state.animating(now));
    }

    #[test]
    fn a_new_value_prop_replaces_the_native_value() {
        let tag = 910_001;
        let now = Instant::now();
        let (value, _, _) = sync(tag, &json!({"value": false}), false, now);
        assert!(!value);
        flip(
            &ComponentNode {
                component: "Switch".into(),
                tag,
                frame: Default::default(),
                scale: (1.0, 1.0),
                props: Arc::new(json!({"value": false})),
                parent: None,
                children: vec![],
            },
            false,
        );
        // `flip` stamps the change with its own clock reading, so read after it.
        let now = Instant::now();
        let (value, position, _) = sync(tag, &json!({"value": false}), false, now);
        assert!(
            value && position > 0.99,
            "the click is kept until JS changes the prop"
        );
        let (value, position, _) = sync(tag, &json!({"value": true}), false, now);
        assert!(value && position > 0.99);
        let (value, position, _) = sync(tag, &json!({"value": false}), false, now);
        assert!(!value && position < 0.01);
        states().lock().unwrap().remove(&tag);
    }
}
