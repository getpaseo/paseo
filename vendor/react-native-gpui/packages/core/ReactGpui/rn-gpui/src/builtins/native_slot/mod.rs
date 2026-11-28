//! A place in a native tree that shows React Native children.
//!
//! `<NativeSlot>` inside a native tree is two things. In the tree it is an
//! instance, the placeholder: a box as wide as the tree's layout makes it. Next
//! to the tree, in React Native's, it is a `DesktopNativeSlot` node that holds
//! the children. The placeholder embeds that node, so the node is painted,
//! clipped and hit where the placeholder is, as part of the tree's element
//! tree. Layout goes the other way: the placeholder puts its width into the
//! node's Fabric state, which Yoga lays the node out at without a React render,
//! and the node's height becomes the placeholder's.
//!
//! Where React Native thinks the node is (`measure`, the test driver, the
//! accessibility tree) is corrected by `slot_shift`, a scroll link the placeholder
//! keeps current with where it was painted.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use gpui::{canvas, div, point, prelude::*, px, AnyElement, App, Window};
use serde_json::{Map, Value};

use crate::extensions::{register_component_renderer, ComponentNode, ComponentRenderer};
use crate::native_tree::{register_native_component, NativeComponent, NativeContext};

pub const COMPONENT: &str = "DesktopNativeSlot";

/// The type of the placeholder instance in a native tree.
pub const PLACEHOLDER: &str = "NativeSlot";

thread_local! {
    static HOSTS: std::cell::RefCell<std::collections::HashMap<(u32, i64), i32>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}

/// Notes the node that holds slot `slot` of tree `root`, when the node is made.
pub(crate) fn register_host(props: &Value, tag: i32) {
    let root = props.get("rootId").and_then(Value::as_u64);
    let slot = props.get("slotId").and_then(Value::as_i64);
    if let (Some(root), Some(slot)) = (root, slot) {
        HOSTS.with(|hosts| hosts.borrow_mut().insert((root as u32, slot), tag));
    }
}

/// The tags of the nodes that hold the slots of tree `root`, by slot id. A tag
/// whose node is gone is dropped by whoever looks it up.
pub(crate) fn hosts_of(root: u32) -> Vec<(i64, i32)> {
    HOSTS.with(|hosts| {
        hosts
            .borrow()
            .iter()
            .filter(|((tree, _), _)| *tree == root)
            .map(|((_, slot), tag)| (*slot, *tag))
            .collect()
    })
}

fn slot_tag(root: u32, slot: i64) -> Option<i32> {
    HOSTS.with(|hosts| hosts.borrow().get(&(root, slot)).copied())
}

struct NativeSlotRenderer;

impl ComponentRenderer for NativeSlotRenderer {
    fn render(
        &self,
        _node: &ComponentNode,
        _window: &mut Window,
        _cx: &mut App,
    ) -> Option<AnyElement> {
        None
    }
}

thread_local! {
    /// The placeholders whose content has not got the width the tree gave it,
    /// with their tree and since when.
    static WAITING: RefCell<HashMap<u64, (u32, std::time::Instant)>> = RefCell::new(HashMap::new());
}

/// How long a placeholder waits for its content before it is shown as it is.
const WAIT_LIMIT: std::time::Duration = std::time::Duration::from_millis(750);

static NEXT_KEY: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// Whether a slot has shown its first frame less than a moment ago and is still
/// waiting for its content to get the width the tree gave it. A slot that stops
/// being rendered while it waits is forgotten after that moment.
pub(crate) fn layouts_pending() -> bool {
    WAITING.with(|waiting| {
        waiting
            .borrow()
            .values()
            .any(|(_, since)| since.elapsed() < WAIT_LIMIT)
    })
}

struct Placeholder {
    reported: Rc<Cell<(f32, f32)>>,
    shown: Rc<Cell<bool>>,
    /// The tree's layout gave the slot no width (its parent is as wide as its
    /// content), so the slot takes the width of its content instead.
    fit: Rc<Cell<bool>>,
    key: u64,
}

impl Drop for Placeholder {
    fn drop(&mut self) {
        let key = self.key;
        let _ = WAITING.try_with(|waiting| waiting.borrow_mut().remove(&key));
    }
}

fn slot_id(props: &Map<String, Value>) -> i64 {
    props.get("slotId").and_then(Value::as_i64).unwrap_or(0)
}

impl NativeComponent for Placeholder {
    fn create(_props: &Map<String, Value>, _cx: &mut NativeContext) -> Self {
        Self {
            reported: Rc::new(Cell::new((-1.0, -1.0))),
            shown: Rc::new(Cell::new(false)),
            fit: Rc::new(Cell::new(false)),
            key: NEXT_KEY.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        }
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
        _children: Vec<AnyElement>,
        _window: &mut Window,
        cx: &mut App,
    ) -> AnyElement {
        let host = super::native_root::slot_host(slot_id(props));
        let height = host
            .as_ref()
            .map(|host| host.read(cx).frame.h)
            .unwrap_or(0.0);
        let slot_tag = slot_tag(super::native_root::current_root(), slot_id(props));
        let reported = self.reported.clone();
        let fill = props.get("fill").and_then(Value::as_bool).unwrap_or(false);
        let measured = host.clone();
        if props.get("fit").and_then(Value::as_bool) == Some(true) {
            self.fit.set(true);
        }
        // A slot as wide as its content does not clip it unless asked:
        // content that overflows its own box shows, as it would in React Native.
        let clip = props
            .get("clip")
            .and_then(Value::as_bool)
            .unwrap_or(!self.fit.get());
        let mut element = div().relative().w_full().min_h(px(0.0));
        if clip {
            element = element.overflow_hidden();
        }
        element = if fill {
            element.flex_grow(1.0).flex_shrink(1.0).flex_basis(px(0.0))
        } else {
            element.flex_shrink(1.0).h(px(height))
        };
        let fit = self.fit.clone();
        if fit.get() {
            if let Some(host) = &host {
                element = element.w(px(host.read(cx).frame.w)).flex_none();
            }
        }
        let has_frame = host.as_ref().is_some_and(|host| {
            let (width, _) = reported.get();
            width >= 0.0 && (host.read(cx).frame.w - width).abs() < 0.5
        });
        if has_frame {
            self.shown.set(true);
        }
        let key = self.key;
        let root = super::native_root::current_root();
        if has_frame {
            WAITING.with(|waiting| waiting.borrow_mut().remove(&key));
        }
        if let Some(host) = host.filter(|_| self.shown.get()) {
            element = element.child(host);
        }
        element
            .child(
                canvas(
                    move |bounds, window, cx| {
                        // Only a slot that is painted waits for its content, and
                        // one whose node has not arrived yet waits for it too:
                        // its content comes a commit after the tree.
                        if !has_frame {
                            WAITING.with(|waiting| {
                                waiting
                                    .borrow_mut()
                                    .entry(key)
                                    .or_insert_with(|| (root, std::time::Instant::now()));
                            });
                        }
                        let width = f32::from(bounds.size.width);
                        let height = f32::from(bounds.size.height);
                        if !fit.get()
                            && width < 0.5
                            && measured
                                .as_ref()
                                .is_some_and(|host| host.read(cx).frame.w > 0.5)
                        {
                            fit.set(true);
                            window.refresh();
                            return;
                        }
                        if let Some(host) = &measured {
                            let shift = host.read(cx).slot_shift.clone();
                            if let Some(shift) = shift {
                                let origin = host.read(cx).absolute_origin(cx);
                                let (offset_x, offset_y) = host.read(cx).window_offset();
                                let current = shift.get();
                                let next = point(
                                    f32::from(origin.x) + current.x
                                        - (f32::from(bounds.origin.x) - offset_x),
                                    f32::from(origin.y) + current.y
                                        - (f32::from(bounds.origin.y) - offset_y),
                                );
                                if next != current {
                                    shift.set(next);
                                }
                            }
                        }
                        let (last_width, last_height) = reported.get();
                        let height_matters = fill && (last_height - height).abs() > 0.01;
                        let changed = (last_width - width).abs() > 0.01 || height_matters;
                        if let Some(tag) = slot_tag.filter(|_| changed) {
                            if rn_gpui_sys::ffi::reportNativeSlotSize(
                                tag,
                                !fit.get(),
                                width,
                                fill,
                                height,
                            ) {
                                reported.set((width, height));
                            }
                        }
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full(),
            )
            .into_any_element()
    }
}

pub fn register() {
    register_native_component::<Placeholder>(PLACEHOLDER);
    register_component_renderer(COMPONENT, Arc::new(NativeSlotRenderer));
}
