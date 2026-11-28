//! `ActivityIndicator`: spokes on macOS, a sweeping arc on Windows and Linux.
//!
//! Frames are requested only while it animates, so a stopped indicator costs
//! nothing.

use std::f32::consts::TAU;
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use gpui::{canvas, point, prelude::*, px, AnyElement, App, Bounds, Hsla, PathBuilder, Window};
use serde_json::Value;

use crate::extensions::{register_component_renderer, ComponentNode, ComponentRenderer};
use crate::style::color;

const SPOKES: usize = 12;
const SPOKE_PERIOD_SECONDS: f32 = 1.0;
const ARC_PERIOD_SECONDS: f32 = 1.2;

fn animating(props: &Value) -> bool {
    props
        .get("animating")
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

fn hides_when_stopped(props: &Value) -> bool {
    props
        .get("hidesWhenStopped")
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

fn tint(props: &Value) -> Hsla {
    let argb = props
        .get("color")
        .and_then(Value::as_u64)
        .map(|value| value as u32)
        .filter(|value| *value != 0)
        .unwrap_or(if cfg!(target_os = "macos") {
            0x99_3C3C43
        } else {
            0xFF_6E6E6E
        });
    color(argb)
}

/// Seconds since an arbitrary fixed moment, so every indicator is in step.
fn clock() -> f32 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |duration| (duration.as_secs_f64() % 3600.0) as f32)
}

/// How bright spoke `index` is when the leading one is `lead`: the leader is
/// full and the ones behind it fade.
pub(crate) fn spoke_alpha(index: usize, lead: usize) -> f32 {
    let behind = (lead + SPOKES - index) % SPOKES;
    (1.0 - behind as f32 / SPOKES as f32).max(0.12)
}

pub(crate) fn spoke_lead(seconds: f32) -> usize {
    ((seconds / SPOKE_PERIOD_SECONDS).fract() * SPOKES as f32) as usize % SPOKES
}

struct ActivityIndicatorRenderer;

impl ComponentRenderer for ActivityIndicatorRenderer {
    fn render(&self, _: &ComponentNode, _: &mut Window, _: &mut App) -> Option<AnyElement> {
        None
    }

    fn content(
        &self,
        node: &ComponentNode,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<AnyElement> {
        let running = animating(&node.props);
        if !running && hides_when_stopped(&node.props) {
            return None;
        }
        let animated = running && !cx.reduce_motion();
        if animated {
            window.request_animation_frame();
        }
        let tint = tint(&node.props);
        let seconds = if animated { clock() } else { 0.0 };
        Some(
            canvas(
                |_, _, _| (),
                move |bounds, (), window, _cx| paint(bounds, tint, seconds, window),
            )
            .size_full()
            .into_any_element(),
        )
    }
}

fn paint(bounds: Bounds<gpui::Pixels>, tint: Hsla, seconds: f32, window: &mut Window) {
    let size = f32::from(bounds.size.width.min(bounds.size.height));
    let center = point(
        bounds.origin.x + bounds.size.width / 2.0,
        bounds.origin.y + bounds.size.height / 2.0,
    );
    if cfg!(target_os = "macos") {
        let lead = spoke_lead(seconds);
        let (inner, outer, thickness) = (size * 0.28, size * 0.5, size * 0.1);
        for index in 0..SPOKES {
            let angle = index as f32 / SPOKES as f32 * TAU;
            let (sin, cos) = angle.sin_cos();
            let mut builder = PathBuilder::stroke(px(thickness));
            builder.move_to(point(
                center.x + px(sin * inner),
                center.y - px(cos * inner),
            ));
            builder.line_to(point(
                center.x + px(sin * outer),
                center.y - px(cos * outer),
            ));
            if let Ok(path) = builder.build() {
                let mut spoke = tint;
                spoke.a *= spoke_alpha(index, lead);
                window.paint_path(path, spoke);
            }
        }
    } else {
        let radius = size * 0.5 - size * 0.08;
        let turn = (seconds / ARC_PERIOD_SECONDS).fract();
        let start = turn * TAU * 2.0;
        // The sweep grows and shrinks as it turns.
        let sweep = TAU * (0.15 + 0.55 * (0.5 - 0.5 * (turn * TAU).cos()));
        let mut builder = PathBuilder::stroke(px(size * 0.1));
        let steps = 32;
        for step in 0..=steps {
            let angle = start + sweep * step as f32 / steps as f32;
            let (sin, cos) = angle.sin_cos();
            let at = point(center.x + px(sin * radius), center.y - px(cos * radius));
            if step == 0 {
                builder.move_to(at);
            } else {
                builder.line_to(at);
            }
        }
        if let Ok(path) = builder.build() {
            window.paint_path(path, tint);
        }
    }
}

pub fn register() {
    register_component_renderer("ActivityIndicatorView", Arc::new(ActivityIndicatorRenderer));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_leading_spoke_is_brightest_and_the_trail_fades() {
        assert_eq!(spoke_alpha(3, 3), 1.0);
        assert!(spoke_alpha(2, 3) < spoke_alpha(3, 3));
        assert!(spoke_alpha(4, 3) < spoke_alpha(2, 3));
        assert!(spoke_alpha(4, 3) >= 0.12);
    }

    #[test]
    fn the_leader_advances_once_per_period() {
        assert_eq!(spoke_lead(0.0), 0);
        assert_eq!(spoke_lead(0.5), SPOKES / 2);
        assert_eq!(spoke_lead(1.0), 0);
    }

    #[test]
    fn a_stopped_indicator_follows_hides_when_stopped() {
        let stopped = serde_json::json!({"animating": false});
        assert!(!animating(&stopped));
        assert!(hides_when_stopped(&stopped));
        assert!(!hides_when_stopped(
            &serde_json::json!({"animating": false, "hidesWhenStopped": false})
        ));
    }
}
