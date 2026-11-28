pub mod interaction;
pub mod layout;
pub mod model;
pub mod render;

use crate::interaction::InteractionState;
use crate::layout::{layout_document, LaidOutDocument};
use crate::model::MarkdownSnapshot;
use gpui::{AnyElement, App, Window};
use react_native_gpui::extensions::input::{InputContext, InputSpec, MouseEvent, Propagation};
use react_native_gpui::extensions::{
    register_component_renderer, ComponentNode, ComponentRenderer,
};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
#[cfg(not(test))]
use std::ffi::{c_char, CStr};
use std::hash::{Hash, Hasher};
use std::sync::{Arc, Mutex, OnceLock};

#[cfg(not(test))]
type MeasureFn = extern "C" fn(*const c_char, f32, f32, f32, f32, *mut f32, *mut f32);

#[cfg(not(test))]
extern "C" {
    fn rn_gpui_markdown_set_measure_fn(cb: MeasureFn);
}

struct CacheMap<K, V> {
    max_entries: usize,
    entries: HashMap<K, V>,
    order: VecDeque<K>,
}

impl<K: Clone + Eq + Hash, V: Clone> CacheMap<K, V> {
    fn new(max_entries: usize) -> Self {
        Self {
            max_entries,
            entries: HashMap::new(),
            order: VecDeque::new(),
        }
    }

    fn get(&self, key: &K) -> Option<V> {
        self.entries.get(key).cloned()
    }

    fn insert(&mut self, key: K, value: V) {
        if self.entries.contains_key(&key) {
            self.entries.insert(key, value);
            return;
        }
        if self.order.len() >= self.max_entries {
            if let Some(oldest) = self.order.pop_front() {
                self.entries.remove(&oldest);
            }
        }
        self.order.push_back(key.clone());
        self.entries.insert(key, value);
    }
}

fn hash_bytes(bytes: &[u8]) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    hasher.finish()
}

fn snapshot_from_str(json: &str) -> Option<Arc<MarkdownSnapshot>> {
    static SNAPSHOT_CACHE: OnceLock<Mutex<CacheMap<(u64, usize), Arc<MarkdownSnapshot>>>> =
        OnceLock::new();
    let cache = SNAPSHOT_CACHE.get_or_init(|| Mutex::new(CacheMap::new(128)));
    let hash = hash_bytes(json.as_bytes());
    let key = (hash, json.len());
    if let Some(hit) = cache.lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
        return Some(hit);
    }
    let mut parsed: MarkdownSnapshot = match serde_json::from_str(json) {
        Ok(parsed) => parsed,
        Err(error) => {
            log::error!("failed to parse markdown snapshot: {error}");
            return None;
        }
    };
    parsed.content_hash = hash ^ (json.len() as u64);
    let arc = Arc::new(parsed);
    cache
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(key, arc.clone());
    Some(arc)
}

fn layout_cached(snapshot: &MarkdownSnapshot, max_width: Option<f32>) -> Arc<LaidOutDocument> {
    static LAYOUT_CACHE: OnceLock<Mutex<CacheMap<(u64, u64), Arc<LaidOutDocument>>>> =
        OnceLock::new();
    let cache = LAYOUT_CACHE.get_or_init(|| Mutex::new(CacheMap::new(128)));
    let width_key = max_width
        .map(|w| (w * 10.0).round() as u64)
        .unwrap_or(u64::MAX);
    let key = (snapshot.content_hash, width_key);
    if let Some(hit) = cache.lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
        return hit;
    }
    let laid_out = Arc::new(layout_document(snapshot, max_width));
    cache
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(key, laid_out.clone());
    laid_out
}

fn clamp_axis(value: f32, min: f32, max: f32) -> f32 {
    let safe_value = if value.is_finite() {
        value.max(0.0)
    } else {
        0.0
    };
    let min_bound = if min.is_finite() { min.max(0.0) } else { 0.0 };
    let capped = if max.is_finite() {
        safe_value.min(max.max(0.0))
    } else {
        safe_value
    };
    capped.max(min_bound)
}

pub fn measure_snapshot(
    snapshot: &MarkdownSnapshot,
    min_width: f32,
    min_height: f32,
    max_width: f32,
    max_height: f32,
) -> (f32, f32) {
    let width_constraint = if max_width.is_finite() && max_width > 0.0 {
        Some(max_width)
    } else {
        None
    };
    let doc = layout_cached(snapshot, width_constraint);
    (
        clamp_axis(doc.width, min_width, max_width),
        clamp_axis(doc.height, min_height, max_height),
    )
}

#[cfg(not(test))]
extern "C" fn markdown_measure_cb(
    snapshot_json: *const c_char,
    min_width: f32,
    min_height: f32,
    max_width: f32,
    max_height: f32,
    out_width: *mut f32,
    out_height: *mut f32,
) {
    let fallback = (
        clamp_axis(0.0, min_width, max_width),
        clamp_axis(0.0, min_height, max_height),
    );
    let result = std::panic::catch_unwind(|| {
        if snapshot_json.is_null() {
            return fallback;
        }
        let json = unsafe { CStr::from_ptr(snapshot_json) }
            .to_str()
            .unwrap_or("");
        let Some(snapshot) = snapshot_from_str(json) else {
            return fallback;
        };
        measure_snapshot(&snapshot, min_width, min_height, max_width, max_height)
    })
    .unwrap_or(fallback);

    unsafe {
        if !out_width.is_null() {
            *out_width = result.0;
        }
        if !out_height.is_null() {
            *out_height = result.1;
        }
    }
}

struct NodeLayoutEntry {
    props: Arc<Value>,
    width_key: u64,
    doc: Arc<LaidOutDocument>,
}

struct MarkdownRenderer {
    interaction: InteractionState,
    node_cache: Mutex<CacheMap<i32, NodeLayoutEntry>>,
}

impl MarkdownRenderer {
    fn layout_for_node(&self, node: &ComponentNode) -> Option<Arc<LaidOutDocument>> {
        if node.props.is_null() || node.props.as_object().is_some_and(|m| m.is_empty()) {
            return None;
        }
        let width = (node.frame.w > 0.0).then_some(node.frame.w);
        let width_key = width.map(|w| (w * 10.0).round() as u64).unwrap_or(u64::MAX);
        if let Some(entry) = self
            .node_cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&node.tag)
        {
            if Arc::ptr_eq(&entry.props, &node.props) && entry.width_key == width_key {
                return Some(entry.doc);
            }
        }
        let json = serde_json::to_string(&*node.props).ok()?;
        let snapshot = snapshot_from_str(&json)?;
        let doc = layout_cached(&snapshot, width);
        self.node_cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                node.tag,
                NodeLayoutEntry {
                    props: node.props.clone(),
                    width_key,
                    doc: doc.clone(),
                },
            );
        Some(doc)
    }
}

impl ComponentRenderer for MarkdownRenderer {
    fn render(
        &self,
        _node: &ComponentNode,
        _window: &mut Window,
        _cx: &mut App,
    ) -> Option<AnyElement> {
        None
    }

    fn content(
        &self,
        node: &ComponentNode,
        _window: &mut Window,
        _cx: &mut App,
    ) -> Option<AnyElement> {
        let doc = self.layout_for_node(node)?;
        Some(render::render_document(&doc, node.tag))
    }

    fn input(&self, _node: &ComponentNode) -> InputSpec {
        InteractionState::input_spec()
    }

    fn claims_press(&self, _node: &ComponentNode) -> bool {
        true
    }

    fn on_mouse_down(
        &self,
        node: &ComponentNode,
        event: &MouseEvent,
        _cx: &mut InputContext<'_>,
    ) -> Propagation {
        let Some(doc) = self.layout_for_node(node) else {
            return Propagation::Continue;
        };
        self.interaction.on_mouse_down(node.tag, &doc, event)
    }

    fn on_mouse_up(
        &self,
        node: &ComponentNode,
        event: &MouseEvent,
        cx: &mut InputContext<'_>,
    ) -> Propagation {
        let Some(doc) = self.layout_for_node(node) else {
            return Propagation::Continue;
        };
        self.interaction.on_mouse_up(node.tag, &doc, event, cx)
    }
}

impl Clone for NodeLayoutEntry {
    fn clone(&self) -> Self {
        Self {
            props: self.props.clone(),
            width_key: self.width_key,
            doc: self.doc.clone(),
        }
    }
}

pub fn rn_gpui_register() {
    #[cfg(not(test))]
    unsafe {
        rn_gpui_markdown_set_measure_fn(markdown_measure_cb);
    }
    let renderer = Arc::new(MarkdownRenderer {
        interaction: InteractionState::default(),
        node_cache: Mutex::new(CacheMap::new(128)),
    });
    register_component_renderer("EnrichedMarkdown", renderer.clone());
    register_component_renderer("EnrichedMarkdownText", renderer);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{AstNode, BlockStyle, MarkdownStyle};
    use std::collections::HashMap;

    fn sample_paragraph_snapshot(text: &str) -> MarkdownSnapshot {
        let mut text_node = AstNode {
            node_type: "Text".to_string(),
            content: Some(text.to_string()),
            ..Default::default()
        };
        if text.is_empty() {
            text_node.content = None;
        }
        let para = AstNode {
            node_type: "Paragraph".to_string(),
            children: if text.is_empty() {
                None
            } else {
                Some(vec![text_node])
            },
            ..Default::default()
        };
        MarkdownSnapshot {
            content_hash: if text.is_empty() { 1 } else { 2 },
            ast: AstNode {
                node_type: "Document".to_string(),
                children: Some(vec![para]),
                attributes: Some(HashMap::new()),
                ..Default::default()
            },
            style: MarkdownStyle {
                paragraph: BlockStyle {
                    font_size: 15.0,
                    line_height: 21.0,
                    ..Default::default()
                },
                ..Default::default()
            },
            ..Default::default()
        }
    }

    #[test]
    fn measure_snapshot_clamps_to_minimum_and_maximum_constraints() {
        let short = sample_paragraph_snapshot("Short reply");
        let (w, h) = measure_snapshot(&short, 804.0, 0.0, 804.0, f32::INFINITY);
        assert!((w - 804.0).abs() < 0.01, "expected 804.0 width, got {w}");
        assert!(h > 0.0);

        let empty = sample_paragraph_snapshot("");
        let (ew, eh) = measure_snapshot(&empty, 804.0, 22.0, 804.0, f32::INFINITY);
        assert!((ew - 804.0).abs() < 0.01);
        assert!((eh - 22.0).abs() < 0.01);

        let tall = sample_paragraph_snapshot("Word ".repeat(80).trim());
        let (cw, ch) = measure_snapshot(&tall, 0.0, 0.0, 120.0, 40.0);
        assert!(cw <= 120.0);
        assert!(ch <= 40.0);
    }
}
