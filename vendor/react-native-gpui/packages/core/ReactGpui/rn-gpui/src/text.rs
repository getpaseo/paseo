//! Paragraph shaping shared by Fabric measurement and GPUI painting.
//!
//! Fabric asks for text measurements from its JS/layout thread. The GPUI
//! `TextSystem` is an `Arc`-shared, synchronized service, so this module shapes
//! there and keeps the paintable result in a bounded cache for the UI thread.

use gpui::{
    canvas, font, point, prelude::*, px, App, ContentMask, Font, FontStyle, FontWeight,
    SharedString, StrikethroughStyle, TextAlign, TextRun, UnderlineStyle, WrappedLine,
};
use rn_gpui_sys::ffi::{LineFlat, MeasureResult, ParagraphFlat, TextFragmentFlat};
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
    text_transform: u8,
    font_variant: u32,
    background_color: u32,
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
            text_transform: fragment.text_transform,
            font_variant: fragment.font_variant,
            background_color: fragment.background_color,
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
    fit: Option<u32>,
    scale: u32,
    empty_line: bool,
}

impl ParagraphKey {
    fn new(paragraph: &ParagraphFlat, width: f32) -> Self {
        Self {
            fragments: paragraph.fragments.iter().map(FragmentKey::from).collect(),
            width: width.to_bits(),
            max_lines: paragraph.max_lines,
            text_align: resolve_alignment(paragraph.text_align),
            ellipsize: paragraph.ellipsize,
            fit: paragraph
                .adjusts_to_fit
                .then_some(paragraph.min_font_scale.to_bits()),
            scale: device_scale().to_bits(),
            empty_line: paragraph.measure_empty_line,
        }
    }
}

struct ShapedParagraph {
    lines: Vec<WrappedLine>,
    line_heights: Vec<f32>,
    /// Per line, the ascent and descent of the tallest font it uses, fallback
    /// fonts included, unrounded.
    line_metrics: Vec<(f32, f32)>,
    width: f32,
    height: f32,
    visual_lines: usize,
    text_align: TextAlign,
}

struct TextService {
    text_system: Arc<gpui::TextSystem>,
    cache: Mutex<ParagraphCache>,
}

const MAX_CACHED_PARAGRAPHS: usize = 12_288;
const MAX_CACHED_BYTES: usize = 48 << 20;

struct CacheEntry {
    shaped: Arc<ShapedParagraph>,
    used: u64,
    bytes: usize,
}

/// Shaped paragraphs bounded by count and by approximate size. Past either
/// bound the least recently used quarter goes, so a screenful of text that was
/// shaped off the main thread is still there when it is painted.
#[derive(Default)]
struct ParagraphCache {
    entries: HashMap<ParagraphKey, CacheEntry>,
    bytes: usize,
    clock: u64,
}

impl ParagraphCache {
    fn get(&mut self, key: &ParagraphKey) -> Option<Arc<ShapedParagraph>> {
        self.clock += 1;
        let clock = self.clock;
        self.entries.get_mut(key).map(|entry| {
            entry.used = clock;
            entry.shaped.clone()
        })
    }

    fn insert(&mut self, key: ParagraphKey, shaped: Arc<ShapedParagraph>) {
        self.clock += 1;
        let bytes = key
            .fragments
            .iter()
            .map(|fragment| fragment.text.len())
            .sum::<usize>()
            * 48
            + shaped.lines.len() * 256
            + 512;
        if let Some(previous) = self.entries.insert(
            key,
            CacheEntry {
                shaped,
                used: self.clock,
                bytes,
            },
        ) {
            self.bytes -= previous.bytes;
        }
        self.bytes += bytes;
        if self.entries.len() > MAX_CACHED_PARAGRAPHS || self.bytes > MAX_CACHED_BYTES {
            self.evict();
        }
    }

    fn evict(&mut self) {
        let mut stamps: Vec<u64> = self.entries.values().map(|entry| entry.used).collect();
        let cut = stamps.len() / 4;
        let (_, threshold, _) = stamps.select_nth_unstable(cut);
        let threshold = *threshold;
        self.entries.retain(|_, entry| entry.used > threshold);
        self.bytes = self.entries.values().map(|entry| entry.bytes).sum();
    }

    fn clear(&mut self) {
        self.entries.clear();
        self.bytes = 0;
    }
}

/// A paragraph shaped off the main thread, kept with the node that paints it.
/// `width` is the content width it was shaped for.
#[derive(Clone)]
pub struct PreparedParagraph {
    shaped: Arc<ShapedParagraph>,
    width: f32,
}

impl PreparedParagraph {
    pub(crate) fn fits(&self, width: f32) -> bool {
        (self.width - width).abs() <= 0.05
    }
}

/// Takes the paragraph a handle from `rn_gpui_prepare_text` stands for.
pub(crate) fn take_prepared(handle: u64, width: f32) -> Option<PreparedParagraph> {
    rn_gpui_sys::take_prepared(handle)
        .and_then(|any| any.downcast::<ShapedParagraph>().ok())
        .map(|shaped| PreparedParagraph { shaped, width })
}

static TEXT_SERVICE: OnceLock<Arc<TextService>> = OnceLock::new();
static DEVICE_SCALE: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0x3f80_0000);

/// The pixel density line metrics are rounded at. A browser lays text out in
/// device pixels, so a line is a whole number of them.
pub(crate) fn set_device_scale(scale: f32) {
    if scale.is_finite() && scale > 0.0 {
        DEVICE_SCALE.store(scale.to_bits(), std::sync::atomic::Ordering::Relaxed);
    }
}

fn device_scale() -> f32 {
    f32::from_bits(DEVICE_SCALE.load(std::sync::atomic::Ordering::Relaxed))
}
static FONT_ALIASES: OnceLock<RwLock<HashMap<String, String>>> = OnceLock::new();
static FONT_DATA: OnceLock<RwLock<HashMap<String, Arc<Vec<u8>>>>> = OnceLock::new();

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

/// The OpenType features `fontVariant` asks for.
fn variant_features(variant: u32) -> Vec<(String, u32)> {
    const TAGS: [(u32, &str); 5] = [
        (1 << 1, "smcp"),
        (1 << 2, "onum"),
        (1 << 3, "lnum"),
        (1 << 4, "tnum"),
        (1 << 5, "pnum"),
    ];
    let mut features: Vec<(String, u32)> = TAGS
        .iter()
        .filter(|(bit, _)| variant & bit != 0)
        .map(|(_, tag)| ((*tag).to_owned(), 1))
        .collect();
    // `stylistic-one` to `stylistic-twenty` are `ss01` to `ss20`.
    for set in 1..=20u32 {
        if variant & (1 << (5 + set)) != 0 {
            features.push((format!("ss{set:02}"), 1));
        }
    }
    features
}

/// The fragment's text with its `textTransform` applied.
pub(crate) fn fragment_text(fragment: &TextFragmentFlat) -> std::borrow::Cow<'_, str> {
    use std::borrow::Cow;
    match fragment.text_transform {
        1 => Cow::Owned(fragment.text.to_uppercase()),
        2 => Cow::Owned(fragment.text.to_lowercase()),
        3 => {
            let mut out = String::with_capacity(fragment.text.len());
            let mut word_start = true;
            for ch in fragment.text.chars() {
                if word_start && ch.is_alphabetic() {
                    out.extend(ch.to_uppercase());
                } else {
                    out.push(ch);
                }
                word_start = ch.is_whitespace();
            }
            Cow::Owned(out)
        }
        _ => Cow::Borrowed(fragment.text.as_str()),
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
    if fragment.font_variant != 0 {
        font.features =
            gpui::FontFeatures(std::sync::Arc::new(variant_features(fragment.font_variant)));
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
        let shown = fragment_text(fragment);
        runs.push(TextRun {
            len: shown.len(),
            font: font_of(fragment),
            color,
            background_color: (fragment.background_color >> 24 != 0)
                .then(|| crate::style::color(fragment.background_color)),
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
        text.push_str(&shown);
    }
    (text, runs)
}

/// `natural` and `start` follow the trailing edge's mirror in a right-to-left
/// layout, `end` the leading one; `left` and `right` stay literal.
fn resolve_alignment(value: u8) -> u8 {
    if !crate::builtins::i18n::rtl_active() {
        return value;
    }
    match value {
        0 | 5 => 3,
        6 => 1,
        other => other,
    }
}

fn text_align(value: u8) -> TextAlign {
    match value {
        2 => TextAlign::Center,
        3 | 6 => TextAlign::Right,
        _ => TextAlign::Left,
    }
}

/// `paragraph` with every font size and line height multiplied by `scale`.
fn scaled(paragraph: &ParagraphFlat, scale: f32) -> ParagraphFlat {
    let mut next = paragraph.clone();
    for fragment in &mut next.fragments {
        fragment.font_size = font_size_of(fragment.font_size) * scale;
        fragment.line_height *= scale;
    }
    next
}

impl TextService {
    /// The largest scale, down to the paragraph's minimum, at which the text
    /// fits in `max_lines`; the paragraph at that scale, without the fit flag.
    fn fit_paragraph(&self, paragraph: &ParagraphFlat, width: f32) -> ParagraphFlat {
        let floor = if paragraph.min_font_scale > 0.0 {
            paragraph.min_font_scale.min(1.0)
        } else {
            0.1
        };
        let mut probe = paragraph.clone();
        probe.adjusts_to_fit = false;
        probe.max_lines = 0;
        let mut scale = 1.0f32;
        loop {
            let shaped = self.shape(&scaled(&probe, scale), width);
            if shaped.visual_lines <= paragraph.max_lines as usize || scale <= floor {
                break;
            }
            scale = (scale * 0.95).max(floor);
        }
        let mut fitted = scaled(paragraph, scale);
        fitted.adjusts_to_fit = false;
        fitted
    }

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
        {
            return shaped;
        }

        if paragraph.adjusts_to_fit && paragraph.max_lines > 0 && width < f32::MAX {
            let fitted = self.fit_paragraph(paragraph, width);
            let shaped = self.shape(&fitted, width);
            self.cache
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .insert(key, shaped.clone());
            return shaped;
        }

        let (mut text, mut runs) = make_runs(paragraph);
        let base_fragment = paragraph
            .fragments
            .iter()
            .find(|fragment| !fragment.text.is_empty())
            .or_else(|| paragraph.fragments.first());
        let font_size = base_fragment
            .map(|fragment| font_size_of(fragment.font_size))
            .unwrap_or(14.0);
        let base_font = base_fragment.map(font_of).unwrap_or_default();

        let window_text_system = gpui::WindowTextSystem::new(self.text_system.clone());
        // The box a text was measured into is rounded to the pixel grid, so it can
        // be a hair narrower than the text it was measured for. Text that fits
        // within that hair is not truncated, and keeps its line.
        const ROUNDING_SLACK: f32 = 0.5;
        let mut wrap_width = width;
        let mut fits = false;
        let mut was_truncated = false;
        if paragraph.max_lines > 0 && !text.is_empty() && width < f32::MAX {
            let probe = window_text_system
                .shape_text(
                    SharedString::from(text.clone()),
                    px(font_size),
                    &runs,
                    Some(px(width + ROUNDING_SLACK)),
                    None,
                )
                .unwrap_or_default();
            let lines: usize = probe
                .iter()
                .map(|line| line.wrap_boundaries.len() + 1)
                .sum();
            fits = lines <= paragraph.max_lines as usize;
            if fits {
                wrap_width = width + ROUNDING_SLACK;
            }
        }

        if !fits && paragraph.max_lines > 0 && !text.is_empty() && width < f32::MAX {
            let mut wrapper = self
                .text_system
                .line_wrapper(base_font.clone(), px(font_size));
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
                was_truncated = true;
            }
        }

        let shaped_lines = window_text_system
            .shape_text(
                SharedString::from(text),
                px(font_size),
                &runs,
                (width < f32::MAX).then_some(px(wrap_width)),
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
        let mut line_metrics = Vec::with_capacity(shaped_lines.len());
        let mut measured_width = 0.0f32;
        let mut measured_height = 0.0f32;
        for line in shaped_lines {
            let (mut ascent, mut descent) = (f32::from(line.ascent()), f32::from(line.descent()));
            for run in line.runs() {
                if run.glyphs.iter().all(|glyph| glyph.is_emoji) {
                    continue;
                }
                let size = px(font_size);
                ascent = ascent.max(f32::from(self.text_system.ascent(run.font_id, size)));
                descent = descent.max(f32::from(self.text_system.descent(run.font_id, size)).abs());
            }
            let line_height = explicit_line_height.unwrap_or_else(|| {
                let scale = device_scale();
                (((ascent * scale).round() + (descent * scale).round()) / scale).max(1.0)
            });
            line_metrics.push((ascent, descent));
            let visual_lines = line.wrap_boundaries.len() + 1;
            measured_width = measured_width.max(f32::from(line.width()));
            measured_height += line_height * visual_lines as f32;
            lines.push(line);
            line_heights.push(line_height);
        }

        if paragraph.measure_empty_line {
            let font_id = self.text_system.resolve_font(&base_font);
            let size = px(font_size);
            let ascent = f32::from(self.text_system.ascent(font_id, size));
            let descent = f32::from(self.text_system.descent(font_id, size)).abs();
            measured_height = explicit_line_height.unwrap_or_else(|| {
                let scale = device_scale();
                (((ascent * scale).round() + (descent * scale).round()) / scale).max(1.0)
            });
        }

        let visual_lines = lines
            .iter()
            .map(|line| line.wrap_boundaries.len() + 1)
            .sum();
        let shaped = Arc::new(ShapedParagraph {
            lines,
            line_heights,
            line_metrics,
            width: if was_truncated {
                width
            } else {
                measured_width.min(width)
            },
            height: measured_height,
            visual_lines,
            text_align: text_align(resolve_alignment(paragraph.text_align)),
        });
        let mut cache = self
            .cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        cache.insert(key, shaped.clone());
        shaped
    }
}

pub fn install_measure_handler(cx: &mut App) {
    let service = Arc::new(TextService {
        text_system: cx.text_system().clone(),
        cache: Mutex::new(ParagraphCache::default()),
    });
    let _ = TEXT_SERVICE.set(service.clone());
    let lines_service = service.clone();
    let _ = rn_gpui_sys::LINES_HANDLER.set(Box::new(move |paragraph, width| {
        measure_lines(&lines_service, paragraph, width)
    }));
    let prepare_service = service.clone();
    let _ = rn_gpui_sys::PREPARE_HANDLER.set(Box::new(move |paragraph, width| {
        let shaped = prepare_service.shape(paragraph, width);
        let scale = device_scale();
        (
            shaped.clone() as Arc<dyn std::any::Any + Send + Sync>,
            MeasureResult {
                width: shaped.width,
                height: (shaped.height * scale).round() / scale,
            },
        )
    }));
    let _ = rn_gpui_sys::MEASURE_HANDLER.set(Box::new(move |paragraph, width, _height| {
        let shaped = service.shape(paragraph, width);
        let scale = device_scale();
        MeasureResult {
            width: shaped.width,
            height: (shaped.height * scale).round() / scale,
        }
    }));
}

/// How a piece of text is set, for a host component that measures it.
#[derive(Clone, Debug, PartialEq)]
pub struct TextStyle {
    /// The font family; empty for the system font.
    pub family: String,
    pub size: f32,
    /// 100 to 900.
    pub weight: u16,
    pub italic: bool,
    /// Zero for the font's own line height.
    pub line_height: f32,
    pub letter_spacing: f32,
    /// Lines to show before cutting the text short, zero for all.
    pub max_lines: u32,
}

impl Default for TextStyle {
    fn default() -> Self {
        Self {
            family: String::new(),
            size: 14.0,
            weight: 400,
            italic: false,
            line_height: 0.0,
            letter_spacing: 0.0,
            max_lines: 0,
        }
    }
}

/// What a text takes once set.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TextExtent {
    pub width: f32,
    pub height: f32,
}

/// Sets `text` in `style`, wrapped to `max_width` when given, and returns the
/// room it takes, with the rounding Fabric's own text gets. Safe from the layout
/// thread. `None` before the text system exists, which is before the app starts.
pub fn measure_text(text: &str, style: &TextStyle, max_width: Option<f32>) -> Option<TextExtent> {
    let service = TEXT_SERVICE.get()?;
    let paragraph = ParagraphFlat {
        fragments: vec![TextFragmentFlat {
            text: text.to_string(),
            font_family: style.family.clone(),
            font_size: style.size,
            font_weight: style.weight,
            italic: style.italic,
            line_height: style.line_height,
            letter_spacing: style.letter_spacing,
            ..Default::default()
        }],
        max_lines: style.max_lines as i32,
        ..Default::default()
    };
    let shaped = service.shape(&paragraph, max_width.unwrap_or(f32::MAX));
    let scale = device_scale();
    Some(TextExtent {
        width: shaped.width,
        height: (shaped.height * scale).round() / scale,
    })
}

/// The height of the paragraph laid out on one line, or 0 when it is empty.
pub(crate) fn single_line_height(paragraph: &ParagraphFlat) -> f32 {
    TEXT_SERVICE
        .get()
        .map_or(0.0, |service| service.shape(paragraph, f32::MAX).height)
}

/// Every laid-out row of the paragraph, as `onTextLayout` reports them.
fn measure_lines(service: &TextService, paragraph: &ParagraphFlat, width: f32) -> Vec<LineFlat> {
    let shaped = service.shape(paragraph, width);
    let mut rows = Vec::with_capacity(shaped.visual_lines);
    let mut top = 0.0f32;
    for (line, line_height) in shaped.lines.iter().zip(&shaped.line_heights) {
        let lh = px(*line_height);
        let count = line.wrap_boundaries.len() + 1;
        let starts: Vec<usize> = (0..count)
            .map(|row| {
                if row == 0 {
                    return 0;
                }
                let probe = point(px(0.0), lh * row as f32 + lh * 0.5);
                line.closest_index_for_position(probe, lh)
                    .unwrap_or_else(|nearest| nearest)
                    .min(line.len())
            })
            .collect();
        for (row, start) in starts.iter().enumerate() {
            let end = starts.get(row + 1).copied().unwrap_or_else(|| line.len());
            let from = f32::from(line.position_for_index(*start, lh).unwrap_or_default().x);
            let to = f32::from(line.position_for_index(end, lh).unwrap_or_default().x);
            let ascent = f32::from(line.ascent());
            rows.push(LineFlat {
                text: line.text.get(*start..end).unwrap_or_default().to_string(),
                x: from,
                y: top + row as f32 * line_height,
                width: if row + 1 == count {
                    f32::from(line.width()) - from
                } else {
                    (to - from).max(0.0)
                },
                height: *line_height,
                ascender: ascent,
                descender: f32::from(line.descent()),
                cap_height: ascent * 0.7,
                x_height: ascent * 0.5,
            });
        }
        top += line_height * count as f32;
    }
    rows
}

/// A paragraph shaped for a width, ready to paint into a box.
pub(crate) struct ParagraphPainter {
    shaped: Arc<ShapedParagraph>,
    shadow: Option<Vec<ShadowLayer>>,
    reach: f32,
}

impl ParagraphPainter {
    pub(crate) fn new(
        paragraph: &ParagraphFlat,
        width: f32,
        height: f32,
        prepared: Option<&PreparedParagraph>,
    ) -> Self {
        let shaped = prepared
            .filter(|prepared| prepared.fits(width))
            .map(|prepared| prepared.shaped.clone())
            .or_else(|| {
                TEXT_SERVICE
                    .get()
                    .map(|service| service.shape(paragraph, width))
            })
            .unwrap_or_else(|| {
                Arc::new(ShapedParagraph {
                    lines: Vec::new(),
                    line_heights: Vec::new(),
                    line_metrics: Vec::new(),
                    visual_lines: 0,
                    width,
                    height,
                    text_align: text_align(resolve_alignment(paragraph.text_align)),
                })
            });
        log::debug!(
            "[text] cached shape: {:.1}x{:.1} at width {:.1}; mounted {:.1}x{:.1}; {} hard lines",
            shaped.width,
            shaped.height,
            width,
            width,
            height,
            shaped.lines.len()
        );
        let shadow = (paragraph.shadow_color >> 24 != 0).then(|| shadow_layers(paragraph, width));
        let reach = paragraph.shadow_radius.max(0.0)
            + paragraph.shadow_dx.abs().max(paragraph.shadow_dy.abs());
        Self {
            shaped,
            shadow,
            reach,
        }
    }

    /// Paints the text and its shadow, clipped to `bounds` (the shadow to
    /// `bounds` grown by its reach).
    pub(crate) fn paint(
        &self,
        bounds: gpui::Bounds<gpui::Pixels>,
        window: &mut gpui::Window,
        cx: &mut App,
    ) {
        let reach = self.reach;
        if let Some(layers) = self.shadow.as_ref() {
            let wide = gpui::Bounds {
                origin: bounds.origin - point(px(reach), px(reach)),
                size: gpui::size(
                    bounds.size.width + px(reach * 2.0),
                    bounds.size.height + px(reach * 2.0),
                ),
            };
            window.with_content_mask(Some(ContentMask { bounds: wide }), |window| {
                for layer in layers {
                    for (dx, dy) in &layer.offsets {
                        let origin = bounds.origin
                            + point(px(paragraph_dx(layer, *dx)), px(paragraph_dy(layer, *dy)));
                        paint_lines(&layer.shaped, origin, wide, window, cx);
                    }
                }
            });
        }
        window.with_content_mask(Some(ContentMask { bounds }), |window| {
            paint_lines(&self.shaped, bounds.origin, bounds, window, cx);
        });
    }
}

pub fn paragraph_element(
    paragraph: &ParagraphFlat,
    width: f32,
    height: f32,
    prepared: Option<&PreparedParagraph>,
) -> gpui::Canvas<()> {
    let painter = ParagraphPainter::new(paragraph, width, height, prepared);
    canvas(
        |_, _, _| (),
        move |bounds, (), window, cx| painter.paint(bounds, window, cx),
    )
    .w(px(width.max(0.0)))
    .h(px(height.max(0.0)))
}

/// A painter with where its box sits in the node and how big it is.
pub(crate) type ParagraphOverlayParts = (
    ParagraphPainter,
    gpui::Point<gpui::Pixels>,
    gpui::Size<gpui::Pixels>,
);

/// `child` with a paragraph painted over it at `offset` from its top-left
/// corner, the way a text child would be painted last, without a layout node.
pub(crate) struct ParagraphOverlay {
    child: gpui::AnyElement,
    painter: ParagraphPainter,
    offset: gpui::Point<gpui::Pixels>,
    size: gpui::Size<gpui::Pixels>,
    /// Whether the text is clipped to the child's box, as the child's own
    /// `overflow: hidden` would clip a text child.
    clip: bool,
}

impl ParagraphOverlay {
    pub(crate) fn new(
        child: impl IntoElement,
        painter: ParagraphPainter,
        offset: gpui::Point<gpui::Pixels>,
        size: gpui::Size<gpui::Pixels>,
        clip: bool,
    ) -> Self {
        Self {
            child: child.into_any_element(),
            painter,
            offset,
            size,
            clip,
        }
    }
}

impl IntoElement for ParagraphOverlay {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl gpui::Element for ParagraphOverlay {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<gpui::ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&gpui::GlobalElementId>,
        _inspector_id: Option<&gpui::InspectorElementId>,
        window: &mut gpui::Window,
        cx: &mut App,
    ) -> (gpui::LayoutId, Self::RequestLayoutState) {
        (self.child.request_layout(window, cx), ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&gpui::GlobalElementId>,
        _inspector_id: Option<&gpui::InspectorElementId>,
        _bounds: gpui::Bounds<gpui::Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        window: &mut gpui::Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        self.child.prepaint(window, cx);
    }

    fn paint(
        &mut self,
        _id: Option<&gpui::GlobalElementId>,
        _inspector_id: Option<&gpui::InspectorElementId>,
        bounds: gpui::Bounds<gpui::Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        _prepaint: &mut Self::PrepaintState,
        window: &mut gpui::Window,
        cx: &mut App,
    ) {
        self.child.paint(window, cx);
        let text = gpui::Bounds {
            origin: bounds.origin + self.offset,
            size: self.size,
        };
        if self.clip {
            window.with_content_mask(Some(ContentMask { bounds }), |window| {
                self.painter.paint(text, window, cx)
            });
        } else {
            self.painter.paint(text, window, cx);
        }
    }
}

/// The paragraph's text as the shaper sees it, fragments joined.
pub(crate) fn paragraph_text(paragraph: &ParagraphFlat) -> String {
    paragraph.fragments.iter().map(fragment_text).collect()
}

/// The byte offset in the paragraph's text closest to a point in its box.
pub(crate) fn text_index_at(
    paragraph: &ParagraphFlat,
    width: f32,
    x: f32,
    y: f32,
) -> Option<usize> {
    let shaped = TEXT_SERVICE.get()?.shape(paragraph, width);
    let mut top = 0.0f32;
    let mut offset = 0usize;
    let last = shaped.lines.len().checked_sub(1)?;
    for (index, (line, line_height)) in shaped.lines.iter().zip(&shaped.line_heights).enumerate() {
        let height = line_height * (line.wrap_boundaries.len() + 1) as f32;
        if y < top + height || index == last {
            let local = point(px(x), px((y - top).max(0.0)));
            let within = line
                .closest_index_for_position(local, px(*line_height))
                .unwrap_or_else(|nearest| nearest);
            return Some(offset + within.min(line.len()));
        }
        top += height;
        offset += line.len() + 1;
    }
    None
}

/// The rectangles `(x, y, width, height)` a byte range covers, row by row.
pub(crate) fn text_range_rects(
    paragraph: &ParagraphFlat,
    width: f32,
    range: std::ops::Range<usize>,
) -> Vec<(f32, f32, f32, f32)> {
    let mut rects = Vec::new();
    let Some(shaped) = TEXT_SERVICE
        .get()
        .map(|service| service.shape(paragraph, width))
    else {
        return rects;
    };
    let mut top = 0.0f32;
    let mut offset = 0usize;
    for (line, line_height) in shaped.lines.iter().zip(&shaped.line_heights) {
        let rows = line.wrap_boundaries.len() + 1;
        let start = range.start.max(offset);
        let end = range.end.min(offset + line.len());
        if start < end || (range.start <= offset + line.len() && range.end > offset + line.len()) {
            let from = start.saturating_sub(offset).min(line.len());
            let to = end.saturating_sub(offset).min(line.len());
            let lh = px(*line_height);
            let a = line.position_for_index(from, lh).unwrap_or_default();
            let b = line.position_for_index(to, lh).unwrap_or_default();
            let row_a = (f32::from(a.y) / line_height).floor() as usize;
            let row_b = (f32::from(b.y) / line_height).floor() as usize;
            // A selection that runs on past this line's end covers its newline.
            let newline = range.end > offset + line.len();
            for row in row_a..=row_b.min(rows - 1) {
                let x0 = if row == row_a { f32::from(a.x) } else { 0.0 };
                let x1 = if row == row_b && !newline {
                    f32::from(b.x)
                } else if row == row_b {
                    f32::from(b.x).max(shaped.width) + 4.0
                } else {
                    shaped.width.max(f32::from(a.x))
                };
                if x1 > x0 {
                    rects.push((x0, top + row as f32 * line_height, x1 - x0, *line_height));
                }
            }
        }
        top += line_height * rows as f32;
        offset += line.len() + 1;
    }
    rects
}

/// One alpha of a blurred shadow: the shaped text in that alpha and the offsets
/// it is painted at.
struct ShadowLayer {
    shaped: Arc<ShapedParagraph>,
    offsets: Vec<(f32, f32)>,
    base: (f32, f32),
}

fn paragraph_dx(layer: &ShadowLayer, offset: f32) -> f32 {
    layer.base.0 + offset
}

fn paragraph_dy(layer: &ShadowLayer, offset: f32) -> f32 {
    layer.base.1 + offset
}

/// A Gaussian-weighted blur of the text's shadow, drawn as the text repeated on
/// rings around the shadow's position. Each ring is painted in the alpha that,
/// composited over every sample, leaves the shadow's own alpha where all of
/// them overlap, so a thick glyph keeps its colour and a thin one fades out.
fn shadow_layers(paragraph: &ParagraphFlat, width: f32) -> Vec<ShadowLayer> {
    let Some(service) = TEXT_SERVICE.get() else {
        return Vec::new();
    };
    let alpha = ((paragraph.shadow_color >> 24) as f32 / 255.0).min(0.999);
    let rgb = paragraph.shadow_color & 0x00FF_FFFF;
    let radius = paragraph.shadow_radius.max(0.0);
    let base = (paragraph.shadow_dx, paragraph.shadow_dy);
    // (distance from the centre, number of samples on that ring)
    let mut rings: Vec<(f32, usize)> = vec![(0.0, 1)];
    if radius > 0.0 {
        const RINGS: usize = 4;
        for ring in 1..=RINGS {
            rings.push((radius * ring as f32 / RINGS as f32, 6 * ring));
        }
    }
    let sigma = (radius / 2.0).max(0.001);
    let weight = |distance: f32| (-(distance * distance) / (2.0 * sigma * sigma)).exp();
    let total: f32 = rings
        .iter()
        .map(|(distance, count)| weight(*distance) * *count as f32)
        .sum();
    rings
        .iter()
        .enumerate()
        .filter_map(|(index, (distance, count))| {
            let ring_alpha = if radius > 0.0 {
                1.0 - (1.0 - alpha).powf(weight(*distance) / total)
            } else {
                alpha
            };
            let color = (((ring_alpha * 255.0).round().max(1.0) as u32) << 24) | rgb;
            let mut flat = paragraph.clone();
            for fragment in &mut flat.fragments {
                fragment.color = color;
            }
            let offsets = (0..*count)
                .map(|point_index| {
                    let angle = std::f32::consts::TAU * point_index as f32 / *count as f32
                        + index as f32 * 0.5;
                    (distance * angle.cos(), distance * angle.sin())
                })
                .collect();
            Some(ShadowLayer {
                shaped: service.shape(&flat, width),
                offsets,
                base,
            })
        })
        .collect()
}

/// How far to move a line so its baseline sits where a browser puts it: the
/// ascent and descent each rounded to whole device pixels and the half leading
/// rounded down to one, added above the ascent. gpui centres the unrounded
/// metrics instead.
fn baseline_correction(
    line: &gpui::WrappedLine,
    line_height: f32,
    (ascent, descent): (f32, f32),
) -> f32 {
    let scale = device_scale();
    let (rounded_ascent, rounded_descent) = ((ascent * scale).round(), (descent * scale).round());
    let browser = (rounded_ascent
        + ((line_height * scale - rounded_ascent - rounded_descent) / 2.0).floor())
        / scale;
    let (own_ascent, own_descent) = (f32::from(line.ascent()), f32::from(line.descent()));
    let gpui = (line_height - own_ascent - own_descent) / 2.0 + own_ascent;
    browser - gpui
}

/// Where a highlight behind a run starts, relative to the top of its line: a
/// browser paints it over the font's content area, which the line's leading
/// centres in the line box. A line that wraps keeps GPUI's whole-line-tall
/// rectangle, which steps with the line height.
fn background_top(
    line: &gpui::WrappedLine,
    line_height: f32,
    (ascent, descent): (f32, f32),
) -> f32 {
    if !line.wrap_boundaries.is_empty() {
        return 0.0;
    }
    let scale = device_scale();
    let content = (ascent * scale).round() + (descent * scale).round();
    ((line_height * scale - content) / 2.0).floor() / scale
}

fn background_height(
    line: &gpui::WrappedLine,
    line_height: f32,
    (ascent, descent): (f32, f32),
) -> f32 {
    if !line.wrap_boundaries.is_empty() {
        return line_height;
    }
    let scale = device_scale();
    ((ascent * scale).round() + (descent * scale).round()) / scale
}

fn paint_lines(
    shaped: &ShapedParagraph,
    origin: gpui::Point<gpui::Pixels>,
    bounds: gpui::Bounds<gpui::Pixels>,
    window: &mut gpui::Window,
    cx: &mut App,
) {
    let mut y = origin.y;
    for ((line, line_height), metrics) in shaped
        .lines
        .iter()
        .zip(&shaped.line_heights)
        .zip(&shaped.line_metrics)
    {
        let baseline = point(
            origin.x,
            y + px(baseline_correction(line, *line_height, *metrics)),
        );
        let _ = line.paint_background(
            point(
                origin.x,
                y + px(background_top(line, *line_height, *metrics)),
            ),
            px(background_height(line, *line_height, *metrics)),
            shaped.text_align,
            Some(bounds),
            window,
            cx,
        );
        if line
            .paint(
                baseline,
                px(*line_height),
                shaped.text_align,
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
