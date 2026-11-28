//! A virtual list for native trees.
//!
//! The list owns the scrolling and tells JavaScript which items are in view
//! (`onRangeChange`, `{ first, last }`); JavaScript renders those items, and a
//! few more on each side, as `NativeVirtualItem` children. Items have the height
//! of their content: a native item is measured by GPUI, an item that holds a
//! `NativeSlot` by the layout of its React Native content. Items not measured
//! yet count as the estimate. When an item above the viewport changes size the
//! scroll position moves by the difference, so what is on screen stays put.
//!
//! `scrollRequest` scrolls to an index or an offset, and `onEndReached` fires
//! when the end comes within a threshold of the viewport.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use gpui::{canvas, div, point, prelude::*, px, AnyElement, App, ScrollHandle, Window};
use serde_json::{json, Map, Value};

use crate::native_tree::{
    register_native_component, NativeComponent, NativeContext, NativeEmitter,
};

pub const LIST: &str = "NativeVirtualList";
pub const ITEM: &str = "NativeVirtualItem";

fn number(props: &Map<String, Value>, name: &str) -> f32 {
    props.get(name).and_then(Value::as_f64).unwrap_or(0.0) as f32
}

/// The heights of a list's items: measured ones, and the estimate for the rest.
/// Positions are prefix sums, kept in a Fenwick tree of each measured item's
/// difference from the estimate, so a position and an item at a position are
/// both a logarithm.
struct Heights {
    estimate: f32,
    count: usize,
    measured: HashMap<usize, f32>,
    tree: Vec<f64>,
}

impl Heights {
    fn new(estimate: f32, count: usize) -> Self {
        Self {
            estimate,
            count,
            measured: HashMap::new(),
            tree: vec![0.0; count + 1],
        }
    }

    fn rebuild(&mut self, estimate: f32, count: usize) {
        if estimate == self.estimate && count == self.count {
            return;
        }
        self.estimate = estimate;
        self.count = count;
        self.measured.retain(|index, _| *index < count);
        self.tree = vec![0.0; count + 1];
        let entries: Vec<_> = self.measured.iter().map(|(i, h)| (*i, *h)).collect();
        for (index, height) in entries {
            self.add(index, f64::from(height - estimate));
        }
    }

    fn add(&mut self, index: usize, delta: f64) {
        let mut at = index + 1;
        while at < self.tree.len() {
            self.tree[at] += delta;
            at += at & at.wrapping_neg();
        }
    }

    fn delta_before(&self, index: usize) -> f64 {
        let mut at = index.min(self.count);
        let mut sum = 0.0;
        while at > 0 {
            sum += self.tree[at];
            at -= at & at.wrapping_neg();
        }
        sum
    }

    fn height(&self, index: usize) -> f32 {
        self.measured.get(&index).copied().unwrap_or(self.estimate)
    }

    fn offset_of(&self, index: usize) -> f32 {
        (index as f64 * f64::from(self.estimate) + self.delta_before(index)) as f32
    }

    fn total(&self) -> f32 {
        self.offset_of(self.count)
    }

    /// The item that covers `y`, the last one if `y` is past the end.
    fn index_at(&self, y: f32) -> usize {
        if self.count == 0 {
            return 0;
        }
        let (mut low, mut high) = (0, self.count - 1);
        while low < high {
            let middle = (low + high).div_ceil(2);
            if self.offset_of(middle) <= y {
                low = middle;
            } else {
                high = middle - 1;
            }
        }
        low
    }

    /// Records a measurement, returning how far it moved what follows the item.
    fn set(&mut self, index: usize, height: f32) -> Option<f32> {
        if index >= self.count || (self.height(index) - height).abs() < 0.5 {
            return None;
        }
        let before = self.height(index);
        self.measured.insert(index, height);
        self.add(index, f64::from(height - before));
        Some(height - before)
    }
}

struct ListState {
    heights: Heights,
    scroll: ScrollHandle,
}

thread_local! {
    static LISTS: RefCell<HashMap<u32, Rc<RefCell<ListState>>>> = RefCell::new(HashMap::new());
}

fn list_state(id: u32) -> Option<Rc<RefCell<ListState>>> {
    LISTS.with(|lists| lists.borrow().get(&id).cloned())
}

#[derive(Clone, Copy)]
struct ScrollRequest {
    id: i64,
    index: Option<usize>,
    offset: f32,
    align: f32,
    attempts: u8,
}

fn read_request(value: &Value) -> Option<ScrollRequest> {
    let id = value.get("id")?.as_i64()?;
    let align = match value.get("align").and_then(Value::as_str) {
        Some("center") => 0.5,
        Some("end") => 1.0,
        _ => 0.0,
    };
    Some(ScrollRequest {
        id,
        index: value
            .get("index")
            .and_then(Value::as_u64)
            .map(|i| i as usize),
        offset: value.get("offset").and_then(Value::as_f64).unwrap_or(0.0) as f32,
        align,
        attempts: 0,
    })
}

struct VirtualList {
    emitter: NativeEmitter,
    id: u32,
    state: Rc<RefCell<ListState>>,
    reported: Rc<Cell<(i64, i64)>>,
    pending: Rc<Cell<Option<ScrollRequest>>>,
    end_reached_for: Rc<Cell<i64>>,
}

fn list_id(props: &Map<String, Value>) -> u32 {
    props.get("listId").and_then(Value::as_u64).unwrap_or(0) as u32
}

impl NativeComponent for VirtualList {
    fn create(props: &Map<String, Value>, cx: &mut NativeContext) -> Self {
        let id = list_id(props);
        let state = Rc::new(RefCell::new(ListState {
            heights: Heights::new(
                number(props, "estimatedItemHeight").max(1.0),
                number(props, "count") as usize,
            ),
            scroll: ScrollHandle::new(),
        }));
        LISTS.with(|lists| lists.borrow_mut().insert(id, state.clone()));
        Self {
            emitter: cx.emitter(),
            id,
            state,
            reported: Rc::new(Cell::new((-2, -2))),
            pending: Rc::new(Cell::new(None)),
            end_reached_for: Rc::new(Cell::new(-1)),
        }
    }

    fn update(&mut self, props: &Map<String, Value>, changed: &[String], _cx: &mut NativeContext) {
        self.state.borrow_mut().heights.rebuild(
            number(props, "estimatedItemHeight").max(1.0),
            number(props, "count") as usize,
        );
        if changed.iter().any(|name| name == "count") {
            self.end_reached_for.set(-1);
        }
        if changed.iter().any(|name| name == "scrollRequest") {
            self.pending
                .set(props.get("scrollRequest").and_then(read_request));
        }
    }

    fn render(
        &mut self,
        props: &Map<String, Value>,
        children: Vec<AnyElement>,
        _window: &mut Window,
        _cx: &mut App,
    ) -> AnyElement {
        let state = self.state.clone();
        let (total, handle) = {
            let state = state.borrow();
            (state.heights.total(), state.scroll.clone())
        };
        let count = number(props, "count") as i64;
        let threshold = props
            .get("endReachedThreshold")
            .and_then(Value::as_f64)
            .unwrap_or(200.0) as f32;
        let wants_end = props.get("onEndReached").is_some();
        let emitter = self.emitter.clone();
        let reported = self.reported.clone();
        let pending = self.pending.clone();
        let end_reached_for = self.end_reached_for.clone();
        div()
            .relative()
            .size_full()
            .child(
                div()
                    .id("native-virtual-list")
                    .size_full()
                    .overflow_y_scroll()
                    .track_scroll(&handle)
                    .child(div().relative().w_full().h(px(total)).children(children)),
            )
            .child(
                canvas(
                    move |bounds, _window, _cx| {
                        if count <= 0 {
                            return;
                        }
                        let view = f32::from(bounds.size.height);
                        let state = state.borrow();
                        let scroll = &state.scroll;
                        let max_top = (state.heights.total() - view).max(0.0);
                        if let Some(mut request) = pending.get() {
                            let target = match request.index {
                                Some(index) => {
                                    let index = index.min(count as usize - 1);
                                    let top = state.heights.offset_of(index);
                                    let height = state.heights.height(index);
                                    top - (view - height) * request.align
                                }
                                None => request.offset,
                            }
                            .clamp(0.0, max_top);
                            let current = -f32::from(scroll.offset().y);
                            if (current - target).abs() > 0.5 {
                                scroll.set_offset(point(px(0.0), px(-target)));
                            }
                            request.attempts += 1;
                            let settled = (current - target).abs() <= 0.5
                                && request.index.is_none_or(|index| {
                                    state.heights.measured.contains_key(&index)
                                });
                            pending.set((!settled && request.attempts < 12).then_some(request));
                        }
                        let top = -f32::from(scroll.offset().y);
                        let first = state.heights.index_at(top) as i64;
                        let last = (state.heights.index_at(top + view) as i64).max(first);
                        if reported.get() != (first, last) {
                            reported.set((first, last));
                            emitter.emit("onRangeChange", json!({ "first": first, "last": last }));
                        }
                        if wants_end
                            && end_reached_for.get() != count
                            && top + view >= state.heights.total() - threshold
                        {
                            end_reached_for.set(count);
                            emitter.emit("onEndReached", json!({}));
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

impl Drop for VirtualList {
    fn drop(&mut self) {
        let id = self.id;
        let _ = LISTS.try_with(|lists| lists.borrow_mut().remove(&id));
    }
}

struct VirtualItem;

impl NativeComponent for VirtualItem {
    fn create(_props: &Map<String, Value>, _cx: &mut NativeContext) -> Self {
        VirtualItem
    }

    fn update(
        &mut self,
        _props: &Map<String, Value>,
        _changed: &[String],
        _cx: &mut NativeContext,
    ) {
    }

    fn recyclable(&self) -> bool {
        true
    }

    fn recycle(&mut self, _props: &Map<String, Value>, _cx: &mut NativeContext) -> bool {
        true
    }

    fn render(
        &mut self,
        props: &Map<String, Value>,
        children: Vec<AnyElement>,
        _window: &mut Window,
        _cx: &mut App,
    ) -> AnyElement {
        let index = number(props, "index") as usize;
        let state = list_state(list_id(props));
        let top = state
            .as_ref()
            .map_or(0.0, |state| state.borrow().heights.offset_of(index));
        let root = crate::builtins::native_root::current_root();
        div()
            .absolute()
            .left_0()
            .top(px(top))
            .w_full()
            .flex()
            .flex_col()
            .children(children)
            .child(
                canvas(
                    move |bounds, window, cx| {
                        let Some(state) = state else {
                            return;
                        };
                        let height = f32::from(bounds.size.height);
                        let mut state = state.borrow_mut();
                        let above =
                            state.heights.offset_of(index) < -f32::from(state.scroll.offset().y);
                        if let Some(delta) = state.heights.set(index, height) {
                            if above {
                                let offset = state.scroll.offset();
                                state
                                    .scroll
                                    .set_offset(point(offset.x, offset.y - px(delta)));
                            }
                            drop(state);
                            crate::builtins::native_root::notify_root_later(root, window, cx);
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
    register_native_component::<VirtualList>(LIST);
    register_native_component::<VirtualItem>(ITEM);
}

#[cfg(test)]
mod tests {
    use super::Heights;

    #[test]
    fn unmeasured_items_count_as_the_estimate() {
        let heights = Heights::new(10.0, 100);
        assert_eq!(heights.offset_of(5), 50.0);
        assert_eq!(heights.total(), 1000.0);
        assert_eq!(heights.index_at(55.0), 5);
        assert_eq!(heights.index_at(5000.0), 99);
    }

    #[test]
    fn a_measurement_moves_what_follows_it() {
        let mut heights = Heights::new(10.0, 100);
        assert_eq!(heights.set(3, 25.0), Some(15.0));
        assert_eq!(heights.offset_of(3), 30.0);
        assert_eq!(heights.offset_of(4), 55.0);
        assert_eq!(heights.total(), 1015.0);
        assert_eq!(heights.index_at(54.0), 3);
        assert_eq!(heights.index_at(55.0), 4);
        assert_eq!(heights.set(3, 25.2), None);
    }

    #[test]
    fn a_new_count_or_estimate_keeps_the_measurements_that_still_apply() {
        let mut heights = Heights::new(10.0, 100);
        heights.set(3, 20.0);
        heights.set(90, 40.0);
        heights.rebuild(10.0, 50);
        assert_eq!(heights.total(), 510.0);
        heights.rebuild(20.0, 50);
        assert_eq!(heights.offset_of(4), 3.0 * 20.0 + 20.0);
    }
}
