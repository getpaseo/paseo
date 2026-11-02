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
    if !this.input_editable {
        return false;
    }
    match key {
        "backspace" | "delete" => {
            let mut range = selected_range(this);
            if range.is_empty() {
                if key == "backspace" {
                    range.start = this.input_text[..range.start]
                        .char_indices()
                        .next_back()
                        .map(|(index, _)| index)
                        .unwrap_or(0);
                } else if range.end < this.input_text.len() {
                    range.end += this.input_text[range.end..]
                        .chars()
                        .next()
                        .map(char::len_utf8)
                        .unwrap_or(0);
                }
            }
            if !range.is_empty() {
                this.input_text.replace_range(range.clone(), "");
                this.input_selection = range.start..range.start;
                this.input_selection_anchor = None;
                this.input_marked = None;
                this.sync_input_paragraph();
                emit_change(this, window, cx);
            }
            true
        }
        "enter" => {
            if this.input_multiline {
                replace_plain_text(
                    &mut this.input_text,
                    &mut this.input_selection,
                    &mut this.input_marked,
                    None,
                    "\n",
                );
                this.sync_input_paragraph();
                emit_change(this, window, cx);
            } else if let Some(store) = store_from(cx) {
                store.read(cx).host.dispatch_event(
                    this.tag,
                    "topSubmitEditing",
                    &serde_json::json!({
                        "text": this.input_text, "eventCount": this.input_event_count,
                    }),
                );
            }
            true
        }
        "left" | "right" | "home" | "end" => {
            let text = this.input_text.as_str();
            let selection = selected_range(this);
            let (anchor, focus) = if extend_selection {
                let anchor = *this.input_selection_anchor.get_or_insert(selection.start);
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
                this.input_selection_anchor = None;
                let cursor = if key == "left" || key == "home" {
                    selection.start
                } else {
                    selection.end
                };
                (cursor, cursor)
            } else {
                this.input_selection_anchor = None;
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
            this.input_selection = anchor.min(focus)..anchor.max(focus);
            this.input_marked = None;
            emit_selection(this, window, cx);
            true
        }
        _ => false,
    }
}

pub(crate) fn select_at_point(
    this: &mut RNNodeView,
    point: Point<Pixels>,
    extend: bool,
    window: &mut Window,
    cx: &mut Context<RNNodeView>,
) {
    if this.component != "TextInput" || !this.input_editable {
        return;
    }
    let index = this
        .character_index_for_point(point, window, cx)
        .map(|index| byte_at_utf16(&this.input_text, index))
        .unwrap_or(this.input_text.len());
    let anchor = if extend {
        this.input_selection_anchor
            .unwrap_or(this.input_selection.start)
    } else {
        index
    };
    this.input_selection_anchor = Some(anchor);
    this.input_selection = anchor.min(index)..anchor.max(index);
    emit_selection(this, window, cx);
}

pub(crate) fn select_all(this: &mut RNNodeView, window: &mut Window, cx: &mut Context<RNNodeView>) {
    if this.component != "TextInput" || !this.input_editable {
        return;
    }
    this.input_selection = 0..this.input_text.len();
    this.input_selection_anchor = None;
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
    let text = this.input_text[range].to_string();
    cx.write_to_clipboard(gpui::ClipboardItem::new_string(text));
    true
}

pub(crate) fn cut_selection(
    this: &mut RNNodeView,
    window: &mut Window,
    cx: &mut Context<RNNodeView>,
) -> bool {
    if !this.input_editable || !copy_selection(this, cx) {
        return false;
    }
    let range = selected_range(this);
    this.input_text.replace_range(range.clone(), "");
    this.input_selection = range.start..range.start;
    this.input_selection_anchor = None;
    this.input_marked = None;
    this.sync_input_paragraph();
    emit_change(this, window, cx);
    true
}

pub(crate) fn paste_clipboard(
    this: &mut RNNodeView,
    window: &mut Window,
    cx: &mut Context<RNNodeView>,
) -> bool {
    if !this.input_editable {
        return false;
    }
    let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) else {
        return false;
    };
    if text.is_empty() {
        return false;
    }
    replace_plain_text(
        &mut this.input_text,
        &mut this.input_selection,
        &mut this.input_marked,
        None,
        &text,
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
    this.input_selection.start.min(this.input_text.len())
        ..this.input_selection.end.min(this.input_text.len())
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

fn replace_plain_text(
    text: &mut String,
    selection: &mut Range<usize>,
    marked: &mut Option<Range<usize>>,
    range_utf16: Option<Range<usize>>,
    inserted: &str,
) {
    let range = replacement_range(text, selection, marked, range_utf16);
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
) {
    let range = replacement_range(text, selection, marked, range_utf16);
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
    this.input_event_count += 1;
    this.input_selection_anchor = None;
    keep_caret_visible(this, window);
    let text = this.input_text.clone();
    let selection = utf16_range(&text, selected_range(this));
    if let Some(store) = store_from(cx) {
        let host = store.read(cx).host.clone();
        host.dispatch_event(
            this.tag,
            "topChange",
            &serde_json::json!({
                "text": text,
                "eventCount": this.input_event_count,
            }),
        );
        host.dispatch_event(
            this.tag,
            "topSelectionChange",
            &serde_json::json!({"selection": {"start": selection.start, "end": selection.end}}),
        );
        store.read(cx).frame_hook.arm(window);
    }
    this.reset_text_input_caret(cx);
    cx.notify();
}

fn emit_selection(this: &mut RNNodeView, window: &mut Window, cx: &mut Context<RNNodeView>) {
    keep_caret_visible(this, window);
    let selection = utf16_range(&this.input_text, selected_range(this));
    if let Some(store) = store_from(cx) {
        let host = store.read(cx).host.clone();
        host.dispatch_event(
            this.tag,
            "topSelectionChange",
            &serde_json::json!({"selection": {"start": selection.start, "end": selection.end}}),
        );
        store.read(cx).frame_hook.arm(window);
    }
    this.reset_text_input_caret(cx);
    cx.notify();
}

pub(crate) fn keep_caret_visible(this: &mut RNNodeView, window: &mut Window) {
    if this.input_multiline {
        this.input_scroll_x = 0.0;
        return;
    }
    let Some(paragraph) = this.paragraph.as_ref() else {
        this.input_scroll_x = 0.0;
        return;
    };
    if paragraph.fragments.is_empty() {
        this.input_scroll_x = 0.0;
        return;
    }
    let end = this.input_selection.end.min(this.input_text.len());
    let line_start = this.input_text[..end]
        .rfind('\n')
        .map_or(0, |index| index + 1);
    let line = &this.input_text[line_start..end];
    let caret_x = crate::text::input_caret_x(window.text_system(), paragraph, line, line.len());
    let viewport =
        (this.frame.w - this.view.content_insets.left - this.view.content_insets.right).max(0.0);
    this.input_scroll_x = input_scroll_offset(this.input_scroll_x, caret_x, viewport);
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
        || !clear_text_state(
            &mut this.input_text,
            &mut this.input_selection,
            &mut this.input_marked,
        )
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
        let range = byte_range(&self.input_text, range_utf16);
        *actual_range = Some(utf16_range(&self.input_text, range.clone()));
        Some(self.input_text[range].to_owned())
    }

    fn selected_text_range(
        &mut self,
        _ignore_disabled_input: bool,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: utf16_range(&self.input_text, selected_range(self)),
            reversed: false,
        })
    }

    fn marked_text_range(
        &self,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Range<usize>> {
        self.input_marked
            .as_ref()
            .map(|range| utf16_range(&self.input_text, range.clone()))
    }

    fn unmark_text(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        self.input_marked = None;
        cx.notify();
    }

    fn replace_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        text: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.input_editable {
            return;
        }
        if !self.input_multiline && (text.contains('\n') || text.contains('\r')) {
            if let Some(store) = store_from(cx) {
                let host = store.read(cx).host.clone();
                host.dispatch_event(
                    self.tag,
                    "topSubmitEditing",
                    &serde_json::json!({
                        "text": self.input_text,
                        "eventCount": self.input_event_count,
                    }),
                );
            }
            return;
        }
        replace_plain_text(
            &mut self.input_text,
            &mut self.input_selection,
            &mut self.input_marked,
            range_utf16,
            text,
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
        if !self.input_editable {
            return;
        }
        replace_marked_text(
            &mut self.input_text,
            &mut self.input_selection,
            &mut self.input_marked,
            range_utf16,
            new_text,
            new_selected_range_utf16,
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
        let local_x = if self.input_multiline {
            local_x
        } else {
            local_x + self.input_scroll_x
        };
        let local_y = (f32::from(point.y - origin.y) / scale_y.max(0.0001)
            - self.view.content_insets.top)
            .max(0.0);
        let target_line = if self.input_multiline {
            (local_y / line_height.max(1.0)).floor() as usize
        } else {
            0
        };
        let mut byte_start = 0;
        let mut line_text = self.input_text.as_str();
        if self.input_multiline {
            for (index, line) in self.input_text.split_inclusive('\n').enumerate() {
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
        Some(utf16_at_byte(&self.input_text, byte_start + byte_in_line))
    }

    fn set_selected_text_range(
        &mut self,
        range_utf16: Range<usize>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.input_selection = byte_range(&self.input_text, range_utf16);
        self.input_selection_anchor = None;
        emit_selection(self, _window, cx);
    }

    fn text_length_utf16(
        &mut self,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<usize> {
        Some(self.input_text.encode_utf16().count())
    }

    fn accepts_text_input(&self, _window: &mut Window, _cx: &mut Context<Self>) -> bool {
        self.input_editable
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

        replace_plain_text(&mut text, &mut selection, &mut marked, Some(1..3), "é");

        assert_eq!(text, "AéZ");
        assert_eq!(selection, 3..3);
        assert_eq!(marked, None);
    }

    #[test]
    fn marked_composition_replaces_its_previous_marked_text() {
        let mut text = "Hi ".to_owned();
        let mut selection = 3..3;
        let mut marked = None;

        replace_marked_text(&mut text, &mut selection, &mut marked, None, "k", None);
        assert_eq!(text, "Hi k");
        assert_eq!(marked, Some(3..4));

        replace_marked_text(
            &mut text,
            &mut selection,
            &mut marked,
            None,
            "か",
            Some(1..1),
        );
        assert_eq!(text, "Hi か");
        assert_eq!(marked, Some(3..6));
        assert_eq!(selection, 6..6);

        replace_plain_text(&mut text, &mut selection, &mut marked, None, "");
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

/// `core-private:` this reads and writes `RNNodeView`'s input fields directly.
pub(crate) fn apply_update(this: &mut RNNodeView, op: &rn_gpui_sys::ffi::MountOp) {
    let next = TextInputProps::from_json(&op.extension_props_json);
    if should_apply_text_update(this.input_event_count, next.event_count)
        && next.text != this.input_text
    {
        this.input_text.clone_from(&next.text);
        this.input_marked = None;
    }
    this.input_placeholder = next.placeholder;
    this.input_selection_color = next.selection_color;
    this.input_multiline = next.multiline;
    this.input_editable = next.editable;
    this.input_selection = reconcile_selection(
        &this.input_text,
        this.input_selection.clone(),
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
            event_count: number("eventCount") as i32,
            selection,
        }
    }
}
