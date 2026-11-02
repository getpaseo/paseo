use serde_json::Value;

use crate::extensions::{
    register_component_renderer, ComponentNode, ComponentRenderer, ScrollSpec,
};
use gpui::{AnyElement, App, Window};

const SCROLL_EVENT: &str = "topScroll";

struct ScrollViewRenderer;

impl ComponentRenderer for ScrollViewRenderer {
    fn render(
        &self,
        _node: &ComponentNode,
        _window: &mut Window,
        _cx: &mut App,
    ) -> Option<AnyElement> {
        None
    }

    fn scroll(&self, props: &Value) -> Option<ScrollSpec> {
        let number = |key: &str| props.get(key).and_then(Value::as_f64).unwrap_or(0.0) as f32;
        Some(ScrollSpec {
            content_size: (number("contentWidth"), number("contentHeight")),
            horizontal: props
                .get("horizontal")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            enabled: props
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            indicator: props
                .get("indicator")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            offset: (number("offsetX"), number("offsetY")),
            event: Some(SCROLL_EVENT.to_string()),
        })
    }
}

pub fn register() {
    register_component_renderer("ScrollView", std::sync::Arc::new(ScrollViewRenderer));
}
