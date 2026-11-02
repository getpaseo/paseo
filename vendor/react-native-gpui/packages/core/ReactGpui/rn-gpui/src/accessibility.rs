use crate::{node_view::RNNodeView, store::StoreGlobal};
use gpui::{App, Entity, FocusHandle, Global, Window};
use std::collections::HashSet;

#[derive(Default)]
struct ModalFocusState {
    active: Option<i32>,
    visible: HashSet<i32>,
    restore: Option<(i32, FocusHandle)>,
    pending_focus: bool,
}
impl Global for ModalFocusState {}

pub(crate) fn hidden_by_active_modal(tag: i32, cx: &App) -> bool {
    cx.try_global::<ModalFocusState>()
        .is_some_and(|state| state.active.is_some() && !state.visible.contains(&tag))
}

fn collect_modal(
    node: &Entity<RNNodeView>,
    cx: &App,
    tags: &mut HashSet<i32>,
    focus: &mut Vec<FocusHandle>,
) {
    let node = node.read(cx);
    if node.view.display_none
        || node.view.accessibility_hidden
        || node.view.accessibility_important == 3
    {
        return;
    }
    tags.insert(node.tag);
    if node.focusable
        && !node.view.accessibility_disabled
        && node.view.accessibility_responds_to_interaction
    {
        if let Some(handle) = node.accessibility_focus_handle() {
            focus.push(handle);
        }
    }
    for (_, child) in &node.children {
        collect_modal(child, cx, tags, focus);
    }
}

/// Called after the mount/render transaction, while no RN entity is leased.
pub(crate) fn sync_modal_focus(window: &mut Window, cx: &mut App) {
    let Some(store) = cx.try_global::<StoreGlobal>().map(|store| store.0.clone()) else {
        return;
    };
    let (active, descendants, visible, targets, fallback, nodes, focused) = {
        let store = store.read(cx);
        #[cfg(feature = "visual-capture")]
        if std::env::var_os("RN_GPUI_DEBUG_A11Y_TREE").is_some() {
            log::info!(
                "[accessibility] sync modal tags={:?}",
                store.accessibility_modal_tags
            );
        }
        if store.accessibility_modal_tags.is_empty()
            && cx
                .try_global::<ModalFocusState>()
                .is_none_or(|state| state.active.is_none())
        {
            return;
        }
        let active = store.accessibility_modal_tags.iter().rev().find_map(|tag| {
            store
                .nodes
                .get(tag)
                .filter(|node| {
                    let node = node.read(cx);
                    !node.view.display_none && !node.view.accessibility_hidden
                })
                .map(|node| (*tag, node.clone()))
        });
        let mut descendants = HashSet::new();
        let mut targets = Vec::new();
        let mut visible = HashSet::new();
        let mut fallback = None;
        if let Some((_, modal)) = &active {
            collect_modal(modal, cx, &mut descendants, &mut targets);
            visible.clone_from(&descendants);
            let modal = modal.read(cx);
            fallback = modal.accessibility_focus_handle();
            let mut parent = modal.parent.clone();
            while let Some(entity) = parent.and_then(|node| node.upgrade()) {
                let node = entity.read(cx);
                visible.insert(node.tag);
                parent = node.parent.clone();
            }
        }
        let focused = store.nodes.iter().find_map(|(tag, node)| {
            node.read(cx)
                .accessibility_focus_handle()
                .filter(|handle| handle.is_focused(window))
                .map(|handle| (*tag, handle))
        });
        (
            active.map(|(tag, _)| tag),
            descendants,
            visible,
            targets,
            fallback,
            store.nodes.values().cloned().collect::<Vec<_>>(),
            focused,
        )
    };
    if cx.try_global::<ModalFocusState>().is_none() {
        cx.set_global(ModalFocusState::default());
    }
    let state = cx.global_mut::<ModalFocusState>();
    let changed = state.active != active;
    let tree_changed = state.visible != visible;
    if changed && state.active.is_none() && active.is_some() {
        state.restore = focused;
    }
    if changed {
        state.pending_focus = active.is_some();
    }
    let pending_focus = state.pending_focus;
    state.active = active;
    state.visible = visible;
    let restore = if changed && active.is_none() {
        state.restore.take()
    } else {
        None
    };
    if changed || tree_changed {
        for node in nodes {
            node.update(cx, |node, cx| {
                node.set_accessibility_tab_stop_allowed(
                    active.is_none() || descendants.contains(&node.tag),
                );
                cx.notify();
            });
        }
        window.refresh();
    }
    if changed || pending_focus {
        if active.is_some() {
            if let Some(target) = targets.first().cloned().or(fallback) {
                target.focus(window, cx);
                cx.global_mut::<ModalFocusState>().pending_focus = false;
            } else {
                window.on_next_frame(sync_modal_focus);
                window.refresh();
            }
        } else if let Some((tag, handle)) = restore {
            if store.read(cx).nodes.contains_key(&tag) {
                handle.focus(window, cx);
            }
        }
        log::info!(
            "[accessibility] modal focus active={active:?} restored={}",
            active.is_none()
        );
    }
}
