use react_native_gpui::host_component::RichTextAlign;
use serde::Deserialize;
use std::collections::HashMap;

#[derive(Clone, Debug, Deserialize, Default)]
#[allow(dead_code)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownSnapshot {
    #[serde(skip)]
    pub content_hash: u64,
    pub ast: AstNode,
    #[serde(default)]
    pub style: MarkdownStyle,
    #[serde(default)]
    pub is_gfm: bool,
    #[serde(default)]
    pub allow_trailing_margin: bool,
    #[serde(default = "default_true")]
    pub selectable: bool,
    #[serde(default)]
    pub enable_image_press: bool,
    #[serde(default)]
    pub enable_code_block_press: bool,
    #[serde(default)]
    pub enable_task_list_item_toggle: bool,
    #[serde(default)]
    pub number_of_lines: i32,
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize, Default)]
pub struct AstNode {
    #[serde(rename = "type", default)]
    pub node_type: String,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub attributes: Option<HashMap<String, String>>,
    #[serde(default)]
    pub children: Option<Vec<AstNode>>,
    #[serde(default)]
    pub tokens: Option<Vec<(usize, usize, u8)>>,
}

impl AstNode {
    pub fn attr(&self, key: &str) -> Option<&str> {
        self.attributes
            .as_ref()
            .and_then(|map| map.get(key))
            .map(String::as_str)
    }

    pub fn children_slice(&self) -> &[AstNode] {
        self.children.as_deref().unwrap_or(&[])
    }
}

#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BlockStyle {
    #[serde(default)]
    pub font_size: f32,
    #[serde(default)]
    pub font_family: String,
    #[serde(default)]
    pub font_weight: String,
    #[serde(default)]
    pub color: u32,
    #[serde(default)]
    pub margin_top: f32,
    #[serde(default)]
    pub margin_bottom: f32,
    #[serde(default)]
    pub line_height: f32,
    #[serde(default)]
    pub text_align: String,
}

#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AdmonitionColors {
    #[serde(default)]
    pub color: u32,
    #[serde(default)]
    pub background_color: u32,
}

#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AdmonitionsStyle {
    #[serde(default)]
    pub note: AdmonitionColors,
    #[serde(default)]
    pub tip: AdmonitionColors,
    #[serde(default)]
    pub important: AdmonitionColors,
    #[serde(default)]
    pub warning: AdmonitionColors,
    #[serde(default)]
    pub caution: AdmonitionColors,
}

#[derive(Clone, Debug, Deserialize, Default)]
#[allow(dead_code)]
#[serde(rename_all = "camelCase")]
pub struct BlockquoteStyle {
    #[serde(default)]
    pub font_size: f32,
    #[serde(default)]
    pub font_family: String,
    #[serde(default)]
    pub font_weight: String,
    #[serde(default)]
    pub color: u32,
    #[serde(default)]
    pub margin_top: f32,
    #[serde(default)]
    pub margin_bottom: f32,
    #[serde(default)]
    pub line_height: f32,
    #[serde(default)]
    pub border_color: u32,
    #[serde(default)]
    pub border_width: f32,
    #[serde(default)]
    pub gap_width: f32,
    #[serde(default)]
    pub background_color: u32,
    #[serde(default)]
    pub border_radius: f32,
    #[serde(default)]
    pub padding: f32,
    #[serde(default)]
    pub admonitions: AdmonitionsStyle,
}

#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ListStyle {
    #[serde(default)]
    pub font_size: f32,
    #[serde(default)]
    pub font_family: String,
    #[serde(default)]
    pub font_weight: String,
    #[serde(default)]
    pub color: u32,
    #[serde(default)]
    pub margin_top: f32,
    #[serde(default)]
    pub margin_bottom: f32,
    #[serde(default)]
    pub line_height: f32,
    #[serde(default)]
    pub bullet_color: u32,
    #[serde(default)]
    pub bullet_size: f32,
    #[serde(default)]
    pub marker_min_width: f32,
    #[serde(default)]
    pub marker_color: u32,
    #[serde(default)]
    pub marker_font_weight: String,
    #[serde(default)]
    pub gap_width: f32,
    #[serde(default)]
    pub margin_left: f32,
    #[serde(default)]
    pub item_spacing: f32,
}

#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxColors {
    #[serde(default)]
    pub keyword: u32,
    #[serde(default)]
    pub operator_color: u32,
    #[serde(default)]
    pub punctuation: u32,
    #[serde(default)]
    pub string: u32,
    #[serde(default)]
    pub number: u32,
    #[serde(default)]
    pub constant: u32,
    #[serde(default)]
    pub comment: u32,
    #[serde(default)]
    pub function: u32,
    #[serde(default, rename = "type")]
    pub type_color: u32,
    #[serde(default)]
    pub variable: u32,
    #[serde(default)]
    pub property: u32,
    #[serde(default)]
    pub tag: u32,
    #[serde(default)]
    pub attribute: u32,
    #[serde(default)]
    pub embedded: u32,
}

impl SyntaxColors {
    /// Maps C++ `HighlightTokenType` discriminants (0..13) to foreground ARGB.
    pub fn color_for(&self, token_type: u8, fallback: u32) -> u32 {
        let color = match token_type {
            0 => self.keyword,
            1 => self.operator_color,
            2 => self.punctuation,
            3 => self.string,
            4 => self.number,
            5 => self.constant,
            6 => self.comment,
            7 => self.function,
            8 => self.type_color,
            9 => self.variable,
            10 => self.property,
            11 => self.tag,
            12 => self.attribute,
            13 => self.embedded,
            _ => 0,
        };
        if color != 0 {
            color
        } else {
            fallback
        }
    }
}

#[derive(Clone, Debug, Deserialize, Default)]
#[allow(dead_code)]
#[serde(rename_all = "camelCase")]
pub struct CodeBlockStyle {
    #[serde(default)]
    pub font_size: f32,
    #[serde(default)]
    pub font_family: String,
    #[serde(default)]
    pub font_weight: String,
    #[serde(default)]
    pub color: u32,
    #[serde(default)]
    pub margin_top: f32,
    #[serde(default)]
    pub margin_bottom: f32,
    #[serde(default)]
    pub line_height: f32,
    #[serde(default)]
    pub background_color: u32,
    #[serde(default)]
    pub border_color: u32,
    #[serde(default)]
    pub border_radius: f32,
    #[serde(default)]
    pub border_width: f32,
    #[serde(default)]
    pub padding: f32,
    #[serde(default)]
    pub syntax_colors: SyntaxColors,
}

#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LinkStyle {
    #[serde(default)]
    pub font_family: String,
    #[serde(default)]
    pub color: u32,
    #[serde(default)]
    pub underline: bool,
    #[serde(default)]
    pub background_color: u32,
}

#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StrongStyle {
    #[serde(default)]
    pub font_family: String,
    #[serde(default)]
    pub font_weight: String,
    #[serde(default)]
    pub color: u32,
}

#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EmphasisStyle {
    #[serde(default)]
    pub font_family: String,
    #[serde(default)]
    pub font_style: String,
    #[serde(default)]
    pub color: u32,
}

#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ColorOnlyStyle {
    #[serde(default)]
    pub color: u32,
}

#[derive(Clone, Debug, Deserialize, Default)]
#[allow(dead_code)]
#[serde(rename_all = "camelCase")]
pub struct CodeStyle {
    #[serde(default)]
    pub font_family: String,
    #[serde(default)]
    pub font_size: f32,
    #[serde(default)]
    pub font_scale: f32,
    #[serde(default)]
    pub color: u32,
    #[serde(default)]
    pub background_color: u32,
    #[serde(default)]
    pub border_color: u32,
}

#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ThematicBreakStyle {
    #[serde(default)]
    pub color: u32,
    #[serde(default)]
    pub height: f32,
    #[serde(default)]
    pub margin_top: f32,
    #[serde(default)]
    pub margin_bottom: f32,
}

#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TableStyle {
    #[serde(default)]
    pub font_size: f32,
    #[serde(default)]
    pub font_family: String,
    #[serde(default)]
    pub font_weight: String,
    #[serde(default)]
    pub color: u32,
    #[serde(default)]
    pub margin_top: f32,
    #[serde(default)]
    pub margin_bottom: f32,
    #[serde(default)]
    pub line_height: f32,
    #[serde(default)]
    pub header_font_family: String,
    #[serde(default)]
    pub header_background_color: u32,
    #[serde(default)]
    pub header_text_color: u32,
    #[serde(default)]
    pub row_even_background_color: u32,
    #[serde(default)]
    pub row_odd_background_color: u32,
    #[serde(default)]
    pub border_color: u32,
    #[serde(default)]
    pub border_width: f32,
    #[serde(default)]
    pub border_radius: f32,
    #[serde(default)]
    pub cell_padding_horizontal: f32,
    #[serde(default)]
    pub cell_padding_vertical: f32,
}

#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TaskListStyle {
    #[serde(default)]
    pub checked_color: u32,
    #[serde(default)]
    pub border_color: u32,
    #[serde(default)]
    pub checkbox_size: f32,
    #[serde(default)]
    pub checkbox_border_radius: f32,
    #[serde(default)]
    pub checkmark_color: u32,
    #[serde(default)]
    pub checked_text_color: u32,
    #[serde(default)]
    pub checked_strikethrough: bool,
}

#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HighlightStyle {
    #[serde(default)]
    pub color: u32,
    #[serde(default)]
    pub background_color: u32,
}

#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImageStyle {
    #[serde(default)]
    pub height: f32,
    #[serde(default)]
    pub max_height: f32,
    #[serde(default)]
    pub aspect_ratio: f32,
    #[serde(default)]
    pub border_radius: f32,
    #[serde(default)]
    pub margin_top: f32,
    #[serde(default)]
    pub margin_bottom: f32,
}

#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownStyle {
    #[serde(default)]
    pub paragraph: BlockStyle,
    #[serde(default)]
    pub h1: BlockStyle,
    #[serde(default)]
    pub h2: BlockStyle,
    #[serde(default)]
    pub h3: BlockStyle,
    #[serde(default)]
    pub h4: BlockStyle,
    #[serde(default)]
    pub h5: BlockStyle,
    #[serde(default)]
    pub h6: BlockStyle,
    #[serde(default)]
    pub blockquote: BlockquoteStyle,
    #[serde(default)]
    pub list: ListStyle,
    #[serde(default)]
    pub code_block: CodeBlockStyle,
    #[serde(default)]
    pub link: LinkStyle,
    #[serde(default)]
    pub strong: StrongStyle,
    #[serde(default)]
    pub em: EmphasisStyle,
    #[serde(default)]
    pub strikethrough: ColorOnlyStyle,
    #[serde(default)]
    pub underline: ColorOnlyStyle,
    #[serde(default)]
    pub code: CodeStyle,
    #[serde(default)]
    pub thematic_break: ThematicBreakStyle,
    #[serde(default)]
    pub table: TableStyle,
    #[serde(default)]
    pub task_list: TaskListStyle,
    #[serde(default)]
    pub highlight: HighlightStyle,
    #[serde(default)]
    pub image: ImageStyle,
}

pub fn normalize_font_family(family: &str) -> String {
    let first = family
        .split(',')
        .next()
        .map(str::trim)
        .unwrap_or("")
        .trim_matches(|c| c == '"' || c == '\'');
    match first {
        "" | "normal" | "System" | "sans-serif" | "system-ui" | "-apple-system"
        | "BlinkMacSystemFont" | "Segoe UI" | "Roboto" => {
            #[cfg(target_os = "linux")]
            {
                // DejaVu Sans only ships Regular and Bold on many Linux installs;
                // Nimbus Sans (URW base35) ships Regular, Bold, Italic, and Bold Italic.
                "Nimbus Sans".to_string()
            }
            #[cfg(not(target_os = "linux"))]
            {
                String::new()
            }
        }
        "monospace" | "ui-monospace" | "Menlo" | "Consolas" | "Monaco" | "Courier New"
        | "Courier" => "monospace".to_string(),
        other => other.to_string(),
    }
}

pub fn parse_font_weight(weight: &str) -> u16 {
    let trimmed = weight.trim();
    if trimmed.eq_ignore_ascii_case("bold") {
        return 700;
    }
    if trimmed.eq_ignore_ascii_case("semibold") {
        return 600;
    }
    if trimmed.eq_ignore_ascii_case("medium") {
        return 500;
    }
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("normal") {
        return 400;
    }
    trimmed.parse::<u16>().unwrap_or(400).clamp(100, 900)
}

pub fn argb_or(value: u32, fallback: u32) -> u32 {
    if value >> 24 == 0 {
        fallback
    } else {
        value
    }
}

pub fn hs_color(argb: u32) -> gpui::Hsla {
    let a = ((argb >> 24) & 0xFF) as f32 / 255.0;
    let r = ((argb >> 16) & 0xFF) as f32 / 255.0;
    let g = ((argb >> 8) & 0xFF) as f32 / 255.0;
    let b = (argb & 0xFF) as f32 / 255.0;
    gpui::Rgba { r, g, b, a }.into()
}

pub fn text_align_of(align: &str) -> RichTextAlign {
    match align.trim() {
        "center" => RichTextAlign::Center,
        "right" => RichTextAlign::Right,
        "left" => RichTextAlign::Left,
        _ => RichTextAlign::Natural,
    }
}

impl MarkdownStyle {
    pub fn heading_style(&self, level: usize) -> &BlockStyle {
        match level {
            1 => &self.h1,
            2 => &self.h2,
            3 => &self.h3,
            4 => &self.h4,
            5 => &self.h5,
            _ => &self.h6,
        }
    }
}
