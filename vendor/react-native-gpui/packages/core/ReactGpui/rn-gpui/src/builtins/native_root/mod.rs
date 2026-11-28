//! The native root: a box whose content is a native tree.
//!
//! A second React reconciler describes nested components of one family as
//! batches of operations, and [`crate::native_tree`] keeps them as instances. This
//! component is where such a tree meets React Native's layout: Yoga sizes the box
//! like any view, and the tree is built inside it as one GPUI element tree.
//!
//! The batches arrive from JavaScript through `__gpuiNativeRootApply(rootId,
//! json)` and are applied on the main thread. Events go back as `topNativeEvent`
//! on the box, naming the instance and the prop that holds its handler.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use gpui::{
    canvas, div, prelude::*, px, size, AnyElement, App, AvailableSpace, Element, GlobalElementId,
    InspectorElementId, LayoutId, Window,
};
use serde_json::{json, Map, Value};

use crate::extensions::{register_component_renderer, ComponentNode, ComponentRenderer};
use crate::host::Host;
use crate::native_tree::{
    register_native_component, NativeComponent, NativeContext, NativeOp, NativeTree,
};

/// The name of the event that tells JavaScript the size a tree was laid out at,
/// for it to remember. The box itself takes the size from the shadow node's
/// state.
pub const CONTENT_SIZE: &str = "__contentSize";

pub const COMPONENT: &str = "DesktopNativeRoot";

/// The type of the instance that holds a tree's top-level components.
pub const CONTAINER: &str = "NativeRootContainer";

struct RootState {
    tree: NativeTree,
    /// The tag of the node that shows this tree, once it has rendered.
    tag: Rc<Cell<Option<i32>>>,
    /// The box has no height of its own: the tree is laid out at its natural
    /// height and that height is reported to the box's shadow node.
    auto_height: Rc<Cell<bool>>,
    /// The box has no width of its own: the tree's max-content and min-content
    /// widths are reported with the height, and the box fits between them.
    auto_width: Rc<Cell<bool>>,
    reported_height: Rc<Cell<f32>>,
    reported_width: Rc<Cell<(f32, f32)>>,
}

thread_local! {
    static CURRENT_ROOT: Cell<u32> = const { Cell::new(0) };
    /// The nodes that hold the React Native children of the slots of the tree
    /// being rendered, by slot id.
    static SLOT_HOSTS: RefCell<HashMap<i64, gpui::Entity<crate::node_view::RNNodeView>>> =
        RefCell::new(HashMap::new());
    static TREES: RefCell<HashMap<u32, RootState>> = RefCell::new(HashMap::new());
    /// The trees that appeared less than `SETTLE_LIMIT` ago, which the window
    /// holds its last frame for while their box does not have the tree's size
    /// or a slot waits for its content.
    static UNSETTLED: RefCell<HashMap<u32, Settling>> = RefCell::new(HashMap::new());
    static SEQUENCE: Cell<u64> = const { Cell::new(0) };
    /// Every tree seen, gone ones too: a box rendered once more as its tree is
    /// destroyed is not a new tree. Ids are never reused.
    static STARTED: RefCell<std::collections::HashSet<u32>> = RefCell::new(Default::default());
    /// The nodes that rendered before their tree arrived, so the tree's first
    /// batch repaints them.
    static EARLY_TAGS: RefCell<HashMap<u32, i32>> = RefCell::new(HashMap::new());
    /// The hinted trees whose first content has been checked against their box.
    static CHECKED: RefCell<std::collections::HashSet<u32>> = RefCell::new(Default::default());
    static HOLD: Rc<dyn Fn() -> bool> = Rc::new(holding);
    /// When the window began holding its last frame, while it does.
    static HELD_SINCE: Cell<Option<std::time::Instant>> = const { Cell::new(None) };
    /// When the windows' recent holds ended and how long each took.
    static RECENT_HOLDS: RefCell<std::collections::VecDeque<(std::time::Instant, std::time::Duration)>> =
        RefCell::new(std::collections::VecDeque::new());
}

/// How much holding a window may do within `HOLD_BUDGET_WINDOW` before new
/// roots stop holding it: a stream of roots that mount one after another
/// would otherwise keep the window on its last frame.
const HOLD_BUDGET: std::time::Duration = std::time::Duration::from_millis(200);
const HOLD_BUDGET_WINDOW: std::time::Duration = std::time::Duration::from_secs(1);

/// How recent a scroll event is that keeps a new root from holding the window:
/// a row that mounts while the list is scrolled shifts nothing in view, and a
/// frozen frame would stop the scroll.
const SCROLL_QUIET: std::time::Duration = std::time::Duration::from_millis(150);

/// Records when the window starts and stops holding.
fn note_hold(held: bool) {
    let now = std::time::Instant::now();
    HELD_SINCE.with(|since| match (since.get(), held) {
        (None, true) => since.set(Some(now)),
        (Some(started), false) => {
            since.set(None);
            let took = now.duration_since(started);
            RECENT_HOLDS.with(|recent| recent.borrow_mut().push_back((now, took)));
            crate::counters::add(crate::counters::Counter::NativeRootHolds, 1);
            crate::counters::add(
                crate::counters::Counter::NativeRootHeldMicros,
                took.as_micros() as u64,
            );
        }
        _ => {}
    });
}

/// Whether a new root may hold the window: not while it is scrolling, and not
/// once it has held for `HOLD_BUDGET` within the last `HOLD_BUDGET_WINDOW`.
fn hold_allowed() -> bool {
    let spent = RECENT_HOLDS.with(|recent| {
        let mut recent = recent.borrow_mut();
        while recent
            .front()
            .is_some_and(|(ended, _)| ended.elapsed() > HOLD_BUDGET_WINDOW)
        {
            recent.pop_front();
        }
        recent
            .iter()
            .map(|(_, took)| *took)
            .sum::<std::time::Duration>()
    }) + HELD_SINCE.with(|since| {
        since
            .get()
            .map_or(std::time::Duration::ZERO, |at| at.elapsed())
    });
    let allowed = !crate::wheel::scrolled_within(SCROLL_QUIET) && spent <= HOLD_BUDGET;
    if !allowed {
        crate::counters::add(crate::counters::Counter::NativeRootHoldsSkipped, 1);
    }
    allowed
}

/// How long a window holds its last frame for new trees to settle.
const SETTLE_LIMIT: std::time::Duration = std::time::Duration::from_millis(250);

struct Settling {
    since: std::time::Instant,
    /// When the tree was last rendered and last painted, in one sequence.
    rendered: Option<u64>,
    painted: Option<u64>,
}

fn next_sequence() -> u64 {
    SEQUENCE.with(|sequence| {
        sequence.set(sequence.get() + 1);
        sequence.get()
    })
}

/// Whether a window should keep showing its last frame: a new tree is still
/// settling, so the frame would show it, and what is laid out around it, at
/// sizes about to change. A tree rendered but not painted is out of view.
fn holding() -> bool {
    let held = UNSETTLED.with(|unsettled| {
        let mut unsettled = unsettled.borrow_mut();
        unsettled.retain(|_, settling| settling.since.elapsed() < SETTLE_LIMIT);
        unsettled.values().any(|settling| match settling.rendered {
            None => true,
            Some(rendered) => settling.painted.is_some_and(|painted| painted > rendered),
        })
    });
    note_hold(held);
    held
}

fn root_id(node: &ComponentNode) -> u32 {
    node.props
        .get("rootId")
        .and_then(Value::as_u64)
        .unwrap_or(0) as u32
}

/// Applies a batch of operations to the tree `root`, making the tree if this is
/// its first, and repaints the node that shows it. `"destroy"` drops the tree.
pub(crate) fn apply_ops(cx: &mut App, root: u32, payload: &str) {
    if payload == "destroy" {
        TREES.with(|trees| {
            trees.borrow_mut().remove(&root);
        });
        UNSETTLED.with(|unsettled| unsettled.borrow_mut().remove(&root));
        EARLY_TAGS.with(|tags| tags.borrow_mut().remove(&root));
        CHECKED.with(|checked| checked.borrow_mut().remove(&root));
        return;
    }
    if payload == "auto-height" || payload == "auto-width" {
        TREES.with(|trees| {
            let mut trees = trees.borrow_mut();
            let state = trees.entry(root).or_insert_with(|| new_state(root, cx));
            if payload == "auto-height" {
                state.auto_height.set(true);
            } else {
                state.auto_width.set(true);
            }
        });
        return;
    }
    let ops = match serde_json::from_str::<Value>(payload)
        .map_err(|error| error.to_string())
        .and_then(|batch| NativeOp::parse_batch(&batch))
    {
        Ok(ops) => ops,
        Err(error) => {
            log::error!("[native-root] bad batch for tree {root}: {error}");
            return;
        }
    };
    let Some(store) = crate::store::store_from(cx) else {
        return;
    };
    drop_stale_trees(cx, root);
    let tag = TREES.with(|trees| {
        let mut trees = trees.borrow_mut();
        let state = trees.entry(root).or_insert_with(|| new_state(root, cx));
        let window = state
            .tag
            .get()
            .and_then(|tag| store.read(cx).nodes.get(&tag).cloned())
            .and_then(|node| crate::store::window_of_surface(node.read(cx).surface_id));
        if window.is_some() {
            state.tree.set_window(window);
        }
        let started = std::time::Instant::now();
        let count = ops.len() as u64;
        state.tree.apply(ops, cx);
        crate::counters::add(crate::counters::Counter::NativeOpsApplied, count);
        crate::counters::add(
            crate::counters::Counter::NativeApplyMicros,
            started.elapsed().as_micros() as u64,
        );
        state.tag.get()
    });
    if let Some(node) = tag.and_then(|tag| store.read(cx).nodes.get(&tag).cloned()) {
        node.update(cx, |_, cx| cx.notify());
        if let Some(window) = crate::store::window_of_surface(node.read(cx).surface_id) {
            draw_settling_now(window, cx);
        }
    }
}

thread_local! {
    static DRAW_QUEUED: Cell<bool> = const { Cell::new(false) };
}

/// While a tree is settling, draws `window` as soon as new content arrives
/// instead of on its next frame: the frame is not shown during a hold, so a
/// size that takes several rounds between the tree and React Native's layout
/// settles in one frame interval rather than one per round.
pub(crate) fn draw_settling_now(window: gpui::AnyWindowHandle, cx: &mut App) {
    if UNSETTLED.with(|unsettled| unsettled.borrow().is_empty())
        || DRAW_QUEUED.with(|queued| queued.replace(true))
    {
        return;
    }
    cx.defer(move |cx| {
        DRAW_QUEUED.with(|queued| queued.set(false));
        let _ = window.update(cx, |_, window, cx| window.draw_while_held(cx));
    });
}

/// Whether this is the first time the tree `root` is seen, by its box rendering
/// or its first batch arriving, whichever comes first.
fn first_seen(root: u32) -> bool {
    STARTED.with(|started| started.borrow_mut().insert(root))
}

/// Starts holding the window's last frame for the tree `root` to settle, unless
/// the window is scrolling or has held enough lately. Whether it did.
fn begin_settling(root: u32) -> bool {
    if !hold_allowed() {
        return false;
    }
    UNSETTLED.with(|unsettled| {
        unsettled.borrow_mut().insert(
            root,
            Settling {
                since: std::time::Instant::now(),
                rendered: None,
                painted: None,
            },
        );
    });
    true
}

fn new_state(root: u32, cx: &App) -> RootState {
    if first_seen(root) {
        begin_settling(root);
    }
    let host: Host = crate::store::store_from(cx)
        .map(|store| store.read(cx).host.clone())
        .expect("the store exists while a tree is applied to");
    let tag = Rc::new(Cell::new(
        EARLY_TAGS.with(|tags| tags.borrow_mut().remove(&root)),
    ));
    let sink_tag = tag.clone();
    let mut tree = NativeTree::new(move |event| {
        if let Some(tag) = sink_tag.get() {
            host.dispatch_event(
                tag,
                "topNativeEvent",
                &json!({
                    "id": event.id,
                    "name": event.name,
                    "payload": event.payload,
                }),
            );
        }
    });
    tree.set_instance_renderer(Rc::new(move |id, window, cx| {
        CURRENT_ROOT.with(|current| current.set(root));
        collect_slot_hosts(root, cx);
        TREES.with(|trees| match trees.borrow_mut().get_mut(&root) {
            Some(state) => state.tree.render(id, window, cx),
            None => div().into_any_element(),
        })
    }));
    RootState {
        tree,
        tag,
        auto_height: Rc::new(Cell::new(false)),
        auto_width: Rc::new(Cell::new(false)),
        reported_height: Rc::new(Cell::new(-1.0)),
        reported_width: Rc::new(Cell::new((-1.0, -1.0))),
    }
}

/// Drops the trees whose node is gone, which is what a reload or an unmount that
/// never sent `destroy` leaves behind. `keep` is the tree being applied to.
fn drop_stale_trees(cx: &App, keep: u32) {
    let Some(store) = crate::store::store_from(cx) else {
        return;
    };
    let store = store.read(cx);
    TREES.with(|trees| {
        trees.borrow_mut().retain(|root, state| {
            *root == keep
                || state
                    .tag
                    .get()
                    .is_none_or(|tag| store.nodes.contains_key(&tag))
        });
    });
}

fn collect_slot_hosts(root: u32, cx: &App) {
    let Some(store) = crate::store::store_from(cx) else {
        return;
    };
    let store = store.read(cx);
    let hosts = crate::builtins::native_slot::hosts_of(root)
        .into_iter()
        .filter_map(|(slot, tag)| Some((slot, store.nodes.get(&tag)?.clone())))
        .collect::<HashMap<_, _>>();
    SLOT_HOSTS.with(|slots| *slots.borrow_mut() = hosts);
}

/// The tree whose components are being rendered.
pub(crate) fn current_root() -> u32 {
    CURRENT_ROOT.with(Cell::get)
}

/// Renders the node that shows tree `root` again, once the current frame is
/// done. For a component that learns something while painting that changes what
/// it renders, such as the size of an item.
pub(crate) fn notify_root_later(root: u32, window: &mut Window, cx: &mut App) {
    window.defer(cx, move |_, cx| {
        let Some(store) = crate::store::store_from(cx) else {
            return;
        };
        let tag = TREES.with(|trees| trees.borrow().get(&root).and_then(|state| state.tag.get()));
        if let Some(node) = tag.and_then(|tag| store.read(cx).nodes.get(&tag).cloned()) {
            node.update(cx, |_, cx| cx.notify());
        }
    });
}

/// The node holding the React Native children of slot `slot` in the tree being
/// rendered.
pub(crate) fn slot_host(slot: i64) -> Option<gpui::Entity<crate::node_view::RNNodeView>> {
    SLOT_HOSTS.with(|slots| slots.borrow().get(&slot).cloned())
}

struct NativeRootRenderer;

impl ComponentRenderer for NativeRootRenderer {
    fn render(
        &self,
        _node: &ComponentNode,
        _window: &mut Window,
        _cx: &mut App,
    ) -> Option<AnyElement> {
        None
    }

    fn content(
        &self,
        node: &ComponentNode,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<AnyElement> {
        let root = root_id(node);
        // A box that started at a remembered size is probably right already:
        // it holds the window only if its first content shows it was not.
        let hinted = node.props.get("hinted").and_then(Value::as_bool) == Some(true);
        // A box whose tree has not arrived yet holds the window too: the frame
        // would show the page around it at sizes about to change.
        if root != 0 && TREES.with(|trees| !trees.borrow().contains_key(&root)) {
            if first_seen(root) {
                EARLY_TAGS.with(|tags| tags.borrow_mut().insert(root, node.tag));
                if !hinted && begin_settling(root) {
                    window.set_presentation_hold(Some(HOLD.with(Rc::clone)));
                }
            }
            return None;
        }
        TREES.with(|trees| {
            let mut trees = trees.borrow_mut();
            let state = trees.get_mut(&root)?;
            state.tag.set(Some(node.tag));
            let settling = UNSETTLED.with(|unsettled| {
                unsettled
                    .borrow_mut()
                    .get_mut(&root)
                    .map(|settling| settling.rendered = Some(next_sequence()))
                    .is_some()
            });
            if settling {
                window.set_presentation_hold(Some(HOLD.with(Rc::clone)));
            }
            let started = std::time::Instant::now();
            CURRENT_ROOT.with(|current| current.set(root));
            collect_slot_hosts(root, cx);
            let auto = state.auto_height.get();
            let auto_width = state.auto_width.get();
            let roots: Vec<_> = state.tree.roots().to_vec();
            // A tree of one component without a width of its own is laid out
            // as the item of a row, as a GPUI flex item of a row would be: it
            // shrinks with the box down to its automatic minimum width.
            let single = match roots.as_slice() {
                [root] if auto_width => match state.tree.children(*root) {
                    [child] => Some(*child),
                    _ => None,
                },
                _ => None,
            };
            let shown = single.map_or_else(|| roots.clone(), |child| vec![child]);
            let elements: Vec<AnyElement> = shown
                .iter()
                .map(|&id| state.tree.render(id, window, cx))
                .collect();
            // Copies that are only laid out, as items of a row: one in a row
            // of no width, where they shrink as far as GPUI lets them, and one
            // at max-content. Their extents are the tree's min-content and
            // max-content widths.
            let probes = auto_width.then(|| {
                [single.is_some(), false].map(|shrunk| {
                    let measured: Vec<Measured> = shown
                        .iter()
                        .map(|&id| Measured::new(state.tree.render(id, window, cx)))
                        .collect();
                    let ids = measured
                        .iter()
                        .map(|item| item.id.clone())
                        .collect::<Vec<_>>();
                    let probe = div().flex().flex_row().children(measured);
                    let probe = if shrunk { probe.w(px(0.)) } else { probe };
                    (probe.into_any_element(), ids)
                })
            });
            crate::counters::add(
                crate::counters::Counter::NativeRenderMicros,
                started.elapsed().as_micros() as u64,
            );
            let reported = state.reported_height.clone();
            let reported_width = state.reported_width.clone();
            let tag = node.tag;
            let measure = canvas(
                move |bounds, window, cx| {
                    let height = f32::from(bounds.size.height);
                    let widths = probes.map(|[min, max]| {
                        let extent = |(mut probe, ids): (
                            AnyElement,
                            Vec<Rc<Cell<Option<gpui::LayoutId>>>>,
                        ),
                                      width: AvailableSpace,
                                      window: &mut Window,
                                      cx: &mut App| {
                            probe.layout_as_root(
                                size(width, AvailableSpace::MaxContent),
                                window,
                                cx,
                            );
                            let bounds: Vec<_> = ids
                                .iter()
                                .filter_map(|id| id.get())
                                .map(|id| window.layout_bounds(id))
                                .collect();
                            let left = bounds
                                .iter()
                                .map(|b| f32::from(b.left()))
                                .fold(f32::INFINITY, f32::min);
                            let right = bounds
                                .iter()
                                .map(|b| f32::from(b.right()))
                                .fold(f32::NEG_INFINITY, f32::max);
                            if bounds.is_empty() {
                                0.0
                            } else {
                                right - left
                            }
                        };
                        let min = extent(min, AvailableSpace::Definite(px(0.)), window, cx);
                        let max = extent(max, AvailableSpace::MaxContent, window, cx);
                        (max, min.min(max))
                    });
                    let changed = (reported.get() - height).abs() > 0.01
                        || widths.is_some_and(|(max, min)| {
                            let (old_max, old_min) = reported_width.get();
                            (old_max - max).abs() > 0.01 || (old_min - min).abs() > 0.01
                        });
                    if changed {
                        let (max, min) = widths.unwrap_or_default();
                        if rn_gpui_sys::ffi::reportNativeRootSize(
                            tag,
                            height,
                            widths.is_some(),
                            max,
                            min,
                        ) {
                            reported.set(height);
                            let payload = match widths {
                                Some((max, min)) => {
                                    reported_width.set((max, min));
                                    json!({ "width": max, "minWidth": min, "height": height })
                                }
                                None => json!({ "height": height }),
                            };
                            if let Some(store) = crate::store::store_from(cx) {
                                store.read(cx).host.dispatch_event(
                                    tag,
                                    "topNativeEvent",
                                    &json!({ "id": 0, "name": CONTENT_SIZE, "payload": payload }),
                                );
                            }
                        }
                    }
                },
                |_, _, _, _| {},
            )
            .absolute()
            .size_full();
            let frame_size = (node.frame.w, node.frame.h);
            // A tree without its first batch is empty, and as high as its
            // empty box: that is not its size.
            let has_content = state
                .tree
                .roots()
                .first()
                .is_some_and(|&container| !state.tree.children(container).is_empty());
            let settled_width = state.reported_width.clone();
            let late = hinted
                && !settling
                && has_content
                && CHECKED.with(|checked| checked.borrow_mut().insert(root));
            let settle = (settling || late).then(|| {
                canvas(
                    move |bounds, window, _| {
                        let (width, height) = frame_size;
                        let (max, min) = settled_width.get();
                        // Yoga rounds the box to the pixel grid: within half a
                        // device pixel of the tree, it will not move again.
                        let slack = 0.5 / window.scale_factor();
                        let sized = (!auto
                            || (height - f32::from(bounds.size.height)).abs() <= slack)
                            && (!auto_width
                                || (max >= 0.0 && width >= min - slack && width <= max + slack));
                        let settled = has_content && sized;
                        // A settled tree stays watched until its time is up: a
                        // component that renders its real content in a later
                        // batch grows the tree after it first matched its box.
                        if !settled {
                            if late && begin_settling(root) {
                                window.set_presentation_hold(Some(HOLD.with(Rc::clone)));
                            }
                            UNSETTLED.with(|unsettled| {
                                if let Some(settling) = unsettled.borrow_mut().get_mut(&root) {
                                    settling.rendered = Some(next_sequence());
                                    settling.painted = Some(next_sequence());
                                }
                            });
                        }
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full()
            });
            let frame = div().absolute().w_full();
            let frame = if auto { frame } else { frame.h_full() };
            let auto = auto || auto_width;
            Some(
                frame
                    .flex()
                    .when(single.is_some(), |this| this.flex_row())
                    .when(single.is_none(), |this| this.flex_col())
                    .tab_group()
                    .tab_index(node.tag as isize)
                    .on_key_down(|event, window, cx| {
                        if event.keystroke.key == "tab" {
                            if event.keystroke.modifiers.shift {
                                window.focus_prev(cx);
                            } else {
                                window.focus_next(cx);
                            }
                            cx.stop_propagation();
                        }
                    })
                    .children(elements)
                    .when(auto, |this| this.child(measure))
                    .children(settle)
                    .into_any_element(),
            )
        })
    }
}

/// The instance every tree hangs from: a box that lays its children out in a
/// column, or in a row when its `direction` prop says so.
struct Container;

impl NativeComponent for Container {
    fn create(_props: &Map<String, Value>, _cx: &mut NativeContext) -> Self {
        Container
    }

    fn update(
        &mut self,
        _props: &Map<String, Value>,
        _changed: &[String],
        _cx: &mut NativeContext,
    ) {
    }

    fn render(
        &mut self,
        props: &Map<String, Value>,
        children: Vec<AnyElement>,
        _window: &mut Window,
        _cx: &mut App,
    ) -> AnyElement {
        let row = props.get("direction").and_then(Value::as_str) == Some("row");
        let element = div().size_full().flex();
        if row {
            element.flex_row()
        } else {
            element.flex_col()
        }
        .children(children)
        .into_any_element()
    }
}

pub fn register() {
    register_native_component::<Container>(CONTAINER);
    register_component_renderer(COMPONENT, Arc::new(NativeRootRenderer));
}

/// What the test driver and the accessibility checks see of one instance.
pub(crate) struct InstanceInfo {
    pub tag: i32,
    pub type_name: String,
    pub props: Map<String, Value>,
    /// In window coordinates, once the instance has painted.
    pub bounds: Option<gpui::Bounds<gpui::Pixels>>,
    pub children: Vec<i32>,
    pub root: u32,
}

thread_local! {
    static SYNTHETIC: RefCell<Synthetic> = RefCell::new(Synthetic::default());
}

/// The tags the test driver gives instances. Fabric's are positive; these are
/// negative, so one number says which kind it is and which instance.
#[derive(Default)]
struct Synthetic {
    by_instance: HashMap<(u32, u64), i32>,
    by_tag: HashMap<i32, (u32, u64)>,
    last: i32,
}

fn synthetic_tag(root: u32, id: u64) -> i32 {
    SYNTHETIC.with(|synthetic| {
        let mut synthetic = synthetic.borrow_mut();
        if let Some(tag) = synthetic.by_instance.get(&(root, id)) {
            return *tag;
        }
        synthetic.last -= 1;
        let tag = synthetic.last;
        synthetic.by_instance.insert((root, id), tag);
        synthetic.by_tag.insert(tag, (root, id));
        tag
    })
}

/// Every instance of the tree `root`, parents first.
pub(crate) fn instances(root: u32) -> Vec<InstanceInfo> {
    TREES.with(|trees| {
        let trees = trees.borrow();
        let Some(state) = trees.get(&root) else {
            return Vec::new();
        };
        state
            .tree
            .ids()
            .into_iter()
            .map(|id| InstanceInfo {
                tag: synthetic_tag(root, id),
                type_name: state.tree.type_of(id).unwrap_or_default().to_string(),
                props: state.tree.props_of(id).cloned().unwrap_or_default(),
                bounds: state.tree.bounds_of(id),
                children: state
                    .tree
                    .children(id)
                    .iter()
                    .map(|child| synthetic_tag(root, *child))
                    .collect(),
                root,
            })
            .collect()
    })
}

/// Every tree that has a node showing it.
pub(crate) fn root_ids() -> Vec<u32> {
    TREES.with(|trees| trees.borrow().keys().copied().collect())
}

/// Where a click on the instance with this tag goes: its centre in window
/// coordinates, and the tag of the node that shows its tree, which is what the
/// pointer is over as far as React Native's hit testing goes.
pub(crate) fn pointer_target(tag: i32) -> Option<(gpui::Point<gpui::Pixels>, i32)> {
    let (root, id) = SYNTHETIC.with(|synthetic| synthetic.borrow().by_tag.get(&tag).copied())?;
    TREES.with(|trees| {
        let trees = trees.borrow();
        let state = trees.get(&root)?;
        let bounds = state.tree.bounds_of(id)?;
        Some((bounds.center(), state.tag.get()?))
    })
}

/// Lays out its child as itself and keeps the child's layout id, so the size
/// the child was given can be read after a probe layout.
struct Measured {
    child: AnyElement,
    id: Rc<Cell<Option<LayoutId>>>,
}

impl Measured {
    fn new(child: AnyElement) -> Self {
        Self {
            child,
            id: Rc::new(Cell::new(None)),
        }
    }
}

impl IntoElement for Measured {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

impl Element for Measured {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<gpui::ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        let id = self.child.request_layout(window, cx);
        self.id.set(Some(id));
        (id, ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: gpui::Bounds<gpui::Pixels>,
        _request_layout: &mut (),
        _window: &mut Window,
        _cx: &mut App,
    ) {
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: gpui::Bounds<gpui::Pixels>,
        _request_layout: &mut (),
        _prepaint: &mut (),
        _window: &mut Window,
        _cx: &mut App,
    ) {
    }
}
