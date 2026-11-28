//! The cache key of a drawing: what decides its pixels, hashed in place.
//!
//! The document string is the expensive part of a render, so a lookup never
//! builds it: the key is a structural hash of the node, its props and its
//! children (the resolved colours are props), the frame's size and the scale.
//! A position is not part of it, so identical icons at different places share
//! one raster.

use react_native_gpui::extensions::ComponentNode;
use rn_gpui_sys::ffi::RectF;
use serde_json::Value;
use std::collections::hash_map::DefaultHasher;
use std::hash::Hasher;

/// Two independent 64 bit hashes of the same input.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Key(u64, u64);

struct Pair(DefaultHasher, DefaultHasher);

impl Hasher for Pair {
    fn write(&mut self, bytes: &[u8]) {
        self.0.write(bytes);
        self.1.write(bytes);
    }

    fn finish(&self) -> u64 {
        self.0.finish()
    }
}

fn hash_value(input: &Value, hasher: &mut Pair) {
    match input {
        Value::Null => hasher.write_u8(0),
        Value::Bool(flag) => {
            hasher.write_u8(1);
            hasher.write_u8(u8::from(*flag));
        }
        Value::Number(number) => {
            hasher.write_u8(2);
            hasher.write_u64(number.as_f64().unwrap_or(f64::NAN).to_bits());
        }
        Value::String(text) => {
            hasher.write_u8(3);
            hasher.write_usize(text.len());
            hasher.write(text.as_bytes());
        }
        Value::Array(items) => {
            hasher.write_u8(4);
            hasher.write_usize(items.len());
            for item in items {
                hash_value(item, hasher);
            }
        }
        Value::Object(entries) => {
            hasher.write_u8(5);
            hasher.write_usize(entries.len());
            for (name, entry) in entries {
                hasher.write_usize(name.len());
                hasher.write(name.as_bytes());
                hash_value(entry, hasher);
            }
        }
    }
}

fn node(node: &ComponentNode, hasher: &mut Pair) {
    hasher.write_usize(node.component.len());
    hasher.write(node.component.as_bytes());
    hash_value(&node.props, hasher);
    hasher.write_usize(node.children.len());
    for child in &node.children {
        self::node(child, hasher);
    }
}

pub fn node_key(root: &ComponentNode, frame: RectF, scale: f32) -> Key {
    let mut hasher = Pair(DefaultHasher::new(), DefaultHasher::new());
    hasher.1.write_u8(0x5a);
    node(root, &mut hasher);
    hasher.write_u32(frame.w.to_bits());
    hasher.write_u32(frame.h.to_bits());
    hasher.write_u32(scale.to_bits());
    Key(hasher.0.finish(), hasher.1.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;

    fn shape(props: Value) -> ComponentNode {
        ComponentNode {
            component: "RNSVGPath".into(),
            tag: 1,
            frame: RectF {
                x: 0.0,
                y: 0.0,
                w: 10.0,
                h: 10.0,
            },
            scale: (1.0, 1.0),
            props: Arc::new(props),
            parent: None,
            children: Vec::new(),
        }
    }

    fn svg(color: u32, d: &str) -> ComponentNode {
        let mut root = shape(json!({"color": color, "vbWidth": 24, "vbHeight": 24}));
        root.component = "RNSVGSvgView".into();
        root.children.push(shape(
            json!({"d": d, "fill": {"type": 0, "payload": color}}),
        ));
        root
    }

    const FRAME: RectF = RectF {
        x: 0.0,
        y: 0.0,
        w: 16.0,
        h: 16.0,
    };

    #[test]
    fn the_same_drawing_has_the_same_key_wherever_it_is() {
        let a = node_key(&svg(0xff112233, "M0 0L1 1"), FRAME, 2.0);
        let mut moved = svg(0xff112233, "M0 0L1 1");
        moved.frame.x = 99.0;
        moved.tag = 7;
        assert_eq!(a, node_key(&moved, RectF { x: 40.0, ..FRAME }, 2.0));
        assert_eq!(a, node_key(&svg(0xff112233, "M0 0L1 1"), FRAME, 2.0));
    }

    #[test]
    fn anything_that_changes_the_pixels_changes_the_key() {
        let base = node_key(&svg(0xff112233, "M0 0L1 1"), FRAME, 2.0);
        // A colour, a path, a child, the size and the scale each make a new key.
        assert_ne!(base, node_key(&svg(0xff112234, "M0 0L1 1"), FRAME, 2.0));
        assert_ne!(base, node_key(&svg(0xff112233, "M0 0L1 2"), FRAME, 2.0));
        let mut more = svg(0xff112233, "M0 0L1 1");
        more.children.push(shape(json!({"d": "M1 1"})));
        assert_ne!(base, node_key(&more, FRAME, 2.0));
        assert_ne!(
            base,
            node_key(
                &svg(0xff112233, "M0 0L1 1"),
                RectF { w: 17.0, ..FRAME },
                2.0
            )
        );
        assert_ne!(base, node_key(&svg(0xff112233, "M0 0L1 1"), FRAME, 1.0));
    }

    #[test]
    fn values_of_different_kinds_do_not_collide() {
        let flag = node_key(&shape(json!({"a": true})), FRAME, 1.0);
        let text = node_key(&shape(json!({"a": "true"})), FRAME, 1.0);
        let number = node_key(&shape(json!({"a": 1})), FRAME, 1.0);
        assert_ne!(flag, text);
        assert_ne!(flag, number);
        assert_ne!(
            node_key(&shape(json!({"ab": "c"})), FRAME, 1.0),
            node_key(&shape(json!({"a": "bc"})), FRAME, 1.0)
        );
    }
}

#[cfg(test)]
pub fn test_key(n: u64) -> Key {
    Key(n, n)
}
