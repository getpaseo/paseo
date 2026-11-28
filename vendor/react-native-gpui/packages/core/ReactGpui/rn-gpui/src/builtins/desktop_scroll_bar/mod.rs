//! The scrollbar component.
//!
//! It paints nothing: the scroll view that contains it finds it while the store
//! refreshes the tree (`store::refresh_inherited_tree`) and draws its own bar
//! from these props.

use std::sync::Arc;

use gpui::{AnyElement, App, Window};

use crate::extensions::{register_component_renderer, ComponentNode, ComponentRenderer};

pub const COMPONENT: &str = "DesktopScrollBar";

struct ScrollBarRenderer;

impl ComponentRenderer for ScrollBarRenderer {
    fn render(
        &self,
        _node: &ComponentNode,
        _window: &mut Window,
        _cx: &mut App,
    ) -> Option<AnyElement> {
        None
    }
}

pub fn register() {
    register_component_renderer(COMPONENT, Arc::new(ScrollBarRenderer));
}
