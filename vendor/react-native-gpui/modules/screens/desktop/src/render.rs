//! Painting react-native-screens through the generic renderer hooks.
//!
//! Core builds a box, a background and an accessibility node for every
//! component. What is screens-specific — which screen is on top, where a header
//! subview sits, whether a card is showing — is decided here, from the props this
//! module's C++ half produced and a read-only view of the tree.
use crate::props;
use crate::stack::{
    CONTENT_WRAPPER, FULL_WINDOW_OVERLAY, HEADER_CONFIG, HEADER_SUBVIEW, MODAL_SCREEN, SCREEN,
    STACK,
};
use gpui::{div, prelude::*, AnyElement, App, MouseButton, SharedString, Window};
use react_native_gpui::extensions::{
    store_handle, ComponentNode, ComponentRenderer, Decoration, Portal, StoreHandle, TreeView,
};
use rn_gpui_sys::ffi::RectF;

/// The header bar's height, which the content wrapper is inset by.
pub const HEADER_HEIGHT: f32 = 56.0;

/// A screen inside a stack.
pub struct ScreenRenderer;

impl ComponentRenderer for ScreenRenderer {
    fn render(
        &self,
        _node: &ComponentNode,
        _window: &mut Window,
        _cx: &mut App,
    ) -> Option<AnyElement> {
        None
    }

    fn children(
        &self,
        node: &ComponentNode,
        children: Vec<AnyElement>,
        _window: &mut Window,
        _cx: &mut App,
    ) -> Vec<AnyElement> {
        if !props::is_modal_presentation(node) {
            return children;
        }
        let material = props::is_transparent_presentation(node);
        // The frame is in unscaled coordinates and the element this returns is
        // painted scaled, so the sheet has to be scaled to land where the card
        // it covers does. The old code did the same with `scale_x`/`scale_y`.
        let (scale_x, scale_y) = node.scale;
        let width = (node.frame.w - SHEET_MARGIN).clamp(0.0, SHEET_MAX_WIDTH) * scale_x;
        let height = (node.frame.h - SHEET_MARGIN).clamp(0.0, SHEET_MAX_HEIGHT) * scale_y;
        let left = ((node.frame.w * scale_x - width) * 0.5).max(0.0);
        let top = ((node.frame.h * scale_y - height) * 0.5).max(0.0);
        let mut layers = Vec::with_capacity(2);
        if !material {
            layers.push(
                div()
                    .absolute()
                    .inset_0()
                    .size_full()
                    .bg(argb(0x80000000))
                    .into_any_element(),
            );
        }
        layers.push(
            div()
                .absolute()
                .left(gpui::px(left))
                .top(gpui::px(top))
                .w(gpui::px(width))
                .h(gpui::px(height))
                .overflow_hidden()
                .bg(argb(if material { 0x00000000 } else { 0xff171923 }))
                .children(children)
                .into_any_element(),
        );
        layers
    }

    fn hides_subtree(&self, node: &ComponentNode, tree: &TreeView) -> bool {
        if props::activity_state(node) > 0.0 {
            return false;
        }
        if tree
            .transition(node.tag)
            .is_some_and(|state| state.progress < 1.0)
        {
            return false;
        }
        !covered_by_modal_sibling(node, tree)
    }

    fn decorate(&self, node: &ComponentNode, tree: &TreeView) -> Decoration {
        if props::activity_state(node) > 0.0 {
            return Decoration::default();
        }
        let transitioning = tree
            .transition(node.tag)
            .is_some_and(|state| state.progress < 1.0);
        let visible_under_modal = covered_by_modal_sibling(node, tree);
        if !transitioning && !visible_under_modal {
            return Decoration {
                display: Some(false),
                ..Decoration::default()
            };
        }
        Decoration::default()
    }
}

/// Whether a later sibling in the same stack is an active modal presentation.
fn covered_by_modal_sibling(node: &ComponentNode, tree: &TreeView) -> bool {
    let Some(parent) = node.parent else {
        return false;
    };
    let siblings = tree.children(parent);
    let Some(position) = siblings.iter().position(|tag| *tag == node.tag) else {
        return false;
    };
    siblings
        .into_iter()
        .skip(position + 1)
        .filter_map(|tag| tree.node(tag))
        .any(|sibling| {
            sibling.component == SCREEN
                && props::activity_state(&sibling) > 0.0
                && props::is_modal_presentation(&sibling)
        })
}

/// The stack itself: it clips, and it owns the Escape gesture.
pub struct StackRenderer;

impl ComponentRenderer for StackRenderer {
    fn render(
        &self,
        _node: &ComponentNode,
        _window: &mut Window,
        _cx: &mut App,
    ) -> Option<AnyElement> {
        None
    }

    fn decorate(&self, _node: &ComponentNode, _tree: &TreeView) -> Decoration {
        Decoration {
            clip: true,
            ..Decoration::default()
        }
    }

    fn handles_keys(&self, _node: &ComponentNode) -> bool {
        true
    }

    fn on_key_down(
        &self,
        node: &ComponentNode,
        key: &str,
        tree: &TreeView,
        handle: &react_native_gpui::extensions::StoreHandle,
        window: &mut Window,
        cx: &mut App,
    ) -> bool {
        if key != "escape" {
            return false;
        }
        if has_screen_ancestor(node, tree) {
            return false;
        }
        let screens: Vec<i32> = tree
            .children(node.tag)
            .into_iter()
            .filter(|tag| {
                tree.is_live(*tag) && tree.node(*tag).is_some_and(|n| n.component == SCREEN)
            })
            .collect();
        let Some(top) = screens.last().copied() else {
            return false;
        };
        if crate::state::with(|state| state.native_dismiss_pending.is_some()) {
            return true;
        }
        dismiss_top(top, node.tag, tree, handle, window, cx);
        true
    }
}

/// Whether any ancestor of `node` is a screen, i.e. this stack is nested.
fn has_screen_ancestor(node: &ComponentNode, tree: &TreeView) -> bool {
    tree.ancestors(node.tag)
        .into_iter()
        .filter_map(|tag| tree.node(tag))
        .any(|ancestor| ancestor.component == SCREEN)
}

/// The header bar: a background, a title and a back button.
pub struct HeaderConfigRenderer;

impl ComponentRenderer for HeaderConfigRenderer {
    fn render(
        &self,
        _node: &ComponentNode,
        _window: &mut Window,
        _cx: &mut App,
    ) -> Option<AnyElement> {
        None
    }

    fn layout_frame(&self, node: &ComponentNode, tree: &TreeView) -> Option<RectF> {
        let mut frame = node.frame;
        frame.y += tree.window_top_inset();
        frame.h = if props::header_hidden(node) || !is_top_header(node, tree) {
            0.0
        } else {
            HEADER_HEIGHT
        };
        Some(frame)
    }

    fn hides_subtree(&self, node: &ComponentNode, tree: &TreeView) -> bool {
        props::header_hidden(node) || !is_top_header(node, tree)
    }

    fn decorate(&self, node: &ComponentNode, tree: &TreeView) -> Decoration {
        let top = is_top_header(node, tree);
        let shown = should_show_back(node, tree);
        crate::state::set_header_facts(
            node.tag,
            top,
            shown,
            has_title_subview(node, tree),
            node.parent,
        );
        if props::header_hidden(node) || !top {
            return Decoration {
                display: Some(false),
                ..Decoration::default()
            };
        }
        let background = first_nonzero(props::header_background_color(node), 0xff171923);
        Decoration {
            background: Some(background),
            ..Decoration::default()
        }
    }

    fn depends_on_window_insets(&self) -> bool {
        true
    }

    fn content(
        &self,
        node: &ComponentNode,
        _window: &mut Window,
        _cx: &mut App,
    ) -> Option<AnyElement> {
        if props::header_hidden(node) || !crate::state::header_is_top(node.tag) {
            return None;
        }
        // React Native declares `onHeaderBackButtonClicked` on the screen, so
        // the config's parent is the tag that has a listener for it.
        let Some(screen_tag) = crate::state::header_screen(node.tag) else {
            return None;
        };
        let title_color = first_nonzero(props::header_title_color(node), 0xffffffff);
        let mut bar = div()
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .text_color(argb(title_color))
            .text_size(gpui::px(18.0));
        if !crate::state::header_has_title_subview(node.tag) {
            bar = bar.child(SharedString::from(props::header_title(node).to_string()));
        }
        if crate::state::header_shows_back(node.tag) {
            bar = bar.child(
                div()
                    .absolute()
                    .left_0()
                    .top_0()
                    .h(gpui::px(HEADER_HEIGHT))
                    .w(gpui::px(HEADER_HEIGHT))
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_color(argb(first_nonzero(
                        props::header_tint_color(node),
                        0xffffffff,
                    )))
                    .text_size(gpui::px(30.0))
                    .cursor_pointer()
                    .child("‹")
                    .on_mouse_down(MouseButton::Left, move |_event, window, cx| {
                        if let Some(handle) = store_handle(cx) {
                            handle.dispatch_event(
                                screen_tag,
                                "headerBackButtonClicked",
                                &serde_json::json!({}),
                                cx,
                            );
                            handle.request_frame(window);
                        }
                        cx.stop_propagation();
                    }),
            );
        }
        Some(bar.into_any_element())
    }
}

/// Escape dismisses the top screen the way a native gesture would.
///
/// The card runs its exit animation, the screen gets the `will` pair, and only
/// when the animation ends does it get the final progress, the `did` pair and
/// `topDismissed`. `native_dismiss_pending` tells the stack observer that this
/// dismissal already ran its animation, so it must not run a second one.
fn dismiss_top(
    top: i32,
    stack: i32,
    tree: &TreeView,
    handle: &StoreHandle,
    window: &mut Window,
    cx: &mut App,
) {
    crate::state::with(|state| state.native_dismiss_pending = Some(top));
    let incoming = previous_screen(top, stack, tree);
    crate::lifecycle::dispatch_will(handle, Some(top), incoming, cx);
    // The animation belongs to the screen being dismissed, not to the stack: a
    // stack carries no `stackAnimation` prop of its own. A dismissal plays the
    // entry mirrored, which is what `reverse` is for.
    let animation = tree
        .node(top)
        .map(|node| props::stack_animation(&node).to_string())
        .unwrap_or_default();
    let mode = crate::transition::transition_mode(&animation)
        .filter(|_| tree.animations_enabled())
        .map(crate::transition::TransitionMode::reverse);
    let duration = mode.map(|mode| mode.duration());
    if let Some(mode) = mode {
        let exit = crate::transition::transition(mode, crate::transition::Role::Exit, 1.0);
        crate::state::with(|state| {
            state.roles.insert(top, (crate::state::Role::Exit, 1.0));
        });
        handle.start_transition(top, exit, cx);
        // The card underneath comes back to rest from wherever the push left
        // it. Without this it stays offset for the whole dismissal.
        if let Some(incoming) = incoming {
            handle.clear_transition(incoming, cx);
        }
        handle.request_frame(window);
    }
    let finish = move |handle: &StoreHandle, cx: &mut App| {
        handle.dispatch_event(
            top,
            "topTransitionProgress",
            &serde_json::json!({"progress": 1, "closing": 1, "goingForward": 0}),
            cx,
        );
        crate::lifecycle::dispatch_did(handle, Some(top), incoming, cx);
        handle.dispatch_event(
            top,
            "topDismissed",
            &serde_json::json!({ "dismissCount": 1 }),
            cx,
        );
    };
    match duration {
        Some(duration) => {
            let handle = handle.clone();
            handle.after(duration, cx, move |handle, cx| finish(handle, cx));
        }
        None => finish(handle, cx),
    }
}

/// A Fabric colour as GPUI sees it, alpha included.
fn argb(color: u32) -> gpui::Hsla {
    let alpha = color >> 24;
    gpui::rgba((color << 8) | alpha).into()
}

fn first_nonzero(value: u32, fallback: u32) -> u32 {
    if value == 0 {
        fallback
    } else {
        value
    }
}

/// Whether the screen has a previous live screen in its stack to go back to.
fn should_show_back(node: &ComponentNode, tree: &TreeView) -> bool {
    if props::header_hide_back(node) {
        return false;
    }
    let Some(screen) = node.parent else {
        return false;
    };
    let Some(stack) = stack_of(screen, tree) else {
        return false;
    };
    let screens: Vec<i32> = tree
        .children(stack)
        .into_iter()
        .filter(|tag| tree.is_live(*tag) && tree.node(*tag).is_some_and(|n| n.component == SCREEN))
        .collect();
    screens
        .iter()
        .position(|tag| *tag == screen)
        .is_some_and(|position| position > 0)
}

/// Whether this header belongs to the screen currently on top of its stack.
fn is_top_header(node: &ComponentNode, tree: &TreeView) -> bool {
    let Some(parent) = node.parent else {
        return true;
    };
    let Some(stack) = stack_of(parent, tree) else {
        return true;
    };
    let screens: Vec<i32> = tree
        .children(stack)
        .into_iter()
        .filter(|tag| tree.node(*tag).is_some_and(|n| n.component == SCREEN))
        .collect();
    let is_last = screens.last().copied() == Some(parent);
    // A screen that is leaving keeps its header while its transition runs, so
    // the header does not blink out before the card has finished moving. An
    // entry transition is never cleared once it ends, so only a running one
    // counts: otherwise the first screen ever pushed keeps its header for good.
    is_last
        || tree
            .transition(parent)
            .is_some_and(|state| state.progress < 1.0)
}

/// Whether the header config carries a subview that paints the title.
///
/// React Navigation puts a custom title in a `title` subview, and a centred one
/// in a `center` subview; either way that subview paints the title, so core must
/// not paint a second copy.
fn has_title_subview(config: &ComponentNode, tree: &TreeView) -> bool {
    tree.children(config.tag)
        .into_iter()
        .filter_map(|tag| tree.node(tag))
        .any(|child| {
            child.component == HEADER_SUBVIEW
                && matches!(props::subview_type(&child), "title" | "center")
        })
}

/// The live screen directly below `top` in its stack, if any.
fn previous_screen(top: i32, stack: i32, tree: &TreeView) -> Option<i32> {
    let screens: Vec<i32> = tree
        .children(stack)
        .into_iter()
        .filter(|tag| tree.is_live(*tag) && tree.node(*tag).is_some_and(|n| n.component == SCREEN))
        .collect();
    let index = screens.iter().position(|tag| *tag == top)?;
    index.checked_sub(1).and_then(|i| screens.get(i)).copied()
}

/// The stack a screen sits in, walking up past intermediate containers.
fn stack_of(screen: i32, tree: &TreeView) -> Option<i32> {
    tree.ancestors(screen)
        .into_iter()
        .find(|tag| tree.node(*tag).is_some_and(|n| n.component == STACK))
}

/// A header subview: positioned by its declared type.
pub struct HeaderSubviewRenderer;

impl ComponentRenderer for HeaderSubviewRenderer {
    fn render(
        &self,
        _node: &ComponentNode,
        _window: &mut Window,
        _cx: &mut App,
    ) -> Option<AnyElement> {
        None
    }

    fn layout_frame(&self, node: &ComponentNode, tree: &TreeView) -> Option<RectF> {
        let mut frame = node.frame;
        let Some(config) = node.parent else {
            return Some(frame);
        };
        let container_width = tree
            .node(config)
            .map(|config| config.frame.w)
            .unwrap_or(frame.w);
        let tallest = tree
            .children(node.tag)
            .into_iter()
            .filter_map(|tag| tree.node(tag))
            .fold(0.0f32, |height, child| height.max(child.frame.h));
        frame.x = match props::subview_type(node) {
            "right" => container_width - frame.w - 12.0,
            "center" | "title" => (container_width - frame.w) / 2.0,
            "left" => 12.0,
            _ => frame.x,
        };
        frame.y = ((HEADER_HEIGHT - tallest).max(0.0)) / 2.0;
        Some(frame)
    }
}

/// A screen's content area, inset by the header when one is showing.
pub struct ContentWrapperRenderer;

impl ComponentRenderer for ContentWrapperRenderer {
    fn render(
        &self,
        _node: &ComponentNode,
        _window: &mut Window,
        _cx: &mut App,
    ) -> Option<AnyElement> {
        None
    }

    fn layout_frame(&self, node: &ComponentNode, tree: &TreeView) -> Option<RectF> {
        let Some(screen) = node.parent else {
            return None;
        };
        let mut frame = node.frame;
        // Only a header that is actually showing takes space. When it is hidden
        // the C++ half already gave the wrapper the whole screen, so the Yoga
        // frame is the answer and any adjustment here would move it twice.
        if !header_hidden(screen, tree) {
            frame.y += HEADER_HEIGHT;
            frame.h = (frame.h - HEADER_HEIGHT).max(0.0);
        }
        Some(frame)
    }
}

/// Whether a screen's header config is hidden, whether or not it exists.
fn header_hidden(screen: i32, tree: &TreeView) -> bool {
    tree.children(screen)
        .into_iter()
        .filter_map(|tag| tree.node(tag))
        .find(|node| node.component == HEADER_CONFIG)
        .is_some_and(|config| props::header_hidden(&config))
}

/// The gap a modal sheet leaves around itself, and the size it is capped at.
const SHEET_MARGIN: f32 = 48.0;
const SHEET_MAX_WIDTH: f32 = 760.0;
const SHEET_MAX_HEIGHT: f32 = 640.0;

/// A modal presentation. It paints like a screen; the difference is that the
/// card underneath stays visible.
pub struct ModalScreenRenderer;

impl ComponentRenderer for ModalScreenRenderer {
    fn render(
        &self,
        _node: &ComponentNode,
        _window: &mut Window,
        _cx: &mut App,
    ) -> Option<AnyElement> {
        None
    }
}

/// A full-window overlay paints over the whole window, not inside the tree.
pub struct FullWindowOverlayRenderer;

impl ComponentRenderer for FullWindowOverlayRenderer {
    fn render(
        &self,
        _node: &ComponentNode,
        _window: &mut Window,
        _cx: &mut App,
    ) -> Option<AnyElement> {
        None
    }

    fn portal(&self, _props: &serde_json::Value) -> Option<Portal> {
        Some(Portal {
            visible: true,
            close_request_event: None,
        })
    }
}

/// Every component name this module paints, and how to build its renderer.
pub const RENDERED_COMPONENTS: &[(&str, fn() -> Box<dyn ComponentRenderer>)] = &[
    (STACK, || Box::new(StackRenderer)),
    (SCREEN, || Box::new(ScreenRenderer)),
    (MODAL_SCREEN, || Box::new(ModalScreenRenderer)),
    (HEADER_CONFIG, || Box::new(HeaderConfigRenderer)),
    (HEADER_SUBVIEW, || Box::new(HeaderSubviewRenderer)),
    (CONTENT_WRAPPER, || Box::new(ContentWrapperRenderer)),
    (FULL_WINDOW_OVERLAY, || Box::new(FullWindowOverlayRenderer)),
];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state;
    use std::sync::Arc;

    /// Builds a node with the props this module's C++ half would have produced.
    fn node(component: &str, tag: i32, props: serde_json::Value) -> ComponentNode {
        ComponentNode {
            component: component.to_string(),
            tag,
            frame: RectF::default(),
            scale: (1.0, 1.0),
            props: Arc::new(props),
            parent: None,
            children: Vec::new(),
        }
    }

    fn frame(x: f32, y: f32, w: f32, h: f32) -> RectF {
        RectF { x, y, w, h }
    }

    /// A tree built from plain values, matching what core would hand a hook.
    fn tree(
        nodes: Vec<react_native_gpui::extensions::TestNode>,
        edges: &[(i32, i32)],
        top_inset: f32,
    ) -> TreeView<'static> {
        TreeView::for_test(nodes, edges, top_inset)
    }

    fn entry(
        tag: i32,
        component: &'static str,
        frame: RectF,
        props: serde_json::Value,
    ) -> react_native_gpui::extensions::TestNode {
        react_native_gpui::extensions::TestNode {
            tag,
            component: component.to_string(),
            frame,
            scale: (1.0, 1.0),
            props,
        }
    }

    /// A stack with one screen, its header config and its content wrapper.
    ///
    /// `header` is the header config's props and `content_height` the wrapper's
    /// Yoga height, which the C++ half computes for the whole screen.
    fn stack_with_header(
        header: serde_json::Value,
        content_height: f32,
    ) -> (TreeView<'static>, i32, i32) {
        let nodes = vec![
            entry(
                1,
                STACK,
                frame(0.0, 0.0, 400.0, 600.0),
                serde_json::json!({}),
            ),
            entry(
                2,
                SCREEN,
                frame(0.0, 0.0, 400.0, 600.0),
                serde_json::json!({"activityState": 2, "stackPresentation": "card"}),
            ),
            entry(3, HEADER_CONFIG, frame(0.0, 0.0, 400.0, 56.0), header),
            entry(
                4,
                CONTENT_WRAPPER,
                frame(0.0, 0.0, 400.0, content_height),
                serde_json::json!({}),
            ),
        ];
        let edges = [(1, 2), (2, 3), (2, 4)];
        (tree(nodes, &edges, 0.0), 3, 4)
    }

    #[test]
    fn a_visible_header_pushes_the_content_down_by_its_height() {
        // Yoga gives the wrapper the whole screen; a visible header takes the
        // top 56 px of it, so the content starts below the bar.
        let (tree, _, wrapper) = stack_with_header(serde_json::json!({"title": "Home"}), 600.0);
        let node = tree.node(wrapper).expect("wrapper is mounted");
        let laid_out = ContentWrapperRenderer
            .layout_frame(&node, &tree)
            .expect("the wrapper is laid out");
        assert_eq!(laid_out.y, HEADER_HEIGHT);
        assert_eq!(laid_out.h, 600.0 - HEADER_HEIGHT);
    }

    #[test]
    fn a_hidden_header_leaves_the_content_where_yoga_put_it() {
        // The C++ half gives a hidden-header screen's wrapper the full height,
        // so any adjustment here would move the content a second time: the
        // reported bug was content sitting 56 px above the top of the window.
        let (tree, _, wrapper) =
            stack_with_header(serde_json::json!({"title": "Home", "hidden": true}), 600.0);
        let node = tree.node(wrapper).expect("wrapper is mounted");
        let laid_out = ContentWrapperRenderer
            .layout_frame(&node, &tree)
            .expect("the wrapper is laid out");
        assert_eq!(laid_out.y, 0.0);
        assert_eq!(laid_out.h, 600.0);
    }

    #[test]
    fn the_header_sits_below_the_window_inset_and_is_one_bar_tall() {
        let (tree, header, _) = stack_with_header(serde_json::json!({"title": "Home"}), 600.0);
        // A window whose title bar takes 28 px: the bar must start below it.
        let tree = tree_with_inset(&tree, 28.0);
        let node = tree.node(header).expect("header is mounted");
        let laid_out = HeaderConfigRenderer
            .layout_frame(&node, &tree)
            .expect("the header is laid out");
        assert_eq!(laid_out.y, 28.0);
        assert_eq!(laid_out.h, HEADER_HEIGHT);
    }

    #[test]
    fn a_hidden_header_takes_no_height_and_paints_nothing() {
        let (tree, header, _) =
            stack_with_header(serde_json::json!({"title": "Home", "hidden": true}), 600.0);
        let node = tree.node(header).expect("header is mounted");
        let laid_out = HeaderConfigRenderer
            .layout_frame(&node, &tree)
            .expect("the header is laid out");
        assert_eq!(laid_out.h, 0.0);
        assert!(HeaderConfigRenderer.hides_subtree(&node, &tree));
        assert_eq!(
            HeaderConfigRenderer.decorate(&node, &tree).display,
            Some(false)
        );
    }

    /// A header carrying a `title` or `center` subview must not paint a second
    /// title of its own: the subview is the title.
    #[test]
    fn a_title_subview_suppresses_the_headers_own_title() {
        for subview_type in ["title", "center"] {
            let nodes = vec![
                entry(
                    1,
                    STACK,
                    frame(0.0, 0.0, 400.0, 600.0),
                    serde_json::json!({}),
                ),
                entry(
                    2,
                    SCREEN,
                    frame(0.0, 0.0, 400.0, 600.0),
                    serde_json::json!({"activityState": 2, "stackPresentation": "card"}),
                ),
                entry(
                    3,
                    HEADER_CONFIG,
                    frame(0.0, 0.0, 400.0, 56.0),
                    serde_json::json!({"title": "Details 1"}),
                ),
                entry(
                    4,
                    HEADER_SUBVIEW,
                    frame(0.0, 0.0, 80.0, 20.0),
                    serde_json::json!({ "type": subview_type }),
                ),
            ];
            let edges = [(1, 2), (2, 3), (3, 4)];
            let tree = tree(nodes, &edges, 0.0);
            let config = tree.node(3).expect("header config is mounted");
            assert!(
                has_title_subview(&config, &tree),
                "a {subview_type} subview paints the title"
            );
        }
    }

    #[test]
    fn a_header_without_a_title_subview_paints_its_title() {
        let (tree, header, _) = stack_with_header(serde_json::json!({"title": "Home"}), 600.0);
        let node = tree.node(header).expect("header is mounted");
        assert!(!has_title_subview(&node, &tree));
    }

    #[test]
    fn the_header_paints_the_colours_react_native_asked_for() {
        let (tree, header, _) = stack_with_header(
            serde_json::json!({
                "title": "Home",
                "backgroundColor": 0xff203040u32,
            }),
            600.0,
        );
        let node = tree.node(header).expect("header is mounted");
        let decoration = HeaderConfigRenderer.decorate(&node, &tree);
        assert_eq!(decoration.background, Some(0xff203040));
        assert_ne!(decoration.display, Some(false));
    }

    #[test]
    fn a_header_without_a_background_falls_back_to_the_default() {
        let (tree, header, _) = stack_with_header(serde_json::json!({"title": "Home"}), 600.0);
        let node = tree.node(header).expect("header is mounted");
        assert_eq!(
            HeaderConfigRenderer.decorate(&node, &tree).background,
            Some(0xff171923)
        );
    }

    /// The same tree as `stack_with_header` but with a window inset.
    fn tree_with_inset(source: &TreeView<'_>, inset: f32) -> TreeView<'static> {
        let mut nodes: Vec<react_native_gpui::extensions::TestNode> = Vec::new();
        let mut edges = Vec::new();
        for tag in [1, 2, 3, 4] {
            let node = source.node(tag).expect("node is mounted");
            nodes.push(react_native_gpui::extensions::TestNode {
                tag,
                component: node.component,
                frame: node.frame,
                scale: node.scale,
                props: (*node.props).clone(),
            });
            if let Some(parent) = node.parent {
                edges.push((parent, tag));
            }
        }
        tree(nodes, &edges, inset)
    }
}
