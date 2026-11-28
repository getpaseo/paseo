//! Turning a node into the image it is drawn as, and when to do it.
//!
//! A drawing is found by its [`Key`] in the shared cache, which builds no
//! document. Only a miss builds the four documents (one per coverage sample) and
//! rasterises them. A small image with nothing already on screen for its node is
//! drawn right away, so a row that scrolls in has its icon on the first frame.
//! Anything else is drawn on a background thread while the node keeps showing
//! its previous image, if it has one, and is built again when the new one is
//! ready.

use crate::cache::{self, Cache};
use crate::key::{node_key, Key};
use crate::{svg_document, Sample, SAMPLE_OFFSETS};
use gpui::{App, Window};
use react_native_gpui::extensions::{rendering_node, ComponentNode, NodeHandle};
use rn_gpui_sys::ffi::RectF;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

/// Images up to this many device pixels are drawn on the main thread when their
/// node has nothing to show yet: about 48 CSS pixels square at a scale of 2.
const SYNC_MAX_PIXELS: i64 = 96 * 96;

/// Below this many device pixels the four samples are drawn one after the other:
/// each takes less time than starting a thread for it.
const PARALLEL_MIN_PIXELS: i64 = 128 * 128;

/// `RN_GPUI_SVG_TRACE=1` logs every drawing that is rasterised: its size, how
/// long each coverage sample took and how long they took together. With
/// `RN_GPUI_SVG_SYNC=1` every drawing is rasterised on the main thread.
fn setting(name: &str) -> bool {
    std::env::var(name).is_ok_and(|value| value == "1")
}

fn trace() -> bool {
    static TRACE: OnceLock<bool> = OnceLock::new();
    *TRACE.get_or_init(|| setting("RN_GPUI_SVG_TRACE"))
}

fn force_sync() -> bool {
    static SYNC: OnceLock<bool> = OnceLock::new();
    *SYNC.get_or_init(|| setting("RN_GPUI_SVG_SYNC"))
}

/// The image each node showed last, so a node whose drawing changes keeps
/// showing it until the new one is ready.
fn shown() -> &'static Mutex<HashMap<i32, Arc<gpui::RenderImage>>> {
    static SHOWN: OnceLock<Mutex<HashMap<i32, Arc<gpui::RenderImage>>>> = OnceLock::new();
    SHOWN.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Drawings being rasterised, with the nodes waiting for each.
fn pending() -> &'static Mutex<HashMap<Key, Vec<NodeHandle>>> {
    static PENDING: OnceLock<Mutex<HashMap<Key, Vec<NodeHandle>>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Drawings the renderer could not rasterise, which are not tried again.
fn failed() -> &'static Mutex<HashSet<Key>> {
    static FAILED: OnceLock<Mutex<HashSet<Key>>> = OnceLock::new();
    FAILED.get_or_init(|| Mutex::new(HashSet::new()))
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn has_filter(node: &ComponentNode) -> bool {
    node.component == "RNSVGFilter" || node.children.iter().any(has_filter)
}

/// The image in the cache for `key`, or the result of `make`, which is stored.
pub fn get_or_make(
    cache: &Mutex<Cache>,
    key: Key,
    make: impl FnOnce() -> Option<Arc<gpui::RenderImage>>,
) -> Option<Arc<gpui::RenderImage>> {
    if let Some(image) = lock(cache).get(&key) {
        return Some(image);
    }
    let image = make()?;
    lock(cache).insert(key, image.clone());
    Some(image)
}

/// The image `node` is drawn as now, or what it shows meanwhile.
pub fn image_for(
    node: &ComponentNode,
    frame: RectF,
    scale: f32,
    window: &mut Window,
    cx: &mut App,
) -> Option<Arc<gpui::RenderImage>> {
    let key = node_key(node, frame, scale);
    let remember = |image: &Arc<gpui::RenderImage>| {
        lock(shown()).insert(node.tag, image.clone());
    };
    if let Some(image) = lock(cache::global()).get(&key) {
        remember(&image);
        return Some(image);
    }
    let previous = lock(shown()).get(&node.tag).cloned();
    if lock(failed()).contains(&key) {
        return previous;
    }
    let pixels = (frame.w * scale).round() as i64 * (frame.h * scale).round() as i64;
    let small = pixels <= SYNC_MAX_PIXELS && !has_filter(node);
    if force_sync() || (previous.is_none() && small) {
        let renderer = cx.svg_renderer();
        let image = get_or_make(cache::global(), key, || {
            sampled_image(&renderer, node, frame, scale)
        });
        match &image {
            Some(image) => remember(image),
            None => {
                lock(failed()).insert(key);
            }
        }
        return image;
    }
    request(key, node.clone(), frame, scale, window, cx);
    previous
}

/// Rasterises `node` on a background thread, once for every node that asks for
/// the same drawing, and builds the nodes again when it is done.
fn request(
    key: Key,
    node: ComponentNode,
    frame: RectF,
    scale: f32,
    window: &mut Window,
    cx: &mut App,
) {
    let Some(handle) = rendering_node() else {
        return;
    };
    {
        let mut pending = lock(pending());
        if let Some(waiting) = pending.get_mut(&key) {
            waiting.push(handle);
            return;
        }
        pending.insert(key, vec![handle]);
    }
    let renderer = cx.svg_renderer();
    let work = cx
        .background_executor()
        .spawn(async move { sampled_image(&renderer, &node, frame, scale) });
    window
        .spawn(cx, async move |cx| {
            let image = work.await;
            match &image {
                Some(image) => lock(cache::global()).insert(key, image.clone()),
                None => {
                    lock(failed()).insert(key);
                }
            }
            let waiting = lock(pending()).remove(&key).unwrap_or_default();
            let _ = cx.update(|_, cx| {
                for handle in &waiting {
                    handle.notify(cx);
                }
            });
        })
        .detach();
}

/// Draws the document at the window's scale, once per coverage sample without
/// antialiasing, and averages the samples. The samples are rasterised side by
/// side and combined in a fixed order, so the pixels do not depend on timing.
pub fn sampled_image(
    renderer: &gpui::SvgRenderer,
    node: &ComponentNode,
    frame: RectF,
    scale: f32,
) -> Option<Arc<gpui::RenderImage>> {
    let width = (frame.w * scale).round() as i32;
    let height = (frame.h * scale).round() as i32;
    if width < 1 || height < 1 {
        return None;
    }
    let size = gpui::size(gpui::DevicePixels(width), gpui::DevicePixels(height));
    let started = Instant::now();
    let render = |(dx, dy): (f32, f32)| -> Option<(Vec<u8>, f64)> {
        let sample_started = Instant::now();
        let document = svg_document(node, frame, Some(Sample { dx, dy, scale }));
        let parsed = renderer.parse_svg(document.as_bytes()).ok()?;
        let rendered = renderer
            .render_parsed(&parsed, gpui::SvgSize::ExactSize(size))
            .ok()?;
        rendered.as_bytes(0).map(|bytes| {
            (
                bytes.to_vec(),
                sample_started.elapsed().as_secs_f64() * 1000.0,
            )
        })
    };
    let samples: Vec<Option<(Vec<u8>, f64)>> =
        if i64::from(width) * i64::from(height) < PARALLEL_MIN_PIXELS {
            SAMPLE_OFFSETS
                .iter()
                .map(|offset| render(*offset))
                .collect()
        } else {
            std::thread::scope(|scope| {
                let workers: Vec<_> = SAMPLE_OFFSETS
                    .iter()
                    .map(|offset| scope.spawn(move || render(*offset)))
                    .collect();
                workers
                    .into_iter()
                    .map(|worker| worker.join().ok().flatten())
                    .collect()
            })
        };
    if trace() {
        let times: Vec<String> = samples
            .iter()
            .map(|sample| {
                sample
                    .as_ref()
                    .map_or("failed".into(), |(_, ms)| format!("{ms:.1}"))
            })
            .collect();
        eprintln!(
            "[svg] {width}x{height} samples_ms=[{}] wall_ms={:.1}",
            times.join(", "),
            started.elapsed().as_secs_f64() * 1000.0
        );
    }
    let samples: Vec<Option<Vec<u8>>> = samples
        .into_iter()
        .map(|sample| sample.map(|(bytes, _)| bytes))
        .collect();
    average(&samples, width as u32, height as u32)
}

/// Averages the samples: BGRA with straight alpha, colour weighted by alpha.
fn average(samples: &[Option<Vec<u8>>], width: u32, height: u32) -> Option<Arc<gpui::RenderImage>> {
    let length = width as usize * height as usize * 4;
    let mut sum = vec![0f32; length];
    for bytes in samples {
        let bytes = bytes.as_ref()?;
        if bytes.len() != length {
            return None;
        }
        for (total, pixel) in sum.chunks_exact_mut(4).zip(bytes.chunks_exact(4)) {
            let alpha = f32::from(pixel[3]);
            total[0] += f32::from(pixel[0]) * alpha;
            total[1] += f32::from(pixel[1]) * alpha;
            total[2] += f32::from(pixel[2]) * alpha;
            total[3] += alpha;
        }
    }
    let count = samples.len() as f32;
    let mut out = Vec::with_capacity(sum.len());
    for total in sum.chunks_exact(4) {
        if total[3] <= 0.0 {
            out.extend_from_slice(&[0, 0, 0, 0]);
            continue;
        }
        let blue = (total[0] / total[3]).round().clamp(0.0, 255.0);
        let green = (total[1] / total[3]).round().clamp(0.0, 255.0);
        let red = (total[2] / total[3]).round().clamp(0.0, 255.0);
        // Half coverage is 127.5 of 255, which the alpha channel cannot hold.
        // Chrome blends the exact half, and the result then rounds away from
        // the ink's own side: toward light under dark ink and toward dark
        // under light ink, so the alpha rounds the other way to match.
        let alpha = total[3] / count;
        let alpha = if (alpha.fract() - 0.5).abs() < 1e-3 {
            let luma = 0.299 * red + 0.587 * green + 0.114 * blue;
            if luma < 128.0 {
                alpha.floor()
            } else {
                alpha.ceil()
            }
        } else {
            alpha.round()
        };
        out.extend_from_slice(&[
            blue as u8,
            green as u8,
            red as u8,
            alpha.clamp(0.0, 255.0) as u8,
        ]);
    }
    let buffer = image::ImageBuffer::from_raw(width, height, out)?;
    Some(Arc::new(gpui::RenderImage::new(
        smallvec::SmallVec::from_const([image::Frame::new(buffer)]),
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn image() -> Arc<gpui::RenderImage> {
        let buffer = image::ImageBuffer::from_raw(2, 2, vec![0u8; 16]).expect("a buffer");
        Arc::new(gpui::RenderImage::new(smallvec::SmallVec::from_const([
            image::Frame::new(buffer),
        ])))
    }

    #[test]
    fn a_hit_makes_nothing_and_a_miss_makes_once() {
        let cache = Mutex::new(Cache::new(1 << 20));
        let made = AtomicUsize::new(0);
        let make = || {
            made.fetch_add(1, Ordering::SeqCst);
            Some(image())
        };
        let key = crate::key::test_key(1);
        let first = get_or_make(&cache, key, make).unwrap();
        assert_eq!(made.load(Ordering::SeqCst), 1);
        // The second lookup is a hit: the closure, which is where a document
        // string would be built, is not called.
        let second = get_or_make(&cache, key, || panic!("a hit must not build anything")).unwrap();
        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(made.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_drawing_that_cannot_be_made_is_not_cached() {
        let cache = Mutex::new(Cache::new(1 << 20));
        let key = crate::key::test_key(2);
        assert!(get_or_make(&cache, key, || None).is_none());
        assert_eq!(lock(&cache).len(), 0);
    }

    #[test]
    fn averaging_four_equal_samples_gives_the_sample() {
        let pixels = vec![10u8, 20, 30, 255, 0, 0, 0, 0];
        let samples = vec![
            Some(pixels.clone()),
            Some(pixels.clone()),
            Some(pixels.clone()),
            Some(pixels),
        ];
        let averaged = average(&samples, 2, 1).unwrap();
        assert_eq!(
            averaged.as_bytes(0).unwrap(),
            &[10, 20, 30, 255, 0, 0, 0, 0]
        );
    }

    #[test]
    fn a_missing_sample_gives_no_image() {
        assert!(average(&[Some(vec![0; 4]), None], 1, 1).is_none());
    }

    fn node(
        component: &str,
        props: serde_json::Value,
        children: Vec<ComponentNode>,
    ) -> ComponentNode {
        ComponentNode {
            component: component.into(),
            tag: 1,
            frame: RectF {
                x: 0.0,
                y: 0.0,
                w: 24.0,
                h: 24.0,
            },
            scale: (1.0, 1.0),
            props: Arc::new(props),
            parent: None,
            children,
        }
    }

    fn drawings() -> Vec<ComponentNode> {
        use serde_json::json;
        let fill = json!({"type": 0, "payload": 0xff336699_u32});
        let shape = |component: &str, props: serde_json::Value| {
            let mut full = json!({"fill": fill, "propList": ["fill"]});
            full.as_object_mut()
                .unwrap()
                .extend(props.as_object().unwrap().clone());
            node(component, full, vec![])
        };
        let root = |children| {
            node(
                "RNSVGSvgView",
                json!({"vbWidth": 24, "vbHeight": 24, "align": "xMidYMid", "meetOrSlice": 0}),
                children,
            )
        };
        let blurred = node(
            "RNSVGGroup",
            json!({"filter": "f", "propList": []}),
            vec![shape(
                "RNSVGRect",
                json!({"x": 6, "y": 6, "width": 12, "height": 12}),
            )],
        );
        let filter = node(
            "RNSVGDefs",
            json!({}),
            vec![node(
                "RNSVGFilter",
                json!({"name": "f", "x": 0, "y": 0, "width": 24, "height": 24, "filterUnits": "userSpaceOnUse", "primitiveUnits": "userSpaceOnUse"}),
                vec![node(
                    "RNSVGFeGaussianBlur",
                    json!({"stdDeviationX": 2, "stdDeviationY": 2}),
                    vec![],
                )],
            )],
        );
        vec![
            root(vec![shape("RNSVGPath", json!({"d": "M2 2L22 2L12 22Z"}))]),
            root(vec![shape(
                "RNSVGCircle",
                json!({"cx": 12, "cy": 12, "r": 7.3}),
            )]),
            root(vec![shape(
                "RNSVGRect",
                json!({"x": 3.3, "y": 4.1, "width": 15, "height": 9, "rx": 3, "matrix": [0.94, -0.34, 0.34, 0.94, 0, 0]}),
            )]),
            root(vec![filter, blurred]),
        ]
    }

    /// The four samples one after the other, as the module drew them before.
    fn sequential(
        renderer: &gpui::SvgRenderer,
        node: &ComponentNode,
        frame: RectF,
        scale: f32,
    ) -> Option<Arc<gpui::RenderImage>> {
        let width = (frame.w * scale).round() as i32;
        let height = (frame.h * scale).round() as i32;
        let size = gpui::size(gpui::DevicePixels(width), gpui::DevicePixels(height));
        let samples: Vec<Option<Vec<u8>>> = SAMPLE_OFFSETS
            .iter()
            .map(|&(dx, dy)| {
                let document = svg_document(node, frame, Some(Sample { dx, dy, scale }));
                let parsed = renderer.parse_svg(document.as_bytes()).ok()?;
                let rendered = renderer
                    .render_parsed(&parsed, gpui::SvgSize::ExactSize(size))
                    .ok()?;
                rendered.as_bytes(0).map(<[u8]>::to_vec)
            })
            .collect();
        average(&samples, width as u32, height as u32)
    }

    #[test]
    fn rasterising_the_samples_side_by_side_gives_the_same_pixels() {
        let renderer = gpui::SvgRenderer::new(Arc::new(()));
        // 24 and 48 point frames are drawn in turn, and 80 at a scale of 2 is
        // large enough to be drawn in parallel.
        for (index, drawing) in drawings().iter().enumerate() {
            for (side, scale) in [(24.0, 1.0), (24.0, 2.0), (80.0, 2.0)] {
                let frame = RectF {
                    x: 0.0,
                    y: 0.0,
                    w: side,
                    h: side,
                };
                let together = sampled_image(&renderer, drawing, frame, scale).expect("drawn");
                let apart = sequential(&renderer, drawing, frame, scale).expect("drawn");
                assert_eq!(
                    together.as_bytes(0).unwrap(),
                    apart.as_bytes(0).unwrap(),
                    "drawing {index} at scale {scale}"
                );
                assert!(together.as_bytes(0).unwrap().iter().any(|byte| *byte != 0));
            }
        }
    }
}
