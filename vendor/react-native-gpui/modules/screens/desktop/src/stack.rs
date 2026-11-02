//! The stack observer: everything react-native-screens does between a mount
//! batch and a paint.
//!
//! Core tells an observer about a batch before it applies it, about each insert
//! and removal as it applies them, and about the batch once it is done. All the
//! navigation decisions — which stack is nested, which card is leaving, when a
//! lifecycle event fires, when a card is kept alive for its exit — are made here
//! and remembered in `state`.
use crate::props;
use crate::state::{self, PopPlan, Role};
use crate::transition::{self, Role as TransitionRole};
use react_native_gpui::extensions::{
    BatchOpKind, BatchView, ComponentNode, StoreHandle, StoreObserver, TreeView,
};
use std::collections::HashSet;

/// The component names this module owns.
pub const STACK: &str = "RNSScreenStack";
pub const SCREEN: &str = "RNSScreen";
pub const HEADER_CONFIG: &str = "RNSScreenStackHeaderConfig";
pub const HEADER_SUBVIEW: &str = "RNSScreenStackHeaderSubview";
pub const CONTENT_WRAPPER: &str = "RNSScreenContentWrapper";
pub const MODAL_SCREEN: &str = "RNSModalScreen";
pub const FULL_WINDOW_OVERLAY: &str = "RNSFullWindowOverlay";

/// Watches the batch and drives the stack.
pub struct StackObserver;

impl StoreObserver for StackObserver {
    fn before_batch(
        &self,
        batch: &BatchView,
        tree: &TreeView,
        handle: &StoreHandle,
        cx: &mut gpui::App,
    ) {
        let nested = nested_stacks(batch, tree);
        if std::env::var_os("RN_GPUI_DEBUG_SCREENS").is_some() && !nested.is_empty() {
            log::info!("[screens] nested stack tags={nested:?}");
        }
        let plans = pop_plans(batch, tree, &nested, handle, cx);
        for (tag, plan) in &plans {
            if plan.retain {
                handle.retain_subtree(*tag);
            }
        }
        state::with(|state| {
            state.nested_stacks = nested;
            state.pop_plans = plans;
        });
    }

    fn on_mount(&self, node: &ComponentNode, _handle: &StoreHandle, _cx: &mut gpui::App) {
        if node.component == FULL_WINDOW_OVERLAY {
            log::info!(
                "[screens] full window overlay created tag={} frame={}x{}",
                node.tag,
                node.frame.w,
                node.frame.h
            );
        } else if crate::unsupported::unsupported_component(&node.component) {
            log::error!(
                "[screens] component {} is not implemented on gpui",
                node.component
            );
        }
    }

    fn on_insert(
        &self,
        child: &ComponentNode,
        parent: i32,
        previous_children: &[i32],
        tree: &TreeView,
        handle: &StoreHandle,
        cx: &mut gpui::App,
    ) {
        if child.component != SCREEN || !is_outer_stack(parent) {
            return;
        }
        let animation = props::stack_animation(child).to_string();
        let presentation = props::stack_presentation(child).to_string();
        log::info!(
            "[screens] screen inserted tag={} animation={} presentation={} reduce_motion={}",
            child.tag,
            animation,
            presentation,
            !tree.animations_enabled()
        );
        let previous_top = previous_children
            .iter()
            .rev()
            .copied()
            .find(|tag| tree.node(*tag).is_some_and(|node| node.component == SCREEN));
        let mode = transition::transition_mode(&animation).filter(|_| tree.animations_enabled());
        if let Some(mode) = mode {
            log::info!(
                "[screens] push transition incoming={} outgoing={:?} animation={} mode={mode:?}",
                child.tag,
                previous_top,
                animation
            );
            if presentation == "push" {
                if let Some(previous) = previous_top {
                    let distance = transition::PARALLAX_DISTANCE;
                    handle.start_transition(
                        previous,
                        transition::transition(mode, TransitionRole::Exit, distance),
                        cx,
                    );
                    state::with(|state| {
                        state.roles.insert(previous, (Role::Exit, distance));
                    });
                }
            }
            handle.start_transition(
                child.tag,
                transition::transition(mode, TransitionRole::Enter, 1.0),
                cx,
            );
            state::with(|state| {
                state.roles.insert(child.tag, (Role::Enter, 1.0));
            });
        }
        crate::lifecycle::dispatch_will(handle, previous_top, Some(child.tag), cx);
        match mode {
            Some(mode) => {
                let outgoing = previous_top;
                let incoming = Some(child.tag);
                let handle = handle.clone();
                handle.after(mode.duration(), cx, move |handle, cx| {
                    if let Some(outgoing) = outgoing {
                        handle.clear_transition(outgoing, cx);
                    }
                    crate::lifecycle::dispatch_did(handle, outgoing, incoming, cx);
                });
            }
            None => crate::lifecycle::dispatch_did(handle, previous_top, Some(child.tag), cx),
        }
    }

    fn on_remove_child(
        &self,
        child: i32,
        parent: i32,
        retained: bool,
        tree: &TreeView,
        handle: &StoreHandle,
        cx: &mut gpui::App,
    ) {
        let Some(node) = tree.node(child) else {
            return;
        };
        if node.component != SCREEN {
            return;
        }
        let plan = state::with(|state| state.pop_plans.remove(&child));
        let Some(plan) = plan else {
            return;
        };
        let _ = parent;
        if let Some(revealed) = plan.revealed {
            handle.clear_transition(revealed, cx);
        }
        let native_dismiss = state::with(|state| state.native_dismiss_pending == Some(child));
        let mode = transition::transition_mode(&plan.animation)
            .filter(|_| tree.animations_enabled())
            .map(transition::TransitionMode::reverse);
        let retain = plan.retain && mode.is_some();
        log::info!(
            "[screens] pop transition outgoing={} incoming={:?} animation={} retained={retain}",
            child,
            plan.revealed,
            plan.animation
        );
        if retain {
            if let Some(mode) = mode {
                handle.start_transition(
                    child,
                    transition::transition(mode, TransitionRole::Exit, 1.0),
                    cx,
                );
                state::with(|state| {
                    state.roles.insert(child, (Role::Exit, 1.0));
                });
            }
        }
        if !native_dismiss {
            crate::lifecycle::dispatch_will(handle, Some(child), plan.revealed, cx);
        }
        if retained {
            let duration = mode.map(|mode| mode.duration()).unwrap_or_default();
            let revealed = plan.revealed;
            let handle = handle.clone();
            handle.after(duration, cx, move |handle, cx| {
                handle.release_retained(child, cx);
                log::info!("[screens] pop finished outgoing={child}");
                crate::lifecycle::dispatch_did(handle, Some(child), revealed, cx);
            });
        } else if !native_dismiss {
            crate::lifecycle::dispatch_did(handle, Some(child), plan.revealed, cx);
        }
        state::with(|state| {
            if state.native_dismiss_pending == Some(child) {
                state.native_dismiss_pending = None;
            }
        });
    }

    fn on_remove(&self, tag: i32, _handle: &StoreHandle, _cx: &mut gpui::App) {
        state::with(|state| {
            state.pop_plans.remove(&tag);
            state.roles.remove(&tag);
            state.headers.remove(&tag);
        });
    }

    fn on_update(
        &self,
        node: &ComponentNode,
        previous: &ComponentNode,
        handle: &StoreHandle,
        cx: &mut gpui::App,
    ) {
        if node.component != SCREEN {
            return;
        }
        let before = props::activity_state(previous);
        let after = props::activity_state(node);
        if before == after {
            return;
        }
        for event in crate::lifecycle::lifecycle_events(before, after) {
            log::info!(
                "[screens] tag={} activity={}->{} event={event}",
                node.tag,
                before,
                after
            );
            handle.dispatch_event(node.tag, event, &serde_json::json!({}), cx);
        }
    }

    fn after_batch(&self, _tree: &TreeView, _handle: &StoreHandle, _cx: &mut gpui::App) {
        state::clear_batch_state();
    }

    fn on_transition_frame(
        &self,
        tag: i32,
        progress: f32,
        handle: &StoreHandle,
        cx: &mut gpui::App,
    ) {
        let forward = state::with(|state| {
            state
                .roles
                .get(&tag)
                .is_none_or(|(role, distance)| *role == Role::Enter || *distance < 1.0)
        });
        handle.dispatch_event(
            tag,
            "topTransitionProgress",
            &serde_json::json!({
                "progress": progress,
                "closing": if forward { 0 } else { 1 },
                "goingForward": if forward { 1 } else { 0 }
            }),
            cx,
        );
    }
}

/// Whether `stack` is the outer stack, the only one that animates.
fn is_outer_stack(stack: i32) -> bool {
    !state::with(|state| state.nested_stacks.contains(&stack))
}

/// Every stack that sits inside a screen, found from the batch topology before
/// any of it is applied.
fn nested_stacks(batch: &BatchView, tree: &TreeView) -> HashSet<i32> {
    let stacks: Vec<i32> = batch
        .ops
        .iter()
        .filter(|op| op.kind == BatchOpKind::Create && op.component == STACK)
        .map(|op| op.tag)
        .chain(
            batch
                .ops
                .iter()
                .filter(|op| op.kind != BatchOpKind::Create && op.component == STACK)
                .map(|op| op.tag),
        )
        .collect();
    let mut nested = HashSet::new();
    for stack in stacks {
        let mut cursor = Some(stack);
        let mut visited = HashSet::new();
        while let Some(tag) = cursor {
            if !visited.insert(tag) {
                break;
            }
            let Some(parent) = batch.parent_of(tag).or_else(|| tree.parent(tag)) else {
                break;
            };
            if batch.component_of(parent, tree).as_deref() == Some(SCREEN) {
                nested.insert(stack);
                break;
            }
            cursor = Some(parent);
        }
    }
    nested
}

/// The cards leaving in this batch that should animate their exit.
fn pop_plans(
    batch: &BatchView,
    tree: &TreeView,
    nested: &HashSet<i32>,
    handle: &StoreHandle,
    cx: &mut gpui::App,
) -> std::collections::HashMap<i32, PopPlan> {
    let removed: HashSet<i32> = batch
        .ops
        .iter()
        .filter(|op| op.kind == BatchOpKind::Remove && op.component == SCREEN)
        .map(|op| op.tag)
        .collect();
    let mut plans = std::collections::HashMap::new();
    for op in batch
        .ops
        .iter()
        .filter(|op| op.kind == BatchOpKind::Remove && op.component == SCREEN)
    {
        if nested.contains(&op.parent_tag) {
            continue;
        }
        let Some(stack) = tree.node(op.parent_tag) else {
            continue;
        };
        if stack.component != STACK {
            continue;
        }
        let live: Vec<i32> = tree
            .children(op.parent_tag)
            .into_iter()
            .filter(|tag| {
                tree.is_live(*tag) && tree.node(*tag).is_some_and(|node| node.component == SCREEN)
            })
            .collect();
        if live.last().copied() != Some(op.tag) {
            continue;
        }
        let revealed = live
            .iter()
            .rev()
            .find(|tag| !removed.contains(tag))
            .copied();
        let Some(screen) = tree.node(op.tag) else {
            continue;
        };
        let animation = props::stack_animation(&screen).to_string();
        let native_dismiss = state::with(|state| state.native_dismiss_pending == Some(op.tag));
        let mode = transition::transition_mode(&animation).filter(|_| tree.animations_enabled());
        let retain = !native_dismiss && revealed.is_some() && mode.is_some();
        if retain {
            log::info!(
                "[screens] preserve outgoing={} descendants={}",
                op.tag,
                descendant_count(op.tag, tree)
            );
        }
        plans.insert(
            op.tag,
            PopPlan {
                revealed,
                animation,
                duration: mode.map(|mode| mode.duration()).unwrap_or_default(),
                retain,
            },
        );
    }
    plans
}

/// How many nodes sit below `tag`, at any depth.
fn descendant_count(tag: i32, tree: &TreeView) -> usize {
    let mut total = 0;
    let mut stack = tree.children(tag);
    while let Some(next) = stack.pop() {
        total += 1;
        stack.extend(tree.children(next));
    }
    total
}
