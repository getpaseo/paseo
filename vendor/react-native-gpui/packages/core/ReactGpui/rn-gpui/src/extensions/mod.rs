pub mod input;

use gpui::{AnyElement, App, Window};
use rn_gpui_sys::ffi::RectF;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// A read-only view of one mounted component.
///
/// Core builds it for the renderer and the observer; a module reads it and
/// never keeps it, because the tree it describes is replaced on the next mount.
/// A hook that only needs the node's own fields — everything added for the
/// whole-batch and structural callbacks — receives one with no children, so the
/// cost does not grow with the subtree.
#[derive(Clone, Debug)]
pub struct ComponentNode {
    pub component: String,
    pub tag: i32,
    pub frame: RectF,
    /// The scale a transform has accumulated down to this node and its own.
    ///
    /// A hook that draws something inside the node — a modal sheet, a caret —
    /// has to multiply by this, because the frame it was given is in unscaled
    /// coordinates while the element it returns is painted scaled.
    pub scale: (f32, f32),
    pub props: Arc<Value>,
    pub parent: Option<i32>,
    pub children: Vec<ComponentNode>,
}

impl ComponentNode {
    /// The first component in this subtree with this test id.
    pub fn find_test_id(&self, test_id: &str) -> Option<&ComponentNode> {
        if self.props.get("testID").and_then(Value::as_str) == Some(test_id) {
            return Some(self);
        }
        self.children
            .iter()
            .find_map(|child| child.find_test_id(test_id))
    }
}

/// Where a node sits between two poses during a transition.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pose {
    pub offset_x: f32,
    pub opacity: f32,
}

/// A node transition: movement between two poses over a duration.
///
/// Core owns the timing and the paint, so the same API serves a navigation push,
/// a fade and anything else that moves a node. A module supplies only the poses
/// its platform's transitions correspond to.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Transition {
    pub from: Pose,
    pub to: Pose,
    pub duration: Duration,
}

impl Transition {
    /// The pose at `progress`, a plain lerp between `from` and `to`.
    pub fn pose_at(&self, progress: f32) -> Pose {
        let progress = progress.clamp(0.0, 1.0);
        Pose {
            offset_x: self.from.offset_x + (self.to.offset_x - self.from.offset_x) * progress,
            opacity: self.from.opacity + (self.to.opacity - self.from.opacity) * progress,
        }
    }

    /// Smoothstep of the elapsed fraction, clamped to `0.0..=1.0`.
    pub fn progress_now(&self, started_at: Instant) -> f32 {
        let duration = self.duration.as_secs_f32().max(f32::EPSILON);
        let linear = ((Instant::now() - started_at).as_secs_f32() / duration).clamp(0.0, 1.0);
        linear * linear * (3.0 - 2.0 * linear)
    }
}

/// A transition in progress, as the tree reports it.
#[derive(Clone, Copy, Debug)]
pub struct TransitionState {
    pub transition: Transition,
    pub started_at: Instant,
    pub progress: f32,
}

/// What a `StoreObserver` may ask core to do, beyond reading the tree.
///
/// A handle is cheap to clone and may be moved into a closure. Inside a batch
/// core records what it is asked to do and applies it as the hook returns,
/// because the store is already leased for the mutation; outside a batch a
/// command takes effect immediately.
#[derive(Clone)]
pub struct StoreHandle {
    store: gpui::WeakEntity<crate::store::ViewStore>,
    queued: Option<Arc<Mutex<Vec<Command>>>>,
}

/// A closure a queued [`Command::After`] runs once its timer fires.
///
/// It is behind a mutex and an `Option` so the command can be moved into the
/// queue and still be taken exactly once when the timer runs.
pub type DeferredRun = Arc<Mutex<Option<Box<dyn FnOnce(&mut App) + Send>>>>;

/// One deferred command, recorded while the store is leased.
pub enum Command {
    Transition {
        tag: i32,
        transition: Transition,
    },
    ClearTransition {
        tag: i32,
    },
    Dispatch {
        tag: i32,
        name: String,
        payload: Value,
    },
    Wake,
    After {
        duration: Duration,
        run: DeferredRun,
    },
    ReleaseRetained {
        tag: i32,
    },
}

impl StoreHandle {
    /// A handle that acts immediately, for a hook outside a batch.
    pub(crate) fn new(store: gpui::WeakEntity<crate::store::ViewStore>) -> Self {
        Self {
            store,
            queued: None,
        }
    }

    /// A handle that records instead of acting, for the inside of a batch.
    pub(crate) fn queued(
        store: gpui::WeakEntity<crate::store::ViewStore>,
        queued: Arc<Mutex<Vec<Command>>>,
    ) -> Self {
        Self {
            store,
            queued: Some(queued),
        }
    }

    fn record(&self, command: Command) -> bool {
        match &self.queued {
            Some(queued) => {
                queued.lock().expect("command queue poisoned").push(command);
                true
            }
            None => false,
        }
    }

    /// Emits `name` to JS for `tag`. An empty payload sends `{}`.
    pub fn dispatch_event(&self, tag: i32, name: &str, payload: &Value, cx: &mut App) {
        if self.record(Command::Dispatch {
            tag,
            name: name.to_string(),
            payload: payload.clone(),
        }) {
            return;
        }
        let Some(store) = self.store.upgrade() else {
            return;
        };
        store.read(cx).host.dispatch_event(tag, name, payload);
    }

    /// Lets Fabric deliver callbacks after a timer fired.
    pub fn wake(&self, cx: &mut App) {
        if self.record(Command::Wake) {
            return;
        }
        let Some(store) = self.store.upgrade() else {
            return;
        };
        store.read(cx).host.on_render();
    }

    /// Starts `transition` on a component.
    pub fn start_transition(&self, tag: i32, transition: Transition, cx: &mut App) {
        if self.record(Command::Transition { tag, transition }) {
            return;
        }
        if let Some(store) = self.store.upgrade() {
            crate::store::start_component_transition(&store, tag, transition, cx);
        }
    }

    /// Removes a component's transition and notifies it.
    pub fn clear_transition(&self, tag: i32, cx: &mut App) {
        if self.record(Command::ClearTransition { tag }) {
            return;
        }
        if let Some(store) = self.store.upgrade() {
            crate::store::clear_node_transition(&store, tag, cx);
        }
    }

    /// Asks for the next frame, so an animation can advance.
    pub fn request_frame(&self, window: &mut Window) {
        let _ = window;
    }

    /// Keeps a node attached to its parent though React Native removed it.
    ///
    /// Only valid from `before_batch`; anywhere else it warns and does nothing,
    /// because the mutation it would interrupt has already run.
    /// Keeps a node attached to its parent though React Native removed it.
    ///
    /// Only valid from `before_batch`; anywhere else it warns and does nothing,
    /// because the mutation it would interrupt has already run.
    pub fn retain_subtree(&self, tag: i32) {
        if self.record(Command::Wake) {
            log::warn!("[extensions] retain_subtree is only valid in before_batch");
            return;
        }
        crate::store::request_retain_subtree(tag);
    }

    /// Detaches a subtree `retain_subtree` kept, and re-evaluates the tree.
    pub fn release_retained(&self, tag: i32, cx: &mut App) {
        if self.record(Command::ReleaseRetained { tag }) {
            return;
        }
        if let Some(store) = self.store.upgrade() {
            crate::store::release_retained_subtree(&store, tag, cx);
        }
    }

    /// Runs `f` after `duration`, with a handle that acts immediately.
    pub fn after(
        &self,
        duration: Duration,
        cx: &mut App,
        f: impl FnOnce(&StoreHandle, &mut App) + Send + 'static,
    ) {
        let store = self.store.clone();
        let run: DeferredRun = Arc::new(Mutex::new(Some(Box::new(move |cx: &mut App| {
            let handle = StoreHandle::new(store.clone());
            f(&handle, cx);
        }))));
        if self.record(Command::After {
            duration,
            run: run.clone(),
        }) {
            return;
        }
        let Some(store) = self.store.upgrade() else {
            return;
        };
        crate::store::after_on_store(store, duration, cx, move |cx| {
            if let Some(run) = run.lock().ok().and_then(|mut slot| slot.take()) {
                run(cx);
            }
        });
    }

    /// Whether animations may run: the system and the app both allow them.
    pub fn animations_enabled(&self, cx: &App) -> bool {
        let Some(store) = self.store.upgrade() else {
            return false;
        };
        store.read(cx).animations_enabled(cx)
    }

    /// Runs `f` with a read-only view of the mounted tree.
    pub fn with_tree(&self, cx: &App, f: impl FnOnce(&TreeView)) {
        let Some(store) = self.store.upgrade() else {
            return;
        };
        let store = store.read(cx);
        f(&store.tree_view(cx));
    }
}

/// A read-only view of the mounted tree.
///
/// It exists so a module can answer structural questions — what a node's parent
/// is, which of its children are live, whether an ancestor is hiding it — without
/// holding a lease on the store, which core owns while it applies a batch.
///
/// Core may build it around a node it is already holding, so a query about that
/// node is answered from the reference rather than by reading its entity.
/// A read-only view of the mounted tree.
///
/// It exists so a module can answer structural questions — what a node's parent
/// is, which of its children are live, whether an ancestor is hiding it — without
/// holding a lease on the store, which core owns while it applies a batch.
///
/// Core may build it around a node it is already holding, so a query about that
/// node is answered from the reference rather than by reading its entity.
pub struct TreeView<'a> {
    pub(crate) nodes: std::borrow::Cow<'a, HashMap<i32, NodeSnapshot>>,
    pub(crate) root_tags: Vec<i32>,
    pub(crate) top_inset: f32,
    pub(crate) animations_enabled: bool,
    pub(crate) current: Option<(i32, NodeSnapshot)>,
    pub(crate) retained: &'a HashMap<i32, Vec<i32>>,
}

/// What the tree needs to know about one node, copied out of its entity.
///
/// The view owns these rather than holding the entities themselves: a hook is
/// given `&mut App`, so a tree that kept entity handles could read a node that
/// the same call is updating. Copying costs a string and a small prop map per
/// node, and removes the aliasing entirely.
#[derive(Clone, Debug)]
pub(crate) struct NodeSnapshot {
    pub(crate) component: String,
    pub(crate) tag: i32,
    pub(crate) frame: RectF,
    pub(crate) scale: (f32, f32),
    pub(crate) props: Arc<Value>,
    pub(crate) parent: Option<i32>,
    pub(crate) children: Vec<i32>,
    pub(crate) surface_id: i32,
    pub(crate) transition: Option<TransitionState>,
}

/// One node of a tree built by [`TreeView::for_test`].
#[cfg(any(test, feature = "test-driver"))]
pub struct TestNode {
    pub tag: i32,
    pub component: String,
    pub frame: RectF,
    pub scale: (f32, f32),
    pub props: Value,
}

impl<'a> TreeView<'a> {
    /// A tree built from plain values, for a module's own unit tests.
    ///
    /// Real hooks run against a store; a module that only wants to check what
    /// its renderer computes can hand it a tree instead of starting an app.
    /// `edges` is `(parent, child)`, and every tag it mentions must be in
    /// `nodes`.
    ///
    /// Compiled whenever the test driver is: a module's tests are a different
    /// crate, so `cfg(test)` in core would not reach them.
    #[cfg(any(test, feature = "test-driver"))]
    pub fn for_test(
        nodes: Vec<TestNode>,
        edges: &[(i32, i32)],
        top_inset: f32,
    ) -> TreeView<'static> {
        let mut map: HashMap<i32, NodeSnapshot> = HashMap::new();
        for node in nodes {
            let parent = edges
                .iter()
                .find(|(_, child)| *child == node.tag)
                .map(|(parent, _)| *parent);
            let children = edges
                .iter()
                .filter(|(parent, _)| *parent == node.tag)
                .map(|(_, child)| *child)
                .collect();
            map.insert(
                node.tag,
                NodeSnapshot {
                    component: node.component,
                    tag: node.tag,
                    frame: node.frame,
                    scale: node.scale,
                    props: Arc::new(node.props),
                    parent,
                    children,
                    surface_id: 1,
                    transition: None,
                },
            );
        }
        TreeView {
            nodes: std::borrow::Cow::Owned(map),
            root_tags: Vec::new(),
            top_inset,
            animations_enabled: true,
            current: None,
            retained: Box::leak(Box::default()),
        }
    }
}

impl NodeSnapshot {
    fn to_component_node(&self) -> ComponentNode {
        ComponentNode {
            component: self.component.clone(),
            tag: self.tag,
            frame: self.frame,
            scale: self.scale,
            props: self.props.clone(),
            parent: self.parent,
            children: Vec::new(),
        }
    }
}

impl TreeView<'_> {
    /// One node, with no children. `None` when no such tag is mounted.
    pub fn node(&self, tag: i32) -> Option<ComponentNode> {
        if let Some((current_tag, node)) = &self.current {
            if *current_tag == tag {
                return Some(node.to_component_node());
            }
        }
        self.nodes.get(&tag).map(NodeSnapshot::to_component_node)
    }

    /// A node's parent and the index it sits at among its siblings.
    pub fn parent(&self, tag: i32) -> Option<i32> {
        self.node(tag).and_then(|node| node.parent)
    }

    /// A node's children in paint order. A retained subtree's children stay
    /// listed here even after React Native deleted their tags.
    pub fn children(&self, tag: i32) -> Vec<i32> {
        if let Some((current_tag, node)) = &self.current {
            if *current_tag == tag {
                return node.children.clone();
            }
        }
        self.nodes
            .get(&tag)
            .map(|node| node.children.clone())
            .unwrap_or_default()
    }

    /// A node's ancestors, nearest first.
    pub fn ancestors(&self, tag: i32) -> Vec<i32> {
        let mut out = Vec::new();
        let mut current = self.parent(tag);
        while let Some(parent) = current {
            out.push(parent);
            current = self.parent(parent);
        }
        out
    }

    /// Whether React Native still lists this tag. False for a retained node.
    pub fn is_live(&self, tag: i32) -> bool {
        self.nodes.contains_key(&tag)
    }

    /// Whether the node is at the root of a surface.
    pub fn is_root(&self, tag: i32) -> bool {
        self.root_tags.contains(&tag)
    }

    /// The surface a node's root belongs to, when it is mounted.
    pub fn surface_of(&self, tag: i32) -> Option<i32> {
        self.nodes.get(&tag).map(|node| node.surface_id)
    }

    /// A node's transition, with its progress sampled now.
    pub fn transition(&self, tag: i32) -> Option<TransitionState> {
        if let Some((current_tag, node)) = &self.current {
            if *current_tag == tag {
                return node.transition;
            }
        }
        self.nodes.get(&tag).and_then(|node| node.transition)
    }

    /// The window's top inset, the same value the node sees.
    pub fn window_top_inset(&self) -> f32 {
        self.top_inset
    }

    /// Whether animations may run: the app allows them and the tree did too.
    ///
    /// A hook asks this instead of reading the store, which it may not do while
    /// core is applying a batch.
    pub fn animations_enabled(&self) -> bool {
        self.animations_enabled
    }

    /// The tags a `retain_subtree` call kept attached.
    pub fn retained_tags(&self) -> Vec<i32> {
        self.retained.keys().copied().collect()
    }
}

/// What kind of operation a batch carried for one tag.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BatchOpKind {
    Create,
    Delete,
    Insert,
    Remove,
    Update,
}

/// One operation in a batch, as a module sees it before it is applied.
#[derive(Clone, Debug)]
pub struct BatchOp {
    pub kind: BatchOpKind,
    pub tag: i32,
    pub parent_tag: i32,
    pub index: i32,
    pub component: String,
    pub props: Arc<Value>,
    pub props_changed: bool,
}

/// A whole mount batch, before any of it is applied.
///
/// A batch is the unit React Native commits in, so a module that has to reason
/// about the tree as a whole — rather than op by op — reads it here.
#[derive(Clone, Debug, Default)]
pub struct BatchView {
    pub surface_id: i32,
    pub ops: Vec<BatchOp>,
}

impl BatchView {
    /// The component name a tag has in this batch, from a `Create` op or the
    /// live tree.
    /// The component name a tag has in this batch, from a `Create` op or the
    /// live tree.
    pub fn component_of<'a>(&'a self, tag: i32, tree: &TreeView) -> Option<String> {
        self.ops
            .iter()
            .find(|op| op.tag == tag && op.kind == BatchOpKind::Create)
            .map(|op| op.component.clone())
            .or_else(|| tree.node(tag).map(|node| node.component))
    }

    /// The parent an `Insert` op gives a tag.
    pub fn parent_of(&self, tag: i32) -> Option<i32> {
        self.ops
            .iter()
            .find(|op| op.tag == tag && op.kind == BatchOpKind::Insert)
            .map(|op| op.parent_tag)
    }
}

/// How core should paint one node, beyond what its style says.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Decoration {
    pub display: Option<bool>,
    pub background: Option<u32>,
    pub clip: bool,
    pub a11y_hidden: bool,
}

/// A component painted over the window instead of inside the React Native tree.
///
/// A modal and a full-window overlay both need this, which is why it is one
/// concept rather than a per-component hook.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Portal {
    pub visible: bool,
    pub close_request_event: Option<String>,
}

/// A component whose content scrolls inside its own frame.
///
/// Core owns the scrolling itself — a GPUI scroll handle, the wheel listener and
/// the resolved-offset read-back are platform capability, the same as a portal's
/// placement — so a component only declares that it scrolls, and how.
#[derive(Clone, Debug, PartialEq)]
pub struct ScrollSpec {
    pub content_size: (f32, f32),
    pub horizontal: bool,
    pub enabled: bool,
    pub indicator: bool,
    pub offset: (f32, f32),
    pub event: Option<String>,
}

/// Paints one component name.
///
/// Core tries `content` first and then `render`. A component whose painting is
/// its whole appearance implements `render`; one that core still has to give a
/// box, a background, a border and an accessibility role implements `content`,
/// which core places inside the element it builds.
/// Paints one component name.
///
/// Core tries `content` first and then `render`. A component whose painting is
/// its whole appearance implements `render`; one that core still has to give a
/// box, a background, a border and an accessibility role implements `content`,
/// which core places inside the element it builds.
pub trait ComponentRenderer: Send + Sync + 'static {
    /// The node's own content, inserted where core puts a component's children.
    /// The surrounding element keeps core's style and accessibility.
    /// The node's own content, inserted where core puts a component's children.
    /// The surrounding element keeps core's style and accessibility.
    fn content(
        &self,
        _node: &ComponentNode,
        _window: &mut Window,
        _cx: &mut App,
    ) -> Option<AnyElement> {
        None
    }

    /// The node's whole appearance, replacing the element core would build.
    /// Returning `None` falls through to `content` and then to core.
    /// The node's whole appearance, replacing the element core would build.
    /// Returning `None` falls through to `content` and then to core.
    fn render(&self, node: &ComponentNode, window: &mut Window, cx: &mut App)
        -> Option<AnyElement>;

    /// Which input this component wants.
    ///
    /// Read when the node is built, so core only installs listeners a component
    /// asked for. The default asks for nothing, which is what a renderer written
    /// before these hooks existed gets.
    fn input(&self, _node: &ComponentNode) -> input::InputSpec {
        input::InputSpec::default()
    }

    /// A button went down inside this component.
    fn on_mouse_down(
        &self,
        _node: &ComponentNode,
        _event: &input::MouseEvent,
        _cx: &mut input::InputContext<'_>,
    ) -> input::Propagation {
        input::Propagation::Continue
    }

    /// A button came up inside this component.
    fn on_mouse_up(
        &self,
        _node: &ComponentNode,
        _event: &input::MouseEvent,
        _cx: &mut input::InputContext<'_>,
    ) -> input::Propagation {
        input::Propagation::Continue
    }

    /// The pointer moved while over this component.
    fn on_mouse_move(
        &self,
        _node: &ComponentNode,
        _event: &input::MouseEvent,
        _cx: &mut input::InputContext<'_>,
    ) -> input::Propagation {
        input::Propagation::Continue
    }

    /// The pointer entered or left this component.
    fn on_hover(&self, _node: &ComponentNode, _hovered: bool, _cx: &mut input::InputContext<'_>) {}

    /// The wheel or a trackpad scrolled over this component.
    fn on_scroll(
        &self,
        _node: &ComponentNode,
        _event: &input::ScrollEvent,
        _cx: &mut input::InputContext<'_>,
    ) -> input::Propagation {
        input::Propagation::Continue
    }

    /// A drag this component accepted moved, ended or was cancelled.
    fn on_drag(
        &self,
        _node: &ComponentNode,
        _phase: input::DragPhase,
        _event: &input::MouseEvent,
        _cx: &mut input::InputContext<'_>,
    ) -> input::Propagation {
        input::Propagation::Continue
    }

    /// A context menu was requested over this component: a right click, a
    /// Ctrl+click on macOS, or the Menu key / Shift+F10.
    fn on_context_menu(
        &self,
        _node: &ComponentNode,
        _event: &input::ContextMenuTrigger,
        _cx: &mut input::InputContext<'_>,
    ) -> input::Propagation {
        input::Propagation::Continue
    }

    /// Marks this node's box as a title-bar area. `desktopDragRegion` does the
    /// same for a `View`; a caption button is a component rather than a prop, so
    /// this hook is the only way to claim one.
    fn window_control(&self, _node: &ComponentNode) -> Option<input::WindowControl> {
        None
    }

    /// Whether this component is painted over the window, and how it closes.
    ///
    /// `None` leaves the component in the tree. It reads parsed props rather
    /// than a `ComponentNode` because the store decides placement while it walks
    /// a mount batch, before any node exists.
    /// Whether this component is painted over the window, and how it closes.
    ///
    /// `None` leaves the component in the tree. It reads parsed props rather
    /// than a `ComponentNode` because the store decides placement while it walks
    /// a mount batch, before any node exists.
    fn portal(&self, _props: &Value) -> Option<Portal> {
        None
    }

    /// Whether this component scrolls its content, and with what geometry.
    ///
    /// Like `portal`, it reads parsed props so the answer does not depend on a
    /// render pass.
    /// Whether this component scrolls its content, and with what geometry.
    ///
    /// Like `portal`, it reads parsed props so the answer does not depend on a
    /// render pass.
    fn scroll(&self, _props: &Value) -> Option<ScrollSpec> {
        None
    }

    /// The keymap context this component's element carries.
    ///
    /// Read while the node's element is built, which is the only place a
    /// `KeyContext` can be set: GPUI keeps it on the element and pushes it onto
    /// the dispatch tree at paint. A component that returns one takes part in
    /// keymap resolution, which is how a `ShortcutScope` limits where its
    /// bindings apply. `None` leaves the node out of the context stack.
    fn key_context(&self, _node: &ComponentNode) -> Option<String> {
        None
    }

    /// The node's frame inside its parent, replacing the layout the platform
    /// computed for placement, painted size, hit testing, accessibility bounds
    /// and the test driver. `None` keeps the platform's frame.
    /// The node's frame inside its parent, replacing the layout the platform
    /// computed for placement, painted size, hit testing, accessibility bounds
    /// and the test driver. `None` keeps the platform's frame.
    fn layout_frame(&self, _node: &ComponentNode, _tree: &TreeView) -> Option<RectF> {
        None
    }

    /// Whether to hide the node and its descendants from accessibility and from
    /// the test driver's visibility checks. Evaluated in the inherit pass.
    /// Whether to hide the node and its descendants from accessibility and from
    /// the test driver's visibility checks. Evaluated in the inherit pass.
    fn hides_subtree(&self, _node: &ComponentNode, _tree: &TreeView) -> bool {
        false
    }

    /// How to paint the node, evaluated after core built its style.
    fn decorate(&self, _node: &ComponentNode, _tree: &TreeView) -> Decoration {
        Decoration::default()
    }

    /// Whether this component's content is composited by the OS rather than
    /// painted by GPUI (a native view, a GPU surface).
    fn renders_native_surface(&self) -> bool {
        false
    }

    fn children(
        &self,
        _node: &ComponentNode,
        children: Vec<AnyElement>,
        _window: &mut Window,
        _cx: &mut App,
    ) -> Vec<AnyElement> {
        children
    }

    /// Whether core should route key-down events for this node to `on_key_down`.
    fn handles_keys(&self, _node: &ComponentNode) -> bool {
        false
    }

    /// Handles a key press. Returning true stops propagation.
    fn on_key_down(
        &self,
        _node: &ComponentNode,
        _key: &str,
        _tree: &TreeView,
        _handle: &StoreHandle,
        _window: &mut Window,
        _cx: &mut App,
    ) -> bool {
        false
    }

    /// Whether the node repaints when the window's insets change.
    fn depends_on_window_insets(&self) -> bool {
        false
    }
}

/// Watches the mounted tree. Used for navigation, overlays and anything that
/// has to react to a component appearing, changing or going away.
/// Watches the mounted tree. Used for navigation, overlays and anything that
/// has to react to a component appearing, changing or going away.
pub trait StoreObserver: Send + Sync + 'static {
    /// A component was created or inserted.
    fn on_mount(&self, node: &ComponentNode, handle: &StoreHandle, cx: &mut App);
    /// A component's props or frame changed. `previous` is the node as it was.
    fn on_update(
        &self,
        node: &ComponentNode,
        previous: &ComponentNode,
        handle: &StoreHandle,
        cx: &mut App,
    );
    /// A component was deleted.
    fn on_remove(&self, tag: i32, handle: &StoreHandle, cx: &mut App);

    /// The whole batch, before any of it is applied.
    fn before_batch(
        &self,
        _batch: &BatchView,
        _tree: &TreeView,
        _handle: &StoreHandle,
        _cx: &mut App,
    ) {
    }

    /// Core inserted `child` under `parent`. `previous_children` is the parent's
    /// child tags from just before the insert.
    /// Core inserted `child` under `parent`. `previous_children` is the parent's
    /// child tags from just before the insert.
    fn on_insert(
        &self,
        _child: &ComponentNode,
        _parent: i32,
        _previous_children: &[i32],
        _tree: &TreeView,
        _handle: &StoreHandle,
        _cx: &mut App,
    ) {
    }

    /// Core is about to detach `child` from `parent`. `retained` says whether it
    /// will stay attached because a subtree was retained.
    /// Core is about to detach `child` from `parent`. `retained` says whether it
    /// will stay attached because a subtree was retained.
    fn on_remove_child(
        &self,
        _child: i32,
        _parent: i32,
        _retained: bool,
        _tree: &TreeView,
        _handle: &StoreHandle,
        _cx: &mut App,
    ) {
    }

    /// The batch is applied, before inheritance is refreshed.
    fn after_batch(&self, _tree: &TreeView, _handle: &StoreHandle, _cx: &mut App) {}

    /// A transition on `tag` reached a new sample.
    fn on_transition_frame(&self, _tag: i32, _progress: f32, _handle: &StoreHandle, _cx: &mut App) {
    }
}

/// Whether any component renderer was ever registered, as a relaxed load.
fn any_renderers_flag() -> &'static std::sync::atomic::AtomicBool {
    static FLAG: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    &FLAG
}

/// Whether any component renderer was ever registered.
pub fn any_component_renderers() -> bool {
    any_renderers_flag().load(std::sync::atomic::Ordering::Relaxed)
}

fn component_renderers() -> &'static Mutex<HashMap<String, Arc<dyn ComponentRenderer>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Arc<dyn ComponentRenderer>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn store_observers_registry() -> &'static Mutex<Vec<Arc<dyn StoreObserver>>> {
    static REGISTRY: OnceLock<Mutex<Vec<Arc<dyn StoreObserver>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(Vec::new()))
}

/// Registers `renderer` for `component_name`, replacing any earlier one.
///
/// Called from a module's `rn_gpui_register()`, before the runtime starts.
/// Registers `renderer` for `component_name`, replacing any earlier one.
///
/// Called from a module's `rn_gpui_register()`, before the runtime starts.
pub fn register_component_renderer(
    component_name: impl Into<String>,
    renderer: Arc<dyn ComponentRenderer>,
) {
    component_renderers()
        .lock()
        .expect("component renderer registry poisoned")
        .insert(component_name.into(), renderer);
    any_renderers_flag().store(true, std::sync::atomic::Ordering::Relaxed);
}

/// Registers `observer`; observers are notified in registration order.
///
/// Called from a module's `rn_gpui_register()`, before the runtime starts.
/// Registers `observer`; observers are notified in registration order.
///
/// Called from a module's `rn_gpui_register()`, before the runtime starts.
pub fn register_store_observer(observer: Arc<dyn StoreObserver>) {
    store_observers_registry()
        .lock()
        .expect("store observer registry poisoned")
        .push(observer);
}

/// Serialises a test that installs an observer, and empties the registry.
///
/// The registry is process-wide with no unregister, so two tests that register
/// one would see each other's hooks. Every test that installs one takes this
/// guard for its whole body, which keeps the swaps from overlapping.
#[cfg(test)]
pub(crate) fn exclusive_observers() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    store_observers_registry()
        .lock()
        .expect("store observer registry poisoned")
        .clear();
    guard
}

/// The renderer registered for `component_name`, if any.
/// Whether a component's content is composited by the OS rather than painted
/// by GPUI.
pub fn component_renders_native_surface(component_name: &str) -> bool {
    component_renderer(component_name).is_some_and(|renderer| renderer.renders_native_surface())
}

pub fn component_renderer(component_name: &str) -> Option<Arc<dyn ComponentRenderer>> {
    if !any_component_renderers() {
        return None;
    }
    component_renderers()
        .lock()
        .expect("component renderer registry poisoned")
        .get(component_name)
        .cloned()
}

/// The portal a component's renderer declares for these props.
///
/// The store calls it to decide whether a component is spliced out of its
/// React Native parent. A component with no renderer, or one whose renderer
/// does not declare a portal, stays in the tree.
/// The portal a component's renderer declares for these props.
///
/// The store calls it to decide whether a component is spliced out of its
/// React Native parent. A component with no renderer, or one whose renderer
/// does not declare a portal, stays in the tree.
pub fn component_portal(component_name: &str, props: &Value) -> Option<Portal> {
    component_renderer(component_name)?.portal(props)
}

/// The scroll declaration a component's renderer makes for these props.
pub fn component_scroll(component_name: &str, props: &Value) -> Option<ScrollSpec> {
    component_renderer(component_name)?.scroll(props)
}

/// Parses the JSON a module filled for a component, or `Null`.
pub fn parse_extension_props(json: &str) -> Value {
    if json.is_empty() {
        Value::Null
    } else {
        serde_json::from_str(json).unwrap_or(Value::Null)
    }
}

/// Every registered observer, for one notification pass.
/// A handle on the mounted tree, for a hook that has only the app context.
///
/// A renderer's `content` and a `decorate` are given no handle, because core
/// already holds it; a pointer handler built there needs one, and this is how it
/// gets the same handle core would have passed.
pub fn store_handle(cx: &App) -> Option<StoreHandle> {
    cx.try_global::<crate::store::StoreGlobal>()
        .map(|store| StoreHandle::new(store.0.downgrade()))
}

pub fn store_observers() -> Vec<Arc<dyn StoreObserver>> {
    store_observers_registry()
        .lock()
        .expect("store observer registry poisoned")
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{div, prelude::*, px, TestAppContext};
    use serde_json::json;

    struct FakeRenderer {
        calls: Arc<Mutex<Vec<String>>>,
    }

    impl ComponentRenderer for FakeRenderer {
        fn render(
            &self,
            node: &ComponentNode,
            _window: &mut Window,
            _cx: &mut App,
        ) -> Option<AnyElement> {
            self.calls.lock().unwrap().push(node.component.clone());
            Some(div().into_any_element())
        }
    }

    struct FakeObserver {
        seen: Arc<Mutex<Vec<String>>>,
    }

    impl FakeObserver {
        /// Records a tag the test it belongs to is about.
        ///
        /// The registry is process-wide, so a batch another test applies runs
        /// this observer too; only the tag under test is recorded, which is what
        /// keeps the assertion below about ordering rather than about timing.
        fn record(&self, entry: String) {
            if entry.ends_with(":7") {
                self.seen.lock().unwrap().push(entry);
            }
        }
    }

    impl StoreObserver for FakeObserver {
        fn on_mount(&self, node: &ComponentNode, _handle: &StoreHandle, _cx: &mut App) {
            self.record(format!("mount:{}", node.tag));
        }

        fn on_update(
            &self,
            node: &ComponentNode,
            _previous: &ComponentNode,
            _handle: &StoreHandle,
            _cx: &mut App,
        ) {
            self.record(format!("update:{}", node.tag));
        }

        fn on_remove(&self, tag: i32, _handle: &StoreHandle, _cx: &mut App) {
            self.record(format!("remove:{tag}"));
        }
    }

    fn node(component: &str, tag: i32) -> ComponentNode {
        ComponentNode {
            component: component.to_string(),
            tag,
            frame: RectF::default(),
            scale: (1.0, 1.0),
            props: Arc::new(json!({ "testID": format!("id-{tag}") })),
            parent: None,
            children: Vec::new(),
        }
    }

    #[gpui::test]
    fn a_registered_renderer_is_used_for_its_component_name(cx: &mut TestAppContext) {
        let calls = Arc::new(Mutex::new(Vec::new()));
        register_component_renderer(
            "FixtureWidget",
            Arc::new(FakeRenderer {
                calls: calls.clone(),
            }),
        );
        let found = component_renderer("FixtureWidget").expect("registered renderer");
        let window = cx.open_window(gpui::size(px(120.0), px(100.0)), |_, _| gpui::Empty);
        window
            .update(cx, |_, window, cx| {
                assert!(found
                    .render(&node("FixtureWidget", 1), window, cx)
                    .is_some());
            })
            .unwrap();
        assert_eq!(*calls.lock().unwrap(), vec!["FixtureWidget".to_string()]);
    }

    #[gpui::test]
    fn an_unregistered_name_falls_through_to_core(_cx: &mut TestAppContext) {
        assert!(component_renderer("View").is_none());
    }

    #[gpui::test]
    fn an_observer_sees_mount_update_and_remove_in_order(cx: &mut TestAppContext) {
        // The registry is process-wide: this test owns it for its whole body so
        // a test that installs its own observer cannot run at the same time.
        let _exclusive = exclusive_observers();
        let seen = Arc::new(Mutex::new(Vec::new()));
        register_store_observer(Arc::new(FakeObserver { seen: seen.clone() }));
        let observers = store_observers();
        assert!(!observers.is_empty());
        let handle = crate::store::test_store_handle(cx);
        cx.update(|cx| {
            let observer = observers.last().unwrap().clone();
            observer.on_mount(&node("View", 7), &handle, cx);
            observer.on_update(&node("View", 7), &node("View", 7), &handle, cx);
            observer.on_remove(7, &handle, cx);
        });
        assert_eq!(
            *seen.lock().unwrap(),
            vec![
                "mount:7".to_string(),
                "update:7".to_string(),
                "remove:7".to_string()
            ]
        );
    }

    /// The hooks of one batch run in the order the plan fixes: the whole-batch
    /// pre-pass, then the per-operation hooks, then the post-pass.
    #[gpui::test]
    fn batch_hooks_run_in_order(cx: &mut TestAppContext) {
        let order = Arc::new(Mutex::new(Vec::new()));
        let observer = Arc::new(OrderObserver {
            order: order.clone(),
        });
        let handle = crate::store::test_store_handle(cx);
        cx.update(|cx| {
            let tree = empty_tree();
            observer.before_batch(&BatchView::default(), &tree, &handle, cx);
            observer.on_insert(&node("View", 1), 0, &[], &tree, &handle, cx);
            observer.on_remove_child(1, 0, false, &tree, &handle, cx);
            observer.after_batch(&tree, &handle, cx);
        });
        assert_eq!(
            *order.lock().unwrap(),
            vec!["before", "insert", "remove_child", "after"]
        );
    }

    struct OrderObserver {
        order: Arc<Mutex<Vec<&'static str>>>,
    }

    impl StoreObserver for OrderObserver {
        fn on_mount(&self, _node: &ComponentNode, _handle: &StoreHandle, _cx: &mut App) {}
        fn on_update(
            &self,
            _node: &ComponentNode,
            _previous: &ComponentNode,
            _handle: &StoreHandle,
            _cx: &mut App,
        ) {
        }
        fn on_remove(&self, _tag: i32, _handle: &StoreHandle, _cx: &mut App) {}
        fn before_batch(
            &self,
            _batch: &BatchView,
            _tree: &TreeView,
            _handle: &StoreHandle,
            _cx: &mut App,
        ) {
            self.order.lock().unwrap().push("before");
        }
        fn on_insert(
            &self,
            _child: &ComponentNode,
            _parent: i32,
            _previous_children: &[i32],
            _tree: &TreeView,
            _handle: &StoreHandle,
            _cx: &mut App,
        ) {
            self.order.lock().unwrap().push("insert");
        }
        fn on_remove_child(
            &self,
            _child: i32,
            _parent: i32,
            _retained: bool,
            _tree: &TreeView,
            _handle: &StoreHandle,
            _cx: &mut App,
        ) {
            self.order.lock().unwrap().push("remove_child");
        }
        fn after_batch(&self, _tree: &TreeView, _handle: &StoreHandle, _cx: &mut App) {
            self.order.lock().unwrap().push("after");
        }
    }

    /// A tree with no nodes, for hooks whose bodies do not consult it.
    fn empty_tree() -> TreeView<'static> {
        static NODES: OnceLock<HashMap<i32, NodeSnapshot>> = OnceLock::new();
        static RETAINED: OnceLock<HashMap<i32, Vec<i32>>> = OnceLock::new();
        TreeView {
            nodes: std::borrow::Cow::Borrowed(NODES.get_or_init(HashMap::new)),
            root_tags: Vec::new(),
            top_inset: 0.0,
            animations_enabled: true,
            current: None,
            retained: RETAINED.get_or_init(HashMap::new),
        }
    }
}
