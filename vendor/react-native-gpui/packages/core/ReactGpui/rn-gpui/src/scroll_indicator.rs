//! A view of its own, outside the scrolling container: it reads the scroll
//! offset while rendering, and gpui-fast rebuilds whatever view did that on
//! every scroll.

use gpui::{div, prelude::*, px, rgba, Context, Pixels, Point, ScrollHandle, Task, Window};
use std::time::{Duration, Instant};

const VISIBLE_FOR: Duration = Duration::from_millis(1200);
const THICKNESS: f32 = 6.0;
/// Space kept at either end of the track; across it the thumb sits flush with
/// the container's edge.
const MARGIN: f32 = 2.0;
const MIN_LENGTH: f32 = 24.0;

pub(crate) struct ScrollIndicator {
    handle: ScrollHandle,
    horizontal: bool,
    last_offset: Point<Pixels>,
    visible_until: Option<Instant>,
    hide_task: Task<()>,
}

impl ScrollIndicator {
    pub(crate) fn new(handle: ScrollHandle, horizontal: bool) -> Self {
        Self {
            last_offset: handle.offset(),
            handle,
            horizontal,
            visible_until: None,
            hide_task: Task::ready(()),
        }
    }

    pub(crate) fn horizontal(&self) -> bool {
        self.horizontal
    }
}

fn thumb(viewport: f32, max_offset: f32, offset: f32) -> Option<(f32, f32)> {
    if viewport <= 0.0 || max_offset <= 0.5 {
        return None;
    }
    let track = viewport - 2.0 * MARGIN;
    let length = (track * viewport / (viewport + max_offset))
        .max(MIN_LENGTH)
        .min(track);
    let progress = (offset / max_offset).clamp(0.0, 1.0);
    Some((MARGIN + (track - length) * progress, length))
}

impl Render for ScrollIndicator {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let offset = self.handle.offset();
        let max_offset = self.handle.max_offset();
        let viewport = self.handle.bounds().size;
        let now = Instant::now();
        if offset != self.last_offset {
            self.last_offset = offset;
            self.visible_until = Some(now + VISIBLE_FOR);
            self.hide_task = cx.spawn(async move |this, cx| {
                cx.background_executor()
                    .timer(VISIBLE_FOR + Duration::from_millis(30))
                    .await;
                let _ = this.update(cx, |_, cx| cx.notify());
            });
        }
        let overlay = div().absolute().top_0().left_0().size_full();
        if !self.visible_until.is_some_and(|until| now < until) {
            return overlay;
        }
        let (viewport, max_offset, offset) = if self.horizontal {
            (
                f32::from(viewport.width),
                f32::from(max_offset.x),
                -f32::from(offset.x),
            )
        } else {
            (
                f32::from(viewport.height),
                f32::from(max_offset.y),
                -f32::from(offset.y),
            )
        };
        let Some((start, length)) = thumb(viewport, max_offset, offset) else {
            return overlay;
        };
        let bar = div()
            .absolute()
            .rounded(px(THICKNESS / 2.0))
            .bg(rgba(0x808080b0));
        overlay.child(if self.horizontal {
            bar.left(px(start))
                .bottom_0()
                .w(px(length))
                .h(px(THICKNESS))
        } else {
            bar.top(px(start)).right_0().w(px(THICKNESS)).h(px(length))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::thumb;

    #[test]
    fn content_that_fits_has_no_thumb() {
        assert_eq!(thumb(400.0, 0.0, 0.0), None);
        assert_eq!(thumb(0.0, 100.0, 0.0), None);
    }

    #[test]
    fn thumb_length_follows_the_visible_fraction_and_stays_on_the_track() {
        let (start, length) = thumb(404.0, 404.0, 0.0).unwrap();
        assert_eq!((start, length), (2.0, 200.0));
        let (start, length) = thumb(404.0, 404.0, 404.0).unwrap();
        assert_eq!(start + length, 402.0);
        let (start, length) = thumb(404.0, 100_000.0, 200_000.0).unwrap();
        assert_eq!(length, 24.0);
        assert_eq!(start + length, 402.0);
    }
}
