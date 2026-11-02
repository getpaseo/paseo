//! Whether a native surface inside a scrolling node keeps up with the scroll.

/// How a scrolling node moves its content.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ScrollStrategy {
    /// GPUI scrolls the container itself: `overflow_*_scroll` plus
    /// `track_scroll`. gpui-fast may cache the content as a scroll layer and
    /// composite it on frames that only scroll.
    GpuiLayer,
    /// The node offsets the content itself, inside a clipped box. No element
    /// reports `Overflow::Scroll`, so gpui-fast never makes the container a
    /// layer and the content is prepainted on every frame — which is what a
    /// native surface inside it needs, because its bounds are set in
    /// `prepaint`.
    ManualOffset,
}

/// Which strategy a scrolling node must use.
pub(crate) fn scroll_strategy(contains_native_surface: bool) -> ScrollStrategy {
    if contains_native_surface {
        ScrollStrategy::ManualOffset
    } else {
        ScrollStrategy::GpuiLayer
    }
}

#[cfg(test)]
mod tests {
    use super::{scroll_strategy, ScrollStrategy};
    use gpui::{
        div, point, prelude::*, px, size, AnyElement, App, AppContext, Bounds, Context, Element,
        ElementId, GlobalElementId, IntoElement, LayoutId, Pixels, PlatformInput, Render,
        ScrollDelta, ScrollHandle, ScrollWheelEvent, Style, TestAppContext, Window, WindowHandle,
    };
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;

    const VIEWPORT: (f32, f32) = (200.0, 100.0);
    const CONTENT_HEIGHT: f32 = 2000.0;

    /// Stands in for a native surface: records the bounds of every `prepaint`
    /// it is given, exactly where `NativeSurfaceElement` calls `set_bounds`.
    struct BoundsProbe {
        prepaints: Rc<RefCell<Vec<Pixels>>>,
    }

    impl IntoElement for BoundsProbe {
        type Element = Self;

        fn into_element(self) -> Self::Element {
            self
        }
    }

    impl Element for BoundsProbe {
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
            _inspector_id: Option<&gpui::InspectorElementId>,
            window: &mut Window,
            cx: &mut App,
        ) -> (LayoutId, Self::RequestLayoutState) {
            let mut style = Style::default();
            style.size.width = px(40.).into();
            style.size.height = px(40.).into();
            (window.request_layout(style, [], cx), ())
        }

        fn prepaint(
            &mut self,
            _id: Option<&GlobalElementId>,
            _inspector_id: Option<&gpui::InspectorElementId>,
            bounds: Bounds<Pixels>,
            _request_layout: &mut Self::RequestLayoutState,
            _window: &mut Window,
            _cx: &mut App,
        ) -> Self::PrepaintState {
            self.prepaints.borrow_mut().push(bounds.origin.y);
        }

        fn paint(
            &mut self,
            _id: Option<&GlobalElementId>,
            _inspector_id: Option<&gpui::InspectorElementId>,
            _bounds: Bounds<Pixels>,
            _request_layout: &mut Self::RequestLayoutState,
            _prepaint: &mut Self::PrepaintState,
            _window: &mut Window,
            _cx: &mut App,
        ) {
        }
    }

    /// A scrolling node holding a probe, rendered the way the runtime renders
    /// one: `GpuiLayer` means GPUI scrolls it, `ManualOffset` means the node
    /// offsets its own content inside a clipped box.
    struct ScrollFixture {
        handle: ScrollHandle,
        strategy: ScrollStrategy,
        probe: Rc<RefCell<Vec<Pixels>>>,
        /// The offset the content is drawn at, in `ManualOffset`.
        offset: f32,
    }

    impl Render for ScrollFixture {
        fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            let mut content = div()
                .relative()
                .flex_none()
                .w(px(VIEWPORT.0))
                .h(px(CONTENT_HEIGHT));
            if self.strategy == ScrollStrategy::ManualOffset {
                content = content.top(px(-self.offset));
            }
            content = content.child(div().h(px(500.))).child(BoundsProbe {
                prepaints: self.probe.clone(),
            });
            let mut scroller = div().id("scroller").absolute().top_0().left_0().size_full();
            scroller = match self.strategy {
                ScrollStrategy::GpuiLayer => scroller
                    .overflow_y_scroll()
                    .track_scroll(&self.handle)
                    .child(content),
                ScrollStrategy::ManualOffset => {
                    let has_scroll = self.handle.offset().y != px(0.) || self.offset != 0.;
                    scroller = scroller.overflow_hidden();
                    let _ = has_scroll;
                    let entity = cx.entity().downgrade();
                    scroller
                        .on_scroll_wheel(move |event: &ScrollWheelEvent, _window, cx| {
                            let dy = match &event.delta {
                                ScrollDelta::Pixels(delta) => f32::from(delta.y),
                                ScrollDelta::Lines(lines) => lines.y * 20.0,
                            };
                            let _ = entity.update(cx, |this, cx| {
                                let max = (CONTENT_HEIGHT - VIEWPORT.1).max(0.0);
                                this.offset = (this.offset - dy).clamp(0.0, max);
                                cx.notify();
                            });
                        })
                        .child(content)
                }
            };
            div()
                .relative()
                .w(px(VIEWPORT.0))
                .h(px(VIEWPORT.1))
                .bg(gpui::rgb(0xffffff))
                .child(scroller)
        }
    }

    fn open(cx: &mut TestAppContext, strategy: ScrollStrategy) -> WindowHandle<ScrollFixture> {
        let window = cx.add_window(move |_, _| ScrollFixture {
            handle: ScrollHandle::new(),
            strategy,
            probe: Rc::new(RefCell::new(Vec::new())),
            offset: 0.0,
        });
        cx.update_window(window.into(), |_, window, cx| {
            window.set_scroll_layers(true);
            window.resize(size(px(VIEWPORT.0), px(VIEWPORT.1)));
            window.dispatch_event(mouse_move(), cx);
            window.draw(cx).clear(cx);
        })
        .unwrap();
        window
    }

    fn mouse_move() -> PlatformInput {
        PlatformInput::MouseMove(gpui::MouseMoveEvent {
            position: point(px(20.), px(20.)),
            pressed_button: None,
            ..Default::default()
        })
    }

    /// How many times the probe was prepainted so far.
    fn prepaints(window: WindowHandle<ScrollFixture>, cx: &mut TestAppContext) -> usize {
        window
            .read_with(cx, |fixture, _| fixture.probe.borrow().len())
            .unwrap()
    }

    fn last_probe_y(
        window: WindowHandle<ScrollFixture>,
        cx: &mut TestAppContext,
    ) -> Option<Pixels> {
        window
            .read_with(cx, |fixture, _| fixture.probe.borrow().last().copied())
            .unwrap()
    }

    /// Scrolls one frame down by `dy` pixels and draws it.
    fn scroll_frame(window: WindowHandle<ScrollFixture>, cx: &mut TestAppContext, dy: f32) {
        cx.update_window(window.into(), |_, window, cx| {
            window.dispatch_event(mouse_move(), cx);
            window.dispatch_event(
                PlatformInput::ScrollWheel(ScrollWheelEvent {
                    position: point(px(20.), px(20.)),
                    delta: ScrollDelta::Pixels(point(px(0.), px(dy))),
                    modifiers: Default::default(),
                    touch_phase: gpui::TouchPhase::Moved,
                }),
                cx,
            );
            window.draw(cx).clear(cx);
        })
        .unwrap();
    }

    /// The design's §5.4 question, answered: a native surface inside a GPUI
    /// scroll container stops tracking once the container is composited as a
    /// scroll layer, because a scroll-only frame prepaints no children.
    #[gpui::test]
    fn a_gpui_scrolled_container_stops_prepainting_its_content_once_composited(
        cx: &mut TestAppContext,
    ) {
        let window = open(cx, ScrollStrategy::GpuiLayer);
        assert!(
            prepaints(window, cx) >= 1,
            "the first frame prepaints the content"
        );

        let mut saw_a_frame_without_prepaint = false;
        let mut offset_moved_while_prepaint_stale = false;
        let mut previous_y = last_probe_y(window, cx).expect("the probe was prepainted");
        let mut trace = Vec::new();
        for step in 0..8 {
            let before = prepaints(window, cx);
            scroll_frame(window, cx, -6.0);
            let after = prepaints(window, cx);
            let y = last_probe_y(window, cx).expect("the probe was prepainted");
            trace.push((before, after, y));
            if after == before {
                saw_a_frame_without_prepaint = true;
                if y == previous_y && step > 1 {
                    offset_moved_while_prepaint_stale = true;
                }
            }
            previous_y = y;
        }

        assert!(
            saw_a_frame_without_prepaint,
            "a scroll-only frame must skip prepainting the content; the probe was \
             prepainted on every frame, so the layer path was never taken: {trace:?}"
        );
        assert!(
            offset_moved_while_prepaint_stale,
            "the native surface's bounds must be seen to go stale while the window scrolls"
        );
    }

    /// The other half: when the node offsets its own content, no element
    /// reports `Overflow::Scroll`, so there is no layer to composite and the
    /// content — and with it a native surface's bounds — is prepainted every
    /// frame.
    #[gpui::test]
    fn a_manually_offset_container_prepaints_its_content_on_every_scrolled_frame(
        cx: &mut TestAppContext,
    ) {
        let window = open(cx, ScrollStrategy::ManualOffset);
        let start = last_probe_y(window, cx).expect("the probe was prepainted");

        let mut ys = Vec::new();
        for _ in 0..8 {
            let before = prepaints(window, cx);
            scroll_frame(window, cx, -6.0);
            assert_eq!(
                prepaints(window, cx),
                before + 1,
                "every scrolled frame must prepaint the content"
            );
            ys.push(last_probe_y(window, cx).expect("the probe was prepainted"));
        }

        assert!(
            ys.iter().all(|y| *y < start),
            "the prepainted bounds must move up with the scroll: {ys:?} from {start:?}"
        );
        assert!(
            ys.windows(2).all(|pair| pair[0] > pair[1]),
            "the bounds must track every frame, not jump: {ys:?}"
        );
    }

    #[test]
    fn a_native_surface_opts_a_scroll_container_out_of_the_composite_path() {
        assert_eq!(scroll_strategy(true), ScrollStrategy::ManualOffset);
        assert_eq!(scroll_strategy(false), ScrollStrategy::GpuiLayer);
    }

    /// `AnyElement` is what a scroll container's content is built from, so the
    /// test fixture must stay representable that way.
    #[allow(dead_code)]
    fn _probe_is_an_element(probe: Rc<RefCell<Vec<Pixels>>>) -> AnyElement {
        BoundsProbe { prepaints: probe }.into_any_element()
    }
}
