//! The invisible border that makes a frameless window resizable.
//!
//! A window with client-side decorations has no frame for the user to grab, so
//! the app draws one: eight invisible strips along and around the edges, each
//! starting a native resize when pressed. Only Linux needs this — macOS and
//! Windows keep a native resize border around a title-bar-less window — so the
//! element is only built there. The geometry and the cursor are
//! platform-independent and unit-tested everywhere, which is why the module is
//! not itself behind a `cfg`: the tests are what keep the numbers right, and they
//! have to run on the machine the change is made on.
#![allow(dead_code)]

use gpui::{px, Bounds, CursorStyle, Pixels, Point, ResizeEdge, Size};

/// How thick the grab area is, in points.
///
/// Eight is what GTK and winit use for a client-decorated edge: thinner and the
/// edge is hard to hit, thicker and it starts eating presses meant for content.
pub const BORDER: f32 = 8.0;

/// Every edge, in the order the border draws them.
///
/// The four sides come first and the corners last: a later child paints in
/// front, so where a corner overlaps the two sides it belongs to, the corner is
/// what the pointer hits.
pub const EDGES: [ResizeEdge; 8] = [
    ResizeEdge::Top,
    ResizeEdge::Bottom,
    ResizeEdge::Left,
    ResizeEdge::Right,
    ResizeEdge::TopLeft,
    ResizeEdge::TopRight,
    ResizeEdge::BottomLeft,
    ResizeEdge::BottomRight,
];

/// Where one edge's grab area sits inside a window of this size.
///
/// The thickness shrinks with a window smaller than two borders, so a tiny
/// window still lays out: two overlapping 8px strips that each claim half would
/// leave the middle unfindable.
pub fn border_bounds(edge: ResizeEdge, width: f32, height: f32) -> Bounds<Pixels> {
    let width = width.max(0.0);
    let height = height.max(0.0);
    let thickness = BORDER.min(width / 2.0).min(height / 2.0);
    let (x, y, w, h) = match edge {
        ResizeEdge::Top => (0.0, 0.0, width, thickness),
        ResizeEdge::Bottom => (0.0, height - thickness, width, thickness),
        ResizeEdge::Left => (0.0, 0.0, thickness, height),
        ResizeEdge::Right => (width - thickness, 0.0, thickness, height),
        ResizeEdge::TopLeft => (0.0, 0.0, thickness, thickness),
        ResizeEdge::TopRight => (width - thickness, 0.0, thickness, thickness),
        ResizeEdge::BottomLeft => (0.0, height - thickness, thickness, thickness),
        ResizeEdge::BottomRight => (width - thickness, height - thickness, thickness, thickness),
    };
    Bounds::new(Point::new(px(x), px(y)), Size::new(px(w), px(h)))
}

/// The cursor a resize edge shows, in the CSS spelling each edge means.
pub fn edge_cursor(edge: ResizeEdge) -> CursorStyle {
    match edge {
        ResizeEdge::Top | ResizeEdge::Bottom => CursorStyle::ResizeUpDown,
        ResizeEdge::Left | ResizeEdge::Right => CursorStyle::ResizeLeftRight,
        // `nwse-resize` runs from the top-left corner to the bottom-right one.
        ResizeEdge::TopLeft | ResizeEdge::BottomRight => CursorStyle::ResizeUpRightDownLeft,
        ResizeEdge::TopRight | ResizeEdge::BottomLeft => CursorStyle::ResizeUpLeftDownRight,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(edge: ResizeEdge, width: f32, height: f32) -> (f32, f32, f32, f32) {
        let bounds = border_bounds(edge, width, height);
        (
            f32::from(bounds.origin.x),
            f32::from(bounds.origin.y),
            f32::from(bounds.size.width),
            f32::from(bounds.size.height),
        )
    }

    #[test]
    fn each_side_spans_the_window_and_sits_against_its_own_edge() {
        assert_eq!(rect(ResizeEdge::Top, 400.0, 300.0), (0.0, 0.0, 400.0, 8.0));
        assert_eq!(
            rect(ResizeEdge::Bottom, 400.0, 300.0),
            (0.0, 292.0, 400.0, 8.0)
        );
        assert_eq!(rect(ResizeEdge::Left, 400.0, 300.0), (0.0, 0.0, 8.0, 300.0));
        assert_eq!(
            rect(ResizeEdge::Right, 400.0, 300.0),
            (392.0, 0.0, 8.0, 300.0)
        );
    }

    #[test]
    fn a_corner_is_a_square_in_its_own_corner() {
        assert_eq!(
            rect(ResizeEdge::TopLeft, 400.0, 300.0),
            (0.0, 0.0, 8.0, 8.0)
        );
        assert_eq!(
            rect(ResizeEdge::TopRight, 400.0, 300.0),
            (392.0, 0.0, 8.0, 8.0)
        );
        assert_eq!(
            rect(ResizeEdge::BottomLeft, 400.0, 300.0),
            (0.0, 292.0, 8.0, 8.0)
        );
        assert_eq!(
            rect(ResizeEdge::BottomRight, 400.0, 300.0),
            (392.0, 292.0, 8.0, 8.0)
        );
    }

    #[test]
    fn the_border_shrinks_to_fit_a_tiny_window() {
        // A window narrower than two borders would otherwise place the right
        // strip at a negative x, outside the window it is meant to resize.
        let (x, _, w, _) = rect(ResizeEdge::Right, 10.0, 10.0);
        assert_eq!((x, w), (5.0, 5.0));
        let (x, y, w, h) = rect(ResizeEdge::BottomRight, 10.0, 6.0);
        assert_eq!((x, y, w, h), (7.0, 3.0, 3.0, 3.0));
    }

    #[test]
    fn an_empty_window_has_no_border() {
        assert_eq!(rect(ResizeEdge::Right, 0.0, 0.0), (0.0, 0.0, 0.0, 0.0));
        assert_eq!(rect(ResizeEdge::Top, -5.0, 20.0), (0.0, 0.0, 0.0, 0.0));
    }

    #[test]
    fn every_edge_has_the_cursor_that_matches_its_direction() {
        assert_eq!(edge_cursor(ResizeEdge::Top), CursorStyle::ResizeUpDown);
        assert_eq!(edge_cursor(ResizeEdge::Bottom), CursorStyle::ResizeUpDown);
        assert_eq!(edge_cursor(ResizeEdge::Left), CursorStyle::ResizeLeftRight);
        assert_eq!(edge_cursor(ResizeEdge::Right), CursorStyle::ResizeLeftRight);
        // The two diagonals must not be swapped: a browser and a window manager
        // disagree about nothing else here, and a wrong cursor is the visible
        // symptom of a wrong resize direction.
        assert_eq!(
            edge_cursor(ResizeEdge::TopLeft),
            CursorStyle::ResizeUpRightDownLeft
        );
        assert_eq!(
            edge_cursor(ResizeEdge::BottomRight),
            CursorStyle::ResizeUpRightDownLeft
        );
        assert_eq!(
            edge_cursor(ResizeEdge::TopRight),
            CursorStyle::ResizeUpLeftDownRight
        );
        assert_eq!(
            edge_cursor(ResizeEdge::BottomLeft),
            CursorStyle::ResizeUpLeftDownRight
        );
    }
}
