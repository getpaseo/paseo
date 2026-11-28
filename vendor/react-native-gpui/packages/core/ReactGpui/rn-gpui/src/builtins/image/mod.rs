use gpui::{prelude::*, AnyElement, App, ObjectFit, StyledImage, Window};
use serde_json::Value;

use crate::extensions::{register_component_renderer, ComponentNode, ComponentRenderer};

mod processed;

struct ImageRenderer;

impl ComponentRenderer for ImageRenderer {
    fn content(
        &self,
        node: &ComponentNode,
        _window: &mut Window,
        _cx: &mut App,
    ) -> Option<AnyElement> {
        paint(&node.props, (node.frame.w, node.frame.h))
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

fn fit_for(resize_mode: Option<&str>) -> ObjectFit {
    match resize_mode {
        Some("contain") => ObjectFit::Contain,
        Some("cover") => ObjectFit::Cover,
        Some("center") | Some("none") => ObjectFit::ScaleDown,
        _ => ObjectFit::Fill,
    }
}

fn plain(uri: &str) -> Option<gpui::Img> {
    if let Some(data) = uri.strip_prefix("data:") {
        crate::node_view::decode_data_image(data).map(|image| gpui::img(std::sync::Arc::new(image)))
    } else if let Some(path) = crate::image_loader::file_uri_path(uri) {
        Some(gpui::img(path))
    } else {
        Some(gpui::img(
            crate::image_loader::dev_server_asset_url(uri).into_owned(),
        ))
    }
}

/// The image at its natural size, repeated across the box.
fn tiled(uri: String, tint: u32, blur: f32) -> AnyElement {
    gpui::canvas(
        |_, _, _| (),
        move |bounds, (), window, cx| {
            let Some(Ok(image)) = processed::image(&uri, tint, blur, window, cx) else {
                return;
            };
            let size = image.size(0);
            let scale = window.scale_factor();
            let (tile_w, tile_h) = (
                f32::from(size.width.0 as f32 / scale),
                f32::from(size.height.0 as f32 / scale),
            );
            if tile_w < 1.0 || tile_h < 1.0 {
                return;
            }
            window.with_content_mask(Some(gpui::ContentMask { bounds: bounds }), |window| {
                let mut y = 0.0;
                while y < f32::from(bounds.size.height) {
                    let mut x = 0.0;
                    while x < f32::from(bounds.size.width) {
                        let tile = gpui::Bounds {
                            origin: bounds.origin + gpui::point(gpui::px(x), gpui::px(y)),
                            size: gpui::size(gpui::px(tile_w), gpui::px(tile_h)),
                        };
                        let _ = window.paint_image(
                            tile,
                            tile,
                            gpui::Corners::default(),
                            image.clone(),
                            0,
                            false,
                        );
                        x += tile_w;
                    }
                    y += tile_h;
                }
            });
        },
    )
    .size_full()
    .into_any_element()
}

fn paint(props: &Value, size: (f32, f32)) -> Option<AnyElement> {
    let uri = props.get("uri")?.as_str()?;
    let resize_mode = props.get("resizeMode").and_then(Value::as_str);
    let tint = props.get("tintColor").and_then(Value::as_u64).unwrap_or(0) as u32;
    let blur = props
        .get("blurRadius")
        .and_then(Value::as_f64)
        .unwrap_or(0.0) as f32;
    if resize_mode == Some("repeat") {
        return Some(tiled(uri.to_owned(), tint, blur));
    }
    let fit = fit_for(resize_mode);
    let mut image = if tint >> 24 != 0 || blur > 0.0 {
        let uri = uri.to_owned();
        gpui::img(move |window: &mut Window, cx: &mut App| {
            processed::image(&uri, tint, blur, window, cx)
        })
    } else {
        plain(uri)?
    };
    if let Some(default) = props
        .get("defaultSource")
        .and_then(Value::as_str)
        .map(str::to_owned)
    {
        let mode = resize_mode.map(str::to_owned);
        image = image.with_loading(move || {
            let fit = fit_for(mode.as_deref());
            plain(&default)
                .map(|placeholder| placeholder.size_full().object_fit(fit).into_any_element())
                .unwrap_or_else(|| gpui::Empty.into_any_element())
        });
    }
    // The node's size in points, not 100%: the decoder reads it before the
    // image has loaded to know how big a picture to make.
    let image = if size.0 > 0.0 && size.1 > 0.0 {
        image.w(gpui::px(size.0)).h(gpui::px(size.1))
    } else {
        image.size_full()
    };
    Some(image.object_fit(fit).into_any_element())
}

pub fn register() {
    register_component_renderer("Image", std::sync::Arc::new(ImageRenderer));
}
