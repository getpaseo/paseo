use crate::layout::{
    InteractiveCopyRect, InteractiveImageRect, InteractiveLinkRect, InteractiveTaskRect,
    LaidOutDocument,
};
use react_native_gpui::extensions::input::{
    ButtonSet, InputContext, InputSpec, MouseEvent, Propagation,
};
use serde_json::json;
use std::collections::HashMap;
use std::sync::Mutex;

const CLICK_DRAG_THRESHOLD_PX: f32 = 6.0;

#[derive(Clone, Debug, PartialEq)]
pub enum PressTarget {
    Link {
        url: String,
        source_type: String,
    },
    Task {
        index: i32,
        checked: bool,
        text: String,
    },
    Image {
        url: String,
        alt_text: String,
    },
    Copy {
        code: String,
        language: String,
    },
}

#[derive(Clone, Debug)]
struct PendingPress {
    start_x: f32,
    start_y: f32,
    target: PressTarget,
}

#[derive(Default)]
pub struct InteractionState {
    pending: Mutex<HashMap<i32, PendingPress>>,
}

fn contains(rx: f32, ry: f32, rw: f32, rh: f32, x: f32, y: f32) -> bool {
    x >= rx && x <= rx + rw && y >= ry && y <= ry + rh
}

pub fn hit_test_link<'a>(
    doc: &'a LaidOutDocument,
    x: f32,
    y: f32,
) -> Option<&'a InteractiveLinkRect> {
    doc.links
        .iter()
        .find(|r| contains(r.x, r.y, r.width, r.height, x, y))
}

pub fn hit_test_task<'a>(
    doc: &'a LaidOutDocument,
    x: f32,
    y: f32,
) -> Option<&'a InteractiveTaskRect> {
    doc.task_toggles
        .iter()
        .find(|r| contains(r.x, r.y, r.width, r.height, x, y))
}

pub fn hit_test_image<'a>(
    doc: &'a LaidOutDocument,
    x: f32,
    y: f32,
) -> Option<&'a InteractiveImageRect> {
    doc.images
        .iter()
        .find(|r| contains(r.x, r.y, r.width, r.height, x, y))
}

pub fn hit_test_copy<'a>(
    doc: &'a LaidOutDocument,
    x: f32,
    y: f32,
) -> Option<&'a InteractiveCopyRect> {
    doc.code_copies
        .iter()
        .find(|r| contains(r.x, r.y, r.width, r.height, x, y))
}

pub fn hit_test_target(doc: &LaidOutDocument, x: f32, y: f32) -> Option<PressTarget> {
    if let Some(link) = hit_test_link(doc, x, y) {
        return Some(PressTarget::Link {
            url: link.url.clone(),
            source_type: link.source_type.clone(),
        });
    }
    if let Some(task) = hit_test_task(doc, x, y) {
        return Some(PressTarget::Task {
            index: task.index,
            checked: !task.checked,
            text: task.text.clone(),
        });
    }
    if let Some(img) = hit_test_image(doc, x, y) {
        return Some(PressTarget::Image {
            url: img.url.clone(),
            alt_text: img.alt_text.clone(),
        });
    }
    if let Some(cb) = hit_test_copy(doc, x, y) {
        return Some(PressTarget::Copy {
            code: cb.code.clone(),
            language: cb.language.clone(),
        });
    }
    None
}

impl InteractionState {
    pub fn input_spec() -> InputSpec {
        InputSpec {
            mouse_buttons: ButtonSet::all(),
            ..Default::default()
        }
    }

    pub fn on_mouse_down(
        &self,
        tag: i32,
        doc: &LaidOutDocument,
        event: &MouseEvent,
    ) -> Propagation {
        if (event.buttons & 1) == 0 {
            return Propagation::Continue;
        }
        let x = f32::from(event.local.x);
        let y = f32::from(event.local.y);
        let Some(target) = hit_test_target(doc, x, y) else {
            return Propagation::Continue;
        };
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        pending.insert(
            tag,
            PendingPress {
                start_x: x,
                start_y: y,
                target,
            },
        );
        Propagation::Stop
    }

    pub fn on_mouse_up(
        &self,
        tag: i32,
        doc: &LaidOutDocument,
        event: &MouseEvent,
        cx: &mut InputContext<'_>,
    ) -> Propagation {
        let pending = {
            let mut map = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            map.remove(&tag)
        };
        let Some(press) = pending else {
            return Propagation::Continue;
        };
        let x = f32::from(event.local.x);
        let y = f32::from(event.local.y);
        let dx = x - press.start_x;
        let dy = y - press.start_y;
        if dx * dx + dy * dy > CLICK_DRAG_THRESHOLD_PX * CLICK_DRAG_THRESHOLD_PX {
            return Propagation::Stop;
        }
        let Some(released_target) = hit_test_target(doc, x, y) else {
            return Propagation::Stop;
        };
        if released_target != press.target {
            return Propagation::Stop;
        }

        match press.target {
            PressTarget::Link { url, source_type } => {
                cx.dispatch_event(
                    "topLinkPress",
                    &json!({ "url": url, "sourceType": source_type }),
                );
            }
            PressTarget::Task {
                index,
                checked,
                text,
            } => {
                cx.dispatch_event(
                    "topTaskListItemPress",
                    &json!({ "index": index, "checked": checked, "text": text }),
                );
            }
            PressTarget::Image { url, alt_text } => {
                cx.dispatch_event("topImagePress", &json!({ "url": url, "altText": alt_text }));
            }
            PressTarget::Copy { code, language } => {
                cx.dispatch_event(
                    "topCodeBlockPress",
                    &json!({ "code": code, "language": language }),
                );
            }
        }
        Propagation::Stop
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hit_test_matches_link_only_inside_bounds() {
        let doc = LaidOutDocument {
            width: 300.0,
            height: 100.0,
            links: vec![InteractiveLinkRect {
                x: 40.0,
                y: 12.0,
                width: 80.0,
                height: 20.0,
                url: "https://example.com".to_string(),
                source_type: "link".to_string(),
            }],
            ..Default::default()
        };

        assert_eq!(
            hit_test_target(&doc, 60.0, 20.0),
            Some(PressTarget::Link {
                url: "https://example.com".to_string(),
                source_type: "link".to_string(),
            })
        );
        assert_eq!(hit_test_target(&doc, 10.0, 20.0), None);
        assert_eq!(hit_test_target(&doc, 150.0, 20.0), None);
    }
}
