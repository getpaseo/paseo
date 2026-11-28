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
type MeasureFn = extern "C" fn(*const c_char, f32, f32, *mut f32, *mut f32);

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

#[cfg(not(test))]
extern "C" fn markdown_measure_cb(
    snapshot_json: *const c_char,
    max_width: f32,
    _max_height: f32,
    out_width: *mut f32,
    out_height: *mut f32,
) {
    let result = std::panic::catch_unwind(|| {
        if snapshot_json.is_null() {
            return (0.0f32, 0.0f32);
        }
        let json = unsafe { CStr::from_ptr(snapshot_json) }
            .to_str()
            .unwrap_or("");
        let Some(snapshot) = snapshot_from_str(json) else {
            return (0.0f32, 0.0f32);
        };
        let width_constraint = if max_width.is_finite() && max_width > 0.0 {
            Some(max_width)
        } else {
            None
        };
        let doc = layout_cached(&snapshot, width_constraint);
        let measured_w = if let Some(mw) = width_constraint {
            doc.width.min(mw)
        } else {
            doc.width
        };
        (measured_w.max(0.0), doc.height.max(0.0))
    })
    .unwrap_or((0.0, 0.0));

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
