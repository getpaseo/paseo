//! The `filter` style, in the order its functions are listed: colour
//! functions become a matrix GPUI applies to what is under the node, `blur`
//! and `dropShadow` paint what is under the node into a group of its own and
//! work on that picture.

use gpui::{
    AnyElement, App, BlendMode, Bounds, ColorFilter, Element, ElementId, GlobalElementId,
    GroupEffect, InspectorElementId, IntoElement, LayoutId, Pixels, Window,
};

/// One step of a `filter`.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Step {
    /// Consecutive colour functions as one matrix.
    Color(ColorFilter),
    /// A gaussian blur of standard deviation `sigma`, in logical pixels.
    Blur(f32),
    DropShadow {
        dx: f32,
        dy: f32,
        sigma: f32,
        color: [f32; 4],
    },
}

/// The steps of `[[name, amount], ...]`, where a `dropShadow` carries
/// `{x, y, blur, color}` for its amount. Functions that change nothing are
/// left out.
pub(crate) fn parse(json: &str) -> Vec<Step> {
    // No filter, on nearly every node: not worth the error serde allocates.
    if json.is_empty() {
        return Vec::new();
    }
    let Ok(functions) = serde_json::from_str::<Vec<(String, serde_json::Value)>>(json) else {
        return Vec::new();
    };
    let mut steps = Vec::new();
    let mut matrix = ColorFilter::IDENTITY;
    let flush = |steps: &mut Vec<Step>, matrix: &mut ColorFilter| {
        if !matrix.is_identity() {
            steps.push(Step::Color(*matrix));
        }
        *matrix = ColorFilter::IDENTITY;
    };
    for (name, value) in functions {
        match name.as_str() {
            "blur" => {
                let sigma = value.as_f64().unwrap_or(0.0) as f32;
                if sigma.is_finite() && sigma > 0.0 {
                    flush(&mut steps, &mut matrix);
                    steps.push(Step::Blur(sigma));
                }
            }
            "dropShadow" => {
                let field = |key: &str| value.get(key).and_then(|v| v.as_f64()).unwrap_or(0.0);
                let argb = field("color") as i64 as u32;
                let [a, r, g, b] =
                    [24, 16, 8, 0].map(|shift| ((argb >> shift) & 0xff) as f32 / 255.0);
                flush(&mut steps, &mut matrix);
                steps.push(Step::DropShadow {
                    dx: field("x") as f32,
                    dy: field("y") as f32,
                    sigma: field("blur").max(0.0) as f32,
                    color: [r, g, b, a],
                });
            }
            _ => {
                if let Some(next) = value
                    .as_f64()
                    .and_then(|amount| function(&name, amount as f32))
                {
                    matrix = next.after(&matrix);
                }
            }
        }
    }
    flush(&mut steps, &mut matrix);
    steps
}

fn rgb(rows: [[f32; 3]; 3], offset: [f32; 3]) -> ColorFilter {
    ColorFilter {
        rows: [
            [rows[0][0], rows[0][1], rows[0][2], 0., offset[0]],
            [rows[1][0], rows[1][1], rows[1][2], 0., offset[1]],
            [rows[2][0], rows[2][1], rows[2][2], 0., offset[2]],
            [0., 0., 0., 1., 0.],
        ],
    }
}

/// One CSS filter function, per the Filter Effects spec's matrices.
fn function(name: &str, raw: f32) -> Option<ColorFilter> {
    if !raw.is_finite() {
        return None;
    }
    if name == "hueRotate" {
        // The amount is in degrees and may be negative.
        return hue_rotate(raw);
    }
    let amount = raw.max(0.0);
    let unit = amount.min(1.0);
    Some(match name {
        "brightness" => rgb(
            [[amount, 0., 0.], [0., amount, 0.], [0., 0., amount]],
            [0.; 3],
        ),
        "contrast" => {
            let offset = 0.5 - 0.5 * amount;
            rgb(
                [[amount, 0., 0.], [0., amount, 0.], [0., 0., amount]],
                [offset; 3],
            )
        }
        "grayscale" => {
            let k = 1.0 - unit;
            rgb(
                [
                    [
                        0.2126 + 0.7874 * k,
                        0.7152 - 0.7152 * k,
                        0.0722 - 0.0722 * k,
                    ],
                    [
                        0.2126 - 0.2126 * k,
                        0.7152 + 0.2848 * k,
                        0.0722 - 0.0722 * k,
                    ],
                    [
                        0.2126 - 0.2126 * k,
                        0.7152 - 0.7152 * k,
                        0.0722 + 0.9278 * k,
                    ],
                ],
                [0.; 3],
            )
        }
        "sepia" => {
            let k = 1.0 - unit;
            rgb(
                [
                    [0.393 + 0.607 * k, 0.769 - 0.769 * k, 0.189 - 0.189 * k],
                    [0.349 - 0.349 * k, 0.686 + 0.314 * k, 0.168 - 0.168 * k],
                    [0.272 - 0.272 * k, 0.534 - 0.534 * k, 0.131 + 0.869 * k],
                ],
                [0.; 3],
            )
        }
        "saturate" => rgb(
            [
                [
                    0.213 + 0.787 * amount,
                    0.715 - 0.715 * amount,
                    0.072 - 0.072 * amount,
                ],
                [
                    0.213 - 0.213 * amount,
                    0.715 + 0.285 * amount,
                    0.072 - 0.072 * amount,
                ],
                [
                    0.213 - 0.213 * amount,
                    0.715 - 0.715 * amount,
                    0.072 + 0.928 * amount,
                ],
            ],
            [0.; 3],
        ),
        "invert" => rgb(
            [
                [1. - 2. * unit, 0., 0.],
                [0., 1. - 2. * unit, 0.],
                [0., 0., 1. - 2. * unit],
            ],
            [unit; 3],
        ),
        "opacity" => ColorFilter {
            rows: [
                [1., 0., 0., 0., 0.],
                [0., 1., 0., 0., 0.],
                [0., 0., 1., 0., 0.],
                [0., 0., 0., unit, 0.],
            ],
        },
        _ => return None,
    })
}

fn hue_rotate(degrees: f32) -> Option<ColorFilter> {
    let (sin, cos) = degrees.to_radians().sin_cos();
    Some(rgb(
        [
            [
                0.213 + cos * 0.787 - sin * 0.213,
                0.715 - cos * 0.715 - sin * 0.715,
                0.072 - cos * 0.072 + sin * 0.928,
            ],
            [
                0.213 - cos * 0.213 + sin * 0.143,
                0.715 + cos * 0.285 + sin * 0.140,
                0.072 - cos * 0.072 - sin * 0.283,
            ],
            [
                0.213 - cos * 0.213 - sin * 0.787,
                0.715 - cos * 0.715 + sin * 0.715,
                0.072 + cos * 0.928 + sin * 0.072,
            ],
        ],
        [0.; 3],
    ))
}

/// `child` painted through `filter`.
pub(crate) struct Filtered {
    child: AnyElement,
    filter: ColorFilter,
}

impl Filtered {
    pub(crate) fn new(child: AnyElement, filter: ColorFilter) -> Self {
        Self { child, filter }
    }
}

impl IntoElement for Filtered {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for Filtered {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        (self.child.request_layout(window, cx), ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        let child = &mut self.child;
        window.with_color_filter(self.filter, |window| child.prepaint(window, cx));
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        _prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let child = &mut self.child;
        window.with_color_filter(self.filter, |window| child.paint(window, cx));
    }
}

/// The children of a component declared `maskChildren`: `content` painted into an isolated group,
/// then `mask` over it as a group that keeps only what its alpha covers. The
/// mask is laid out and painted like any child but takes no pointer input.
pub(crate) struct Masked {
    mask: AnyElement,
    content: Vec<AnyElement>,
}

impl Masked {
    pub(crate) fn new(mask: AnyElement, content: Vec<AnyElement>) -> Self {
        Self { mask, content }
    }
}

impl IntoElement for Masked {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for Masked {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let children: Vec<LayoutId> = std::iter::once(&mut self.mask)
            .chain(self.content.iter_mut())
            .map(|child| child.request_layout(window, cx))
            .collect();
        let mut style = gpui::Style::default();
        style.position = gpui::Position::Absolute;
        style.inset = gpui::Edges::all(gpui::px(0.0).into());
        (window.request_layout(style, children, cx), ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        let mask = &mut self.mask;
        window.without_hitboxes(|window| mask.prepaint(window, cx));
        for child in &mut self.content {
            child.prepaint(window, cx);
        }
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        _prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let (mask, content) = (&mut self.mask, &mut self.content);
        let mut paint_content = |window: &mut Window, cx: &mut App| {
            for child in content.iter_mut() {
                child.paint(window, cx);
            }
        };
        if !window.paints_effect_groups() {
            paint_content(window, cx);
            return;
        }
        window.with_group_effect(1.0, GroupEffect::Isolate, |window| {
            paint_content(window, cx);
            window.with_blended_group(1.0, GroupEffect::None, BlendMode::DestinationIn, |window| {
                window.cover_effect_group(bounds);
                mask.paint(window, cx);
            });
        });
    }
}

/// `child` painted into an effect group of its own and composited at `opacity`.
pub(crate) struct Grouped {
    child: AnyElement,
    opacity: f32,
    effect: Step,
    blend: BlendMode,
    isolate: bool,
}

/// The blend mode for RN's `BlendMode` ordinal.
pub(crate) fn blend_mode(ordinal: u8) -> BlendMode {
    use BlendMode::*;
    [
        Normal,
        Multiply,
        Screen,
        Overlay,
        Darken,
        Lighten,
        ColorDodge,
        ColorBurn,
        HardLight,
        SoftLight,
        Difference,
        Exclusion,
        Hue,
        Saturation,
        Color,
        Luminosity,
        PlusLighter,
    ]
    .get(ordinal as usize)
    .copied()
    .unwrap_or(Normal)
}

impl Grouped {
    pub(crate) fn new(child: AnyElement, opacity: f32) -> Self {
        Self {
            child,
            opacity,
            effect: Step::Color(ColorFilter::IDENTITY),
            blend: BlendMode::Normal,
            isolate: false,
        }
    }

    /// `child` faded by `opacity`, combined with the backdrop by `blend`,
    /// and, if `isolate`, painted as a group whatever the other two say.
    pub(crate) fn blended(
        child: AnyElement,
        opacity: f32,
        blend: BlendMode,
        isolate: bool,
    ) -> Self {
        Self {
            child,
            opacity,
            effect: Step::Color(ColorFilter::IDENTITY),
            blend,
            isolate,
        }
    }

    /// `child` with `step` done to its picture; `step` must be a blur or a
    /// drop shadow.
    pub(crate) fn with_step(child: AnyElement, step: Step) -> Self {
        Self {
            child,
            opacity: 1.0,
            effect: step,
            blend: BlendMode::Normal,
            isolate: false,
        }
    }
}

impl IntoElement for Grouped {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for Grouped {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        (self.child.request_layout(window, cx), ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        self.child.prepaint(window, cx);
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        _prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let child = &mut self.child;
        let scale = window.scale_factor();
        let effect = match self.effect {
            Step::Blur(sigma) => GroupEffect::Blur {
                sigma: sigma * scale,
            },
            Step::DropShadow {
                dx,
                dy,
                sigma,
                color,
            } => GroupEffect::DropShadow {
                dx: dx * scale,
                dy: dy * scale,
                sigma: sigma * scale,
                color,
            },
            Step::Color(_) if self.isolate => GroupEffect::Isolate,
            Step::Color(_) => GroupEffect::None,
        };
        window.with_blended_group(self.opacity, effect, self.blend, |window| {
            child.paint(window, cx)
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apply(filter: &ColorFilter, color: [f32; 4]) -> [f32; 4] {
        let mut out = [0.; 4];
        for (row, out) in filter.rows.iter().zip(out.iter_mut()) {
            *out = row[0] * color[0]
                + row[1] * color[1]
                + row[2] * color[2]
                + row[3] * color[3]
                + row[4];
        }
        out
    }

    fn near(a: [f32; 4], b: [f32; 4]) {
        for (x, y) in a.iter().zip(b) {
            assert!((x - y).abs() < 0.01, "{a:?} vs {b:?}");
        }
    }

    /// The matrix of the colour functions in `json`.
    fn matrix(json: &str) -> Option<ColorFilter> {
        parse(json).into_iter().find_map(|step| match step {
            Step::Color(filter) => Some(filter),
            _ => None,
        })
    }

    #[test]
    fn an_empty_or_neutral_filter_has_no_steps() {
        assert!(parse("[]").is_empty());
        assert!(parse("[[\"brightness\",1.0]]").is_empty());
        assert!(parse("[[\"blur\",0.0]]").is_empty());
        assert!(parse("not json").is_empty());
    }

    #[test]
    fn blur_and_drop_shadow_are_steps_in_order() {
        let json = "[[\"grayscale\",1.0],[\"blur\",4.0],[\"dropShadow\",{\"x\":2.0,\"y\":3.0,\"blur\":1.5,\"color\":4294901760}],[\"invert\",1.0]]";
        let steps = parse(json);
        assert_eq!(steps.len(), 4);
        assert!(matches!(steps[0], Step::Color(_)));
        assert_eq!(steps[1], Step::Blur(4.0));
        assert_eq!(
            steps[2],
            Step::DropShadow {
                dx: 2.0,
                dy: 3.0,
                sigma: 1.5,
                color: [1.0, 0.0, 0.0, 1.0]
            }
        );
        assert!(matches!(steps[3], Step::Color(_)));
    }

    #[test]
    fn grayscale_collapses_red_to_its_luminance() {
        let filter = matrix("[[\"grayscale\",1.0]]").unwrap();
        near(
            apply(&filter, [1., 0., 0., 1.]),
            [0.2126, 0.2126, 0.2126, 1.],
        );
    }

    #[test]
    fn invert_flips_each_channel() {
        let filter = matrix("[[\"invert\",1.0]]").unwrap();
        near(apply(&filter, [1., 0.25, 0., 1.]), [0., 0.75, 1., 1.]);
    }

    #[test]
    fn opacity_scales_alpha_only() {
        let filter = matrix("[[\"opacity\",0.5]]").unwrap();
        near(apply(&filter, [0.2, 0.4, 0.6, 1.]), [0.2, 0.4, 0.6, 0.5]);
    }

    #[test]
    fn contrast_pivots_on_mid_grey() {
        let filter = matrix("[[\"contrast\",2.0]]").unwrap();
        near(apply(&filter, [0.5, 0.75, 0.25, 1.]), [0.5, 1.0, 0.0, 1.]);
    }

    #[test]
    fn functions_apply_in_order() {
        // Brightness doubles, then invert flips: 0.25 -> 0.5 -> 0.5; 0.5 -> 1 -> 0.
        let filter = matrix("[[\"brightness\",2.0],[\"invert\",1.0]]").unwrap();
        near(apply(&filter, [0.25, 0.5, 0., 1.]), [0.5, 0., 1., 1.]);
    }

    #[test]
    fn a_full_turn_of_hue_changes_nothing() {
        assert!(matrix("[[\"hueRotate\",360.0]]").map_or(true, |filter| {
            let out = apply(&filter, [0.8, 0.2, 0.4, 1.]);
            (out[0] - 0.8).abs() < 0.01 && (out[1] - 0.2).abs() < 0.01
        }));
    }
}
