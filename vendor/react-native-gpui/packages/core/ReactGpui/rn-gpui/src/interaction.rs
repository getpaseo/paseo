//! Which nodes the pointer is over and which a held press is on, for the
//! pointer state styles (`hoverStyle`, `activeStyle`, `groupHoverStyle`,
//! `groupActiveStyle`).
//!
//! Both come from the hit path React Native already tracks, the target and its
//! ancestors, not from gpui's hitboxes. gpui resolves a hover or press from
//! listeners that sit on the styled element, and those never run for a press the
//! topmost node stopped, and read a group that is not there when a view is drawn
//! apart from its parent.
//!
//! A group style follows the nearest ancestor that names its group, so the
//! nodes whose group is hovered or pressed are worked out here when the path
//! changes, not looked up by name.

use crate::node_view::RNNodeView;
use crate::store::StoreGlobal;
use gpui::App;
use std::cell::RefCell;

#[derive(Clone, Copy)]
pub(crate) enum Kind {
    Hover,
    Press,
    Drag,
}

#[derive(Default)]
struct Track {
    /// The path: the target and its ancestors.
    tags: Vec<i32>,
    /// The nodes with a group style whose group is on the path.
    grouped: Vec<i32>,
}

#[derive(Default)]
struct State {
    hover: Track,
    press: Track,
    drag: Track,
}

impl State {
    fn track(&self, kind: Kind) -> &Track {
        match kind {
            Kind::Hover => &self.hover,
            Kind::Press => &self.press,
            Kind::Drag => &self.drag,
        }
    }

    fn track_mut(&mut self, kind: Kind) -> &mut Track {
        match kind {
            Kind::Hover => &mut self.hover,
            Kind::Press => &mut self.press,
            Kind::Drag => &mut self.drag,
        }
    }
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

/// Whether the pointer is over this node or one of its descendants.
pub(crate) fn node_hovered(tag: i32) -> bool {
    STATE.with_borrow(|state| state.hover.tags.contains(&tag))
}

/// Whether the pointer is over the group this node's hover style follows.
pub(crate) fn group_hovered(tag: i32) -> bool {
    STATE.with_borrow(|state| state.hover.grouped.contains(&tag))
}

/// Whether files are being dragged over this node, the one that takes them.
pub(crate) fn node_dragged_over(tag: i32) -> bool {
    STATE.with_borrow(|state| state.drag.tags.contains(&tag))
}

/// Whether a press is held on this node or one of its descendants.
pub(crate) fn node_pressed(tag: i32) -> bool {
    STATE.with_borrow(|state| state.press.tags.contains(&tag))
}

/// Whether a press is held on the group this node's press style follows.
pub(crate) fn group_pressed(tag: i32) -> bool {
    STATE.with_borrow(|state| state.press.grouped.contains(&tag))
}

/// The pointer is now over `chain`, the target and its ancestors.
pub(crate) fn set_hover(chain: &[i32], cx: &mut App) {
    set(Kind::Hover, chain, cx);
}

/// Files are now being dragged over `target`, or over nothing.
pub(crate) fn set_drag(target: Option<i32>, cx: &mut App) {
    let chain: Vec<i32> = target.into_iter().collect();
    set(Kind::Drag, &chain, cx);
}

/// A press is now held on `chain`, the target and its ancestors.
pub(crate) fn begin_press(chain: &[i32], cx: &mut App) {
    set(Kind::Press, chain, cx);
}

/// The press ended.
pub(crate) fn end_press(cx: &mut App) {
    set(Kind::Press, &[], cx);
}

/// Forgets everything without repainting, for when the nodes are gone.
pub(crate) fn clear() {
    STATE.take();
}

/// Works the groups out again for the tree as it is now, for a view that
/// mounted or moved under a pointer that did not.
pub(crate) fn refresh(cx: &mut App) {
    for kind in [Kind::Hover, Kind::Press] {
        let chain = STATE.with_borrow(|state| state.track(kind).tags.clone());
        update(kind, &chain, true, cx);
    }
}

fn set(kind: Kind, chain: &[i32], cx: &mut App) {
    update(kind, chain, false, cx);
}

fn update(kind: Kind, chain: &[i32], force: bool, cx: &mut App) {
    let Some(store) = cx.try_global::<StoreGlobal>().map(|store| store.0.clone()) else {
        return;
    };
    let unchanged = STATE.with_borrow(|state| state.track(kind).tags == chain);
    if unchanged && !force {
        return;
    }
    let grouped = {
        let store = store.read(cx);
        store
            .nodes
            .values()
            .filter(|node| node.read(cx).pointer_style_group(kind).is_some())
            .filter(|node| group_on_path(node, kind, chain, cx))
            .map(|node| node.read(cx).tag)
            .collect()
    };
    let previous = STATE.with_borrow_mut(|state| {
        std::mem::replace(
            state.track_mut(kind),
            Track {
                tags: chain.to_vec(),
                grouped,
            },
        )
    });
    let nodes: Vec<_> = store
        .read(cx)
        .nodes
        .values()
        .filter(|node| node.read(cx).has_pointer_style(kind))
        .cloned()
        .collect();
    for node in nodes {
        let tag = node.read(cx).tag;
        let in_track = |track: &Track| track.tags.contains(&tag) || track.grouped.contains(&tag);
        let was = in_track(&previous);
        let is = STATE.with_borrow(|state| in_track(state.track(kind)));
        if was != is {
            node.update(cx, |_: &mut RNNodeView, cx| cx.notify());
        }
    }
    refresh_text_colors(cx);
}

/// Hands the text color a state style gives a node down to the text inside it,
/// for the nodes whose color changed. A node's own color wins over an
/// ancestor's.
pub(crate) fn refresh_text_colors(cx: &mut App) {
    let Some(store) = cx.try_global::<StoreGlobal>().map(|store| store.0.clone()) else {
        return;
    };
    let changed: Vec<_> = store
        .read(cx)
        .nodes
        .values()
        .filter(|node| {
            let node = node.read(cx);
            node.has_text_color_style() && node.own_text_color() != node.own_state_color()
        })
        .cloned()
        .collect();
    for node in changed {
        let parent = node
            .read(cx)
            .parent
            .as_ref()
            .and_then(|parent| parent.upgrade())
            .and_then(|parent| parent.read(cx).state_text_color());
        propagate_text_color(&node, parent, cx);
    }
}

fn propagate_text_color(node: &gpui::Entity<RNNodeView>, inherited: Option<u32>, cx: &mut App) {
    let own = node.read(cx).own_text_color();
    let mut changed = false;
    let mut children = Vec::new();
    node.update(cx, |node: &mut RNNodeView, cx| {
        changed = node.set_state_text_color(own, inherited);
        if changed {
            cx.notify();
        }
        children = node
            .children
            .iter()
            .map(|(_, child)| child.clone())
            .collect();
    });
    let effective = node.read(cx).state_text_color();
    for child in children {
        propagate_text_color(&child, effective, cx);
    }
}

/// Whether the nearest ancestor of `node` that names its group is on `chain`.
fn group_on_path(node: &gpui::Entity<RNNodeView>, kind: Kind, chain: &[i32], cx: &App) -> bool {
    let Some(group) = node.read(cx).pointer_style_group(kind) else {
        return false;
    };
    let mut ancestor = node
        .read(cx)
        .parent
        .as_ref()
        .and_then(|parent| parent.upgrade());
    while let Some(entity) = ancestor {
        let entity = entity.read(cx);
        if entity.group_name().as_ref() == Some(&group) {
            return chain.contains(&entity.tag);
        }
        ancestor = entity.parent.as_ref().and_then(|parent| parent.upgrade());
    }
    false
}
