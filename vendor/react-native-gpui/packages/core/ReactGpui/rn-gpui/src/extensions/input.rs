//! The input a component renderer can ask for, and the events it is given.
//!
//! A renderer registered with `register_component_renderer` could supply content,
//! change children, decorate, scroll and handle keys, but could not attach mouse
//! listeners, take part in a drag or mark a window-control area. These types are
//! that API.
//!
//! Nothing here is a GPUI type. `MouseEvent`, `ScrollEvent`, `DragPhase` and
//! `WindowControl` are this crate's own copies of the parts of GPUI's event data
//! a component needs, so a GPUI upgrade without a change in meaning cannot break a
//! module's source. The cost is a conversion at the boundary, which is why the
//! conversions live here next to the types they convert.

use crate::events::{Button, ModifierState};
use gpui::{App, Pixels, Point, Window};

/// Which buttons a component wants to hear about.
///
/// A set rather than a flag per button, so `InputSpec::default()` naturally means
/// "none" and adding a button does not change the struct's size.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ButtonSet(u8);

impl ButtonSet {
    pub const NONE: ButtonSet = ButtonSet(0);

    pub const fn one(button: Button) -> Self {
        ButtonSet(1 << (button as u8))
    }

    pub const fn all() -> Self {
        ButtonSet(0b1_1111)
    }

    #[must_use]
    pub const fn with(self, other: ButtonSet) -> Self {
        ButtonSet(self.0 | other.0)
    }

    pub const fn contains(self, button: Button) -> bool {
        self.0 & (1 << (button as u8)) != 0
    }
}

/// What a component wants to be told about.
///
/// Read when the node is built, so core only installs the listeners a component
/// asked for. A component that returns the default gets no input at all, which is
/// what every renderer written before these hooks existed does.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct InputSpec {
    /// Which buttons to deliver `on_mouse_down` / `on_mouse_up` for.
    pub mouse_buttons: ButtonSet,
    /// Whether to call `on_hover` when the pointer enters and leaves.
    pub hover: bool,
    /// Whether to call `on_scroll`; asking also stops the scroll from reaching
    /// the node's scrolling ancestor, which is what a custom scroll view wants.
    pub scroll: bool,
    /// Whether a press that moves past the threshold starts a drag.
    pub drag: bool,
    /// Whether to call `on_context_menu` for a right click, Ctrl+click on macOS,
    /// or the Menu key / Shift+F10.
    pub context_menu: bool,
    /// The cursor while the pointer is over the node.
    pub cursor: Option<CursorStyle>,
}

/// The pointer shapes a component can ask for.
///
/// A small named set rather than GPUI's `CursorStyle`, so the meaning does not
/// change if GPUI's does. Each maps to the platform cursor a user expects.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CursorStyle {
    Default,
    Pointer,
    Text,
    Crosshair,
    Move,
    NotAllowed,
    ResizeLeftRight,
    ResizeUpDown,
}

/// Where a mouse event happened.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MouseEvent {
    /// In the window, in device-independent pixels.
    pub position: Point<Pixels>,
    /// In the node's own box, so a component does not have to subtract a frame.
    pub local: Point<Pixels>,
    pub button: Button,
    /// The mask of held buttons, using the DOM's order (see `Button::mask`).
    pub buttons: i32,
    /// 1 for a single click, 2 for a double.
    pub click_count: usize,
    pub modifiers: ModifierState,
}

/// A scroll, in the units GPUI reports: pixels, already normalised across the
/// platforms' very different conventions.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScrollEvent {
    pub delta: Point<Pixels>,
    pub position: Point<Pixels>,
    pub local: Point<Pixels>,
    pub modifiers: ModifierState,
}

/// Where a drag is in its life.
///
/// `Start` is delivered once the pointer has moved past the threshold, not on the
/// initial press, so a component can use the same button for a click and a drag.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DragPhase {
    Start,
    Move,
    End,
    /// The drag did not finish normally: the window lost the pointer, or the
    /// drag was cancelled. A component holding state should reset it.
    Cancel,
}

/// Whether a hook consumed the event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Propagation {
    /// Let the event continue to other handlers and the node's ancestors.
    Continue,
    /// Stop here. Core calls `cx.stop_propagation()`.
    Stop,
}

/// How a context menu was requested, and where.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ContextMenuTrigger {
    /// `Mouse` for a right click or a Ctrl+click, `Keyboard` for the Menu key or
    /// Shift+F10 — which only Windows and Linux report.
    pub source: crate::events::ContextMenuTriggerSource,
    /// Where to anchor the menu: the pointer for a mouse trigger, the node's
    /// bottom-left corner for a keyboard one, as a native menu does.
    pub position: Point<Pixels>,
    pub local: Point<Pixels>,
    pub button: Button,
    pub modifiers: ModifierState,
}

/// What a hook may do while it runs.
///
/// The fields are private so a hook cannot hold onto the window or the app past
/// its own call; everything it needs is a method. That is the reason this exists
/// instead of passing `&mut Window` and `&mut App` straight through: a component
/// gets a small, stable surface rather than the whole of GPUI.
pub struct InputContext<'a> {
    pub(crate) node: &'a crate::extensions::ComponentNode,
    pub(crate) window: &'a mut Window,
    pub(crate) cx: &'a mut App,
    /// Set by `capture_pointer`; core keeps delivering moves after the hook
    /// returns, which is what makes a drag outside the node's box work.
    pub(crate) captured: bool,
}

impl<'a> InputContext<'a> {
    /// The id of the window the event belongs to, which is what
    /// `ContextMenu.show` and `DesktopWindow` take.
    pub fn window_id(&self) -> u32 {
        let handle = self.window.window_handle();
        crate::desktop::windows::window_key_for_handle(self.cx, handle)
            .unwrap_or(crate::desktop::windows::MAIN_WINDOW_KEY)
    }

    /// Dispatches a Fabric event to this node's tag.
    pub fn dispatch_event(&mut self, name: &str, payload: &serde_json::Value) {
        if let Some(store) = self.cx.try_global::<crate::store::StoreGlobal>() {
            let store = store.0.read(self.cx);
            store.host.dispatch_event(self.node.tag, name, payload);
            store.frame_hook.arm(self.window);
        }
    }

    /// Keeps receiving this component's moves after the pointer leaves its box,
    /// until the button is released. Used by drags.
    pub fn capture_pointer(&mut self) {
        self.captured = true;
    }

    /// Shows a context menu for this node, in the window the press arrived in.
    ///
    /// The presenter decides when the menu actually appears: the native one runs
    /// a modal tracking loop, which must not happen while GPUI is inside an
    /// update, so it defers; the GPUI-drawn one opens its own window. Either way
    /// this returns before the menu exists.
    ///
    /// `model` is already parsed, which is what lets a component decide for
    /// itself whether its props describe a menu at all. The answer, an item id or
    /// nothing, is dispatched to the node's tag as `topMenuSelect` or
    /// `topMenuDismiss` when the menu closes.
    pub fn show_context_menu(
        &mut self,
        model: crate::desktop::menu_model::MenuModel,
        position: gpui::Point<gpui::Pixels>,
    ) {
        let window = self.window.window_handle();
        let x = f32::from(position.x);
        let y = f32::from(position.y);
        let tag = self.node.tag;
        // The selection comes back on whichever thread the platform reports it
        // on, long after this hook returned, so it is dispatched on the main
        // thread and to the tag rather than through the entity.
        let responder =
            crate::desktop::context_menu::Responder::callback(Box::new(move |selection| {
                crate::desktop::post_to_main(Box::new(move |cx: &mut App| {
                    let Some(store) = crate::store::store_from(cx) else {
                        return;
                    };
                    let (host, frame_hook) = {
                        let store = store.read(cx);
                        (store.host.clone(), store.frame_hook.clone())
                    };
                    match selection {
                        Some(id) => host.dispatch_event(
                            tag,
                            "topMenuSelect",
                            &serde_json::json!({ "id": id }),
                        ),
                        None => host.dispatch_event(tag, "topMenuDismiss", &serde_json::json!({})),
                    }
                    let _ = window.update(cx, |_root, window, _cx| frame_hook.arm(window));
                }));
            }));
        crate::desktop::context_menu::present(self.cx, model, window, (x, y), responder);
    }

    /// Stops capture early, on the drag's end.
    pub fn release_pointer(&mut self) {
        self.captured = false;
    }

    /// Schedules a frame, for a component whose next paint depends on this event.
    pub fn request_frame(&mut self) {
        self.window.request_animation_frame();
    }

    /// The node this hook was called for.
    pub fn node(&self) -> &crate::extensions::ComponentNode {
        self.node
    }

    /// Whether the window is currently maximized.
    ///
    /// A caption button needs this to choose between a maximize and a restore
    /// glyph, which is why it is here rather than on an event.
    pub fn window_is_maximized(&self) -> bool {
        self.window.is_maximized()
    }

    pub fn minimize_window(&mut self) {
        self.window.minimize_window();
    }

    /// Maximize, or restore if already maximized.
    ///
    /// GPUI's `zoom_window` toggles on macOS (an `NSWindow` zoom), on X11
    /// (`_NET_WM_STATE_MAXIMIZED_*` with `Toggle`) and on Wayland
    /// (`set_maximized` / `unset_maximized`), so asking it for a zoom is asking
    /// for a toggle. Windows is the one platform where it only ever maximizes —
    /// a caption button there is performed by the OS through `HTMAXBUTTON`,
    /// which asks `IsZoomed` and sends `SW_MAXIMIZE` or `SW_NORMAL` itself, so
    /// this hook is never the one that acts there.
    pub fn toggle_maximize_window(&mut self) {
        self.window.zoom_window();
    }

    /// Closes the window through the normal path.
    ///
    /// `remove_window` would bypass `closeRequested`, so a component asking to
    /// close must go the way a title-bar close button does: the app gets its veto
    /// first. The close is deferred because it updates the same window this hook
    /// is running inside, and a window cannot be updated while it is borrowed;
    /// deferred work runs once the current update has finished, which is also
    /// when `closeRequested` can safely reach JS.
    pub fn close_window(&mut self) {
        let Some(key) =
            crate::desktop::windows::window_key_for_handle(self.cx, self.window.window_handle())
        else {
            // A window with no registry entry is not one the desktop shell
            // opened, so there is no veto to ask; it is not the shell's to close.
            log::warn!("[window] a control asked to close a window the shell does not own");
            return;
        };
        self.cx.defer(move |cx| {
            if let Err(error) = crate::desktop::windows::close_window(cx, key, false) {
                log::warn!("[window] could not close window {key}: {}", error.message);
            }
        });
    }
}

/// A title-bar area a component can claim.
///
/// `desktopDragRegion` marks a drag area for a `View`; this is how a component
/// claims one, and the only way to claim a caption button — the
/// `desktopWindowControl` prop it replaces is gone.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowControl {
    Drag,
    Minimize,
    Maximize,
    Close,
}

impl ModifierState {
    /// Exposed for the hook signatures, which take this crate's copy.
    pub fn all(ctrl: bool, shift: bool, alt: bool, meta: bool) -> Self {
        Self {
            ctrl,
            shift,
            alt,
            meta,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// Records the hooks it is given, so a test can assert what fired and when.
    struct RecordingRenderer {
        spec: InputSpec,
        /// `None` leaves the trait's default, which is what an existing renderer
        /// gets; `Some` claims that area so the test can see the difference.
        control: Option<WindowControl>,
        seen: Arc<Mutex<Vec<String>>>,
    }

    impl crate::extensions::ComponentRenderer for RecordingRenderer {
        fn render(
            &self,
            _node: &crate::extensions::ComponentNode,
            _window: &mut Window,
            _cx: &mut App,
        ) -> Option<gpui::AnyElement> {
            None
        }

        fn input(&self, _node: &crate::extensions::ComponentNode) -> InputSpec {
            self.spec
        }

        fn on_mouse_down(
            &self,
            _node: &crate::extensions::ComponentNode,
            event: &MouseEvent,
            _cx: &mut InputContext<'_>,
        ) -> Propagation {
            self.seen.lock().unwrap().push(format!(
                "down {:?} mask={} count={}",
                event.button, event.buttons, event.click_count
            ));
            Propagation::Continue
        }

        fn on_mouse_up(
            &self,
            _node: &crate::extensions::ComponentNode,
            event: &MouseEvent,
            _cx: &mut InputContext<'_>,
        ) -> Propagation {
            self.seen
                .lock()
                .unwrap()
                .push(format!("up {:?}", event.button));
            Propagation::Continue
        }

        fn on_hover(
            &self,
            _node: &crate::extensions::ComponentNode,
            hovered: bool,
            _cx: &mut InputContext<'_>,
        ) {
            self.seen.lock().unwrap().push(format!("hover {hovered}"));
        }

        fn on_context_menu(
            &self,
            _node: &crate::extensions::ComponentNode,
            event: &ContextMenuTrigger,
            _cx: &mut InputContext<'_>,
        ) -> Propagation {
            self.seen
                .lock()
                .unwrap()
                .push(format!("menu {:?}", event.source));
            Propagation::Stop
        }

        fn window_control(
            &self,
            _node: &crate::extensions::ComponentNode,
        ) -> Option<WindowControl> {
            self.control
        }
    }

    fn node() -> crate::extensions::ComponentNode {
        crate::extensions::ComponentNode {
            component: "RecordingWidget".to_string(),
            tag: 7,
            frame: rn_gpui_sys::ffi::RectF {
                x: 10.0,
                y: 20.0,
                w: 100.0,
                h: 50.0,
            },
            scale: (1.0, 1.0),
            props: Arc::new(serde_json::json!({})),
            parent: None,
            children: Vec::new(),
        }
    }

    #[gpui::test]
    fn the_hooks_a_component_asked_for_are_the_ones_called(cx: &mut gpui::TestAppContext) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        crate::extensions::register_component_renderer(
            "RecordingWidget",
            Arc::new(RecordingRenderer {
                spec: InputSpec {
                    mouse_buttons: ButtonSet::one(Button::Middle),
                    hover: true,
                    context_menu: true,
                    ..InputSpec::default()
                },
                control: Some(WindowControl::Drag),
                seen: seen.clone(),
            }),
        );

        let window = cx.open_window(gpui::size(gpui::px(200.0), gpui::px(200.0)), |_, _| {
            gpui::Empty
        });
        window
            .update(cx, |_, window, cx| {
                let renderer =
                    crate::extensions::component_renderer("RecordingWidget").expect("registered");
                let spec = renderer.input(&node());

                // The spec is what core reads to decide which listeners to add.
                assert!(spec.mouse_buttons.contains(Button::Middle));
                assert!(!spec.mouse_buttons.contains(Button::Left));
                assert!(spec.hover);
                assert!(spec.context_menu);
                assert!(!spec.drag);
                assert!(!spec.scroll);

                let mut context = InputContext {
                    node: &node(),
                    window,
                    cx,
                    captured: false,
                };
                let event = MouseEvent {
                    position: gpui::point(gpui::px(30.0), gpui::px(40.0)),
                    local: gpui::point(gpui::px(20.0), gpui::px(20.0)),
                    button: Button::Middle,
                    buttons: Button::Middle.mask(),
                    click_count: 1,
                    modifiers: ModifierState::none(),
                };
                renderer.on_mouse_down(&node(), &event, &mut context);
                renderer.on_mouse_up(&node(), &event, &mut context);
                renderer.on_hover(&node(), true, &mut context);
                renderer.on_context_menu(
                    &node(),
                    &ContextMenuTrigger {
                        source: crate::events::ContextMenuTriggerSource::Mouse,
                        position: event.position,
                        local: event.local,
                        button: Button::Right,
                        modifiers: ModifierState::none(),
                    },
                    &mut context,
                );
            })
            .unwrap();

        assert_eq!(
            *seen.lock().unwrap(),
            vec![
                "down Middle mask=4 count=1".to_string(),
                "up Middle".to_string(),
                "hover true".to_string(),
                "menu Mouse".to_string(),
            ]
        );
    }

    #[gpui::test]
    fn a_renderer_that_asks_for_nothing_still_answers_the_hooks(cx: &mut gpui::TestAppContext) {
        // Every renderer written before this API must keep compiling and behave as
        // it did. The trait supplies no-op defaults, so this only checks that the
        // defaults exist and are inert rather than that they are reachable.
        let seen = Arc::new(Mutex::new(Vec::new()));
        crate::extensions::register_component_renderer(
            "SilentWidget",
            Arc::new(RecordingRenderer {
                spec: InputSpec::default(),
                control: None,
                seen: seen.clone(),
            }),
        );
        let window = cx.open_window(gpui::size(gpui::px(120.0), gpui::px(90.0)), |_, _| {
            gpui::Empty
        });
        window
            .update(cx, |_, window, cx| {
                let renderer =
                    crate::extensions::component_renderer("SilentWidget").expect("registered");
                assert_eq!(renderer.input(&node()), InputSpec::default());
                let mut context = InputContext {
                    node: &node(),
                    window,
                    cx,
                    captured: false,
                };
                let event = MouseEvent {
                    position: gpui::point(gpui::px(0.0), gpui::px(0.0)),
                    local: gpui::point(gpui::px(0.0), gpui::px(0.0)),
                    button: Button::Left,
                    buttons: 0,
                    click_count: 1,
                    modifiers: ModifierState::none(),
                };
                // The default returns `Continue`, so a component that did not ask
                // for input never swallows an event.
                assert_eq!(
                    renderer.on_mouse_down(&node(), &event, &mut context),
                    Propagation::Continue
                );
                assert_eq!(
                    renderer.on_scroll(
                        &node(),
                        &ScrollEvent {
                            delta: gpui::point(gpui::px(0.0), gpui::px(1.0)),
                            position: event.position,
                            local: event.local,
                            modifiers: ModifierState::none(),
                        },
                        &mut context
                    ),
                    Propagation::Continue
                );
                assert_eq!(
                    renderer.window_control(&node()),
                    None,
                    "a renderer that does not override window_control inherits None"
                );
            })
            .unwrap();
        // The default spec is what decides whether any listener is installed, so
        // the assertion that matters is the spec, not the absence of calls: core
        // does not call these hooks when nothing was requested.
        assert_eq!(
            crate::extensions::component_renderer("SilentWidget")
                .expect("registered")
                .input(&node()),
            InputSpec::default()
        );
    }

    #[test]
    fn a_default_spec_asks_for_nothing() {
        // Every renderer written before these hooks existed returns the default,
        // so the default must install no listeners.
        let spec = InputSpec::default();
        assert_eq!(spec.mouse_buttons, ButtonSet::NONE);
        assert!(!spec.hover);
        assert!(!spec.scroll);
        assert!(!spec.drag);
        assert!(!spec.context_menu);
        assert_eq!(spec.cursor, None);
    }

    #[test]
    fn a_button_set_contains_only_what_was_added() {
        let left = ButtonSet::one(Button::Left);
        assert!(left.contains(Button::Left));
        assert!(!left.contains(Button::Right));

        let both = left.with(ButtonSet::one(Button::Right));
        assert!(both.contains(Button::Left));
        assert!(both.contains(Button::Right));
        assert!(!both.contains(Button::Middle));
    }

    #[test]
    fn every_button_fits_in_a_set_and_all_holds_them() {
        // `ButtonSet::all` is a hand-written mask, so a new button would silently
        // be outside it. This fails when one is added without updating it.
        for button in [
            Button::Left,
            Button::Middle,
            Button::Right,
            Button::Back,
            Button::Forward,
        ] {
            assert!(ButtonSet::all().contains(button), "{button:?}");
        }
        assert_eq!(
            ButtonSet::NONE
                .with(ButtonSet::one(Button::Left))
                .with(ButtonSet::one(Button::Middle))
                .with(ButtonSet::one(Button::Right))
                .with(ButtonSet::one(Button::Back))
                .with(ButtonSet::one(Button::Forward)),
            ButtonSet::all()
        );
    }

    #[test]
    fn the_default_cursor_is_only_asked_for_explicitly() {
        // `None` and `Some(Default)` mean different things: the first leaves the
        // cursor alone, the second sets it. A component that returns the default
        // spec must not change the cursor.
        assert_eq!(InputSpec::default().cursor, None);
        let explicit = InputSpec {
            cursor: Some(CursorStyle::Default),
            ..InputSpec::default()
        };
        assert_eq!(explicit.cursor, Some(CursorStyle::Default));
    }
}
