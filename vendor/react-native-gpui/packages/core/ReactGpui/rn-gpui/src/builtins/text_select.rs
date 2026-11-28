//! Selecting the text of a `Text` with `selectable`: a drag, a double click for
//! a word, a triple click for a line, Copy from the menu or the context menu.
//!
//! One node holds the selection at a time. Starting a selection elsewhere, or
//! pressing anything that is not selectable text, clears the previous one.

use std::ops::Range;

use gpui::{Context, Pixels, Point, Window};

use crate::node_view::RNNodeView;
use crate::store::store_from;

/// The tag of the node that holds the selection, if any.
#[derive(Default)]
pub(crate) struct ActiveSelection(pub Option<i32>);

impl gpui::Global for ActiveSelection {}

pub(crate) fn is_selectable(node: &RNNodeView) -> bool {
    node.component != "TextInput" && node.paragraph.as_ref().is_some_and(|p| p.selectable)
}

fn content_width(node: &RNNodeView) -> f32 {
    (node.frame.w - node.view.content_insets.left - node.view.content_insets.right).max(0.0)
}

fn index_at(node: &RNNodeView, point: Point<Pixels>, cx: &gpui::App) -> Option<usize> {
    let paragraph = node.paragraph.as_ref()?;
    let origin = node.absolute_origin(cx);
    let (scale_x, scale_y) = node.cumulative_scale(cx);
    let x = f32::from(point.x - origin.x) / scale_x.max(0.0001) - node.view.content_insets.left;
    let y = f32::from(point.y - origin.y) / scale_y.max(0.0001) - node.view.content_insets.top;
    crate::text::text_index_at(paragraph, content_width(node), x.max(0.0), y.max(0.0))
}

fn class(ch: char) -> u8 {
    if ch.is_alphanumeric() || ch == '_' {
        0
    } else if ch.is_whitespace() {
        1
    } else {
        2
    }
}

/// The run of same-class characters around `index`.
fn word_range(text: &str, index: usize) -> Range<usize> {
    let index = index.min(text.len());
    let before = text[..index].chars().next_back();
    let after = text[index..].chars().next();
    let Some(anchor) = after.or(before) else {
        return index..index;
    };
    let kind = class(anchor);
    let start = text[..index]
        .char_indices()
        .rev()
        .take_while(|(_, ch)| class(*ch) == kind)
        .last()
        .map_or(index, |(at, _)| at);
    let end = text[index..]
        .char_indices()
        .find(|(_, ch)| class(*ch) != kind)
        .map_or(text.len(), |(at, _)| index + at);
    start..end
}

/// The hard line around `index`, without its newline.
fn line_range(text: &str, index: usize) -> Range<usize> {
    let index = index.min(text.len());
    let start = text[..index].rfind('\n').map_or(0, |at| at + 1);
    let end = text[index..].find('\n').map_or(text.len(), |at| index + at);
    start..end
}

fn claim(node: &mut RNNodeView, cx: &mut Context<RNNodeView>) {
    let tag = node.tag;
    let previous = cx
        .try_global::<ActiveSelection>()
        .and_then(|active| active.0)
        .filter(|previous| *previous != tag);
    cx.set_global(ActiveSelection(Some(tag)));
    if let (Some(previous), Some(store)) = (previous, store_from(cx)) {
        if let Some(entity) = store.read(cx).nodes.get(&previous).cloned() {
            cx.defer(move |cx| {
                entity.update(cx, |node, cx| {
                    node.text_selection = 0..0;
                    node.text_selection_anchor = None;
                    cx.notify();
                });
            });
        }
    }
}

/// A press on selectable text: a caret for one click, a word for two, a line
/// for three.
pub(crate) fn begin(
    node: &mut RNNodeView,
    point: Point<Pixels>,
    click_count: usize,
    cx: &mut Context<RNNodeView>,
) {
    let Some(paragraph) = node.paragraph.as_ref() else {
        return;
    };
    let text = crate::text::paragraph_text(paragraph);
    let index = index_at(node, point, cx)
        .unwrap_or(text.len())
        .min(text.len());
    claim(node, cx);
    match click_count {
        0 | 1 => {
            node.text_selection = index..index;
            node.text_selection_anchor = Some(index);
        }
        2 => {
            node.text_selection = word_range(&text, index);
            node.text_selection_anchor = None;
        }
        _ => {
            node.text_selection = line_range(&text, index);
            node.text_selection_anchor = None;
        }
    }
    cx.notify();
}

/// The pointer moved with the button down.
pub(crate) fn extend(node: &mut RNNodeView, point: Point<Pixels>, cx: &mut Context<RNNodeView>) {
    let Some(anchor) = node.text_selection_anchor else {
        return;
    };
    let Some(index) = index_at(node, point, cx) else {
        return;
    };
    node.text_selection = anchor.min(index)..anchor.max(index);
    cx.notify();
}

pub(crate) fn select_all(node: &mut RNNodeView, cx: &mut Context<RNNodeView>) {
    let Some(paragraph) = node.paragraph.as_ref() else {
        return;
    };
    let length = crate::text::paragraph_text(paragraph).len();
    claim(node, cx);
    node.text_selection = 0..length;
    node.text_selection_anchor = None;
    cx.notify();
}

pub(crate) fn selected_text(node: &RNNodeView) -> Option<String> {
    let paragraph = node.paragraph.as_ref()?;
    let text = crate::text::paragraph_text(paragraph);
    let range = node.text_selection.start.min(text.len())..node.text_selection.end.min(text.len());
    (!range.is_empty() && text.is_char_boundary(range.start) && text.is_char_boundary(range.end))
        .then(|| text[range].to_string())
}

pub(crate) fn copy(node: &RNNodeView, cx: &mut gpui::App) -> bool {
    match selected_text(node) {
        Some(text) => {
            cx.write_to_clipboard(gpui::ClipboardItem::new_string(text));
            true
        }
        None => false,
    }
}

/// Copies what the node holding the selection has selected.
pub(crate) fn copy_active(cx: &mut gpui::App) -> bool {
    let text = active_node(cx).and_then(|node| selected_text(node.read(cx)));
    match text {
        Some(text) => {
            cx.write_to_clipboard(gpui::ClipboardItem::new_string(text));
            true
        }
        None => false,
    }
}

/// Drops the selection of whichever node holds it.
pub(crate) fn clear_active(cx: &mut gpui::App) {
    let Some(tag) = cx
        .try_global::<ActiveSelection>()
        .and_then(|active| active.0)
    else {
        return;
    };
    cx.set_global(ActiveSelection(None));
    let Some(store) = store_from(cx) else {
        return;
    };
    if let Some(entity) = store.read(cx).nodes.get(&tag).cloned() {
        entity.update(cx, |node, cx| {
            node.text_selection = 0..0;
            node.text_selection_anchor = None;
            cx.notify();
        });
    }
}

/// The node holding the selection, for the menu's Copy and Select All.
pub(crate) fn active_node(cx: &gpui::App) -> Option<gpui::Entity<RNNodeView>> {
    let tag = cx.try_global::<ActiveSelection>()?.0?;
    store_from(cx)?.read(cx).nodes.get(&tag).cloned()
}

const MENU_COPY: &str = "copy";
const MENU_SELECT_ALL: &str = "selectAll";

/// Opens a Copy and Select All menu over selectable text.
pub(crate) fn show_menu(
    entity: &gpui::Entity<RNNodeView>,
    position: Point<Pixels>,
    window: &mut Window,
    cx: &mut gpui::App,
) -> bool {
    use crate::desktop::menu_model::{MenuItemDef, MenuModel, MenuNode};
    let (selectable, has_selection, tag) = {
        let node = entity.read(cx);
        (is_selectable(node), selected_text(node).is_some(), node.tag)
    };
    if !selectable {
        return false;
    }
    let item = |id: &str, label: &str, enabled: bool| {
        MenuNode::Item(MenuItemDef {
            id: id.to_string(),
            label: label.to_string(),
            accelerator: None,
            enabled,
            checked: false,
            role: None,
            icon: None,
        })
    };
    let model = MenuModel {
        items: vec![
            item(MENU_COPY, "Copy", has_selection),
            MenuNode::Separator,
            item(MENU_SELECT_ALL, "Select All", true),
        ],
    };
    let handle = window.window_handle();
    let responder = crate::desktop::context_menu::Responder::callback(Box::new(move |choice| {
        let Some(choice) = choice else {
            return;
        };
        crate::desktop::post_to_main(Box::new(move |cx: &mut gpui::App| {
            let Some(entity) =
                store_from(cx).and_then(|store| store.read(cx).nodes.get(&tag).cloned())
            else {
                return;
            };
            let _ = handle.update(cx, |_root, _window, cx| {
                entity.update(cx, |node, cx| match choice.as_str() {
                    MENU_COPY => {
                        copy(node, cx);
                    }
                    MENU_SELECT_ALL => select_all(node, cx),
                    _ => {}
                });
            });
        }));
    }));
    crate::desktop::context_menu::present(
        cx,
        model,
        handle,
        (f32::from(position.x), f32::from(position.y)),
        responder,
    );
    true
}

#[cfg(test)]
mod tests {
    use super::{line_range, word_range};

    #[test]
    fn a_word_is_the_run_of_its_own_kind_around_the_index() {
        assert_eq!(word_range("hello big world", 7), 6..9);
        assert_eq!(word_range("hello, world", 5), 5..6);
        assert_eq!(word_range("hello  world", 6), 5..7);
        assert_eq!(word_range("", 0), 0..0);
    }

    #[test]
    fn a_line_stops_at_the_newlines() {
        assert_eq!(line_range("one\ntwo\nthree", 5), 4..7);
        assert_eq!(line_range("one\ntwo", 0), 0..3);
        assert_eq!(line_range("one\ntwo", 7), 4..7);
    }
}
