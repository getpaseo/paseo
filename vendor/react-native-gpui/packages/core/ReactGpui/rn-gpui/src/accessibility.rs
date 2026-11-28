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

/// What `AccessibilityInfo.announceForAccessibility` asked the screen reader to
/// say, shown as a live region of the window: a change of its label is what
/// Narrator and Orca read out.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Announcement {
    pub label: String,
    pub assertive: bool,
}

static ANNOUNCEMENT: std::sync::Mutex<Option<(u64, String, i32)>> = std::sync::Mutex::new(None);

/// The label a live region carries for announcement number `sequence`. A
/// zero-width space on every other announcement makes a repeated message a
/// change.
fn announcement_label(text: &str, sequence: u64) -> String {
    if sequence % 2 == 1 {
        format!("{text}\u{200b}")
    } else {
        text.to_string()
    }
}

/// Priority 0 is `low`; the rest interrupt.
fn is_assertive(priority: i32) -> bool {
    priority > 0
}

pub(crate) fn current_announcement() -> Option<Announcement> {
    let state = ANNOUNCEMENT.lock().expect("announcement poisoned");
    state
        .as_ref()
        .map(|(sequence, text, priority)| Announcement {
            label: announcement_label(text, *sequence),
            assertive: is_assertive(*priority),
        })
}

fn record_announcement(text: &str, priority: i32) {
    let mut state = ANNOUNCEMENT.lock().expect("announcement poisoned");
    let sequence = state.as_ref().map_or(0, |(sequence, _, _)| sequence + 1);
    *state = Some((sequence, text.to_string(), priority));
}

/// The live region element for the current announcement.
pub(crate) fn announcement_element(announcement: Announcement) -> impl gpui::IntoElement {
    use gpui::{div, prelude::*, px, Role};
    let live = if announcement.assertive {
        gpui::accesskit::Live::Assertive
    } else {
        gpui::accesskit::Live::Polite
    };
    div()
        .id("accessibility-announcement")
        .absolute()
        .top_0()
        .left_0()
        .size(px(1.0))
        .role(Role::Status)
        .aria_label(announcement.label)
        .a11y_synthetic_children(move |builder| {
            let node = builder.parent_node();
            node.set_live(live);
            node.set_live_atomic();
        })
}

#[cfg(not(target_os = "macos"))]
extern "C" {
    fn rn_gpui_set_announce_handler(handler: extern "C" fn(*const std::ffi::c_char, i32));
}

#[cfg(not(target_os = "macos"))]
extern "C" fn on_announce(text: *const std::ffi::c_char, priority: i32) {
    if text.is_null() {
        return;
    }
    // SAFETY: the caller passes a NUL-terminated string that outlives the call.
    let text = unsafe { std::ffi::CStr::from_ptr(text) }.to_string_lossy();
    record_announcement(&text, priority);
    crate::desktop::post_to_main(Box::new(|cx: &mut App| {
        let Some(store) = crate::store::store_from(cx) else {
            return;
        };
        let window = store.read(cx).window;
        if let Some(window) = window.downcast::<crate::store::SurfaceRootView>() {
            let _ = window.update(cx, |_root, _window, cx| cx.notify());
        }
    }));
}

/// Routes the host's announcements to the window. macOS has the system's own.
#[cfg(not(target_os = "macos"))]
pub(crate) fn install_announcer() {
    // SAFETY: the handler is a plain function that lives for the whole process.
    unsafe { rn_gpui_set_announce_handler(on_announce) };
}

#[cfg(test)]
mod announcement_tests {
    use super::*;

    #[test]
    fn a_repeated_message_changes_the_label() {
        assert_eq!(announcement_label("Saved", 0), "Saved");
        assert_eq!(announcement_label("Saved", 1), "Saved\u{200b}");
        assert_eq!(announcement_label("Saved", 2), "Saved");
    }

    #[test]
    fn low_priority_waits_and_the_rest_interrupt() {
        assert!(!is_assertive(0));
        assert!(is_assertive(1));
        assert!(is_assertive(2));
    }

    #[test]
    fn each_announcement_replaces_the_last() {
        record_announcement("one", 1);
        let first = current_announcement().unwrap();
        record_announcement("one", 1);
        let second = current_announcement().unwrap();
        assert_ne!(first.label, second.label);
        record_announcement("two", 0);
        let third = current_announcement().unwrap();
        assert!(third.label.starts_with("two"));
        assert!(!third.assertive);
    }
}
