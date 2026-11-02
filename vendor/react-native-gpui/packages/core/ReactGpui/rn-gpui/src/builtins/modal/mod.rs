use serde_json::Value;

use crate::extensions::{register_component_renderer, ComponentNode, ComponentRenderer, Portal};
use gpui::{AnyElement, App, Window};

const CLOSE_REQUEST_EVENT: &str = "topRequestClose";

struct ModalRenderer;

impl ComponentRenderer for ModalRenderer {
    fn render(
        &self,
        _node: &ComponentNode,
        _window: &mut Window,
        _cx: &mut App,
    ) -> Option<AnyElement> {
        None
    }

    fn portal(&self, props: &Value) -> Option<Portal> {
        Some(Portal {
            visible: props
                .get("visible")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            close_request_event: Some(CLOSE_REQUEST_EVENT.to_string()),
        })
    }
}

pub fn register() {
    register_component_renderer("ModalHostView", std::sync::Arc::new(ModalRenderer));
}
