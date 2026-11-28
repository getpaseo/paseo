use gpui::{div, prelude::*, px, AnyElement, App, Window};
use react_native_gpui::extensions::{
    register_component_renderer, ComponentNode, ComponentRenderer,
};
use rn_gpui_sys::ffi::RectF;
use std::sync::Arc;

mod cache;
mod key;
mod raster;

const COMPONENTS: &[&str] = &[
    "RNSVGSvgView",
    "RNSVGCircle",
    "RNSVGEllipse",
    "RNSVGLine",
    "RNSVGPath",
    "RNSVGRect",
    "RNSVGGroup",
    "RNSVGDefs",
    "RNSVGClipPath",
    "RNSVGLinearGradient",
    "RNSVGRadialGradient",
    "RNSVGText",
    "RNSVGTSpan",
    "RNSVGMask",
    "RNSVGSymbol",
    "RNSVGPattern",
    "RNSVGMarker",
    "RNSVGTextPath",
    "RNSVGUse",
    "RNSVGFilter",
    "RNSVGFeBlend",
    "RNSVGFeColorMatrix",
    "RNSVGFeComposite",
    "RNSVGFeFlood",
    "RNSVGFeGaussianBlur",
    "RNSVGFeMerge",
    "RNSVGFeOffset",
];

struct SvgRenderer;

impl ComponentRenderer for SvgRenderer {
    // The SVG document is drawn from the shapes under its root.
    fn reads_children(&self) -> bool {
        true
    }

    fn render(
        &self,
        node: &ComponentNode,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<AnyElement> {
        if node.component != "RNSVGSvgView" {
            return Some(div().into_any_element());
        }
        // The frame is in unscaled coordinates and this element is painted
        // scaled, exactly as `ComponentRenderer::render` documents, so the box
        // has to be scaled the same way core scales the element it would have
        // built. `size_full()` sized the image to its parent instead: the
        // document is rasterized at the window's scale factor, and an image
        // carries no intrinsic size, so every SVG stretched to fill whatever
        // surrounded it and painted over the text below it.
        let frame = node.frame;
        let (scale_x, scale_y) = node.scale;
        let width = frame.w * scale_x;
        let height = frame.h * scale_y;
        let scale = window.scale_factor();
        let image = raster::image_for(node, frame, scale, window, cx);
        // Chrome paints an inline SVG at a whole CSS pixel: a box laid out at
        // 2.5 is drawn at 3. The image is placed the same way, so a 15 point
        // icon centred in a 20 point button lands where the web app's does.
        Some(
            gpui::canvas(
                |bounds, _, _| bounds,
                move |_, bounds, window, _| {
                    let snapped = gpui::Bounds::new(
                        gpui::point(
                            px((bounds.origin.x.as_f32() + 0.5).floor()),
                            px((bounds.origin.y.as_f32() + 0.5).floor()),
                        ),
                        bounds.size,
                    );
                    if let Some(image) = &image {
                        let _ = window.paint_image(
                            snapped,
                            snapped,
                            gpui::Corners::default(),
                            image.clone(),
                            0,
                            false,
                        );
                    }
                },
            )
            .w(px(width))
            .h(px(height))
            .into_any_element(),
        )
    }
}

pub fn rn_gpui_register() {
    for component in COMPONENTS {
        register_component_renderer(*component, Arc::new(SvgRenderer));
    }
}

/// Where one coverage sample sits, so a shape can be drawn once per sample.
#[derive(Clone, Copy)]
pub(crate) struct Sample {
    /// The sample's offset from the pixel centre, in device pixels.
    pub(crate) dx: f32,
    pub(crate) dy: f32,
    /// Device pixels per CSS pixel.
    pub(crate) scale: f32,
}

/// Chrome rasterises with four coverage samples per pixel at these offsets (in
/// pixels from the centre): the standard Direct3D 4x pattern. A pixel is
/// therefore never covered by anything but 0, 1/4, 1/2, 3/4 or all, and the edge
/// of an icon takes the same five steps here.
pub(crate) const SAMPLE_OFFSETS: [(f32, f32); 4] = [
    (-2.0 / 16.0, -6.0 / 16.0),
    (6.0 / 16.0, -2.0 / 16.0),
    (-6.0 / 16.0, 2.0 / 16.0),
    (2.0 / 16.0, 6.0 / 16.0),
];

pub(crate) fn svg_document(node: &ComponentNode, frame: RectF, sample: Option<Sample>) -> String {
    let props = &node.props;
    let mut attributes = format!(
        "xmlns=\"http://www.w3.org/2000/svg\" width=\"{}\" height=\"{}\"",
        svg_number(frame.w),
        svg_number(frame.h)
    );
    if sample.is_some() {
        attributes.push_str(" shape-rendering=\"crispEdges\"");
    }
    for (name, attribute) in [
        ("color", "color"),
        ("fill", "fill"),
        ("stroke", "stroke"),
        ("strokeWidth", "stroke-width"),
        ("fillOpacity", "fill-opacity"),
        ("strokeOpacity", "stroke-opacity"),
        ("opacity", "opacity"),
    ] {
        if let Some(value) = props.get(name).filter(|value| !value.is_null()) {
            if let Some(value) = svg_value(value) {
                attributes.push_str(&format!(" {attribute}=\"{}\"", svg_escape(&value)));
            }
        }
    }
    if let Some(cap) = props
        .get("strokeLinecap")
        .and_then(serde_json::Value::as_i64)
    {
        let cap = ["butt", "round", "square"]
            .get(cap as usize)
            .copied()
            .unwrap_or("butt");
        attributes.push_str(&format!(" stroke-linecap=\"{cap}\""));
    }
    if let Some(join) = props
        .get("strokeLinejoin")
        .and_then(serde_json::Value::as_i64)
    {
        let join = ["miter", "round", "bevel"]
            .get(join as usize)
            .copied()
            .unwrap_or("miter");
        attributes.push_str(&format!(" stroke-linejoin=\"{join}\""));
    }
    let view_box = match (
        props.get("vbWidth").and_then(serde_json::Value::as_f64),
        props.get("vbHeight").and_then(serde_json::Value::as_f64),
    ) {
        (Some(width), Some(height)) if width > 0.0 && height > 0.0 => {
            let min_x = props
                .get("minX")
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(0.0);
            let min_y = props
                .get("minY")
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(0.0);
            let align = props.get("align").and_then(serde_json::Value::as_str);
            let mode = match props
                .get("meetOrSlice")
                .and_then(serde_json::Value::as_i64)
                .unwrap_or(0)
            {
                1 => "slice",
                2 => "none",
                _ => "meet",
            };
            Some((min_x, min_y, width, height, align, mode))
        }
        _ => None,
    };
    match (view_box, sample) {
        (Some((min_x, min_y, width, height, align, mode)), sample) => {
            // The sample's shift in user units: how many of them one device
            // pixel covers depends on how the view box is fitted to the frame.
            let (mut min_x, mut min_y) = (min_x, min_y);
            if let Some(sample) = sample {
                let fit_x = f64::from(frame.w * sample.scale) / width;
                let fit_y = f64::from(frame.h * sample.scale) / height;
                let (unit_x, unit_y) = match (align, mode) {
                    (Some("none"), _) | (Some(_), "none") => (fit_x, fit_y),
                    (_, "slice") => (fit_x.max(fit_y), fit_x.max(fit_y)),
                    _ => (fit_x.min(fit_y), fit_x.min(fit_y)),
                };
                min_x += f64::from(sample.dx) / unit_x;
                min_y += f64::from(sample.dy) / unit_y;
            }
            attributes.push_str(&format!(
                " viewBox=\"{} {} {} {}\"",
                svg_number(min_x as f32),
                svg_number(min_y as f32),
                svg_number(width as f32),
                svg_number(height as f32)
            ));
            if let Some(align) = align {
                attributes.push_str(&format!(
                    " preserveAspectRatio=\"{} {}\"",
                    svg_escape(align),
                    mode
                ));
            }
        }
        (None, Some(sample)) => {
            // Without a view box the user unit is the CSS pixel; one is added
            // only to carry the shift.
            attributes.push_str(&format!(
                " viewBox=\"{} {} {} {}\"",
                svg_number(sample.dx / sample.scale),
                svg_number(sample.dy / sample.scale),
                svg_number(frame.w),
                svg_number(frame.h)
            ));
        }
        (None, None) => {}
    }
    let mut document = format!("<svg {attributes}>");
    for child in &node.children {
        svg_node(child, &mut document);
    }
    document.push_str("</svg>");
    document
}

fn svg_node(node: &ComponentNode, output: &mut String) {
    let props = &node.props;
    let element = match node.component.as_str() {
        "RNSVGCircle" => "circle",
        "RNSVGEllipse" => "ellipse",
        "RNSVGLine" => "line",
        "RNSVGPath" => "path",
        "RNSVGRect" => "rect",
        "RNSVGGroup" => "g",
        "RNSVGDefs" => "defs",
        "RNSVGClipPath" => "clipPath",
        "RNSVGLinearGradient" => "linearGradient",
        "RNSVGRadialGradient" => "radialGradient",
        "RNSVGMask" => "mask",
        "RNSVGSymbol" => "symbol",
        "RNSVGPattern" => "pattern",
        "RNSVGMarker" => "marker",
        "RNSVGText" => "text",
        "RNSVGTSpan" => "tspan",
        "RNSVGTextPath" => "textPath",
        "RNSVGUse" => "use",
        "RNSVGFilter" => "filter",
        "RNSVGFeBlend" => "feBlend",
        "RNSVGFeColorMatrix" => "feColorMatrix",
        "RNSVGFeComposite" => "feComposite",
        "RNSVGFeFlood" => "feFlood",
        "RNSVGFeGaussianBlur" => "feGaussianBlur",
        "RNSVGFeMerge" => "feMerge",
        "RNSVGFeOffset" => "feOffset",
        _ => "",
    };
    if element.is_empty() {
        for child in &node.children {
            svg_node(child, output);
        }
        return;
    }
    let mut attributes = String::new();
    for name in [
        "id",
        "name",
        "href",
        "d",
        "x",
        "y",
        "x1",
        "y1",
        "x2",
        "y2",
        "cx",
        "cy",
        "r",
        "rx",
        "ry",
        "width",
        "height",
        "color",
        "fill",
        "stroke",
        "strokeWidth",
        "fillOpacity",
        "strokeOpacity",
        "strokeDasharray",
        "strokeDashoffset",
        "strokeMiterlimit",
        "opacity",
        "fontSize",
        "fontWeight",
        "fontFamily",
        "textLength",
        "dominantBaseline",
        "offset",
        "stopColor",
        "stopOpacity",
    ] {
        if !svg_property_is_set(props, name) {
            continue;
        }
        if let Some(value) = props.get(name) {
            let attribute = match name {
                "strokeWidth" => "stroke-width",
                "fillOpacity" => "fill-opacity",
                "strokeOpacity" => "stroke-opacity",
                "strokeDasharray" => "stroke-dasharray",
                "strokeDashoffset" => "stroke-dashoffset",
                "strokeMiterlimit" => "stroke-miterlimit",
                "fontSize" => "font-size",
                "fontWeight" => "font-weight",
                "fontFamily" => "font-family",
                "dominantBaseline" => "dominant-baseline",
                "stopColor" => "stop-color",
                "stopOpacity" => "stop-opacity",
                other => other,
            };
            let value = if value.is_null() && matches!(name, "fill" | "stroke") {
                Some("none".to_owned())
            } else {
                svg_value(value)
            };
            if let Some(value) = value {
                attributes.push_str(&format!(" {attribute}=\"{}\"", svg_escape(&value)));
            }
        }
    }
    if let Some(rule) = props
        .get("fillRule")
        .filter(|_| svg_property_is_set(props, "fillRule"))
        .and_then(serde_json::Value::as_i64)
    {
        attributes.push_str(&format!(
            " fill-rule=\"{}\"",
            if rule == 0 { "evenodd" } else { "nonzero" }
        ));
    }
    if let Some(cap) = props
        .get("strokeLinecap")
        .filter(|_| svg_property_is_set(props, "strokeLinecap"))
        .and_then(serde_json::Value::as_i64)
    {
        let cap = ["butt", "round", "square"]
            .get(cap as usize)
            .copied()
            .unwrap_or("butt");
        attributes.push_str(&format!(" stroke-linecap=\"{cap}\""));
    }
    if let Some(join) = props
        .get("strokeLinejoin")
        .filter(|_| svg_property_is_set(props, "strokeLinejoin"))
        .and_then(serde_json::Value::as_i64)
    {
        let join = ["miter", "round", "bevel"]
            .get(join as usize)
            .copied()
            .unwrap_or("miter");
        attributes.push_str(&format!(" stroke-linejoin=\"{join}\""));
    }
    if let Some(matrix) = props.get("matrix").and_then(serde_json::Value::as_array) {
        let component = |index: usize| matrix.get(index).and_then(serde_json::Value::as_f64);
        let values = match matrix.len() {
            6 => [0, 1, 2, 3, 4, 5],
            16.. => [0, 1, 4, 5, 12, 13],
            _ => [usize::MAX; 6],
        }
        .map(component);
        if let [Some(a), Some(b), Some(c), Some(d), Some(e), Some(f)] = values {
            attributes.push_str(&format!(" transform=\"matrix({a} {b} {c} {d} {e} {f})\""));
        }
    }
    if let Some(id) = props
        .get("name")
        .and_then(serde_json::Value::as_str)
        .filter(|id| !id.is_empty())
    {
        attributes.push_str(&format!(" id=\"{}\"", svg_escape(id)));
    }
    if let Some(filter) = props
        .get("filter")
        .and_then(serde_json::Value::as_str)
        .filter(|filter| !filter.is_empty())
    {
        attributes.push_str(&format!(" filter=\"url(#{})\"", svg_escape(filter)));
    }
    if element == "filter" {
        attributes.push_str(" color-interpolation-filters=\"sRGB\"");
    }
    if element.starts_with("fe") || element == "filter" {
        attributes.push_str(&filter_primitive_attributes(props));
    }
    output.push('<');
    output.push_str(element);
    output.push_str(&attributes);
    output.push('>');
    if element == "feMerge" {
        for id in props
            .get("nodes")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(serde_json::Value::as_str)
        {
            output.push_str(&format!("<feMergeNode in=\"{}\"/>", svg_escape(id)));
        }
    }
    for child in &node.children {
        svg_node(child, output);
    }
    output.push_str("</");
    output.push_str(element);
    output.push('>');
}

fn filter_primitive_attributes(props: &serde_json::Value) -> String {
    let mut attributes = String::new();
    let text = |name: &str| match props.get(name) {
        Some(serde_json::Value::String(value)) if !value.is_empty() => Some(value.clone()),
        Some(value) if value.is_array() || value.is_number() => svg_value(value),
        _ => None,
    };
    for (name, attribute) in [
        ("in1", "in"),
        ("in2", "in2"),
        ("result", "result"),
        ("mode", "mode"),
        ("type", "type"),
        ("values", "values"),
        ("operator1", "operator"),
        ("k1", "k1"),
        ("k2", "k2"),
        ("k3", "k3"),
        ("k4", "k4"),
        ("dx", "dx"),
        ("dy", "dy"),
        ("edgeMode", "edgeMode"),
        ("floodOpacity", "flood-opacity"),
        ("filterUnits", "filterUnits"),
        ("primitiveUnits", "primitiveUnits"),
    ] {
        if let Some(value) = text(name) {
            attributes.push_str(&format!(" {attribute}=\"{}\"", svg_escape(&value)));
        }
    }
    if let Some(color) = props.get("floodColor").and_then(svg_value) {
        attributes.push_str(&format!(" flood-color=\"{}\"", svg_escape(&color)));
    }
    let deviation = |name: &str| props.get(name).and_then(serde_json::Value::as_f64);
    if let Some(x) = deviation("stdDeviationX") {
        let y = deviation("stdDeviationY").unwrap_or(x);
        attributes.push_str(&format!(" stdDeviation=\"{x} {y}\""));
    }
    attributes
}

fn svg_property_is_set(props: &serde_json::Value, name: &str) -> bool {
    if !matches!(
        name,
        "fill"
            | "fillOpacity"
            | "fillRule"
            | "stroke"
            | "strokeWidth"
            | "strokeOpacity"
            | "strokeLinecap"
            | "strokeLinejoin"
            | "strokeDasharray"
            | "strokeDashoffset"
            | "strokeMiterlimit"
    ) {
        return true;
    }
    props
        .get("propList")
        .and_then(serde_json::Value::as_array)
        .is_none_or(|properties| {
            properties
                .iter()
                .any(|property| property.as_str() == Some(name))
        })
}

fn svg_value(value: &serde_json::Value) -> Option<String> {
    match value.get("type").and_then(serde_json::Value::as_i64) {
        Some(1) => {
            return value
                .get("brushRef")
                .and_then(serde_json::Value::as_str)
                .map(|id| format!("url(#{id})"))
        }
        Some(2) => return Some("currentColor".to_owned()),
        Some(3) => return Some("context-fill".to_owned()),
        Some(4) => return Some("context-stroke".to_owned()),
        _ => {}
    }

    if let Some(number) = value.as_f64() {
        if number < 0.0 && number.fract() == 0.0 {
            return Some(format!("#{:06x}", (number as i64 as u32) & 0x00ff_ffff));
        }
        if (0x0100_0000..=0xffff_ffff).contains(&(number as u64)) {
            let argb = number as u32;
            return Some(format!(
                "rgba({}, {}, {}, {})",
                (argb >> 16) & 0xff,
                (argb >> 8) & 0xff,
                argb & 0xff,
                ((argb >> 24) & 0xff) as f32 / 255.0
            ));
        }
        return Some(svg_number(number as f32));
    }
    if let Some(value) = value.as_str() {
        return Some(value.to_owned());
    }
    if let Some(value) = value.as_array() {
        return Some(
            value
                .iter()
                .filter_map(svg_value)
                .collect::<Vec<_>>()
                .join(" "),
        );
    }
    value
        .get("payload")
        .and_then(svg_value)
        .or_else(|| value.get("value").and_then(svg_value))
}

fn svg_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn svg_number(value: f32) -> String {
    if value.fract() == 0.0 {
        format!("{value:.0}")
    } else {
        value.to_string()
    }
}

#[cfg(test)]
mod svg_paint_tests {
    use super::{svg_property_is_set, svg_value};
    use serde_json::json;

    #[test]
    fn brushes_keep_current_color_and_reference_semantics() {
        assert_eq!(
            svg_value(&json!({"type": 2})).as_deref(),
            Some("currentColor")
        );
        assert_eq!(
            svg_value(&json!({"type": 1, "brushRef": "gradient"})).as_deref(),
            Some("url(#gradient)")
        );
        assert_eq!(
            svg_value(&json!({"type": 0, "payload": 0xff64d2ff_u32})).as_deref(),
            Some("rgba(100, 210, 255, 1)")
        );
    }

    #[test]
    fn default_black_fill_does_not_override_inherited_none() {
        let child = json!({"fill": {"type": 0, "payload": 0xff000000_u32}, "strokeLinecap": 0, "propList": []});
        assert!(!svg_property_is_set(&child, "fill"));
        assert!(!svg_property_is_set(&child, "strokeLinecap"));
        let group = json!({"fill": null, "stroke": {"type": 2}, "propList": ["fill", "stroke"]});
        assert!(svg_property_is_set(&group, "fill"));
        assert!(svg_property_is_set(&group, "stroke"));
    }
}
