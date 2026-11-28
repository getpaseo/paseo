//! Images drawn through the app's own loader rather than GPUI's: a tint or a
//! blur has to be applied to the pixels, and a repeating image needs them to
//! tile.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use gpui::{App, ImageCacheError, RenderImage, Window};
use image::{imageops, Frame, RgbaImage};

enum Entry {
    Loading,
    Ready(Arc<RenderImage>),
    Failed(Arc<anyhow::Error>),
}

static CACHE: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();

fn cache() -> &'static Mutex<HashMap<String, Entry>> {
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Replaces the colour of every pixel with `tint`, keeping its alpha.
fn tinted(image: &mut RgbaImage, tint: u32) {
    let [red, green, blue] = [(tint >> 16) as u8, (tint >> 8) as u8, tint as u8];
    let opacity = f32::from((tint >> 24) as u8) / 255.0;
    for pixel in image.pixels_mut() {
        pixel.0 = [
            red,
            green,
            blue,
            (f32::from(pixel.0[3]) * opacity).round() as u8,
        ];
    }
}

fn process(bytes: &[u8], tint: u32, blur: f32) -> anyhow::Result<Arc<RenderImage>> {
    let mut rgba = image::load_from_memory(bytes)?.into_rgba8();
    if blur > 0.0 {
        rgba = imageops::blur(&rgba, blur / 2.0);
    }
    if tint >> 24 != 0 {
        tinted(&mut rgba, tint);
    }
    for pixel in rgba.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }
    Ok(Arc::new(RenderImage::new(vec![Frame::new(rgba)])))
}

/// The decoded image for `uri`, loading it on first ask: `None` while it loads.
pub(crate) fn image(
    uri: &str,
    tint: u32,
    blur: f32,
    _window: &mut Window,
    cx: &mut App,
) -> Option<Result<Arc<RenderImage>, ImageCacheError>> {
    let key = format!("{uri}|{tint}|{}", blur.to_bits());
    {
        let mut entries = cache()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match entries.get(&key) {
            Some(Entry::Ready(image)) => return Some(Ok(image.clone())),
            Some(Entry::Failed(error)) => return Some(Err(ImageCacheError::Other(error.clone()))),
            Some(Entry::Loading) => return None,
            None => {
                entries.insert(key.clone(), Entry::Loading);
            }
        }
    }
    let client = cx.http_client();
    let executor = cx.background_executor().clone();
    let uri = uri.to_owned();
    cx.spawn(async move |cx| {
        let loaded = match crate::image_loader::load_bytes(&uri, client).await {
            Ok(bytes) => {
                executor
                    .spawn(async move { process(&bytes, tint, blur) })
                    .await
            }
            Err(error) => Err(anyhow::anyhow!(error)),
        };
        let entry = match loaded {
            Ok(image) => Entry::Ready(image),
            Err(error) => Entry::Failed(Arc::new(error)),
        };
        cache()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(key, entry);
        cx.update(|cx| cx.refresh_windows());
    })
    .detach();
    None
}
