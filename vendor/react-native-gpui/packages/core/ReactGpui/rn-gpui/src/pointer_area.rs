//! A `div` with listeners asks `hitbox.is_hovered` while painting, and gpui-fast
//! records that read as a dependency. This element inserts the same hitbox but
//! asks only inside its event handlers, where nothing is recorded.

use gpui::{
    canvas, prelude::*, App, DispatchPhase, HitboxBehavior, MouseButton, MouseDownEvent,
    MouseMoveEvent, MouseUpEvent, NavigationDirection, Window,
};
use std::rc::Rc;

pub(crate) type PointerHandler<Event> = Rc<dyn Fn(&Event, &mut Window, &mut App)>;

/// A hover sample: whether the pointer is over the area now, then the context.
///
/// It is a sample rather than an edge because the edge is decided by whoever owns
/// the previous state, which cannot live in here — `mouse_listeners` is cleared on
/// every frame, so this closure is rebuilt each paint.
pub(crate) type HoverHandler = Rc<dyn Fn(bool, &mut Window, &mut App)>;

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
            _ => None,
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
#[derive(Default)]
pub(crate) struct PointerHandlers {
    pub(crate) left_down: Vec<PointerHandler<MouseDownEvent>>,
    pub(crate) right_down: Vec<PointerHandler<MouseDownEvent>>,
    pub(crate) left_up: Vec<PointerHandler<MouseUpEvent>>,
    pub(crate) right_up: Vec<PointerHandler<MouseUpEvent>>,
    pub(crate) middle_down: Vec<PointerHandler<MouseDownEvent>>,
    pub(crate) middle_up: Vec<PointerHandler<MouseUpEvent>>,
    /// The side buttons, which are rare enough not to deserve a field each.
    pub(crate) back_down: Vec<PointerHandler<MouseDownEvent>>,
    pub(crate) forward_down: Vec<PointerHandler<MouseDownEvent>>,
    pub(crate) back_up: Vec<PointerHandler<MouseUpEvent>>,
    pub(crate) forward_up: Vec<PointerHandler<MouseUpEvent>>,
    pub(crate) mouse_move: Vec<PointerHandler<MouseMoveEvent>>,
    /// Hover samples: each handler is told whether the pointer is over the area
    /// and decides for itself whether that is a change.
    pub(crate) hover: Vec<HoverHandler>,
}

impl PointerHandlers {
    pub(crate) fn is_empty(&self) -> bool {
        POINTER_BUTTONS
            .iter()
            .all(|button| self.down(*button).is_empty() && self.up(*button).is_empty())
            && self.mouse_move.is_empty()
            && self.hover.is_empty()
    }

    fn down(&self, button: PointerButton) -> &Vec<PointerHandler<MouseDownEvent>> {
        match button {
            PointerButton::Left => &self.left_down,
            PointerButton::Right => &self.right_down,
            PointerButton::Middle => &self.middle_down,
            PointerButton::Back => &self.back_down,
            PointerButton::Forward => &self.forward_down,
        }
    }

    fn up(&self, button: PointerButton) -> &Vec<PointerHandler<MouseUpEvent>> {
        match button {
            PointerButton::Left => &self.left_up,
            PointerButton::Right => &self.right_up,
            PointerButton::Middle => &self.middle_up,
            PointerButton::Back => &self.back_up,
            PointerButton::Forward => &self.forward_up,
        }
    }
}

pub(crate) fn pointer_area(handlers: PointerHandlers) -> impl IntoElement {
    canvas(
        |bounds, window, _cx| window.insert_hitbox(bounds, HitboxBehavior::Normal),
        move |_bounds, hitbox, window, _cx| {
            // Every button, including the ones nothing currently registers, so
            // adding a listener for a middle click needs no change here.
            for button in POINTER_BUTTONS {
                for handler in handlers.down(button).clone() {
                    let hitbox = hitbox.clone();
                    window.on_mouse_event(move |event: &MouseDownEvent, phase, window, cx| {
                        if phase == DispatchPhase::Bubble
                            && PointerButton::from_gpui(event.button) == Some(button)
                            && hitbox.is_hovered(window)
                        {
                            handler(event, window, cx);
                        }
                    });
                }
                for handler in handlers.up(button).clone() {
                    let hitbox = hitbox.clone();
                    window.on_mouse_event(move |event: &MouseUpEvent, phase, window, cx| {
                        if phase == DispatchPhase::Bubble
                            && PointerButton::from_gpui(event.button) == Some(button)
                            && hitbox.is_hovered(window)
                        {
                            handler(event, window, cx);
                        }
                    });
                }
            }
            for handler in handlers.mouse_move {
                let hitbox = hitbox.clone();
                window.on_mouse_event(move |event: &MouseMoveEvent, phase, window, cx| {
                    if phase == DispatchPhase::Bubble && hitbox.is_hovered(window) {
                        handler(event, window, cx);
                    }
                });
            }
            // Enter and leave: GPUI reports hovered state per hitbox, so the
            // transition is an edge detected by the handler rather than an event.
            // The handler decides, because the previous state has to outlive this
            // closure: GPUI clears `mouse_listeners` on every frame, so a
            // `was_hovered` local here would reset at each paint and the leave edge
            // would never fire.
            for handler in handlers.hover {
                let hitbox = hitbox.clone();
                window.on_mouse_event(move |_event: &MouseMoveEvent, phase, window, cx| {
                    if phase != DispatchPhase::Bubble {
                        return;
                    }
                    let h = hitbox.is_hovered(window);
                    handler(h, window, cx);
                });
            }
        },
    )
    .absolute()
    .inset_0()
    .size_full()
}

#[cfg(test)]
mod hover_tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    /// A root view holding one pointer area, so a test can draw it and dispatch
    /// moves at it. `pointer_area` is an element, not a `Render`, so it needs a
    /// view to live in — the same shape `store.rs` uses for its surface root.
    struct HoverProbe {
        handlers: RefCell<Option<PointerHandlers>>,
    }

    impl gpui::Render for HoverProbe {
        fn render(
            &mut self,
            _window: &mut Window,
            _cx: &mut gpui::Context<Self>,
        ) -> impl IntoElement {
            let handlers = self.handlers.borrow_mut().take().unwrap_or_default();
            gpui::div().size_full().child(pointer_area(handlers))
        }
    }

    /// Records every hover sample the listener reports, and edges them the way a
    /// real caller does — with the previous state owned outside the listener.
    fn recorder() -> (Rc<RefCell<Vec<bool>>>, HoverHandler) {
        let seen = Rc::new(RefCell::new(Vec::new()));
        let sink = seen.clone();
        let previous = Rc::new(std::cell::Cell::new(false));
        let handler: HoverHandler = Rc::new(move |hovered: bool, _window, _cx| {
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
    fn move_pointer(cx: &mut gpui::TestAppContext, handlers: PointerHandlers, x: f32, y: f32) {
        use gpui::prelude::*;
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
        use gpui::prelude::*;
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
                let mut draw_and_move = |window: &mut gpui::Window, app: &mut gpui::App, x, y| {
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
}
