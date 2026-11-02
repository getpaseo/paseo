use gpui::{
    http_client::{HttpClient, Url},
    App,
};
use rn_gpui_sys::{ffi, IMAGE_CACHE_QUERY_HANDLER, IMAGE_HANDLER};
#[cfg(feature = "test-driver")]
use std::sync::atomic::{AtomicUsize, Ordering};
use std::{
    borrow::Cow,
    collections::{HashMap, VecDeque},
    io::Cursor,
    sync::{Mutex, OnceLock},
};

#[cfg(feature = "test-driver")]
static IMAGE_LOADS_IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);

#[cfg(feature = "test-driver")]
pub(crate) fn loads_in_flight() -> usize {
    IMAGE_LOADS_IN_FLIGHT.load(Ordering::Relaxed)
}

#[cfg(feature = "test-driver")]
struct ImageLoadActivity;

#[cfg(feature = "test-driver")]
impl Drop for ImageLoadActivity {
    fn drop(&mut self) {
        IMAGE_LOADS_IN_FLIGHT.fetch_sub(1, Ordering::Relaxed);
    }
}

pub(crate) fn file_uri_path(uri: &str) -> Option<std::path::PathBuf> {
    if let Some(asset_path) = uri.strip_prefix("file://assets/") {
        let relative_path = std::path::Path::new(asset_path);
        if relative_path.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir | std::path::Component::RootDir
            )
        }) {
            return None;
        }
        let assets_dir = crate::resources::default_assets_dir().or_else(|| {
            std::env::current_dir()
                .ok()
                .map(|cwd| crate::resources::assets_in(&cwd))
        })?;
        return Some(assets_dir.join(relative_path));
    }
    let url = uri.parse::<Url>().ok()?;
    if url.scheme() != "file" {
        return None;
    }
    url.to_file_path().ok()
}

/// Rewrites a dev-server asset URL so Metro serves it.
///
/// Metro keeps the relative path for a module under `node_modules`, so the URL
/// its clients build carries a literal `../..`
/// (`/assets/../../node_modules/.../close.png`). Metro parses the request with
/// `new URL(req.url, "resolve://")`, and WHATWG URL normalization collapses
/// that to `/node_modules/...`, which no longer matches its `/assets/` route,
/// so the request 404s. Encoding only the dots is not enough — `%2E%2E/` is
/// also a dot segment — so the separator is encoded as well (`..%2F`), which
/// survives parsing and still decodes to `../..` for Metro's asset lookup.
///
/// Only `/assets/` URLs are touched; Metro's own file routes and every other
/// URI are returned unchanged.
pub(crate) fn dev_server_asset_url(uri: &str) -> Cow<'_, str> {
    let Some(rest) = uri
        .strip_prefix("http://")
        .or_else(|| uri.strip_prefix("https://"))
    else {
        return Cow::Borrowed(uri);
    };
    let Some(assets) = rest.find("/assets/") else {
        return Cow::Borrowed(uri);
    };
    let path_start = uri.len() - rest.len() + assets;
    let (head, tail) = uri.split_at(path_start);
    let (path, query) = match tail.find('?') {
        Some(index) => tail.split_at(index),
        None => (tail, ""),
    };
    if !path.contains("../") {
        return Cow::Borrowed(uri);
    }
    Cow::Owned(format!(
        "{head}{}{query}",
        path.replace("../", "..%2F").replace("./", ".%2F")
    ))
}

const IMAGE_CACHE_LIMIT: usize = 64 * 1024 * 1024;

#[derive(Default)]
struct ImageByteCache {
    entries: HashMap<String, Vec<u8>>,
    insertion_order: VecDeque<String>,
    byte_count: usize,
}

static IMAGE_BYTES: OnceLock<Mutex<ImageByteCache>> = OnceLock::new();

fn byte_cache() -> &'static Mutex<ImageByteCache> {
    IMAGE_BYTES.get_or_init(|| Mutex::new(ImageByteCache::default()))
}

pub(crate) fn cached_bytes(uri: &str) -> Option<Vec<u8>> {
    byte_cache().lock().ok()?.entries.get(uri).cloned()
}

pub(crate) fn cache_bytes(uri: String, bytes: Vec<u8>) {
    if bytes.len() > IMAGE_CACHE_LIMIT {
        return;
    }
    if let Ok(mut cache) = byte_cache().lock() {
        if let Some(old_bytes) = cache.entries.remove(&uri) {
            cache.byte_count -= old_bytes.len();
            cache.insertion_order.retain(|entry| entry != &uri);
        }
        while cache.byte_count + bytes.len() > IMAGE_CACHE_LIMIT {
            let Some(old_uri) = cache.insertion_order.pop_front() else {
                break;
            };
            if let Some(old_bytes) = cache.entries.remove(&old_uri) {
                cache.byte_count -= old_bytes.len();
            }
        }
        cache.byte_count += bytes.len();
        cache.insertion_order.push_back(uri.clone());
        cache.entries.insert(uri, bytes);
    }
}

pub fn install(cx: &App) {
    let _ = IMAGE_CACHE_QUERY_HANDLER.set(Box::new(|uri| cached_bytes(uri).is_some()));
    let executor = cx.background_executor().clone();
    let client = cx.http_client();
    let _ = IMAGE_HANDLER.set(Box::new(move |uri, request_id| {
        let client = client.clone();
        #[cfg(feature = "test-driver")]
        IMAGE_LOADS_IN_FLIGHT.fetch_add(1, Ordering::Relaxed);
        executor
            .spawn(async move {
                #[cfg(feature = "test-driver")]
                let _activity = ImageLoadActivity;
                let result = load_dimensions(&uri, client).await;
                match result {
                    Ok((width, height)) => ffi::rn_gpui_on_image_load_result(
                        request_id,
                        f64::from(width),
                        f64::from(height),
                        String::new(),
                    ),
                    Err(error) => ffi::rn_gpui_on_image_load_result(request_id, 0.0, 0.0, error),
                }
            })
            .detach();
    }));
}

async fn load_dimensions(
    uri: &str,
    client: std::sync::Arc<dyn HttpClient>,
) -> Result<(u32, u32), String> {
    let bytes = load_bytes(uri, client).await?;
    image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|error| error.to_string())?
        .into_dimensions()
        .map_err(|error| error.to_string())
}

/// The encoded bytes of an image source: a `data:` URI, a file, a Metro asset
/// URL, any http(s) URL, or a plain path.
pub(crate) async fn load_bytes(
    uri: &str,
    client: std::sync::Arc<dyn HttpClient>,
) -> Result<Vec<u8>, String> {
    let bytes = if let Some(bytes) = cached_bytes(uri) {
        bytes
    } else if let Some(data) = uri.strip_prefix("data:") {
        use base64::Engine;
        let (metadata, payload) = data
            .split_once(',')
            .ok_or_else(|| "invalid image data URI".to_owned())?;
        if !metadata.ends_with(";base64") {
            return Err("only base64 image data URIs are supported".into());
        }
        base64::engine::general_purpose::STANDARD
            .decode(payload)
            .map_err(|error| error.to_string())?
    } else if uri.starts_with("file://") {
        std::fs::read(file_uri_path(uri).ok_or_else(|| "invalid file URI".to_owned())?)
            .map_err(|error| error.to_string())?
    } else if uri.starts_with("http://") || uri.starts_with("https://") {
        use futures::AsyncReadExt;
        let request_url = dev_server_asset_url(uri);
        let mut response = client
            .get(&request_url, ().into(), true)
            .await
            .map_err(|error| error.to_string())?;
        if !response.status().is_success() {
            return Err(format!("image request failed with {}", response.status()));
        }
        let mut bytes = Vec::new();
        response
            .body_mut()
            .read_to_end(&mut bytes)
            .await
            .map_err(|error| error.to_string())?;
        bytes
    } else {
        std::fs::read(uri).map_err(|error| error.to_string())?
    };

    cache_bytes(uri.to_owned(), bytes.clone());
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::dev_server_asset_url;
    use gpui::http_client::Url;

    /// The path Metro actually routes on, after its own URL parsing: the
    /// `/assets/` prefix must survive, and the decoded asset path must still be
    /// the relative one Metro resolves against the project root. Metro decodes
    /// each segment (`Server.js` maps `decodeURIComponent`), so this does too.
    fn metro_asset_path(url: &str) -> Option<String> {
        let parsed = Url::parse(url).ok()?;
        let joined = parsed
            .path_segments()?
            .map(percent_decode)
            .collect::<Vec<_>>()
            .join("/");
        if !joined.starts_with("assets/") {
            return None;
        }
        joined.strip_prefix("assets/").map(str::to_owned)
    }

    /// Minimal `decodeURIComponent`, enough for the segments these URLs carry.
    fn percent_decode(segment: &str) -> String {
        let bytes = segment.as_bytes();
        let mut out = Vec::with_capacity(bytes.len());
        let mut index = 0;
        while index < bytes.len() {
            if bytes[index] == b'%' && index + 2 < bytes.len() {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok();
                if let Some(byte) = hex.and_then(|hex| u8::from_str_radix(hex, 16).ok()) {
                    out.push(byte);
                    index += 3;
                    continue;
                }
            }
            out.push(bytes[index]);
            index += 1;
        }
        String::from_utf8_lossy(&out).into_owned()
    }

    const CLOSE: &str = "http://localhost:8082/assets/../../node_modules/react-native/Libraries/LogBox/UI/LogBoxImages/close.png?platform=desktop&hash=369745d4a4a6fa62fa0ed495f89aa964";

    #[test]
    fn relative_node_modules_asset_survives_metro_parsing() {
        let rewritten = dev_server_asset_url(CLOSE);
        assert!(
            rewritten.contains("..%2F..%2F"),
            "expected encoded separators, got {rewritten}"
        );
        assert_eq!(
            metro_asset_path(&rewritten).as_deref(),
            Some("../../node_modules/react-native/Libraries/LogBox/UI/LogBoxImages/close.png")
        );
    }

    #[test]
    fn the_unencoded_form_is_normalized_away() {
        // Guards the reason the rewrite exists: without it Metro never sees an
        // `/assets/` path at all.
        assert_eq!(metro_asset_path(CLOSE), None);
    }

    #[test]
    fn encoding_only_the_dots_is_not_enough() {
        // `%2E%2E/` is still a dot segment to WHATWG URL, so the separator has
        // to be encoded too.
        let dots_only = CLOSE.replace("../", "%2E%2E/");
        assert_eq!(metro_asset_path(&dots_only), None);
    }

    #[test]
    fn query_string_is_preserved() {
        let rewritten = dev_server_asset_url(CLOSE);
        assert!(rewritten.ends_with("?platform=desktop&hash=369745d4a4a6fa62fa0ed495f89aa964"));
    }

    #[test]
    fn ordinary_asset_urls_are_unchanged() {
        let plain = "http://localhost:8082/assets/node_modules/react-native/x.png?platform=desktop";
        assert_eq!(dev_server_asset_url(plain), plain);
    }

    #[test]
    fn relative_path_outside_the_assets_route_is_unchanged() {
        let source = "http://localhost:8082/../../node_modules/react-native/x.png";
        assert_eq!(dev_server_asset_url(source), source);
    }

    #[test]
    fn non_http_urls_are_unchanged() {
        for uri in [
            "file://assets/../../evil.png",
            "/assets/../../node_modules/x.png",
            "data:image/png;base64,AAAA",
            "https://example.test/other/../../x.png",
        ] {
            assert_eq!(
                dev_server_asset_url(uri),
                uri,
                "{uri} must not be rewritten"
            );
        }
    }

    #[test]
    fn single_parent_segment_is_encoded() {
        let rewritten = dev_server_asset_url("http://localhost:8082/assets/../Images/x.png");
        assert_eq!(
            metro_asset_path(&rewritten).as_deref(),
            Some("../Images/x.png")
        );
    }
}
