//! Typed readers over the JSON this module's C++ half produced.
//!
//! A missing key reads as today's zero value, so a component that has not been
//! given the prop yet behaves the way it did before it arrived.
use react_native_gpui::extensions::ComponentNode;

/// A number, or 0 when absent.
fn number(node: &ComponentNode, key: &str) -> f64 {
    node.props
        .get(key)
        .and_then(|value| value.as_f64())
        .unwrap_or(0.0)
}

/// A number as `f32`, or 0 when absent.
fn number_f32(node: &ComponentNode, key: &str) -> f32 {
    number(node, key) as f32
}

/// A string, borrowed from the props.
fn string<'a>(node: &'a ComponentNode, key: &str) -> &'a str {
    node.props
        .get(key)
        .and_then(|value| value.as_str())
        .unwrap_or("")
}

/// A boolean, false when absent.
fn boolean(node: &ComponentNode, key: &str) -> bool {
    node.props
        .get(key)
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

/// A colour as 0xAARRGGBB, 0 when unset.
fn color(node: &ComponentNode, key: &str) -> u32 {
    number(node, key) as u32
}

/// An `RNSScreen`'s activity state. 0 is detached, 1 is transitioning, 2 is
/// fully on screen.
pub fn activity_state(node: &ComponentNode) -> f32 {
    number_f32(node, "activityState")
}

/// An `RNSScreen`'s `stackAnimation`.
pub fn stack_animation(node: &ComponentNode) -> &str {
    string(node, "stackAnimation")
}

/// An `RNSScreen`'s `stackPresentation`.
pub fn stack_presentation(node: &ComponentNode) -> &str {
    string(node, "stackPresentation")
}

/// Whether a presentation paints its own card over the one underneath.
pub fn is_modal_presentation(node: &ComponentNode) -> bool {
    matches!(
        stack_presentation(node),
        "modal" | "transparentModal" | "containedModal" | "formSheet"
    )
}

/// Whether that card lets the screen underneath show through.
pub fn is_transparent_presentation(node: &ComponentNode) -> bool {
    stack_presentation(node) == "transparentModal"
}

/// A header config's title.
pub fn header_title(node: &ComponentNode) -> &str {
    string(node, "title")
}

/// A header config's background colour.
pub fn header_background_color(node: &ComponentNode) -> u32 {
    color(node, "backgroundColor")
}

/// A header config's title colour.
pub fn header_title_color(node: &ComponentNode) -> u32 {
    color(node, "titleColor")
}

/// A header config's tint colour, used for the back button.
pub fn header_tint_color(node: &ComponentNode) -> u32 {
    color(node, "tintColor")
}

/// Whether a header config hides the whole bar.
pub fn header_hidden(node: &ComponentNode) -> bool {
    boolean(node, "hidden")
}

/// Whether a header config hides only the back button.
pub fn header_hide_back(node: &ComponentNode) -> bool {
    boolean(node, "hideBackButton")
}

/// A header subview's placement: `left`, `right`, `center`, `title` or a Yoga x.
pub fn subview_type(node: &ComponentNode) -> &str {
    string(node, "type")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn node(json: serde_json::Value) -> ComponentNode {
        ComponentNode {
            component: "RNSScreen".to_string(),
            tag: 1,
            frame: rn_gpui_sys::ffi::RectF::default(),
            scale: (1.0, 1.0),
            props: Arc::new(json),
            parent: None,
            children: Vec::new(),
        }
    }

    #[test]
    fn a_missing_key_reads_as_the_zero_value() {
        let empty = node(serde_json::json!({}));
        assert_eq!(activity_state(&empty), 0.0);
        assert_eq!(stack_animation(&empty), "");
        assert_eq!(stack_presentation(&empty), "");
        assert_eq!(header_title(&empty), "");
        assert_eq!(header_background_color(&empty), 0);
        assert!(!header_hidden(&empty));
        assert!(!header_hide_back(&empty));
        assert!(!is_modal_presentation(&empty));
    }

    #[test]
    fn reads_the_fields_the_props_half_writes() {
        let screen = node(serde_json::json!({
            "activityState": 2,
            "stackAnimation": "slide_from_right",
            "stackPresentation": "transparentModal",
        }));
        assert_eq!(activity_state(&screen), 2.0);
        assert_eq!(stack_animation(&screen), "slide_from_right");
        assert!(is_modal_presentation(&screen));
        assert!(is_transparent_presentation(&screen));

        let header = node(serde_json::json!({
            "title": "Home",
            "backgroundColor": 0xff112233u32,
            "titleColor": 0xffaabbccu32,
            "tintColor": 0xff445566u32,
            "hidden": true,
            "hideBackButton": true,
        }));
        assert_eq!(header_title(&header), "Home");
        assert_eq!(header_background_color(&header), 0xff112233);
        assert_eq!(header_title_color(&header), 0xffaabbcc);
        assert_eq!(header_tint_color(&header), 0xff445566);
        assert!(header_hidden(&header));
        assert!(header_hide_back(&header));

        let subview = node(serde_json::json!({"type": "right"}));
        assert_eq!(subview_type(&subview), "right");
    }

    #[test]
    fn only_the_modal_presentations_count_as_modal() {
        for presentation in ["modal", "transparentModal", "containedModal", "formSheet"] {
            let node = node(serde_json::json!({"stackPresentation": presentation}));
            assert!(is_modal_presentation(&node), "{presentation}");
        }
        for presentation in ["push", "card", ""] {
            let node = node(serde_json::json!({"stackPresentation": presentation}));
            assert!(!is_modal_presentation(&node), "{presentation}");
        }
    }
}
