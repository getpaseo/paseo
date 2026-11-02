use crate::frame::FrameHook;
use crate::host::Host;
use crate::node_view::{inherit, InheritInput, Inherited, RNNodeView};
use gpui::deferred;
use gpui::{
    div, point, prelude::*, px, AnyWindowHandle, App, Context, Entity, Global, IntoElement,
    MouseButton, NavigationDirection, Pixels, Point, Subscription, Window,
};
use rn_gpui_sys::ffi::{MountBatch, MountKind, MountOp};
use std::cell::{Cell, RefCell};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::OnceLock;
use std::time::Instant;

pub(crate) fn benchmark_mode() -> Option<&'static str> {
    static MODE: OnceLock<Option<String>> = OnceLock::new();
    MODE.get_or_init(|| std::env::var("RN_GPUI_BENCH_MODE").ok())
        .as_deref()
}

pub const APP_SURFACE_ID: i32 = 1;

pub struct StoreGlobal(pub Entity<ViewStore>);
impl Global for StoreGlobal {}

/// The queue every host component report goes into, and the store's one
/// delivery point for them.
pub(crate) type HostReportQueue = crate::host_component::HostReportQueue;

/// How a surface's root is shown.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SurfaceKind {
    /// The root of a window: the menu bar, the overlay slot, the performance
    /// monitor and the app key context belong to it.
    Window,
    /// Shown above a window's content through its overlay slot (LogBox).
    Overlay,
    /// Owned by a `ReactSurface`: GPUI places it inside any tree, and it carries
    /// none of the window's chrome.
    Embedded,
}

pub struct ViewStore {
    pub host: Host,
    pub frame_hook: FrameHook,
    pub window: AnyWindowHandle,
    pub windows: HashMap<i32, AnyWindowHandle>,
    /// Fabric tags are unique across the surfaces of one React instance.
    pub nodes: HashMap<i32, Entity<RNNodeView>>,
    pub(crate) accessibility_modal_tags: BTreeSet<i32>,
    pub roots: HashMap<i32, Entity<SurfaceRootView>>,
    pub primary_surface_id: i32,
    /// The size each surface's root was laid out at, as the last mount batch
    /// reported it. A `FitContent` surface reads this to size its leaf.
    pub surface_content_sizes: HashMap<i32, (f32, f32)>,
    /// Embedded surfaces that report their content size, by surface id.
    surface_size_observers: HashMap<
        i32,
        (
            crate::surface::SurfaceContentSize,
            gpui::WeakEntity<crate::surface::ReactSurface>,
        ),
    >,
    /// Where each embedded surface's box is in its window, shared with its nodes.
    surface_origins: HashMap<i32, crate::surface::SurfaceOrigin>,
    pub overlay_host: Entity<OverlayHost>,
    /// Interior mutability on purpose: pointer movement must not update the store
    /// entity, which nearly every node reads while rendering.
    pub hovered: RefCell<Vec<i32>>,
    pub pointer: Cell<Point<Pixels>>,
    pub top_inset: f32,
    /// Target fixed at primary-button down. RN keeps a touch's target stable
    /// across drags, so responder moves/releases must still reach this node
    /// after the pointer leaves its bounds.
    pub active_touch_target: Option<crate::events::Target>,
    /// The screen whose Escape dismissal already announced its lifecycle
    /// events. The following Fabric Remove should not announce it twice.
    pub(crate) retained_subtrees: HashMap<i32, Vec<i32>>,
    /// What a `TreeView` reports about each mounted node, kept in step with
    /// `nodes` as a batch is applied.
    ///
    /// Building this on demand copies every node in the tree, so doing it once
    /// per insert and once per remove made a first mount of N nodes cost O(N²).
    /// A batch now writes the entries it touches, and a hook borrows the map.
    snapshots: HashMap<i32, crate::extensions::NodeSnapshot>,
    log_mount_ops: bool,
    /// A dropped `Subscription` unsubscribes, so the store owns it.
    pub window_bounds_subscription: Option<Subscription>,
    /// The main window's maximized / minimized / fullscreen observer.
    pub window_state_subscription: Option<Subscription>,
    pub window_appearance_subscription: Option<Subscription>,
    pub navigation_keyboard_subscription: Option<Subscription>,
    /// Every host component report waiting to be applied, in order.
    pub(crate) host_reports: HostReportQueue,
}

impl ViewStore {
    pub fn new(
        host: Host,
        window: impl Into<AnyWindowHandle>,
        frame_hook: FrameHook,
        overlay_host: Entity<OverlayHost>,
    ) -> Self {
        let window = window.into();
        Self {
            host,
            frame_hook,
            window,
            windows: HashMap::from([(APP_SURFACE_ID, window)]),
            nodes: HashMap::new(),
            accessibility_modal_tags: BTreeSet::new(),
            roots: HashMap::new(),
            primary_surface_id: APP_SURFACE_ID,
            surface_content_sizes: HashMap::new(),
            surface_size_observers: HashMap::new(),
            surface_origins: HashMap::new(),
            overlay_host,
            hovered: RefCell::new(Vec::new()),
            pointer: Cell::new(point(px(0.), px(0.))),
            top_inset: 0.0,
            active_touch_target: None,
            retained_subtrees: HashMap::new(),
            snapshots: HashMap::new(),
            log_mount_ops: benchmark_mode().is_none(),
            window_bounds_subscription: None,
            window_state_subscription: None,
            window_appearance_subscription: None,
            navigation_keyboard_subscription: None,
            host_reports: std::rc::Rc::new(crate::host_component::HostReports::default()),
        }
    }

    pub fn register_root(&mut self, surface_id: i32, root: Entity<SurfaceRootView>) {
        self.roots.insert(surface_id, root);
    }

    pub fn register_window(&mut self, surface_id: i32, window: AnyWindowHandle) {
        self.windows.insert(surface_id, window);
    }

    pub fn unregister_window(&mut self, surface_id: i32) {
        self.windows.remove(&surface_id);
    }

    pub fn window_for(&self, surface_id: i32) -> Option<AnyWindowHandle> {
        self.windows
            .get(&surface_id)
            .copied()
            .or_else(|| (surface_id == APP_SURFACE_ID).then_some(self.window))
    }

    pub fn surfaces_in_window(&self, window: AnyWindowHandle) -> Vec<i32> {
        self.windows
            .iter()
            .filter(|(_, handle)| **handle == window)
            .map(|(surface, _)| *surface)
            .collect()
    }

    /// Fabric references the `RootView` as a parent that is never itself mounted,
    /// so the root view is created the first time a node is spliced into it.
    /// Lets `observer` be told when `surface_id`'s root changes size.
    pub fn observe_surface_content_size(
        &mut self,
        surface_id: i32,
        observer: crate::surface::SurfaceContentSize,
        surface: gpui::WeakEntity<crate::surface::ReactSurface>,
    ) {
        if let Some(size) = self.surface_content_sizes.get(&surface_id) {
            observer.set(*size);
        }
        self.surface_size_observers
            .insert(surface_id, (observer, surface));
    }

    /// The root entity for `surface_id`, making one if needed.
    pub fn ensure_root(
        &mut self,
        surface_id: i32,
        cx: &mut Context<Self>,
    ) -> Entity<SurfaceRootView> {
        self.root_for(surface_id, cx)
    }

    /// The root of an embedded surface: a surface GPUI places inside its own
    /// tree. Unlike the root a mount batch creates for an unknown surface, it is
    /// not shown through the overlay slot, and it carries no window chrome.
    pub fn ensure_embedded_root(
        &mut self,
        surface_id: i32,
        cx: &mut Context<Self>,
    ) -> Entity<SurfaceRootView> {
        if let Some(root) = self.roots.get(&surface_id) {
            return root.clone();
        }
        let root = cx.new(|_| SurfaceRootView::with_kind(surface_id, SurfaceKind::Embedded));
        self.roots.insert(surface_id, root.clone());
        root
    }

    /// Uses `origin` as the box of `surface_id` in its window. Called before the
    /// surface's first node mounts, so each node shares the cell.
    pub fn use_surface_origin(&mut self, surface_id: i32, origin: crate::surface::SurfaceOrigin) {
        self.surface_origins.insert(surface_id, origin);
    }

    /// The origin cell nodes of `surface_id` share. A surface that was never
    /// placed by GPUI (a window root) keeps the zero origin it starts with.
    fn origin_for(&mut self, surface_id: i32) -> crate::surface::SurfaceOrigin {
        self.surface_origins.entry(surface_id).or_default().clone()
    }

    fn root_for(&mut self, surface_id: i32, cx: &mut Context<Self>) -> Entity<SurfaceRootView> {
        if let Some(root) = self.roots.get(&surface_id) {
            return root.clone();
        }
        // A surface with no registered window belongs to the main window. That
        // covers LogBox (surface 2), which C++ starts directly, and any surface
        // that mounted before the window registry adopted it.
        let window = self.window_for(surface_id).unwrap_or(self.window);
        let overlay = surface_id != self.primary_surface_id && window == self.window;
        let kind = if overlay {
            SurfaceKind::Overlay
        } else {
            SurfaceKind::Window
        };
        let root = cx.new(|_| SurfaceRootView::with_kind(surface_id, kind));
        self.roots.insert(surface_id, root.clone());
        if overlay {
            log::info!("[store] surface {surface_id} registered as an overlay");
            self.overlay_host.update(cx, |host, cx| {
                host.insert(surface_id, root.clone());
                cx.notify();
            });
        }
        root
    }

    /// Fabric emits no `Delete` mutations for a dying surface. On a reload every
    /// node must go, or the new instance would reuse tags on top of the stale tree.
    pub fn surface_stopped(&mut self, surface_id: i32, cx: &mut Context<Self>) {
        if surface_id == rn_gpui_sys::ALL_SURFACES {
            log::info!(
                "[store] React instance going away: dropping {} nodes and every root child",
                self.nodes.len()
            );
            self.nodes.clear();
            self.snapshots.clear();
            self.accessibility_modal_tags.clear();
            self.hovered.borrow_mut().clear();
            self.active_touch_target = None;
            let roots: Vec<Entity<SurfaceRootView>> = self.roots.values().cloned().collect();
            for root in roots {
                root.update(cx, |root, cx| {
                    root.clear_children();
                    cx.notify();
                });
            }
            self.overlay_host.update(cx, |host, cx| {
                host.clear();
                cx.notify();
            });
            cx.notify();
            return;
        }

        let stale: Vec<i32> = self
            .nodes
            .iter()
            .filter(|(_, node)| node.read(cx).surface_id == surface_id)
            .map(|(tag, _)| *tag)
            .collect();
        let dropped = stale.len();
        if self
            .active_touch_target
            .as_ref()
            .is_some_and(|target| stale.contains(&target.tag))
        {
            self.active_touch_target = None;
        }
        for tag in stale {
            self.nodes.remove(&tag);
            self.snapshots.remove(&tag);
            self.accessibility_modal_tags.remove(&tag);
            self.overlay_host.update(cx, |host, cx| {
                host.remove_portal(tag);
                cx.notify();
            });
        }
        let live: HashSet<i32> = self.nodes.keys().copied().collect();
        self.hovered.borrow_mut().retain(|tag| live.contains(tag));
        if let Some(root) = self.roots.remove(&surface_id) {
            self.overlay_host.update(cx, |host, cx| {
                host.remove(surface_id);
                cx.notify();
            });
            root.update(cx, |root, cx| {
                root.clear_children();
                cx.notify();
            });
        }
        self.windows.remove(&surface_id);
        log::info!("[store] surface {surface_id} stopped: dropped {dropped} nodes");
        cx.notify();
    }

    pub fn resize_window(&mut self, window: AnyWindowHandle, width: f32, height: f32, scale: f32) {
        // Per surface, not per call: the menu bar can be hidden in one window and
        // shown in another, so the inset has to follow the window the surface
        // belongs to.
        for surface_id in self.surfaces_in_window(window) {
            let height =
                height - crate::desktop::gpui_menu::menu_bar_inset_for_window_id(surface_id as u32);
            log::info!(
                "[store] surface {surface_id} resized to {width}x{height}@{scale}x (window-scoped)"
            );
            self.host.set_surface_size(surface_id, width, height, scale);
        }
    }

    /// Carries `delta` from `parent_tag` up to the surface root.
    fn carry_native_surface_delta(
        &mut self,
        surface_id: i32,
        parent_tag: Option<i32>,
        delta: i64,
        cx: &mut Context<Self>,
    ) {
        if delta == 0 {
            return;
        }
        let mut parent = parent_tag;
        while let Some(tag) = parent {
            let Some(node) = self.nodes.get(&tag).cloned() else {
                break;
            };
            crate::counters::bump(crate::counters::Counter::NativeSurfaceWalkNodes);
            let mut next = None;
            node.update(cx, |node, cx| {
                next = node.parent_tag_cached();
                let crossed = if delta > 0 {
                    node.add_native_surface_descendants(delta as u32)
                } else {
                    node.sub_native_surface_descendants((-delta) as u32)
                };
                if crossed {
                    cx.notify();
                }
            });
            parent = next;
        }
        if let Some(root) = self.roots.get(&surface_id).cloned() {
            root.update(cx, |root, cx| {
                let crossed = if delta > 0 {
                    root.add_native_surfaces(delta as u32)
                } else {
                    root.sub_native_surfaces((-delta) as u32)
                };
                if crossed {
                    cx.notify();
                }
            });
        }
    }

    /// Claims what `tag`'s subtree owes, so it is counted exactly once.
    fn claim_native_surface_contribution(&mut self, tag: i32, cx: &mut Context<Self>) -> u32 {
        let Some(node) = self.nodes.get(&tag).cloned() else {
            return 0;
        };
        let (counted, descendants) = {
            let node = node.read(cx);
            (node.native_surface_counted, node.native_surface_descendants)
        };
        if !counted {
            return 0;
        }
        node.update(cx, |node, _cx| {
            node.take_native_surface_contribution();
        });
        descendants
    }

    /// Adds what `tag`'s subtree contributes to its ancestors.
    fn add_native_surface_to_ancestors(
        &mut self,
        surface_id: i32,
        tag: i32,
        parent_tag: Option<i32>,
        cx: &mut Context<Self>,
    ) {
        let Some(node) = self.nodes.get(&tag).cloned() else {
            return;
        };
        let (counted, descendants) = {
            let node = node.read(cx);
            (node.native_surface_counted, node.native_surface_descendants)
        };
        if counted {
            return;
        }
        node.update(cx, |node, _cx| node.mark_native_surface_counted());
        self.carry_native_surface_delta(surface_id, parent_tag, i64::from(descendants), cx);
    }

    /// Takes what `tag`'s subtree contributes back off its ancestors.
    fn remove_native_surface_from_ancestors(
        &mut self,
        surface_id: i32,
        tag: i32,
        parent_tag: Option<i32>,
        cx: &mut Context<Self>,
    ) {
        let contribution = self.claim_native_surface_contribution(tag, cx);
        self.carry_native_surface_delta(surface_id, parent_tag, -i64::from(contribution), cx);
    }

    /// Fabric emits `Create`/`Update` before the `Insert` that splices a node in,
    /// so a parent always exists when its children arrive.
    pub fn apply_batch(&mut self, batch: MountBatch, cx: &mut Context<Self>) {
        let surface_id = batch.surface_id;
        if batch.has_content_size {
            let size = (batch.content_width, batch.content_height);
            log::debug!(
                "[store] surface {surface_id} content size {}x{}",
                size.0,
                size.1
            );
            self.surface_content_sizes.insert(surface_id, size);
            if let Some((observer, surface)) = self.surface_size_observers.get(&surface_id) {
                if observer.set(size) {
                    let _ = surface.update(cx, |_, cx| cx.notify());
                }
            }
        }
        log::debug!("[store] surface {}: {} ops", surface_id, batch.ops.len());
        let store = cx.entity().downgrade();
        let commands: std::sync::Arc<std::sync::Mutex<Vec<crate::extensions::Command>>> =
            Default::default();
        let handle = crate::extensions::StoreHandle::queued(store, commands.clone());
        let batch_view = crate::extensions::BatchView {
            surface_id,
            ops: batch
                .ops
                .iter()
                .map(|op| crate::extensions::BatchOp {
                    kind: match op.kind {
                        MountKind::Create => crate::extensions::BatchOpKind::Create,
                        MountKind::Delete => crate::extensions::BatchOpKind::Delete,
                        MountKind::Insert => crate::extensions::BatchOpKind::Insert,
                        MountKind::Remove => crate::extensions::BatchOpKind::Remove,
                        MountKind::Update => crate::extensions::BatchOpKind::Update,
                        _ => crate::extensions::BatchOpKind::Update,
                    },
                    tag: op.tag,
                    parent_tag: op.parent_tag,
                    index: op.index,
                    component: op.component.clone(),
                    props: std::sync::Arc::new(crate::extensions::parse_extension_props(
                        &op.extension_props_json,
                    )),
                    props_changed: op.props_changed,
                })
                .collect(),
        };
        let host_reports = self.host_reports.clone();
        let observers = crate::extensions::store_observers();
        if !observers.is_empty() {
            for observer in &observers {
                let tree = self.tree_view(cx);
                observer.before_batch(&batch_view, &tree, &handle, cx);
                self.apply_commands(&commands, cx);
            }
            let pending: Vec<i32> =
                PENDING_RETAIN.with(|pending| pending.borrow_mut().drain().collect());
            for tag in pending {
                self.retain_subtree(tag, cx);
            }
        }
        for op in batch.ops.iter() {
            match op.kind {
                MountKind::Create | MountKind::Update => {
                    let is_visible_portal = crate::extensions::component_portal(
                        &op.component,
                        &crate::extensions::parse_extension_props(&op.extension_props_json),
                    )
                    .is_some_and(|portal| portal.visible);
                    if op.view.accessibility_modal || is_visible_portal {
                        self.accessibility_modal_tags.insert(op.tag);
                    } else {
                        self.accessibility_modal_tags.remove(&op.tag);
                    }
                }
                MountKind::Delete | MountKind::Remove => {
                    self.accessibility_modal_tags.remove(&op.tag);
                }
                _ => {}
            }
            if self.log_mount_ops {
                log_mount_op(op);
            }
            match op.kind {
                MountKind::Create => {
                    if op.component == "NativeViewHost" {
                        log::info!(
                            "[native-view] Fabric created tag={} factory='{}' props={}",
                            op.tag,
                            op.native_view_name,
                            op.native_view_props
                        );
                    }
                    let host_reports = host_reports.clone();
                    let origin = self.origin_for(surface_id);
                    let node = cx.new(|_| {
                        RNNodeView::from_op(op, surface_id, host_reports)
                            .with_surface_origin(origin)
                    });
                    self.nodes.insert(op.tag, node.clone());
                    self.record_subtree_nodes(&[op.tag], cx);
                    let component_node = node.read(cx).component_node(cx);
                    for observer in &observers {
                        observer.on_mount(&component_node, &handle, cx);
                        self.apply_commands(&commands, cx);
                    }
                }
                MountKind::Delete => {
                    if crate::extensions::component_portal(
                        &op.component,
                        &crate::extensions::parse_extension_props(&op.extension_props_json),
                    )
                    .is_some()
                    {
                        self.overlay_host.update(cx, |host, cx| {
                            host.remove_portal(op.tag);
                            cx.notify();
                        });
                    }
                    if let Some(node) = self.nodes.get(&op.tag).cloned() {
                        let parent_tag = node.read(cx).parent_tag_cached();
                        let contribution = self.claim_native_surface_contribution(op.tag, cx);
                        self.carry_native_surface_delta(
                            surface_id,
                            parent_tag,
                            -i64::from(contribution),
                            cx,
                        );
                        if contribution > 0 {
                            if let Some(parent) =
                                parent_tag.and_then(|tag| self.nodes.get(&tag).cloned())
                            {
                                parent.update(cx, |parent, cx| {
                                    parent.remove_child(op.tag);
                                    cx.notify();
                                });
                            }
                        }
                    }
                    self.nodes.remove(&op.tag);
                    self.drop_snapshot(op.tag);
                    for observer in &observers {
                        observer.on_remove(op.tag, &handle, cx);
                        self.apply_commands(&commands, cx);
                    }
                }
                MountKind::Insert => {
                    let Some(child) = self.nodes.get(&op.tag).cloned() else {
                        log::warn!("[store] insert of unknown tag {}", op.tag);
                        continue;
                    };
                    {
                        let node = child.read(cx);
                        let is_visible_portal = crate::extensions::component_portal(
                            &op.component,
                            &crate::extensions::parse_extension_props(&op.extension_props_json),
                        )
                        .is_some_and(|portal| portal.visible);
                        if node.view.accessibility_modal || is_visible_portal {
                            self.accessibility_modal_tags.insert(op.tag);
                        }
                    }
                    if let Some(portal) = crate::extensions::component_portal(
                        &op.component,
                        &crate::extensions::parse_extension_props(&op.extension_props_json),
                    ) {
                        child.update(cx, |child, _cx| child.set_parent(None, None));
                        if portal.visible {
                            self.overlay_host.update(cx, |host, cx| {
                                host.insert_portal(op.tag, child.clone());
                                cx.notify();
                            });
                        }
                        continue;
                    }
                    let index = op.index.max(0) as usize;
                    if let Some(parent) = self.nodes.get(&op.parent_tag).cloned() {
                        self.add_native_surface_to_ancestors(
                            surface_id,
                            op.tag,
                            Some(op.parent_tag),
                            cx,
                        );
                        let parent_ref = parent.downgrade();
                        let previous_children = parent.read(cx).child_tags();
                        parent.update(cx, |parent, cx| {
                            parent.insert_child(index, op.tag, child.clone());
                            cx.notify();
                        });
                        child.update(cx, |child, _cx| {
                            child.set_parent(Some(parent_ref), Some(op.parent_tag))
                        });
                        // `on_insert` sees the tree with the splice applied, so
                        // both the parent and the child are re-recorded first.
                        self.record_subtree_nodes(&[op.parent_tag, op.tag], cx);
                        {
                            let inserted = child.read(cx).component_node_shallow();
                            for observer in &observers {
                                let tree = self.tree_view(cx);
                                observer.on_insert(
                                    &inserted,
                                    op.parent_tag,
                                    &previous_children,
                                    &tree,
                                    &handle,
                                    cx,
                                );
                                self.apply_commands(&commands, cx);
                            }
                        }
                    } else {
                        let root = self.root_for(surface_id, cx);
                        let (root_surface, before) = {
                            let root_ref = root.read(cx);
                            (root_ref.surface_id, root_ref.children.len())
                        };
                        log::info!(
                            "[store-debug] root child tag={} batch_surface={} root_surface={} children={}",
                            op.tag,
                            surface_id,
                            root_surface,
                            before
                        );
                        root.update(cx, |root, cx| {
                            root.insert_child(index, op.tag, child.clone());
                            cx.notify();
                        });
                        child.update(cx, |child, _cx| child.set_parent(None, None));
                        self.add_native_surface_to_ancestors(surface_id, op.tag, None, cx);
                    }
                }
                MountKind::Remove => {
                    if crate::extensions::component_portal(
                        &op.component,
                        &crate::extensions::parse_extension_props(&op.extension_props_json),
                    )
                    .is_some()
                    {
                        self.overlay_host.update(cx, |host, cx| {
                            host.remove_portal(op.tag);
                            cx.notify();
                        });
                        continue;
                    }
                    for observer in &observers {
                        let tree = self.tree_view(cx);
                        observer.on_remove_child(
                            op.tag,
                            op.parent_tag,
                            self.retained_subtrees.contains_key(&op.tag),
                            &tree,
                            &handle,
                            cx,
                        );
                        self.apply_commands(&commands, cx);
                    }
                    if let Some(parent) = self.nodes.get(&op.parent_tag).cloned() {
                        self.remove_native_surface_from_ancestors(
                            surface_id,
                            op.tag,
                            Some(op.parent_tag),
                            cx,
                        );
                        parent.update(cx, |parent, cx| {
                            parent.remove_child(op.tag);
                            cx.notify();
                        });
                        self.record_subtree_nodes(&[op.parent_tag], cx);
                    } else if let Some(root) = self.roots.get(&surface_id).cloned() {
                        self.remove_native_surface_from_ancestors(surface_id, op.tag, None, cx);
                        // The app's whole tree leaving its surface is what a blank
                        // window is: say so, with what is left, so a log answers
                        // "when did it go" without a debugger.
                        log::warn!(
                            "[store] surface {surface_id} root child tag={} ({}) removed; {} child(ren) were mounted",
                            op.tag,
                            op.component,
                            root.read(cx).children.len()
                        );
                        root.update(cx, |root, cx| {
                            root.remove_child(op.tag);
                            cx.notify();
                        });
                    }
                    // The node itself stays mounted until Fabric deletes it, so
                    // its snapshot stays too: `is_live` and the parent's
                    // `children` kept answering this way when the tree was
                    // copied out on every call, and a retained card has to keep
                    // painting from its snapshot after the removal.
                }
                MountKind::Update => {
                    if let Some(node) = self.nodes.get(&op.tag).cloned() {
                        let previous_node = node.read(cx).component_node(cx);
                        let (counted, before) = {
                            let node = node.read(cx);
                            (node.native_surface_counted, node.native_surface_descendants)
                        };
                        node.update(cx, |node, cx| {
                            node.update_from_op(op);
                            cx.notify();
                        });
                        let after = node.read(cx).native_surface_descendants;
                        if counted && after != before {
                            let parent_tag = node.read(cx).parent_tag_cached();
                            self.carry_native_surface_delta(
                                surface_id,
                                parent_tag,
                                i64::from(after) - i64::from(before),
                                cx,
                            );
                        }
                        let updated_node = node.read(cx).component_node(cx);
                        self.record_subtree_nodes(&[op.tag], cx);
                        for observer in &observers {
                            observer.on_update(&updated_node, &previous_node, &handle, cx);
                            self.apply_commands(&commands, cx);
                        }
                        if let Some(portal) = crate::extensions::component_portal(
                            &op.component,
                            &crate::extensions::parse_extension_props(&op.extension_props_json),
                        ) {
                            self.overlay_host.update(cx, |host, cx| {
                                if portal.visible {
                                    host.insert_portal(op.tag, node.clone());
                                } else {
                                    host.remove_portal(op.tag);
                                }
                                cx.notify();
                            });
                        }
                    }
                }
                _ => log::warn!("[store] unknown mount kind {}", op.kind.repr),
            }
            let is_scroll = crate::extensions::component_scroll(
                &op.component,
                &crate::extensions::parse_extension_props(&op.extension_props_json),
            )
            .is_some();
            if op.layout_changed && (op.component == "View" || is_scroll) {
                self.host.dispatch_event(
                    op.tag,
                    "topLayout",
                    &serde_json::json!({
                        "layout": {
                            "x": op.frame.x,
                            "y": op.frame.y,
                            "width": op.frame.w,
                            "height": op.frame.h
                        }
                    }),
                );
            }
        }
        for observer in &observers {
            let tree = self.tree_view(cx);
            observer.after_batch(&tree, &handle, cx);
            self.apply_commands(&commands, cx);
        }
        self.refresh_inherited(surface_id, cx);
        self.flush_host_reports(cx);
        self.host.on_render();
        let hook = self.frame_hook.clone();
        let target = self.window_for(surface_id).unwrap_or(self.window);
        let _ = cx.update_window(target, |_root, window, _cx| {
            hook.arm(window);
            window.on_next_frame(crate::accessibility::sync_modal_focus);
        });
    }

    /// Applies every host component report queued so far, in order.
    pub(crate) fn flush_host_reports(&mut self, cx: &mut Context<Self>) {
        if !crate::host_component::any_host_components() {
            return;
        }
        self.host_reports.release_flush();
        let reports = self.host_reports.take();
        crate::counters::add(
            crate::counters::Counter::HostReportsDelivered,
            reports.len() as u64,
        );
        for report in reports {
            match report {
                crate::host_component::HostReport::Size { tag, width, height } => {
                    crate::host_component::apply_size(tag, width, height);
                    if let Some(node) = self.nodes.get(&tag).cloned() {
                        node.update(cx, |node, _| node.set_intrinsic_size(width, height));
                    }
                }
                crate::host_component::HostReport::Insets {
                    tag,
                    top,
                    right,
                    bottom,
                    left,
                } => crate::host_component::apply_insets(tag, top, right, bottom, left),
                crate::host_component::HostReport::Event { send, .. } => send(),
            }
        }
    }

    fn apply_commands(
        &mut self,
        commands: &std::sync::Arc<std::sync::Mutex<Vec<crate::extensions::Command>>>,
        cx: &mut Context<Self>,
    ) {
        let queued: Vec<crate::extensions::Command> = {
            let mut queue = commands.lock().expect("command queue poisoned");
            queue.drain(..).collect()
        };
        for command in queued {
            match command {
                crate::extensions::Command::Transition { tag, transition } => {
                    start_component_transition_here(self, tag, transition, cx);
                }
                crate::extensions::Command::ClearTransition { tag } => {
                    if let Some(node) = self.nodes.get(&tag).cloned() {
                        node.update(cx, |node, cx| {
                            node.transition = None;
                            cx.notify();
                        });
                        self.record_subtree_nodes(&[tag], cx);
                    }
                }
                crate::extensions::Command::Dispatch { tag, name, payload } => {
                    self.host.dispatch_event(tag, &name, &payload);
                }
                crate::extensions::Command::Wake => self.host.on_render(),
                crate::extensions::Command::ReleaseRetained { tag } => {
                    release_retained_subtree_here(self, tag, cx);
                }
                crate::extensions::Command::After { duration, run } => {
                    cx.spawn(async move |_store, cx| {
                        cx.background_executor().timer(duration).await;
                        if let Some(run) = run.lock().ok().and_then(|mut slot| slot.take()) {
                            let _ = cx.update(|cx| run(cx));
                        }
                    })
                    .detach();
                }
            }
        }
    }

    pub(crate) fn retain_subtree(&mut self, tag: i32, cx: &App) {
        let mut descendants = Vec::new();
        let mut stack: Vec<i32> = self
            .nodes
            .get(&tag)
            .map(|node| node.read(cx).child_tags())
            .unwrap_or_default();
        let mut seen = HashSet::new();
        while let Some(child) = stack.pop() {
            if !seen.insert(child) {
                continue;
            }
            descendants.push(child);
            if let Some(node) = self.nodes.get(&child) {
                stack.extend(node.read(cx).child_tags());
            }
        }
        self.retained_subtrees.insert(tag, descendants);
    }

    pub(crate) fn tree_view<'a>(&'a self, cx: &App) -> crate::extensions::TreeView<'a> {
        self.tree_view_at(None, cx)
    }

    /// Re-records the tags a batch just changed, so the next `TreeView` reports
    /// them without reading the entities.
    ///
    /// Every mutation a snapshot covers has to call this: the batch writes here
    /// what it used to copy out of the whole tree on every operation.
    fn record_subtree_nodes(&mut self, tags: &[i32], cx: &App) {
        for tag in tags {
            if let Some(entity) = self.nodes.get(tag) {
                let snapshot = entity.read(cx).snapshot();
                self.snapshots.insert(*tag, snapshot);
            }
        }
    }

    /// Forgets a node, and every tag below it that Fabric no longer reports.
    fn drop_snapshot(&mut self, tag: i32) {
        self.snapshots.remove(&tag);
    }

    /// Re-reads every node, for the paths that mutate the tree outside a batch.
    fn rebuild_snapshots(&mut self, cx: &App) {
        self.snapshots.clear();
        for (tag, entity) in &self.nodes {
            let snapshot = entity.read(cx).snapshot();
            self.snapshots.insert(*tag, snapshot);
        }
    }

    /// A view of the tree for a hook.
    ///
    /// The nodes are copied into `snapshots` as the batch applies them, before
    /// any hook runs, because a hook is handed `&mut App` and a tree that kept
    /// entity handles would let it read a node that the same call is updating.
    pub(crate) fn tree_view_at<'a>(
        &'a self,
        current: Option<(i32, &'a RNNodeView)>,
        cx: &App,
    ) -> crate::extensions::TreeView<'a> {
        let root_tags = self
            .roots
            .values()
            .flat_map(|root| root.read(cx).children.iter().map(|(tag, _)| *tag))
            .collect();
        crate::extensions::TreeView {
            nodes: std::borrow::Cow::Borrowed(&self.snapshots),
            root_tags,
            top_inset: self.top_inset,
            animations_enabled: !cx.reduce_motion()
                && !crate::animation_policy::animations_disabled(),
            current: current.map(|(tag, node)| (tag, node.snapshot())),
            retained: &self.retained_subtrees,
        }
    }

    pub(crate) fn animations_enabled(&self, cx: &App) -> bool {
        !cx.reduce_motion() && !crate::animation_policy::animations_disabled()
    }

    /// Writes a node only when its value changed, and notifies it only when a
    /// value its own `render` reads changed.
    pub(crate) fn refresh_inherited(&mut self, surface_id: i32, cx: &mut Context<Self>) {
        let mut roots: Vec<Entity<RNNodeView>> = Vec::new();
        if let Some(root) = self.roots.get(&surface_id) {
            roots.extend(root.read(cx).children.iter().map(|(_, node)| node.clone()));
        }
        for (_, portal) in self.overlay_host.read(cx).portals.iter() {
            if portal.read(cx).surface_id == surface_id && portal.read(cx).parent.is_none() {
                roots.push(portal.clone());
            }
        }
        // The pass runs while this entity is being updated, so `origin_frame`
        // cannot read the store back out of the global; hand it the value.
        let top_inset = self.top_inset;
        let root_tags = self
            .roots
            .values()
            .flat_map(|root| root.read(cx).children.iter().map(|(tag, _)| *tag))
            .collect();
        let animations_enabled =
            !cx.reduce_motion() && !crate::animation_policy::animations_disabled();
        self.rebuild_snapshots(cx);
        let tree = crate::extensions::TreeView {
            nodes: std::borrow::Cow::Borrowed(&self.snapshots),
            root_tags,
            top_inset,
            animations_enabled,
            current: None,
            retained: &self.retained_subtrees,
        };
        for root in roots {
            refresh_inherited_tree(root, top_inset, None, &tree, cx);
        }
    }
}

/// One node's refreshed state, computed while the tree is alive and applied
/// after it is dropped.
struct InheritedUpdate {
    node: Entity<RNNodeView>,
    inherited: Inherited,
    hides_self: bool,
    renderer_frame: Option<rn_gpui_sys::ffi::RectF>,
    renderer_decoration: Option<crate::extensions::Decoration>,
    changed: bool,
    render_affecting: bool,
}

fn refresh_inherited_tree(
    node: Entity<RNNodeView>,
    top_inset: f32,
    parent: Option<(Inherited, InheritInput)>,
    tree: &crate::extensions::TreeView,
    cx: &mut Context<ViewStore>,
) {
    let mut updates: Vec<InheritedUpdate> = Vec::new();
    let mut pending: Vec<(Entity<RNNodeView>, Option<(Inherited, InheritInput)>)> =
        vec![(node, parent)];

    while let Some((node, parent)) = pending.pop() {
        let own = node.read(cx).inherit_input(tree);
        let inherited = inherit(parent.as_ref().map(|(p, i)| (p, i)), &own);
        let children: Vec<Entity<RNNodeView>> = node
            .read(cx)
            .children
            .iter()
            .map(|(_, child)| child.clone())
            .collect();
        let modal_children = children
            .iter()
            .filter(|child| child.read(cx).view.accessibility_modal)
            .count();
        let (renderer_frame, renderer_decoration, changed, render_affecting) = {
            let view = node.read(cx);
            let frame = crate::extensions::component_renderer(&view.component)
                .and_then(|r| r.layout_frame(&view.component_node_shallow(), tree));
            let decoration = crate::extensions::component_renderer(&view.component)
                .map(|r| r.decorate(&view.component_node_shallow(), tree));
            (
                frame,
                decoration,
                !view.inherited.same(&inherited),
                !view.inherited.same_render_affecting(&inherited),
            )
        };
        for child in children {
            let child_is_modal = child.read(cx).view.accessibility_modal;
            let mut parent_input = own.clone();
            parent_input.other_modal_child = modal_children > usize::from(child_is_modal);
            pending.push((child, Some((inherited.clone(), parent_input))));
        }
        updates.push(InheritedUpdate {
            node,
            inherited,
            hides_self: own.hides_subtree,
            renderer_frame,
            renderer_decoration,
            changed,
            render_affecting,
        });
    }

    for update in updates {
        update.node.update(cx, |view, cx| {
            let renderer_changed = view.renderer_frame != update.renderer_frame
                || view.renderer_decoration != update.renderer_decoration;
            view.renderer_frame = update.renderer_frame;
            view.renderer_decoration = update.renderer_decoration;
            if update.changed {
                view.inherited = update.inherited.clone();
                view.inherited.window_top_inset = top_inset;
                view.inherited.hides_subtree_self = update.hides_self;
            }
            if update.render_affecting || renderer_changed {
                cx.notify();
            }
        });
    }
}

pub(crate) fn start_component_transition(
    store: &Entity<ViewStore>,
    tag: i32,
    transition: crate::extensions::Transition,
    cx: &mut App,
) {
    store.update(cx, |store, cx| {
        if let Some(node) = store.nodes.get(&tag).cloned() {
            node.update(cx, |node, cx| {
                let forward = transition.to.opacity >= transition.from.opacity;
                node.transition = Some((transition, Instant::now()));
                node.transition_forward = forward;
                cx.notify();
            });
            store.record_subtree_nodes(&[tag], cx);
        }
    });
}

fn start_component_transition_here(
    store: &mut ViewStore,
    tag: i32,
    transition: crate::extensions::Transition,
    cx: &mut Context<ViewStore>,
) {
    if let Some(node) = store.nodes.get(&tag).cloned() {
        node.update(cx, |node, cx| {
            node.transition = Some((transition, Instant::now()));
            cx.notify();
        });
        store.record_subtree_nodes(&[tag], cx);
    }
}

pub(crate) fn clear_node_transition(store: &Entity<ViewStore>, tag: i32, cx: &mut App) {
    store.update(cx, |store, cx| {
        if let Some(node) = store.nodes.get(&tag).cloned() {
            node.update(cx, |node, cx| {
                node.transition = None;
                cx.notify();
            });
            store.record_subtree_nodes(&[tag], cx);
        }
    });
}

pub(crate) fn request_retain_subtree(tag: i32) {
    PENDING_RETAIN.with(|pending| pending.borrow_mut().insert(tag));
}

thread_local! {
    static PENDING_RETAIN: std::cell::RefCell<std::collections::HashSet<i32>> =
        std::cell::RefCell::new(std::collections::HashSet::new());
}

pub(crate) fn release_retained_subtree(store: &Entity<ViewStore>, tag: i32, cx: &mut App) {
    store.update(cx, |store, cx| {
        release_retained_subtree_here(store, tag, cx)
    });
}

fn release_retained_subtree_here(store: &mut ViewStore, tag: i32, cx: &mut Context<ViewStore>) {
    let Some(descendants) = store.retained_subtrees.remove(&tag) else {
        return;
    };
    let _ = descendants;
    let parent_tag = store
        .nodes
        .get(&tag)
        .and_then(|node| node.read(cx).parent_tag_cached());
    let surface_id = store
        .nodes
        .get(&tag)
        .map(|node| node.read(cx).surface_id)
        .unwrap_or(rn_gpui_sys::ALL_SURFACES);
    store.remove_native_surface_from_ancestors(surface_id, tag, parent_tag, cx);
    if let Some(parent) = store
        .nodes
        .get(&tag)
        .and_then(|node| node.read(cx).parent.clone())
        .and_then(|parent| parent.upgrade())
    {
        parent.update(cx, |parent, cx| {
            parent.remove_child(tag);
            cx.notify();
        });
    }
    let surface_id = store
        .nodes
        .get(&tag)
        .map(|node| node.read(cx).surface_id)
        .unwrap_or(rn_gpui_sys::ALL_SURFACES);
    log::info!("[extensions] retained subtree released tag={tag}");
    store.refresh_inherited(surface_id, cx);
}

pub(crate) fn after_on_store(
    store: Entity<ViewStore>,
    duration: std::time::Duration,
    cx: &mut gpui::App,
    f: impl FnOnce(&mut gpui::App) + 'static,
) {
    let mut f = Some(f);
    store.update(cx, |_: &mut ViewStore, cx: &mut Context<ViewStore>| {
        cx.spawn(async move |_store, cx| {
            cx.background_executor().timer(duration).await;
            if let Some(f) = f.take() {
                let _ = cx.update(|cx| f(cx));
            }
        })
        .detach();
    });
}

#[cfg(test)]
pub(crate) fn test_store_handle(cx: &mut gpui::TestAppContext) -> crate::extensions::StoreHandle {
    let overlay_host = cx.new(|_| OverlayHost::new());
    let window = cx.open_window(gpui::size(gpui::px(120.0), gpui::px(100.0)), {
        let overlay_host = overlay_host.clone();
        move |_, _| SurfaceRootView::new(1).with_overlay_host(overlay_host)
    });
    let root = window.root(cx).unwrap();
    let any_window: gpui::AnyWindowHandle = window.into();
    let host = crate::host::Host::test_stub();
    let frame_hook = FrameHook::new(host.clone());
    let store = cx.new(|_| ViewStore::new(host, any_window, frame_hook, overlay_host));
    cx.update(|cx| cx.set_global(StoreGlobal(store.clone())));
    let _ = root;
    crate::extensions::StoreHandle::new(store.downgrade())
}

#[cfg(test)]
mod test_app_context_tests {
    use super::{OverlayHost, StoreGlobal, SurfaceKind, SurfaceRootView, ViewStore};
    use crate::{frame::FrameHook, host::Host};
    use gpui::{px, AppContext, TestAppContext};
    use rn_gpui_sys::ffi::{MountBatch, MountKind, MountOp, ParagraphFlat, RectF, ViewPropsFlat};

    fn op(kind: MountKind) -> MountOp {
        MountOp {
            kind,
            tag: 101,
            parent_tag: -1,
            index: 0,
            component: "View".into(),
            native_view_name: String::new(),
            native_view_props: "{}".into(),
            frame: RectF {
                x: 10.0,
                y: 12.0,
                w: 40.0,
                h: 30.0,
            },
            props_changed: true,
            view: ViewPropsFlat {
                opacity: 1.0,
                ..Default::default()
            },
            extension_props_json: String::new(),
            host_index: -1,
            host_props_handle: 0,
            host_emitter_handle: 0,
            host_changed: 0,
            host_changed_more: Vec::new(),
            has_paragraph: false,
            paragraph: ParagraphFlat::default(),
            layout_changed: false,
        }
    }

    /// The registry index each native test component was declared at.
    fn native_indices() -> &'static std::sync::Mutex<std::collections::HashMap<String, i32>> {
        static INDICES: std::sync::OnceLock<
            std::sync::Mutex<std::collections::HashMap<String, i32>>,
        > = std::sync::OnceLock::new();
        INDICES.get_or_init(Default::default)
    }

    /// Declares a host component whose content the OS composites, for the
    /// counter tests below. Declared once per name at a fresh index; an op for it
    /// carries that index, as a real one does.
    fn register_native_component(name: &str) {
        let mut indices = native_indices().lock().unwrap();
        if indices.contains_key(name) {
            return;
        }
        let index = 1000 + indices.len() as u32;
        crate::host_component::declare_host_component(
            index,
            name,
            crate::host_component::HostComponentOptions {
                native_surface: true,
                ..Default::default()
            },
        );
        indices.insert(name.to_string(), index as i32);
    }

    /// Builds a store whose surface root is a real window root, and returns
    /// both the store and that root.
    fn store_with_root(
        cx: &mut TestAppContext,
    ) -> (gpui::Entity<ViewStore>, gpui::Entity<SurfaceRootView>) {
        let overlay_host = cx.new(|_| OverlayHost::new());
        let window = cx.open_window(gpui::size(px(120.0), px(100.0)), {
            let overlay_host = overlay_host.clone();
            move |_, _| SurfaceRootView::new(1).with_overlay_host(overlay_host)
        });
        let root = window.root(cx).expect("surface root exists");
        let any_window: gpui::AnyWindowHandle = window.into();
        let host = Host::test_stub();
        let frame_hook = FrameHook::new(host.clone());
        let store = cx.new(|_| ViewStore::new(host, any_window, frame_hook, overlay_host));
        cx.update(|cx| cx.set_global(StoreGlobal(store.clone())));
        store.update(cx, |store, _| store.register_root(1, root.clone()));
        (store, root)
    }

    /// Applies a batch of `(kind, tag, parent)` triples.
    fn apply(cx: &mut TestAppContext, store: &gpui::Entity<ViewStore>, ops: Vec<MountOp>) {
        store.update(cx, |store, cx| {
            store.apply_batch(
                MountBatch {
                    surface_id: 1,
                    ops,
                    ..Default::default()
                },
                cx,
            );
        });
    }

    fn create(tag: i32, component: &str) -> MountOp {
        let mut create = op(MountKind::Create);
        create.tag = tag;
        create.component = component.into();
        if let Some(index) = native_indices().lock().unwrap().get(component) {
            create.host_index = *index;
        }
        create
    }

    fn insert(tag: i32, parent: i32) -> MountOp {
        let mut insert = op(MountKind::Insert);
        insert.tag = tag;
        insert.parent_tag = parent;
        insert
    }

    fn remove(tag: i32, parent: i32) -> MountOp {
        let mut remove = op(MountKind::Remove);
        remove.tag = tag;
        remove.parent_tag = parent;
        remove
    }

    fn delete(tag: i32) -> MountOp {
        let mut delete = op(MountKind::Delete);
        delete.tag = tag;
        delete
    }

    /// A counter read off one node, or `None` if it is not mounted.
    fn count_of(cx: &mut TestAppContext, store: &gpui::Entity<ViewStore>, tag: i32) -> Option<u32> {
        cx.read_entity(store, |store, app| {
            store
                .nodes
                .get(&tag)
                .map(|node| node.read(app).native_surface_descendants)
        })
    }

    /// An embedded surface's root belongs to the `ReactSurface` that placed it:
    /// it must not also be shown through the window's overlay slot, where it
    /// would cover the window it was meant to sit inside.
    #[gpui::test]
    fn an_embedded_root_is_not_an_overlay(cx: &mut TestAppContext) {
        let (store, _root) = store_with_root(cx);
        let (embedded, overlay_count) = store.update(cx, |store, cx| {
            let root = store.ensure_embedded_root(5, cx);
            (root, store.overlay_host.read(cx).overlay_count())
        });
        assert_eq!(overlay_count, 0, "an embedded surface is not an overlay");
        assert_eq!(
            embedded.read_with(cx, |root, _| root.kind),
            SurfaceKind::Embedded
        );

        let (logbox, overlay_count) = store.update(cx, |store, cx| {
            let root = store.ensure_root(2, cx);
            (root, store.overlay_host.read(cx).overlay_count())
        });
        assert_eq!(overlay_count, 1);
        assert_eq!(
            logbox.read_with(cx, |root, _| root.kind),
            SurfaceKind::Overlay
        );
    }

    /// The surface root's own count.
    fn root_count(cx: &mut TestAppContext, root: &gpui::Entity<SurfaceRootView>) -> u32 {
        root.read_with(cx, |root, _| root.native_surfaces)
    }

    #[gpui::test]
    fn a_native_surface_is_counted_up_the_parent_chain(cx: &mut TestAppContext) {
        register_native_component("CounterNative");
        let (store, root) = store_with_root(cx);

        apply(
            cx,
            &store,
            vec![
                create(1, "View"),
                insert(1, -1),
                create(2, "View"),
                insert(2, 1),
                create(3, "View"),
                insert(3, 2),
                create(4, "Text"),
                insert(4, 2),
                create(5, "CounterNative"),
                insert(5, 3),
            ],
        );

        assert_eq!(
            count_of(cx, &store, 5),
            Some(1),
            "the surface itself counts"
        );
        assert_eq!(
            count_of(cx, &store, 4),
            Some(0),
            "a GPUI-only node holds none"
        );
        assert_eq!(count_of(cx, &store, 3), Some(1));
        assert_eq!(count_of(cx, &store, 2), Some(1));
        assert_eq!(count_of(cx, &store, 1), Some(1));
        assert_eq!(root_count(cx, &root), 1, "the root counts it too");
    }

    #[gpui::test]
    fn two_native_surfaces_under_one_ancestor_both_count(cx: &mut TestAppContext) {
        register_native_component("CounterNativeTwo");
        let (store, root) = store_with_root(cx);

        apply(
            cx,
            &store,
            vec![
                create(1, "View"),
                insert(1, -1),
                create(2, "CounterNativeTwo"),
                insert(2, 1),
                create(3, "CounterNativeTwo"),
                insert(3, 1),
            ],
        );

        assert_eq!(
            count_of(cx, &store, 1),
            Some(2),
            "the count is how many surfaces are below, not whether there is one"
        );
        assert_eq!(root_count(cx, &root), 2);
    }

    #[gpui::test]
    fn the_counter_reports_a_crossing_only_at_zero(cx: &mut TestAppContext) {
        register_native_component("CrossingNative");
        let (store, root) = store_with_root(cx);
        apply(
            cx,
            &store,
            vec![
                create(1, "View"),
                create(2, "View"),
                insert(1, -1),
                insert(2, 1),
                create(3, "CrossingNative"),
                insert(3, 2),
            ],
        );
        let node = cx
            .read_entity(&store, |store, _| store.nodes.get(&1).cloned())
            .unwrap();

        let second = node.update(cx, |node, _cx| node.add_native_surface_descendants(1));
        assert!(!second, "1 -> 2 changes no reader's answer");

        let back = node.update(cx, |node, _cx| node.sub_native_surface_descendants(1));
        assert!(!back, "2 -> 1 changes no reader's answer either");

        let empty = node.update(cx, |node, _cx| node.sub_native_surface_descendants(1));
        assert!(empty, "1 -> 0 is the crossing a ScrollView must react to");

        let first = node.update(cx, |node, _cx| node.add_native_surface_descendants(1));
        assert!(first, "0 -> 1 is the other crossing");
        let _ = (&store, &root);
    }

    #[gpui::test]
    fn removing_a_native_surface_takes_it_off_every_ancestor(cx: &mut TestAppContext) {
        register_native_component("CounterNativeRemove");
        let (store, root) = store_with_root(cx);

        apply(
            cx,
            &store,
            vec![
                create(1, "View"),
                insert(1, -1),
                create(2, "View"),
                insert(2, 1),
                create(3, "CounterNativeRemove"),
                insert(3, 2),
            ],
        );
        assert_eq!(count_of(cx, &store, 1), Some(1));
        assert_eq!(root_count(cx, &root), 1);

        apply(cx, &store, vec![remove(3, 2)]);

        assert_eq!(count_of(cx, &store, 2), Some(0), "the parent drops it");
        assert_eq!(count_of(cx, &store, 1), Some(0), "so does the grandparent");
        assert_eq!(root_count(cx, &root), 0, "and the root");

        apply(cx, &store, vec![delete(3)]);
        assert_eq!(
            count_of(cx, &store, 1),
            Some(0),
            "a delete after a remove takes nothing more off"
        );
    }

    #[gpui::test]
    fn deleting_without_a_remove_still_takes_the_surface_off(cx: &mut TestAppContext) {
        register_native_component("CounterNativeDelete");
        let (store, root) = store_with_root(cx);

        apply(
            cx,
            &store,
            vec![
                create(1, "View"),
                insert(1, -1),
                create(2, "CounterNativeDelete"),
                insert(2, 1),
            ],
        );
        assert_eq!(root_count(cx, &root), 1);

        apply(cx, &store, vec![delete(2)]);

        assert_eq!(
            count_of(cx, &store, 1),
            Some(0),
            "a delete with no remove still gives the count back"
        );
        assert_eq!(root_count(cx, &root), 0);
    }

    #[gpui::test]
    fn reparenting_a_native_surface_does_not_double_count(cx: &mut TestAppContext) {
        register_native_component("CounterNativeMove");
        let (store, root) = store_with_root(cx);

        apply(
            cx,
            &store,
            vec![
                create(1, "View"),
                insert(1, -1),
                create(2, "View"),
                insert(2, 1),
                create(3, "View"),
                insert(3, 1),
                create(4, "CounterNativeMove"),
                insert(4, 2),
            ],
        );
        assert_eq!(count_of(cx, &store, 2), Some(1));
        assert_eq!(count_of(cx, &store, 3), Some(0));
        assert_eq!(root_count(cx, &root), 1);

        apply(cx, &store, vec![remove(4, 2), insert(4, 3)]);

        assert_eq!(count_of(cx, &store, 2), Some(0), "the old parent lets go");
        assert_eq!(
            count_of(cx, &store, 3),
            Some(1),
            "the new parent picks it up"
        );
        assert_eq!(
            count_of(cx, &store, 1),
            Some(1),
            "the shared ancestor is unchanged, not doubled"
        );
        assert_eq!(root_count(cx, &root), 1);
    }

    #[gpui::test]
    fn a_native_view_host_counts_only_once_it_has_a_factory(cx: &mut TestAppContext) {
        let (store, root) = store_with_root(cx);

        let mut create_host = create(1, "NativeViewHost");
        create_host.native_view_name = String::new();
        apply(cx, &store, vec![create_host, insert(1, -1)]);
        assert_eq!(
            count_of(cx, &store, 1),
            Some(0),
            "a host with no factory composites nothing"
        );
        assert_eq!(root_count(cx, &root), 0);

        let mut update = op(MountKind::Update);
        update.tag = 1;
        update.component = "NativeViewHost".into();
        update.native_view_name = "MapView".into();
        apply(cx, &store, vec![update]);
        assert_eq!(count_of(cx, &store, 1), Some(1));
        assert_eq!(root_count(cx, &root), 1, "the update reached the root");

        let mut update = op(MountKind::Update);
        update.tag = 1;
        update.component = "NativeViewHost".into();
        apply(cx, &store, vec![update]);
        assert_eq!(count_of(cx, &store, 1), Some(0));
        assert_eq!(root_count(cx, &root), 0);
    }

    #[gpui::test]
    fn a_tree_with_no_native_surface_counts_nothing(cx: &mut TestAppContext) {
        let (store, root) = store_with_root(cx);

        apply(
            cx,
            &store,
            vec![
                create(1, "View"),
                insert(1, -1),
                create(2, "View"),
                insert(2, 1),
                create(3, "Text"),
                insert(3, 2),
            ],
        );

        for tag in [1, 2, 3] {
            assert_eq!(
                count_of(cx, &store, tag),
                Some(0),
                "tag {tag} must not report a surface it does not hold"
            );
        }
        assert_eq!(root_count(cx, &root), 0);
        assert!(
            !store.read_with(cx, |store, app| store
                .nodes
                .get(&1)
                .expect("mounted")
                .read(app)
                .subtree_renders_native_surface()),
            "a ScrollView over this tree stays on the scroll-layer path"
        );
    }

    #[gpui::test]
    #[gpui::test]
    fn test_app_context_mounts_a_view_and_resolves_its_pointer_target(cx: &mut TestAppContext) {
        let overlay_host = cx.new(|_| OverlayHost::new());
        let window = cx.open_window(gpui::size(px(120.0), px(100.0)), {
            let overlay_host = overlay_host.clone();
            move |_, _| SurfaceRootView::new(1).with_overlay_host(overlay_host)
        });
        let root = window.root(cx).unwrap();
        let any_window: gpui::AnyWindowHandle = window.into();
        let host = Host::test_stub();
        let frame_hook = FrameHook::new(host.clone());
        let store = cx.new(|_| ViewStore::new(host, any_window, frame_hook, overlay_host));
        cx.update(|cx| cx.set_global(StoreGlobal(store.clone())));
        store.update(cx, |store, _| store.register_root(1, root));

        cx.update_entity(&store, |store, cx| {
            store.apply_batch(
                MountBatch {
                    surface_id: 1,
                    ops: vec![op(MountKind::Create), op(MountKind::Insert)],
                    ..Default::default()
                },
                cx,
            );
        });

        cx.update_window(any_window, |_, window, app| {
            let needs_clear = window.draw(app);
            needs_clear.clear(app);
            window.dispatch_event(
                gpui::PlatformInput::MouseMove(gpui::MouseMoveEvent {
                    position: gpui::point(px(20.0), px(20.0)),
                    pressed_button: None,
                    ..Default::default()
                }),
                app,
            );
        })
        .unwrap();
        let hit = cx.read_entity(&store, |store, _| store.hovered.borrow().first().copied());
        assert_eq!(hit, Some(101));
    }

    /// A decoration that changes without any inherited value changing must
    /// still be stored, and must notify.
    ///
    /// The pass used to write the renderer's answer only when the *inherited*
    /// state changed, so a module whose decoration depends on transition
    /// progress kept its answer from the start of the transition forever.
    #[gpui::test]
    fn refresh_stores_a_decoration_that_changed_alone(cx: &mut TestAppContext) {
        use std::sync::atomic::{AtomicU32, Ordering};
        use std::sync::Arc;

        static COLOUR: AtomicU32 = AtomicU32::new(0);

        struct Probe;
        impl crate::extensions::ComponentRenderer for Probe {
            fn render(
                &self,
                _node: &crate::extensions::ComponentNode,
                _window: &mut gpui::Window,
                _cx: &mut gpui::App,
            ) -> Option<gpui::AnyElement> {
                None
            }

            fn decorate(
                &self,
                _node: &crate::extensions::ComponentNode,
                _tree: &crate::extensions::TreeView,
            ) -> crate::extensions::Decoration {
                crate::extensions::Decoration {
                    background: Some(COLOUR.load(Ordering::SeqCst)),
                    ..Default::default()
                }
            }
        }

        let overlay_host = cx.new(|_| OverlayHost::new());
        let window = cx.open_window(gpui::size(px(120.0), px(100.0)), {
            let overlay_host = overlay_host.clone();
            move |_, _| SurfaceRootView::new(1).with_overlay_host(overlay_host)
        });
        let root = window.root(cx).unwrap();
        let any_window: gpui::AnyWindowHandle = window.into();
        let host = Host::test_stub();
        let frame_hook = FrameHook::new(host.clone());
        let store = cx.new(|_| ViewStore::new(host, any_window, frame_hook, overlay_host));
        cx.update(|cx| cx.set_global(StoreGlobal(store.clone())));
        store.update(cx, |store, _| store.register_root(1, root));

        crate::extensions::register_component_renderer("DecorationProbe", Arc::new(Probe));
        let mut create = op(MountKind::Create);
        create.component = "DecorationProbe".into();
        cx.update_entity(&store, |store, cx| {
            store.apply_batch(
                MountBatch {
                    surface_id: 1,
                    ops: vec![create, op(MountKind::Insert)],
                    ..Default::default()
                },
                cx,
            );
        });

        let read = |cx: &mut TestAppContext| {
            cx.read_entity(&store, |store, _| {
                store
                    .nodes
                    .get(&101)
                    .map(|node| node.read_with(cx, |n, _| n.renderer_decoration))
                    .flatten()
            })
        };
        assert_eq!(read(cx).and_then(|d| d.background), Some(0));

        // Only the decoration changes; no inherited value moves.
        COLOUR.store(0xff00ff00, Ordering::SeqCst);
        cx.update_entity(&store, |store, cx| {
            store.refresh_inherited(super::APP_SURFACE_ID, cx);
        });
        assert_eq!(
            read(cx).and_then(|d| d.background),
            Some(0xff00ff00),
            "a decoration that changed alone must be stored"
        );
    }

    #[gpui::test]
    fn test_driver_frames_follow_transforms_and_visibility_clips(cx: &mut TestAppContext) {
        let overlay_host = cx.new(|_| OverlayHost::new());
        let window = cx.open_window(gpui::size(px(120.0), px(100.0)), {
            let overlay_host = overlay_host.clone();
            move |_, _| SurfaceRootView::new(1).with_overlay_host(overlay_host)
        });
        let root = window.root(cx).expect("surface root exists");
        let any_window: gpui::AnyWindowHandle = window.into();
        let host = Host::test_stub();
        let frame_hook = FrameHook::new(host.clone());
        let store = cx.new(|_| ViewStore::new(host, any_window, frame_hook, overlay_host));
        cx.update(|cx| cx.set_global(StoreGlobal(store.clone())));
        store.update(cx, |store, _| store.register_root(1, root));

        let mut create = op(MountKind::Create);
        create.view.has_transform = true;
        create.view.transform = [
            2.0, 0.0, 0.0, 0.0, 0.0, 0.5, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 8.0, 6.0, 0.0, 1.0,
        ];
        let mut insert = op(MountKind::Insert);
        insert.view = create.view.clone();
        cx.update_entity(&store, |store, cx| {
            store.apply_batch(
                MountBatch {
                    surface_id: 1,
                    ops: vec![create, insert],
                    ..Default::default()
                },
                cx,
            );
        });

        let transformed = cx.read_entity(&store, |store, app| {
            crate::test_driver::node_frame(store, 101, app).expect("mounted frame")
        });
        assert_eq!((transformed.x, transformed.y), (18.0, 18.0));
        assert_eq!((transformed.w, transformed.h), (80.0, 15.0));

        let clipped = cx.read_entity(&store, |store, app| {
            crate::test_driver::node_visible_frame(
                store,
                101,
                RectF {
                    x: 0.0,
                    y: 0.0,
                    w: 20.0,
                    h: 20.0,
                },
                app,
            )
        });
        let clipped = clipped.expect("transformed frame intersects viewport");
        assert_eq!((clipped.x, clipped.y), (18.0, 18.0));
        assert_eq!((clipped.w, clipped.h), (2.0, 2.0));

        let outside = cx.read_entity(&store, |store, app| {
            crate::test_driver::node_visible_frame(
                store,
                101,
                RectF {
                    x: 100.0,
                    y: 80.0,
                    w: 20.0,
                    h: 20.0,
                },
                app,
            )
        });
        assert!(outside.is_none(), "off-window view must be invisible");

        let mut hidden = op(MountKind::Update);
        hidden.view.display_none = true;
        cx.update_entity(&store, |store, cx| {
            store.apply_batch(
                MountBatch {
                    surface_id: 1,
                    ops: vec![hidden],
                    ..Default::default()
                },
                cx,
            );
        });
        let hidden_frame = cx.read_entity(&store, |store, app| {
            crate::test_driver::node_visible_frame(
                store,
                101,
                RectF {
                    x: 0.0,
                    y: 0.0,
                    w: 120.0,
                    h: 100.0,
                },
                app,
            )
        });
        assert!(
            hidden_frame.is_none(),
            "display:none view must be invisible"
        );
    }

    /// Opening a view of the tree must not copy the tree.
    ///
    /// Core opens one for every observer on every insert and every remove, so
    /// anything that copies every node per call makes a first mount of N nodes
    /// cost O(N²). The view borrows the map the store keeps instead.
    #[gpui::test]
    fn opening_a_tree_view_copies_no_nodes(cx: &mut TestAppContext) {
        let overlay_host = cx.new(|_| OverlayHost::new());
        let window = cx.open_window(gpui::size(px(120.0), px(100.0)), {
            let overlay_host = overlay_host.clone();
            move |_, _| SurfaceRootView::new(1).with_overlay_host(overlay_host)
        });
        let root = window.root(cx).unwrap();
        let any_window: gpui::AnyWindowHandle = window.into();
        let host = Host::test_stub();
        let frame_hook = FrameHook::new(host.clone());
        let store = cx.new(|_| ViewStore::new(host, any_window, frame_hook, overlay_host));
        cx.update(|cx| cx.set_global(StoreGlobal(store.clone())));
        store.update(cx, |store, _| store.register_root(1, root));

        // Mount a tree big enough that a per-call copy would be obvious.
        let mut ops = Vec::new();
        let mut parent = op(MountKind::Create);
        parent.tag = 1;
        ops.push(parent);
        let mut parent_insert = op(MountKind::Insert);
        parent_insert.tag = 1;
        ops.push(parent_insert);
        for row in 0..200i32 {
            let tag = 1000 + row;
            let mut create = op(MountKind::Create);
            create.tag = tag;
            create.component = "Text".into();
            create.parent_tag = 1;
            ops.push(create);
            let mut insert = op(MountKind::Insert);
            insert.tag = tag;
            insert.component = "Text".into();
            insert.parent_tag = 1;
            insert.index = row;
            ops.push(insert);
        }
        cx.update_entity(&store, |store, cx| {
            store.apply_batch(
                MountBatch {
                    surface_id: 1,
                    ops,
                    ..Default::default()
                },
                cx,
            );
        });

        // Two hundred children, all in one view.
        let copied = cx.read_entity(&store, |store, app| {
            crate::node_view::reset_snapshot_count();
            let tree = store.tree_view(app);
            let children = tree.children(1).len();
            assert_eq!(children, 200);
            crate::node_view::snapshot_count()
        });
        assert_eq!(
            copied, 0,
            "opening a tree view copied {copied} nodes; it must borrow the store's own map"
        );

        // A hook that needs one node's own fields still pays for one node, not
        // for the tree. `tree_view_at` supplies the node core is holding.
        let copied = cx.read_entity(&store, |store, app| {
            let node = store.nodes.get(&1005).expect("row is mounted");
            let borrowed = node.read(app);
            crate::node_view::reset_snapshot_count();
            let tree = store.tree_view_at(Some((1005, &borrowed)), app);
            assert!(tree.node(1005).is_some());
            crate::node_view::snapshot_count()
        });
        assert_eq!(
            copied, 1,
            "a tree built around one node copies that node and nothing else"
        );
    }

    /// A hook must see the tree as it is, not as it was before the batch.
    ///
    /// The snapshots a `TreeView` borrows are now written per operation instead
    /// of copied from every node per operation. A missed write shows up here as
    /// a hook reading a stale parent, child list or frame, because the hooks all
    /// run inside the batch, before the trailing rebuild.
    #[gpui::test]
    fn the_snapshot_map_follows_each_operation(cx: &mut TestAppContext) {
        use crate::extensions::{ComponentNode, StoreHandle, StoreObserver, TreeView};
        use std::sync::{Arc, Mutex};

        // The observer registry is process-wide, so no other test may install
        // one while this runs.
        let _exclusive = crate::extensions::exclusive_observers();

        #[derive(Default)]
        struct Seen {
            /// What the tree said after each insert, in order.
            inserts: Vec<String>,
            /// What the tree said at the end of every batch, in order.
            batches: Vec<String>,
            /// What the tree said after the remove.
            remove: Option<String>,
            /// What the tree said after the delete.
            delete: Option<String>,
        }

        struct Probe(Arc<Mutex<Seen>>);

        fn describe(tree: &TreeView, tag: i32, parent: i32) -> String {
            format!(
                "parent={:?} children={:?} frame={}x{}",
                tree.children(parent),
                tree.children(tag),
                tree.node(tag).map(|n| n.frame.w).unwrap_or(-1.0),
                tree.node(tag).map(|n| n.frame.h).unwrap_or(-1.0)
            )
        }

        impl StoreObserver for Probe {
            fn on_mount(&self, _node: &ComponentNode, _h: &StoreHandle, _cx: &mut gpui::App) {}
            fn on_update(
                &self,
                _node: &ComponentNode,
                _previous: &ComponentNode,
                _h: &StoreHandle,
                _cx: &mut gpui::App,
            ) {
            }
            fn after_batch(&self, tree: &TreeView, _h: &StoreHandle, _cx: &mut gpui::App) {
                if tree.node(7202).is_none() && tree.node(7101).is_none() {
                    return;
                }
                self.0
                    .lock()
                    .unwrap()
                    .batches
                    .push(describe(tree, 7202, 7101));
            }
            fn on_remove(&self, tag: i32, _h: &StoreHandle, _cx: &mut gpui::App) {
                if tag == 7202 {
                    self.0.lock().unwrap().delete = Some("deleted".into());
                }
            }
            fn on_insert(
                &self,
                child: &ComponentNode,
                parent: i32,
                _previous_children: &[i32],
                tree: &TreeView,
                _h: &StoreHandle,
                _cx: &mut gpui::App,
            ) {
                // Other tests run their own batches against this process-wide
                // registry, so only this test's own parent is recorded.
                if parent != 7101 {
                    return;
                }
                self.0
                    .lock()
                    .unwrap()
                    .inserts
                    .push(describe(tree, child.tag, parent));
            }
            fn on_remove_child(
                &self,
                child: i32,
                parent: i32,
                _retained: bool,
                tree: &TreeView,
                _h: &StoreHandle,
                _cx: &mut gpui::App,
            ) {
                if child == 7202 {
                    self.0.lock().unwrap().remove = Some(describe(tree, child, parent));
                }
            }
        }

        let seen = Arc::new(Mutex::new(Seen::default()));
        crate::extensions::register_store_observer(Arc::new(Probe(seen.clone())));

        let overlay_host = cx.new(|_| OverlayHost::new());
        let window = cx.open_window(gpui::size(px(120.0), px(100.0)), {
            let overlay_host = overlay_host.clone();
            move |_, _| SurfaceRootView::new(1).with_overlay_host(overlay_host)
        });
        let root = window.root(cx).unwrap();
        let any_window: gpui::AnyWindowHandle = window.into();
        let host = Host::test_stub();
        let frame_hook = FrameHook::new(host.clone());
        let store = cx.new(|_| ViewStore::new(host, any_window, frame_hook, overlay_host));
        cx.update(|cx| cx.set_global(StoreGlobal(store.clone())));
        store.update(cx, |store, _| store.register_root(1, root));

        let mut create_parent = op(MountKind::Create);
        create_parent.tag = 7101;
        let mut insert_parent = op(MountKind::Insert);
        insert_parent.tag = 7101;
        let mut create_child = op(MountKind::Create);
        create_child.tag = 7202;
        create_child.component = "Text".into();
        create_child.parent_tag = 7101;
        create_child.frame = RectF {
            x: 4.0,
            y: 6.0,
            w: 20.0,
            h: 10.0,
        };
        let mut insert_child = op(MountKind::Insert);
        insert_child.tag = 7202;
        insert_child.parent_tag = 7101;
        insert_child.component = "Text".into();
        cx.update_entity(&store, |store, cx| {
            store.apply_batch(
                MountBatch {
                    surface_id: 1,
                    ops: vec![create_parent, insert_parent, create_child, insert_child],
                    ..Default::default()
                },
                cx,
            );
        });

        let inserted = seen.lock().unwrap().inserts.clone();
        assert_eq!(
            inserted.last().map(String::as_str),
            Some("parent=[7202] children=[] frame=20x10"),
            "on_insert must see the child spliced into its parent: {inserted:?}"
        );

        let mut move_child = op(MountKind::Update);
        move_child.tag = 7202;
        move_child.component = "Text".into();
        move_child.parent_tag = 7101;
        move_child.frame = RectF {
            x: 0.0,
            y: 0.0,
            w: 55.0,
            h: 66.0,
        };
        cx.update_entity(&store, |store, cx| {
            store.apply_batch(
                MountBatch {
                    surface_id: 1,
                    ops: vec![move_child],
                    ..Default::default()
                },
                cx,
            );
        });
        assert_eq!(
            seen.lock().unwrap().batches.last().map(String::as_str),
            Some("parent=[7202] children=[] frame=55x66"),
            "the tree must report the frame an update gave the node"
        );

        let mut remove_child = op(MountKind::Remove);
        remove_child.tag = 7202;
        remove_child.component = "Text".into();
        remove_child.parent_tag = 7101;
        cx.update_entity(&store, |store, cx| {
            store.apply_batch(
                MountBatch {
                    surface_id: 1,
                    ops: vec![remove_child],
                    ..Default::default()
                },
                cx,
            );
        });
        // The hook runs before the splice is undone, exactly as it did when the
        // tree was read from the live nodes: the leaving card is still listed,
        // which is what lets the module find it and keep it for its exit.
        assert_eq!(
            seen.lock().unwrap().remove.as_deref(),
            Some("parent=[7202] children=[] frame=55x66"),
            "a remove hook must still see the card it is being told about"
        );

        let mut delete_child = op(MountKind::Delete);
        delete_child.tag = 7202;
        delete_child.component = "Text".into();
        delete_child.parent_tag = -1;
        cx.update_entity(&store, |store, cx| {
            store.apply_batch(
                MountBatch {
                    surface_id: 1,
                    ops: vec![delete_child],
                    ..Default::default()
                },
                cx,
            );
        });
        assert_eq!(seen.lock().unwrap().delete.as_deref(), Some("deleted"));
        assert_eq!(
            cx.read_entity(&store, |store, _| store.snapshots.contains_key(&7202)),
            false,
            "a deleted tag must not linger in the snapshot map"
        );
        assert_eq!(
            cx.read_entity(&store, |store, _| store.snapshots.contains_key(&7101)),
            true,
            "its parent must still be there"
        );
    }
}

fn log_mount_op(op: &MountOp) {
    log::debug!(
        "[store]   {:<6} tag={} parent={} index={} {:<30} frame=({:.1},{:.1} {:.1}x{:.1}) props_changed={} props={}",
        kind_name(op.kind),
        op.tag,
        op.parent_tag,
        op.index,
        op.component,
        op.frame.x,
        op.frame.y,
        op.frame.w,
        op.frame.h,
        op.props_changed,
        op.extension_props_json,
    );
}

/// cxx models a shared enum as a struct with a `repr` field, so the match is
/// intentionally not exhaustive.
fn kind_name(kind: MountKind) -> &'static str {
    match kind {
        MountKind::Create => "Create",
        MountKind::Delete => "Delete",
        MountKind::Insert => "Insert",
        MountKind::Remove => "Remove",
        MountKind::Update => "Update",
        _ => "Unknown",
    }
}

/// A separate entity because GPUI only re-runs `render` for entities the window
/// tracked while drawing, and the root view is not invalidated after its first
/// frame. Created before the window opens; it only toggles its own contents.
pub struct OverlayHost {
    overlays: Vec<(i32, Entity<SurfaceRootView>)>,
    portals: Vec<(i32, Entity<RNNodeView>)>,
}

impl OverlayHost {
    pub fn new() -> Self {
        Self {
            overlays: Vec::new(),
            portals: Vec::new(),
        }
    }

    /// How many surfaces are shown through the slot, for tests.
    #[cfg(test)]
    pub(crate) fn overlay_count(&self) -> usize {
        self.overlays.len()
    }

    pub fn insert(&mut self, surface_id: i32, overlay: Entity<SurfaceRootView>) {
        if !self.overlays.iter().any(|(id, _)| *id == surface_id) {
            self.overlays.push((surface_id, overlay));
        }
    }

    pub fn remove(&mut self, surface_id: i32) {
        self.overlays.retain(|(id, _)| *id != surface_id);
    }

    pub fn clear(&mut self) {
        self.overlays.clear();
        self.portals.clear();
    }

    pub fn insert_portal(&mut self, tag: i32, portal: Entity<RNNodeView>) {
        if !self.portals.iter().any(|(existing, _)| *existing == tag) {
            self.portals.push((tag, portal));
        }
    }

    pub fn remove_portal(&mut self, tag: i32) {
        self.portals.retain(|(existing, _)| *existing != tag);
    }
}

impl Render for OverlayHost {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        // Kept absolute so the empty host is exactly 0x0: a full-size empty div
        // would swallow every hover and click meant for the app behind it.
        let host = div().absolute().top_0().left_0();
        if self.overlays.is_empty() && self.portals.is_empty() {
            host
        } else {
            host.size_full()
                .children(self.overlays.iter().map(|(_, overlay)| overlay.clone()))
                .children(self.portals.iter().map(|(_, portal)| portal.clone()))
        }
    }
}

pub struct SurfaceRootView {
    surface_id: i32,
    pub(crate) kind: SurfaceKind,
    pub children: Vec<(i32, Entity<RNNodeView>)>,
    /// How many of the nodes mounted under this surface render a native
    /// surface.
    native_surfaces: u32,
    /// A GPUI-first app's content, painted where a React tree would be.
    app_content: Option<gpui::AnyView>,
    pub overlay_host: Option<Entity<OverlayHost>>,
    pub perf_monitor: Option<Entity<crate::desktop::perf_monitor::PerfMonitor>>,
    pub menu_bar: Option<Entity<crate::desktop::gpui_menu::MenuBar>>,
    /// Kept alive for as long as the surface: dropping it would stop the
    /// window-activation callback that dismisses an open menu on focus loss.
    pub menu_bar_activation_subscription: Option<Subscription>,
    #[cfg(all(target_os = "macos", feature = "visual-capture"))]
    native_view_probe: Option<Entity<crate::native_view_probe::NativeViewCompositionProbeView>>,
}

impl SurfaceRootView {
    pub fn new(surface_id: i32) -> Self {
        Self::with_kind(surface_id, SurfaceKind::Window)
    }

    pub fn with_kind(surface_id: i32, kind: SurfaceKind) -> Self {
        Self {
            surface_id,
            kind,
            children: Vec::new(),
            native_surfaces: 0,
            app_content: None,
            overlay_host: None,
            perf_monitor: None,
            menu_bar: None,
            menu_bar_activation_subscription: None,
            #[cfg(all(target_os = "macos", feature = "visual-capture"))]
            native_view_probe: None,
        }
    }

    /// Makes the root show a GPUI view instead of a React tree. The window chrome
    /// — the menu bar, the overlay slot, the key context — stays the root's.
    pub fn set_app_content(&mut self, view: gpui::AnyView) {
        self.app_content = Some(view);
    }

    pub fn with_overlay_host(mut self, overlay_host: Entity<OverlayHost>) -> Self {
        self.overlay_host = Some(overlay_host);
        self
    }

    #[cfg(all(target_os = "macos", feature = "visual-capture"))]
    pub fn with_native_view_probe(
        mut self,
        native_view_probe: Entity<crate::native_view_probe::NativeViewCompositionProbeView>,
    ) -> Self {
        self.native_view_probe = Some(native_view_probe);
        self
    }

    pub fn insert_child(&mut self, index: usize, tag: i32, child: Entity<RNNodeView>) {
        let index = index.min(self.children.len());
        self.children.insert(index, (tag, child));
    }

    pub fn remove_child(&mut self, tag: i32) {
        self.children.retain(|(child_tag, _)| *child_tag != tag);
    }

    /// Drops every child and the count that went with them.
    pub fn clear_children(&mut self) {
        self.children.clear();
        self.native_surfaces = 0;
    }

    /// Adds to the number of native surfaces mounted under this surface.
    pub(crate) fn add_native_surfaces(&mut self, delta: u32) -> bool {
        let before = self.native_surfaces;
        self.native_surfaces = before.saturating_add(delta);
        before == 0 && self.native_surfaces != 0
    }

    pub(crate) fn sub_native_surfaces(&mut self, delta: u32) -> bool {
        let before = self.native_surfaces;
        self.native_surfaces = before.saturating_sub(delta);
        before != 0 && self.native_surfaces == 0
    }

    /// Whether a native surface is mounted anywhere under this surface.
    pub(crate) fn has_native_surface(&self) -> bool {
        self.native_surfaces > 0
    }
}

/// The invisible grab border of a window with client-side decorations.
///
/// A frameless window has no native frame to drag, so the app supplies one. It
/// is drawn only where the compositor really did give client-side decorations:
/// an X11 window manager that ignores the request keeps its own frame, and a
/// second, invisible border inside it would take presses from the content with
/// no way to tell the user why.
#[cfg(target_os = "linux")]
fn resize_border(window: &mut Window) -> Option<gpui::AnyElement> {
    if !matches!(
        window.window_decorations(),
        gpui::Decorations::Client { .. }
    ) {
        return None;
    }
    if !window.is_resizable() {
        return None;
    }
    let size = window.viewport_size();
    let (width, height) = (f32::from(size.width), f32::from(size.height));
    let mut border = div().absolute().inset_0().size_full();
    for edge in crate::desktop::client_frame::EDGES {
        let bounds = crate::desktop::client_frame::border_bounds(edge, width, height);
        border = border.child(
            div()
                .absolute()
                .left(bounds.origin.x)
                .top(bounds.origin.y)
                .w(bounds.size.width)
                .h(bounds.size.height)
                // No background: the border only exists to catch the press, and
                // painting it would put an eight-pixel band over the app's own
                // edges.
                .cursor(crate::desktop::client_frame::edge_cursor(edge))
                .on_mouse_down(
                    gpui::MouseButton::Left,
                    move |event: &gpui::MouseDownEvent, window, cx| {
                        if event.click_count > 1 {
                            return;
                        }
                        window.start_window_resize(edge);
                        cx.stop_propagation();
                    },
                ),
        );
    }
    Some(border.into_any_element())
}

impl Render for SurfaceRootView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.kind == SurfaceKind::Embedded {
            return div()
                .size_full()
                .relative()
                .capture_any_mouse_down(|_, _, _| crate::events::begin_press_dispatch())
                .capture_any_mouse_up(|_, _, _| crate::events::begin_press_dispatch())
                .children(self.children.iter().map(|(_, child)| child.clone()))
                .into_any_element();
        }
        let has_fabric_native_view = self.has_native_surface();
        let mut root = div()
            .size_full()
            .relative()
            // Ahead of every node's listener, so a press that a title bar handed
            // to the window does not leave the next press marked as well.
            .capture_any_mouse_down(|_, _, _| crate::events::begin_press_dispatch())
            .capture_any_mouse_up(|_, _, _| crate::events::begin_press_dispatch())
            // The root stays hovered while any descendant is hit, so this only fires when
            // the pointer left the window.
            .on_mouse_exit(cx.listener(|_this, _event, window, cx| {
                crate::events::leave_root(window, cx);
            }))
            .children(self.app_content.clone())
            .children(self.children.iter().map(|(_, child)| child.clone()));
        #[cfg(all(target_os = "macos", feature = "visual-capture"))]
        if let Some(native_view_probe) = &self.native_view_probe {
            root = root.child(native_view_probe.clone());
        }
        if let Some(overlay_host) = &self.overlay_host {
            let has_native_composition = has_fabric_native_view || {
                #[cfg(all(target_os = "macos", feature = "visual-capture"))]
                {
                    self.native_view_probe.is_some()
                }
                #[cfg(not(all(target_os = "macos", feature = "visual-capture")))]
                {
                    false
                }
            };
            if has_native_composition {
                root = root.child(deferred(overlay_host.clone()).priority(100));
            } else {
                root = root.child(overlay_host.clone());
            }
        }
        if let Some(monitor) = self.perf_monitor.clone() {
            root = root.child(monitor);
        }
        // The hardware navigation buttons belong to the window, not the
        // surface: the handlers go on the outermost element so the in-window
        // menu bar (Linux) cannot swallow a press aimed at the app.
        // A press in the app body dismisses an open GPUI menu: clicking away
        // from a menu is expected to close it. The handler is in the capture
        // phase so the press is seen before any RN view consumes it, and it is
        // on the content area *below* the menu bar — a press on a menu title
        // still opens/replaces that menu, and the popup's own item clicks are in
        // its separate window and never reach here. `dismiss` resolves the menu
        // with `None`, the documented "dismissed" outcome for a context menu.
        let content = div()
            .id("surface-content")
            .flex_1()
            .min_h_0()
            .capture_any_mouse_down(cx.listener(|_this, _event, _window, cx| {
                let _ = crate::desktop::gpui_menu::MenuPopup::dismiss(cx);
            }))
            .child(root);
        // The root carries the app key context, so a shortcut with no scope can
        // match with nothing focused: GPUI evaluates a context predicate against
        // the focus path's contexts, and an empty stack matches nothing at all —
        // including a negation. Since this is the shallowest context, every
        // `ShortcutScope` inside it outranks it, which is the documented
        // "innermost wins, window scope last" order.
        let app_context =
            gpui::KeyContext::parse(crate::desktop::keymap::APP_CONTEXT).unwrap_or_default();
        let mut window_root = if let Some(menu_bar) = self.menu_bar.clone() {
            div()
                .size_full()
                .flex()
                .flex_col()
                .key_context(app_context)
                .child(menu_bar)
                .child(content)
        } else {
            div()
                .size_full()
                .flex()
                .flex_col()
                .key_context(app_context)
                .child(content)
        };
        if self.surface_id == APP_SURFACE_ID {
            for (button, event_name) in [
                (
                    MouseButton::Navigate(NavigationDirection::Back),
                    "hardwareBackPress",
                ),
                (
                    MouseButton::Navigate(NavigationDirection::Forward),
                    "hardwareForwardPress",
                ),
            ] {
                window_root = window_root.on_mouse_down(
                    button,
                    cx.listener(move |_this, _event, window, cx| {
                        if let Some(store) = cx.try_global::<StoreGlobal>() {
                            let store = store.0.read(cx);
                            store.host.emit_device_event(event_name);
                            store.frame_hook.arm(window);
                            log::info!("[navigation] emitted {event_name} from mouse button");
                        }
                        cx.stop_propagation();
                    }),
                );
            }
        }
        // Last, so the border paints in front of the app: whichever edge the
        // pointer is nearest is what a press there resizes.
        #[cfg(target_os = "linux")]
        if let Some(border) = resize_border(_window) {
            window_root = window_root.child(border);
        }
        window_root.into_any_element()
    }
}

pub fn store_from(cx: &App) -> Option<Entity<ViewStore>> {
    cx.try_global::<StoreGlobal>()
        .map(|global| global.0.clone())
}
