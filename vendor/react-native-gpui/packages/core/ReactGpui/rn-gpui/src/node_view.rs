//! One GPUI view per Fabric node. No flex property is ever set: every frame
//! comes from RN's Yoga pass.

use crate::pointer_area::{pointer_area, PointerHandlers};
use crate::style;
use gpui::{
    div, point, prelude::*, px, AnyElement, App, Context, Display, Entity, Fill, FocusHandle,
    IntoElement, KeyDownEvent, KeyUpEvent, MouseButton, MouseDownEvent, MouseMoveEvent,
    MouseUpEvent, Pixels, Point, Position, Role, StyleRefinement, Subscription, Task, WeakEntity,
    Window,
};
use rn_gpui_sys::ffi::{MountOp, ParagraphFlat, RectF, ViewPropsFlat};
use std::cell::Cell;
use std::collections::HashMap;
use std::rc::Rc;
#[cfg(all(target_os = "macos", feature = "visual-capture"))]
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(feature = "test-driver")]
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

static ACCESSIBILITY_ACTIVE: AtomicBool = AtomicBool::new(false);
static ACCESSIBILITY_ACTIVE_INITIALIZED: AtomicBool = AtomicBool::new(false);

#[no_mangle]
pub extern "C" fn rn_gpui_accessibility_active() -> bool {
    ACCESSIBILITY_ACTIVE.load(Ordering::Relaxed)
}

fn debug_render_counts_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var_os("RN_GPUI_DEBUG_RENDER_COUNTS").is_some())
}

fn elapsed_since_first_render_ms() -> u128 {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    START
        .get_or_init(std::time::Instant::now)
        .elapsed()
        .as_millis()
}

pub struct RNNodeView {
    pub tag: i32,
    render_count: u64,
    /// Whether the pointer was over this node at the last hover sample.
    ///
    /// Kept here rather than in the mouse listener because GPUI clears
    /// `mouse_listeners` on every frame: a listener-local flag would reset at each
    /// paint, so a component would be told it was entered repeatedly and never
    /// told the pointer left.
    hovered: bool,
    pub surface_id: i32,
    pub component: String,
    pub native_view_name: String,
    pub native_view_props: String,
    /// Whether this node's own content is composited by the OS rather than
    /// painted by GPUI. Decided once, when the node is created, from its
    /// registry entry; only a `NativeViewHost` can change it later, when an
    /// update gives it a factory name.
    pub(crate) renders_native_surface: bool,
    /// How many nodes in this subtree render a native surface, this node
    /// included.
    pub(crate) native_surface_descendants: u32,
    /// Whether this node's contribution has been added to its ancestors.
    pub(crate) native_surface_counted: bool,
    extension_props_json: String,
    extension_props: std::sync::Arc<serde_json::Value>,
    native_view_host: Option<std::rc::Rc<crate::native_surface::NativeSurface>>,
    /// The host component rendering this node, when its op carried a registry
    /// index. Created on the main thread when the node is mounted, and the only
    /// thing about the component this node ever looks up: from here on it is a
    /// vtable call, never a name lookup.
    host_component: Option<Box<dyn crate::host_component::HostObject>>,
    /// The registry index the host component was created from, for the
    /// declaration (container, native surface) the node needs while rendering.
    host_index: i32,
    /// Whether the host component is a container: core paints its React children
    /// between its chrome and its overlay.
    host_container: bool,
    /// The intrinsic size this node's host component last reported. Exposed to
    /// the test driver and to diagnostics; Yoga has the authoritative copy, in
    /// the shadow node's state.
    intrinsic_size: Option<(f32, f32)>,
    /// The store's report queue, shared by every node. A method's context writes
    /// here; the store is the one place that applies what is written.
    host_reports: crate::store::HostReportQueue,
    /// Where this node's surface is in its window. Zero for a window's own root
    /// surface; a `ReactSurface` placed by GPUI writes its box here.
    surface_origin: crate::surface::SurfaceOrigin,
    pub frame: RectF,
    pub(crate) parent_tag_cache: std::rc::Rc<std::cell::Cell<Option<i32>>>,
    pub view: ViewPropsFlat,
    animated_transform: Option<[f32; 16]>,
    animated_background_color: Option<u32>,
    animated_text_color: Option<u32>,
    pub paragraph: Option<ParagraphFlat>,
    pub input_text: String,
    pub input_placeholder: String,
    pub(crate) input_placeholder_mode: bool,
    pub(crate) input_text_color: u32,
    pub(crate) input_selection_color: u32,
    pub input_multiline: bool,
    pub input_editable: bool,
    pub(crate) input_secure_text: bool,
    pub input_selection: std::ops::Range<usize>,
    pub(crate) input_scroll_x: f32,
    pub(crate) input_selection_anchor: Option<usize>,
    pub input_marked: Option<std::ops::Range<usize>>,
    pub input_event_count: i32,
    pub(crate) caret_visible: bool,
    pub(crate) caret_blink_task: Task<()>,
    pub(crate) transition: Option<(crate::extensions::Transition, Instant)>,
    pub(crate) transition_forward: bool,
    transition_progress_sent: Option<(Instant, f32)>,
    transition_end_refreshed: Option<Instant>,
    /// Outside the entity so a scroll can move it without updating this view:
    /// gpui-fast rebuilds every view that read an updated entity.
    scroll_position: Rc<Cell<Point<f32>>>,
    pub(crate) scroll: Option<crate::extensions::ScrollSpec>,
    scroll_indicator: Option<Entity<crate::scroll_indicator::ScrollIndicator>>,
    scroll_sync_generation: Rc<Cell<u64>>,
    scroll_handle: gpui::ScrollHandle,
    scroll_handle_stale: bool,
    pub focusable: bool,
    pub(crate) pending_text_input_focus: Option<bool>,
    pub children: Vec<(i32, Entity<RNNodeView>)>,
    pub parent: Option<WeakEntity<RNNodeView>>,
    cached_style: StyleRefinement,
    pub(crate) renderer_frame: Option<RectF>,
    pub(crate) renderer_decoration: Option<crate::extensions::Decoration>,
    pub(crate) inherited: Inherited,
    pub(crate) focus_handle: Option<FocusHandle>,
    pub(crate) focus_subscriptions: Vec<Subscription>,
}

static A11Y_TREE_DUMP_SCHEDULED: AtomicBool = AtomicBool::new(false);
static A11Y_TREE_DUMP_COMPLETE: AtomicBool = AtomicBool::new(false);
#[cfg(all(target_os = "macos", feature = "visual-capture"))]
static A11Y_TREE_DUMP_ATTEMPTS: AtomicUsize = AtomicUsize::new(0);

/// The DOM view of the modifiers held during an event.
fn modifier_state(modifiers: gpui::Modifiers) -> crate::events::ModifierState {
    crate::events::ModifierState::from_gpui(&modifiers)
}

/// Which `ComponentRenderer` hook to run for a button press or release.
#[derive(Clone, Copy)]
enum ComponentHook {
    Down,
    Up,
}

/// Runs a component renderer's mouse hook for one event.
///
/// The node and the renderer are resolved here rather than captured, because a
/// component can be re-rendered between the event and the hook: a captured
/// `ComponentNode` would describe the tree as it was when the listener was built.
#[allow(clippy::too_many_arguments)]
fn run_component_hook(
    node: &gpui::WeakEntity<RNNodeView>,
    captured: &crate::extensions::ComponentNode,
    window: &mut gpui::Window,
    cx: &mut gpui::App,
    position: gpui::Point<gpui::Pixels>,
    button: crate::events::Button,
    click_count: usize,
    modifiers: gpui::Modifiers,
    hook: ComponentHook,
) {
    let Some(node) = node.upgrade() else {
        return;
    };
    let component = node.read(cx).component.clone();
    let Some(renderer) = crate::extensions::component_renderer(&component) else {
        return;
    };
    let frame = captured.frame;
    let local = gpui::point(
        position.x - gpui::px(frame.x),
        position.y - gpui::px(frame.y),
    );
    let event = crate::extensions::input::MouseEvent {
        position,
        local,
        button,
        buttons: button.mask(),
        click_count,
        modifiers: modifier_state(modifiers),
    };
    let mut context = crate::extensions::input::InputContext {
        node: captured,
        window,
        cx,
        captured: false,
    };
    let propagation = match hook {
        ComponentHook::Down => renderer.on_mouse_down(captured, &event, &mut context),
        ComponentHook::Up => renderer.on_mouse_up(captured, &event, &mut context),
    };
    if propagation == crate::extensions::input::Propagation::Stop {
        context.cx.stop_propagation();
    }
}

/// Handles a right press: reports the pointer event, then opens the nearest
/// context menu.
///
/// One press, one node. The pointer event goes to the innermost target so RN
/// bubbles it through the JS tree; the menu goes to the nearest ancestor-or-self
/// that owns one, found by an explicit walk rather than by GPUI's bubbling. That
/// walk is what lets a `Text` inside an `onContextMenu` view still open the
/// parent's menu.
fn dispatch_right_press(
    node: &gpui::WeakEntity<RNNodeView>,
    event: &MouseDownEvent,
    window: &mut gpui::Window,
    cx: &mut gpui::App,
) {
    let Some(entity) = node.upgrade() else {
        return;
    };
    let (owner, target) = {
        let this = entity.read(cx);
        (
            crate::events::context_menu_owner(cx, this),
            crate::events::target(cx, this),
        )
    };
    if let Some(target) = target.as_ref() {
        crate::events::send_pointer(
            window,
            cx,
            target,
            event.position,
            crate::events::Phase::Start,
            Some(crate::events::Button::Right),
            crate::events::Button::Right.mask(),
            modifier_state(event.modifiers),
        );
    }
    let modifiers = modifier_state(event.modifiers);
    if crate::events::mouse_context_menu_trigger(
        crate::events::Button::Right,
        modifiers,
        std::env::consts::OS,
    )
    .is_some()
    {
        if let Some(owner) = owner {
            // A component that asked for context menus owns the press and renders
            // its own; a `View` with the prop dispatches to JS. The hook has to be
            // preferred, or a `ContextMenuView` would both open natively and tell
            // JS about a press it already handled.
            if !run_component_context_menu(&owner, event.position, false, modifiers, window, cx) {
                dispatch_context_menu(
                    owner.tag,
                    event.position,
                    crate::events::Button::Right,
                    modifiers,
                    "mouse",
                    window,
                    cx,
                );
            }
        }
    }
    cx.stop_propagation();
}

/// Runs a component's `on_context_menu` hook, if the owner is a component.
///
/// Returns whether the hook handled the press. `false` means the owner is a plain
/// `View` with `onContextMenu`, which the caller dispatches to JS instead.
fn run_component_context_menu(
    owner: &crate::events::ContextMenuOwner,
    position: gpui::Point<gpui::Pixels>,
    is_keyboard: bool,
    modifiers: crate::events::ModifierState,
    window: &mut gpui::Window,
    cx: &mut gpui::App,
) -> bool {
    let Some(entity) = owner.entity.clone() else {
        return false;
    };
    let Some(node) = entity.upgrade() else {
        return false;
    };
    let component = node.read(cx).component.clone();
    let Some(renderer) = crate::extensions::component_renderer(&component) else {
        return false;
    };
    let component_node = {
        let this = node.read(cx);
        this.component_node(cx)
    };
    if !renderer.input(&component_node).context_menu {
        return false;
    }
    let local = gpui::point(
        position.x - gpui::px(component_node.frame.x),
        position.y - gpui::px(component_node.frame.y),
    );
    let trigger = crate::extensions::input::ContextMenuTrigger {
        source: if is_keyboard {
            crate::events::ContextMenuTriggerSource::Keyboard
        } else {
            crate::events::ContextMenuTriggerSource::Mouse
        },
        position,
        local,
        button: crate::events::Button::Right,
        modifiers,
    };
    let mut context = crate::extensions::input::InputContext {
        node: &component_node,
        window,
        cx,
        captured: false,
    };
    let propagation = renderer.on_context_menu(&component_node, &trigger, &mut context);
    if propagation == crate::extensions::input::Propagation::Stop {
        context.cx.stop_propagation();
    }
    true
}

/// Sends the DOM pointer events for one non-primary button press.
///
/// Shared by the middle and right listeners so the two cannot diverge; the
/// button's mask is the only thing that differs.
fn dispatch_pointer_button(
    node: &gpui::WeakEntity<RNNodeView>,
    event: &MouseDownEvent,
    button: crate::events::Button,
    window: &mut gpui::Window,
    cx: &mut gpui::App,
) {
    let Some(node) = node.upgrade() else {
        return;
    };
    let target = {
        let this = node.read(cx);
        crate::events::target(cx, this)
    };
    let Some(target) = target else {
        return;
    };
    crate::events::send_pointer(
        window,
        cx,
        &target,
        event.position,
        crate::events::Phase::Start,
        Some(button),
        button.mask(),
        modifier_state(event.modifiers),
    );
    cx.stop_propagation();
}

/// Dispatches `topContextMenu` for a press, once `events` says it is a trigger.
///
/// `is_left` distinguishes the Ctrl + click case from the right click so the same
/// listener body serves both; the trigger rule itself is in
/// `events::mouse_context_menu_trigger`, so this and the extension hooks cannot
/// disagree.
fn dispatch_context_menu(
    tag: i32,
    position: gpui::Point<gpui::Pixels>,
    button: crate::events::Button,
    modifiers: crate::events::ModifierState,
    trigger: &str,
    window: &mut gpui::Window,
    cx: &mut gpui::App,
) {
    let x = f32::from(position.x);
    let y = f32::from(position.y);
    // The window is resolved from the window the press arrived in, not from the
    // pressed node's surface id: the owner may be several levels up and its
    // surface is the same one either way.
    let window_id = crate::desktop::windows::window_key_for_handle(cx, window.window_handle())
        .unwrap_or(crate::desktop::windows::MAIN_WINDOW_KEY);
    if let Some(store) = cx.try_global::<crate::store::StoreGlobal>() {
        let store = store.0.read(cx);
        store.host.dispatch_event(
            tag,
            "topContextMenu",
            &serde_json::json!({
                "x": x,
                "y": y,
                "pageX": x,
                "pageY": y,
                "windowId": window_id,
                "button": button.number(),
                "ctrlKey": modifiers.ctrl,
                "shiftKey": modifiers.shift,
                "altKey": modifiers.alt,
                "metaKey": modifiers.meta,
                "trigger": trigger,
            }),
        );
        store.frame_hook.arm(window);
    }
}

/// Whether a newly created node's own content is composited by the OS.
fn renders_native_surface_for_op(op: &MountOp) -> bool {
    if op.component == "NativeViewHost" {
        return !op.native_view_name.is_empty();
    }
    if op.host_index >= 0 && crate::host_component::renders_native_surface(op.host_index as u32) {
        return true;
    }
    crate::extensions::any_component_renderers()
        && crate::extensions::component_renders_native_surface(&op.component)
}

impl RNNodeView {
    pub(crate) fn accessibility_focus_handle(&self) -> Option<FocusHandle> {
        self.focus_handle.clone()
    }

    pub(crate) fn set_accessibility_tab_stop_allowed(&mut self, allowed: bool) {
        if let Some(handle) = self.focus_handle.take() {
            self.focus_handle = Some(handle.tab_stop(
                allowed
                    && (self.focusable || self.view.accessibility_has_escape_listener)
                    && !self.view.accessibility_disabled
                    && self.view.accessibility_responds_to_interaction
                    && !self.view.accessibility_hidden
                    && self.view.accessibility_important != 3
                    && !self.view.display_none,
            ));
        }
    }
    pub(crate) fn focus_for_accessibility(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(handle) = self.focus_handle.as_ref() {
            handle.focus(window, cx);
            log::info!(
                "[accessibility] focused tag {} from native request",
                self.tag
            );
        } else {
            log::warn!(
                "[accessibility] cannot focus tag {} because it has no focus handle",
                self.tag
            );
        }
    }

    pub fn apply_text_input_focus_command(
        &mut self,
        focus: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.component != "TextInput" {
            return;
        }
        if focus && !self.input_editable {
            return;
        }
        let Some(handle) = self.focus_handle.as_ref().cloned() else {
            // Fabric can deliver autoFocus immediately after mount, before
            // GPUI's first render has created the entity's FocusHandle.
            self.pending_text_input_focus = Some(focus);
            cx.notify();
            return;
        };
        if focus {
            handle.focus(window, cx);
        } else if handle.is_focused(window) {
            window.blur(cx);
        }
    }

    pub fn set_animated_opacity(&mut self, opacity: f32) {
        self.view.opacity = opacity.clamp(0.0, 1.0);
        self.cached_style = style::to_refinement(&self.view);
    }

    pub fn set_animated_transform(&mut self, transform: Option<[f32; 16]>) {
        self.animated_transform = transform;
    }

    pub fn set_animated_background_color(&mut self, color: u32) {
        self.animated_background_color = Some(color);
    }

    pub fn set_animated_text_color(&mut self, color: u32) {
        self.animated_text_color = Some(color);
    }

    fn start_caret_blink(&mut self, cx: &mut Context<Self>) {
        if self.component != "TextInput" {
            return;
        }
        self.caret_visible = true;
        self.caret_blink_task = cx.spawn(async move |this, cx| loop {
            cx.background_executor()
                .timer(Duration::from_millis(530))
                .await;
            if this
                .update(cx, |view, cx| {
                    view.caret_visible = !view.caret_visible;
                    cx.notify();
                })
                .is_err()
            {
                break;
            }
        });
    }

    fn stop_caret_blink(&mut self) {
        self.caret_visible = false;
        self.caret_blink_task = Task::ready(());
    }

    pub(crate) fn reset_text_input_caret(&mut self, cx: &mut Context<Self>) {
        self.start_caret_blink(cx);
    }

    #[cfg(any(test, debug_assertions))]
    fn hidden_by_modal_sibling_walked(&self, cx: &App) -> bool {
        let mut child_tag = self.tag;
        let mut parent = self.parent.clone();
        while let Some(parent_entity) = parent.and_then(|parent| parent.upgrade()) {
            let parent_view = parent_entity.read(cx);
            if parent_view.children.iter().any(|(sibling_tag, sibling)| {
                *sibling_tag != child_tag && sibling.read(cx).view.accessibility_modal
            }) {
                return true;
            }
            child_tag = parent_view.tag;
            parent = parent_view.parent.clone();
        }
        false
    }

    #[cfg(any(test, debug_assertions))]
    fn hidden_by_hidden_ancestor_walked(&self, cx: &App) -> bool {
        let mut parent = self.parent.clone();
        while let Some(entity) = parent.and_then(|parent| parent.upgrade()) {
            let node = entity.read(cx);
            if node.view.accessibility_hidden
                || node.view.accessibility_important == 3
                || node.view.display_none
            {
                return true;
            }
            parent = node.parent.clone();
        }
        false
    }

    fn accessibility_escape_target(&self, cx: &App) -> Option<i32> {
        if self.view.accessibility_has_escape_listener {
            return Some(self.tag);
        }
        let mut parent = self.parent.clone();
        while let Some(entity) = parent.and_then(|parent| parent.upgrade()) {
            let node = entity.read(cx);
            if node.view.accessibility_has_escape_listener {
                return Some(node.tag);
            }
            parent = node.parent.clone();
        }
        None
    }

    #[cfg(any(test, debug_assertions))]
    fn hidden_by_accessible_ancestor_walked(&self, cx: &App) -> bool {
        if self.focusable || self.view.accessible {
            return false;
        }
        let mut parent = self.parent.clone();
        while let Some(parent_entity) = parent.and_then(|parent| parent.upgrade()) {
            let parent_view = parent_entity.read(cx);
            if parent_view.view.accessible {
                return true;
            }
            parent = parent_view.parent.clone();
        }
        false
    }

    #[cfg(any(test, debug_assertions))]
    fn hidden_by_hiding_ancestor_walked(&self, cx: &App) -> bool {
        let mut parent = self.parent.clone();
        while let Some(parent_entity) = parent.and_then(|parent| parent.upgrade()) {
            let parent_view = parent_entity.read(cx);
            if parent_view.inherited.hides_subtree_self {
                return true;
            }
            parent = parent_view.parent.clone();
        }
        false
    }

    fn accessible_group_text(&self, cx: &App) -> String {
        let Some(store) = cx.try_global::<crate::store::StoreGlobal>() else {
            return String::new();
        };
        fn collect(
            tag: i32,
            active_tag: i32,
            nodes: &HashMap<i32, Entity<RNNodeView>>,
            cx: &App,
            output: &mut String,
        ) {
            if tag == active_tag {
                return;
            }
            let Some(entity) = nodes.get(&tag) else {
                return;
            };
            let view = entity.read(cx);
            if view.component == "Paragraph" {
                if view.view.accessibility_hidden || view.view.accessibility_important == 3 {
                    return;
                }
                if let Some(paragraph) = &view.paragraph {
                    if !output.is_empty() {
                        output.push(' ');
                    }
                    for fragment in &paragraph.fragments {
                        output.push_str(&fragment.text);
                    }
                }
                return;
            }
            if view.view.accessible || view.focusable {
                return;
            }
            let children = view
                .children
                .iter()
                .map(|(tag, _)| *tag)
                .collect::<Vec<_>>();
            for child_tag in children {
                collect(child_tag, active_tag, nodes, cx, output);
            }
        }
        let store = store.0.read(cx);
        let mut text = String::new();
        let children = self
            .children
            .iter()
            .map(|(tag, _)| *tag)
            .collect::<Vec<_>>();
        for tag in children {
            collect(tag, self.tag, &store.nodes, cx, &mut text);
        }
        text
    }

    fn accessibility_labelled_by_text(&self, cx: &App) -> String {
        if self.view.accessibility_labelled_by.is_empty() {
            return String::new();
        }
        let Some(store) = cx.try_global::<crate::store::StoreGlobal>() else {
            return String::new();
        };
        let store = store.0.read(cx);
        fn collect(
            tag: i32,
            active_tag: i32,
            nodes: &HashMap<i32, Entity<RNNodeView>>,
            cx: &App,
            output: &mut String,
        ) {
            if tag == active_tag {
                return;
            }
            let Some(entity) = nodes.get(&tag) else {
                return;
            };
            let view = entity.read(cx);
            if !view.view.accessibility_label.is_empty() {
                output.push_str(&view.view.accessibility_label);
                return;
            }
            if view.component == "Paragraph" {
                if let Some(paragraph) = &view.paragraph {
                    for fragment in &paragraph.fragments {
                        output.push_str(&fragment.text);
                    }
                }
                return;
            }
            let children = view
                .children
                .iter()
                .map(|(tag, _)| *tag)
                .collect::<Vec<_>>();
            for child_tag in children {
                collect(child_tag, active_tag, nodes, cx, output);
            }
        }
        let mut labels = Vec::new();
        for native_id in &self.view.accessibility_labelled_by {
            let Some(tag) = store.nodes.iter().find_map(|(tag, entity)| {
                if *tag == self.tag {
                    return None;
                }
                let view = entity.read(cx);
                (view.view.accessibility_native_id == *native_id).then_some(*tag)
            }) else {
                continue;
            };
            let mut label = String::new();
            collect(tag, self.tag, &store.nodes, cx, &mut label);
            if !label.is_empty() {
                labels.push(label);
            }
        }
        labels.join(" ")
    }

    fn accessibility_role(&self) -> Option<Role> {
        // GPUI rejects `Role::GenericContainer` with a debug assertion, so
        // `importantForAccessibility="no"` exposes no role at all.
        if self.view.accessibility_important == 2 {
            return None;
        }
        if self.component == "Paragraph" && self.view.accessibility_role.is_empty() {
            return Some(Role::Label);
        }
        if self.component == "Image" && self.view.accessibility_role.is_empty() {
            return if self.view.accessible || !self.view.accessibility_label.is_empty() {
                Some(Role::Image)
            } else {
                None
            };
        }
        if self.component == "TextInput" && self.view.accessibility_role.is_empty() {
            return Some(if self.input_secure_text {
                Role::PasswordInput
            } else if self.input_multiline {
                Role::MultilineTextInput
            } else {
                Role::TextInput
            });
        }
        if self.view.accessibility_role.is_empty() {
            let traits = self.view.accessibility_traits;
            let trait_role = if traits & (1 << 0) != 0 {
                Some(Role::Button)
            } else if traits & (1 << 1) != 0 {
                Some(Role::Link)
            } else if traits & (1 << 2) != 0 {
                Some(Role::Image)
            } else if traits & (1 << 5) != 0 {
                Some(Role::Keyboard)
            } else if traits & (1 << 6) != 0 {
                Some(Role::Label)
            } else if traits & (1 << 7) != 0 {
                Some(Role::Note)
            } else if traits & (1 << 9) != 0 {
                Some(Role::Search)
            } else if traits & (1 << 12) != 0 {
                Some(Role::Slider)
            } else if traits & (1 << 15) != 0 {
                Some(Role::Heading)
            } else if traits & (1 << 16) != 0 {
                Some(Role::Switch)
            } else {
                None
            };
            if trait_role.is_some() {
                return trait_role;
            }
        }
        role_for_accessibility_role(&self.view.accessibility_role, self.view.accessible)
    }

    #[cfg(feature = "test-driver")]
    pub(crate) fn test_render_count(&self) -> u64 {
        self.render_count
    }

    pub(crate) fn nearest_focus_handle(&self, cx: &App) -> Option<FocusHandle> {
        if let Some(handle) = &self.focus_handle {
            return Some(handle.clone());
        }
        let mut parent = self.parent.clone();
        while let Some(node) = parent.and_then(|node| node.upgrade()) {
            let node = node.read(cx);
            if let Some(handle) = &node.focus_handle {
                return Some(handle.clone());
            }
            parent = node.parent.clone();
        }
        None
    }

    pub(crate) fn from_op(
        op: &MountOp,
        surface_id: i32,
        host_reports: crate::store::HostReportQueue,
    ) -> Self {
        let renders_native_surface = renders_native_surface_for_op(op);
        // `core-private:` TextInput reads its own props out of the module JSON.
        let text_input =
            crate::builtins::textinput::input::TextInputProps::from_json(&op.extension_props_json);
        // `core-private:` a scrolling component's starting offset comes from the
        let scroll_initial = crate::extensions::component_scroll(
            &op.component,
            &crate::extensions::parse_extension_props(&op.extension_props_json),
        )
        .map(|scroll| scroll.offset)
        .unwrap_or((0.0, 0.0));
        let (host_component, host_container) = Self::create_host_component(op, &host_reports);
        let mut view = Self {
            tag: op.tag,
            render_count: 0,
            hovered: false,
            surface_id,
            component: op.component.clone(),
            native_view_name: op.native_view_name.clone(),
            native_view_props: op.native_view_props.clone(),
            extension_props_json: op.extension_props_json.clone(),
            extension_props: std::sync::Arc::new(crate::extensions::parse_extension_props(
                &op.extension_props_json,
            )),
            native_view_host: None,
            renders_native_surface,
            native_surface_descendants: u32::from(renders_native_surface),
            native_surface_counted: false,
            host_component,
            host_index: op.host_index,
            host_container,
            intrinsic_size: None,
            host_reports,
            surface_origin: crate::surface::SurfaceOrigin::default(),
            frame: if crate::extensions::component_portal(
                &op.component,
                &crate::extensions::parse_extension_props(&op.extension_props_json),
            )
            .is_some()
            {
                rn_gpui_sys::ffi::RectF {
                    x: 0.0,
                    y: 0.0,
                    ..op.frame
                }
            } else {
                op.frame
            },
            parent_tag_cache: std::rc::Rc::new(std::cell::Cell::new(None)),
            view: op.view.clone(),
            animated_transform: None,
            animated_background_color: None,
            animated_text_color: None,
            paragraph: op.has_paragraph.then(|| op.paragraph.clone()),
            // `core-private:` the text-input fields come from the module's own
            input_text: text_input.text.clone(),
            input_placeholder: text_input.placeholder.clone(),
            input_placeholder_mode: text_input.text.is_empty(),
            input_selection_color: text_input.selection_color,
            input_text_color: op
                .paragraph
                .fragments
                .first()
                .map(|fragment| fragment.color)
                .filter(|color| *color != 0)
                .unwrap_or(0xff000000),
            input_multiline: text_input.multiline,
            input_editable: text_input.editable,
            input_secure_text: text_input.secure,
            input_selection: 0..0,
            input_scroll_x: 0.0,
            input_selection_anchor: None,
            input_marked: None,
            input_event_count: 0,
            caret_visible: false,
            caret_blink_task: Task::ready(()),
            transition: None,
            transition_forward: false,
            transition_progress_sent: None,
            transition_end_refreshed: None,
            // `core-private:` a scroll view starts at the offset the module's
            scroll_position: Rc::new(Cell::new(point(scroll_initial.0, scroll_initial.1))),
            scroll: crate::extensions::component_scroll(
                &op.component,
                &crate::extensions::parse_extension_props(&op.extension_props_json),
            ),
            scroll_indicator: None,
            scroll_sync_generation: Rc::new(Cell::new(0)),
            scroll_handle: gpui::ScrollHandle::new(),
            scroll_handle_stale: true,
            focusable: op.view.focusable || op.component == "TextInput",
            pending_text_input_focus: None,
            children: Vec::new(),
            parent: None,
            cached_style: StyleRefinement::default(),
            renderer_frame: None,
            renderer_decoration: None,
            inherited: Inherited::default(),
            focus_handle: None,
            focus_subscriptions: Vec::new(),
        };
        if view.component == "TextInput" {
            view.input_selection = crate::builtins::textinput::input::reconcile_selection(
                &view.input_text,
                0..0,
                text_input.selection,
                true,
            );
            view.sync_input_paragraph();
        }
        view.cached_style = style::to_refinement(&view.view);
        view
    }

    pub fn update_from_op(&mut self, op: &MountOp) {
        if self.native_view_name != op.native_view_name
            || self.native_view_props != op.native_view_props
        {
            self.native_view_name.clone_from(&op.native_view_name);
            self.native_view_props.clone_from(&op.native_view_props);
            self.native_view_host = None;
        }
        if self.component == "NativeViewHost" {
            let renders = !self.native_view_name.is_empty();
            if renders != self.renders_native_surface {
                self.renders_native_surface = renders;
                self.native_surface_descendants = self
                    .native_surface_descendants
                    .saturating_add_signed(if renders { 1 } else { -1 });
            }
        }
        self.frame = if crate::extensions::component_portal(
            &op.component,
            &crate::extensions::parse_extension_props(&op.extension_props_json),
        )
        .is_some()
        {
            rn_gpui_sys::ffi::RectF {
                x: 0.0,
                y: 0.0,
                ..op.frame
            }
        } else {
            op.frame
        };
        if op.props_changed {
            self.view = op.view.clone();
            self.focusable = op.view.focusable || self.component == "TextInput";
            if !self.focusable {
                self.focus_handle = None;
                self.focus_subscriptions.clear();
            }
            self.cached_style = style::to_refinement(&self.view);
            if self.component == "TextInput" {
                crate::builtins::textinput::input::apply_update(self, op);
            }
        }
        if op.has_paragraph {
            self.paragraph = Some(op.paragraph.clone());
            if let Some(fragment) = op.paragraph.fragments.first() {
                if fragment.color != 0 && !self.input_placeholder_mode {
                    self.input_text_color = fragment.color;
                }
            }
        }
        if self.component == "TextInput" {
            self.sync_input_paragraph();
        }
        if let Some(next) = crate::extensions::component_scroll(
            &op.component,
            &crate::extensions::parse_extension_props(&op.extension_props_json),
        ) {
            if let Some(previous) = &mut self.scroll {
                previous.content_size = next.content_size;
                previous.horizontal = next.horizontal;
                previous.enabled = next.enabled;
                previous.indicator = next.indicator;
            } else {
                self.scroll = Some(next);
            }
            self.scroll_handle_stale = true;
        }
        self.update_host_component(op);
        if op.props_changed {
            self.extension_props_json
                .clone_from(&op.extension_props_json);
            self.extension_props = std::sync::Arc::new(crate::extensions::parse_extension_props(
                &self.extension_props_json,
            ));
        }
    }

    /// Creates the host component an op names by registry index, if it names
    /// one. Returns it with whether it is a container.
    fn create_host_component(
        op: &MountOp,
        host_reports: &crate::store::HostReportQueue,
    ) -> (Option<Box<dyn crate::host_component::HostObject>>, bool) {
        // SAFETY: C++ made these handles for this op and gave them to Rust; this
        let (props, emitter) = unsafe { Self::claim_host_handles(op) };
        let Some(entry) = (op.host_index >= 0)
            .then(|| crate::host_component::entry(op.host_index as u32))
            .flatten()
        else {
            return (None, false);
        };
        let (Some(props), Some(emitter)) = (props, emitter) else {
            if entry.is_registered() {
                log::error!(
                    "[host-component] {} (tag {}) was created without its props or emitter",
                    entry.name,
                    op.tag
                );
            }
            return (None, entry.options.container);
        };
        let cx = crate::host_component::HostContext::queued(op.tag, host_reports.clone());
        let object = entry.create(props, emitter, cx);
        if object.is_none() {
            log::error!(
                "[host-component] {} is declared but no package registered it; the node renders nothing",
                entry.name
            );
        }
        (object, entry.options.container)
    }

    /// Takes ownership of the handles an op carried, so they are released when
    /// the result drops.
    ///
    /// # Safety
    ///
    /// The handles must have been made by C++ for this op and not claimed before.
    unsafe fn claim_host_handles(
        op: &MountOp,
    ) -> (
        Option<crate::host_component::PropsHandle>,
        Option<crate::host_component::EmitterHandle>,
    ) {
        let props = (op.host_props_handle != 0)
            .then(|| crate::host_component::PropsHandle::from_raw(op.host_props_handle));
        let emitter = (op.host_emitter_handle != 0)
            .then(|| crate::host_component::EmitterHandle::from_raw(op.host_emitter_handle));
        (props, emitter)
    }

    /// Hands the component its new props, when C++ found its own props changed.
    fn update_host_component(&mut self, op: &MountOp) {
        if op.host_props_handle == 0 {
            return;
        }
        // SAFETY: as in `create_host_component`; an `Update` op's props handle is
        let props = unsafe { crate::host_component::PropsHandle::from_raw(op.host_props_handle) };
        let Some(component) = self.host_component.as_mut() else {
            return;
        };
        let mut changed = Vec::with_capacity(1 + op.host_changed_more.len());
        changed.push(op.host_changed);
        changed.extend_from_slice(&op.host_changed_more);
        let cx = crate::host_component::HostContext::queued(self.tag, self.host_reports.clone());
        crate::counters::bump(crate::counters::Counter::HostUpdateCalls);
        component.update(props, &changed, cx);
    }

    pub(crate) fn set_parent(&mut self, parent: Option<WeakEntity<RNNodeView>>, tag: Option<i32>) {
        self.parent = parent;
        self.parent_tag_cache.set(tag);
    }

    pub fn insert_child(&mut self, index: usize, tag: i32, child: Entity<RNNodeView>) {
        let index = index.min(self.children.len());
        self.children.insert(index, (tag, child));
    }

    pub fn remove_child(&mut self, tag: i32) {
        self.children.retain(|(child_tag, _)| *child_tag != tag);
    }

    /// Whether any node in this subtree, this one included, renders a native
    /// surface.
    pub(crate) fn subtree_renders_native_surface(&self) -> bool {
        self.native_surface_descendants > 0
    }

    /// Claims this node's contribution, so a second `Remove` or a `Delete`
    /// after a `Remove` subtracts nothing.
    pub(crate) fn take_native_surface_contribution(&mut self) -> u32 {
        if !self.native_surface_counted {
            return 0;
        }
        self.native_surface_counted = false;
        self.native_surface_descendants
    }

    /// Records that this node's contribution is now part of its ancestors'
    /// counts.
    pub(crate) fn mark_native_surface_counted(&mut self) {
        self.native_surface_counted = true;
    }

    /// Adds `delta` to this subtree's count.
    /// Adds `delta` to this subtree's count.
    pub(crate) fn add_native_surface_descendants(&mut self, delta: u32) -> bool {
        let before = self.native_surface_descendants;
        self.native_surface_descendants = before.saturating_add(delta);
        before == 0 && self.native_surface_descendants != 0
    }

    /// Removes `delta` from this subtree's count.
    pub(crate) fn sub_native_surface_descendants(&mut self, delta: u32) -> bool {
        let before = self.native_surface_descendants;
        self.native_surface_descendants = before.saturating_sub(delta);
        before != 0 && self.native_surface_descendants == 0
    }

    fn local_transform(&self) -> (f32, f32, f32, f32) {
        if self.animated_transform.is_none() && !self.view.has_transform {
            return (1.0, 1.0, 0.0, 0.0);
        }
        let m = self.animated_transform.unwrap_or(self.view.transform);
        let (scale_x, scale_y, translate_x, translate_y) = axis_aligned_transform(&m);
        if has_unsupported_subtree_transform(&m) {
            log::trace!(
                "[transform] tag={} has rotation/skew/perspective; GPUI subtree transform spike is not supported",
                self.tag
            );
        }
        (scale_x, scale_y, translate_x, translate_y)
    }

    pub(crate) fn stable_paint_tree<'a>(&'a self, cx: &'a App) -> crate::extensions::TreeView<'a> {
        static NO_NODES: std::sync::OnceLock<HashMap<i32, crate::extensions::NodeSnapshot>> =
            std::sync::OnceLock::new();
        static NO_RETAINED: std::sync::OnceLock<HashMap<i32, Vec<i32>>> =
            std::sync::OnceLock::new();
        crate::extensions::TreeView {
            nodes: std::borrow::Cow::Borrowed(NO_NODES.get_or_init(HashMap::new)),
            root_tags: Vec::new(),
            top_inset: self.inherited.window_top_inset,
            animations_enabled: !cx.reduce_motion()
                && !crate::animation_policy::animations_disabled(),
            current: Some((self.tag, self.snapshot())),
            retained: NO_RETAINED.get_or_init(HashMap::new),
        }
    }

    fn origin_frame(&self, cx: &App) -> (f32, f32) {
        let stable = self.stable_paint_tree(cx);
        self.origin_frame_with_tree(&stable)
    }

    /// `refresh_inherited` runs while `ViewStore` is being updated, so the inset
    /// is passed in instead of read back from the global.
    pub(crate) fn transition_state(&self) -> Option<crate::extensions::TransitionState> {
        let (transition, started_at) = self.transition?;
        Some(crate::extensions::TransitionState {
            transition,
            started_at,
            progress: transition.progress_now(started_at),
        })
    }

    pub(crate) fn transition_active(&self, cx: &App) -> bool {
        if cx.reduce_motion() || crate::animation_policy::animations_disabled() {
            return false;
        }
        self.transition
            .is_some_and(|(transition, started_at)| transition.progress_now(started_at) < 1.0)
    }

    pub(crate) fn decoration(&self, cx: &App) -> crate::extensions::Decoration {
        if let Some(decoration) = self.renderer_decoration {
            return decoration;
        }
        let Some(renderer) = crate::extensions::component_renderer(&self.component) else {
            return crate::extensions::Decoration::default();
        };
        let nodes = HashMap::default();
        let retained = HashMap::default();
        let tree = crate::extensions::TreeView {
            nodes: std::borrow::Cow::Borrowed(&nodes),
            root_tags: Vec::new(),
            top_inset: self.inherited.window_top_inset,
            animations_enabled: !cx.reduce_motion()
                && !crate::animation_policy::animations_disabled(),
            current: Some((self.tag, self.snapshot())),
            retained: &retained,
        };
        renderer.decorate(&self.component_node_shallow(), &tree)
    }

    pub(crate) fn layout_frame(&self, tree: &crate::extensions::TreeView) -> RectF {
        if let Some(frame) = self.renderer_frame {
            return frame;
        }
        crate::extensions::component_renderer(&self.component)
            .and_then(|renderer| renderer.layout_frame(&self.component_node_shallow(), tree))
            .unwrap_or(self.frame)
    }

    pub(crate) fn hides_subtree(&self, tree: &crate::extensions::TreeView) -> bool {
        crate::extensions::component_renderer(&self.component)
            .is_some_and(|renderer| renderer.hides_subtree(&self.component_node_shallow(), tree))
    }

    pub(crate) fn origin_frame_with_tree(&self, tree: &crate::extensions::TreeView) -> (f32, f32) {
        let frame = self.layout_frame(tree);
        (frame.x, frame.y)
    }

    pub(crate) fn inherit_input(&self, tree: &crate::extensions::TreeView) -> InheritInput {
        InheritInput {
            origin_frame: self.origin_frame_with_tree(tree),
            transform: self.local_transform(),
            border: (self.view.border_widths.left, self.view.border_widths.top),
            scroll: self.scroll.is_some().then(|| self.scroll_position.clone()),
            accessible: self.view.accessible,
            hides_descendants: self.view.accessibility_hidden
                || self.view.accessibility_important == 3
                || self.view.display_none,
            hides_subtree: self.hides_subtree(tree),
            other_modal_child: false,
            focusable_or_accessible: self.focusable || self.view.accessible,
            window_control: self.window_control_role(),
        }
    }

    pub fn absolute_origin(&self, _cx: &App) -> Point<Pixels> {
        let (mut x, mut y) = self.inherited.origin_unscrolled;
        for link in self.inherited.scrollers.iter() {
            let offset = link.position.get();
            x -= link.scale.0 * offset.x;
            y -= link.scale.1 * offset.y;
        }
        let (surface_x, surface_y) = self.surface_origin.get();
        point(px(x + surface_x), px(y + surface_y))
    }

    /// Whether GPUI placed this node's surface, so its frames are window
    /// coordinates.
    pub(crate) fn surface_is_placed(&self) -> bool {
        self.surface_origin.is_placed()
    }

    /// Shares `origin` with the other nodes of this node's surface.
    pub(crate) fn with_surface_origin(mut self, origin: crate::surface::SurfaceOrigin) -> Self {
        self.surface_origin = origin;
        self
    }

    #[cfg(any(test, debug_assertions))]
    pub fn absolute_origin_walked(&self, cx: &App) -> Point<Pixels> {
        let mut chain = vec![OriginStep {
            frame: self.origin_frame(cx),
            transform: self.local_transform(),
            scroll: (self.scroll_offset().x, self.scroll_offset().y),
            is_scroll: self.scroll.is_some(),
        }];
        let mut parent = self.parent.clone();
        while let Some(weak) = parent {
            let Some(node) = weak.upgrade() else { break };
            let node = node.read(cx);
            chain.push(OriginStep {
                frame: node.origin_frame(cx),
                transform: node.local_transform(),
                scroll: (node.scroll_offset().x, node.scroll_offset().y),
                is_scroll: node.scroll.is_some(),
            });
            parent = node.parent.clone();
        }
        chain.reverse();
        let (x, y) = accumulate_origin(&chain);
        let (surface_x, surface_y) = self.surface_origin.get();
        point(px(x + surface_x), px(y + surface_y))
    }

    pub(crate) fn cumulative_scale(&self, _cx: &App) -> (f32, f32) {
        (self.inherited.scale.0.abs(), self.inherited.scale.1.abs())
    }

    #[cfg(any(test, debug_assertions))]
    pub(crate) fn cumulative_scale_walked(&self, cx: &App) -> (f32, f32) {
        let mut sx = 1.0;
        let mut sy = 1.0;
        let mut parent = self.parent.clone();
        let mut chain = Vec::new();
        while let Some(weak) = parent {
            let Some(node) = weak.upgrade() else { break };
            let node = node.read(cx);
            chain.push(node.local_transform());
            parent = node.parent.clone();
        }
        chain.reverse();
        chain.push(self.local_transform());
        for (local_sx, local_sy, _, _) in chain {
            sx *= local_sx;
            sy *= local_sy;
        }
        (sx.abs(), sy.abs())
    }

    /// `RN_GPUI_VERIFY_INHERITED=1`: checks the cached `Inherited` against the
    /// walking versions.
    #[cfg(debug_assertions)]
    fn verify_inherited(&self, cx: &App) {
        let walked = self.absolute_origin_walked(cx);
        let cached = self.absolute_origin(cx);
        for (field, walked, cached) in [
            ("origin.x", f32::from(walked.x), f32::from(cached.x)),
            ("origin.y", f32::from(walked.y), f32::from(cached.y)),
        ] {
            if (walked - cached).abs() > 0.01 {
                log::error!(
                    "[inherited] mismatch tag={} field={field} cached={cached} walked={walked}",
                    self.tag
                );
            }
        }
        let (walked_scale_x, walked_scale_y) = self.cumulative_scale_walked(cx);
        let (cached_scale_x, cached_scale_y) = self.cumulative_scale(cx);
        for (field, walked, cached) in [
            ("scale.x", walked_scale_x, cached_scale_x),
            ("scale.y", walked_scale_y, cached_scale_y),
            (
                "hidden_by_accessible_ancestor",
                f32::from(self.hidden_by_accessible_ancestor_walked(cx)),
                f32::from(self.inherited.hidden_by_accessible_ancestor),
            ),
            (
                "hidden_by_hidden_ancestor",
                f32::from(self.hidden_by_hidden_ancestor_walked(cx)),
                f32::from(self.inherited.hidden_by_hidden_ancestor),
            ),
            (
                "hidden_by_modal_sibling",
                f32::from(self.hidden_by_modal_sibling_walked(cx)),
                f32::from(self.inherited.hidden_by_modal_sibling),
            ),
            (
                "hidden_by_hiding_ancestor",
                f32::from(self.hidden_by_hiding_ancestor_walked(cx)),
                f32::from(self.inherited.hidden_by_hiding_ancestor),
            ),
        ] {
            if (walked - cached).abs() > 0.01 {
                log::error!(
                    "[inherited] mismatch tag={} field={field} cached={cached} walked={walked}",
                    self.tag
                );
            }
        }
    }
}

#[cfg(debug_assertions)]
fn verify_inherited_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var_os("RN_GPUI_VERIFY_INHERITED").is_some())
}

fn role_for_accessibility_role(role: &str, accessible: bool) -> Option<Role> {
    Some(match role {
        "none" | "presentation" => return None,
        "button" | "imagebutton" | "togglebutton" => Role::Button,
        "image" | "img" => Role::Image,
        "link" => Role::Link,
        "header" | "heading" => Role::Heading,
        "adjustable" => Role::Slider,
        "dropdownlist" | "combobox" => Role::ComboBox,
        "keyboardkey" => Role::Keyboard,
        "checkbox" => Role::CheckBox,
        "radio" => Role::RadioButton,
        "radiogroup" => Role::RadioGroup,
        "switch" => Role::Switch,
        "search" => Role::SearchInput,
        // AccessKit maps Label to the platform's static-text role; TextInput
        // would incorrectly announce read-only RN text as an editable field.
        "text" => Role::Label,
        "summary" => Role::Note,
        "toolbar" => Role::Toolbar,
        "menu" | "iconmenu" => Role::Menu,
        "menubar" => Role::MenuBar,
        "menuitem" => Role::MenuItem,
        "progressbar" => Role::ProgressIndicator,
        "scrollbar" => Role::ScrollBar,
        "tab" => Role::Tab,
        "tabbar" => Role::TabPanel,
        "tablist" => Role::TabList,
        "timer" => Role::Timer,
        "alert" => Role::Alert,
        "dialog" => Role::Dialog,
        "alertdialog" => Role::AlertDialog,
        "application" => Role::Application,
        "article" => Role::Article,
        "banner" => Role::Banner,
        "complementary" => Role::Complementary,
        "contentinfo" => Role::ContentInfo,
        "definition" => Role::Definition,
        "directory" => Role::List,
        "feed" => Role::Feed,
        "figure" => Role::Figure,
        "form" => Role::Form,
        "log" => Role::Log,
        "main" => Role::Main,
        "marquee" => Role::Marquee,
        "math" => Role::Math,
        "meter" => Role::Meter,
        "navigation" => Role::Navigation,
        "option" => Role::ListBoxOption,
        "region" => Role::Region,
        "rowgroup" => Role::RowGroup,
        "rowheader" => Role::RowHeader,
        "columnheader" => Role::ColumnHeader,
        "searchbox" => Role::SearchInput,
        "separator" => Role::Splitter,
        "status" => Role::Status,
        "tabpanel" => Role::TabPanel,
        "term" => Role::Term,
        "tooltip" => Role::Tooltip,
        "tree" => Role::Tree,
        "treegrid" => Role::TreeGrid,
        "treeitem" => Role::TreeItem,
        "textbox" => Role::TextInput,
        "generic" | "group" => Role::Group,
        "list" => Role::List,
        "listitem" => Role::ListItem,
        "grid" => Role::Grid,
        "row" => Role::Row,
        "cell" => Role::Cell,
        "table" => Role::Table,
        "paragraph" => Role::Paragraph,
        "label" => Role::Label,
        "pager" | "scrollview" | "horizontalscrollview" => Role::ScrollView,
        "viewgroup" | "slidingdrawer" => Role::Group,
        "drawerlayout" => Role::Pane,
        "webview" => Role::WebView,
        "spinbutton" => Role::SpinButton,
        _ if !role.is_empty() || accessible => Role::Group,
        _ => return None,
    })
}

fn accessibility_action_for_name(name: &str) -> Option<gpui::AccessibleAction> {
    Some(match name {
        "activate" => gpui::AccessibleAction::Click,
        "increment" => gpui::AccessibleAction::Increment,
        "decrement" => gpui::AccessibleAction::Decrement,
        "longpress" => gpui::AccessibleAction::ShowContextMenu,
        "expand" => gpui::AccessibleAction::Expand,
        "collapse" => gpui::AccessibleAction::Collapse,
        _ => return None,
    })
}

fn dispatch_accessibility_event(
    tag: i32,
    event: &str,
    payload: &serde_json::Value,
    window: &mut Window,
    cx: &mut App,
) {
    let Some(store) = cx.try_global::<crate::store::StoreGlobal>() else {
        return;
    };
    let (host, frame_hook) = {
        let store = store.0.read(cx);
        (store.host.clone(), store.frame_hook.clone())
    };
    host.dispatch_event(tag, event, payload);
    frame_hook.arm(window);
}

fn focus_adjacent_semantic_sibling(
    view: &RNNodeView,
    key: &str,
    window: &mut Window,
    cx: &mut App,
) -> bool {
    let Some(role @ (Role::RadioButton | Role::Tab)) = view.accessibility_role() else {
        return false;
    };
    let direction = match key {
        "left" | "up" => -1,
        "right" | "down" => 1,
        _ => return false,
    };
    let Some(parent) = view.parent.as_ref().and_then(WeakEntity::upgrade) else {
        return false;
    };
    let parent = parent.read(cx);
    let mut siblings = Vec::new();
    for (tag, entity) in &parent.children {
        if *tag == view.tag {
            if let Some(focus) = view.focus_handle.clone() {
                siblings.push((*tag, focus));
            }
            continue;
        }
        let sibling = entity.read(cx);
        if sibling.accessibility_role() == Some(role)
            && sibling.focusable
            && sibling.view.accessibility_responds_to_interaction
            && !sibling.view.accessibility_disabled
            && !sibling.view.accessibility_hidden
            && !sibling.view.display_none
        {
            if let Some(focus) = sibling.focus_handle.clone() {
                siblings.push((*tag, focus));
            }
        }
    }
    let Some(current_index) = siblings.iter().position(|(tag, _)| *tag == view.tag) else {
        return false;
    };
    if siblings.len() < 2 {
        return false;
    }
    let next_index = if direction > 0 {
        (current_index + 1) % siblings.len()
    } else {
        (current_index + siblings.len() - 1) % siblings.len()
    };
    let (tag, focus_handle) = &siblings[next_index];
    let tag = *tag;
    let focus_handle = focus_handle.clone();
    window.on_next_frame(move |window, cx| {
        focus_handle.focus(window, cx);
        dispatch_accessibility_event(tag, "click", &serde_json::json!({}), window, cx);
    });
    true
}

#[cfg(test)]
mod accessibility_role_tests {
    use super::role_for_accessibility_role;
    use gpui::Role;

    #[test]
    fn maps_react_native_087_roles_to_accesskit_roles() {
        for (rn_role, expected) in [
            ("button", Role::Button),
            ("dropdownlist", Role::ComboBox),
            ("togglebutton", Role::Button),
            ("link", Role::Link),
            ("search", Role::SearchInput),
            ("image", Role::Image),
            ("keyboardkey", Role::Keyboard),
            ("text", Role::Label),
            ("adjustable", Role::Slider),
            ("imagebutton", Role::Button),
            ("header", Role::Heading),
            ("summary", Role::Note),
            ("alert", Role::Alert),
            ("checkbox", Role::CheckBox),
            ("combobox", Role::ComboBox),
            ("menu", Role::Menu),
            ("menubar", Role::MenuBar),
            ("menuitem", Role::MenuItem),
            ("progressbar", Role::ProgressIndicator),
            ("radio", Role::RadioButton),
            ("radiogroup", Role::RadioGroup),
            ("scrollbar", Role::ScrollBar),
            ("spinbutton", Role::SpinButton),
            ("switch", Role::Switch),
            ("tab", Role::Tab),
            ("tabbar", Role::TabPanel),
            ("tablist", Role::TabList),
            ("timer", Role::Timer),
            ("list", Role::List),
            ("toolbar", Role::Toolbar),
            ("grid", Role::Grid),
            ("pager", Role::ScrollView),
            ("scrollview", Role::ScrollView),
            ("horizontalscrollview", Role::ScrollView),
            ("viewgroup", Role::Group),
            ("webview", Role::WebView),
            ("drawerlayout", Role::Pane),
            ("slidingdrawer", Role::Group),
            ("iconmenu", Role::Menu),
            ("listitem", Role::ListItem),
            ("row", Role::Row),
            ("cell", Role::Cell),
            ("table", Role::Table),
            ("paragraph", Role::Paragraph),
            ("label", Role::Label),
        ] {
            assert_eq!(
                role_for_accessibility_role(rn_role, false),
                Some(expected),
                "{rn_role}"
            );
        }
    }

    #[test]
    fn presentation_and_unknown_roles_keep_their_accessibility_semantics() {
        assert_eq!(role_for_accessibility_role("none", true), None);
        assert_eq!(role_for_accessibility_role("presentation", true), None);
        assert_eq!(
            role_for_accessibility_role("unknown", false),
            Some(Role::Group)
        );
        assert_eq!(
            role_for_accessibility_role("unknown", true),
            Some(Role::Group)
        );
    }
}

#[derive(Clone)]
pub(crate) struct ScrollLink {
    pub(crate) position: Rc<Cell<Point<f32>>>,
    pub(crate) scale: (f32, f32),
}

/// What a node does with a press, as far as the window's own controls go.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WindowControlRole {
    /// A drag region or a caption button: the press is the window's.
    Claims(gpui::WindowControlArea),
    /// A button, a text input, a scroll view: the press is the node's.
    TakesPress,
    /// Neither: the press belongs to whatever area contains the node.
    Passive,
}

#[derive(Clone)]
pub(crate) struct Inherited {
    /// The window-control area a passive node falls inside, from its nearest
    /// ancestor that either claims one or takes the press itself.
    pub(crate) window_control_area: Option<gpui::WindowControlArea>,
    pub(crate) window_top_inset: f32,
    pub(crate) hides_subtree_self: bool,
    pub(crate) parent_scale: (f32, f32),
    pub(crate) scale: (f32, f32),
    pub(crate) origin_unscrolled: (f32, f32),
    pub(crate) parent_border: (f32, f32),
    pub(crate) scrollers: Rc<[ScrollLink]>,
    pub(crate) accessible_ancestor: bool,
    pub(crate) hidden_by_accessible_ancestor: bool,
    pub(crate) hidden_by_hidden_ancestor: bool,
    pub(crate) hidden_by_modal_sibling: bool,
    pub(crate) hidden_by_hiding_ancestor: bool,
}

impl Default for Inherited {
    fn default() -> Self {
        Self {
            window_control_area: None,
            window_top_inset: 0.0,
            parent_scale: (1.0, 1.0),
            scale: (1.0, 1.0),
            origin_unscrolled: (0.0, 0.0),
            parent_border: (0.0, 0.0),
            scrollers: Rc::from(Vec::new()),
            accessible_ancestor: false,
            hidden_by_accessible_ancestor: false,
            hidden_by_hidden_ancestor: false,
            hidden_by_modal_sibling: false,
            hidden_by_hiding_ancestor: false,
            hides_subtree_self: false,
        }
    }
}

impl Inherited {
    pub(crate) fn same(&self, other: &Inherited) -> bool {
        self.same_render_affecting(other)
            && self.origin_unscrolled == other.origin_unscrolled
            && self.scrollers.len() == other.scrollers.len()
            && self
                .scrollers
                .iter()
                .zip(other.scrollers.iter())
                .all(|(left, right)| {
                    Rc::ptr_eq(&left.position, &right.position) && left.scale == right.scale
                })
    }

    pub(crate) fn same_render_affecting(&self, other: &Inherited) -> bool {
        self.window_control_area == other.window_control_area
            && self.parent_scale == other.parent_scale
            && self.scale == other.scale
            && self.parent_border == other.parent_border
            && self.accessible_ancestor == other.accessible_ancestor
            && self.hidden_by_accessible_ancestor == other.hidden_by_accessible_ancestor
            && self.hidden_by_hidden_ancestor == other.hidden_by_hidden_ancestor
            && self.hidden_by_modal_sibling == other.hidden_by_modal_sibling
            && self.hidden_by_hiding_ancestor == other.hidden_by_hiding_ancestor
    }
}

#[derive(Clone)]
pub(crate) struct InheritInput {
    pub(crate) origin_frame: (f32, f32),
    pub(crate) transform: (f32, f32, f32, f32),
    pub(crate) border: (f32, f32),
    pub(crate) scroll: Option<Rc<Cell<Point<f32>>>>,
    pub(crate) accessible: bool,
    pub(crate) hides_descendants: bool,
    pub(crate) hides_subtree: bool,
    pub(crate) other_modal_child: bool,
    pub(crate) focusable_or_accessible: bool,
    pub(crate) window_control: WindowControlRole,
}

pub(crate) fn inherit(
    parent: Option<(&Inherited, &InheritInput)>,
    own: &InheritInput,
) -> Inherited {
    let mut inherited = Inherited {
        parent_scale: parent.map_or((1.0, 1.0), |(parent, _)| parent.scale),
        ..Inherited::default()
    };
    match parent {
        Some((parent, input)) => {
            // This is `accumulate_origin` with the parent's scroll forced to
            // zero, so the offset stays a live value the input path subtracts.
            inherited.origin_unscrolled = (
                parent.origin_unscrolled.0
                    + inherited.parent_scale.0 * (own.origin_frame.0 + own.transform.2),
                parent.origin_unscrolled.1
                    + inherited.parent_scale.1 * (own.origin_frame.1 + own.transform.3),
            );
            inherited.parent_border = input.border;
            inherited.scrollers = match &input.scroll {
                Some(position) => {
                    let mut links = parent.scrollers.to_vec();
                    links.push(ScrollLink {
                        position: position.clone(),
                        scale: inherited.parent_scale,
                    });
                    Rc::from(links)
                }
                None => parent.scrollers.clone(),
            };
            inherited.accessible_ancestor = parent.accessible_ancestor || input.accessible;
            inherited.hidden_by_hidden_ancestor =
                parent.hidden_by_hidden_ancestor || input.hides_descendants;
            inherited.hidden_by_modal_sibling =
                parent.hidden_by_modal_sibling || input.other_modal_child;
            inherited.hidden_by_hiding_ancestor =
                parent.hidden_by_hiding_ancestor || input.hides_subtree;
            inherited.window_control_area = match input.window_control {
                WindowControlRole::Claims(area) => Some(area),
                WindowControlRole::TakesPress => None,
                WindowControlRole::Passive => parent.window_control_area,
            };
        }
        None => {
            inherited.origin_unscrolled = (
                own.origin_frame.0 + own.transform.2,
                own.origin_frame.1 + own.transform.3,
            );
        }
    }
    inherited.scale = (
        inherited.parent_scale.0 * own.transform.0,
        inherited.parent_scale.1 * own.transform.1,
    );
    inherited.hidden_by_accessible_ancestor =
        !own.focusable_or_accessible && inherited.accessible_ancestor;
    inherited
}

#[derive(Clone, Copy)]
struct OriginStep {
    frame: (f32, f32),
    transform: (f32, f32, f32, f32),
    scroll: (f32, f32),
    is_scroll: bool,
}

fn accumulate_origin(chain: &[OriginStep]) -> (f32, f32) {
    let (mut x, mut y, mut scale_x, mut scale_y) = (0.0f32, 0.0f32, 1.0f32, 1.0f32);
    let mut parent_scroll = (0.0f32, 0.0f32);
    for step in chain {
        let (local_scale_x, local_scale_y, translate_x, translate_y) = step.transform;
        x += scale_x * (step.frame.0 - parent_scroll.0 + translate_x);
        y += scale_y * (step.frame.1 - parent_scroll.1 + translate_y);
        scale_x *= local_scale_x;
        scale_y *= local_scale_y;
        parent_scroll = if step.is_scroll {
            step.scroll
        } else {
            (0.0, 0.0)
        };
    }
    (x, y)
}

fn axis_aligned_transform(matrix: &[f32; 16]) -> (f32, f32, f32, f32) {
    if matrix.iter().any(|value| !value.is_finite()) {
        return (1.0, 1.0, 0.0, 0.0);
    }
    (matrix[0], matrix[5], matrix[12], matrix[13])
}

fn has_unsupported_subtree_transform(matrix: &[f32; 16]) -> bool {
    matrix.iter().any(|value| !value.is_finite())
        || [
            matrix[1], matrix[2], matrix[3], matrix[4], matrix[6], matrix[7], matrix[8], matrix[9],
            matrix[11], matrix[14],
        ]
        .into_iter()
        .any(|value| value.abs() > 0.0001)
        || matrix[0] < 0.0
        || matrix[5] < 0.0
        || (matrix[10] - 1.0).abs() > 0.0001
        || (matrix[15] - 1.0).abs() > 0.0001
}

thread_local! {
    /// How many node copies a `TreeView` has taken, for the test that guards
    /// against copying the whole tree once per mount operation.
    #[cfg(test)]
    static SNAPSHOT_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Starts counting node copies from zero.
#[cfg(test)]
pub(crate) fn reset_snapshot_count() {
    SNAPSHOT_COUNT.with(|count| count.set(0));
}

/// How many node copies have been taken since the last reset.
#[cfg(test)]
pub(crate) fn snapshot_count() -> usize {
    SNAPSHOT_COUNT.with(|count| count.get())
}

#[cfg(test)]
mod transform_matrix_tests {
    use super::{
        accumulate_origin, axis_aligned_transform, has_unsupported_subtree_transform, OriginStep,
    };

    fn identity() -> [f32; 16] {
        [
            1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        ]
    }

    #[test]
    fn axis_aligned_matrix_keeps_translation_and_nonuniform_scale() {
        let mut matrix = identity();
        matrix[0] = 1.5;
        matrix[5] = 0.75;
        matrix[12] = 12.0;
        matrix[13] = -3.0;

        assert_eq!(axis_aligned_transform(&matrix), (1.5, 0.75, 12.0, -3.0));
        assert!(!has_unsupported_subtree_transform(&matrix));
    }

    #[test]
    fn rotation_is_flagged_for_the_documented_gpui_spike() {
        let mut matrix = identity();
        matrix[0] = 0.0;
        matrix[1] = 1.0;
        matrix[4] = -1.0;
        matrix[5] = 0.0;

        assert!(has_unsupported_subtree_transform(&matrix));
    }

    #[test]
    fn reflection_and_perspective_are_flagged() {
        let mut reflection = identity();
        reflection[0] = -1.0;
        assert!(has_unsupported_subtree_transform(&reflection));

        for perspective_index in [14, 15] {
            let mut perspective = identity();
            perspective[perspective_index] = if perspective_index == 15 { 0.5 } else { 0.01 };
            assert!(has_unsupported_subtree_transform(&perspective));
        }
    }

    #[test]
    fn nonfinite_transform_is_flagged() {
        let mut matrix = identity();
        matrix[12] = f32::NAN;
        assert!(has_unsupported_subtree_transform(&matrix));
        assert_eq!(axis_aligned_transform(&matrix), (1.0, 1.0, 0.0, 0.0));
    }

    #[test]
    fn nested_scaled_origins_apply_parent_scroll_and_translation() {
        let chain = [
            OriginStep {
                frame: (10.0, 20.0),
                transform: (2.0, 2.0, 3.0, 4.0),
                scroll: (5.0, 6.0),
                is_scroll: true,
            },
            OriginStep {
                frame: (30.0, 40.0),
                transform: (0.5, 0.5, 1.0, 2.0),
                scroll: (0.0, 0.0),
                is_scroll: false,
            },
        ];

        assert_eq!(accumulate_origin(&chain), (65.0, 96.0));
    }
}

#[cfg(test)]
mod inherited_tests {
    use super::{
        accumulate_origin, inherit, InheritInput, Inherited, OriginStep, WindowControlRole,
    };
    use gpui::point;
    use std::cell::Cell;
    use std::rc::Rc;

    fn node(
        origin_frame: (f32, f32),
        transform: (f32, f32, f32, f32),
        border: (f32, f32),
    ) -> InheritInput {
        InheritInput {
            origin_frame,
            transform,
            border,
            scroll: None,
            accessible: false,
            hides_descendants: false,
            hides_subtree: false,
            other_modal_child: false,
            focusable_or_accessible: false,
            window_control: WindowControlRole::Passive,
        }
    }

    fn with_role(role: WindowControlRole) -> InheritInput {
        InheritInput {
            window_control: role,
            ..plain()
        }
    }

    #[test]
    fn a_passive_node_falls_inside_the_drag_region_around_it() {
        // A title bar's spacer and its title text sit in front of the bar, so
        // unless they answer for it the window cannot be dragged by them.
        let inherited = inherited(&[
            with_role(WindowControlRole::Claims(gpui::WindowControlArea::Drag)),
            plain(),
            plain(),
        ]);
        assert_eq!(
            inherited.window_control_area,
            Some(gpui::WindowControlArea::Drag)
        );
    }

    #[test]
    fn a_node_inside_a_button_belongs_to_the_button() {
        // The label inside a Pressable in the title bar must press the button,
        // not drag the window.
        let inherited = inherited(&[
            with_role(WindowControlRole::Claims(gpui::WindowControlArea::Drag)),
            with_role(WindowControlRole::TakesPress),
            plain(),
        ]);
        assert_eq!(inherited.window_control_area, None);
    }

    #[test]
    fn a_caption_buttons_glyph_falls_inside_the_caption_button() {
        let inherited = inherited(&[
            with_role(WindowControlRole::Claims(gpui::WindowControlArea::Drag)),
            with_role(WindowControlRole::Claims(gpui::WindowControlArea::Close)),
            plain(),
        ]);
        assert_eq!(
            inherited.window_control_area,
            Some(gpui::WindowControlArea::Close)
        );
    }

    fn plain() -> InheritInput {
        node((0.0, 0.0), (1.0, 1.0, 0.0, 0.0), (0.0, 0.0))
    }

    fn scrolling(
        origin_frame: (f32, f32),
        transform: (f32, f32, f32, f32),
        offset: (f32, f32),
    ) -> InheritInput {
        InheritInput {
            scroll: Some(Rc::new(Cell::new(point(offset.0, offset.1)))),
            ..node(origin_frame, transform, (0.0, 0.0))
        }
    }

    fn inherited(chain: &[InheritInput]) -> Inherited {
        let mut parent: Option<(Inherited, InheritInput)> = None;
        let mut last = Inherited::default();
        for own in chain {
            last = inherit(
                parent.as_ref().map(|(inherited, input)| (inherited, input)),
                own,
            );
            parent = Some((last.clone(), own.clone()));
        }
        last
    }

    fn cached_origin(chain: &[InheritInput]) -> (f32, f32) {
        let inherited = inherited(chain);
        let (mut x, mut y) = inherited.origin_unscrolled;
        for link in inherited.scrollers.iter() {
            let offset = link.position.get();
            x -= link.scale.0 * offset.x;
            y -= link.scale.1 * offset.y;
        }
        (x, y)
    }

    fn walked_origin(chain: &[InheritInput]) -> (f32, f32) {
        let steps: Vec<OriginStep> = chain
            .iter()
            .map(|input| OriginStep {
                frame: input.origin_frame,
                transform: input.transform,
                scroll: input
                    .scroll
                    .as_ref()
                    .map(|position| (position.get().x, position.get().y))
                    .unwrap_or_default(),
                is_scroll: input.scroll.is_some(),
            })
            .collect();
        accumulate_origin(&steps)
    }

    fn assert_same_origin(chain: &[InheritInput]) {
        let cached = cached_origin(chain);
        let walked = walked_origin(chain);
        assert!(
            (cached.0 - walked.0).abs() < 0.01 && (cached.1 - walked.1).abs() < 0.01,
            "cached {cached:?} != walked {walked:?}"
        );
    }

    #[test]
    fn plain_nesting_accumulates_origins() {
        let chain = [
            node((10.0, 20.0), (1.0, 1.0, 0.0, 0.0), (0.0, 0.0)),
            node((5.0, 7.0), (1.0, 1.0, 0.0, 0.0), (0.0, 0.0)),
        ];
        assert_same_origin(&chain);
        assert_eq!(inherited(&chain).origin_unscrolled, (15.0, 27.0));
        assert_eq!(inherited(&chain).scale, (1.0, 1.0));
    }

    #[test]
    fn a_scaled_parent_scales_its_children() {
        let chain = [
            node((100.0, 0.0), (2.0, 2.0, 0.0, 0.0), (0.0, 0.0)),
            node((10.0, 20.0), (1.0, 1.0, 3.0, 4.0), (0.0, 0.0)),
        ];
        assert_same_origin(&chain);
        assert_eq!(inherited(&chain).origin_unscrolled, (126.0, 48.0));
        assert_eq!(inherited(&chain).scale, (2.0, 2.0));
    }

    #[test]
    fn a_scrollview_offset_moves_only_its_descendants() {
        let chain = [
            scrolling((0.0, 0.0), (1.0, 1.0, 0.0, 0.0), (0.0, 100.0)),
            node((10.0, 20.0), (1.0, 1.0, 0.0, 0.0), (0.0, 0.0)),
        ];
        assert_same_origin(&chain);
        assert_eq!(cached_origin(&chain), (10.0, -80.0));
        assert_eq!(inherited(&chain[..1]).origin_unscrolled, (0.0, 0.0));
    }

    #[test]
    fn a_scrollview_inside_a_scaled_parent_scrolls_at_that_scale() {
        let chain = [
            node((0.0, 0.0), (2.0, 2.0, 0.0, 0.0), (0.0, 0.0)),
            scrolling((0.0, 0.0), (1.0, 1.0, 0.0, 0.0), (0.0, 50.0)),
            node((0.0, 10.0), (1.0, 1.0, 0.0, 0.0), (0.0, 0.0)),
        ];
        assert_same_origin(&chain);
        let inherited = inherited(&chain);
        assert_eq!(inherited.scrollers.len(), 1);
        assert_eq!(inherited.scrollers[0].scale, (2.0, 2.0));
        assert_eq!(cached_origin(&chain), (0.0, -80.0));
    }

    #[test]
    fn nested_scrollviews_keep_both_offsets_outermost_first() {
        let chain = [
            scrolling((0.0, 0.0), (1.0, 1.0, 0.0, 0.0), (0.0, 10.0)),
            node((0.0, 0.0), (2.0, 2.0, 0.0, 0.0), (0.0, 0.0)),
            scrolling((0.0, 0.0), (1.0, 1.0, 0.0, 0.0), (0.0, 20.0)),
            node((0.0, 5.0), (1.0, 1.0, 0.0, 0.0), (0.0, 0.0)),
        ];
        assert_same_origin(&chain);
        let inherited = inherited(&chain);
        assert_eq!(inherited.scrollers.len(), 2);
        assert_eq!(inherited.scrollers[0].scale, (1.0, 1.0));
        assert_eq!(inherited.scrollers[1].scale, (2.0, 2.0));
        assert_eq!(cached_origin(&chain), (0.0, -40.0));
    }

    #[test]
    fn a_scroll_offset_never_changes_the_cached_value() {
        let position = Rc::new(Cell::new(point(0.0, 0.0)));
        let mut root = plain();
        root.scroll = Some(position.clone());
        let child = plain();
        let before = inherited(&[root.clone(), child.clone()]);
        assert_eq!(cached_origin(&[root.clone(), child.clone()]), (0.0, 0.0));
        position.set(point(0.0, 40.0));
        let after = inherited(&[root.clone(), child.clone()]);
        assert!(before.same(&after));
        assert_eq!(cached_origin(&[root, child]), (0.0, -40.0));
    }

    #[test]
    fn a_parent_border_is_remembered_unscaled() {
        let root = node((0.0, 0.0), (2.0, 2.0, 0.0, 0.0), (3.0, 4.0));
        assert_eq!(inherited(&[root, plain()]).parent_border, (3.0, 4.0));
        assert_eq!(inherited(&[plain()]).parent_border, (0.0, 0.0));
    }

    #[test]
    fn hidden_by_hidden_ancestor_follows_the_running_flag() {
        let mut root = plain();
        root.hides_descendants = true;
        let chain = [root.clone(), plain(), plain()];
        assert!(inherited(&chain).hidden_by_hidden_ancestor);
        assert!(!inherited(&[root]).hidden_by_hidden_ancestor);
        assert!(!inherited(&[plain(), plain()]).hidden_by_hidden_ancestor);
    }

    #[test]
    fn hidden_by_hiding_ancestor_follows_the_running_flag() {
        let mut root = plain();
        root.hides_subtree = true;
        assert!(inherited(&[root.clone(), plain()]).hidden_by_hiding_ancestor);
        assert!(!inherited(&[root]).hidden_by_hiding_ancestor);
        assert!(!inherited(&[plain(), plain()]).hidden_by_hiding_ancestor);
    }

    #[test]
    fn hidden_by_modal_sibling_is_set_by_the_parent_for_each_child() {
        let mut root = plain();
        root.other_modal_child = true;
        assert!(inherited(&[root.clone(), plain()]).hidden_by_modal_sibling);
        assert!(!inherited(&[root]).hidden_by_modal_sibling);
        assert!(!inherited(&[plain(), plain()]).hidden_by_modal_sibling);
    }

    #[test]
    fn hidden_by_accessible_ancestor_spares_focusable_and_accessible_nodes() {
        let mut root = plain();
        root.accessible = true;
        let child = plain();
        assert!(inherited(&[root.clone(), child.clone()]).hidden_by_accessible_ancestor);

        let mut focusable = plain();
        focusable.focusable_or_accessible = true;
        assert!(!inherited(&[root.clone(), focusable]).hidden_by_accessible_ancestor);

        let mut accessible = plain();
        accessible.accessible = true;
        accessible.focusable_or_accessible = true;
        assert!(!inherited(&[root, accessible]).hidden_by_accessible_ancestor);

        assert!(!inherited(&[child.clone(), child]).hidden_by_accessible_ancestor);
    }
}

impl RNNodeView {
    pub(crate) fn sync_input_paragraph(&mut self) {
        let show_placeholder = self.input_text.is_empty();
        let visible = if show_placeholder {
            &self.input_placeholder
        } else {
            &self.input_text
        };
        let Some(paragraph) = self.paragraph.as_mut() else {
            return;
        };
        if paragraph.fragments.is_empty() {
            if visible.is_empty() {
                return;
            }
            paragraph
                .fragments
                .push(rn_gpui_sys::ffi::TextFragmentFlat {
                    text: visible.clone(),
                    font_family: String::new(),
                    font_size: 14.0,
                    font_weight: 400,
                    italic: false,
                    color: if show_placeholder {
                        0xff8e8e93
                    } else {
                        self.input_text_color
                    },
                    line_height: 0.0,
                    letter_spacing: 0.0,
                    underline: false,
                    strikethrough: false,
                });
        } else {
            paragraph.fragments[0].text.clone_from(visible);
            if show_placeholder && !self.input_placeholder_mode {
                self.input_text_color = paragraph.fragments[0].color;
            }
            paragraph.fragments[0].color = if show_placeholder {
                0xff8e8e93
            } else if self.input_placeholder_mode {
                self.input_text_color
            } else {
                paragraph.fragments[0].color
            };
            paragraph.fragments.truncate(1);
        }
        self.input_placeholder_mode = show_placeholder;
    }
}

/// Reports a key to JS with the names the DOM uses.
///
/// `key` is the DOM's `KeyboardEvent.key`: `ArrowLeft`, `Enter`, `Escape`, a
/// single printable character, or `" "` for space. `code` is the physical key
/// (`KeyA`, `Digit4`, `ArrowLeft`) and `keyCode` the legacy number. Before this,
/// only six keys were translated and everything else went out as GPUI's own
/// spelling with `keyCode: 0`, so JS could not tell `ArrowLeft` from an unknown
/// key.
///
/// The GPUI spelling is kept in `gpuiKey` for anything that still matches on it.
/// Nothing in core reads the payload back — the internal handling matches on
/// `event.keystroke.key` before this runs — so this is purely what JS sees.
fn dispatch_key(tag: i32, event_type: &str, key: &gpui::Keystroke, repeat: bool, cx: &App) {
    let Some(store) = cx.try_global::<crate::store::StoreGlobal>() else {
        return;
    };
    let host = store.0.read(cx).host.clone();
    let key_name = crate::desktop::keymap::normalise_web_key(&key.key, key.modifiers.shift);
    host.dispatch_event(
        tag,
        event_type,
        &serde_json::json!({
            "key": key_name,
            "gpuiKey": key.key.as_str(),
            "code": crate::desktop::keymap::web_code(&key.key),
            "keyCode": crate::desktop::keymap::key_code(&key.key),
            "repeat": repeat,
            "shiftKey": key.modifiers.shift,
            "ctrlKey": key.modifiers.control,
            "altKey": key.modifiers.alt,
            "metaKey": key.modifiers.platform,
        }),
    );
}

pub(crate) static RENDER_COUNT: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

/// Queues one delivery of the host reports made during this frame's renders.
fn schedule_frame_host_report_flush(
    reports: &crate::store::HostReportQueue,
    window: &mut Window,
    cx: &mut Context<RNNodeView>,
) {
    if reports.is_empty() || reports.claim_flush() {
        return;
    }
    let reports = reports.clone();
    window.defer(cx, move |_window, cx| {
        reports.release_flush();
        match crate::store::store_from(cx) {
            Some(store) => {
                store.update(cx, |store, cx| store.flush_host_reports(cx));
            }
            None => {
                let _ = reports.take();
            }
        }
    });
}

impl Render for RNNodeView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        RENDER_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.render_count += 1;
        let accessibility_active = window.is_a11y_active();
        let was_initialized = ACCESSIBILITY_ACTIVE_INITIALIZED.swap(true, Ordering::Relaxed);
        let previous_accessibility_active =
            ACCESSIBILITY_ACTIVE.swap(accessibility_active, Ordering::Relaxed);
        if cfg!(not(target_os = "macos"))
            && was_initialized
            && previous_accessibility_active != accessibility_active
        {
            if let Some(store) = cx.try_global::<crate::store::StoreGlobal>() {
                store
                    .0
                    .read(cx)
                    .host
                    .emit_device_event_bool("screenReaderChanged", accessibility_active);
            }
        }
        if std::env::var_os("RN_GPUI_DEBUG_A11Y_TREE").is_some()
            && !A11Y_TREE_DUMP_COMPLETE.load(Ordering::Relaxed)
            && A11Y_TREE_DUMP_SCHEDULED
                .compare_exchange(false, true, Ordering::Relaxed, Ordering::Relaxed)
                .is_ok()
        {
            window.on_next_frame(|window, _cx| {
                #[cfg(all(target_os = "macos", feature = "visual-capture"))]
                let attempts = A11Y_TREE_DUMP_ATTEMPTS.fetch_add(1, Ordering::Relaxed);
                if let Some(tree) = window.debug_a11y_tree_json() {
                    log::info!("[a11y-tree] {tree}");
                    A11Y_TREE_DUMP_COMPLETE.store(true, Ordering::Relaxed);
                } else {
                    #[cfg(all(target_os = "macos", feature = "visual-capture"))]
                    {
                        if attempts >= 10 {
                            log::error!("[a11y-tree] provider did not activate after 10 frames");
                            A11Y_TREE_DUMP_COMPLETE.store(true, Ordering::Relaxed);
                            return;
                        }
                        crate::native_view::activate_accessibility_probe(window);
                        A11Y_TREE_DUMP_SCHEDULED.store(false, Ordering::Relaxed);
                        window.refresh();
                    }
                    #[cfg(not(all(target_os = "macos", feature = "visual-capture")))]
                    {
                        log::info!("[a11y-tree] unavailable (no active AccessKit client)");
                        A11Y_TREE_DUMP_COMPLETE.store(true, Ordering::Relaxed);
                    }
                }
            });
        }
        if debug_render_counts_enabled() {
            log::info!(
                "[retention] RNNodeView::render elapsed_ms={} tag={} component={} count={}",
                elapsed_since_first_render_ms(),
                self.tag,
                self.component,
                self.render_count
            );
        }
        let hidden_portal = crate::extensions::component_portal(
            &self.component,
            &crate::extensions::parse_extension_props(&self.extension_props_json),
        )
        .is_some_and(|portal| !portal.visible);
        if self.view.display_none || hidden_portal {
            return div().id(self.tag).size_0().into_any_element();
        }
        if self.component == "NativeViewHost" && !self.native_view_name.is_empty() {
            if self.native_view_host.is_none() {
                match crate::native_surface::NativeSurface::create(
                    crate::native_surface::NativeSurfaceContent::Factory {
                        name: self.native_view_name.clone(),
                        props: self.native_view_props.clone(),
                    },
                    window,
                    cx,
                ) {
                    Ok(host) => self.native_view_host = Some(std::rc::Rc::new(host)),
                    Err(error) => log::error!(
                        "[native-view] tag {} ({}) initialization failed: {error:#}",
                        self.tag,
                        self.native_view_name
                    ),
                }
            }
        }
        let frame = self.layout_frame(&self.stable_paint_tree(cx));
        let (scale_x, scale_y) = self.cumulative_scale(cx);
        // Yoga's child frames already include the parent's border inset, and GPUI
        // positions absolute children inside that border as well.
        let (parent_scale_x, parent_scale_y) = self.inherited.parent_scale;
        let (origin_x, origin_y) = self.origin_frame(cx);
        let (_, _, translate_x, translate_y) = self.local_transform();
        // No parent scroll offset here: the ScrollView moves all its children at once
        // through its content wrapper.
        let base_left = parent_scale_x * (origin_x + translate_x)
            - self.inherited.parent_border.0 * parent_scale_x.abs();
        let base_top = parent_scale_y * (origin_y + translate_y)
            - self.inherited.parent_border.1 * parent_scale_y.abs();
        #[cfg(debug_assertions)]
        if verify_inherited_enabled() {
            self.verify_inherited(cx);
        }
        let transition = if cx.reduce_motion() || crate::animation_policy::animations_disabled() {
            None
        } else {
            self.transition
        };
        let transition_started_at = transition.map(|(_, started_at)| started_at);
        let transition_progress =
            transition.map(|(transition, started_at)| transition.progress_now(started_at));
        if let (Some((_transition, started_at)), Some(progress)) = (transition, transition_progress)
        {
            let sample = (started_at, progress);
            if self.transition_progress_sent != Some(sample) {
                self.transition_progress_sent = Some(sample);
                if let Some(store) = cx.try_global::<crate::store::StoreGlobal>() {
                    let handle = crate::extensions::StoreHandle::new(store.0.downgrade());
                    for observer in crate::extensions::store_observers() {
                        observer.on_transition_frame(self.tag, progress, &handle, cx);
                    }
                }
            }
        }
        if transition_progress.is_some_and(|progress| progress < 1.0) {
            let node = cx.entity().downgrade();
            window.on_next_frame(move |_, cx| {
                let _ = node.update(cx, |_, cx| cx.notify());
            });
            window.request_animation_frame();
        } else if let Some(started) = transition_started_at {
            if self.transition_end_refreshed != Some(started) {
                self.transition_end_refreshed = Some(started);
                let surface_id = self.surface_id;
                cx.defer(move |cx| {
                    if let Some(store) = crate::store::store_from(cx) {
                        store.update(cx, |store, cx| {
                            store.refresh_inherited(surface_id, cx);
                        });
                    }
                });
            }
        }
        let scroll = self.scroll.clone();
        let is_scroll = scroll.is_some();
        let ordered_children = self.children.clone();
        if let Some(renderer) = crate::extensions::component_renderer(&self.component) {
            let node = self.component_node(cx);
            if let Some(painted) = renderer.render(&node, window, cx) {
                // The renderer paints the node's whole appearance, but core still
                // owns where the node is: without this box the element is an
                // unpositioned flow child of the parent, and a `size_full()`
                // image fills the parent instead of the node's frame.
                let mut placed = div().id(self.tag);
                *placed.style() = {
                    let mut style = self.cached_style.clone();
                    style.position = Some(Position::Absolute);
                    style.inset.left = Some(px(base_left).into());
                    style.inset.top = Some(px(base_top).into());
                    style.size.width = Some(px(frame.w * scale_x).into());
                    style.size.height = Some(px(frame.h * scale_y).into());
                    style
                };
                return placed.child(painted).into_any_element();
            }
        }
        let mut element = div().id(self.tag);
        // Everything that puts this node into keymap resolution goes through one
        // `KeyContext`, because `Div::key_context` *assigns*: a second call would
        // silently replace the first. Building one context and merging into it
        // means a node that is both a scope and a text input keeps both markers,
        // instead of one vanishing with no warning.
        //
        // This is also the only place a context can go: GPUI keeps it on the
        // element and pushes it onto the dispatch tree at paint, which is what
        // makes the focus path's context stack — and so the scope precedence —
        // real.
        let key_context = {
            let mut context = gpui::KeyContext::default();
            let mut claimed = false;
            if let Some(renderer) = crate::extensions::component_renderer(&self.component) {
                let node = self.component_node_shallow();
                if let Some(declared) = renderer.key_context(&node) {
                    match gpui::KeyContext::parse(&declared) {
                        Ok(parsed) => {
                            context.extend(&parsed);
                            claimed = true;
                        }
                        Err(error) => {
                            log::warn!(
                                "[shortcut] {} has an invalid key context {declared:?}: {error}",
                                self.component
                            );
                        }
                    }
                }
            }
            // A `TextInput` marks itself so a shortcut that did not ask for
            // `allowInTextInput` can exclude itself with `!rn-text-input`. The
            // marker is on the node's own element, so it is on the focus path of
            // every key the input handles.
            if self.component == "TextInput" {
                if let Ok(marker) =
                    gpui::KeyContext::parse(crate::desktop::keymap::TEXT_INPUT_CONTEXT)
                {
                    context.extend(&marker);
                    claimed = true;
                }
            }
            claimed.then_some(context)
        };
        if let Some(context) = key_context {
            element = element.key_context(context);
        }
        // A shortcut scope owns the `ShortcutAction`s whose ids it registered.
        // The listener is in the bubble phase, innermost node first, so the
        // deepest scope on the focus path claims the action and an outer one
        // never sees it — which is the "innermost wins" rule. A scope that does
        // not own the id propagates, so an outer scope, or the app-wide handler,
        // still gets its turn.
        if self.component == crate::builtins::shortcut_scope::COMPONENT {
            let tag = self.tag;
            let scope = crate::builtins::shortcut_scope::scope_name(&self.component_node_shallow());
            element = element.on_action(cx.listener(
                move |_this, action: &crate::desktop::keymap::ShortcutAction, window, cx| {
                    if !crate::desktop::keymap::scope_owns(cx, &scope, &action.id) {
                        cx.propagate();
                        return;
                    }
                    crate::desktop::keymap::dispatch_to(cx, tag, &action.id, Some(window));
                },
            ));
        }
        let decoration = self.decoration(cx);
        if decoration.clip {
            element = element.overflow_hidden().overflow_clips_corners();
        }
        if let Some(background) = decoration.background {
            element = element.bg(gpui::rgb(background));
        }
        // One helper decides the area, so a `View` drag region and a component
        // that claims a caption button cannot disagree — and the component wins
        // its own box, which is what makes a `WindowControl` inside a title bar
        // act as a button rather than drag the window.
        if let Some(area) = self.window_control_area(cx) {
            element = element.window_control_area(area);
        }
        let accessibility_id = if self.view.accessibility_native_id.is_empty() {
            &self.view.test_id
        } else {
            &self.view.accessibility_native_id
        };
        if !accessibility_id.is_empty() {
            element = element.accessibility_id(accessibility_id.clone());
        }
        if !self.view.accessibility_label.is_empty() {
            element = element.aria_label(self.view.accessibility_label.clone());
        }
        if !self.view.accessibility_hint.is_empty() {
            element = element.aria_description(self.view.accessibility_hint.clone());
        }
        if self.view.accessibility_label.is_empty() {
            let labelled_by = if accessibility_active {
                self.accessibility_labelled_by_text(cx)
            } else {
                String::new()
            };
            let label = if !labelled_by.is_empty() {
                labelled_by
            } else if self.view.accessible && accessibility_active {
                self.accessible_group_text(cx)
            } else {
                String::new()
            };
            if !label.is_empty() {
                element = element.aria_label(label);
            }
        }
        if self.component == "Paragraph" && self.view.accessibility_label.is_empty() {
            if let Some(paragraph) = &self.paragraph {
                let text = paragraph
                    .fragments
                    .iter()
                    .map(|fragment| fragment.text.as_str())
                    .collect::<String>();
                if !text.is_empty() {
                    element = element.aria_value(text);
                }
            }
        }
        if !self.view.accessibility_value_text.is_empty() {
            element = element.aria_value(self.view.accessibility_value_text.clone());
        }
        if self.view.accessibility_has_value_min {
            element = element.aria_min_numeric_value(f64::from(self.view.accessibility_value_min));
        }
        if self.view.accessibility_has_value_max {
            element = element.aria_max_numeric_value(f64::from(self.view.accessibility_value_max));
        }
        if self.view.accessibility_has_value_now {
            element = element.aria_numeric_value(f64::from(self.view.accessibility_value_now));
        }
        if self.component == "TextInput" {
            if !self.input_placeholder.is_empty() {
                element = element.aria_placeholder(self.input_placeholder.clone());
            }
            if !self.input_secure_text && !self.input_text.is_empty() {
                element = element.aria_value(self.input_text.clone());
            }
        }
        if let Some(role) = self.accessibility_role() {
            element = element.role(role);
        }
        if accessibility_active && self.accessibility_role() == Some(Role::ListItem) {
            if let Some(parent) = self.parent.as_ref().and_then(|parent| parent.upgrade()) {
                let parent = parent.read(cx);
                let mut position = None;
                let mut size = 0;
                for (tag, sibling) in &parent.children {
                    // Render already leases self. Never read it through Entity.
                    let is_item = *tag == self.tag
                        || sibling.read(cx).accessibility_role() == Some(Role::ListItem);
                    if is_item {
                        size += 1;
                        if *tag == self.tag {
                            position = Some(size);
                        }
                    }
                }
                if let Some(position) = position {
                    element = element
                        .aria_position_in_set(position)
                        .aria_size_of_set(size);
                }
            }
        }
        let hidden_image = self.component == "Image"
            && self.view.accessibility_label.is_empty()
            && self.view.accessibility_role.is_empty()
            && !self.view.accessible;
        let hidden_by_accessible_ancestor = self.inherited.hidden_by_accessible_ancestor;
        let hidden_by_hidden_ancestor = self.inherited.hidden_by_hidden_ancestor;
        let hidden_by_modal_sibling = self.inherited.hidden_by_modal_sibling;
        let hidden_by_active_modal = crate::accessibility::hidden_by_active_modal(self.tag, cx);
        let hidden_by_hiding_ancestor = self.inherited.hidden_by_hiding_ancestor;
        let hidden_by_decoration = decoration.a11y_hidden;
        let hidden_display_none = self.view.display_none;
        let accessibility = self.view.clone();
        #[cfg(feature = "visual-capture")]
        let accessibility_tag = self.tag;
        let input_editable = self.input_editable;
        let input_secure_text = self.input_secure_text;
        let is_text_input = self.component == "TextInput";
        let input_text = self.input_text.clone();
        let input_placeholder = self.input_placeholder.clone();
        element = element.a11y_synthetic_children(move |builder| {
            let node = builder.parent_node();
            if accessibility.accessibility_important == 3
                || accessibility.accessibility_hidden
                || hidden_image
                || hidden_image
                || hidden_by_accessible_ancestor
                || hidden_by_hidden_ancestor
                || hidden_by_modal_sibling
                || hidden_by_active_modal
                || hidden_by_hiding_ancestor
                || hidden_by_decoration
                || hidden_display_none
            {
                node.set_hidden();
            }
            if accessibility.accessibility_modal {
                node.set_modal();
            }
            if accessibility.accessibility_busy {
                node.set_busy();
            }
            if accessibility.accessibility_disabled
                || !accessibility.accessibility_responds_to_interaction
            {
                node.set_disabled();
            }
            if accessibility.accessibility_selected {
                node.set_selected(true);
            }
            if accessibility.accessibility_expanded >= 0 {
                node.set_expanded(accessibility.accessibility_expanded != 0);
            }
            match accessibility.accessibility_checked {
                1 => node.set_toggled(gpui::Toggled::False),
                2 => node.set_toggled(gpui::Toggled::True),
                3 => node.set_toggled(gpui::Toggled::Mixed),
                _ => {}
            }
            if !accessibility.accessibility_language.is_empty() {
                node.set_language(accessibility.accessibility_language.clone());
            }
            match accessibility.accessibility_live_region {
                1 => node.set_live(gpui::accesskit::Live::Polite),
                2 => node.set_live(gpui::accesskit::Live::Assertive),
                _ => {}
            }
            if accessibility.accessibility_has_value_min {
                node.set_min_numeric_value(f64::from(accessibility.accessibility_value_min));
            }
            if accessibility.accessibility_has_value_max {
                node.set_max_numeric_value(f64::from(accessibility.accessibility_value_max));
            }
            if accessibility.accessibility_has_value_now {
                node.set_numeric_value(f64::from(accessibility.accessibility_value_now));
            }
            let value = if is_text_input {
                if input_secure_text || input_text.is_empty() {
                    None
                } else {
                    Some(input_text.as_str())
                }
            } else if !accessibility.accessibility_value_text.is_empty() {
                Some(accessibility.accessibility_value_text.as_str())
            } else {
                None
            };
            if let Some(value) = value {
                node.set_value(value);
            }
            if is_text_input && !input_placeholder.is_empty() {
                node.set_placeholder(input_placeholder);
            }
            if is_text_input {
                if !input_editable {
                    node.set_read_only();
                }
                if input_secure_text {
                    node.set_value("");
                }
            }
            node.set_custom_actions(
                accessibility
                    .accessibility_actions
                    .iter()
                    .filter(|action| accessibility_action_for_name(&action.name).is_none())
                    .enumerate()
                    .map(|(index, action)| gpui::accesskit::CustomAction {
                        id: index as i32,
                        description: if action.label.is_empty() {
                            action.name.clone().into_boxed_str()
                        } else {
                            action.label.clone().into_boxed_str()
                        },
                    })
                    .collect::<Vec<_>>(),
            );
            #[cfg(feature = "visual-capture")]
            if std::env::var_os("RN_GPUI_DEBUG_A11Y_TREE").is_some() {
                let snapshot = serde_json::json!({
                    "tag": accessibility_tag,
                    "id": accessibility.test_id,
                    "role": format!("{:?}", node.role()),
                    "label": node.label(),
                    "value": node.value(),
                    "hidden": node.is_hidden(),
                    "disabled": node.is_disabled(),
                    "modal": node.is_modal(),
                    "escapeListener": accessibility.accessibility_has_escape_listener,
                    "language": node.language(),
                    "live": node.live().map(|value| format!("{value:?}")),
                    "position": node.position_in_set(),
                    "size": node.size_of_set(),
                    "customActions": node.custom_actions().iter().map(|action| action.description.as_ref()).collect::<Vec<_>>(),
                }).to_string();
                static SNAPSHOTS: OnceLock<Mutex<HashMap<i32, String>>> = OnceLock::new();
                let mut snapshots = SNAPSHOTS.get_or_init(Mutex::default).lock().unwrap();
                if snapshots.get(&accessibility_tag) != Some(&snapshot) {
                    log::info!("[a11y-node] {snapshot}");
                    snapshots.insert(accessibility_tag, snapshot);
                }
            }
        });
        let has_accessibility_focus_target =
            self.view.accessible || self.accessibility_role().is_some();
        let mut focus_child = None;
        if self.focusable
            || self.view.accessibility_has_escape_listener
            || has_accessibility_focus_target
        {
            if self.focus_handle.is_none() {
                let handle = cx
                    .focus_handle()
                    .tab_stop(self.focusable || self.view.accessibility_has_escape_listener)
                    .tab_index(self.tag as isize);
                if let Some(store) = cx.try_global::<crate::store::StoreGlobal>() {
                    let host = store.0.read(cx).host.clone();
                    let tag = self.tag;
                    let is_text_input = self.component == "TextInput";
                    let focused_host = host.clone();
                    self.focus_subscriptions.push(cx.on_focus(
                        &handle,
                        window,
                        move |this, window, cx| {
                            if is_text_input {
                                this.start_caret_blink(cx);
                            }
                            focused_host.dispatch_event(
                                tag,
                                if is_text_input { "topFocus" } else { "focus" },
                                &serde_json::json!({
                                    "focusVisible": window.last_input_was_keyboard(),
                                }),
                            );
                            if let Some(store) = cx.try_global::<crate::store::StoreGlobal>() {
                                store.0.read(cx).frame_hook.arm(window);
                            }
                        },
                    ));
                    self.focus_subscriptions.push(cx.on_blur(
                        &handle,
                        window,
                        move |this, window, cx| {
                            if is_text_input {
                                this.stop_caret_blink();
                                cx.notify();
                            }
                            host.dispatch_event(
                                tag,
                                if is_text_input { "topBlur" } else { "blur" },
                                &serde_json::json!({}),
                            );
                            if let Some(store) = cx.try_global::<crate::store::StoreGlobal>() {
                                store.0.read(cx).frame_hook.arm(window);
                            }
                        },
                    ));
                }
                self.focus_handle = Some(handle);
            }
            self.set_accessibility_tab_stop_allowed(
                !hidden_by_active_modal
                    && !hidden_by_modal_sibling
                    && !hidden_by_hiding_ancestor
                    && !self.inherited.hidden_by_hidden_ancestor
                    && !self.inherited.hidden_by_accessible_ancestor,
            );
            if let Some(handle) = &self.focus_handle {
                if accessibility_active || is_scroll {
                    // The accessibility tree needs the role, the label and the focus on one
                    // element.
                    element = element.track_focus(handle);
                } else {
                    // `track_focus` forces a div hitbox, and a div asks whether it is hovered
                    // while painting; a zero-sized child's hitbox is never hovered.
                    focus_child = Some(div().absolute().size_0().track_focus(handle));
                }
            }
            element = element
                .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                    dispatch_key(this.tag, "topKeyDown", &event.keystroke, event.is_held, cx);
                    if !event.is_held
                        && focus_adjacent_semantic_sibling(this, &event.keystroke.key, window, cx)
                    {
                        cx.stop_propagation();
                    }
                    if !event.is_held
                        && matches!(event.keystroke.key.as_str(), "enter" | "space")
                        && this.component != "TextInput"
                        && matches!(
                            this.accessibility_role(),
                            Some(
                                Role::Button
                                    | Role::DefaultButton
                                    | Role::CheckBox
                                    | Role::RadioButton
                                    | Role::Switch
                                    | Role::Link
                            )
                        )
                    {
                        dispatch_accessibility_event(
                            this.tag,
                            "click",
                            &serde_json::json!({}),
                            window,
                            cx,
                        );
                        cx.stop_propagation();
                    }
                    if event.keystroke.key == "escape" {
                        #[cfg(feature = "visual-capture")]
                        log::info!(
                            "[accessibility] Escape tag={} target={:?}",
                            this.tag,
                            this.accessibility_escape_target(cx)
                        );
                        if let Some(tag) = this.accessibility_escape_target(cx) {
                            dispatch_accessibility_event(
                                tag,
                                "accessibilityEscape",
                                &serde_json::json!({}),
                                window,
                                cx,
                            );
                            cx.stop_propagation();
                        }
                    }
                    let primary_modifier = if cfg!(target_os = "macos") {
                        event.keystroke.modifiers.platform
                    } else {
                        event.keystroke.modifiers.control
                    };
                    if this.component == "TextInput"
                        && primary_modifier
                        && event.keystroke.key == "a"
                        && !event.keystroke.modifiers.alt
                    {
                        crate::builtins::textinput::input::select_all(this, window, cx);
                        cx.stop_propagation();
                    }
                    if this.component == "TextInput"
                        && crate::builtins::textinput::input::handle_key(
                            this,
                            &event.keystroke.key,
                            event.keystroke.modifiers.shift,
                            window,
                            cx,
                        )
                    {
                        cx.stop_propagation();
                    }
                    if let Some(store) = cx.try_global::<crate::store::StoreGlobal>() {
                        store.0.read(cx).frame_hook.arm(window);
                    }
                    if event.keystroke.key == "tab" {
                        if event.keystroke.modifiers.shift {
                            window.focus_prev(cx);
                        } else {
                            window.focus_next(cx);
                        }
                        cx.stop_propagation();
                    }
                }))
                .on_key_up(cx.listener(|this, event: &KeyUpEvent, window, cx| {
                    dispatch_key(this.tag, "topKeyUp", &event.keystroke, false, cx);
                    if let Some(store) = cx.try_global::<crate::store::StoreGlobal>() {
                        store.0.read(cx).frame_hook.arm(window);
                    }
                }));
            if let Some(focus) = self.pending_text_input_focus.take() {
                if let Some(handle) = self.focus_handle.as_ref() {
                    if focus {
                        handle.focus(window, cx);
                    } else if handle.is_focused(window) {
                        window.blur(cx);
                    }
                }
            }
        }
        if self.view.accessibility_responds_to_interaction && !self.view.accessibility_disabled {
            let tag = self.tag;
            let actions = self.view.accessibility_actions.clone();
            let has_activate_action = actions.iter().any(|action| action.name == "activate");
            if !has_activate_action
                && (self.focusable
                    || self.view.accessibility_has_tap_listener
                    || matches!(
                        self.accessibility_role(),
                        Some(
                            Role::Button
                                | Role::DefaultButton
                                | Role::CheckBox
                                | Role::RadioButton
                                | Role::Switch
                                | Role::Link
                                | Role::Tab
                                | Role::MenuItem
                        )
                    ))
            {
                let has_tap_listener = self.view.accessibility_has_tap_listener;
                element = element.on_a11y_action(
                    gpui::AccessibleAction::Click,
                    move |_data, window, cx| {
                        dispatch_accessibility_event(
                            tag,
                            "click",
                            &serde_json::json!({}),
                            window,
                            cx,
                        );
                        if has_tap_listener {
                            dispatch_accessibility_event(
                                tag,
                                "accessibilityTap",
                                &serde_json::json!({}),
                                window,
                                cx,
                            );
                        }
                    },
                );
            }
            for action in actions.iter().filter_map(|action| {
                accessibility_action_for_name(&action.name)
                    .map(|native_action| (native_action, action.name.clone()))
            }) {
                let (native_action, name) = action;
                let dispatch = self.view.accessibility_has_action_listener;
                let tap = name == "activate" && self.view.accessibility_has_tap_listener;
                element = element.on_a11y_action(native_action, move |_data, window, cx| {
                    if name == "activate" {
                        dispatch_accessibility_event(
                            tag,
                            "click",
                            &serde_json::json!({}),
                            window,
                            cx,
                        );
                    }
                    if dispatch {
                        dispatch_accessibility_event(
                            tag,
                            "accessibilityAction",
                            &serde_json::json!({"actionName": name}),
                            window,
                            cx,
                        );
                    }
                    if tap {
                        dispatch_accessibility_event(
                            tag,
                            "accessibilityTap",
                            &serde_json::json!({}),
                            window,
                            cx,
                        );
                    }
                });
            }
            let custom_actions = actions
                .into_iter()
                .filter(|action| accessibility_action_for_name(&action.name).is_none())
                .collect::<Vec<_>>();
            if !custom_actions.is_empty() && self.view.accessibility_has_action_listener {
                let tag = self.tag;
                element = element.on_a11y_action(
                    gpui::AccessibleAction::CustomAction,
                    move |data, window, cx| {
                        let Some(gpui::accesskit::ActionData::CustomAction(id)) = data else {
                            return;
                        };
                        let Some(action) = custom_actions.get(*id as usize) else {
                            return;
                        };
                        dispatch_accessibility_event(
                            tag,
                            "accessibilityAction",
                            &serde_json::json!({"actionName": action.name}),
                            window,
                            cx,
                        );
                    },
                );
            }
        }
        if let Some(close_event) = crate::extensions::component_portal(
            &self.component,
            &crate::extensions::parse_extension_props(&self.extension_props_json),
        )
        .filter(|portal| portal.visible)
        .and_then(|portal| portal.close_request_event)
        {
            element =
                element.on_key_down(cx.listener(move |this, event: &KeyDownEvent, window, cx| {
                    if event.keystroke.key != "escape" {
                        return;
                    }
                    if let Some(store) = cx.try_global::<crate::store::StoreGlobal>() {
                        let store = store.0.read(cx);
                        store
                            .host
                            .dispatch_event(this.tag, &close_event, &serde_json::json!({}));
                        store.frame_hook.arm(window);
                    }
                    cx.stop_propagation();
                }));
        }
        if crate::extensions::component_renderer(&self.component)
            .is_some_and(|renderer| renderer.handles_keys(&self.component_node_shallow()))
        {
            element = element.on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                let Some(renderer) = crate::extensions::component_renderer(&this.component) else {
                    return;
                };
                let Some(store_entity) = cx
                    .try_global::<crate::store::StoreGlobal>()
                    .map(|store| store.0.clone())
                else {
                    return;
                };
                let (top_inset, animations_enabled) = {
                    let store = store_entity.read(cx);
                    (
                        store.top_inset,
                        !cx.reduce_motion() && !crate::animation_policy::animations_disabled(),
                    )
                };
                let handle = crate::extensions::StoreHandle::new(store_entity.downgrade());
                let node = this.component_node_shallow();
                // `retained` is the only borrow left, so it is copied out too;
                // every node is a snapshot, so the tree never touches an entity
                // while the handler below holds the app mutably.
                let self_tag = this.tag;
                let (nodes, root_tags, retained) = store_entity.read_with(cx, |store, cx| {
                    // This node is leased by the listener that is running, and
                    // the tree already carries it as `current`, so it is skipped
                    // here rather than read back through the entity map.
                    let nodes: HashMap<i32, crate::extensions::NodeSnapshot> = store
                        .nodes
                        .iter()
                        .filter(|(tag, _)| **tag != self_tag)
                        .map(|(tag, entity)| (*tag, entity.read(cx).snapshot()))
                        .collect();
                    let root_tags = store
                        .roots
                        .values()
                        .flat_map(|root| root.read(cx).children.iter().map(|(tag, _)| *tag))
                        .collect();
                    (nodes, root_tags, store.retained_subtrees.clone())
                });
                let tree = crate::extensions::TreeView {
                    nodes: std::borrow::Cow::Owned(nodes),
                    root_tags,
                    top_inset,
                    animations_enabled,
                    current: Some((this.tag, this.snapshot())),
                    retained: &retained,
                };
                let handled =
                    renderer.on_key_down(&node, &event.keystroke.key, &tree, &handle, window, cx);
                if handled {
                    cx.stop_propagation();
                }
            }));
        }
        *element.style() = {
            let mut style = self.cached_style.clone();
            if let Some(color) = self.animated_background_color {
                style.background = Some(Fill::from(style::color(color)));
            }
            let radius_scale = scale_x.min(scale_y);
            style.corner_radii.top_left = Some(px(self.view.border_radii.tl * radius_scale).into());
            style.corner_radii.top_right =
                Some(px(self.view.border_radii.tr * radius_scale).into());
            style.corner_radii.bottom_right =
                Some(px(self.view.border_radii.br * radius_scale).into());
            style.corner_radii.bottom_left =
                Some(px(self.view.border_radii.bl * radius_scale).into());
            if let Some(shadows) = style.box_shadow.as_mut() {
                for shadow in shadows {
                    shadow.offset.x = px(f32::from(shadow.offset.x) * scale_x);
                    shadow.offset.y = px(f32::from(shadow.offset.y) * scale_y);
                    shadow.blur_radius = px(f32::from(shadow.blur_radius) * radius_scale);
                    shadow.spread_radius = px(f32::from(shadow.spread_radius) * radius_scale);
                }
            }
            style.position = Some(Position::Absolute);
            if decoration.display == Some(false) {
                style.display = Some(Display::None);
            }
            let transitioning_out = transition.is_some_and(|(transition, _)| {
                transition.to.opacity < 1.0
                    && transition_progress.is_some_and(|progress| progress < 1.0)
            });
            let _ = transitioning_out;
            let mut transition_offset_x = 0.0;
            if let (Some((transition, _)), Some(progress)) = (transition, transition_progress) {
                let pose = transition.pose_at(progress);
                transition_offset_x = pose.offset_x * frame.w;
                style.opacity = Some(style.opacity.unwrap_or(1.0) * pose.opacity);
            }
            style.inset.left = Some(px(base_left + transition_offset_x).into());
            style.inset.top = Some(px(base_top).into());
            style.size.width = Some(px(frame.w * scale_x).into());
            style.size.height = Some(px(frame.h * scale_y).into());
            style
        };
        // The listeners live on a `pointer_area` child, not on the node's own div: a
        // div with a hitbox records a hover read while painting, which makes a scroll
        // under a still pointer rebuild every row. It is the first child so its
        // hitbox and handlers keep the order the node's own div would give them.
        let mut handlers = PointerHandlers::default();
        // The window-control area a press here lands in: the bar of a title bar,
        // or one of its caption buttons. On Windows a left press there belongs to
        // the OS: the hit-test answered `HTCAPTION` (or a caption button), and
        // the window backend only lets `DefWindowProc` act on that — move the
        // window, maximize it on a double click, snap it, press the button — when
        // the app leaves the press unhandled. So nothing here may consume it.
        let control_area = self.window_control_area(cx);
        let os_owns_press = cfg!(target_os = "windows") && control_area.is_some();
        // A component renderer that asked for input gets it through the same
        // handlers the View props use, so ordering with RN's touch handling and
        // the scroll-container case stays as it was.
        let input_spec = crate::extensions::component_renderer(&self.component).map(|renderer| {
            let node = self.component_node(cx);
            let spec = renderer.input(&node);
            (spec, node)
        });
        if let Some((spec, node)) = input_spec {
            for button in [
                crate::events::Button::Left,
                crate::events::Button::Middle,
                crate::events::Button::Right,
                crate::events::Button::Back,
                crate::events::Button::Forward,
            ] {
                if !spec.mouse_buttons.contains(button) {
                    continue;
                }
                let down_node = cx.entity().downgrade();
                let down_component = node.clone();
                let handler: crate::pointer_area::PointerHandler<MouseDownEvent> =
                    Rc::new(move |event: &MouseDownEvent, window, cx| {
                        run_component_hook(
                            &down_node,
                            &down_component,
                            window,
                            cx,
                            event.position,
                            button,
                            event.click_count,
                            event.modifiers,
                            ComponentHook::Down,
                        );
                    });
                match button {
                    crate::events::Button::Left => handlers.left_down.push(handler),
                    crate::events::Button::Middle => handlers.middle_down.push(handler),
                    crate::events::Button::Right => handlers.right_down.push(handler),
                    crate::events::Button::Back => handlers.back_down.push(handler),
                    crate::events::Button::Forward => handlers.forward_down.push(handler),
                }
                let up_node = cx.entity().downgrade();
                let up_component = node.clone();
                let handler: crate::pointer_area::PointerHandler<MouseUpEvent> =
                    Rc::new(move |event: &MouseUpEvent, window, cx| {
                        run_component_hook(
                            &up_node,
                            &up_component,
                            window,
                            cx,
                            event.position,
                            button,
                            event.click_count,
                            event.modifiers,
                            ComponentHook::Up,
                        );
                    });
                match button {
                    crate::events::Button::Left => handlers.left_up.push(handler),
                    crate::events::Button::Middle => handlers.middle_up.push(handler),
                    crate::events::Button::Right => handlers.right_up.push(handler),
                    crate::events::Button::Back => handlers.back_up.push(handler),
                    crate::events::Button::Forward => handlers.forward_up.push(handler),
                }
            }
            if spec.hover {
                // The edge is decided here, on the entity, because the listener
                // that reports the sample is rebuilt on every paint.
                let hover_node = cx.entity().downgrade();
                let hover_component = node;
                handlers
                    .hover
                    .push(Rc::new(move |hovered: bool, window, cx| {
                        let Some(entity) = hover_node.upgrade() else {
                            return;
                        };
                        let component = entity.read(cx).component.clone();
                        let Some(renderer) = crate::extensions::component_renderer(&component)
                        else {
                            return;
                        };
                        let changed = entity.update(cx, |this, _| {
                            if this.hovered == hovered {
                                return false;
                            }
                            this.hovered = hovered;
                            true
                        });
                        if !changed {
                            return;
                        }
                        let mut context = crate::extensions::input::InputContext {
                            node: &hover_component,
                            window,
                            cx,
                            captured: false,
                        };
                        renderer.on_hover(&hover_component, hovered, &mut context);
                    }));
            }
        }
        // A box-none portal overlay must not install a hit area of its own.
        // Its children still dispatch through their ancestor chain; installing
        // handlers here redirects empty overlay space to its parent and blocks
        // sibling content underneath (for example Paseo's entire sidebar).
        if !matches!(self.view.pointer_events,
            crate::events::POINTER_EVENTS_NONE | crate::events::POINTER_EVENTS_BOX_NONE
        ) {
            let node = cx.entity().downgrade();
            let down_node = node.clone();
            handlers
                .left_down
                .push(Rc::new(move |event: &MouseDownEvent, window, cx| {
                    // No touch either: the release never comes back once the OS
                    // has taken the press into its move loop. The ancestors this
                    // press bubbles to are told, so none of them starts one.
                    if os_owns_press {
                        crate::events::hand_press_to_window();
                        return;
                    }
                    if crate::events::press_belongs_to_window() {
                        return;
                    }
                    let Some(node) = down_node.upgrade() else {
                        return;
                    };
                    let (target, focus_handle, is_text_input) = {
                        let this = node.read(cx);
                        (
                            crate::events::target(cx, this),
                            this.nearest_focus_handle(cx),
                            this.component == "TextInput",
                        )
                    };
                    let Some(target) = target else {
                        return;
                    };
                    if let Some(handle) = focus_handle {
                        window.focus(&handle, cx);
                    }
                    if is_text_input {
                        node.update(cx, |this, cx| {
                            if event.click_count >= 2 {
                                crate::builtins::textinput::input::select_all(this, window, cx);
                            } else {
                                crate::builtins::textinput::input::select_at_point(
                                    this,
                                    event.position,
                                    false,
                                    window,
                                    cx,
                                );
                            }
                        });
                    }
                    crate::events::send(
                        window,
                        cx,
                        &target,
                        event.position,
                        crate::events::Phase::Start,
                        Some(crate::events::Button::Left),
                        modifier_state(event.modifiers),
                    );
                    cx.stop_propagation();
                }));
            // Every other button reports the DOM pointer events only, with no
            // touch or responder involvement, so `Pressable` never fires for a
            // middle or right click. The right button is only wired here when the
            // view has no `onContextMenu`, since that handler owns the press
            // otherwise and stopping there would hide the pointer event too.
            let middle_node = node.clone();
            handlers
                .middle_down
                .push(Rc::new(move |event: &MouseDownEvent, window, cx| {
                    dispatch_pointer_button(
                        &middle_node,
                        event,
                        crate::events::Button::Middle,
                        window,
                        cx,
                    );
                }));
            // Every node that takes pointer input handles the right button, whether
            // or not it owns a context menu. One press must do both jobs: report
            // `topPointerDown` for the innermost node, and open the nearest
            // ancestor's menu. Splitting them across two nodes is what broke a
            // right click on a `Text` inside a view with `onContextMenu` — the
            // text's listener stopped the press before the parent's ran.
            let right_node = node.clone();
            handlers
                .right_down
                .push(Rc::new(move |event: &MouseDownEvent, window, cx| {
                    dispatch_right_press(&right_node, event, window, cx);
                }));
            // Ctrl + click is the macOS equivalent of a right click. It is a left
            // press, so it must not also start a touch, or a `Pressable` would
            // fire; the check happens before any touch dispatch.
            let ctrl_node = node.clone();
            handlers
                .left_down
                .push(Rc::new(move |event: &MouseDownEvent, window, cx| {
                    if os_owns_press || crate::events::press_belongs_to_window() {
                        return;
                    }
                    let modifiers = modifier_state(event.modifiers);
                    if crate::events::mouse_context_menu_trigger(
                        crate::events::Button::Left,
                        modifiers,
                        std::env::consts::OS,
                    )
                    .is_none()
                    {
                        return;
                    }
                    let Some(entity) = ctrl_node.upgrade() else {
                        return;
                    };
                    let owner = {
                        let this = entity.read(cx);
                        crate::events::context_menu_owner(cx, this)
                    };
                    let Some(owner) = owner else {
                        return;
                    };
                    if !run_component_context_menu(
                        &owner,
                        event.position,
                        false,
                        modifiers,
                        window,
                        cx,
                    ) {
                        dispatch_context_menu(
                            owner.tag,
                            event.position,
                            crate::events::Button::Left,
                            modifiers,
                            "mouse",
                            window,
                            cx,
                        );
                    }
                    cx.stop_propagation();
                }));
            // Not `cx.listener`: a listener updates its entity every time it runs, and
            // gpui-fast rebuilds any view that read an updated entity.
            let move_node = node.clone();
            handlers
                .mouse_move
                .push(Rc::new(move |event: &MouseMoveEvent, window, cx| {
                    let Some(node) = move_node.upgrade() else {
                        return;
                    };
                    let (hit_target, selecting) = {
                        let this = node.read(cx);
                        (
                            crate::events::target(cx, this),
                            this.component == "TextInput" && this.input_selection_anchor.is_some(),
                        )
                    };
                    if event.pressed_button.is_some() {
                        if selecting {
                            node.update(cx, |this, cx| {
                                crate::builtins::textinput::input::select_at_point(
                                    this,
                                    event.position,
                                    true,
                                    window,
                                    cx,
                                );
                            });
                        }
                        // RN keeps the touch target fixed from mouse-down to
                        // release, including when the pointer leaves the view.
                        let target =
                            crate::events::active_touch_target(cx).or_else(|| hit_target.clone());
                        if let Some(target) = target.as_ref() {
                            crate::events::send(
                                window,
                                cx,
                                target,
                                event.position,
                                crate::events::Phase::Move,
                                None,
                                modifier_state(event.modifiers),
                            );
                        }
                    } else {
                        crate::events::hover(window, cx, hit_target.as_ref(), event.position);
                    }
                    if hit_target.is_some() || crate::events::active_touch_target(cx).is_some() {
                        cx.stop_propagation();
                    }
                }));
            handlers
                .left_up
                .push(Rc::new(move |event: &MouseUpEvent, window, cx| {
                    // The release of a caption button is what the OS acts on.
                    if os_owns_press {
                        crate::events::hand_press_to_window();
                        return;
                    }
                    if crate::events::press_belongs_to_window() {
                        return;
                    }
                    let Some(node) = node.upgrade() else {
                        return;
                    };
                    let active_target = crate::events::active_touch_target(cx);
                    if let Some(target) = active_target.as_ref() {
                        crate::events::send(
                            window,
                            cx,
                            target,
                            event.position,
                            crate::events::Phase::End,
                            Some(crate::events::Button::Left),
                            modifier_state(event.modifiers),
                        );
                    }
                    let is_touch_target = {
                        let this = node.read(cx);
                        crate::events::target(cx, this).is_some()
                    };
                    if active_target.is_some() || is_touch_target {
                        cx.stop_propagation();
                    }
                }));
        }
        // Registered after every other press handler, which GPUI runs in reverse
        // order: this one has to see the press before a touch or a context menu
        // consumes it.
        // Anywhere in a drag area — the region itself, or a node inside it that
        // does not take the press — moves the window, and a double click zooms.
        // macOS and Linux do not consult the hit-test, so the move starts here.
        // Windows moves the window itself from the `HTCAPTION` press.
        if control_area == Some(gpui::WindowControlArea::Drag) && !os_owns_press {
            handlers
                .left_down
                .push(Rc::new(move |event: &MouseDownEvent, window, cx| {
                    if event.click_count >= 2 {
                        window.titlebar_double_click();
                    } else {
                        window.start_window_move();
                    }
                    cx.stop_propagation();
                }));
        }
        // A child of a scrolling container moves with its content, so a pointer area
        // here would drift off the viewport. A node that claims a window-control
        // area has the same problem for a different reason: the platform asks
        // which element is under the pointer, and an overlay child sits in front
        // of its own parent, so the area would never be consulted and the window
        // could not be dragged by the node that asked to be draggable.
        if os_owns_press {
            // What is left is a component's own hook — a caption button reporting
            // its pressed state — which may stop propagation; the press still has
            // to reach the OS, which performs the button's action.
            handlers.left_down = handlers
                .left_down
                .into_iter()
                .map(
                    |handler| -> crate::pointer_area::PointerHandler<MouseDownEvent> {
                        Rc::new(move |event: &MouseDownEvent, window, cx| {
                            handler(event, window, cx);
                            cx.propagate();
                        })
                    },
                )
                .collect();
            handlers.left_up = handlers
                .left_up
                .into_iter()
                .map(
                    |handler| -> crate::pointer_area::PointerHandler<MouseUpEvent> {
                        Rc::new(move |event: &MouseUpEvent, window, cx| {
                            handler(event, window, cx);
                            cx.propagate();
                        })
                    },
                )
                .collect();
        }
        let claims_area = control_area.is_some();
        if is_scroll || claims_area {
            // The direct-listener path needs one registration per button, and
            // the middle and side buttons go through it too, so a scroll
            // container reports them the same way a pointer area does.
            for (button, down, up) in [
                (
                    MouseButton::Right,
                    handlers.right_down.clone(),
                    handlers.right_up.clone(),
                ),
                (
                    MouseButton::Left,
                    handlers.left_down.clone(),
                    handlers.left_up.clone(),
                ),
                (
                    MouseButton::Middle,
                    handlers.middle_down.clone(),
                    handlers.middle_up.clone(),
                ),
            ] {
                for handler in down {
                    element = element
                        .on_mouse_down(button, move |event, window, cx| handler(event, window, cx));
                }
                for handler in up {
                    element = element
                        .on_mouse_up(button, move |event, window, cx| handler(event, window, cx));
                }
            }
            for handler in handlers.mouse_move {
                element =
                    element.on_mouse_move(move |event, window, cx| handler(event, window, cx));
            }
            // GPUI's own `on_hover` reports an edge by tracking the hovered state
            // itself, so this path needs no bookkeeping of its own — and it takes
            // only one listener, so the handlers are chained rather than added.
            if !handlers.hover.is_empty() {
                let chained = handlers.hover;
                element = element.on_hover(move |hovered: &bool, window, cx| {
                    for handler in &chained {
                        handler(*hovered, window, cx);
                    }
                });
            }
        } else {
            if !handlers.is_empty() {
                element = element.child(pointer_area(handlers));
            }
        }
        // Not for a scroll container, which never had one: its content is
        // re-parented into the scrolling child and a focus handle here would sit
        // outside it.
        if !is_scroll {
            if let Some(focus_child) = focus_child {
                element = element.child(focus_child);
            }
        }
        if let Some(native_view_host) = &self.native_view_host {
            element = element.child(crate::native_surface::NativeSurfaceElement {
                surface: native_view_host.clone(),
            });
        }
        if let Some(paragraph) = &self.paragraph {
            let mut scaled_paragraph = paragraph.clone();
            for fragment in &mut scaled_paragraph.fragments {
                fragment.font_size = scaled_font_size(fragment.font_size, scale_y);
                fragment.line_height *= scale_y;
                fragment.letter_spacing *= scale_x;
                if let Some(color) = self.animated_text_color {
                    fragment.color = color;
                }
            }
            // `core-private:` a text field paints its own paragraph, in its own
            if self.component == "TextInput" {
                element = crate::builtins::textinput::render::paragraph_content(
                    self,
                    element,
                    &scaled_paragraph,
                    (scale_x, scale_y),
                    frame,
                    window,
                );
            } else {
                element = crate::builtins::textinput::render::plain_paragraph(
                    self,
                    element,
                    &scaled_paragraph,
                    (scale_x, scale_y),
                    frame,
                );
            }
        }
        // `core-private:` the caret and the selection are drawn from the
        if self.component == "TextInput" {
            element = crate::builtins::textinput::render::caret_canvas(
                self,
                element,
                cx.entity(),
                (scale_x, scale_y),
            );
        }
        if let Some(scroll) = scroll {
            let (content_width, content_height) = scroll.content_size;
            let mut content = div()
                .relative()
                .flex_none()
                .w(px(content_width.max(frame.w)))
                .h(px(content_height.max(frame.h)));
            content = content.children(ordered_children.iter().map(|(_, child)| child.clone()));
            // The handle is only written when React or a layout change moved
            // the offset. Writing it on every render would count as a scroll.
            if std::mem::take(&mut self.scroll_handle_stale) {
                self.scroll_handle.set_offset(point(
                    px(-self.scroll_offset().x * scale_x),
                    px(-self.scroll_offset().y * scale_y),
                ));
            }
            let strategy =
                crate::scroll_layers::scroll_strategy(self.subtree_renders_native_surface());
            if scroll.enabled {
                let scroller = Rc::new(Scroller {
                    tag: self.tag,
                    position: self.scroll_position.clone(),
                    handle: self.scroll_handle.clone(),
                    sync_generation: self.scroll_sync_generation.clone(),
                    content_size: scroll.content_size,
                    viewport: (frame.w, frame.h),
                    scale: (scale_x, scale_y),
                    event: scroll.event.clone(),
                });
                content =
                    content.on_scroll_wheel(move |_event: &gpui::ScrollWheelEvent, window, cx| {
                        let scroller = scroller.clone();
                        window.defer(cx, move |window, cx| scroller.sync(window, cx));
                    });
            }
            // The scrolling container is a child filling this node, not the
            // node's own element: whatever sits inside a scrolling container
            // moves with its content, and the indicator must not.
            let mut scroller = div().id("scroller").absolute().top_0().left_0().size_full();
            match strategy {
                crate::scroll_layers::ScrollStrategy::GpuiLayer => {
                    scroller = if !scroll.enabled {
                        scroller.overflow_hidden()
                    } else if scroll.horizontal {
                        scroller.overflow_x_scroll().overflow_y_hidden()
                    } else {
                        scroller.overflow_y_scroll().overflow_x_hidden()
                    };
                    element = element
                        .overflow_hidden()
                        .overflow_clips_corners()
                        .child(scroller.track_scroll(&self.scroll_handle).child(content));
                }
                crate::scroll_layers::ScrollStrategy::ManualOffset => {
                    let (offset_x, offset_y) = (self.scroll_offset().x, self.scroll_offset().y);
                    let moved = div()
                        .relative()
                        .flex_none()
                        .left(px(-offset_x * scale_x))
                        .top(px(-offset_y * scale_y))
                        .w(px(scroll.content_size.0.max(frame.w)))
                        .h(px(scroll.content_size.1.max(frame.h)))
                        .children(ordered_children.iter().map(|(_, child)| child.clone()));
                    if scroll.enabled {
                        let horizontal = scroll.horizontal;
                        let max = (
                            (scroll.content_size.0 - frame.w).max(0.0),
                            (scroll.content_size.1 - frame.h).max(0.0),
                        );
                        let position = self.scroll_position.clone();
                        let handle = self.scroll_handle.clone();
                        let scale = (scale_x, scale_y);
                        let view = cx.entity();
                        scroller = scroller.on_scroll_wheel(
                            move |event: &gpui::ScrollWheelEvent, _window, _cx| {
                                let delta = event.delta.pixel_delta(px(20.));
                                let (dx, dy) = if horizontal {
                                    (f32::from(delta.x) + f32::from(delta.y), 0.0)
                                } else {
                                    (0.0, f32::from(delta.y) + f32::from(delta.x))
                                };
                                let current = position.get();
                                let next = point(
                                    (current.x - dx / scale.0.max(f32::EPSILON)).clamp(0.0, max.0),
                                    (current.y - dy / scale.1.max(f32::EPSILON)).clamp(0.0, max.1),
                                );
                                if (next.x - current.x).abs() < 0.01
                                    && (next.y - current.y).abs() < 0.01
                                {
                                    return;
                                }
                                position.set(next);
                                handle.set_offset(point(
                                    px(-next.x * scale.0),
                                    px(-next.y * scale.1),
                                ));
                                let _ = view.update(_cx, |_, cx| cx.notify());
                            },
                        );
                    }
                    scroller = scroller.overflow_hidden().child(moved);
                    element = element
                        .overflow_hidden()
                        .overflow_clips_corners()
                        .child(scroller);
                }
            }
            if scroll.indicator && scroll.enabled {
                let horizontal = scroll.horizontal;
                if self
                    .scroll_indicator
                    .as_ref()
                    .is_none_or(|indicator| indicator.read(cx).horizontal() != horizontal)
                {
                    let handle = self.scroll_handle.clone();
                    self.scroll_indicator = Some(cx.new(|_| {
                        crate::scroll_indicator::ScrollIndicator::new(handle, horizontal)
                    }));
                }
                element = element.children(self.scroll_indicator.clone());
            } else {
                self.scroll_indicator = None;
            }
        } else if self.host_component.is_some() {
            let chrome_cx = self.host_context();
            let overlay_cx = self.host_context();
            let container = self.host_container;
            let (chrome, overlay) = match self.host_component.as_mut() {
                Some(component) => (
                    Some(component.render(window, chrome_cx)),
                    if container {
                        component.render_overlay(window, overlay_cx)
                    } else {
                        None
                    },
                ),
                None => (None, None),
            };
            schedule_frame_host_report_flush(&self.host_reports, window, cx);
            element = element
                .children(chrome)
                .children(
                    ordered_children
                        .iter()
                        .map(|(_, child)| child.clone().into_any_element()),
                )
                .children(overlay);
        } else {
            let content =
                crate::extensions::component_renderer(&self.component).and_then(|renderer| {
                    let node = self.component_node(cx);
                    renderer.content(&node, window, cx)
                });
            let painted: Vec<AnyElement> = content
                .into_iter()
                .chain(
                    ordered_children
                        .iter()
                        .map(|(_, child)| child.clone().into_any_element()),
                )
                .collect();
            let painted = match crate::extensions::component_renderer(&self.component) {
                Some(renderer) => renderer.children(&self.component_node(cx), painted, window, cx),
                None => painted,
            };
            element = element.children(painted);
            if self.component == "TextInput" && !self.input_multiline {
                element = element.on_scroll_wheel(cx.listener(
                    |this, event: &gpui::ScrollWheelEvent, window, cx| {
                        let delta = match &event.delta {
                            gpui::ScrollDelta::Pixels(delta) => {
                                let x = f32::from(delta.x);
                                if x.abs() > 0.0 {
                                    x
                                } else {
                                    f32::from(delta.y)
                                }
                            }
                            gpui::ScrollDelta::Lines(lines) => {
                                if lines.x.abs() > 0.0 {
                                    lines.x * 40.0
                                } else {
                                    lines.y * 40.0
                                }
                            }
                        };
                        let viewport = (this.frame.w
                            - this.view.content_insets.left
                            - this.view.content_insets.right)
                            .max(0.0);
                        let natural_width = this
                            .paragraph
                            .as_ref()
                            .map(|paragraph| {
                                let line = this.input_text.split('\n').next().unwrap_or_default();
                                crate::text::input_caret_x(
                                    window.text_system(),
                                    paragraph,
                                    line,
                                    line.len(),
                                )
                            })
                            .unwrap_or(0.0);
                        let max_offset = (natural_width - viewport).max(0.0);
                        let next = (this.input_scroll_x - delta).clamp(0.0, max_offset);
                        if (next - this.input_scroll_x).abs() > f32::EPSILON {
                            this.input_scroll_x = next;
                            cx.notify();
                            cx.stop_propagation();
                        }
                    },
                ));
            }
        }
        let width = frame.w * scale_x;
        let height = frame.h * scale_y;
        let edges = [
            (
                0,
                0.0,
                0.0,
                height,
                self.view.border_widths.left * scale_x,
                false,
            ),
            (
                1,
                0.0,
                0.0,
                width,
                self.view.border_widths.top * scale_y,
                true,
            ),
            (
                2,
                width - self.view.border_widths.right * scale_x,
                0.0,
                height,
                self.view.border_widths.right * scale_x,
                false,
            ),
            (
                3,
                0.0,
                height - self.view.border_widths.bottom * scale_y,
                width,
                self.view.border_widths.bottom * scale_y,
                true,
            ),
        ];
        let mut border_rules = Vec::new();
        for (edge, x, y, length, thickness, horizontal) in edges {
            let color = self.view.border_colors[edge];
            if color != 0 && thickness > 0.0 {
                border_rules.extend(rule_segments(
                    x,
                    y,
                    length,
                    thickness,
                    horizontal,
                    color,
                    self.view.border_styles[edge],
                ));
            }
        }
        if !border_rules.is_empty() {
            let mut border_clip = div()
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .overflow_hidden();
            {
                let radii = &mut border_clip.style().corner_radii;
                radii.top_left = Some(px(self.view.border_radii.tl * scale_x.min(scale_y)).into());
                radii.top_right = Some(px(self.view.border_radii.tr * scale_x.min(scale_y)).into());
                radii.bottom_right =
                    Some(px(self.view.border_radii.br * scale_x.min(scale_y)).into());
                radii.bottom_left =
                    Some(px(self.view.border_radii.bl * scale_x.min(scale_y)).into());
            }
            element = element.child(border_clip.children(border_rules));
        }
        let mut outline_rules = Vec::new();
        if self.view.outline_color != 0 && self.view.outline_width > 0.0 {
            let outline_width_x = self.view.outline_width * scale_x;
            let outline_width_y = self.view.outline_width * scale_y;
            let offset_x = self.view.outline_offset * scale_x;
            let offset_y = self.view.outline_offset * scale_y;
            let x = -offset_x - outline_width_x;
            let y = -offset_y - outline_width_y;
            outline_rules.extend(rule_segments(
                x,
                y,
                width + 2.0 * offset_x,
                outline_width_y,
                true,
                self.view.outline_color,
                self.view.outline_style,
            ));
            outline_rules.extend(rule_segments(
                x,
                height + offset_y,
                width + 2.0 * offset_x,
                outline_width_y,
                true,
                self.view.outline_color,
                self.view.outline_style,
            ));
            outline_rules.extend(rule_segments(
                x,
                y + outline_width_y,
                height + 2.0 * offset_y,
                outline_width_x,
                false,
                self.view.outline_color,
                self.view.outline_style,
            ));
            outline_rules.extend(rule_segments(
                width + offset_x,
                y + outline_width_y,
                height + 2.0 * offset_y,
                outline_width_x,
                false,
                self.view.outline_color,
                self.view.outline_style,
            ));
        }
        if window.last_input_was_keyboard()
            && self
                .focus_handle
                .as_ref()
                .is_some_and(|focus| focus.is_focused(window))
        {
            let focus_color = 0xff60a5fa;
            let ring = 2.0;
            outline_rules.extend(rule_segments(
                -ring,
                -ring,
                width + ring * 2.0,
                ring,
                true,
                focus_color,
                0,
            ));
            outline_rules.extend(rule_segments(
                -ring,
                height,
                width + ring * 2.0,
                ring,
                true,
                focus_color,
                0,
            ));
            outline_rules.extend(rule_segments(
                -ring,
                0.0,
                height,
                ring,
                false,
                focus_color,
                0,
            ));
            outline_rules.extend(rule_segments(
                width,
                0.0,
                height,
                ring,
                false,
                focus_color,
                0,
            ));
        }
        element.children(outline_rules).into_any_element()
    }
}

fn rule_segments(
    x: f32,
    y: f32,
    length: f32,
    thickness: f32,
    horizontal: bool,
    argb: u32,
    style: u8,
) -> Vec<gpui::Div> {
    let mut rules = Vec::new();
    for (offset, painted) in rule_segment_spans(length, thickness, style) {
        let (left, top, width, height) = if horizontal {
            (x + offset, y, painted, thickness)
        } else {
            (x, y + offset, thickness, painted)
        };
        rules.push(
            div()
                .absolute()
                .left(px(left))
                .top(px(top))
                .w(px(width))
                .h(px(height))
                .bg(style::color(argb)),
        );
    }
    rules
}

fn rule_segment_spans(length: f32, thickness: f32, style: u8) -> Vec<(f32, f32)> {
    if !length.is_finite() || !thickness.is_finite() || length <= 0.0 || thickness <= 0.0 {
        return Vec::new();
    }
    let (segment, gap) = match style {
        1 => (thickness, thickness),
        2 => (thickness * 3.0, thickness * 2.0),
        _ => (length, 0.0),
    };
    let mut spans = Vec::new();
    let mut offset = 0.0;
    while offset < length {
        let painted = segment.min(length - offset);
        spans.push((offset, painted));
        offset += painted + gap;
    }
    spans
}

/// The node's side of a host component: it is created from
/// the registry index on its op, handed new props only when C++ sent a handle,
/// and never looks the component up by name.
#[cfg(test)]
mod host_component_node_tests {
    use super::*;
    use crate::host_component::{
        declare_host_component, register_component, EmitterHandle, HostArg, HostComponentOptions,
        HostComponentSpec, HostContext, HostObject, PropsHandle, TEST_HANDLE,
    };
    use rn_gpui_sys::ffi::{MountKind, ParagraphFlat};
    use std::cell::RefCell;

    thread_local! {
        static LOG: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
    }

    fn log() -> Vec<String> {
        LOG.with(|log| log.borrow().clone())
    }

    struct Fake;

    impl HostObject for Fake {
        fn update(&mut self, _props: PropsHandle, changed: &[u64], _cx: HostContext) {
            LOG.with(|log| log.borrow_mut().push(format!("update {changed:?}")));
        }

        fn render(&mut self, _window: &mut Window, _cx: HostContext) -> AnyElement {
            gpui::IntoElement::into_any_element(gpui::div())
        }

        fn render_overlay(&mut self, _window: &mut Window, _cx: HostContext) -> Option<AnyElement> {
            None
        }

        fn command(&mut self, index: u32, args: &[HostArg], _cx: HostContext) {
            LOG.with(|log| log.borrow_mut().push(format!("command {index} {args:?}")));
        }
    }

    struct FakeSpec;

    impl HostComponentSpec for FakeSpec {
        const NAME: &'static str = "NodeTestFake";

        fn create(
            _props: PropsHandle,
            _emitter: EmitterHandle,
            mut cx: HostContext,
        ) -> Box<dyn HostObject> {
            LOG.with(|log| log.borrow_mut().push("create".to_string()));
            cx.set_intrinsic_size(7.0, 9.0);
            Box::new(Fake)
        }
    }

    const REGISTERED: u32 = 960;
    const UNREGISTERED: u32 = 961;

    fn declare() {
        declare_host_component(
            REGISTERED,
            FakeSpec::NAME,
            HostComponentOptions {
                container: true,
                ..Default::default()
            },
        );
        register_component(FakeSpec);
        declare_host_component(
            UNREGISTERED,
            "NodeTestUnregistered",
            HostComponentOptions::default(),
        );
    }

    fn op(kind: MountKind, index: i32) -> MountOp {
        MountOp {
            kind,
            tag: 42,
            parent_tag: -1,
            index: 0,
            component: "NodeTestFake".into(),
            native_view_name: String::new(),
            native_view_props: "{}".into(),
            frame: RectF {
                x: 0.0,
                y: 0.0,
                w: 10.0,
                h: 10.0,
            },
            props_changed: true,
            view: ViewPropsFlat::default(),
            extension_props_json: String::new(),
            host_index: index,
            host_props_handle: 0,
            host_emitter_handle: 0,
            host_changed: 0,
            host_changed_more: Vec::new(),
            has_paragraph: false,
            paragraph: ParagraphFlat::default(),
            layout_changed: false,
        }
    }

    fn queue() -> crate::store::HostReportQueue {
        std::rc::Rc::new(crate::host_component::HostReports::default())
    }

    #[test]
    fn a_node_creates_its_component_from_the_index_on_its_op() {
        declare();
        LOG.with(|log| log.borrow_mut().clear());
        let mut create = op(MountKind::Create, REGISTERED as i32);
        create.host_props_handle = TEST_HANDLE;
        create.host_emitter_handle = TEST_HANDLE;
        let reports = queue();
        let node = RNNodeView::from_op(&create, 1, reports.clone());
        assert!(node.host_component.is_some());
        assert!(
            node.host_container,
            "the declaration says it is a container"
        );
        assert_eq!(log(), vec!["create".to_string()]);
        assert_eq!(reports.take().len(), 1);
    }

    #[test]
    fn an_op_without_a_host_index_never_touches_the_registry() {
        declare();
        let node = RNNodeView::from_op(&op(MountKind::Create, -1), 1, queue());
        assert!(node.host_component.is_none());
        assert!(!node.host_container);
    }

    #[test]
    fn a_declaration_nobody_registered_leaves_the_node_empty() {
        declare();
        let mut create = op(MountKind::Create, UNREGISTERED as i32);
        create.host_props_handle = TEST_HANDLE;
        create.host_emitter_handle = TEST_HANDLE;
        let node = RNNodeView::from_op(&create, 1, queue());
        assert!(node.host_component.is_none());
    }

    #[test]
    fn an_update_reaches_the_component_only_when_c_plus_plus_sent_props() {
        declare();
        LOG.with(|log| log.borrow_mut().clear());
        let mut create = op(MountKind::Create, REGISTERED as i32);
        create.host_props_handle = TEST_HANDLE;
        create.host_emitter_handle = TEST_HANDLE;
        let mut node = RNNodeView::from_op(&create, 1, queue());

        node.update_from_op(&op(MountKind::Update, REGISTERED as i32));
        assert_eq!(log(), vec!["create".to_string()]);

        let mut update = op(MountKind::Update, REGISTERED as i32);
        update.host_props_handle = TEST_HANDLE;
        update.host_changed = 0b101;
        update.host_changed_more = vec![0b1];
        node.update_from_op(&update);
        assert_eq!(
            log(),
            vec!["create".to_string(), "update [5, 1]".to_string()]
        );
    }
}

#[cfg(test)]
mod border_segment_tests {
    use super::rule_segment_spans;

    #[test]
    fn solid_rule_is_one_segment() {
        assert_eq!(rule_segment_spans(25.0, 3.0, 0), vec![(0.0, 25.0)]);
    }

    #[test]
    fn dotted_and_dashed_rules_clamp_the_last_segment() {
        assert_eq!(
            rule_segment_spans(10.0, 3.0, 1),
            vec![(0.0, 3.0), (6.0, 3.0)]
        );
        assert_eq!(
            rule_segment_spans(20.0, 3.0, 2),
            vec![(0.0, 9.0), (15.0, 5.0)]
        );
    }

    #[test]
    fn nonpositive_or_nonfinite_geometry_is_empty() {
        assert!(rule_segment_spans(0.0, 2.0, 2).is_empty());
        assert!(rule_segment_spans(2.0, 0.0, 2).is_empty());
        assert!(rule_segment_spans(f32::INFINITY, 2.0, 2).is_empty());
    }
}

const SCROLL_STATE_SYNC_DELAY: std::time::Duration = std::time::Duration::from_millis(100);

impl RNNodeView {
    /// The intrinsic size Fabric last reported, if the component measures.
    pub fn intrinsic_size(&self) -> Option<(f32, f32)> {
        self.intrinsic_size
    }

    /// Records the size the store just delivered, for the test driver and for
    /// diagnostics. Yoga reads the shadow node's state, not this.
    pub(crate) fn set_intrinsic_size(&mut self, width: f32, height: f32) {
        self.intrinsic_size = Some((width, height));
    }

    /// A context whose reports go to the store's queue.
    pub(crate) fn host_reports(&self) -> crate::store::HostReportQueue {
        self.host_reports.clone()
    }

    fn host_context(&self) -> crate::host_component::HostContext {
        crate::host_component::HostContext::queued(self.tag, self.host_reports.clone())
    }

    /// The same, with the store handle a command can act through.
    fn host_context_with_handle(
        &self,
        handle: crate::extensions::StoreHandle,
    ) -> crate::host_component::HostContext {
        crate::host_component::HostContext::queued_with_handle(
            self.tag,
            self.host_reports.clone(),
            handle,
        )
    }

    pub fn scroll_offset(&self) -> Point<f32> {
        self.scroll_position.get()
    }

    /// Runs a Fabric command on this node's host component.
    pub(crate) fn dispatch_host_command(
        &mut self,
        command: u32,
        args: &[crate::host_component::HostArg],
        cx: &mut gpui::App,
    ) {
        if self.host_component.is_none() {
            log::debug!(
                "[host-component] command {command} for tag {} with no component",
                self.tag
            );
            return;
        }
        let handle = crate::store::store_from(cx)
            .map(|store| crate::extensions::StoreHandle::new(store.downgrade()));
        let host = match handle {
            Some(handle) => self.host_context_with_handle(handle),
            None => self.host_context(),
        };
        if let Some(component) = self.host_component.as_mut() {
            component.command(command, args, host);
        }
        if !self.host_reports.is_empty() {
            if let Some(store) = crate::store::store_from(cx) {
                cx.defer(move |cx| {
                    store.update(cx, |store, cx| store.flush_host_reports(cx));
                });
            }
        }
    }

    /// How this node scrolls its content, by name, if it scrolls.
    pub(crate) fn scroll_strategy_name(&self) -> Option<&'static str> {
        self.scroll.as_ref()?;
        Some(
            match crate::scroll_layers::scroll_strategy(self.subtree_renders_native_surface()) {
                crate::scroll_layers::ScrollStrategy::GpuiLayer => "GpuiLayer",
                crate::scroll_layers::ScrollStrategy::ManualOffset => "ManualOffset",
            },
        )
    }

    pub(crate) fn extension_props_json(&self) -> &str {
        &self.extension_props_json
    }

    /// The window-control area a press on this node lands in, if any.
    ///
    /// The node's own area when it claims one. Otherwise, a node that does not
    /// take the press itself answers for the area around it: the platform asks
    /// for the frontmost element under the pointer, and every node paints in
    /// front of its parent, so a title bar's spacer, its title text, or the glyph
    /// inside a caption button would otherwise answer "client" over the very
    /// area that contains it — no drag, no double-click to maximize, and on
    /// Windows no caption button either, since the OS performs those actions
    /// from the hit-test. A node that does take the press (a `Pressable`, a text
    /// input, a scroll view) stays client, so a button inside a title bar is
    /// still a button, and so is everything inside it.
    fn window_control_area(&self, _cx: &gpui::App) -> Option<gpui::WindowControlArea> {
        match self.window_control_role() {
            WindowControlRole::Claims(area) => Some(area),
            WindowControlRole::TakesPress => None,
            // Inherited by the store's pass rather than walked here: this runs
            // while rendering, when an ancestor may be the entity being updated,
            // and reading it then panics.
            WindowControlRole::Passive => self.inherited.window_control_area,
        }
    }

    /// What this node does with a press, as far as window controls are concerned.
    pub(crate) fn window_control_role(&self) -> WindowControlRole {
        if let Some(area) = self.own_window_control_area() {
            WindowControlRole::Claims(area)
        } else if self.takes_own_press() {
            WindowControlRole::TakesPress
        } else {
            WindowControlRole::Passive
        }
    }

    /// Whether a press on this node belongs to it rather than to a window-control
    /// area around it.
    ///
    /// `box-none` never takes a press for itself. Otherwise a node owns it when
    /// it can act on it: focusable (what `Pressable` sets), a tap or context-menu
    /// listener, a scroll view, or a component that asked for mouse input.
    /// `accessibilityRespondsToUserInteraction` is not a signal: Fabric defaults
    /// it to true on every view, so it would make all of them take the press.
    fn takes_own_press(&self) -> bool {
        if matches!(
            self.view.pointer_events,
            crate::events::POINTER_EVENTS_BOX_NONE | crate::events::POINTER_EVENTS_NONE
        ) {
            return false;
        }
        if self.focusable
            || self.view.accessibility_has_tap_listener
            || self.view.on_context_menu
            || self.scroll.is_some()
        {
            return true;
        }
        crate::extensions::component_renderer(&self.component).is_some_and(|renderer| {
            let spec = renderer.input(&self.component_node_shallow());
            spec.hover || spec.mouse_buttons != crate::extensions::input::ButtonSet::NONE
        })
    }

    /// The area this node claims for itself: a caption button's, or a drag
    /// region's.
    ///
    /// A component's `window_control()` hook is the only way to claim a caption
    /// button now that `desktopWindowControl` is gone. `desktopDragRegion` still
    /// marks a drag area, and a component that claimed a button overrides it so a
    /// button inside a title bar acts as a button and does not drag the window.
    fn own_window_control_area(&self) -> Option<gpui::WindowControlArea> {
        let claimed = crate::extensions::component_renderer(&self.component)
            .and_then(|renderer| renderer.window_control(&self.component_node_shallow()));
        match claimed {
            Some(crate::extensions::input::WindowControl::Minimize) => {
                Some(gpui::WindowControlArea::Min)
            }
            Some(crate::extensions::input::WindowControl::Maximize) => {
                Some(gpui::WindowControlArea::Max)
            }
            Some(crate::extensions::input::WindowControl::Close) => {
                Some(gpui::WindowControlArea::Close)
            }
            Some(crate::extensions::input::WindowControl::Drag) => {
                Some(gpui::WindowControlArea::Drag)
            }
            None if self.view.desktop_drag_region => Some(gpui::WindowControlArea::Drag),
            None => None,
        }
    }

    pub(crate) fn component_node_shallow(&self) -> crate::extensions::ComponentNode {
        crate::extensions::ComponentNode {
            component: self.component.clone(),
            tag: self.tag,
            frame: self.frame,
            scale: (self.inherited.scale.0.abs(), self.inherited.scale.1.abs()),
            props: self.extension_props.clone(),
            parent: self.parent_tag_cached(),
            children: Vec::new(),
        }
    }

    pub(crate) fn child_tags(&self) -> Vec<i32> {
        self.children.iter().map(|(tag, _)| *tag).collect()
    }

    /// What a `TreeView` keeps about this node, copied so the tree never reads
    /// an entity a hook may be updating.
    pub(crate) fn snapshot(&self) -> crate::extensions::NodeSnapshot {
        #[cfg(test)]
        SNAPSHOT_COUNT.with(|count| count.set(count.get() + 1));
        self.snapshot_inner()
    }

    fn snapshot_inner(&self) -> crate::extensions::NodeSnapshot {
        crate::extensions::NodeSnapshot {
            component: self.component.clone(),
            tag: self.tag,
            frame: self.frame,
            scale: (self.inherited.scale.0.abs(), self.inherited.scale.1.abs()),
            props: self.extension_props.clone(),
            parent: self.parent_tag_cached(),
            children: self.child_tags(),
            surface_id: self.surface_id,
            transition: self.transition_state(),
        }
    }

    pub(crate) fn component_node(&self, cx: &App) -> crate::extensions::ComponentNode {
        crate::extensions::ComponentNode {
            component: self.component.clone(),
            tag: self.tag,
            frame: self.frame,
            scale: (self.inherited.scale.0.abs(), self.inherited.scale.1.abs()),
            props: self.extension_props.clone(),
            parent: self.parent_tag_cached(),
            children: self
                .children
                .iter()
                .map(|(_, child)| child.read(cx).component_node(cx))
                .collect(),
        }
    }

    pub(crate) fn parent_tag_cached(&self) -> Option<i32> {
        self.parent_tag_cache.get()
    }
}

struct Scroller {
    tag: i32,
    position: Rc<Cell<Point<f32>>>,
    handle: gpui::ScrollHandle,
    sync_generation: Rc<Cell<u64>>,
    content_size: (f32, f32),
    event: Option<String>,
    viewport: (f32, f32),
    scale: (f32, f32),
}

impl Scroller {
    fn sync(&self, window: &mut Window, cx: &mut App) {
        let scrolled = self.handle.offset();
        let offset = point(
            -f32::from(scrolled.x) / self.scale.0.max(f32::EPSILON),
            -f32::from(scrolled.y) / self.scale.1.max(f32::EPSILON),
        );
        let old = self.position.get();
        if (offset.x - old.x).abs() < 0.01 && (offset.y - old.y).abs() < 0.01 {
            return;
        }
        self.position.set(offset);
        let Some(store) = cx.try_global::<crate::store::StoreGlobal>() else {
            return;
        };
        let (host, frame_hook) = {
            let store = store.0.read(cx);
            (store.host.clone(), store.frame_hook.clone())
        };
        let payload = serde_json::json!({
            "contentOffset": {"x": offset.x, "y": offset.y},
            "contentSize": {"width": self.content_size.0, "height": self.content_size.1},
            "layoutMeasurement": {"width": self.viewport.0, "height": self.viewport.1},
            "zoomScale": 1
        });
        if let Some(event) = &self.event {
            host.dispatch_event(self.tag, event, &payload);
        }
        frame_hook.arm(window);
        // Fabric's copy of the offset costs a commit per update, so it follows once
        // scrolling pauses.
        let generation = self.sync_generation.get() + 1;
        self.sync_generation.set(generation);
        let (tag, position, sync_generation) = (
            self.tag,
            self.position.clone(),
            self.sync_generation.clone(),
        );
        cx.spawn(async move |cx| {
            cx.background_executor()
                .timer(SCROLL_STATE_SYNC_DELAY)
                .await;
            if sync_generation.get() == generation {
                let offset = position.get();
                host.set_scroll_offset(tag, offset.x, offset.y);
            }
        })
        .detach();
    }
}

pub(crate) fn decode_data_image(data: &str) -> Option<gpui::Image> {
    use base64::Engine;
    let (metadata, payload) = data.split_once(',')?;
    if !metadata.ends_with(";base64") {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .ok()?;
    let mime = metadata.strip_prefix("image/")?.trim_end_matches(";base64");
    let format = match mime {
        "png" => gpui::ImageFormat::Png,
        "jpeg" | "jpg" => gpui::ImageFormat::Jpeg,
        "webp" => gpui::ImageFormat::Webp,
        "gif" => gpui::ImageFormat::Gif,
        "svg+xml" | "svg" => gpui::ImageFormat::Svg,
        "bmp" => gpui::ImageFormat::Bmp,
        "tiff" | "tif" => gpui::ImageFormat::Tiff,
        "ico" => gpui::ImageFormat::Ico,
        _ => return None,
    };
    Some(gpui::Image::from_bytes(format, bytes))
}

/// A transform scales text by shaping it at a scaled font size. GPUI keeps the
/// glyphs of every size it has drawn, so a scale animation that produced a new
/// size each frame would grow the glyph atlas without bound; snapping the size
/// to quarter points keeps the set of sizes small.
fn scaled_font_size(font_size: f32, scale: f32) -> f32 {
    if scale == 1.0 {
        return font_size;
    }
    (font_size * scale * 4.0).round() / 4.0
}

#[cfg(test)]
mod scaled_font_size_tests {
    use super::scaled_font_size;

    #[test]
    fn unscaled_text_keeps_its_size() {
        assert_eq!(scaled_font_size(13.3, 1.0), 13.3);
    }

    #[test]
    fn a_scale_animation_draws_a_bounded_set_of_sizes() {
        let sizes: std::collections::BTreeSet<u32> = (0..10_000)
            .map(|step| 0.7 + 0.7 * step as f32 / 10_000.0)
            .map(|scale| (scaled_font_size(14.0, scale) * 4.0) as u32)
            .collect();
        assert!(sizes.len() <= 40, "{} sizes", sizes.len());
    }
}
