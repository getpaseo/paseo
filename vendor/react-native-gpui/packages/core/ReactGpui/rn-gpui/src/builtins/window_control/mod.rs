//! A caption button: minimize, maximize/restore, or close.
//!
//! The action runs natively, so it works while JS is busy, and on Windows the
//! area takes part in the OS hit-test — which is what gives the snap-layout
//! flyout over a custom maximize button. Only the appearance comes from JS: the
//! component's `style` and `children` may be functions of the state this reports.

use std::sync::Arc;

use gpui::{AnyElement, App, Window};
use serde_json::Value;

use crate::extensions::input::{
    InputContext, InputSpec, MouseEvent, Propagation, WindowControl as ControlArea,
};
use crate::extensions::{register_component_renderer, ComponentNode, ComponentRenderer};

struct WindowControlRenderer;

/// What `action` names, or `None` when the button is disabled.
///
/// Disabled means no area as well as no action: on Windows the OS would otherwise
/// still draw the snap flyout over a button that does nothing.
fn claimed_area(props: &Value) -> Option<ControlArea> {
    if props
        .get("disabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }
    match props.get("action").and_then(Value::as_str) {
        Some("minimize") => Some(ControlArea::Minimize),
        Some("maximize") => Some(ControlArea::Maximize),
        Some("close") => Some(ControlArea::Close),
        // The prop has a native default of `close`, and core reads the parsed
        // props, so anything else is a button with nothing to do.
        _ => None,
    }
}

impl ComponentRenderer for WindowControlRenderer {
    fn render(
        &self,
        _node: &ComponentNode,
        _window: &mut Window,
        _cx: &mut App,
    ) -> Option<AnyElement> {
        // Core paints the element, the style and the children; this renderer only
        // claims the area and tracks state.
        None
    }

    fn window_control(&self, node: &ComponentNode) -> Option<ControlArea> {
        claimed_area(&node.props)
    }

    fn input(&self, node: &ComponentNode) -> InputSpec {
        if claimed_area(&node.props).is_none() {
            return InputSpec::default();
        }
        InputSpec {
            mouse_buttons: crate::extensions::input::ButtonSet::one(crate::events::Button::Left),
            hover: true,
            cursor: Some(crate::extensions::input::CursorStyle::Pointer),
            ..InputSpec::default()
        }
    }

    fn on_hover(&self, node: &ComponentNode, hovered: bool, cx: &mut InputContext<'_>) {
        send_state(node, hovered, false, cx);
    }

    fn on_mouse_down(
        &self,
        node: &ComponentNode,
        _event: &MouseEvent,
        cx: &mut InputContext<'_>,
    ) -> Propagation {
        send_state(node, true, true, cx);
        // Capture so a release outside the button cancels rather than acting.
        cx.capture_pointer();
        Propagation::Stop
    }

    fn on_mouse_up(
        &self,
        node: &ComponentNode,
        event: &MouseEvent,
        cx: &mut InputContext<'_>,
    ) -> Propagation {
        cx.release_pointer();
        send_state(node, false, false, cx);
        // Only a release inside the button acts, as a native caption button does.
        let inside = event.local.x >= gpui::px(0.0)
            && event.local.y >= gpui::px(0.0)
            && event.local.x <= gpui::px(node.frame.w)
            && event.local.y <= gpui::px(node.frame.h);
        if !inside {
            return Propagation::Stop;
        }
        // macOS and Linux act here; on Windows the OS hit-test performs the action
        // and this would double it, so it is skipped. See `perform_action`.
        perform_action(node, cx);
        Propagation::Stop
    }
}

/// Sends `onControlStateChange`.
///
/// Called on a hover edge, a press and a release — never for every pointer move —
/// because the edge is decided by the node's own `hovered` flag.
fn send_state(_node: &ComponentNode, hovered: bool, pressed: bool, cx: &mut InputContext<'_>) {
    // No deduplication here: `on_hover` is only called on a real edge now that the
    // previous state lives on the node, and a press or release is always a change.
    // A second guess at it read a prop that never exists, so it never fired.
    let maximized = cx.window_is_maximized();
    cx.dispatch_event(
        "topControlStateChange",
        &serde_json::json!({
            "hovered": hovered,
            "pressed": pressed,
            "maximized": maximized,
        }),
    );
}

/// Performs the button's action, on the platforms where core owns it.
fn perform_action(node: &ComponentNode, cx: &mut InputContext<'_>) {
    // On Windows the OS performs the action through the non-client hit-test, which
    // is what makes snap layouts work. Doing it here too would run it twice.
    if std::env::consts::OS == "windows" {
        return;
    }
    match claimed_area(&node.props) {
        Some(ControlArea::Minimize) => cx.minimize_window(),
        Some(ControlArea::Maximize) => cx.toggle_maximize_window(),
        Some(ControlArea::Close) => cx.close_window(),
        _ => {}
    }
}

pub fn register() {
    register_component_renderer("DesktopWindowControl", Arc::new(WindowControlRenderer));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(props: Value) -> ComponentNode {
        ComponentNode {
            component: "DesktopWindowControl".to_string(),
            tag: 1,
            frame: rn_gpui_sys::ffi::RectF {
                x: 0.0,
                y: 0.0,
                w: 34.0,
                h: 26.0,
            },
            scale: (1.0, 1.0),
            props: Arc::new(props),
            parent: None,
            children: Vec::new(),
        }
    }

    #[test]
    fn each_action_claims_its_area() {
        assert_eq!(
            claimed_area(&serde_json::json!({ "action": "minimize" })),
            Some(ControlArea::Minimize)
        );
        assert_eq!(
            claimed_area(&serde_json::json!({ "action": "maximize" })),
            Some(ControlArea::Maximize)
        );
        assert_eq!(
            claimed_area(&serde_json::json!({ "action": "close" })),
            Some(ControlArea::Close)
        );
    }

    #[test]
    fn a_disabled_button_claims_nothing() {
        // No area means no hover, no press and no snap flyout on Windows: a
        // caption button that does nothing must not look like it does.
        assert_eq!(
            claimed_area(&serde_json::json!({ "action": "close", "disabled": true })),
            None
        );
    }

    #[test]
    fn an_unknown_action_claims_nothing() {
        assert_eq!(
            claimed_area(&serde_json::json!({ "action": "explode" })),
            None
        );
        assert_eq!(claimed_area(&serde_json::json!({})), None);
    }
}
