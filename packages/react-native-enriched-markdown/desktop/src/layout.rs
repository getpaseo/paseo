use crate::model::{
    argb_or, normalize_font_family, parse_font_weight, text_align_of, AstNode, BlockStyle,
    LinkVariantStyle, MarkdownSnapshot, MarkdownStyle,
};
use react_native_gpui::host_component::{
    measure_rich_text, measure_text, rich_text_range_rects, RichParagraph, RichTextAlign,
    RichTextRun, TextStyle,
};
use std::ops::Range;

#[derive(Clone, Debug)]
pub struct LinkSpan {
    pub byte_range: Range<usize>,
    pub url: String,
    pub source_type: String,
}

#[derive(Clone, Debug)]
pub struct InteractiveLinkRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub url: String,
    pub source_type: String,
}

#[derive(Clone, Debug)]
pub struct InteractiveTaskRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub index: i32,
    pub checked: bool,
    pub text: String,
}

#[derive(Clone, Debug)]
pub struct InteractiveCopyRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub code: String,
    pub language: String,
}

#[derive(Clone, Debug)]
pub struct InteractiveImageRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub url: String,
    pub alt_text: String,
}

#[derive(Clone, Debug)]
pub enum BulletKind {
    Disc {
        depth: usize,
        color: u32,
        size: f32,
    },
    Number {
        label: String,
        color: u32,
        size: f32,
        weight: u16,
        family: String,
        line_height: f32,
    },
    Checkbox {
        checked: bool,
        checked_color: u32,
        border_color: u32,
        checkmark_color: u32,
        size: f32,
        radius: f32,
    },
}

#[allow(dead_code)]
#[derive(Clone, Debug)]
pub struct LaidOutParagraph {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub paragraph: RichParagraph,
    pub plain_text: String,
    pub links: Vec<LinkSpan>,
}

#[allow(dead_code)]
#[derive(Clone, Debug)]
pub struct LaidOutCodeBlock {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub content_width: f32,
    pub content_height: f32,
    pub inset: f32,
    pub header_height: f32,
    pub header_font_size: f32,
    pub language: String,
    pub display_language: String,
    pub code: String,
    pub paragraph: RichParagraph,
    pub bg_color: u32,
    pub border_color: u32,
    pub border_width: f32,
    pub border_radius: f32,
    pub header_text_color: u32,
    pub divider_color: u32,
}

#[derive(Clone, Debug)]
pub struct LaidOutTableCell {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub pad_x: f32,
    pub pad_y: f32,
    pub bg_color: u32,
    pub paragraph: RichParagraph,
    pub text_width: f32,
    pub text_height: f32,
}

#[derive(Clone, Debug)]
pub struct LaidOutTable {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub content_width: f32,
    pub border_color: u32,
    pub border_width: f32,
    pub border_radius: f32,
    pub cells: Vec<LaidOutTableCell>,
}

#[derive(Clone, Debug)]
pub enum LaidOutItem {
    Paragraph(LaidOutParagraph),
    Bullet {
        x: f32,
        y: f32,
        width: f32,
        line_height: f32,
        kind: BulletKind,
    },
    Rect {
        x: f32,
        y: f32,
        width: f32,
        height: f32,
        bg_color: u32,
        border_color: u32,
        border_width: f32,
        border_radius: f32,
    },
    CodeBlock(LaidOutCodeBlock),
    Table(LaidOutTable),
    Image {
        x: f32,
        y: f32,
        width: f32,
        height: f32,
        url: String,
        alt_text: String,
        border_radius: f32,
    },
}

#[derive(Clone, Debug, Default)]
pub struct LaidOutDocument {
    pub width: f32,
    pub height: f32,
    pub items: Vec<LaidOutItem>,
    pub links: Vec<InteractiveLinkRect>,
    pub task_toggles: Vec<InteractiveTaskRect>,
    pub code_copies: Vec<InteractiveCopyRect>,
    pub images: Vec<InteractiveImageRect>,
}

#[derive(Clone, Debug)]
struct InlineCtx {
    family: String,
    size: f32,
    weight: u16,
    italic: bool,
    color: u32,
    background_color: u32,
    line_height: f32,
    underline: bool,
    strikethrough: bool,
    link_url: Option<String>,
    link_source_type: Option<String>,
}

impl InlineCtx {
    fn from_block(
        block: &BlockStyle,
        default_size: f32,
        default_weight: u16,
        fallback_color: u32,
    ) -> Self {
        let size = if block.font_size > 0.0 {
            block.font_size
        } else {
            default_size
        };
        let line_height = if block.line_height > 0.0 {
            block.line_height
        } else {
            0.0
        };
        let weight = if block.font_weight.is_empty() {
            default_weight
        } else {
            parse_font_weight(&block.font_weight)
        };
        Self {
            family: normalize_font_family(&block.font_family),
            size,
            weight,
            italic: false,
            color: argb_or(block.color, fallback_color),
            background_color: 0,
            line_height,
            underline: false,
            strikethrough: false,
            link_url: None,
            link_source_type: None,
        }
    }
}

struct InlineBuilder<'a> {
    style: &'a MarkdownStyle,
    runs: Vec<RichTextRun>,
    links: Vec<LinkSpan>,
    plain_text: String,
}

impl<'a> InlineBuilder<'a> {
    fn new(style: &'a MarkdownStyle) -> Self {
        Self {
            style,
            runs: Vec::new(),
            links: Vec::new(),
            plain_text: String::new(),
        }
    }

    fn push_text(&mut self, text: &str, ctx: &InlineCtx) {
        if text.is_empty() {
            return;
        }
        let start = self.plain_text.len();
        self.plain_text.push_str(text);
        let end = self.plain_text.len();

        if let (Some(url), Some(src)) = (&ctx.link_url, &ctx.link_source_type) {
            if let Some(last) = self.links.last_mut() {
                if last.byte_range.end == start && last.url == *url && last.source_type == *src {
                    last.byte_range.end = end;
                } else {
                    self.links.push(LinkSpan {
                        byte_range: start..end,
                        url: url.clone(),
                        source_type: src.clone(),
                    });
                }
            } else {
                self.links.push(LinkSpan {
                    byte_range: start..end,
                    url: url.clone(),
                    source_type: src.clone(),
                });
            }
        }

        if let Some(last) = self.runs.last_mut() {
            if last.family == ctx.family
                && (last.size - ctx.size).abs() < f32::EPSILON
                && last.weight == ctx.weight
                && last.italic == ctx.italic
                && last.color == ctx.color
                && last.background_color == ctx.background_color
                && (last.line_height - ctx.line_height).abs() < f32::EPSILON
                && last.underline == ctx.underline
                && last.strikethrough == ctx.strikethrough
            {
                last.text.push_str(text);
                return;
            }
        }

        self.runs.push(RichTextRun {
            text: text.to_string(),
            family: ctx.family.clone(),
            size: ctx.size,
            weight: ctx.weight,
            italic: ctx.italic,
            color: ctx.color,
            background_color: ctx.background_color,
            line_height: ctx.line_height,
            letter_spacing: 0.0,
            underline: ctx.underline,
            strikethrough: ctx.strikethrough,
        });
    }

    fn walk(&mut self, node: &AstNode, ctx: &InlineCtx) {
        match node.node_type.as_str() {
            "Text" => {
                if let Some(content) = &node.content {
                    self.push_text(content, ctx);
                }
            }
            "SoftBreak" => {
                self.push_text(" ", ctx);
            }
            "LineBreak" => {
                self.push_text("\n", ctx);
            }
            "Strong" => {
                let mut next = ctx.clone();
                if !self.style.strong.font_family.is_empty() {
                    next.family = normalize_font_family(&self.style.strong.font_family);
                }
                next.weight = if self.style.strong.font_weight.is_empty() {
                    700
                } else {
                    parse_font_weight(&self.style.strong.font_weight)
                };
                if self.style.strong.color >> 24 != 0 {
                    next.color = self.style.strong.color;
                }
                for child in node.children_slice() {
                    self.walk(child, &next);
                }
            }
            "Emphasis" => {
                let mut next = ctx.clone();
                if !self.style.em.font_family.is_empty() {
                    next.family = normalize_font_family(&self.style.em.font_family);
                }
                next.italic = self.style.em.font_style.is_empty()
                    || self.style.em.font_style.eq_ignore_ascii_case("italic");
                if self.style.em.color >> 24 != 0 {
                    next.color = self.style.em.color;
                }
                for child in node.children_slice() {
                    self.walk(child, &next);
                }
            }
            "Strikethrough" => {
                let mut next = ctx.clone();
                next.strikethrough = true;
                if self.style.strikethrough.color >> 24 != 0 {
                    next.color = self.style.strikethrough.color;
                }
                for child in node.children_slice() {
                    self.walk(child, &next);
                }
            }
            "Underline" => {
                let mut next = ctx.clone();
                next.underline = true;
                if self.style.underline.color >> 24 != 0 {
                    next.color = self.style.underline.color;
                }
                for child in node.children_slice() {
                    self.walk(child, &next);
                }
            }
            "Highlight" => {
                let mut next = ctx.clone();
                if self.style.highlight.color >> 24 != 0 {
                    next.color = self.style.highlight.color;
                }
                next.background_color = argb_or(self.style.highlight.background_color, 0x44FF_EB3B);
                for child in node.children_slice() {
                    self.walk(child, &next);
                }
            }
            "Code" => {
                let mut next = ctx.clone();
                let code_family = normalize_font_family(&self.style.code.font_family);
                next.family = if code_family.is_empty() {
                    "monospace".to_string()
                } else {
                    code_family
                };
                // Match iOS CodeRenderer.m and Android CodeSpan.kt:
                // explicit code.fontSize wins; otherwise scale the surrounding block font size.
                next.size = if self.style.code.font_size > 0.0 {
                    self.style.code.font_size
                } else if self.style.code.font_scale > 0.0 {
                    ctx.size * self.style.code.font_scale
                } else {
                    ctx.size
                };
                if next.link_url.is_none() && self.style.code.color >> 24 != 0 {
                    next.color = self.style.code.color;
                }
                if self.style.code.background_color >> 24 != 0 {
                    next.background_color = self.style.code.background_color;
                }
                if let Some(content) = &node.content {
                    self.push_text(content, &next);
                }
                for child in node.children_slice() {
                    self.walk(child, &next);
                }
            }
            "Link" => {
                let mut next = ctx.clone();
                let url = node.attr("url").unwrap_or("").to_string();
                let recognized = node.attr("recognizedLink") == Some("true");
                let has_code_child = node.children_slice().iter().any(|c| c.node_type == "Code");
                let source_type = if has_code_child {
                    "inline-code"
                } else if recognized {
                    "text"
                } else {
                    "markdown"
                };
                let mut link_family = self.style.link.font_family.as_str();
                let mut link_color = argb_or(self.style.link.color, 0xFF25_63EB);
                let mut link_underline =
                    self.style.link.underline || (self.style.link.color >> 24 == 0);
                let mut link_bg = self.style.link.background_color;
                let variant_idx = node
                    .attr("linkVariant")
                    .and_then(|s| s.parse::<usize>().ok());
                if let Some(variant) = variant_idx
                    .and_then(|idx| self.style.link_variants.get(idx))
                    .or_else(|| matching_link_variant(&self.style.link_variants, &url))
                {
                    if !variant.font_family.is_empty() {
                        link_family = &variant.font_family;
                    }
                    if variant.color >> 24 != 0 {
                        link_color = variant.color;
                    }
                    link_underline = variant.underline;
                    if variant.background_color >> 24 != 0 {
                        link_bg = variant.background_color;
                    }
                }
                if !link_family.is_empty() {
                    next.family = normalize_font_family(link_family);
                }
                next.color = link_color;
                next.underline = link_underline;
                if link_bg >> 24 != 0 {
                    next.background_color = link_bg;
                }
                if !url.is_empty() {
                    next.link_url = Some(url);
                    next.link_source_type = Some(source_type.to_string());
                }
                for child in node.children_slice() {
                    self.walk(child, &next);
                }
            }
            "Image" => {
                let label = node
                    .attr("alt")
                    .or_else(|| node.attr("title"))
                    .unwrap_or("[image]");
                self.push_text(label, ctx);
            }
            "Spoiler" => {
                for child in node.children_slice() {
                    self.walk(child, ctx);
                }
            }
            _ => {
                if let Some(content) = &node.content {
                    self.push_text(content, ctx);
                }
                for child in node.children_slice() {
                    self.walk(child, ctx);
                }
            }
        }
    }

    fn finish(self, text_align: RichTextAlign) -> (RichParagraph, Vec<LinkSpan>, String) {
        (
            RichParagraph {
                runs: self.runs,
                text_align,
                max_lines: 0,
            },
            self.links,
            self.plain_text,
        )
    }
}

struct LayoutEngine<'a> {
    snapshot: &'a MarkdownSnapshot,
    doc: LaidOutDocument,
    task_index: i32,
}

impl<'a> LayoutEngine<'a> {
    fn new(snapshot: &'a MarkdownSnapshot) -> Self {
        Self {
            snapshot,
            doc: LaidOutDocument::default(),
            task_index: 0,
        }
    }

    fn style(&self) -> &'a MarkdownStyle {
        &self.snapshot.style
    }

    fn default_text_color(&self) -> u32 {
        argb_or(self.style().paragraph.color, 0xFF11_1827)
    }

    fn default_font_size(&self) -> f32 {
        let s = self.style().paragraph.font_size;
        if s > 0.0 {
            s
        } else {
            15.0
        }
    }

    fn measure_para(&self, paragraph: &RichParagraph, max_width: Option<f32>) -> (f32, f32) {
        if paragraph.runs.is_empty() {
            return (0.0, 0.0);
        }
        if let Some(extent) = measure_rich_text(paragraph, max_width) {
            return (extent.width, extent.height);
        }
        // Fallback metric estimation when TextService isn't installed (non-GPUI unit tests).
        let text_len: usize = paragraph.runs.iter().map(|r| r.text.chars().count()).sum();
        let font_size = paragraph.runs.first().map(|r| r.size).unwrap_or(15.0);
        let lh = paragraph
            .runs
            .first()
            .and_then(|r| (r.line_height > 0.0).then_some(r.line_height))
            .unwrap_or(font_size * 1.4);
        let explicit_lines = paragraph
            .runs
            .iter()
            .map(|r| r.text.matches('\n').count())
            .sum::<usize>()
            + 1;
        let est_w = (text_len as f32) * font_size * 0.52;
        match max_width {
            Some(mw) if mw > 0.0 && mw.is_finite() => {
                let wraps = (est_w / mw).ceil().max(1.0);
                (est_w.min(mw), lh * wraps.max(explicit_lines as f32))
            }
            _ => (est_w, lh * explicit_lines as f32),
        }
    }

    fn push_paragraph(
        &mut self,
        node: &AstNode,
        base: &BlockStyle,
        default_size: f32,
        default_weight: u16,
        x: f32,
        y: f32,
        avail_width: Option<f32>,
        override_color: Option<u32>,
        strikethrough_all: bool,
    ) -> (f32, f32, String) {
        let mut ctx = InlineCtx::from_block(
            base,
            default_size,
            default_weight,
            self.default_text_color(),
        );
        if let Some(c) = override_color {
            ctx.color = c;
        }
        if strikethrough_all {
            ctx.strikethrough = true;
        }
        let mut builder = InlineBuilder::new(self.style());
        for child in node.children_slice() {
            builder.walk(child, &ctx);
        }
        let (paragraph, links, plain_text) = builder.finish(text_align_of(&base.text_align));
        let (w, h) = self.measure_para(&paragraph, avail_width);
        let box_w = avail_width.map_or(w, |aw| {
            if paragraph.text_align == RichTextAlign::Natural
                || paragraph.text_align == RichTextAlign::Left
            {
                w.max(aw)
            } else {
                aw
            }
        });

        for link in &links {
            let rects = rich_text_range_rects(&paragraph, box_w.max(1.0), link.byte_range.clone());
            if rects.is_empty() && h > 0.0 && w > 0.0 {
                // In unit tests without TextService, still keep non-zero fallback span info if needed.
            } else {
                for (rx, ry, rw, rh) in rects {
                    if rw > 0.0 && rh > 0.0 {
                        self.doc.links.push(InteractiveLinkRect {
                            x: x + rx,
                            y: y + ry,
                            width: rw,
                            height: rh,
                            url: link.url.clone(),
                            source_type: link.source_type.clone(),
                        });
                    }
                }
            }
        }

        if h > 0.0 || !paragraph.runs.is_empty() {
            self.doc
                .items
                .push(LaidOutItem::Paragraph(LaidOutParagraph {
                    x,
                    y,
                    width: box_w,
                    height: h,
                    paragraph,
                    plain_text: plain_text.clone(),
                    links,
                }));
        }
        (w, h, plain_text)
    }

    fn layout_children(
        &mut self,
        children: &[AstNode],
        x: f32,
        start_y: f32,
        avail_width: Option<f32>,
        list_depth: usize,
        allow_trailing_margin: bool,
    ) -> (f32, f32) {
        let mut y = start_y;
        let mut max_w = 0.0f32;
        let visible_last = children.iter().rposition(|n| n.node_type != "BlankLine");
        for (idx, child) in children.iter().enumerate() {
            let is_last = Some(idx) == visible_last;
            let keep_bottom_margin = allow_trailing_margin || !is_last;
            let (bw, new_y) = self.layout_block(
                child,
                x,
                y,
                avail_width,
                list_depth,
                idx == 0,
                keep_bottom_margin,
            );
            max_w = max_w.max(bw);
            y = new_y;
        }
        (max_w, y - start_y)
    }

    fn layout_block(
        &mut self,
        node: &AstNode,
        x: f32,
        mut y: f32,
        avail_width: Option<f32>,
        list_depth: usize,
        is_first: bool,
        keep_bottom_margin: bool,
    ) -> (f32, f32) {
        match node.node_type.as_str() {
            "BlankLine" => (0.0, y),
            "Paragraph" => {
                let p = &self.style().paragraph;
                let is_tight = node.attr("tight") == Some("true");
                if !is_first && !is_tight {
                    y += p.margin_top.max(0.0);
                }
                let (w, h, _) =
                    self.push_paragraph(node, p, 15.0, 400, x, y, avail_width, None, false);
                y += h;
                if keep_bottom_margin && !is_tight {
                    y += p.margin_bottom.max(0.0);
                }
                (w, y)
            }
            "Heading" => {
                let level = node
                    .attr("level")
                    .and_then(|s| s.parse::<usize>().ok())
                    .unwrap_or(1)
                    .clamp(1, 6);
                let h_style = self.style().heading_style(level);
                let default_size = match level {
                    1 => 24.0,
                    2 => 20.0,
                    3 => 17.0,
                    _ => 15.0,
                };
                if !is_first {
                    y += h_style.margin_top.max(0.0);
                }
                let (w, h, _) = self.push_paragraph(
                    node,
                    h_style,
                    default_size,
                    700,
                    x,
                    y,
                    avail_width,
                    None,
                    false,
                );
                y += h;
                if keep_bottom_margin {
                    y += h_style.margin_bottom.max(0.0);
                }
                (w, y)
            }
            "UnorderedList" | "OrderedList" => {
                let ls = self.style().list.clone();
                if list_depth == 0 && !is_first {
                    y += ls.margin_top.max(0.0);
                }
                let is_ordered = node.node_type == "OrderedList";
                let start_num = node
                    .attr("start")
                    .and_then(|s| s.parse::<i64>().ok())
                    .unwrap_or(1);
                let indent = ls.margin_left.max(0.0);
                let gap = if ls.gap_width > 0.0 {
                    ls.gap_width
                } else {
                    8.0
                };
                let bullet_size = if ls.bullet_size > 0.0 {
                    ls.bullet_size
                } else {
                    6.0
                };
                let font_size = if ls.font_size > 0.0 {
                    ls.font_size
                } else {
                    self.default_font_size()
                };
                let marker_lh = if ls.line_height > 0.0 {
                    ls.line_height
                } else {
                    font_size * 1.4
                };
                let marker_family = normalize_font_family(&ls.font_family);
                let marker_weight = parse_font_weight(&ls.marker_font_weight);
                let marker_color = argb_or(
                    ls.marker_color,
                    argb_or(ls.bullet_color, self.default_text_color()),
                );
                let bullet_color = argb_or(ls.bullet_color, marker_color);

                let items = node.children_slice();
                let mut max_w = 0.0f32;
                let item_spacing = ls.item_spacing.max(2.0);
                for (idx, item) in items.iter().enumerate() {
                    if idx > 0 {
                        y += item_spacing;
                    }
                    let is_task = item.attr("isTask") == Some("true");
                    let checked = item.attr("taskChecked") == Some("true");
                    let checkbox_size = if self.style().task_list.checkbox_size > 0.0 {
                        self.style().task_list.checkbox_size
                    } else {
                        16.0
                    };
                    let marker_label = if is_ordered {
                        format!("{}.", start_num + idx as i64)
                    } else {
                        String::new()
                    };
                    let marker_w = if is_task {
                        checkbox_size
                    } else if is_ordered {
                        let measured = measure_text(
                            &marker_label,
                            &TextStyle {
                                family: marker_family.clone(),
                                size: font_size,
                                weight: marker_weight,
                                line_height: marker_lh,
                                ..Default::default()
                            },
                            None,
                        )
                        .map(|e| e.width)
                        .unwrap_or_else(|| marker_label.len() as f32 * font_size * 0.55);
                        measured.max(ls.marker_min_width).max(14.0)
                    } else {
                        (bullet_size + 4.0).max(ls.marker_min_width).max(12.0)
                    };

                    let content_x = x + indent + marker_w + gap;
                    let content_avail =
                        avail_width.map(|w| (w - indent - marker_w - gap).max(40.0));
                    let bullet_idx = self.doc.items.len();
                    let kind = if is_task {
                        BulletKind::Checkbox {
                            checked,
                            checked_color: argb_or(
                                self.style().task_list.checked_color,
                                0xFF25_63EB,
                            ),
                            border_color: argb_or(self.style().task_list.border_color, 0xFF64_748B),
                            checkmark_color: argb_or(
                                self.style().task_list.checkmark_color,
                                0xFFFF_FFFF,
                            ),
                            size: checkbox_size,
                            radius: self.style().task_list.checkbox_border_radius.max(3.0),
                        }
                    } else if is_ordered {
                        BulletKind::Number {
                            label: marker_label,
                            color: marker_color,
                            size: font_size,
                            weight: marker_weight,
                            family: marker_family.clone(),
                            line_height: marker_lh,
                        }
                    } else {
                        BulletKind::Disc {
                            depth: list_depth,
                            color: bullet_color,
                            size: bullet_size,
                        }
                    };
                    self.doc.items.push(LaidOutItem::Bullet {
                        x: x + indent,
                        y,
                        width: marker_w,
                        line_height: marker_lh,
                        kind,
                    });

                    let item_start_y = y;
                    let mut item_text = String::new();
                    let list_block_style = BlockStyle {
                        font_size,
                        font_family: ls.font_family.clone(),
                        font_weight: ls.font_weight.clone(),
                        color: if is_task
                            && checked
                            && self.style().task_list.checked_text_color >> 24 != 0
                        {
                            self.style().task_list.checked_text_color
                        } else {
                            argb_or(ls.color, self.default_text_color())
                        },
                        margin_top: 0.0,
                        margin_bottom: 4.0,
                        line_height: ls.line_height,
                        text_align: String::new(),
                    };

                    let children = item.children_slice();
                    for (c_idx, child) in children.iter().enumerate() {
                        let is_last_child = c_idx + 1 == children.len();
                        if child.node_type == "Paragraph" {
                            let is_tight = child.attr("tight") == Some("true");
                            let (cw, ch, plain) = self.push_paragraph(
                                child,
                                &list_block_style,
                                font_size,
                                400,
                                content_x,
                                y,
                                content_avail,
                                None,
                                is_task && checked && self.style().task_list.checked_strikethrough,
                            );
                            if item_text.is_empty() {
                                item_text = plain;
                            }
                            max_w = max_w.max(indent + marker_w + gap + cw);
                            y += ch;
                            if !is_last_child && !is_tight {
                                y += 4.0;
                            }
                        } else {
                            let (cw, next_y) = self.layout_block(
                                child,
                                content_x,
                                y,
                                content_avail,
                                list_depth + 1,
                                c_idx == 0,
                                !is_last_child,
                            );
                            max_w = max_w.max(indent + marker_w + gap + cw);
                            y = next_y;
                        }
                    }

                    let item_h = (y - item_start_y).max(marker_lh);
                    y = item_start_y + item_h;
                    if is_task {
                        let task_idx = self.task_index;
                        self.task_index += 1;
                        if self.snapshot.enable_task_list_item_toggle {
                            self.doc.task_toggles.push(InteractiveTaskRect {
                                x: x + indent,
                                y: item_start_y,
                                width: marker_w + gap,
                                height: marker_lh.max(checkbox_size),
                                index: task_idx,
                                checked,
                                text: item_text,
                            });
                        }
                    } else if let Some(LaidOutItem::Bullet { .. }) = self.doc.items.get(bullet_idx)
                    {
                    }
                }

                if list_depth == 0 && keep_bottom_margin {
                    y += ls.margin_bottom.max(0.0);
                }
                (max_w, y)
            }
            "Blockquote" | "Admonition" => {
                let bq = &self.style().blockquote;
                if !is_first {
                    y += bq.margin_top.max(0.0);
                }
                let is_admonition = node.node_type == "Admonition";
                let adm_type = node.attr("admonitionType").unwrap_or("note");
                let (accent_color, bg_color) = if is_admonition {
                    let adm = match adm_type {
                        "tip" => &bq.admonitions.tip,
                        "important" => &bq.admonitions.important,
                        "warning" => &bq.admonitions.warning,
                        "caution" => &bq.admonitions.caution,
                        _ => &bq.admonitions.note,
                    };
                    (
                        argb_or(adm.color, argb_or(bq.border_color, 0xFF3B_82F6)),
                        argb_or(adm.background_color, bq.background_color),
                    )
                } else {
                    (argb_or(bq.border_color, 0xFF94_A3B8), bq.background_color)
                };

                let bar_w = if bq.border_width > 0.0 {
                    bq.border_width
                } else {
                    3.0
                };
                let gap = if bq.gap_width > 0.0 {
                    bq.gap_width
                } else {
                    12.0
                };
                let pad = bq.padding.max(if bg_color >> 24 != 0 { 10.0 } else { 0.0 });
                let inner_x = x + bar_w + gap + pad;
                let inner_avail = avail_width.map(|w| (w - bar_w - gap - pad * 2.0).max(40.0));
                let box_top = y;
                let rect_idx = self.doc.items.len();
                self.doc.items.push(LaidOutItem::Rect {
                    x,
                    y: box_top,
                    width: 0.0,
                    height: 0.0,
                    bg_color: 0,
                    border_color: 0,
                    border_width: 0.0,
                    border_radius: 0.0,
                });
                let bar_idx = self.doc.items.len();
                self.doc.items.push(LaidOutItem::Rect {
                    x: x + pad,
                    y: box_top + pad,
                    width: bar_w,
                    height: 0.0,
                    bg_color: accent_color,
                    border_color: 0,
                    border_width: 0.0,
                    border_radius: bar_w * 0.5,
                });

                y += pad;
                let mut inner_max_w = 0.0f32;
                if is_admonition {
                    let title = match adm_type {
                        "tip" => "Tip",
                        "important" => "Important",
                        "warning" => "Warning",
                        "caution" => "Caution",
                        _ => "Note",
                    };
                    let title_para = RichParagraph {
                        runs: vec![RichTextRun {
                            text: title.to_string(),
                            family: normalize_font_family(&bq.font_family),
                            size: if bq.font_size > 0.0 {
                                bq.font_size
                            } else {
                                self.default_font_size()
                            },
                            weight: 700,
                            color: accent_color,
                            line_height: bq.line_height,
                            ..Default::default()
                        }],
                        ..Default::default()
                    };
                    let (tw, th) = self.measure_para(&title_para, inner_avail);
                    self.doc
                        .items
                        .push(LaidOutItem::Paragraph(LaidOutParagraph {
                            x: inner_x,
                            y,
                            width: inner_avail.unwrap_or(tw).max(tw),
                            height: th,
                            paragraph: title_para,
                            plain_text: title.to_string(),
                            links: Vec::new(),
                        }));
                    inner_max_w = inner_max_w.max(tw);
                    y += th + 4.0;
                }

                let (cw, _) = self.layout_children(
                    node.children_slice(),
                    inner_x,
                    y,
                    inner_avail,
                    list_depth,
                    false,
                );
                inner_max_w = inner_max_w.max(cw);
                y = self.doc_bottom_after(bar_idx).max(y) + pad;

                let box_w = avail_width.unwrap_or(bar_w + gap + pad * 2.0 + inner_max_w);
                let box_h = (y - box_top).max(bar_w);
                if let Some(LaidOutItem::Rect {
                    width,
                    height,
                    bg_color: bg,
                    border_radius,
                    ..
                }) = self.doc.items.get_mut(rect_idx)
                {
                    *width = box_w;
                    *height = box_h;
                    *bg = bg_color;
                    *border_radius = bq.border_radius;
                }
                if let Some(LaidOutItem::Rect { height, .. }) = self.doc.items.get_mut(bar_idx) {
                    *height = (box_h - pad * 2.0).max(bar_w);
                }

                if keep_bottom_margin {
                    y += bq.margin_bottom.max(0.0);
                }
                (box_w, y)
            }
            "CodeBlock" => {
                let cb = &self.style().code_block;
                if !is_first {
                    y += cb.margin_top.max(0.0);
                }
                let language = node.attr("language").unwrap_or("").to_string();
                let display_language = node
                    .attr("displayLanguage")
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| language.clone());
                let mut code = node.content.clone().unwrap_or_default();
                while code.ends_with('\n') {
                    code.pop();
                }

                let font_size = if cb.font_size > 0.0 {
                    cb.font_size
                } else {
                    13.0
                };
                let line_height = if cb.line_height > 0.0 {
                    cb.line_height
                } else {
                    19.0
                };
                let family = {
                    let norm = normalize_font_family(&cb.font_family);
                    if norm.is_empty() {
                        "monospace".to_string()
                    } else {
                        norm
                    }
                };
                let default_fg = argb_or(cb.color, 0xFFE2_E8F0);
                let bg_color = argb_or(cb.background_color, 0xFF0F_172A);
                let border_color = cb.border_color;
                let border_width = if border_color >> 24 != 0 && cb.border_width <= 0.0 {
                    1.0
                } else {
                    cb.border_width.max(0.0)
                };
                let pad = if cb.padding > 0.0 { cb.padding } else { 12.0 };
                let inset = pad + border_width;
                let header_font_size = font_size * 0.85;
                let header_h = if self.snapshot.is_gfm {
                    let label_h = measure_text(
                        "Ag",
                        &TextStyle {
                            size: header_font_size,
                            weight: 500,
                            ..Default::default()
                        },
                        None,
                    )
                    .map(|e| e.height.ceil())
                    .unwrap_or_else(|| (header_font_size * 1.25).ceil());
                    inset + label_h
                } else {
                    0.0
                };

                let mut runs = Vec::new();
                if let Some(tokens) = &node.tokens {
                    let mut cursor = 0usize;
                    let code_len = code.len();
                    for &(raw_start, raw_end, token_type) in tokens {
                        let start = raw_start.min(code_len);
                        let end = raw_end.min(code_len);
                        if start < cursor || end <= start {
                            continue;
                        }
                        if !code.is_char_boundary(start) || !code.is_char_boundary(end) {
                            continue;
                        }
                        if start > cursor {
                            runs.push(RichTextRun {
                                text: code[cursor..start].to_string(),
                                family: family.clone(),
                                size: font_size,
                                weight: 400,
                                color: default_fg,
                                line_height,
                                ..Default::default()
                            });
                        }
                        runs.push(RichTextRun {
                            text: code[start..end].to_string(),
                            family: family.clone(),
                            size: font_size,
                            weight: 400,
                            color: cb.syntax_colors.color_for(token_type, default_fg),
                            line_height,
                            ..Default::default()
                        });
                        cursor = end;
                    }
                    if cursor < code_len {
                        runs.push(RichTextRun {
                            text: code[cursor..].to_string(),
                            family: family.clone(),
                            size: font_size,
                            weight: 400,
                            color: default_fg,
                            line_height,
                            ..Default::default()
                        });
                    }
                } else {
                    runs.push(RichTextRun {
                        text: code.clone(),
                        family: family.clone(),
                        size: font_size,
                        weight: 400,
                        color: default_fg,
                        line_height,
                        ..Default::default()
                    });
                }

                let paragraph = RichParagraph {
                    runs,
                    text_align: RichTextAlign::Left,
                    max_lines: 0,
                };
                let (content_w, content_h) = self.measure_para(&paragraph, None);
                let natural_box_w = content_w + inset * 2.0;
                let box_w = avail_width
                    .unwrap_or(natural_box_w)
                    .max(natural_box_w.min(avail_width.unwrap_or(natural_box_w)));
                let code_h = if code.is_empty() {
                    0.0
                } else {
                    content_h.max(line_height)
                };
                let box_h = header_h + code_h + inset * 2.0;

                if self.snapshot.enable_code_block_press {
                    self.doc.code_copies.push(InteractiveCopyRect {
                        x,
                        y,
                        width: box_w,
                        height: box_h,
                        code: code.clone(),
                        language: language.clone(),
                    });
                }

                let header_text_color = (default_fg & 0x00FF_FFFF) | 0x9900_0000;
                let divider_color = (default_fg & 0x00FF_FFFF) | 0x3300_0000;

                self.doc
                    .items
                    .push(LaidOutItem::CodeBlock(LaidOutCodeBlock {
                        x,
                        y,
                        width: box_w,
                        height: box_h,
                        content_width: content_w,
                        content_height: code_h.max(line_height),
                        inset,
                        header_height: header_h,
                        header_font_size,
                        language,
                        display_language,
                        code,
                        paragraph,
                        bg_color,
                        border_color,
                        border_width,
                        border_radius: if cb.border_radius > 0.0 {
                            cb.border_radius
                        } else {
                            8.0
                        },
                        header_text_color,
                        divider_color,
                    }));

                y += box_h;
                if keep_bottom_margin {
                    y += cb.margin_bottom.max(0.0);
                }
                (box_w, y)
            }
            "Table" => {
                let tb = &self.style().table;
                if !is_first {
                    y += tb.margin_top.max(0.0);
                }
                let mut rows: Vec<(bool, &AstNode)> = Vec::new();
                for child in node.children_slice() {
                    match child.node_type.as_str() {
                        "TableHead" => {
                            for r in child.children_slice() {
                                if r.node_type == "TableRow" {
                                    rows.push((true, r));
                                }
                            }
                        }
                        "TableBody" => {
                            for r in child.children_slice() {
                                if r.node_type == "TableRow" {
                                    rows.push((false, r));
                                }
                            }
                        }
                        "TableRow" => rows.push((false, child)),
                        _ => {}
                    }
                }
                let col_count = rows
                    .iter()
                    .map(|(_, r)| r.children_slice().len())
                    .max()
                    .unwrap_or(0);
                if col_count == 0 {
                    return (0.0, y);
                }

                let pad_x = if tb.cell_padding_horizontal > 0.0 {
                    tb.cell_padding_horizontal
                } else {
                    10.0
                };
                let pad_y = if tb.cell_padding_vertical > 0.0 {
                    tb.cell_padding_vertical
                } else {
                    6.0
                };
                let border_w = if tb.border_width > 0.0 {
                    tb.border_width
                } else {
                    1.0
                };
                let border_color = argb_or(tb.border_color, 0xFFCB_D5E1);
                let header_bg = argb_or(tb.header_background_color, 0xFFF1_F5F9);
                let even_bg = argb_or(tb.row_even_background_color, 0xFFFF_FFFF);
                let odd_bg = argb_or(tb.row_odd_background_color, 0xFFF8_FAFC);
                let body_fg = argb_or(tb.color, self.default_text_color());
                let header_fg = argb_or(tb.header_text_color, body_fg);
                let font_size = if tb.font_size > 0.0 {
                    tb.font_size
                } else {
                    14.0
                };
                let line_height = tb.line_height;

                // Measure natural width per cell & build RichParagraph for each cell.
                let mut col_nat_widths = vec![48.0f32; col_count];
                struct PreparedCell {
                    paragraph: RichParagraph,
                    links: Vec<LinkSpan>,
                    align: RichTextAlign,
                }
                let mut prepared_rows: Vec<(bool, Vec<PreparedCell>)> =
                    Vec::with_capacity(rows.len());

                for &(is_header, row_node) in &rows {
                    let cells = row_node.children_slice();
                    let mut row_cells = Vec::with_capacity(col_count);
                    for col_idx in 0..col_count {
                        let cell_node = cells.get(col_idx);
                        let align = cell_node
                            .and_then(|c| c.attr("align"))
                            .map(text_align_of)
                            .unwrap_or(RichTextAlign::Left);
                        let ctx = InlineCtx {
                            family: normalize_font_family(
                                if is_header && !tb.header_font_family.is_empty() {
                                    &tb.header_font_family
                                } else {
                                    &tb.font_family
                                },
                            ),
                            size: font_size,
                            weight: if is_header {
                                700
                            } else {
                                parse_font_weight(&tb.font_weight)
                            },
                            italic: false,
                            color: if is_header { header_fg } else { body_fg },
                            background_color: 0,
                            line_height,
                            underline: false,
                            strikethrough: false,
                            link_url: None,
                            link_source_type: None,
                        };
                        let mut builder = InlineBuilder::new(self.style());
                        if let Some(c) = cell_node {
                            for ch in c.children_slice() {
                                builder.walk(ch, &ctx);
                            }
                        }
                        let (para, links, _) = builder.finish(align);
                        let (nw, _) = self.measure_para(&para, None);
                        col_nat_widths[col_idx] =
                            col_nat_widths[col_idx].max(nw + pad_x * 2.0 + 4.0);
                        row_cells.push(PreparedCell {
                            paragraph: para,
                            links,
                            align,
                        });
                    }
                    prepared_rows.push((is_header, row_cells));
                }

                let total_nat: f32 = col_nat_widths.iter().sum();
                let mut col_widths = col_nat_widths.clone();
                let box_w = if let Some(aw) = avail_width {
                    if total_nat > aw {
                        let min_col = 64.0f32;
                        let min_total = min_col * col_count as f32;
                        if aw >= min_total {
                            let scale = aw / total_nat;
                            for (cw, nat) in col_widths.iter_mut().zip(&col_nat_widths) {
                                *cw = (nat * scale).max(min_col);
                            }
                            let sum: f32 = col_widths.iter().sum();
                            if (sum - aw).abs() > 0.5 && !col_widths.is_empty() {
                                let ratio = aw / sum;
                                for cw in &mut col_widths {
                                    *cw *= ratio;
                                }
                            }
                        }
                        aw
                    } else {
                        let extra = aw - total_nat;
                        let per_col = extra / col_count as f32;
                        for cw in &mut col_widths {
                            *cw += per_col;
                        }
                        aw
                    }
                } else {
                    total_nat
                };
                let content_width: f32 = col_widths.iter().sum();

                let mut laid_cells = Vec::with_capacity(prepared_rows.len() * col_count);
                let mut cur_y = y;
                let mut body_row_idx = 0usize;
                for (is_header, row_cells) in prepared_rows {
                    let row_bg = if is_header {
                        header_bg
                    } else {
                        let bg = if body_row_idx % 2 == 0 {
                            even_bg
                        } else {
                            odd_bg
                        };
                        body_row_idx += 1;
                        bg
                    };
                    let mut row_h = font_size + pad_y * 2.0;
                    let mut measured_cells = Vec::with_capacity(col_count);
                    for (col_idx, cell) in row_cells.into_iter().enumerate() {
                        let cw = col_widths[col_idx];
                        let inner_w = (cw - pad_x * 2.0).max(16.0);
                        let (tw, th) = self.measure_para(&cell.paragraph, Some(inner_w));
                        row_h = row_h.max(th + pad_y * 2.0);
                        measured_cells.push((cell, cw, tw, th));
                    }

                    let mut cur_x = x;
                    for (cell, cw, tw, th) in measured_cells {
                        let text_w = match cell.align {
                            RichTextAlign::Center | RichTextAlign::Right => {
                                (cw - pad_x * 2.0).max(tw)
                            }
                            _ => tw.max(cw - pad_x * 2.0),
                        };
                        for link in &cell.links {
                            for (rx, ry, rw, rh) in rich_text_range_rects(
                                &cell.paragraph,
                                text_w.max(1.0),
                                link.byte_range.clone(),
                            ) {
                                self.doc.links.push(InteractiveLinkRect {
                                    x: cur_x + pad_x + rx,
                                    y: cur_y + pad_y + ry,
                                    width: rw,
                                    height: rh,
                                    url: link.url.clone(),
                                    source_type: link.source_type.clone(),
                                });
                            }
                        }
                        laid_cells.push(LaidOutTableCell {
                            x: cur_x,
                            y: cur_y,
                            width: cw,
                            height: row_h,
                            pad_x,
                            pad_y,
                            bg_color: row_bg,
                            paragraph: cell.paragraph,
                            text_width: text_w,
                            text_height: th,
                        });
                        cur_x += cw;
                    }
                    cur_y += row_h;
                }

                let table_h = (cur_y - y).max(0.0);
                self.doc.items.push(LaidOutItem::Table(LaidOutTable {
                    x,
                    y,
                    width: box_w,
                    height: table_h,
                    content_width,
                    border_color,
                    border_width: border_w,
                    border_radius: tb.border_radius.max(6.0),
                    cells: laid_cells,
                }));

                y = cur_y;
                if keep_bottom_margin {
                    y += tb.margin_bottom.max(0.0);
                }
                (box_w, y)
            }
            "ThematicBreak" => {
                let hr = &self.style().thematic_break;
                if !is_first {
                    y += hr.margin_top.max(8.0);
                }
                let h = hr.height.max(1.0);
                let w = avail_width.unwrap_or(200.0);
                self.doc.items.push(LaidOutItem::Rect {
                    x,
                    y,
                    width: w,
                    height: h,
                    bg_color: argb_or(hr.color, 0xFFCB_D5E1),
                    border_color: 0,
                    border_width: 0.0,
                    border_radius: 0.0,
                });
                y += h;
                if keep_bottom_margin {
                    y += hr.margin_bottom.max(8.0);
                }
                (w, y)
            }
            "Image" => {
                let im = &self.style().image;
                if !is_first {
                    y += im.margin_top.max(4.0);
                }
                let url = node.attr("url").unwrap_or("").to_string();
                let alt_text = node.attr("alt").unwrap_or("").to_string();
                let w = avail_width.unwrap_or(240.0).min(360.0);
                let mut h = if im.height > 0.0 {
                    im.height
                } else if im.aspect_ratio > 0.0 {
                    w / im.aspect_ratio
                } else {
                    180.0
                };
                if im.max_height > 0.0 {
                    h = h.min(im.max_height);
                }
                if self.snapshot.enable_image_press && !url.is_empty() {
                    self.doc.images.push(InteractiveImageRect {
                        x,
                        y,
                        width: w,
                        height: h,
                        url: url.clone(),
                        alt_text: alt_text.clone(),
                    });
                }
                self.doc.items.push(LaidOutItem::Image {
                    x,
                    y,
                    width: w,
                    height: h,
                    url,
                    alt_text,
                    border_radius: im.border_radius,
                });
                y += h;
                if keep_bottom_margin {
                    y += im.margin_bottom.max(4.0);
                }
                (w, y)
            }
            _ => {
                let (w, h) = self.layout_children(
                    node.children_slice(),
                    x,
                    y,
                    avail_width,
                    list_depth,
                    keep_bottom_margin,
                );
                (w, y + h)
            }
        }
    }

    fn doc_bottom_after(&self, from_idx: usize) -> f32 {
        let mut max_y = 0.0f32;
        for item in self.doc.items.iter().skip(from_idx + 1) {
            let bottom = match item {
                LaidOutItem::Paragraph(p) => p.y + p.height,
                LaidOutItem::Bullet { y, line_height, .. } => y + line_height,
                LaidOutItem::Rect { y, height, .. } => y + height,
                LaidOutItem::CodeBlock(c) => c.y + c.height,
                LaidOutItem::Table(t) => t.y + t.height,
                LaidOutItem::Image { y, height, .. } => y + height,
            };
            max_y = max_y.max(bottom);
        }
        max_y
    }

    fn run(mut self, max_width: Option<f32>) -> LaidOutDocument {
        let children = self.snapshot.ast.children_slice();
        let (content_w, total_h) = self.layout_children(
            children,
            0.0,
            0.0,
            max_width,
            0,
            self.snapshot.allow_trailing_margin,
        );
        self.doc.width = max_width.map_or(content_w, |mw| content_w.min(mw).max(0.0));
        self.doc.height = total_h.max(0.0);
        self.doc
    }
}

fn matching_link_variant<'a>(
    variants: &'a [LinkVariantStyle],
    url: &str,
) -> Option<&'a LinkVariantStyle> {
    variants.iter().find(|entry| {
        if entry.pattern == "^(?!https?://).+" {
            !url.is_empty() && !url.starts_with("http://") && !url.starts_with("https://")
        } else {
            !entry.pattern.is_empty() && url.contains(entry.pattern.trim_matches('^'))
        }
    })
}

pub fn layout_document(snapshot: &MarkdownSnapshot, max_width: Option<f32>) -> LaidOutDocument {
    LayoutEngine::new(snapshot).run(max_width)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_snapshot() -> MarkdownSnapshot {
        serde_json::from_value(serde_json::json!({
            "ast": {
                "type": "Document",
                "children": [
                    {
                        "type": "Heading",
                        "attributes": { "level": "1" },
                        "children": [{ "type": "Text", "content": "Title" }]
                    },
                    {
                        "type": "Paragraph",
                        "children": [
                            { "type": "Text", "content": "See " },
                            {
                                "type": "Link",
                                "attributes": { "url": "https://example.com" },
                                "children": [{ "type": "Text", "content": "docs" }]
                            }
                        ]
                    },
                    {
                        "type": "UnorderedList",
                        "children": [
                            {
                                "type": "ListItem",
                                "children": [{
                                    "type": "Paragraph",
                                    "attributes": { "tight": "true" },
                                    "children": [{ "type": "Text", "content": "Item A" }]
                                }]
                            },
                            {
                                "type": "ListItem",
                                "children": [{
                                    "type": "Paragraph",
                                    "attributes": { "tight": "true" },
                                    "children": [{ "type": "Text", "content": "Item B" }]
                                }]
                            }
                        ]
                    },
                    {
                        "type": "CodeBlock",
                        "attributes": { "language": "ts" },
                        "content": "const x = 1;\n",
                        "tokens": [[0, 5, 0], [10, 11, 4]]
                    },
                    {
                        "type": "Table",
                        "children": [
                            {
                                "type": "TableHead",
                                "children": [{
                                    "type": "TableRow",
                                    "children": [
                                        { "type": "TableHeaderCell", "children": [{ "type": "Text", "content": "Col A" }] },
                                        { "type": "TableHeaderCell", "children": [{ "type": "Text", "content": "Col B" }] }
                                    ]
                                }]
                            },
                            {
                                "type": "TableBody",
                                "children": [{
                                    "type": "TableRow",
                                    "children": [
                                        { "type": "TableCell", "children": [{ "type": "Text", "content": "Val 1" }] },
                                        { "type": "TableCell", "children": [{ "type": "Text", "content": "Val 2" }] }
                                    ]
                                }]
                            }
                        ]
                    }
                ]
            },
            "style": {
                "h1": { "fontSize": 24, "marginBottom": 8 },
                "paragraph": { "fontSize": 15, "marginBottom": 10 },
                "codeBlock": {
                    "fontSize": 13,
                    "lineHeight": 19,
                    "padding": 12,
                    "marginBottom": 12,
                    "syntaxColors": { "keyword": 4290807036u32, "number": 4294688548u32 }
                },
                "table": { "fontSize": 14, "cellPaddingHorizontal": 10, "cellPaddingVertical": 6, "marginBottom": 10 }
            },
            "allowTrailingMargin": false
        }))
        .expect("valid sample snapshot")
    }

    #[test]
    fn lays_out_heading_paragraph_list_code_and_table() {
        let doc = layout_document(&sample_snapshot(), Some(500.0));
        assert!(doc.height > 120.0);
        assert_eq!(doc.width, 500.0);
        assert!(doc
            .items
            .iter()
            .any(|i| matches!(i, LaidOutItem::CodeBlock(_))));
        assert!(doc.items.iter().any(|i| matches!(i, LaidOutItem::Table(_))));
        assert!(doc
            .items
            .iter()
            .any(|i| matches!(i, LaidOutItem::Bullet { .. })));
    }

    #[test]
    fn allow_trailing_margin_adds_bottom_spacing_when_true() {
        let mut without = sample_snapshot();
        without.allow_trailing_margin = false;
        let mut with_margin = sample_snapshot();
        with_margin.allow_trailing_margin = true;
        let d1 = layout_document(&without, Some(500.0));
        let d2 = layout_document(&with_margin, Some(500.0));
        assert!(d2.height > d1.height);
    }

    #[test]
    fn normalize_font_family_matches_text_renderer() {
        assert_eq!(normalize_font_family(""), "");
        assert_eq!(normalize_font_family("normal"), "");
        assert_eq!(normalize_font_family("System"), "");
        assert_eq!(normalize_font_family("sans-serif"), "");
        assert_eq!(
            normalize_font_family("system-ui, -apple-system, sans-serif"),
            ""
        );
        assert_eq!(normalize_font_family("monospace"), "monospace");
        assert_eq!(normalize_font_family("ui-monospace"), "monospace");
        assert_eq!(normalize_font_family("Menlo, Monaco"), "monospace");
        assert_eq!(normalize_font_family("CustomFont"), "CustomFont");
    }

    #[test]
    fn headings_scale_inline_code_and_emphasis_match_native_spec() {
        let snap: MarkdownSnapshot = serde_json::from_value(serde_json::json!({
            "ast": {
                "type": "Document",
                "children": [
                    {
                        "type": "Heading",
                        "attributes": { "level": "1" },
                        "children": [{ "type": "Text", "content": "Heading One" }]
                    },
                    {
                        "type": "Heading",
                        "attributes": { "level": "2" },
                        "children": [{ "type": "Text", "content": "Heading Two" }]
                    },
                    {
                        "type": "Paragraph",
                        "children": [
                            { "type": "Strong", "children": [{ "type": "Text", "content": "bold" }] },
                            { "type": "Emphasis", "children": [{ "type": "Text", "content": "italic" }] },
                            { "type": "Strikethrough", "children": [{ "type": "Text", "content": "struck" }] },
                            { "type": "Code", "content": "inline_code" },
                            {
                                "type": "Link",
                                "attributes": { "url": "https://paseo.sh/docs" },
                                "children": [{ "type": "Text", "content": "docs" }]
                            },
                            {
                                "type": "Link",
                                "attributes": { "url": "file.ts", "recognizedLink": "true" },
                                "children": [{ "type": "Code", "content": "file.ts" }]
                            }
                        ]
                    }
                ]
            },
            "style": {
                "paragraph": { "fontSize": 15, "lineHeight": 21, "color": 4279769115u32, "marginBottom": 10 },
                "h1": { "fontSize": 24, "lineHeight": 31, "fontWeight": "bold", "marginBottom": 10 },
                "h2": { "fontSize": 21, "lineHeight": 27, "fontWeight": "bold", "marginBottom": 10 },
                "code": { "fontFamily": "monospace", "fontSize": 0, "fontScale": 0.8, "color": 4279769115u32, "backgroundColor": 4294243573u32 },
                "link": { "color": 4280254528u32, "underline": false }
            }
        }))
        .unwrap();

        let doc = layout_document(&snap, Some(500.0));
        let paras: Vec<&LaidOutParagraph> = doc
            .items
            .iter()
            .filter_map(|i| match i {
                LaidOutItem::Paragraph(p) => Some(p),
                _ => None,
            })
            .collect();
        assert_eq!(paras.len(), 3);
        assert_eq!(paras[0].paragraph.runs[0].size, 24.0);
        assert_eq!(paras[0].paragraph.runs[0].weight, 700);
        assert_eq!(paras[1].paragraph.runs[0].size, 21.0);
        assert!(paras[0].height > paras[1].height);

        let body_runs = &paras[2].paragraph.runs;
        assert_eq!(body_runs[0].weight, 700);
        assert!(body_runs[1].italic);
        assert!(body_runs[2].strikethrough);
        assert!((body_runs[3].size - 12.0).abs() < 0.01);
        assert_eq!(body_runs[3].family, "monospace");
        assert_eq!(paras[2].links.len(), 2);
        assert_eq!(paras[2].links[0].source_type, "markdown");
        assert_eq!(paras[2].links[1].source_type, "inline-code");
    }

    #[test]
    fn ordered_task_blockquote_and_gfm_code_block_layout() {
        let snap: MarkdownSnapshot = serde_json::from_value(serde_json::json!({
            "isGFM": true,
            "enableTaskListItemToggle": true,
            "ast": {
                "type": "Document",
                "children": [
                    {
                        "type": "OrderedList",
                        "attributes": { "start": "3" },
                        "children": [
                            {
                                "type": "ListItem",
                                "children": [{ "type": "Paragraph", "children": [{ "type": "Text", "content": "Third" }] }]
                            },
                            {
                                "type": "ListItem",
                                "attributes": { "isTask": "true", "taskChecked": "true" },
                                "children": [{ "type": "Paragraph", "children": [{ "type": "Text", "content": "Checked" }] }]
                            }
                        ]
                    },
                    {
                        "type": "Blockquote",
                        "children": [
                            { "type": "Paragraph", "children": [{ "type": "Text", "content": "Quote line" }] }
                        ]
                    },
                    {
                        "type": "CodeBlock",
                        "attributes": { "language": "ts", "displayLanguage": "TypeScript" },
                        "content": "const a = 1;\n",
                        "tokens": [[0, 5, 0], [10, 11, 4]]
                    }
                ]
            },
            "style": {
                "list": { "fontSize": 15, "markerColor": 4285624698u32, "marginLeft": 20, "gapWidth": 7 },
                "blockquote": { "fontSize": 15, "borderColor": 4293190887u32, "borderWidth": 3, "padding": 12 },
                "codeBlock": {
                    "fontSize": 12,
                    "lineHeight": 21,
                    "padding": 12,
                    "borderWidth": 1,
                    "syntaxColors": { "keyword": 4294933362u32, "number": 4286169343u32 }
                }
            }
        }))
        .unwrap();

        let doc = layout_document(&snap, Some(500.0));
        let has_num_3 = doc.items.iter().any(|i| {
            matches!(i, LaidOutItem::Bullet { kind: BulletKind::Number { label, .. }, .. } if label == "3.")
        });
        assert!(has_num_3);
        let has_checked_box = doc.items.iter().any(|i| {
            matches!(
                i,
                LaidOutItem::Bullet {
                    kind: BulletKind::Checkbox { checked: true, .. },
                    ..
                }
            )
        });
        assert!(has_checked_box);
        assert_eq!(doc.task_toggles.len(), 1);
        assert!(
            doc.items
                .iter()
                .filter(|i| matches!(i, LaidOutItem::Rect { .. }))
                .count()
                >= 2
        );
        let cb = doc
            .items
            .iter()
            .find_map(|i| match i {
                LaidOutItem::CodeBlock(cb) => Some(cb),
                _ => None,
            })
            .expect("code block present");
        assert_eq!(cb.display_language, "TypeScript");
        assert!(cb.header_height > 0.0);
        assert!(cb.paragraph.runs.len() >= 3);
    }

    #[test]
    fn long_unbroken_word_wraps_and_unsupported_nodes_do_not_panic() {
        let long_word = "x".repeat(240);
        let snap: MarkdownSnapshot = serde_json::from_value(serde_json::json!({
            "ast": {
                "type": "Document",
                "children": [
                    { "type": "Paragraph", "children": [{ "type": "Text", "content": long_word }] },
                    { "type": "LatexMathDisplay", "children": [{ "type": "Text", "content": "E = mc^2" }] },
                    { "type": "Image", "attributes": { "url": "local/missing.png", "alt": "Chart" } }
                ]
            },
            "style": {
                "paragraph": { "fontSize": 15, "lineHeight": 21 }
            }
        }))
        .unwrap();

        let doc = layout_document(&snap, Some(180.0));
        assert!(doc.width <= 180.0);
        assert!(doc.height > 200.0);
        assert!(doc
            .items
            .iter()
            .any(|i| matches!(i, LaidOutItem::Image { alt_text, .. } if alt_text == "Chart")));
    }
}
