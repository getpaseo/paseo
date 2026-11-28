//! `backgroundImage`: linear and radial gradients with `backgroundSize`,
//! `backgroundPosition` and `backgroundRepeat`, rasterised on the CPU.
//!
//! The gradient is drawn into an image the size of the box, which GPUI paints
//! with the box's corner radii. That keeps every gradient, whatever its angle,
//! stops or shape, working on each platform's renderer without a shader.

use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq)]
enum Unit {
    None,
    Point(f32),
    Percent(f32),
}

impl Unit {
    fn parse(value: &Value) -> Unit {
        let amount = value.get("value").and_then(Value::as_f64).unwrap_or(0.0) as f32;
        match value.get("unit").and_then(Value::as_str) {
            Some("pt") => Unit::Point(amount),
            Some("pct") => Unit::Percent(amount),
            _ => Unit::None,
        }
    }

    fn optional(value: Option<&Value>) -> Option<Unit> {
        value.filter(|value| !value.is_null()).map(Unit::parse)
    }

    fn resolve(self, reference: f32) -> f32 {
        match self {
            Unit::Point(amount) => amount,
            Unit::Percent(amount) => amount * reference / 100.0,
            Unit::None => 0.0,
        }
    }
}

#[derive(Clone, Debug)]
struct Stop {
    /// Premultiplied red, green, blue and alpha, each 0 to 1.
    color: [f32; 4],
    position: Unit,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Corner {
    TopRight,
    BottomRight,
    TopLeft,
    BottomLeft,
}

#[derive(Clone, Debug)]
enum RadialSize {
    Keyword(String),
    Dimensions(Unit, Unit),
}

#[derive(Clone, Debug, Default)]
struct Edges {
    top: Option<Unit>,
    left: Option<Unit>,
    right: Option<Unit>,
    bottom: Option<Unit>,
}

impl Edges {
    fn parse(value: &Value) -> Edges {
        Edges {
            top: Unit::optional(value.get("top")),
            left: Unit::optional(value.get("left")),
            right: Unit::optional(value.get("right")),
            bottom: Unit::optional(value.get("bottom")),
        }
    }
}

#[derive(Clone, Debug)]
enum Layer {
    Linear {
        angle: Option<f32>,
        corner: Option<Corner>,
        stops: Vec<Stop>,
        repeating: bool,
    },
    Radial {
        circle: bool,
        size: RadialSize,
        position: Edges,
        stops: Vec<Stop>,
        repeating: bool,
    },
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Repeat {
    Repeat,
    Space,
    Round,
    NoRepeat,
}

#[derive(Clone, Debug)]
enum TileSize {
    Auto,
    Cover,
    Contain,
    Lengths(Option<Unit>, Option<Unit>),
}

#[derive(Clone, Debug)]
pub(crate) struct Background {
    layers: Vec<Layer>,
    sizes: Vec<TileSize>,
    positions: Vec<Edges>,
    repeats: Vec<(Repeat, Repeat)>,
}

fn color_of(argb: u32) -> [f32; 4] {
    let alpha = ((argb >> 24) & 0xff) as f32 / 255.0;
    let channel = |shift: u32| ((argb >> shift) & 0xff) as f32 / 255.0 * alpha;
    [channel(16), channel(8), channel(0), alpha]
}

fn stops_of(value: &Value) -> Vec<Stop> {
    value
        .get("stops")
        .and_then(Value::as_array)
        .map(|stops| {
            stops
                .iter()
                .map(|stop| Stop {
                    color: color_of(
                        stop.get("color").and_then(Value::as_f64).unwrap_or(0.0) as u32,
                    ),
                    position: stop.get("position").map_or(Unit::None, Unit::parse),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn repeat_of(name: Option<&str>) -> Repeat {
    match name {
        Some("space") => Repeat::Space,
        Some("round") => Repeat::Round,
        Some("no-repeat") => Repeat::NoRepeat,
        _ => Repeat::Repeat,
    }
}

impl Background {
    pub(crate) fn parse(json: &str) -> Option<Background> {
        let value: Value = serde_json::from_str(json).ok()?;
        let layers: Vec<Layer> = value
            .get("layers")?
            .as_array()?
            .iter()
            .filter_map(|layer| match layer.get("kind").and_then(Value::as_str) {
                Some("linear") => Some(Layer::Linear {
                    angle: layer
                        .get("angle")
                        .and_then(Value::as_f64)
                        .map(|angle| angle as f32),
                    corner: layer.get("keyword").and_then(Value::as_str).and_then(
                        |name| match name {
                            "top-right" => Some(Corner::TopRight),
                            "bottom-right" => Some(Corner::BottomRight),
                            "top-left" => Some(Corner::TopLeft),
                            "bottom-left" => Some(Corner::BottomLeft),
                            _ => None,
                        },
                    ),
                    stops: stops_of(layer),
                    repeating: layer.get("repeating").and_then(Value::as_bool) == Some(true),
                }),
                Some("radial") => Some(Layer::Radial {
                    circle: layer.get("shape").and_then(Value::as_str) == Some("circle"),
                    size: match layer.get("size") {
                        Some(Value::String(name)) => RadialSize::Keyword(name.clone()),
                        Some(dimensions) if dimensions.is_object() => RadialSize::Dimensions(
                            dimensions.get("x").map_or(Unit::None, Unit::parse),
                            dimensions.get("y").map_or(Unit::None, Unit::parse),
                        ),
                        _ => RadialSize::Keyword("farthest-corner".into()),
                    },
                    position: layer.get("position").map(Edges::parse).unwrap_or_default(),
                    stops: stops_of(layer),
                    repeating: layer.get("repeating").and_then(Value::as_bool) == Some(true),
                }),
                _ => None,
            })
            .filter(|layer| match layer {
                Layer::Linear { stops, .. } | Layer::Radial { stops, .. } => stops.len() >= 2,
            })
            .collect();
        if layers.is_empty() {
            return None;
        }
        let sizes = value
            .get("sizes")
            .and_then(Value::as_array)
            .map(|sizes| {
                sizes
                    .iter()
                    .map(|size| match size.as_str() {
                        Some("cover") => TileSize::Cover,
                        Some("contain") => TileSize::Contain,
                        _ if size.is_object() => TileSize::Lengths(
                            Unit::optional(size.get("x")),
                            Unit::optional(size.get("y")),
                        ),
                        _ => TileSize::Auto,
                    })
                    .collect()
            })
            .unwrap_or_default();
        let positions = value
            .get("positions")
            .and_then(Value::as_array)
            .map(|positions| positions.iter().map(Edges::parse).collect())
            .unwrap_or_default();
        let repeats = value
            .get("repeats")
            .and_then(Value::as_array)
            .map(|repeats| {
                repeats
                    .iter()
                    .map(|repeat| {
                        (
                            repeat_of(repeat.get("x").and_then(Value::as_str)),
                            repeat_of(repeat.get("y").and_then(Value::as_str)),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        Some(Background {
            layers,
            sizes,
            positions,
            repeats,
        })
    }

    /// The box drawn as straight RGBA, `max_dimension` pixels at most on the
    /// longer side; the renderer scales it to the box.
    pub(crate) fn render(
        &self,
        width: f32,
        height: f32,
        max_dimension: u32,
    ) -> (u32, u32, Vec<u8>) {
        let scale = (max_dimension as f32 / width.max(height).max(1.0)).min(1.0);
        let pixel_width = ((width * scale).ceil() as u32).max(1);
        let pixel_height = ((height * scale).ceil() as u32).max(1);
        let mut canvas = vec![0.0f32; (pixel_width * pixel_height * 4) as usize];
        // The first layer is the topmost, so paint from the last.
        for (index, layer) in self.layers.iter().enumerate().rev() {
            let tile = self.tile_size(index, width, height);
            let origin = self.origin(index, width, height, tile);
            let (repeat_x, repeat_y) = self
                .repeats
                .get(index % self.repeats.len().max(1))
                .copied()
                .unwrap_or((Repeat::Repeat, Repeat::Repeat));
            let prepared = Prepared::new(layer, tile.0, tile.1);
            for pixel_y in 0..pixel_height {
                let y = (pixel_y as f32 + 0.5) / scale;
                let Some((local_y, tile_h)) =
                    local_coordinate(y, origin.1, tile.1, height, repeat_y)
                else {
                    continue;
                };
                for pixel_x in 0..pixel_width {
                    let x = (pixel_x as f32 + 0.5) / scale;
                    let Some((local_x, tile_w)) =
                        local_coordinate(x, origin.0, tile.0, width, repeat_x)
                    else {
                        continue;
                    };
                    let source = prepared.color(local_x, local_y, tile_w, tile_h);
                    let at = ((pixel_y * pixel_width + pixel_x) * 4) as usize;
                    let inverse = 1.0 - source[3];
                    for channel in 0..4 {
                        canvas[at + channel] = source[channel] + canvas[at + channel] * inverse;
                    }
                }
            }
        }
        let bytes = canvas
            .chunks_exact(4)
            .flat_map(|pixel| {
                let alpha = pixel[3];
                let straight = |value: f32| {
                    if alpha > 0.0 {
                        ((value / alpha).clamp(0.0, 1.0) * 255.0).round() as u8
                    } else {
                        0
                    }
                };
                [
                    straight(pixel[0]),
                    straight(pixel[1]),
                    straight(pixel[2]),
                    (alpha.clamp(0.0, 1.0) * 255.0).round() as u8,
                ]
            })
            .collect();
        (pixel_width, pixel_height, bytes)
    }

    fn tile_size(&self, index: usize, width: f32, height: f32) -> (f32, f32) {
        let size = self
            .sizes
            .get(index % self.sizes.len().max(1))
            .cloned()
            .unwrap_or(TileSize::Auto);
        match size {
            // A gradient has no size of its own, so these fill the box.
            TileSize::Auto | TileSize::Cover | TileSize::Contain => (width, height),
            TileSize::Lengths(x, y) => (
                x.map_or(width, |unit| unit.resolve(width)).max(1.0),
                y.map_or(height, |unit| unit.resolve(height)).max(1.0),
            ),
        }
    }

    fn origin(&self, index: usize, width: f32, height: f32, tile: (f32, f32)) -> (f32, f32) {
        let edges = self
            .positions
            .get(index % self.positions.len().max(1))
            .cloned()
            .unwrap_or_default();
        let offset = |near: Option<Unit>, far: Option<Unit>, room: f32| {
            if let Some(near) = near {
                match near {
                    Unit::Percent(amount) => amount * room / 100.0,
                    other => other.resolve(room),
                }
            } else if let Some(far) = far {
                match far {
                    Unit::Percent(amount) => (100.0 - amount) * room / 100.0,
                    other => room - other.resolve(room),
                }
            } else {
                0.0
            }
        };
        (
            offset(edges.left, edges.right, width - tile.0),
            offset(edges.top, edges.bottom, height - tile.1),
        )
    }
}

/// Where a coordinate falls in a tile along one axis, and that tile's size
/// there; `None` where no tile is drawn.
fn local_coordinate(
    position: f32,
    origin: f32,
    tile: f32,
    extent: f32,
    repeat: Repeat,
) -> Option<(f32, f32)> {
    match repeat {
        Repeat::NoRepeat => {
            let local = position - origin;
            (0.0..tile).contains(&local).then_some((local, tile))
        }
        Repeat::Repeat => Some(((position - origin).rem_euclid(tile), tile)),
        Repeat::Round => {
            let count = (extent / tile).round().max(1.0);
            let fitted = extent / count;
            Some(((position - origin).rem_euclid(fitted), fitted))
        }
        Repeat::Space => {
            let count = (extent / tile).floor();
            if count < 2.0 {
                let local = position - origin;
                return (0.0..tile).contains(&local).then_some((local, tile));
            }
            let period = tile + (extent - count * tile) / (count - 1.0);
            let local = position.rem_euclid(period);
            (local < tile).then_some((local, tile))
        }
    }
}

/// A layer with its stops resolved against the tile it is drawn in.
struct Prepared<'a> {
    layer: &'a Layer,
    /// Each stop's position along the gradient ray, 0 to 1, and its colour.
    stops: Vec<(f32, [f32; 4])>,
    /// For a linear gradient the unit direction, for a radial one the centre
    /// and the two radii.
    geometry: [f32; 4],
    repeating: bool,
}

impl<'a> Prepared<'a> {
    fn new(layer: &'a Layer, width: f32, height: f32) -> Self {
        match layer {
            Layer::Linear {
                angle,
                corner,
                stops,
                repeating,
            } => {
                let (dx, dy) = match (corner, angle) {
                    (Some(corner), _) => {
                        let (sx, sy) = match corner {
                            Corner::TopRight => (1.0, -1.0),
                            Corner::BottomRight => (1.0, 1.0),
                            Corner::TopLeft => (-1.0, -1.0),
                            Corner::BottomLeft => (-1.0, 1.0),
                        };
                        // Perpendicular to the diagonal through the other two corners.
                        let (nx, ny) = (height * sx, width * sy);
                        let length = (nx * nx + ny * ny).sqrt().max(f32::EPSILON);
                        (nx / length, ny / length)
                    }
                    (None, angle) => {
                        let radians = angle.unwrap_or(180.0).to_radians();
                        (radians.sin(), -radians.cos())
                    }
                };
                let length = (width * dx).abs() + (height * dy).abs();
                Prepared {
                    layer,
                    stops: resolve_stops(stops, length),
                    geometry: [dx, dy, length.max(f32::EPSILON), 0.0],
                    repeating: *repeating,
                }
            }
            Layer::Radial {
                circle,
                size,
                position,
                stops,
                repeating,
            } => {
                let x = match (position.left, position.right) {
                    (Some(left), _) => left.resolve(width),
                    (None, Some(right)) => width - right.resolve(width),
                    _ => width / 2.0,
                };
                let y = match (position.top, position.bottom) {
                    (Some(top), _) => top.resolve(height),
                    (None, Some(bottom)) => height - bottom.resolve(height),
                    _ => height / 2.0,
                };
                let (near_x, far_x) = (x.min(width - x).abs(), x.max(width - x).abs());
                let (near_y, far_y) = (y.min(height - y).abs(), y.max(height - y).abs());
                let (mut rx, mut ry) = match size {
                    RadialSize::Dimensions(rx, ry) => {
                        let rx = rx.resolve(width);
                        (rx, if *circle { rx } else { ry.resolve(height) })
                    }
                    RadialSize::Keyword(name) => match name.as_str() {
                        "closest-side" => (near_x, near_y),
                        "farthest-side" => (far_x, far_y),
                        "closest-corner" => (near_x * 2f32.sqrt(), near_y * 2f32.sqrt()),
                        _ => (far_x * 2f32.sqrt(), far_y * 2f32.sqrt()),
                    },
                };
                if *circle && !matches!(size, RadialSize::Dimensions(..)) {
                    let radius = match size {
                        RadialSize::Keyword(name) if name == "closest-side" => near_x.min(near_y),
                        RadialSize::Keyword(name) if name == "farthest-side" => far_x.max(far_y),
                        RadialSize::Keyword(name) if name == "closest-corner" => {
                            (near_x * near_x + near_y * near_y).sqrt()
                        }
                        _ => (far_x * far_x + far_y * far_y).sqrt(),
                    };
                    (rx, ry) = (radius, radius);
                }
                let (rx, ry) = (rx.max(f32::EPSILON), ry.max(f32::EPSILON));
                Prepared {
                    layer,
                    stops: resolve_stops(stops, rx),
                    geometry: [x, y, rx, ry],
                    repeating: *repeating,
                }
            }
        }
    }

    fn color(&self, x: f32, y: f32, _width: f32, _height: f32) -> [f32; 4] {
        let t = match self.layer {
            Layer::Linear { .. } => {
                let [dx, dy, length, _] = self.geometry;
                // Distance along the direction from the tile's centre.
                ((x - _width / 2.0) * dx + (y - _height / 2.0) * dy) / length + 0.5
            }
            Layer::Radial { .. } => {
                let [cx, cy, rx, ry] = self.geometry;
                (((x - cx) / rx).powi(2) + ((y - cy) / ry).powi(2)).sqrt()
            }
        };
        sample(&self.stops, self.wrapped(t))
    }

    /// The position in the first repetition of a repeating gradient: the stops
    /// from the first to the last are the period.
    fn wrapped(&self, t: f32) -> f32 {
        if !self.repeating {
            return t;
        }
        let (Some(first), Some(last)) = (self.stops.first(), self.stops.last()) else {
            return t;
        };
        let period = last.0 - first.0;
        if period <= f32::EPSILON {
            return t;
        }
        first.0 + (t - first.0).rem_euclid(period)
    }
}

/// The stops as positions along the ray: those without one are spread evenly
/// between their neighbours, and none goes back before the one before it.
fn resolve_stops(stops: &[Stop], length: f32) -> Vec<(f32, [f32; 4])> {
    let mut positions: Vec<Option<f32>> = stops
        .iter()
        .map(|stop| match stop.position {
            Unit::None => None,
            Unit::Point(amount) => Some(amount / length.max(f32::EPSILON)),
            Unit::Percent(amount) => Some(amount / 100.0),
        })
        .collect();
    if positions.first().is_some_and(Option::is_none) {
        positions[0] = Some(0.0);
    }
    if positions.last().is_some_and(Option::is_none) {
        *positions.last_mut().expect("not empty") = Some(1.0);
    }
    let mut previous = 0;
    for index in 1..positions.len() {
        if positions[index].is_some() {
            let (from, to) = (
                positions[previous].unwrap_or(0.0),
                positions[index].unwrap_or(1.0),
            );
            let gaps = index - previous;
            for step in 1..gaps {
                positions[previous + step] = Some(from + (to - from) * step as f32 / gaps as f32);
            }
            previous = index;
        }
    }
    let mut highest = f32::MIN;
    stops
        .iter()
        .zip(positions)
        .map(|(stop, position)| {
            highest = highest.max(position.unwrap_or(highest));
            (highest, stop.color)
        })
        .collect()
}

fn sample(stops: &[(f32, [f32; 4])], t: f32) -> [f32; 4] {
    let Some(first) = stops.first() else {
        return [0.0; 4];
    };
    if t <= first.0 {
        return first.1;
    }
    for pair in stops.windows(2) {
        let ((from_at, from), (to_at, to)) = (pair[0], pair[1]);
        if t <= to_at {
            let span = to_at - from_at;
            let mix = if span <= f32::EPSILON {
                1.0
            } else {
                (t - from_at) / span
            };
            return std::array::from_fn(|channel| {
                from[channel] + (to[channel] - from[channel]) * mix
            });
        }
    }
    stops.last().map_or([0.0; 4], |last| last.1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn stop(color: u32, position: Option<f32>) -> Value {
        json!({
            "color": color,
            "position": match position {
                Some(percent) => json!({"unit": "pct", "value": percent}),
                None => json!({"unit": "none", "value": 0}),
            },
        })
    }

    fn pixel(image: &(u32, u32, Vec<u8>), x: u32, y: u32) -> [u8; 4] {
        let at = ((y * image.0 + x) * 4) as usize;
        [
            image.2[at],
            image.2[at + 1],
            image.2[at + 2],
            image.2[at + 3],
        ]
    }

    const RED: u32 = 0xffff0000;
    const BLUE: u32 = 0xff0000ff;
    const GREEN: u32 = 0xff00ff00;

    fn parse(layers: Value, extra: Value) -> Background {
        let mut value = json!({ "layers": layers, "sizes": [], "positions": [], "repeats": [] });
        for (key, entry) in extra.as_object().into_iter().flatten() {
            value[key] = entry.clone();
        }
        Background::parse(&value.to_string()).unwrap()
    }

    #[test]
    fn a_linear_gradient_runs_along_its_angle() {
        let background = parse(
            json!([{"kind": "linear", "angle": 90, "stops": [stop(RED, None), stop(BLUE, None)]}]),
            json!({}),
        );
        let image = background.render(100.0, 20.0, 512);
        let left = pixel(&image, 0, 10);
        let middle = pixel(&image, 50, 10);
        let right = pixel(&image, 99, 10);
        assert!(left[0] > 240 && left[2] < 15);
        assert!((100..160).contains(&middle[0]) && (100..160).contains(&middle[2]));
        assert!(right[2] > 240 && right[0] < 15);
        // Constant down a column when it runs to the right.
        assert_eq!(pixel(&image, 30, 0), pixel(&image, 30, 19));
    }

    #[test]
    fn stops_without_a_position_are_spread_and_hard_stops_stay_hard() {
        let background = parse(
            json!([{"kind": "linear", "angle": 90,
                "stops": [stop(RED, None), stop(GREEN, Some(50.0)), stop(BLUE, Some(50.0)), stop(BLUE, None)]}]),
            json!({}),
        );
        let image = background.render(100.0, 10.0, 512);
        assert!(pixel(&image, 49, 5)[1] > 200);
        assert!(pixel(&image, 51, 5)[2] > 200);
    }

    #[test]
    fn a_radial_gradient_starts_at_its_centre() {
        let background = parse(
            json!([{"kind": "radial", "shape": "circle", "size": "closest-side",
                "position": {"top": null, "left": null, "right": null, "bottom": null},
                "stops": [stop(RED, None), stop(BLUE, None)]}]),
            json!({}),
        );
        let image = background.render(100.0, 100.0, 512);
        let centre = pixel(&image, 50, 50);
        let edge = pixel(&image, 99, 50);
        assert!(centre[0] > 240);
        assert!(edge[2] > 240);
    }

    #[test]
    fn a_smaller_tile_repeats_and_no_repeat_leaves_the_rest_clear() {
        let layers =
            json!([{"kind": "linear", "angle": 90, "stops": [stop(RED, None), stop(BLUE, None)]}]);
        let tile = json!([{"x": {"unit": "pt", "value": 20}, "y": null}]);
        let repeated =
            parse(layers.clone(), json!({"sizes": tile.clone()})).render(100.0, 10.0, 512);
        assert_eq!(pixel(&repeated, 1, 5), pixel(&repeated, 21, 5));
        let once = parse(
            layers,
            json!({"sizes": tile, "repeats": [{"x": "no-repeat", "y": "repeat"}]}),
        )
        .render(100.0, 10.0, 512);
        assert!(pixel(&once, 5, 5)[3] > 0);
        assert_eq!(pixel(&once, 60, 5)[3], 0);
    }

    #[test]
    fn a_repeating_gradient_repeats_its_stops_along_the_ray() {
        let background = parse(
            json!([{
                "kind": "linear",
                "angle": 90.0,
                "repeating": true,
                "stops": [
                    stop(0xffff0000, Some(0.0)),
                    stop(0xffff0000, Some(10.0)),
                    stop(0xff0000ff, Some(10.0)),
                    stop(0xff0000ff, Some(20.0)),
                ],
            }]),
            json!({}),
        );
        let image = background.render(100.0, 10.0, 256);
        let red = pixel(&image, 5, 5);
        let blue = pixel(&image, 15, 5);
        assert!(red[0] > 200 && red[2] < 60);
        assert!(blue[2] > 200 && blue[0] < 60);
        let later_red = pixel(&image, 45, 5);
        let later_blue = pixel(&image, 95, 5);
        assert!(later_red[0] > 200 && later_red[2] < 60);
        assert!(later_blue[2] > 200 && later_blue[0] < 60);
    }

    #[test]
    fn a_gradient_with_fewer_than_two_stops_is_ignored() {
        let json = json!({"layers": [{"kind": "linear", "angle": 0, "stops": [stop(RED, None)]}]});
        assert!(Background::parse(&json.to_string()).is_none());
    }
}
