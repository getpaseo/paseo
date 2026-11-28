use crate::layout::{BulletKind, LaidOutDocument, LaidOutItem};
use crate::model::hs_color;
use gpui::{
    div, img, px, AnyElement, CursorStyle, InteractiveElement, IntoElement, ObjectFit,
    ParentElement, SharedUri, StatefulInteractiveElement, Styled, StyledImage,
};
use react_native_gpui::host_component::{
    rich_text_element, RichParagraph, RichTextAlign, RichTextRun,
};

pub fn render_document(doc: &LaidOutDocument, node_tag: i32) -> AnyElement {
    let mut root = div()
        .relative()
        .w(px(doc.width.max(0.0)))
        .h(px(doc.height.max(0.0)));

    for (idx, item) in doc.items.iter().enumerate() {
        let element =
            match item {
                LaidOutItem::Paragraph(para) => div()
                    .absolute()
                    .left(px(para.x))
                    .top(px(para.y))
                    .w(px(para.width.max(0.0)))
                    .h(px(para.height.max(0.0)))
                    .child(rich_text_element(
                        &para.paragraph,
                        para.width.max(0.0),
                        para.height.max(0.0),
                    ))
                    .into_any_element(),
                LaidOutItem::Bullet {
                    x,
                    y,
                    width,
                    line_height,
                    kind,
                } => render_bullet(*x, *y, *width, *line_height, kind),
                LaidOutItem::Rect {
                    x,
                    y,
                    width,
                    height,
                    bg_color,
                    border_color,
                    border_width,
                    border_radius,
                } => {
                    let mut box_div = div()
                        .absolute()
                        .left(px(*x))
                        .top(px(*y))
                        .w(px(width.max(0.0)))
                        .h(px(height.max(0.0)));
                    if *bg_color >> 24 != 0 {
                        box_div = box_div.bg(hs_color(*bg_color));
                    }
                    if *border_width > 0.0 && *border_color >> 24 != 0 {
                        box_div = box_div
                            .border(px(*border_width))
                            .border_color(hs_color(*border_color));
                    }
                    if *border_radius > 0.0 {
                        box_div = box_div.rounded(px(*border_radius));
                    }
                    box_div.into_any_element()
                }
                LaidOutItem::CodeBlock(cb) => {
                    let mut card = div()
                        .absolute()
                        .left(px(cb.x))
                        .top(px(cb.y))
                        .w(px(cb.width.max(0.0)))
                        .h(px(cb.height.max(0.0)))
                        .overflow_hidden()
                        .bg(hs_color(cb.bg_color))
                        .rounded(px(cb.border_radius))
                        .p(px(cb.padding));
                    if cb.border_width > 0.0 && cb.border_color >> 24 != 0 {
                        card = card
                            .border(px(cb.border_width))
                            .border_color(hs_color(cb.border_color));
                    }

                    let inner_w = (cb.width - cb.padding * 2.0 - cb.border_width * 2.0).max(1.0);
                    let mut inner = div().flex().flex_col().w(px(inner_w));
                    if cb.header_height > 0.0 {
                        let header_para = RichParagraph {
                            runs: vec![RichTextRun {
                                text: cb.language.clone(),
                                size: 11.0,
                                weight: 600,
                                color: cb.header_text_color,
                                line_height: cb.header_height - 4.0,
                                ..Default::default()
                            }],
                            text_align: RichTextAlign::Left,
                            max_lines: 1,
                        };
                        inner = inner.child(div().h(px(cb.header_height)).child(
                            rich_text_element(&header_para, inner_w, cb.header_height - 4.0),
                        ));
                    }

                    let code_w = cb.content_width.max(inner_w);
                    let code_canvas =
                        rich_text_element(&cb.paragraph, code_w, cb.content_height.max(1.0));
                    if cb.content_width > inner_w + 1.0 {
                        inner = inner.child(
                            div()
                                .id(("md-code-scroll", ((node_tag as u64) << 24) | idx as u64))
                                .w(px(inner_w))
                                .h(px(cb.content_height.max(1.0)))
                                .overflow_x_scroll()
                                .overflow_y_hidden()
                                .child(
                                    div()
                                        .w(px(code_w))
                                        .h(px(cb.content_height.max(1.0)))
                                        .child(code_canvas),
                                ),
                        );
                    } else {
                        inner = inner.child(code_canvas);
                    }

                    card.child(inner).into_any_element()
                }
                LaidOutItem::Table(table) => {
                    let mut content = div()
                        .relative()
                        .w(px(table.content_width.max(table.width)))
                        .h(px(table.height.max(0.0)));
                    let border_c = hs_color(table.border_color);
                    for cell in &table.cells {
                        let mut cell_div = div()
                            .absolute()
                            .left(px(cell.x - table.x))
                            .top(px(cell.y - table.y))
                            .w(px(cell.width.max(0.0)))
                            .h(px(cell.height.max(0.0)))
                            .bg(hs_color(cell.bg_color))
                            .border_color(border_c)
                            .border(px((table.border_width * 0.5).max(0.5)))
                            .px(px(cell.pad_x))
                            .py(px(cell.pad_y));
                        cell_div = cell_div.child(rich_text_element(
                            &cell.paragraph,
                            cell.text_width.max(1.0),
                            cell.text_height.max(1.0),
                        ));
                        content = content.child(cell_div);
                    }

                    let mut outer = div()
                        .absolute()
                        .left(px(table.x))
                        .top(px(table.y))
                        .w(px(table.width.max(0.0)))
                        .h(px(table.height.max(0.0)))
                        .overflow_hidden()
                        .rounded(px(table.border_radius))
                        .border(px(table.border_width))
                        .border_color(border_c);

                    if table.content_width > table.width + 1.0 {
                        outer = outer.child(
                            div()
                                .id(("md-table-scroll", ((node_tag as u64) << 24) | idx as u64))
                                .w(px(table.width.max(0.0)))
                                .h(px(table.height.max(0.0)))
                                .overflow_x_scroll()
                                .overflow_y_hidden()
                                .child(content),
                        );
                    } else {
                        outer = outer.child(content);
                    }
                    outer.into_any_element()
                }
                LaidOutItem::Image {
                    x,
                    y,
                    width,
                    height,
                    url,
                    alt_text,
                    border_radius,
                } => {
                    let mut frame = div()
                        .absolute()
                        .left(px(*x))
                        .top(px(*y))
                        .w(px(width.max(0.0)))
                        .h(px(height.max(0.0)))
                        .overflow_hidden()
                        .bg(hs_color(0xFFF1_F5F9));
                    if *border_radius > 0.0 {
                        frame = frame.rounded(px(*border_radius));
                    }
                    if url.starts_with("http://") || url.starts_with("https://") {
                        frame = frame.child(
                            img(SharedUri::from(url.clone()))
                                .w(px(width.max(0.0)))
                                .h(px(height.max(0.0)))
                                .object_fit(ObjectFit::Contain),
                        );
                    } else if !alt_text.is_empty() {
                        let alt_para = RichParagraph {
                            runs: vec![RichTextRun {
                                text: alt_text.clone(),
                                size: 13.0,
                                color: 0xFF64_748B,
                                ..Default::default()
                            }],
                            text_align: RichTextAlign::Center,
                            max_lines: 2,
                        };
                        frame = frame.p(px(8.0)).child(rich_text_element(
                            &alt_para,
                            (width - 16.0).max(1.0),
                            32.0,
                        ));
                    }
                    frame.into_any_element()
                }
            };
        root = root.child(element);
    }

    // Add invisible cursor hotspots over link rects so hovering a link shows a pointer cursor.
    for link in &doc.links {
        root = root.child(
            div()
                .absolute()
                .left(px(link.x))
                .top(px(link.y))
                .w(px(link.width.max(1.0)))
                .h(px(link.height.max(1.0)))
                .cursor(CursorStyle::PointingHand),
        );
    }

    root.into_any_element()
}

fn render_bullet(x: f32, y: f32, width: f32, line_height: f32, kind: &BulletKind) -> AnyElement {
    match kind {
        BulletKind::Disc { depth, color, size } => {
            let dot_size = size.clamp(4.0, 10.0);
            let left = x + ((width - dot_size) * 0.5).max(0.0);
            let top = y + ((line_height - dot_size) * 0.5).max(0.0);
            let mut dot = div()
                .absolute()
                .left(px(left))
                .top(px(top))
                .w(px(dot_size))
                .h(px(dot_size));
            let c = hs_color(*color);
            dot = match depth % 3 {
                0 => dot.rounded_full().bg(c),
                1 => dot.rounded_full().border_1().border_color(c),
                _ => dot.bg(c),
            };
            dot.into_any_element()
        }
        BulletKind::Number {
            label,
            color,
            size,
            weight,
            family,
            line_height: lh,
        } => {
            let para = RichParagraph {
                runs: vec![RichTextRun {
                    text: label.clone(),
                    family: family.clone(),
                    size: *size,
                    weight: *weight,
                    color: *color,
                    line_height: *lh,
                    ..Default::default()
                }],
                text_align: RichTextAlign::Left,
                max_lines: 1,
            };
            div()
                .absolute()
                .left(px(x))
                .top(px(y))
                .w(px(width.max(1.0)))
                .h(px(line_height.max(1.0)))
                .child(rich_text_element(
                    &para,
                    width.max(1.0),
                    line_height.max(1.0),
                ))
                .into_any_element()
        }
        BulletKind::Checkbox {
            checked,
            checked_color,
            border_color,
            checkmark_color,
            size,
            radius,
        } => {
            let box_top = y + ((line_height - size) * 0.5).max(0.0);
            let mut cb = div()
                .absolute()
                .left(px(x))
                .top(px(box_top))
                .w(px(*size))
                .h(px(*size))
                .rounded(px(*radius))
                .flex()
                .items_center()
                .justify_center();
            if *checked {
                let mark = RichParagraph {
                    runs: vec![RichTextRun {
                        text: "✓".to_string(),
                        size: (size * 0.72).max(10.0),
                        weight: 700,
                        color: *checkmark_color,
                        line_height: *size,
                        ..Default::default()
                    }],
                    text_align: RichTextAlign::Center,
                    max_lines: 1,
                };
                cb = cb
                    .bg(hs_color(*checked_color))
                    .child(rich_text_element(&mark, *size, *size));
            } else {
                cb = cb.border(px(1.5)).border_color(hs_color(*border_color));
            }
            cb.into_any_element()
        }
    }
}
