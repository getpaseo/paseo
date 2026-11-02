//! A named scope for keyboard shortcuts.
//!
//! The component paints nothing of its own: core builds the box, the style and
//! the children exactly as it does for a `View`, and this only adds the node's
//! key context. Scopes nest, and GPUI resolves a keystroke against the contexts
//! on the focused element's dispatch path — so a binding in an inner scope
//! outranks one in an outer scope without any of that logic living here.
//!
//! The action listener lives in `node_view.rs` beside the element, because a
//! `ComponentRenderer` never sees the element it would have to attach to.

use std::sync::Arc;

use gpui::{AnyElement, App, Window};
use serde_json::Value;

use crate::desktop::keymap;
use crate::extensions::{register_component_renderer, ComponentNode, ComponentRenderer};

pub const COMPONENT: &str = "DesktopShortcutScope";

/// The scope a `ShortcutScope` node declares, or an empty string when its props
/// carry no usable name.
///
/// A scope with no name claims nothing: it still groups its children, but no
/// shortcut can be registered into it, which is better than every unnamed scope
/// sharing one context and overriding the others.
pub fn scope_name(node: &ComponentNode) -> String {
    node.props
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

struct ShortcutScopeRenderer;

impl ComponentRenderer for ShortcutScopeRenderer {
    /// Core paints the element, so the renderer claims no appearance at all.
    fn render(
        &self,
        _node: &ComponentNode,
        _window: &mut Window,
        _cx: &mut App,
    ) -> Option<AnyElement> {
        None
    }

    fn key_context(&self, node: &ComponentNode) -> Option<String> {
        let name = scope_name(node);
        if name.is_empty() {
            return None;
        }
        Some(keymap::scope_context(&name))
    }
}

pub fn register() {
    register_component_renderer("DesktopShortcutScope", Arc::new(ShortcutScopeRenderer));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn node(props: Value) -> ComponentNode {
        ComponentNode {
            component: COMPONENT.to_string(),
            tag: 1,
            frame: rn_gpui_sys::ffi::RectF {
                x: 0.0,
                y: 0.0,
                w: 100.0,
                h: 100.0,
            },
            scale: (1.0, 1.0),
            props: Arc::new(props),
            parent: None,
            children: Vec::new(),
        }
    }

    #[test]
    fn a_named_scope_gets_its_context() {
        let renderer = ShortcutScopeRenderer;
        assert_eq!(
            renderer.key_context(&node(serde_json::json!({"name": "editor"}))),
            Some("rn-scope-editor".to_string())
        );
    }

    #[test]
    fn an_unnamed_scope_claims_no_context() {
        let renderer = ShortcutScopeRenderer;
        assert_eq!(renderer.key_context(&node(serde_json::json!({}))), None);
        assert_eq!(
            renderer.key_context(&node(serde_json::json!({"name": ""}))),
            None
        );
        assert_eq!(
            renderer.key_context(&node(serde_json::json!({"name": 7}))),
            None
        );
    }

    #[test]
    fn scope_names_are_read_from_the_parsed_props() {
        assert_eq!(
            scope_name(&node(serde_json::json!({"name": "files"}))),
            "files"
        );
        assert_eq!(scope_name(&node(serde_json::json!({}))), "");
    }
}
