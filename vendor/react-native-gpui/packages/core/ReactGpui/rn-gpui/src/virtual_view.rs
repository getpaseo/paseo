//! `VirtualView`: which of three modes a view is in, by where it lies
//! against the viewport of the scroll view around it.
//!
//! Visible, in the viewport; prerender, in the viewport grown by
//! [`PRERENDER_RATIO`] viewports along the scroll axis, where the content is
//! worth having ready; hidden, anywhere else. React hears of every change
//! as `onModeChange` and decides what to keep mounted.

use gpui::App;

/// How many viewports past the visible one a view is still prerendered.
const PRERENDER_RATIO: f32 = 5.0;

pub(crate) const VISIBLE: i32 = 0;
pub(crate) const PRERENDER: i32 = 1;
pub(crate) const HIDDEN: i32 = 2;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl Rect {
    fn intersects(&self, other: &Rect) -> bool {
        self.x < other.x + other.w
            && other.x < self.x + self.w
            && self.y < other.y + other.h
            && other.y < self.y + self.h
    }

    fn json(&self) -> serde_json::Value {
        serde_json::json!({"x": self.x, "y": self.y, "width": self.w, "height": self.h})
    }
}

/// The rect that counts as prerender: the viewport grown along the scroll
/// axis. A view that scrolls both ways is grown both ways.
pub(crate) fn prerender_rect(viewport: Rect, horizontal: bool) -> Rect {
    let mut grown = viewport;
    if horizontal {
        grown.x -= viewport.w * PRERENDER_RATIO;
        grown.w *= 1.0 + 2.0 * PRERENDER_RATIO;
    } else {
        grown.y -= viewport.h * PRERENDER_RATIO;
        grown.h *= 1.0 + 2.0 * PRERENDER_RATIO;
    }
    grown
}

/// The mode of a view at `target`, in the scroll view's content space.
pub(crate) fn mode(target: Rect, viewport: Rect, horizontal: bool) -> i32 {
    if target.intersects(&viewport) {
        VISIBLE
    } else if target.intersects(&prerender_rect(viewport, horizontal)) {
        PRERENDER
    } else {
        HIDDEN
    }
}

/// Reports the mode of every `VirtualView` that changed, after the content
/// of a scroll view moved or a batch mounted.
pub(crate) fn update(cx: &mut App) {
    let Some(store) = crate::store::store_from(cx) else {
        return;
    };
    let (host, nodes): (_, Vec<_>) = {
        let store = store.read(cx);
        (
            store.host.clone(),
            store
                .nodes
                .values()
                .filter(|node| node.read(cx).component == "VirtualView")
                .cloned()
                .collect(),
        )
    };
    for node in nodes {
        let Some((target, viewport, horizontal)) = node.read(cx).virtual_view_geometry(cx) else {
            continue;
        };
        let now = mode(target, viewport, horizontal);
        let tag = node.read(cx).tag;
        if node.read(cx).virtual_view_mode.replace(Some(now)) == Some(now) {
            continue;
        }
        host.dispatch_event(
            tag,
            "topModeChange",
            &serde_json::json!({
                "mode": now,
                "targetRect": target.json(),
                "thresholdRect": match now {
                    VISIBLE => viewport,
                    _ => prerender_rect(viewport, horizontal),
                }.json(),
            }),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VIEWPORT: Rect = Rect {
        x: 0.0,
        y: 1000.0,
        w: 300.0,
        h: 100.0,
    };

    fn at(y: f32) -> Rect {
        Rect {
            x: 0.0,
            y,
            w: 300.0,
            h: 50.0,
        }
    }

    #[test]
    fn a_view_in_the_viewport_is_visible_and_one_just_outside_is_not() {
        assert_eq!(mode(at(1050.0), VIEWPORT, false), VISIBLE);
        assert_eq!(mode(at(960.0), VIEWPORT, false), VISIBLE);
        assert_eq!(mode(at(1100.0), VIEWPORT, false), PRERENDER);
    }

    #[test]
    fn a_view_within_five_viewports_is_prerendered_and_past_that_hidden() {
        assert_eq!(mode(at(1500.0), VIEWPORT, false), PRERENDER);
        assert_eq!(mode(at(1599.0), VIEWPORT, false), PRERENDER);
        assert_eq!(mode(at(1700.0), VIEWPORT, false), HIDDEN);
        assert_eq!(mode(at(460.0), VIEWPORT, false), PRERENDER);
        assert_eq!(mode(at(300.0), VIEWPORT, false), HIDDEN);
    }

    #[test]
    fn a_horizontal_scroll_view_grows_the_viewport_sideways() {
        let viewport = Rect {
            x: 1000.0,
            y: 0.0,
            w: 100.0,
            h: 300.0,
        };
        let target = Rect {
            x: 1400.0,
            y: 0.0,
            w: 50.0,
            h: 300.0,
        };
        assert_eq!(mode(target, viewport, true), PRERENDER);
        assert_eq!(mode(target, viewport, false), HIDDEN);
    }
}
