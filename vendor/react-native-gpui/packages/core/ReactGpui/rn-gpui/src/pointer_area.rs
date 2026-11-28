//! A `div` with listeners asks `hitbox.is_hovered` while painting, and gpui-fast
//! records that read as a dependency. This element inserts the same hitbox but
//! asks only inside its event handlers, where nothing is recorded.

use gpui::{
    point, prelude::*, px, size, AnyElement, App, Bounds, DispatchPhase, Element, ElementId,
    GlobalElementId, Hitbox, HitboxBehavior, InspectorElementId, LayoutId, MouseButton,
    MouseDownEvent, MouseMoveEvent, MouseUpEvent, NavigationDirection, Pixels, Window,
};
use std::rc::Rc;

/// The node a pointer area belongs to, which every handler is given. Handlers
/// take it rather than capture it, so nodes alike share one set of handlers.
pub(crate) type Node = gpui::WeakEntity<crate::node_view::RNNodeView>;

pub(crate) type PointerHandler<Event, N = Node> = Rc<dyn Fn(&N, &Event, &mut Window, &mut App)>;

/// A hover sample: whether the pointer is over the area now, then the context.
///
/// It is a sample rather than an edge because the edge is decided by whoever owns
/// the previous state, which cannot live in here — `mouse_listeners` is cleared on
/// every frame, so this closure is rebuilt each paint.
pub(crate) type HoverHandler<N = Node> = Rc<dyn Fn(&N, bool, &mut Window, &mut App)>;

/// The buttons a listener can be registered for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum PointerButton {
    Left,
    Right,
    Middle,
    Back,
    Forward,
}

impl PointerButton {
    pub(crate) fn from_gpui(button: MouseButton) -> Option<Self> {
        match button {
            MouseButton::Left => Some(PointerButton::Left),
            MouseButton::Right => Some(PointerButton::Right),
            MouseButton::Middle => Some(PointerButton::Middle),
            // The two side buttons arrive as one variant plus a direction.
            MouseButton::Navigate(direction) => Some(match direction {
                NavigationDirection::Back => PointerButton::Back,
                NavigationDirection::Forward => PointerButton::Forward,
            }),
        }
    }

    /// The DOM's button number, which is what `events::Button` reports too.
    pub(crate) fn number(self) -> i32 {
        match self {
            PointerButton::Left => 0,
            PointerButton::Middle => 1,
            PointerButton::Right => 2,
            PointerButton::Back => 3,
            PointerButton::Forward => 4,
        }
    }
}

/// Every button, in the order the DOM numbers them, so the listeners for one
/// element fire in a stable order regardless of registration.
const POINTER_BUTTONS: [PointerButton; 5] = [
    PointerButton::Left,
    PointerButton::Middle,
    PointerButton::Right,
    PointerButton::Back,
    PointerButton::Forward,
];

/// In registration order; the bubble phase runs them in reverse.
pub(crate) struct PointerHandlers<N = Node> {
    pub(crate) left_down: Vec<PointerHandler<MouseDownEvent, N>>,
    pub(crate) right_down: Vec<PointerHandler<MouseDownEvent, N>>,
    pub(crate) left_up: Vec<PointerHandler<MouseUpEvent, N>>,
    pub(crate) right_up: Vec<PointerHandler<MouseUpEvent, N>>,
    pub(crate) middle_down: Vec<PointerHandler<MouseDownEvent, N>>,
    pub(crate) middle_up: Vec<PointerHandler<MouseUpEvent, N>>,
    /// The side buttons, which are rare enough not to deserve a field each.
    pub(crate) back_down: Vec<PointerHandler<MouseDownEvent, N>>,
    pub(crate) forward_down: Vec<PointerHandler<MouseDownEvent, N>>,
    pub(crate) back_up: Vec<PointerHandler<MouseUpEvent, N>>,
    pub(crate) forward_up: Vec<PointerHandler<MouseUpEvent, N>>,
    pub(crate) mouse_move: Vec<PointerHandler<MouseMoveEvent, N>>,
    /// Hover samples: each handler is told whether the pointer is over the area
    /// and decides for itself whether that is a change.
    pub(crate) hover: Vec<HoverHandler<N>>,
}

impl<N> Default for PointerHandlers<N> {
    fn default() -> Self {
        Self {
            left_down: Vec::new(),
            right_down: Vec::new(),
            left_up: Vec::new(),
            right_up: Vec::new(),
            middle_down: Vec::new(),
            middle_up: Vec::new(),
            back_down: Vec::new(),
            forward_down: Vec::new(),
            back_up: Vec::new(),
            forward_up: Vec::new(),
            mouse_move: Vec::new(),
            hover: Vec::new(),
        }
    }
}

impl<N> PointerHandlers<N> {
    pub(crate) fn is_empty(&self) -> bool {
        POINTER_BUTTONS
            .iter()
            .all(|button| self.down(*button).is_empty() && self.up(*button).is_empty())
            && self.mouse_move.is_empty()
            && self.hover.is_empty()
    }

    fn down(&self, button: PointerButton) -> &Vec<PointerHandler<MouseDownEvent, N>> {
        match button {
            PointerButton::Left => &self.left_down,
            PointerButton::Right => &self.right_down,
            PointerButton::Middle => &self.middle_down,
            PointerButton::Back => &self.back_down,
            PointerButton::Forward => &self.forward_down,
        }
    }

    fn up(&self, button: PointerButton) -> &Vec<PointerHandler<MouseUpEvent, N>> {
        match button {
            PointerButton::Left => &self.left_up,
            PointerButton::Right => &self.right_up,
            PointerButton::Middle => &self.middle_up,
            PointerButton::Back => &self.back_up,
            PointerButton::Forward => &self.forward_up,
        }
    }
}

/// How far past its box a node takes a press, in points: left, top, right,
/// bottom. Presses, moves and hover all reach this far, and so does the cursor.
pub(crate) type HitSlop = [f32; 4];

/// `child` taking pointer input over its own box, plus `slop`, without a
/// layout node of its own. The hitbox goes in before the child's, as a first
/// child's would, so the child's descendants stay in front of it.
pub(crate) struct PointerArea<N: 'static = Node> {
    child: AnyElement,
    target: Rc<(N, Rc<PointerHandlers<N>>)>,
    slop: HitSlop,
    cursor: Option<gpui::CursorStyle>,
}

impl<N: 'static> PointerArea<N> {
    pub(crate) fn new(
        child: impl IntoElement,
        node: N,
        handlers: Rc<PointerHandlers<N>>,
        slop: HitSlop,
        cursor: Option<gpui::CursorStyle>,
    ) -> Self {
        Self {
            child: child.into_any_element(),
            target: Rc::new((node, handlers)),
            slop,
            cursor,
        }
    }
}

impl<N: 'static> IntoElement for PointerArea<N> {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl<N: 'static> Element for PointerArea<N> {
    type RequestLayoutState = ();
    type PrepaintState = Hitbox;

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
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        let slop = self.slop;
        let reach = Bounds {
            origin: point(bounds.origin.x - px(slop[0]), bounds.origin.y - px(slop[1])),
            size: size(
                bounds.size.width + px(slop[0] + slop[2]),
                bounds.size.height + px(slop[1] + slop[3]),
            ),
        };
        let hitbox = window.insert_hitbox(reach, HitboxBehavior::Normal);
        self.child.prepaint(window, cx);
        hitbox
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        press_box: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        register_listeners(&self.target, press_box, self.slop, self.cursor, window);
        self.child.paint(window, cx);
    }
}

fn register_listeners<N: 'static>(
    target: &Rc<(N, Rc<PointerHandlers<N>>)>,
    press_box: &Hitbox,
    slop: HitSlop,
    cursor: Option<gpui::CursorStyle>,
    window: &mut Window,
) {
    if let Some(cursor) = cursor {
        if slop != [0.0; 4] {
            window.set_cursor_style(cursor, press_box);
        }
    }
    let hitbox = press_box.id;
    let handlers = &target.1;
    // An event has one button, so while no button has more than one handler,
    // one listener for presses and one for releases run exactly the handler
    // a listener per handler would.
    if POINTER_BUTTONS
        .iter()
        .all(|button| handlers.down(*button).len() <= 1 && handlers.up(*button).len() <= 1)
    {
        if POINTER_BUTTONS
            .iter()
            .any(|button| !handlers.down(*button).is_empty())
        {
            let target = target.clone();
            window.on_mouse_event(move |event: &MouseDownEvent, phase, window, cx| {
                if phase != DispatchPhase::Bubble {
                    return;
                }
                let Some(button) = PointerButton::from_gpui(event.button) else {
                    return;
                };
                if let Some(handler) = target.1.down(button).first() {
                    if hitbox.is_hovered(window) {
                        handler(&target.0, event, window, cx);
                    }
                }
            });
        }
        if POINTER_BUTTONS
            .iter()
            .any(|button| !handlers.up(*button).is_empty())
        {
            let target = target.clone();
            window.on_mouse_event(move |event: &MouseUpEvent, phase, window, cx| {
                if phase != DispatchPhase::Bubble {
                    return;
                }
                let Some(button) = PointerButton::from_gpui(event.button) else {
                    return;
                };
                if let Some(handler) = target.1.up(button).first() {
                    if hitbox.is_hovered(window) {
                        handler(&target.0, event, window, cx);
                    }
                }
            });
        }
    } else {
        register_button_listeners(target, hitbox, window);
    }
    for index in 0..handlers.mouse_move.len() {
        let target = target.clone();
        window.on_mouse_event(move |event: &MouseMoveEvent, phase, window, cx| {
            if phase == DispatchPhase::Bubble && hitbox.is_hovered(window) {
                target.1.mouse_move[index](&target.0, event, window, cx);
            }
        });
    }
    // Enter and leave: GPUI reports hovered state per hitbox, so the
    // transition is an edge detected by the handler rather than an event.
    // The handler decides, because the previous state has to outlive this
    // closure: GPUI clears `mouse_listeners` on every frame, so a
    // `was_hovered` local here would reset at each paint and the leave edge
    // would never fire.
    for index in 0..handlers.hover.len() {
        let target = target.clone();
        window.on_mouse_event(move |_event: &MouseMoveEvent, phase, window, cx| {
            if phase != DispatchPhase::Bubble {
                return;
            }
            let hovered = hitbox.is_hovered(window);
            target.1.hover[index](&target.0, hovered, window, cx);
        });
    }
}

/// A listener per handler, each holding the shared handlers and its index, so
/// GPUI stops between the handlers of one button when one stops propagation.
fn register_button_listeners<N: 'static>(
    target: &Rc<(N, Rc<PointerHandlers<N>>)>,
    hitbox: gpui::HitboxId,
    window: &mut Window,
) {
    let handlers = &target.1;
    for button in POINTER_BUTTONS {
        for index in 0..handlers.down(button).len() {
            let target = target.clone();
            window.on_mouse_event(move |event: &MouseDownEvent, phase, window, cx| {
                if phase == DispatchPhase::Bubble
                    && PointerButton::from_gpui(event.button) == Some(button)
                    && hitbox.is_hovered(window)
                {
                    target.1.down(button)[index](&target.0, event, window, cx);
                }
            });
        }
        for index in 0..handlers.up(button).len() {
            let target = target.clone();
            window.on_mouse_event(move |event: &MouseUpEvent, phase, window, cx| {
                if phase == DispatchPhase::Bubble
                    && PointerButton::from_gpui(event.button) == Some(button)
                    && hitbox.is_hovered(window)
                {
                    target.1.up(button)[index](&target.0, event, window, cx);
                }
            });
        }
    }
}

#[cfg(test)]
mod hover_tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    /// A root view holding one pointer area, so a test can draw it and dispatch
    /// moves at it. `PointerArea` is an element, not a `Render`, so it needs a
    /// view to live in — the same shape `store.rs` uses for its surface root.
    struct HoverProbe {
        handlers: RefCell<Option<PointerHandlers<()>>>,
    }

    impl gpui::Render for HoverProbe {
        fn render(
            &mut self,
            _window: &mut Window,
            _cx: &mut gpui::Context<Self>,
        ) -> impl IntoElement {
            let handlers = self.handlers.borrow_mut().take().unwrap_or_default();
            PointerArea::new(
                gpui::div().size_full(),
                (),
                Rc::new(handlers),
                [0.0; 4],
                None,
            )
        }
    }

    /// Records every hover sample the listener reports, and edges them the way a
    /// real caller does — with the previous state owned outside the listener.
    fn recorder() -> (Rc<RefCell<Vec<bool>>>, HoverHandler<()>) {
        let seen = Rc::new(RefCell::new(Vec::new()));
        let sink = seen.clone();
        let previous = Rc::new(std::cell::Cell::new(false));
        let handler: HoverHandler<()> = Rc::new(move |_: &(), hovered: bool, _window, _cx| {
            if previous.get() == hovered {
                return;
            }
            previous.set(hovered);
            sink.borrow_mut().push(hovered);
        });
        (seen, handler)
    }

    /// Mounts a pointer area filling the window, draws one frame, then moves the
    /// pointer to `position` and reads what the listener saw.
    fn move_pointer(cx: &mut gpui::TestAppContext, handlers: PointerHandlers<()>, x: f32, y: f32) {
        let window = cx.open_window(gpui::size(gpui::px(200.0), gpui::px(200.0)), move |_, _| {
            HoverProbe {
                handlers: RefCell::new(Some(handlers)),
            }
        });
        window
            .update(cx, |_, window, app| {
                // A frame first: the listener is registered while painting, so a
                // move before the first draw has nothing to hit.
                let needs_clear = window.draw(app);
                needs_clear.clear(app);
                window.dispatch_event(
                    gpui::PlatformInput::MouseMove(gpui::MouseMoveEvent {
                        position: gpui::point(gpui::px(x), gpui::px(y)),
                        pressed_button: None,
                        ..Default::default()
                    }),
                    app,
                );
            })
            .unwrap();
    }

    #[gpui::test]
    fn a_hover_handler_reports_enter_when_the_pointer_arrives(cx: &mut gpui::TestAppContext) {
        // The question this answers: does a synthetic move reach a hover listener
        // at all? If this fails, the problem is native; if it passes, it is the
        // test driver or the JS event path.
        let (seen, handler) = recorder();
        let handlers = PointerHandlers {
            hover: vec![handler],
            ..PointerHandlers::default()
        };
        // PointerHandlers is not Clone, so the recorder is read through the Rc the
        // handler owns; moving it in does not lose the other reference.
        move_pointer(cx, handlers, 50.0, 50.0);
        assert_eq!(*seen.borrow(), vec![true], "expected one enter");
    }

    #[gpui::test]
    fn leaving_reports_leave_across_a_repaint(cx: &mut gpui::TestAppContext) {
        // This is the reported bug. `was_hovered` used to live inside the
        // listener, and GPUI registers fresh listeners on every paint, so a
        // repaint reset it to `false` and the leave edge was never seen — the
        // hovered state stayed on forever.
        let (seen, handler) = recorder();
        let handlers = PointerHandlers {
            hover: vec![handler],
            ..PointerHandlers::default()
        };
        let window = cx.open_window(gpui::size(gpui::px(200.0), gpui::px(200.0)), move |_, _| {
            HoverProbe {
                handlers: RefCell::new(Some(handlers)),
            }
        });
        window
            .update(cx, |_, window, app| {
                let draw_and_move = |window: &mut gpui::Window, app: &mut gpui::App, x, y| {
                    let needs_clear = window.draw(app);
                    needs_clear.clear(app);
                    window.dispatch_event(
                        gpui::PlatformInput::MouseMove(gpui::MouseMoveEvent {
                            position: gpui::point(gpui::px(x), gpui::px(y)),
                            pressed_button: None,
                            ..Default::default()
                        }),
                        app,
                    );
                };
                draw_and_move(window, app, 50.0, 50.0);
                // A repaint between the two moves: this is what reset the old
                // closure's state.
                draw_and_move(window, app, 50.0, 50.0);
                // Now leave the window entirely.
                draw_and_move(window, app, 400.0, 400.0);
            })
            .unwrap();
        assert_eq!(
            *seen.borrow(),
            vec![true, false],
            "enter once, then leave once, with the repaint in between ignored",
        );
    }

    /// A 40 by 40 box at (60, 60) holding a pointer area with `slop`.
    struct SlopProbe {
        handlers: RefCell<Option<PointerHandlers<()>>>,
        slop: HitSlop,
    }

    impl gpui::Render for SlopProbe {
        fn render(
            &mut self,
            _window: &mut Window,
            _cx: &mut gpui::Context<Self>,
        ) -> impl IntoElement {
            let handlers = self.handlers.borrow_mut().take().unwrap_or_default();
            gpui::div().size_full().child(PointerArea::new(
                gpui::div()
                    .absolute()
                    .left(gpui::px(60.0))
                    .top(gpui::px(60.0))
                    .size(gpui::px(40.0)),
                (),
                Rc::new(handlers),
                self.slop,
                None,
            ))
        }
    }

    /// Whether a press at (x, y) reaches a handler on a box with `slop`, and
    /// whether a move there is seen as hover.
    fn press_and_hover(
        cx: &mut gpui::TestAppContext,
        slop: HitSlop,
        x: f32,
        y: f32,
    ) -> (bool, bool) {
        let pressed = Rc::new(std::cell::Cell::new(false));
        let hovered = Rc::new(std::cell::Cell::new(false));
        let (sink, hover_sink) = (pressed.clone(), hovered.clone());
        let handlers = PointerHandlers {
            left_down: vec![Rc::new(move |_: &(), _: &MouseDownEvent, _, _| {
                sink.set(true)
            })],
            hover: vec![Rc::new(move |_: &(), over: bool, _, _| {
                if over {
                    hover_sink.set(true);
                }
            })],
            ..PointerHandlers::default()
        };
        let window = cx.open_window(gpui::size(gpui::px(200.0), gpui::px(200.0)), move |_, _| {
            SlopProbe {
                handlers: RefCell::new(Some(handlers)),
                slop,
            }
        });
        window
            .update(cx, |_, window, app| {
                let needs_clear = window.draw(app);
                needs_clear.clear(app);
                let position = gpui::point(gpui::px(x), gpui::px(y));
                window.dispatch_event(
                    gpui::PlatformInput::MouseMove(gpui::MouseMoveEvent {
                        position,
                        pressed_button: None,
                        ..Default::default()
                    }),
                    app,
                );
                window.dispatch_event(
                    gpui::PlatformInput::MouseDown(gpui::MouseDownEvent {
                        position,
                        button: gpui::MouseButton::Left,
                        ..Default::default()
                    }),
                    app,
                );
            })
            .unwrap();
        (pressed.get(), hovered.get())
    }

    #[gpui::test]
    fn a_press_or_hover_in_the_slop_reaches_the_handler(cx: &mut gpui::TestAppContext) {
        let slop = [10.0, 20.0, 30.0, 40.0];
        // Inside the box.
        assert_eq!(press_and_hover(cx, slop, 80.0, 80.0), (true, true));
        // Left of the box by 5 (slop 10), above it by 15 (slop 20).
        assert_eq!(press_and_hover(cx, slop, 55.0, 80.0), (true, true));
        assert_eq!(press_and_hover(cx, slop, 80.0, 45.0), (true, true));
        // Right of the box by 25 (slop 30), below it by 35 (slop 40).
        assert_eq!(press_and_hover(cx, slop, 125.0, 80.0), (true, true));
        assert_eq!(press_and_hover(cx, slop, 80.0, 135.0), (true, true));
        // Past the slop on each side.
        assert_eq!(press_and_hover(cx, slop, 45.0, 80.0), (false, false));
        assert_eq!(press_and_hover(cx, slop, 80.0, 35.0), (false, false));
        assert_eq!(press_and_hover(cx, slop, 135.0, 80.0), (false, false));
        assert_eq!(press_and_hover(cx, slop, 80.0, 145.0), (false, false));
    }
}
