use gpui::{prelude::*, AnyElement, App, ObjectFit, Window};
use serde_json::Value;

use crate::extensions::{register_component_renderer, ComponentNode, ComponentRenderer};

struct ImageRenderer;

impl ComponentRenderer for ImageRenderer {
    fn content(
        &self,
        node: &ComponentNode,
        _window: &mut Window,
        _cx: &mut App,
    ) -> Option<AnyElement> {
        paint(
            node.props.get("uri")?.as_str()?,
            node.props.get("resizeMode"),
        )
    }

    fn render(
        &self,
        _node: &ComponentNode,
        _window: &mut Window,
        _cx: &mut App,
    ) -> Option<AnyElement> {
        None
    }
}

fn paint(uri: &str, resize_mode: Option<&Value>) -> Option<AnyElement> {
    let fit = match resize_mode.and_then(Value::as_str) {
        Some("contain") => ObjectFit::Contain,
        Some("cover") => ObjectFit::Cover,
        Some("center") => ObjectFit::ScaleDown,
        _ => ObjectFit::Fill,
    };
    let source = if let Some(data) = uri.strip_prefix("data:") {
        crate::node_view::decode_data_image(data).map(|image| gpui::img(std::sync::Arc::new(image)))
    } else if let Some(path) = crate::image_loader::file_uri_path(uri) {
        Some(gpui::img(path))
    } else {
        Some(gpui::img(
            crate::image_loader::dev_server_asset_url(uri).into_owned(),
        ))
    };
    Some(source?.size_full().object_fit(fit).into_any_element())
}

pub fn register() {
    register_component_renderer("Image", std::sync::Arc::new(ImageRenderer));
}
