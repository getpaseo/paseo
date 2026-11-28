use crate::node_view::RNNodeView;
use crate::store::store_from;
use gpui::{
    Bounds, Context, EntityInputHandler, Pixels, Point, TextInputConfiguration, UTF16Selection,
    Window,
};
use std::ops::Range;

pub(crate) fn handle_key(
    this: &mut RNNodeView,
    key: &str,
    extend_selection: bool,
    window: &mut Window,
    cx: &mut Context<RNNodeView>,
) -> bool {
    if !this.input().editable && !matches!(key, "left" | "right" | "home" | "end") {
        return false;
    }
    match key {
        "backspace" | "delete" => {
            let mut range = selected_range(this);
            if range.is_empty() {
                if key == "backspace" {
                    range.start = this.input().text[..range.start]
                        .char_indices()
                        .next_back()
                        .map(|(index, _)| index)
                        .unwrap_or(0);
                } else if range.end < this.input().text.len() {
                    range.end += this.input().text[range.end..]
                        .chars()
                        .next()
                        .map(char::len_utf8)
                        .unwrap_or(0);
                }
            }
            if !range.is_empty() {
                this.input_mut().text.replace_range(range.clone(), "");
                this.input_mut().selection = range.start..range.start;
                this.input_mut().selection_anchor = None;
                this.input_mut().marked = None;
                this.sync_input_paragraph();
                emit_change(this, window, cx);
            }
            true
        }
        "enter" => {
            if this
                .input()
                .submit_behavior
                .inserts_newline(this.input().multiline)
            {
                let max_length = this.input().max_length;
                let input = this.input_mut();
                replace_plain_text(
                    &mut input.text,
                    &mut input.selection,
                    &mut input.marked,
                    None,
                    "\n",
                    max_length,
                );
                this.sync_input_paragraph();
                emit_change(this, window, cx);
            } else if let Some(store) = store_from(cx) {
                store.read(cx).host.dispatch_event(
                    this.tag,
                    "topSubmitEditing",
                    &serde_json::json!({
                        "text": this.input().text, "eventCount": this.input().event_count,
                    }),
                );
                if this.input().submit_behavior.blurs(this.input().multiline) {
                    window.blur(cx);
                }
            }
            true
        }
        "left" | "right" | "home" | "end" => {
            let text = this.input().text.clone();
            let selection = selected_range(this);
            let (anchor, focus) = if extend_selection {
                let anchor = *this
                    .input_mut()
                    .selection_anchor
                    .get_or_insert(selection.start);
                let active = if selection.is_empty() {
                    selection.end
                } else if anchor == selection.start {
                    selection.end
                } else {
                    selection.start
                };
                let next = match key {
                    "left" => text[..active]
                        .char_indices()
                        .next_back()
                        .map(|(index, _)| index)
                        .unwrap_or(0),
                    "right" => {
                        active
                            + text[active..]
                                .chars()
                                .next()
                                .map(char::len_utf8)
                                .unwrap_or(0)
                    }
                    "home" => text[..active]
                        .rfind('\n')
                        .map(|index| index + 1)
                        .unwrap_or(0),
                    "end" => active + text[active..].find('\n').unwrap_or(text.len() - active),
                    _ => active,
                };
                (anchor, next)
            } else if !selection.is_empty() {
                this.input_mut().selection_anchor = None;
                let cursor = if key == "left" || key == "home" {
                    selection.start
                } else {
                    selection.end
                };
                (cursor, cursor)
            } else {
                this.input_mut().selection_anchor = None;
                let cursor = selection.end;
                let next = match key {
                    "left" => text[..cursor]
                        .char_indices()
                        .next_back()
                        .map(|(index, _)| index)
                        .unwrap_or(0),
                    "right" => {
                        cursor
                            + text[cursor..]
                                .chars()
                                .next()
                                .map(char::len_utf8)
                                .unwrap_or(0)
                    }
                    "home" => text[..cursor]
                        .rfind('\n')
                        .map(|index| index + 1)
                        .unwrap_or(0),
                    "end" => cursor + text[cursor..].find('\n').unwrap_or(text.len() - cursor),
                    _ => cursor,
                };
                (next, next)
            };
            this.input_mut().selection = anchor.min(focus)..anchor.max(focus);
            this.input_mut().marked = None;
            emit_selection(this, window, cx);
            true
        }
        _ => false,
    }
}

const MENU_CUT: &str = "cut";
const MENU_COPY: &str = "copy";
const MENU_PASTE: &str = "paste";
const MENU_SELECT_ALL: &str = "selectAll";

fn text_menu_model(this: &RNNodeView, can_paste: bool) -> crate::desktop::menu_model::MenuModel {
    use crate::desktop::menu_model::{MenuItemDef, MenuModel, MenuNode};
    let has_selection = !selected_range(this).is_empty();
    let editable = this.input().editable;
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
    let mut items = Vec::new();
    if editable {
        items.push(item(MENU_CUT, "Cut", has_selection));
    }
    items.push(item(MENU_COPY, "Copy", has_selection));
    if editable {
        items.push(item(MENU_PASTE, "Paste", can_paste));
    }
    items.push(MenuNode::Separator);
    items.push(item(
        MENU_SELECT_ALL,
        "Select All",
        !this.input().text.is_empty(),
    ));
    MenuModel { items }
}

/// Opens the Cut, Copy, Paste and Select All menu over a text input, unless the
/// input hides it. Returns whether a menu was shown.
pub(crate) fn show_text_menu(
    entity: &gpui::Entity<RNNodeView>,
    position: Point<Pixels>,
    window: &mut Window,
    cx: &mut gpui::App,
) -> bool {
    let can_paste = cx
        .read_from_clipboard()
        .is_some_and(|item| item.text().is_some_and(|text| !text.is_empty()));
    let this = entity.read(cx);
    if this.component != "TextInput" || this.input().context_menu_hidden {
        return false;
    }
    let model = text_menu_model(this, can_paste);
    let tag = this.tag;
    let handle = window.window_handle();
    let responder = crate::desktop::context_menu::Responder::callback(Box::new(move |choice| {
        let Some(choice) = choice else {
            return;
        };
        crate::desktop::post_to_main(Box::new(move |cx: &mut gpui::App| {
            let Some(store) = store_from(cx) else {
                return;
            };
            let Some(entity) = store.read(cx).nodes.get(&tag).cloned() else {
                return;
            };
            let _ = handle.update(cx, |_root, window, cx| {
                entity.update(cx, |this, cx| {
                    match choice.as_str() {
                        MENU_CUT => {
                            cut_selection(this, window, cx);
                        }
                        MENU_COPY => {
                            copy_selection(this, cx);
                        }
                        MENU_PASTE => {
                            paste_clipboard(this, window, cx);
                        }
                        MENU_SELECT_ALL => select_all(this, window, cx),
                        _ => {}
                    }
                    cx.notify();
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

pub(crate) fn select_at_point(
    this: &mut RNNodeView,
    point: Point<Pixels>,
    extend: bool,
    window: &mut Window,
    cx: &mut Context<RNNodeView>,
) {
    if this.component != "TextInput" {
        return;
    }
    let index = this
        .character_index_for_point(point, window, cx)
        .map(|index| byte_at_utf16(&this.input().text, index))
        .unwrap_or(this.input().text.len());
    let anchor = if extend {
        this.input()
            .selection_anchor
            .unwrap_or(this.input().selection.start)
    } else {
        index
    };
    this.input_mut().selection_anchor = Some(anchor);
    this.input_mut().selection = anchor.min(index)..anchor.max(index);
    // The press that focused the input selects everything, not a caret.
    if !extend
        && this
            .input()
            .select_all_until
            .is_some_and(|until| std::time::Instant::now() < until)
    {
        this.input_mut().selection = 0..this.input().text.len();
        this.input_mut().selection_anchor = None;
    }
    emit_selection(this, window, cx);
}

pub(crate) fn select_all(this: &mut RNNodeView, window: &mut Window, cx: &mut Context<RNNodeView>) {
    if this.component != "TextInput" {
        return;
    }
    this.input_mut().selection = 0..this.input().text.len();
    this.input_mut().selection_anchor = None;
    emit_selection(this, window, cx);
}

pub(crate) fn copy_selection(this: &RNNodeView, cx: &mut gpui::App) -> bool {
    if this.component != "TextInput" {
        return false;
    }
    let range = selected_range(this);
    if range.is_empty() {
        return false;
    }
    let text = this.input().text[range].to_string();
    cx.write_to_clipboard(gpui::ClipboardItem::new_string(text));
    true
}

pub(crate) fn cut_selection(
    this: &mut RNNodeView,
    window: &mut Window,
    cx: &mut Context<RNNodeView>,
) -> bool {
    if !this.input().editable || !copy_selection(this, cx) {
        return false;
    }
    let range = selected_range(this);
    this.input_mut().text.replace_range(range.clone(), "");
    this.input_mut().selection = range.start..range.start;
    this.input_mut().selection_anchor = None;
    this.input_mut().marked = None;
    this.sync_input_paragraph();
    emit_change(this, window, cx);
    true
}

pub(crate) fn paste_clipboard(
    this: &mut RNNodeView,
    window: &mut Window,
    cx: &mut Context<RNNodeView>,
) -> bool {
    if !this.input().editable {
        return false;
    }
    let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) else {
        return false;
    };
    if text.is_empty() {
        return false;
    }
    let max_length = this.input().max_length;
    let input = this.input_mut();
    replace_plain_text(
        &mut input.text,
        &mut input.selection,
        &mut input.marked,
        None,
        &text,
        max_length,
    );
    this.sync_input_paragraph();
    emit_change(this, window, cx);
    true
}

pub(crate) fn byte_at_utf16(text: &str, offset: usize) -> usize {
    let mut units = 0;
    for (byte, ch) in text.char_indices() {
        if units >= offset {
            return byte;
        }
        let next = units + ch.len_utf16();
        if next > offset {
            return byte;
        }
        units = next;
    }
    text.len()
}

fn utf16_at_byte(text: &str, offset: usize) -> usize {
    let offset = offset.min(text.len());
    text.char_indices()
        .take_while(|(byte, _)| *byte < offset)
        .map(|(_, ch)| ch.len_utf16())
        .sum()
}

fn byte_range(text: &str, range: Range<usize>) -> Range<usize> {
    let start = byte_at_utf16(text, range.start);
    let end = byte_at_utf16(text, range.end.max(range.start));
    start..end.max(start)
}

pub(crate) fn reconcile_selection(
    text: &str,
    current: Range<usize>,
    explicit_utf16: Option<Range<usize>>,
    initialize: bool,
) -> Range<usize> {
    if let Some(selection) = explicit_utf16 {
        byte_range(text, selection)
    } else if initialize {
        text.len()..text.len()
    } else {
        current.start.min(text.len())..current.end.min(text.len())
    }
}

pub(crate) fn should_apply_text_update(native_event_count: i32, props_event_count: i32) -> bool {
    props_event_count >= native_event_count
}

fn utf16_range(text: &str, range: Range<usize>) -> Range<usize> {
    utf16_at_byte(text, range.start)..utf16_at_byte(text, range.end)
}

fn selected_range(this: &RNNodeView) -> Range<usize> {
    this.input().selection.start.min(this.input().text.len())
        ..this.input().selection.end.min(this.input().text.len())
}

fn replacement_range(
    text: &str,
    selection: &Range<usize>,
    marked: &mut Option<Range<usize>>,
    range_utf16: Option<Range<usize>>,
) -> Range<usize> {
    range_utf16
        .map(|range| byte_range(text, range))
        .or_else(|| marked.take())
        .unwrap_or_else(|| selection.clone())
}

/// The longest prefix of `inserted` that keeps `text` within `max_length`
/// UTF-16 units once `range` is replaced, never splitting a character.
fn fit_insert<'a>(
    text: &str,
    range: &Range<usize>,
    inserted: &'a str,
    max_length: usize,
) -> &'a str {
    if max_length == usize::MAX {
        return inserted;
    }
    let kept =
        utf16_at_byte(text, range.start) + text[range.end.min(text.len())..].encode_utf16().count();
    let mut room = max_length.saturating_sub(kept);
    for (byte, ch) in inserted.char_indices() {
        if ch.len_utf16() > room {
            return &inserted[..byte];
        }
        room -= ch.len_utf16();
    }
    inserted
}

fn replace_plain_text(
    text: &mut String,
    selection: &mut Range<usize>,
    marked: &mut Option<Range<usize>>,
    range_utf16: Option<Range<usize>>,
    inserted: &str,
    max_length: usize,
) {
    let range = replacement_range(text, selection, marked, range_utf16);
    let inserted = fit_insert(text, &range, inserted, max_length);
    text.replace_range(range.clone(), inserted);
    let cursor = range.start + inserted.len();
    *selection = cursor..cursor;
    *marked = None;
}

fn replace_marked_text(
    text: &mut String,
    selection: &mut Range<usize>,
    marked: &mut Option<Range<usize>>,
    range_utf16: Option<Range<usize>>,
    inserted: &str,
    selected_range_utf16: Option<Range<usize>>,
    max_length: usize,
) {
    let range = replacement_range(text, selection, marked, range_utf16);
    let inserted = fit_insert(text, &range, inserted, max_length);
    text.replace_range(range.clone(), inserted);
    let composing = range.start..range.start + inserted.len();
    *marked = (!inserted.is_empty()).then_some(composing.clone());
    *selection = selected_range_utf16
        .map(|selected| {
            let selected = byte_range(inserted, selected);
            range.start + selected.start..range.start + selected.end
        })
        .unwrap_or(composing.end..composing.end);
}

fn clear_text_state(
    text: &mut String,
    selection: &mut Range<usize>,
    marked: &mut Option<Range<usize>>,
) -> bool {
    if text.is_empty() {
        return false;
    }
    text.clear();
    *selection = 0..0;
    *marked = None;
    true
}

fn emit_change(this: &mut RNNodeView, window: &mut Window, cx: &mut Context<RNNodeView>) {
    this.input_mut().event_count += 1;
    this.input_mut().selection_anchor = None;
    let scrolled_from = this.input().scroll_y;
    keep_caret_visible(this, window);
    let text = this.input().text.clone();
    let selection = utf16_range(&text, selected_range(this));
    if let Some(store) = store_from(cx) {
        let host = store.read(cx).host.clone();
        host.dispatch_event(
            this.tag,
            "topChange",
            &serde_json::json!({
                "text": text,
                "eventCount": this.input().event_count,
            }),
        );
        host.dispatch_event(
            this.tag,
            "topSelectionChange",
            &serde_json::json!({"selection": {"start": selection.start, "end": selection.end}}),
        );
        if this.input().scroll_y != scrolled_from {
            host.dispatch_event(this.tag, "topScroll", &scroll_payload(this));
        }
        store.read(cx).frame_hook.arm(window);
    }
    emit_content_size(this, window, cx);
    this.reset_text_input_caret(cx);
    cx.notify();
}

fn emit_selection(this: &mut RNNodeView, window: &mut Window, cx: &mut Context<RNNodeView>) {
    let scrolled_from = this.input().scroll_y;
    keep_caret_visible(this, window);
    let selection = utf16_range(&this.input().text, selected_range(this));
    if let Some(store) = store_from(cx) {
        let host = store.read(cx).host.clone();
        host.dispatch_event(
            this.tag,
            "topSelectionChange",
            &serde_json::json!({"selection": {"start": selection.start, "end": selection.end}}),
        );
        if this.input().scroll_y != scrolled_from {
            host.dispatch_event(this.tag, "topScroll", &scroll_payload(this));
        }
        store.read(cx).frame_hook.arm(window);
    }
    this.reset_text_input_caret(cx);
    cx.notify();
}

/// The height of one line in the input's own units, as the caret and the
/// selection use it.
pub(crate) fn input_line_height(this: &RNNodeView) -> f32 {
    let fragment = this
        .paragraph
        .as_ref()
        .and_then(|paragraph| paragraph.fragments.first());
    match fragment {
        Some(fragment) if fragment.line_height > 0.0 => fragment.line_height,
        Some(fragment) => fragment.font_size.max(14.0) * 1.2,
        None => 14.0 * 1.2,
    }
}

fn viewport_height(this: &RNNodeView) -> f32 {
    (this.frame.h - this.view.content_insets.top - this.view.content_insets.bottom).max(0.0)
}

fn multiline_content_height(this: &RNNodeView) -> f32 {
    this.input().text.split('\n').count().max(1) as f32 * input_line_height(this)
}

pub(crate) fn max_scroll_y(this: &RNNodeView) -> f32 {
    (multiline_content_height(this) - viewport_height(this)).max(0.0)
}

fn scroll_payload(this: &RNNodeView) -> serde_json::Value {
    let width =
        (this.frame.w - this.view.content_insets.left - this.view.content_insets.right).max(0.0);
    serde_json::json!({
        "contentOffset": {"x": this.input().scroll_x, "y": this.input().scroll_y},
        "contentSize": {"width": width, "height": multiline_content_height(this)},
        "layoutMeasurement": {"width": width, "height": viewport_height(this)},
    })
}

/// Sets the vertical offset of a multiline input and reports it to `onScroll`
/// when it moved.
pub(crate) fn scroll_input_to(this: &mut RNNodeView, y: f32, cx: &mut Context<RNNodeView>) {
    let next = y.clamp(0.0, max_scroll_y(this));
    if (next - this.input().scroll_y).abs() <= f32::EPSILON {
        return;
    }
    this.input_mut().scroll_y = next;
    if let Some(store) = store_from(cx) {
        store
            .read(cx)
            .host
            .dispatch_event(this.tag, "topScroll", &scroll_payload(this));
    }
    cx.notify();
}

/// Reports the content size to `onContentSizeChange` when it differs from the
/// last report.
fn emit_content_size(this: &mut RNNodeView, window: &mut Window, cx: &mut Context<RNNodeView>) {
    let width = if this.input().multiline {
        (this.frame.w - this.view.content_insets.left - this.view.content_insets.right).max(0.0)
    } else {
        this.paragraph.as_ref().map_or(0.0, |paragraph| {
            let line = this.input().text.split('\n').next().unwrap_or_default();
            crate::text::input_caret_x(window.text_system(), paragraph, line, line.len())
        })
    };
    let height = if this.input().multiline {
        multiline_content_height(this)
    } else {
        input_line_height(this)
    };
    if this.input().content_size == (width, height) {
        return;
    }
    this.input_mut().content_size = (width, height);
    if let Some(store) = store_from(cx) {
        store.read(cx).host.dispatch_event(
            this.tag,
            "topContentSizeChange",
            &serde_json::json!({"contentSize": {"width": width, "height": height}}),
        );
    }
}

pub(crate) fn keep_caret_visible(this: &mut RNNodeView, window: &mut Window) {
    if this.input().multiline {
        this.input_mut().scroll_x = 0.0;
        let line_height = input_line_height(this);
        let end = this.input().selection.end.min(this.input().text.len());
        let line = this.input().text[..end].matches('\n').count() as f32;
        let (top, bottom) = (line * line_height, (line + 1.0) * line_height);
        let height = viewport_height(this);
        let mut offset = this.input().scroll_y;
        if top < offset {
            offset = top;
        } else if bottom > offset + height {
            offset = bottom - height;
        }
        this.input_mut().scroll_y = offset.clamp(0.0, max_scroll_y(this));
        return;
    }
    let Some(paragraph) = this.paragraph.as_ref() else {
        this.input_mut().scroll_x = 0.0;
        return;
    };
    if paragraph.fragments.is_empty() {
        this.input_mut().scroll_x = 0.0;
        return;
    }
    let end = this.input().selection.end.min(this.input().text.len());
    let line_start = this.input().text[..end]
        .rfind('\n')
        .map_or(0, |index| index + 1);
    let line = &this.input().text[line_start..end];
    let caret_x = crate::text::input_caret_x(window.text_system(), paragraph, line, line.len());
    let viewport =
        (this.frame.w - this.view.content_insets.left - this.view.content_insets.right).max(0.0);
    this.input_mut().scroll_x = input_scroll_offset(this.input().scroll_x, caret_x, viewport);
}

fn input_scroll_offset(current: f32, caret_x: f32, viewport: f32) -> f32 {
    let current = current.max(0.0);
    let viewport = viewport.max(0.0);
    if caret_x < current {
        caret_x.max(0.0)
    } else if caret_x > current + viewport {
        (caret_x - viewport + 1.0).max(0.0)
    } else {
        current
    }
}

pub fn clear_text_input(this: &mut RNNodeView, window: &mut Window, cx: &mut Context<RNNodeView>) {
    if this.component != "TextInput"
        || !{
            let input = this.input_mut();
            clear_text_state(&mut input.text, &mut input.selection, &mut input.marked)
        }
    {
        return;
    }
    this.sync_input_paragraph();
    emit_change(this, window, cx);
}

impl EntityInputHandler for RNNodeView {
    fn text_for_range(
        &mut self,
        range_utf16: Range<usize>,
        actual_range: &mut Option<Range<usize>>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<String> {
        let range = byte_range(&self.input().text, range_utf16);
        *actual_range = Some(utf16_range(&self.input().text, range.clone()));
        Some(self.input().text[range].to_owned())
    }

    fn selected_text_range(
        &mut self,
        _ignore_disabled_input: bool,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: utf16_range(&self.input().text, selected_range(self)),
            reversed: false,
        })
    }

    fn marked_text_range(
        &self,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Range<usize>> {
        self.input()
            .marked
            .as_ref()
            .map(|range| utf16_range(&self.input().text, range.clone()))
    }

    fn unmark_text(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        self.input_mut().marked = None;
        cx.notify();
    }

    fn replace_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        text: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.input().editable {
            return;
        }
        if !self.input().multiline && (text.contains('\n') || text.contains('\r')) {
            if let Some(store) = store_from(cx) {
                let host = store.read(cx).host.clone();
                host.dispatch_event(
                    self.tag,
                    "topSubmitEditing",
                    &serde_json::json!({
                        "text": self.input().text,
                        "eventCount": self.input().event_count,
                    }),
                );
            }
            return;
        }
        let max_length = self.input().max_length;
        let input = self.input_mut();
        replace_plain_text(
            &mut input.text,
            &mut input.selection,
            &mut input.marked,
            range_utf16,
            text,
            max_length,
        );
        self.sync_input_paragraph();
        emit_change(self, window, cx);
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        new_selected_range_utf16: Option<Range<usize>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.input().editable {
            return;
        }
        let max_length = self.input().max_length;
        let input = self.input_mut();
        replace_marked_text(
            &mut input.text,
            &mut input.selection,
            &mut input.marked,
            range_utf16,
            new_text,
            new_selected_range_utf16,
            max_length,
        );
        self.sync_input_paragraph();
        emit_change(self, window, cx);
    }

    fn bounds_for_range(
        &mut self,
        range_utf16: Range<usize>,
        element_bounds: Bounds<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let _ = range_utf16;
        Some(element_bounds)
    }

    fn character_index_for_point(
        &mut self,
        point: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<usize> {
        let origin = self.absolute_origin(cx);
        let (scale_x, scale_y) = self.cumulative_scale(cx);
        let font_size = self
            .paragraph
            .as_ref()
            .and_then(|paragraph| paragraph.fragments.first())
            .map(|fragment| fragment.font_size.max(14.0))
            .unwrap_or(14.0);
        let line_height = self
            .paragraph
            .as_ref()
            .and_then(|paragraph| paragraph.fragments.first())
            .map(|fragment| {
                if fragment.line_height > 0.0 {
                    fragment.line_height
                } else {
                    font_size * 1.2
                }
            })
            .unwrap_or(font_size * 1.2);
        let local_x = (f32::from(point.x - origin.x) / scale_x.max(0.0001)
            - self.view.content_insets.left)
            .max(0.0);
        let local_x = if self.input().multiline {
            local_x
        } else {
            local_x + self.input().scroll_x
        };
        let local_y = (f32::from(point.y - origin.y) / scale_y.max(0.0001)
            - self.view.content_insets.top)
            .max(0.0);
        let local_y = if self.input().multiline {
            local_y + self.input().scroll_y
        } else {
            local_y
        };
        let target_line = if self.input().multiline {
            (local_y / line_height.max(1.0)).floor() as usize
        } else {
            0
        };
        let mut byte_start = 0;
        let mut line_text = self.input().text.as_str();
        if self.input().multiline {
            for (index, line) in self.input().text.split_inclusive('\n').enumerate() {
                if index == target_line {
                    line_text = line.trim_end_matches('\n');
                    break;
                }
                byte_start += line.len();
                line_text = "";
            }
        }
        let byte_in_line = self
            .paragraph
            .as_ref()
            .map(|paragraph| {
                crate::text::input_index_for_x(window.text_system(), paragraph, line_text, local_x)
            })
            .unwrap_or(line_text.len());
        Some(utf16_at_byte(&self.input().text, byte_start + byte_in_line))
    }

    fn set_selected_text_range(
        &mut self,
        range_utf16: Range<usize>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.input_mut().selection = byte_range(&self.input().text, range_utf16);
        self.input_mut().selection_anchor = None;
        emit_selection(self, _window, cx);
    }

    fn text_length_utf16(
        &mut self,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<usize> {
        Some(self.input().text.encode_utf16().count())
    }

    fn accepts_text_input(&self, _window: &mut Window, _cx: &mut Context<Self>) -> bool {
        self.input().editable
    }

    fn text_input_configuration(
        &mut self,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> TextInputConfiguration {
        TextInputConfiguration::default()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        byte_at_utf16, clear_text_state, input_scroll_offset, reconcile_selection,
        replace_marked_text, replace_plain_text, should_apply_text_update, utf16_at_byte,
    };

    #[test]
    fn utf16_offsets_round_trip_as_unicode_scalar_boundaries() {
        let text = "a😀é";
        for offset in [0, 1, 3, 4] {
            let byte = byte_at_utf16(text, offset);
            assert_eq!(utf16_at_byte(text, byte), offset);
        }
        assert_eq!(byte_at_utf16(text, 2), 1);
    }

    #[test]
    fn plain_replacement_handles_a_selected_surrogate_pair() {
        let mut text = "A😀Z".to_owned();
        let mut selection = 1..5;
        let mut marked = None;

        replace_plain_text(
            &mut text,
            &mut selection,
            &mut marked,
            Some(1..3),
            "é",
            usize::MAX,
        );

        assert_eq!(text, "AéZ");
        assert_eq!(selection, 3..3);
        assert_eq!(marked, None);
    }

    #[test]
    fn insertion_stops_at_max_length_without_splitting_a_character() {
        let mut text = "ab".to_owned();
        let mut selection = 2..2;
        let mut marked = None;

        replace_plain_text(&mut text, &mut selection, &mut marked, None, "😀c", 3);
        assert_eq!(text, "ab");

        replace_plain_text(&mut text, &mut selection, &mut marked, None, "cd", 3);
        assert_eq!(text, "abc");
        assert_eq!(selection, 3..3);

        selection = 0..3;
        replace_plain_text(&mut text, &mut selection, &mut marked, None, "wxyz", 3);
        assert_eq!(text, "wxy");
    }

    #[test]
    fn marked_composition_replaces_its_previous_marked_text() {
        let mut text = "Hi ".to_owned();
        let mut selection = 3..3;
        let mut marked = None;

        replace_marked_text(
            &mut text,
            &mut selection,
            &mut marked,
            None,
            "k",
            None,
            usize::MAX,
        );
        assert_eq!(text, "Hi k");
        assert_eq!(marked, Some(3..4));

        replace_marked_text(
            &mut text,
            &mut selection,
            &mut marked,
            None,
            "か",
            Some(1..1),
            usize::MAX,
        );
        assert_eq!(text, "Hi か");
        assert_eq!(marked, Some(3..6));
        assert_eq!(selection, 6..6);

        replace_plain_text(&mut text, &mut selection, &mut marked, None, "", usize::MAX);
        assert_eq!(text, "Hi ");
        assert_eq!(marked, None);
    }

    #[test]
    fn prop_updates_preserve_internal_selection_unless_rn_sets_one() {
        let middle = 1..1;
        assert_eq!(
            reconcile_selection("hello", middle.clone(), None, false),
            middle
        );
        assert_eq!(reconcile_selection("hello", 4..4, Some(1..3), false), 1..3);
        assert_eq!(reconcile_selection("hello", 0..0, None, true), 5..5);
        assert_eq!(reconcile_selection("hi", 4..4, None, false), 2..2);
    }

    #[test]
    fn stale_props_do_not_replace_text_after_a_newer_native_edit() {
        assert!(!should_apply_text_update(3, 2));
        assert!(should_apply_text_update(3, 3));
        assert!(should_apply_text_update(3, 4));
    }

    #[test]
    fn clear_command_resets_text_selection_and_composition() {
        let mut text = "A😀".to_owned();
        let mut selection = 1..5;
        let mut marked = Some(1..5);
        assert!(clear_text_state(&mut text, &mut selection, &mut marked));
        assert_eq!(text, "");
        assert_eq!(selection, 0..0);
        assert_eq!(marked, None);
        assert!(!clear_text_state(&mut text, &mut selection, &mut marked));
    }

    #[test]
    fn horizontal_scroll_keeps_the_caret_inside_the_viewport() {
        assert_eq!(input_scroll_offset(0.0, 180.0, 100.0), 81.0);
        assert_eq!(input_scroll_offset(81.0, 40.0, 100.0), 40.0);
        assert_eq!(input_scroll_offset(40.0, 90.0, 100.0), 40.0);
    }
}

pub(crate) fn desktop_navigation_event(stroke: &gpui::Keystroke) -> Option<&'static str> {
    let modifiers = stroke.modifiers;
    let no_other = !modifiers.alt && !modifiers.platform && !modifiers.shift;
    let chord_enabled = if cfg!(target_os = "macos") {
        modifiers.platform && !modifiers.alt && !modifiers.control && !modifiers.shift
    } else if modifiers.alt && !modifiers.control && !modifiers.platform && !modifiers.shift {
        true
    } else {
        modifiers.control && no_other
    };
    if !chord_enabled {
        return None;
    }
    let (back, forward) = if cfg!(target_os = "macos") || modifiers.control {
        ("[", "]")
    } else {
        ("left", "right")
    };
    if stroke.key == back {
        Some("hardwareBackPress")
    } else if stroke.key == forward {
        Some("hardwareForwardPress")
    } else {
        None
    }
}

/// What a `TextInput` node holds besides what every node does.
#[derive(Clone, Debug)]
pub(crate) struct TextInputState {
    pub(crate) text: String,
    pub(crate) placeholder: String,
    pub(crate) placeholder_mode: bool,
    pub(crate) text_color: u32,
    pub(crate) selection_color: u32,
    pub(crate) multiline: bool,
    pub(crate) editable: bool,
    pub(crate) placeholder_color: u32,
    pub(crate) caret_hidden: bool,
    pub(crate) select_on_focus: bool,
    pub(crate) submit_behavior: SubmitBehavior,
    pub(crate) max_length: usize,
    pub(crate) context_menu_hidden: bool,
    /// Until when a click selects all, because it is the one that focused the input.
    pub(crate) select_all_until: Option<std::time::Instant>,
    pub(crate) secure_text: bool,
    pub(crate) selection: std::ops::Range<usize>,
    pub(crate) scroll_x: f32,
    pub(crate) scroll_y: f32,
    pub(crate) content_size: (f32, f32),
    pub(crate) selection_anchor: Option<usize>,
    pub(crate) marked: Option<std::ops::Range<usize>>,
    pub(crate) event_count: i32,
    pub(crate) caret_visible: bool,
}

impl TextInputState {
    /// What a node that is not a `TextInput` reads.
    pub(crate) const EMPTY: Self = Self {
        text: String::new(),
        placeholder: String::new(),
        placeholder_mode: true,
        text_color: 0xff000000,
        selection_color: 0,
        multiline: false,
        editable: true,
        placeholder_color: 0xff8e8e93,
        caret_hidden: false,
        select_on_focus: false,
        submit_behavior: SubmitBehavior::Default,
        max_length: usize::MAX,
        context_menu_hidden: false,
        select_all_until: None,
        secure_text: false,
        selection: 0..0,
        scroll_x: 0.0,
        scroll_y: 0.0,
        content_size: (0.0, 0.0),
        selection_anchor: None,
        marked: None,
        event_count: 0,
        caret_visible: false,
    };
}

/// `core-private:` this reads and writes `RNNodeView`'s input fields directly.
/// What Enter does, from `submitBehavior`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub(crate) enum SubmitBehavior {
    /// Not set by JS: a single-line input submits, a multiline one adds a line.
    #[default]
    Default,
    Submit,
    BlurAndSubmit,
    Newline,
}

impl SubmitBehavior {
    pub(crate) fn parse(name: &str) -> Self {
        match name {
            "submit" => Self::Submit,
            "blurAndSubmit" => Self::BlurAndSubmit,
            "newline" => Self::Newline,
            _ => Self::Default,
        }
    }

    /// Whether Enter inserts a newline for an input that is `multiline`.
    pub(crate) fn inserts_newline(self, multiline: bool) -> bool {
        match self {
            Self::Newline => multiline,
            Self::Submit | Self::BlurAndSubmit => false,
            Self::Default => multiline,
        }
    }

    /// Whether Enter blurs the input once it has submitted: a single-line
    /// input does unless `submitBehavior` is `submit`.
    pub(crate) fn blurs(self, multiline: bool) -> bool {
        match self {
            Self::BlurAndSubmit => true,
            Self::Default => !multiline,
            Self::Submit | Self::Newline => false,
        }
    }
}

/// The placeholder's colour: the one the app asked for, or the platform grey.
pub(crate) fn placeholder_color(requested: u32) -> u32 {
    if requested == 0 {
        0xff8e8e93
    } else {
        requested
    }
}

pub(crate) fn apply_update(this: &mut RNNodeView, op: &rn_gpui_sys::ffi::MountOp) {
    let next = TextInputProps::from_json(&op.extension_props_json);
    if should_apply_text_update(this.input().event_count, next.event_count)
        && next.text != this.input().text
    {
        this.input_mut().text.clone_from(&next.text);
        this.input_mut().marked = None;
    }
    this.input_mut().placeholder = next.placeholder;
    this.input_mut().selection_color = next.selection_color;
    this.input_mut().multiline = next.multiline;
    this.input_mut().editable = next.editable;
    this.input_mut().placeholder_color = placeholder_color(next.placeholder_color);
    this.input_mut().caret_hidden = next.caret_hidden;
    this.input_mut().select_on_focus = next.select_on_focus;
    this.input_mut().submit_behavior = next.submit_behavior;
    this.input_mut().max_length = next.max_length;
    this.input_mut().context_menu_hidden = next.context_menu_hidden;
    this.input_mut().selection = reconcile_selection(
        &this.input().text,
        this.input().selection.clone(),
        next.selection,
        false,
    );
}

/// `core-private:` the node stores these as its own fields, so the module both
pub(crate) struct TextInputProps {
    pub text: String,
    pub placeholder: String,
    pub selection_color: u32,
    pub multiline: bool,
    pub editable: bool,
    pub secure: bool,
    pub placeholder_color: u32,
    pub caret_hidden: bool,
    pub select_on_focus: bool,
    pub submit_behavior: SubmitBehavior,
    pub max_length: usize,
    pub context_menu_hidden: bool,
    pub event_count: i32,
    pub selection: Option<Range<usize>>,
}

impl TextInputProps {
    pub(crate) fn from_json(json: &str) -> Self {
        let value: serde_json::Value =
            serde_json::from_str(json).unwrap_or(serde_json::Value::Null);
        let string = |key: &str| {
            value
                .get(key)
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_string()
        };
        let flag = |key: &str, default: bool| {
            value
                .get(key)
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(default)
        };
        let number = |key: &str| {
            value
                .get(key)
                .and_then(serde_json::Value::as_i64)
                .unwrap_or_default()
        };
        let selection = flag("selectionSet", false).then(|| {
            number("selectionStart").max(0) as usize..number("selectionEnd").max(0) as usize
        });
        Self {
            text: string("text"),
            placeholder: string("placeholder"),
            selection_color: number("selectionColor") as u32,
            multiline: flag("multiline", false),
            editable: flag("editable", true),
            secure: flag("secure", false),
            placeholder_color: number("placeholderTextColor") as u32,
            caret_hidden: flag("caretHidden", false),
            select_on_focus: flag("selectTextOnFocus", false),
            submit_behavior: SubmitBehavior::parse(
                value
                    .get("submitBehavior")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default(),
            ),
            max_length: value
                .get("maxLength")
                .and_then(serde_json::Value::as_u64)
                .map_or(usize::MAX, |length| length as usize),
            context_menu_hidden: flag("contextMenuHidden", false),
            event_count: number("eventCount") as i32,
            selection,
        }
    }
}

#[cfg(test)]
mod submit_behavior_tests {
    use super::SubmitBehavior;

    #[test]
    fn enter_follows_the_submit_behavior_and_the_input_kind() {
        assert!(SubmitBehavior::Default.inserts_newline(true));
        assert!(!SubmitBehavior::Default.inserts_newline(false));
        assert!(!SubmitBehavior::Submit.inserts_newline(true));
        assert!(!SubmitBehavior::BlurAndSubmit.inserts_newline(true));
        assert!(SubmitBehavior::Newline.inserts_newline(true));
        assert!(!SubmitBehavior::Newline.inserts_newline(false));
        assert!(SubmitBehavior::BlurAndSubmit.blurs(true));
        assert!(SubmitBehavior::Default.blurs(false));
        assert!(!SubmitBehavior::Default.blurs(true));
        assert!(!SubmitBehavior::Submit.blurs(false));
    }

    #[test]
    fn names_from_the_props_parse() {
        assert_eq!(SubmitBehavior::parse("submit"), SubmitBehavior::Submit);
        assert_eq!(
            SubmitBehavior::parse("blurAndSubmit"),
            SubmitBehavior::BlurAndSubmit
        );
        assert_eq!(SubmitBehavior::parse("newline"), SubmitBehavior::Newline);
        assert_eq!(SubmitBehavior::parse("default"), SubmitBehavior::Default);
    }
}
