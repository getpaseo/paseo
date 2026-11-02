//! Paragraph shaping shared by Fabric measurement and GPUI painting.
//!
//! Fabric asks for text measurements from its JS/layout thread. The GPUI
//! `TextSystem` is an `Arc`-shared, synchronized service, so this module shapes
//! there and keeps the paintable result in a bounded cache for the UI thread.

use gpui::{
    canvas, font, point, prelude::*, px, App, ContentMask, Font, FontStyle, FontWeight,
    IntoElement, SharedString, StrikethroughStyle, TextAlign, TextRun, UnderlineStyle, WrappedLine,
};
use rn_gpui_sys::ffi::{MeasureResult, ParagraphFlat, TextFragmentFlat};
use std::{
    borrow::Cow,
    collections::HashMap,
    hash::Hash,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, RwLock},
};

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
struct FragmentKey {
    text: String,
    font_family: String,
    font_size: u32,
    font_weight: u16,
    italic: bool,
    color: u32,
    line_height: u32,
    letter_spacing: u32,
    underline: bool,
    strikethrough: bool,
}

impl From<&TextFragmentFlat> for FragmentKey {
    fn from(fragment: &TextFragmentFlat) -> Self {
        Self {
            text: fragment.text.clone(),
            font_family: fragment.font_family.clone(),
            font_size: fragment.font_size.to_bits(),
            font_weight: fragment.font_weight,
            italic: fragment.italic,
            color: fragment.color,
            line_height: fragment.line_height.to_bits(),
            letter_spacing: fragment.letter_spacing.to_bits(),
            underline: fragment.underline,
            strikethrough: fragment.strikethrough,
        }
    }
}

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
struct ParagraphKey {
    fragments: Vec<FragmentKey>,
    width: u32,
    max_lines: i32,
    text_align: u8,
    ellipsize: u8,
}

impl ParagraphKey {
    fn new(paragraph: &ParagraphFlat, width: f32) -> Self {
        Self {
            fragments: paragraph.fragments.iter().map(FragmentKey::from).collect(),
            width: width.to_bits(),
            max_lines: paragraph.max_lines,
            text_align: paragraph.text_align,
            ellipsize: paragraph.ellipsize,
        }
    }
}

struct ShapedParagraph {
    lines: Vec<WrappedLine>,
    line_heights: Vec<f32>,
    width: f32,
    height: f32,
    text_align: TextAlign,
}

struct TextService {
    text_system: Arc<gpui::TextSystem>,
    cache: Mutex<HashMap<ParagraphKey, Arc<ShapedParagraph>>>,
}

static TEXT_SERVICE: OnceLock<Arc<TextService>> = OnceLock::new();
static FONT_ALIASES: OnceLock<RwLock<HashMap<String, String>>> = OnceLock::new();
static FONT_DATA: OnceLock<RwLock<HashMap<String, Arc<Vec<u8>>>>> = OnceLock::new();
const MAX_CACHED_PARAGRAPHS: usize = 256;

fn font_aliases() -> &'static RwLock<HashMap<String, String>> {
    FONT_ALIASES.get_or_init(|| RwLock::new(HashMap::new()))
}

fn font_data() -> &'static RwLock<HashMap<String, Arc<Vec<u8>>>> {
    FONT_DATA.get_or_init(|| RwLock::new(HashMap::new()))
}

/// A font family as a lookup key. React Native for Windows names a font file's
/// family `/Assets/File.ttf#Family`, and icon libraries ask for it that way once
/// `Platform.OS` is `windows`: the family after the `#` is the name the font
/// is registered under.
fn normalized_font_name(name: &str) -> String {
    let name = name.rsplit_once('#').map_or(name, |(_, family)| family);
    name.chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn remember_font(alias: &str, path: Option<&Path>, bytes: &[u8]) {
    let mut keys = vec![normalized_font_name(alias)];
    if let Some(stem) = path
        .and_then(Path::file_stem)
        .and_then(|stem| stem.to_str())
    {
        let stem = normalized_font_name(stem);
        keys.push(stem.clone());
        for suffix in [
            "regular",
            "semibold",
            "bold",
            "extrabold",
            "light",
            "medium",
        ] {
            if let Some(base) = stem.strip_suffix(suffix) {
                keys.push(base.to_owned());
            }
        }
    }
    let bytes = Arc::new(bytes.to_vec());
    let mut fonts = font_data()
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    for key in keys.into_iter().filter(|key| !key.is_empty()) {
        fonts.insert(key, bytes.clone());
    }
}

fn supported_font_file(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| matches!(extension.to_ascii_lowercase().as_str(), "ttf" | "otf"))
}

fn collect_font_files(directory: &Path, files: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_font_files(&path, files);
        } else if supported_font_file(&path) {
            files.push(path);
        }
    }
}

pub(crate) fn install_fonts(cx: &mut App) {
    let directory = crate::resources::default_assets_dir().map(|assets| assets.join("fonts"));
    if let Some(directory) = directory {
        let mut files = Vec::new();
        collect_font_files(&directory, &mut files);
        files.sort();
        if files.is_empty() {
            log::debug!("no desktop font assets found at {}", directory.display());
        } else {
            let fonts = files
                .iter()
                .filter_map(|path| {
                    let bytes = std::fs::read(path).ok()?;
                    let alias = path.file_stem()?.to_str()?;
                    remember_font(alias, Some(path), &bytes);
                    Some(Cow::Owned(bytes))
                })
                .collect();
            match cx.text_system().add_fonts(fonts) {
                Ok(()) => log::info!("registered {} bundled desktop font(s)", files.len()),
                Err(error) => log::warn!("failed to register desktop font assets: {error:#}"),
            }
        }
    }
    let text_system = cx.text_system().clone();
    let _ = rn_gpui_sys::FONT_LOAD_HANDLER.set(Box::new(move |family, uri| {
        let Some(bytes) = load_font_source(uri) else {
            return false;
        };
        install_custom_font(&text_system, family, &bytes)
    }));
    let _ = rn_gpui_sys::TEXT_IMAGE_HANDLER.set(Box::new(render_text_image));
}

fn load_font_source(uri: &str) -> Option<Vec<u8>> {
    if uri.starts_with("https://") || uri.starts_with("http://") {
        use futures::io::AsyncReadExt;
        use http_client::HttpClient;

        let client = crate::http_client::RnHttpClient::new();
        let mut response =
            futures::executor::block_on(client.get(uri, http_client::AsyncBody::empty(), true))
                .map_err(|error| log::warn!("failed to fetch font URI {uri}: {error:#}"))
                .ok()?;
        if !response.status().is_success() {
            log::warn!("font URI {uri} returned HTTP {}", response.status());
            return None;
        }
        let mut bytes = Vec::new();
        futures::executor::block_on(response.body_mut().read_to_end(&mut bytes))
            .map_err(|error| log::warn!("failed to read font URI {uri}: {error}"))
            .ok()?;
        return Some(bytes);
    }

    let path = crate::image_loader::file_uri_path(uri).unwrap_or_else(|| PathBuf::from(uri));
    match std::fs::read(&path) {
        Ok(bytes) => Some(bytes),
        Err(error) => {
            log::warn!("failed to read font file {}: {error}", path.display());
            None
        }
    }
}

fn install_custom_font(text_system: &gpui::TextSystem, alias: &str, bytes: &[u8]) -> bool {
    if alias.trim().is_empty() || bytes.is_empty() {
        return false;
    }
    let before = text_system.all_font_names();
    if let Err(error) = text_system.add_fonts(vec![Cow::Owned(bytes.to_vec())]) {
        log::warn!("could not add runtime font {alias}: {error:#}");
        return false;
    }
    let names = text_system.all_font_names();
    let family = names
        .iter()
        .find(|name| name.eq_ignore_ascii_case(alias))
        .or_else(|| {
            names.iter().find(|name| {
                !before.iter().any(|previous| previous == *name)
                    && name
                        .to_ascii_lowercase()
                        .contains(&alias.to_ascii_lowercase())
            })
        })
        .cloned()
        .unwrap_or_else(|| alias.to_owned());
    font_aliases()
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(alias.to_owned(), family);
    remember_font(alias, None, bytes);
    log::info!("registered runtime font {alias}");
    if let Some(service) = TEXT_SERVICE.get() {
        service
            .cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
    }
    true
}

fn render_text_image(family: &str, text: &str, font_size: f64, color: u32) -> String {
    use base64::Engine;
    use image::ImageEncoder;

    if !font_size.is_finite() || font_size <= 0.0 || font_size > 512.0 {
        return String::new();
    }
    let key = normalized_font_name(family);
    let bytes = font_data()
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&key)
        .cloned();
    let Some(bytes) = bytes else {
        log::warn!("icon font {family} is not loaded");
        return String::new();
    };
    let Ok(font) = fontdue::Font::from_bytes(bytes.as_slice(), fontdue::FontSettings::default())
    else {
        log::warn!("could not parse icon font {family}");
        return String::new();
    };
    let Some(glyph) = text.chars().next() else {
        return String::new();
    };
    let (metrics, coverage) = font.rasterize(glyph, font_size as f32);
    if metrics.width == 0 || metrics.height == 0 {
        return String::new();
    }
    let red = (color >> 16) as u8;
    let green = (color >> 8) as u8;
    let blue = color as u8;
    let opacity = (color >> 24) as u8;
    // Keep the complete glyph bitmap inside the source image with a small
    // transparent edge. Some icon fonts have glyphs wider than their em size;
    // returning the tight bitmap makes Image's default fill crop their sides.
    let requested_size = (font_size.ceil() as usize).max(1);
    let width = requested_size.max(metrics.width.saturating_add(4));
    let height = requested_size.max(metrics.height);
    let left = (width - metrics.width) / 2;
    let top = (height - metrics.height) / 2;
    let mut rgba = vec![0; width * height * 4];
    for (index, alpha) in coverage.into_iter().enumerate() {
        let source_x = index % metrics.width;
        let source_y = index / metrics.width;
        let target = ((top + source_y) * width + left + source_x) * 4;
        rgba[target..target + 4].copy_from_slice(&[
            red,
            green,
            blue,
            ((u16::from(alpha) * u16::from(opacity) + 127) / 255) as u8,
        ]);
    }
    let mut png = std::io::Cursor::new(Vec::new());
    if image::codecs::png::PngEncoder::new(&mut png)
        .write_image(
            &rgba,
            width as u32,
            height as u32,
            image::ExtendedColorType::Rgba8,
        )
        .is_err()
    {
        return String::new();
    }
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png.into_inner())
    )
}

/// What the generic `monospace` family (React Native Android's name for it)
/// resolves to.
#[cfg(target_os = "macos")]
const MONOSPACE_FAMILY: &str = "Menlo";
#[cfg(target_os = "windows")]
const MONOSPACE_FAMILY: &str = "Consolas";
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
const MONOSPACE_FAMILY: &str = "DejaVu Sans Mono";

fn font_size_of(size: f32) -> f32 {
    if size.is_finite() && size > 0.0 {
        size
    } else {
        14.0
    }
}

fn font_of(fragment: &TextFragmentFlat) -> Font {
    let family = font_aliases()
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&fragment.font_family)
        .cloned()
        .unwrap_or_else(|| fragment.font_family.clone());
    let family = match family.as_str() {
        "" => ".SystemUIFont",
        "monospace" => MONOSPACE_FAMILY,
        family => family,
    };
    let mut font = font(family);
    font.weight = FontWeight(f32::from(fragment.font_weight));
    if fragment.italic {
        font.style = FontStyle::Italic;
    }
    font
}

/// Measure the insertion point with the same font shaping GPUI uses to paint
/// the input text, so proportional fonts and Unicode land the caret correctly.
pub(crate) fn input_caret_x(
    text_system: &gpui::WindowTextSystem,
    paragraph: &ParagraphFlat,
    line: &str,
    byte_index: usize,
) -> f32 {
    if line.is_empty() {
        return 0.0;
    }
    let Some(fragment) = paragraph.fragments.first() else {
        return 0.0;
    };
    let font = font_of(fragment);
    let text = SharedString::from(line.to_owned());
    let run = TextRun {
        len: text.len(),
        font,
        color: crate::style::color(fragment.color),
        background_color: None,
        underline: None,
        strikethrough: None,
    };
    f32::from(
        text_system
            .shape_line(text, px(font_size_of(fragment.font_size)), &[run], None)
            .x_for_index(byte_index.min(line.len())),
    )
}

pub(crate) fn input_index_for_x(
    text_system: &gpui::WindowTextSystem,
    paragraph: &ParagraphFlat,
    line: &str,
    x: f32,
) -> usize {
    if line.is_empty() {
        return 0;
    }
    let Some(fragment) = paragraph.fragments.first() else {
        return 0;
    };
    let font = font_of(fragment);
    let text = SharedString::from(line.to_owned());
    let run = TextRun {
        len: text.len(),
        font,
        color: crate::style::color(fragment.color),
        background_color: None,
        underline: None,
        strikethrough: None,
    };
    text_system
        .shape_line(text, px(font_size_of(fragment.font_size)), &[run], None)
        .closest_index_for_x(px(x.max(0.0)))
}

fn make_runs(paragraph: &ParagraphFlat) -> (String, Vec<TextRun>) {
    let mut text = String::new();
    let mut runs = Vec::with_capacity(paragraph.fragments.len());
    for fragment in &paragraph.fragments {
        if fragment.text.is_empty() {
            continue;
        }
        let color = crate::style::color(if fragment.color == 0 {
            0xFF00_0000
        } else {
            fragment.color
        });
        runs.push(TextRun {
            len: fragment.text.len(),
            font: font_of(fragment),
            color,
            background_color: None,
            underline: fragment.underline.then_some(UnderlineStyle {
                thickness: px(1.0),
                color: None,
                wavy: false,
            }),
            strikethrough: fragment.strikethrough.then_some(StrikethroughStyle {
                thickness: px(1.0),
                color: None,
            }),
        });
        text.push_str(&fragment.text);
    }
    (text, runs)
}

fn text_align(value: u8) -> TextAlign {
    match value {
        2 => TextAlign::Center,
        3 | 6 => TextAlign::Right,
        _ => TextAlign::Left,
    }
}

impl TextService {
    fn shape(&self, paragraph: &ParagraphFlat, width: f32) -> Arc<ShapedParagraph> {
        let width = if width.is_finite() && width > 0.0 {
            width
        } else {
            f32::MAX
        };
        let key = ParagraphKey::new(paragraph, width);
        if let Some(shaped) = self
            .cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&key)
            .cloned()
        {
            return shaped;
        }

        let (mut text, mut runs) = make_runs(paragraph);
        let font_size = paragraph
            .fragments
            .iter()
            .find(|fragment| !fragment.text.is_empty())
            .map(|fragment| font_size_of(fragment.font_size))
            .unwrap_or(14.0);
        let base_font = paragraph
            .fragments
            .iter()
            .find(|fragment| !fragment.text.is_empty())
            .map(font_of)
            .unwrap_or_default();

        if paragraph.max_lines > 0 && !text.is_empty() && width < f32::MAX {
            let mut wrapper = self.text_system.line_wrapper(base_font, px(font_size));
            let truncation = match paragraph.ellipsize {
                1 => Some(gpui::TruncateFrom::Start),
                2 => Some(gpui::TruncateFrom::Middle),
                3 => Some(gpui::TruncateFrom::End), // clipped below to the same line limit
                _ => Some(gpui::TruncateFrom::End),
            };
            if let Some(direction) = truncation {
                let affix = if paragraph.ellipsize == 3 { "" } else { "…" };
                let (truncated, truncated_runs) = wrapper.truncate_wrapped_line(
                    SharedString::from(text),
                    px(width),
                    paragraph.max_lines as usize,
                    affix,
                    &runs,
                    direction,
                );
                text = truncated.to_string();
                runs = truncated_runs.into_owned();
            }
        }

        let window_text_system = gpui::WindowTextSystem::new(self.text_system.clone());
        let shaped_lines = window_text_system
            .shape_text(
                SharedString::from(text),
                px(font_size),
                &runs,
                (width < f32::MAX).then_some(px(width)),
                (paragraph.max_lines > 0).then_some(paragraph.max_lines as usize),
            )
            .unwrap_or_default();

        let explicit_line_height = paragraph
            .fragments
            .iter()
            .map(|fragment| fragment.line_height)
            .find(|height| height.is_finite() && *height > 0.0);
        let mut lines = Vec::with_capacity(shaped_lines.len());
        let mut line_heights = Vec::with_capacity(shaped_lines.len());
        let mut measured_width = 0.0f32;
        let mut measured_height = 0.0f32;
        for line in shaped_lines {
            let line_height = explicit_line_height
                .unwrap_or_else(|| f32::from(line.ascent() + line.descent()).max(1.0));
            let visual_lines = line.wrap_boundaries.len() + 1;
            measured_width = measured_width.max(f32::from(line.width()));
            measured_height += line_height * visual_lines as f32;
            lines.push(line);
            line_heights.push(line_height);
        }

        let shaped = Arc::new(ShapedParagraph {
            lines,
            line_heights,
            width: measured_width.min(width),
            height: measured_height,
            text_align: text_align(paragraph.text_align),
        });
        let mut cache = self
            .cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if cache.len() >= MAX_CACHED_PARAGRAPHS {
            cache.clear();
        }
        cache.insert(key, shaped.clone());
        shaped
    }
}

pub fn install_measure_handler(cx: &mut App) {
    let service = Arc::new(TextService {
        text_system: cx.text_system().clone(),
        cache: Mutex::new(HashMap::new()),
    });
    let _ = TEXT_SERVICE.set(service.clone());
    let _ = rn_gpui_sys::MEASURE_HANDLER.set(Box::new(move |paragraph, width, _height| {
        let shaped = service.shape(paragraph, width);
        MeasureResult {
            width: shaped.width.ceil(),
            height: shaped.height.ceil(),
        }
    }));
}

pub fn paragraph_element(paragraph: &ParagraphFlat, width: f32, height: f32) -> impl IntoElement {
    let shaped = TEXT_SERVICE
        .get()
        .map(|service| service.shape(paragraph, width))
        .unwrap_or_else(|| {
            Arc::new(ShapedParagraph {
                lines: Vec::new(),
                line_heights: Vec::new(),
                width,
                height,
                text_align: text_align(paragraph.text_align),
            })
        });
    let align = shaped.text_align;
    log::debug!(
        "[text] cached shape: {:.1}x{:.1} at width {:.1}; mounted {:.1}x{:.1}; {} hard lines",
        shaped.width,
        shaped.height,
        width,
        width,
        height,
        shaped.lines.len()
    );
    canvas(
        |_, _, _| (),
        move |bounds, (), window, cx| {
            let mut y = bounds.origin.y;
            window.with_content_mask(Some(ContentMask::new(bounds)), |window| {
                for (line, line_height) in shaped.lines.iter().zip(&shaped.line_heights) {
                    if line
                        .paint(
                            point(bounds.origin.x, y),
                            px(*line_height),
                            align,
                            Some(bounds),
                            window,
                            cx,
                        )
                        .is_err()
                    {
                        log::error!("failed to paint a shaped React Native text line");
                    }
                    y += px(*line_height * (line.wrap_boundaries.len() + 1) as f32);
                }
            });
        },
    )
    .w(px(width.max(0.0)))
    .h(px(height.max(0.0)))
}

#[cfg(test)]
mod font_name_tests {
    use super::normalized_font_name;

    #[test]
    fn a_windows_font_reference_names_the_family_after_the_hash() {
        assert_eq!(
            normalized_font_name("/Assets/MaterialIcons-Regular.ttf#Material Icons"),
            normalized_font_name("Material Icons")
        );
    }

    #[test]
    fn a_plain_family_is_unchanged() {
        assert_eq!(normalized_font_name("Material Icons"), "materialicons");
    }
}
