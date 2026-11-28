// core-private: these functions read `RNNodeView` state (`input_selection`,

use gpui::{div, prelude::*, px, Div, Entity, ParentElement, Stateful, Window};
use rn_gpui_sys::ffi::{ParagraphFlat, RectF};

use crate::node_view::RNNodeView;

/// How far a single-line input's text sits below the top of its content box:
/// it is centred vertically, as on iOS and Android. A multiline input starts at
/// the top.
pub(crate) fn single_line_offset(
    node: &RNNodeView,
    paragraph: &ParagraphFlat,
    viewport_height: f32,
    fallback_height: f32,
) -> f32 {
    if node.input().multiline {
        return 0.0;
    }
    let measured = crate::text::single_line_height(paragraph);
    let height = if measured > 0.0 {
        measured
    } else {
        fallback_height
    };
    ((viewport_height - height) / 2.0).max(0.0)
}

pub(crate) fn paragraph_content(
    node: &RNNodeView,
    mut element: Stateful<Div>,
    paragraph: &ParagraphFlat,
    scale: (f32, f32),
    frame: RectF,
    window: &mut Window,
) -> Stateful<Div> {
    let (scale_x, scale_y) = scale;
    let left = node.view.content_insets.left * scale_x;
    let top = node.view.content_insets.top * scale_y;
    let right = node.view.content_insets.right * scale_x;
    let bottom = node.view.content_insets.bottom * scale_y;
    let viewport_width = (frame.w * scale_x - left - right).max(0.0);
    let viewport_height = (frame.h * scale_y - top - bottom).max(0.0);
    if !node.input().multiline {
        let mut paragraph = paragraph.clone();
        paragraph.max_lines = 0;
        paragraph.ellipsize = 0;
        let line = node.input().text.split('\n').next().unwrap_or_default();
        let natural_width =
            crate::text::input_caret_x(window.text_system(), &paragraph, line, line.len());
        let text_width = viewport_width.max(natural_width + 2.0);
        let fallback = crate::builtins::textinput::input::input_line_height(node) * scale_y;
        let offset = single_line_offset(node, &paragraph, viewport_height, fallback);
        element = element.child(
            div()
                .absolute()
                .left(px(left))
                .top(px(top))
                .w(px(viewport_width))
                .h(px(viewport_height))
                .overflow_hidden()
                .child(
                    div()
                        .absolute()
                        .left(px(-node.input().scroll_x * scale_x))
                        .top(px(offset))
                        .w(px(text_width))
                        .h(px(viewport_height))
                        .child(crate::text::paragraph_element(
                            &paragraph,
                            text_width,
                            viewport_height,
                            None,
                        )),
                ),
        );
    } else {
        let content_height = viewport_height
            .max(crate::builtins::textinput::input::input_line_height(node) * scale_y)
            .max(
                node.input().text.split('\n').count() as f32
                    * crate::builtins::textinput::input::input_line_height(node)
                    * scale_y,
            );
        element = element.child(
            div()
                .absolute()
                .left(px(left))
                .top(px(top))
                .w(px(viewport_width))
                .h(px(viewport_height))
                .overflow_hidden()
                .child(
                    div()
                        .absolute()
                        .left_0()
                        .top(px(-node.input().scroll_y * scale_y))
                        .w(px(viewport_width))
                        .h(px(content_height))
                        .child(crate::text::paragraph_element(
                            paragraph,
                            viewport_width,
                            content_height,
                            None,
                        )),
                ),
        );
    }
    element
}

/// Fabric measured the text inside the padding and border, so it is laid out
/// and painted in that content box, not across the whole frame.
/// With `overlay`, the text is not a child of `element` but returned for the
/// caller to paint over it with [`crate::text::ParagraphOverlay`].
pub(crate) fn plain_paragraph(
    node: &RNNodeView,
    element: Stateful<Div>,
    paragraph: &ParagraphFlat,
    scale: (f32, f32),
    frame: RectF,
    overlay: bool,
    prepared: Option<&crate::text::PreparedParagraph>,
) -> (Stateful<Div>, Option<crate::text::ParagraphOverlayParts>) {
    let (scale_x, scale_y) = scale;
    let insets = node.view.content_insets;
    let left = insets.left * scale_x;
    let top = insets.top * scale_y;
    let width = (frame.w * scale_x - left - insets.right * scale_x).max(0.0);
    let height = (frame.h * scale_y - top - insets.bottom * scale_y).max(0.0);
    let highlights: Vec<_> =
        if crate::builtins::text_select::is_selectable(node) && !node.text_selection.is_empty() {
            let unscaled_width = (frame.w - insets.left - insets.right).max(0.0);
            let mut unscaled = paragraph.clone();
            for fragment in &mut unscaled.fragments {
                fragment.font_size /= scale_y.max(0.0001);
                fragment.line_height /= scale_y.max(0.0001);
                fragment.letter_spacing /= scale_x.max(0.0001);
            }
            crate::text::text_range_rects(&unscaled, unscaled_width, node.text_selection.clone())
        } else {
            Vec::new()
        };
    let element = element.children(highlights.into_iter().map(|(x, y, w, h)| {
        div()
            .absolute()
            .left(px(left + x * scale_x))
            .top(px(top + y * scale_y))
            .w(px(w * scale_x))
            .h(px(h * scale_y))
            .bg(gpui::rgba(0x3875d788))
    }));
    if overlay {
        let painter = crate::text::ParagraphPainter::new(paragraph, width, height, prepared);
        let parts = (
            painter,
            gpui::point(px(left), px(top)),
            gpui::size(px(width), px(height)),
        );
        return (element, Some(parts));
    }
    (
        element.child(
            crate::text::paragraph_element(paragraph, width, height, prepared)
                .absolute()
                .left(px(left))
                .top(px(top)),
        ),
        None,
    )
}

pub(crate) fn caret_canvas(
    node: &RNNodeView,
    element: Stateful<Div>,
    input: Entity<RNNodeView>,
    scale: (f32, f32),
) -> Stateful<Div> {
    if node.input().caret_hidden || !node.input().editable {
        return element;
    }
    let (scale_x, scale_y) = scale;
    let focus = node.focus_handle.clone();
    let caret_text = node.input().text.clone();
    let caret_offset = node.input().selection.end.min(node.input().text.len());
    let mut caret_paragraph = node.paragraph.clone().unwrap_or_default();
    for fragment in &mut caret_paragraph.fragments {
        fragment.font_size *= scale_y;
        fragment.letter_spacing *= scale_x;
    }
    let input_selection = node.input().selection.clone();
    let content_insets = node.view.content_insets;
    let input_text_color = node.input().text_color;
    let input_selection_color = node.input().selection_color;
    let input_multiline = node.input().multiline;
    let input_scroll_x = node.input().scroll_x * scale_x;
    let input_scroll_y = node.input().scroll_y * scale_y;
    let caret_visible = node.input().caret_visible;
    let single_line_paragraph = caret_paragraph.clone();
    let multiline_input = node.input().multiline;
    let fallback_line = crate::builtins::textinput::input::input_line_height(node) * scale_y;
    let caret_height = node
        .paragraph
        .as_ref()
        .and_then(|paragraph| paragraph.fragments.first())
        .map(|fragment| {
            if fragment.line_height > 0.0 {
                fragment.line_height * scale_y
            } else {
                fragment.font_size.max(14.0) * scale_y * 1.2
            }
        })
        .unwrap_or(17.0 * scale_y);
    element.child(
        div().absolute().top_0().left_0().size_full().child(
            gpui::canvas(
                |_bounds, _window, _cx| (),
                move |bounds, _state, window, cx| {
                    let content_box = gpui::Bounds {
                        origin: bounds.origin
                            + gpui::point(
                                px(content_insets.left * scale_x),
                                px(content_insets.top * scale_y),
                            ),
                        size: gpui::size(
                            (bounds.size.width
                                - px((content_insets.left + content_insets.right) * scale_x))
                            .max(px(0.0)),
                            (bounds.size.height
                                - px((content_insets.top + content_insets.bottom) * scale_y))
                            .max(px(0.0)),
                        ),
                    };
                    let vertical = if multiline_input {
                        0.0
                    } else {
                        let measured = crate::text::single_line_height(&single_line_paragraph);
                        let height = if measured > 0.0 {
                            measured
                        } else {
                            fallback_line
                        };
                        ((f32::from(content_box.size.height) - height) / 2.0).max(0.0)
                    };
                    window.with_content_mask(
                        Some(gpui::ContentMask {
                            bounds: content_box,
                        }),
                        |window| {
                            if focus.as_ref().is_some_and(|f| f.is_focused(window)) {
                                if !input_selection.is_empty() {
                                    let start = input_selection.start.min(caret_text.len());
                                    let end = input_selection.end.min(caret_text.len());
                                    let content_width = (f32::from(bounds.size.width)
                                        - (content_insets.left + content_insets.right) * scale_x)
                                        .max(0.0);
                                    let mut line_start = 0;
                                    for (line_number, raw_line) in
                                        caret_text.split_inclusive('\n').enumerate()
                                    {
                                        let line = raw_line.trim_end_matches('\n');
                                        let line_end = line_start + line.len();
                                        let selected_start = start.max(line_start).min(line_end);
                                        let selected_end = end.min(line_end).max(selected_start);
                                        let includes_newline = end > line_end
                                            && start <= line_end
                                            && raw_line.ends_with('\n');
                                        if selected_end > selected_start || includes_newline {
                                            let prefix = &line[..selected_start - line_start];
                                            let through_selection =
                                                &line[..selected_end - line_start];
                                            let mut x0 = crate::text::input_caret_x(
                                                window.text_system(),
                                                &caret_paragraph,
                                                prefix,
                                                prefix.len(),
                                            );
                                            let mut x1 = crate::text::input_caret_x(
                                                window.text_system(),
                                                &caret_paragraph,
                                                through_selection,
                                                through_selection.len(),
                                            );
                                            if !input_multiline {
                                                x0 -= input_scroll_x;
                                                x1 -= input_scroll_x;
                                                x0 = x0.clamp(0.0, content_width);
                                                x1 = x1.clamp(0.0, content_width);
                                            }
                                            let width = if includes_newline {
                                                (content_width - x0).max(1.0)
                                            } else {
                                                (x1 - x0).max(1.0)
                                            };
                                            let selection = gpui::Bounds {
                                                origin: gpui::point(
                                                    bounds.origin.x
                                                        + px(content_insets.left * scale_x + x0),
                                                    bounds.origin.y
                                                        + px(content_insets.top * scale_y
                                                            + vertical
                                                            + line_number as f32 * caret_height
                                                            - input_scroll_y),
                                                ),
                                                size: gpui::size(px(width), px(caret_height)),
                                            };
                                            window.paint_quad(gpui::fill(
                                                selection,
                                                gpui::rgba(0x3875d788),
                                            ));
                                        }
                                        line_start += raw_line.len();
                                    }
                                }
                                if caret_visible {
                                    let offset = caret_offset.min(caret_text.len());
                                    let safe_offset = (0..=offset)
                                        .rev()
                                        .find(|index| caret_text.is_char_boundary(*index))
                                        .unwrap_or(0);
                                    let prefix = &caret_text[..safe_offset];
                                    let line = prefix.rsplit('\n').next().unwrap_or(prefix);
                                    let line_number =
                                        prefix.bytes().filter(|byte| *byte == b'\n').count();
                                    let x = crate::text::input_caret_x(
                                        window.text_system(),
                                        &caret_paragraph,
                                        line,
                                        line.len(),
                                    );
                                    let mut x = x - input_scroll_x;
                                    let content_width = (f32::from(bounds.size.width)
                                        - (content_insets.left + content_insets.right) * scale_x)
                                        .max(0.0);
                                    if !input_multiline {
                                        x = x.clamp(
                                            0.0,
                                            (content_width - scale_x.max(1.0)).max(0.0),
                                        );
                                    }
                                    let x = bounds.origin.x + px(content_insets.left * scale_x + x);
                                    let y = bounds.origin.y
                                        + px(content_insets.top * scale_y
                                            + vertical
                                            + line_number as f32 * caret_height
                                            - input_scroll_y);
                                    let caret = gpui::Bounds {
                                        origin: gpui::point(x, y),
                                        size: gpui::size(px(scale_x.max(1.0)), px(caret_height)),
                                    };
                                    let caret_color = if input_selection_color == 0 {
                                        input_text_color
                                    } else {
                                        input_selection_color
                                    };
                                    window.paint_quad(gpui::fill(
                                        caret,
                                        crate::style::color(caret_color),
                                    ));
                                }
                            }
                        },
                    );
                    if let Some(focus) = focus.as_ref() {
                        window.handle_input(
                            focus,
                            gpui::ElementInputHandler::new(bounds, input.clone()),
                            cx,
                        );
                    }
                },
            )
            .size_full(),
        ),
    )
}
