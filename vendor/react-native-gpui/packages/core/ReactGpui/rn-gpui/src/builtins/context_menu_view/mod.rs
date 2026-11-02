//! A view whose context menu opens natively.
//!
//! A right click (or Ctrl + click on macOS, or the Menu key on Windows and
//! Linux) opens the view's `items` straight from native, so the menu appears even
//! while JS is busy. JS only hears about the item that was chosen, through
//! `onMenuSelect`; the menu itself was never described to JS at the moment it
//! opened.
//!
//! The component lays out like a `View` — core paints the element, the style and
//! the children — so this renderer only claims the press and presents the menu.

use std::sync::Arc;

use gpui::{AnyElement, App, Window};
use serde_json::Value;

use crate::desktop::menu_model::{self, MenuModel};
use crate::events::ContextMenuTriggerSource;
use crate::extensions::input::{ContextMenuTrigger, InputContext, InputSpec, Propagation};
use crate::extensions::{register_component_renderer, ComponentNode, ComponentRenderer};

const OPEN_EVENT: &str = "topMenuOpen";

/// What a press on the view should do, decided from the parsed props alone.
///
/// Split out so the three outcomes — show a menu, stay out of the way, or report
/// a model that cannot be read — are testable without a window or a presenter.
enum MenuRequest {
    /// No `items`, or the press is not this view's to take.
    None,
    Menu(MenuModel),
    /// `items` was supposed to be a menu and is not one.
    Invalid(crate::desktop::errors::DesktopError),
}

/// Whether the press on this view belongs to its menu.
///
/// A disabled view has nothing to open, and a `custom` presentation is drawn by
/// JS, so neither takes the press.
fn claims_press(props: &Value) -> bool {
    if props
        .get("disabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return false;
    }
    // `custom` is drawn by JS, so the descending `View` opens it through
    // `onContextMenu`, exactly as it did before this component existed. Claiming
    // the press here would open a native menu over the React one.
    match props.get("presentation").and_then(Value::as_str) {
        Some("custom") => false,
        _ => true,
    }
}

/// Whether the props carry something that could be a menu.
///
/// An empty array is not one: `items` defaults to `[]` on the C++ side, and a
/// caller that filtered a dynamic menu down to nothing has no menu to show. Either
/// way the press belongs to whatever is behind the view, so this is not a menu
/// owner at all rather than an owner that shows nothing.
fn has_items(props: &Value) -> bool {
    match props.get("items") {
        None | Some(Value::Null) => false,
        Some(Value::Array(items)) => !items.is_empty(),
        // Not an array is a mistake worth reporting, so it still counts as "the
        // caller meant to pass a menu"; `request` turns it into `Invalid`.
        Some(_) => true,
    }
}

fn request(props: &Value) -> MenuRequest {
    if !claims_press(props) || !has_items(props) {
        return MenuRequest::None;
    }
    match menu_model::parse_menu(&props["items"]) {
        Ok(model) => MenuRequest::Menu(model),
        Err(error) => MenuRequest::Invalid(error),
    }
}

fn trigger_name(source: ContextMenuTriggerSource) -> &'static str {
    match source {
        ContextMenuTriggerSource::Mouse => "mouse",
        ContextMenuTriggerSource::Keyboard => "keyboard",
    }
}

/// The `topMenuOpen` payload, in the shape `topContextMenu` uses.
///
/// The two are the same press reported through different components, so a
/// handler written for `onContextMenu` keeps working when the wrapper switches
/// to the native path.
fn open_payload(trigger: &ContextMenuTrigger, window_id: u32) -> serde_json::Value {
    let x = f32::from(trigger.position.x);
    let y = f32::from(trigger.position.y);
    serde_json::json!({
        "x": x,
        "y": y,
        // The menu is placed in window coordinates, which is also the page's
        // here: the surface fills the window, and the top inset is part of the
        // layer's own origin rather than something a handler would add back.
        "pageX": x,
        "pageY": y,
        "windowId": window_id,
        "button": trigger.button.number(),
        "ctrlKey": trigger.modifiers.ctrl,
        "shiftKey": trigger.modifiers.shift,
        "altKey": trigger.modifiers.alt,
        "metaKey": trigger.modifiers.meta,
        "trigger": trigger_name(trigger.source),
    })
}

struct ContextMenuViewRenderer;

impl ComponentRenderer for ContextMenuViewRenderer {
    fn render(
        &self,
        _node: &ComponentNode,
        _window: &mut Window,
        _cx: &mut App,
    ) -> Option<AnyElement> {
        None
    }

    fn input(&self, node: &ComponentNode) -> InputSpec {
        if !claims_press(&node.props) || !has_items(&node.props) {
            return InputSpec::default();
        }
        crate::desktop::icon::prefetch_menu(&node.props["items"]);
        InputSpec {
            // No buttons: the right press is already reported by the node's own
            // listener. This flag is what makes the press find this component as
            // the menu's owner, and what keeps a parent `View`'s `onContextMenu`
            // from also firing.
            context_menu: true,
            ..InputSpec::default()
        }
    }

    fn on_context_menu(
        &self,
        node: &ComponentNode,
        trigger: &ContextMenuTrigger,
        cx: &mut InputContext<'_>,
    ) -> Propagation {
        match request(&node.props) {
            MenuRequest::None => Propagation::Continue,
            MenuRequest::Invalid(error) => {
                // A model JS built wrong is not a reason to swallow the press: an
                // ancestor's menu can still be a real one.
                log::warn!("[context-menu-view] ignoring unreadable items: {error}");
                Propagation::Continue
            }
            MenuRequest::Menu(model) => {
                cx.show_context_menu(model, trigger.position);
                // After the menu is up, so a handler that reads its own state
                // sees it already open. The payload carries what `onContextMenu`
                // reports, because the component keeps that prop working on this
                // path and the native side is the only place these fields exist.
                cx.dispatch_event(OPEN_EVENT, &open_payload(trigger, cx.window_id()));
                // Only the innermost view opens, as native menus do.
                Propagation::Stop
            }
        }
    }
}

pub fn register() {
    register_component_renderer("DesktopContextMenuView", Arc::new(ContextMenuViewRenderer));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desktop::menu_model::MenuNode;
    use serde_json::json;

    fn props(value: Value) -> Arc<Value> {
        Arc::new(value)
    }

    fn node(value: Value) -> ComponentNode {
        ComponentNode {
            component: "DesktopContextMenuView".to_string(),
            tag: 9,
            frame: rn_gpui_sys::ffi::RectF {
                x: 0.0,
                y: 0.0,
                w: 200.0,
                h: 40.0,
            },
            scale: (1.0, 1.0),
            props: props(value),
            parent: None,
            children: Vec::new(),
        }
    }

    const ITEMS: &str = r#"[
        {"id": "open", "label": "Open"},
        {"type": "submenu", "label": "More", "items": [
            {"id": "nested", "label": "Nested"}
        ]},
        {"type": "separator"},
        {"id": "pin", "label": "Pin", "checked": true}
    ]"#;

    fn items() -> Value {
        serde_json::from_str(ITEMS).expect("valid json")
    }

    #[test]
    fn items_become_the_same_model_a_js_menu_uses() {
        let value = json!({"items": items()});
        let MenuRequest::Menu(model) = request(&value) else {
            panic!("a readable menu");
        };
        assert_eq!(model.ids(), vec!["open", "nested", "pin"]);
        assert!(matches!(model.items[1], MenuNode::Submenu(_)));
        assert!(matches!(model.items[2], MenuNode::Separator));
        let MenuNode::Item(pin) = &model.items[3] else {
            panic!("a leaf item");
        };
        assert!(pin.checked);
    }

    #[test]
    fn a_disabled_view_asks_for_nothing() {
        let value = json!({"items": items(), "disabled": true});
        assert!(!claims_press(&value));
        assert!(matches!(request(&value), MenuRequest::None));
        // The spec is the other half: a disabled view must not become a menu
        // owner, or the press would be claimed with nothing to show.
        let spec = ContextMenuViewRenderer.input(&node(value));
        assert!(!spec.context_menu);
        assert_eq!(spec, InputSpec::default());
    }

    #[test]
    fn a_custom_presentation_is_left_to_js() {
        let value = json!({"items": items(), "presentation": "custom"});
        assert!(!claims_press(&value));
        assert!(!ContextMenuViewRenderer.input(&node(value)).context_menu);
    }

    #[test]
    fn native_and_default_presentations_open_here() {
        for presentation in [json!("default"), json!("native"), json!(null)] {
            let value = json!({"items": items(), "presentation": presentation});
            assert!(claims_press(&value), "{presentation}");
            assert!(ContextMenuViewRenderer.input(&node(value)).context_menu);
        }
    }

    #[test]
    fn items_that_are_not_a_menu_are_reported_rather_than_swallowed() {
        // The shape a caller gets wrong most easily: an item with no label.
        let value = json!({"items": [{"id": "a"}]});
        let MenuRequest::Invalid(error) = request(&value) else {
            panic!("an unreadable model");
        };
        assert_eq!(error.code, crate::desktop::errors::codes::INVALID_ARGUMENT);
        // Still an owner, so the hook runs and can log; the press is then passed
        // on rather than stopped.
        assert!(ContextMenuViewRenderer.input(&node(value)).context_menu);
    }

    #[test]
    fn no_items_is_simply_no_menu() {
        assert!(matches!(request(&json!({})), MenuRequest::None));
    }

    #[test]
    fn an_empty_menu_is_not_a_menu() {
        // What the C++ side sends for `items` left out, and what a caller that
        // filtered every entry out of a dynamic menu sends. Neither should claim
        // the press and then show nothing.
        assert!(matches!(request(&json!({"items": []})), MenuRequest::None));
        let spec = ContextMenuViewRenderer.input(&node(json!({"items": []})));
        assert!(!spec.context_menu);
    }
}
