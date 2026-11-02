//! The lifecycle events a stack sends to its screens as they appear and leave.
//!
//! React Native exposes these as `topWillAppear`, `topAppear`,
//! `topWillDisappear` and `topDisappear`, in that order around a transition.
use gpui::App;
use react_native_gpui::extensions::StoreHandle;

/// The events an activity-state change produces, in the order they fire.
pub fn lifecycle_events(previous: f32, next: f32) -> &'static [&'static str] {
    match (previous < 1.0, previous >= 2.0, next < 1.0, next >= 2.0) {
        (true, _, false, true) => &["topWillAppear", "topAppear"],
        (true, _, false, false) => &["topWillAppear"],
        (_, true, false, false) => &["topWillDisappear"],
        (false, false, true, _) => &["topDisappear"],
        (false, true, true, _) => &["topWillDisappear", "topDisappear"],
        (false, false, false, true) => &["topAppear"],
        _ => &[],
    }
}

/// Sends the "will" half of a transition: the outgoing screen then the incoming.
pub fn dispatch_will(
    handle: &StoreHandle,
    outgoing: Option<i32>,
    incoming: Option<i32>,
    cx: &mut App,
) {
    for (tag, event) in [
        outgoing.map(|tag| (tag, "topWillDisappear")),
        incoming.map(|tag| (tag, "topWillAppear")),
    ]
    .into_iter()
    .flatten()
    {
        log::info!("[screens] tag={tag} lifecycle={event}");
        handle.dispatch_event(tag, event, &serde_json::json!({}), cx);
    }
}

/// Sends the "did" half: the outgoing screen then the incoming, and wakes
/// Fabric so the callbacks arrive before a later pop unmounts them.
pub fn dispatch_did(
    handle: &StoreHandle,
    outgoing: Option<i32>,
    incoming: Option<i32>,
    cx: &mut App,
) {
    for (tag, event) in [
        outgoing.map(|tag| (tag, "topDisappear")),
        incoming.map(|tag| (tag, "topAppear")),
    ]
    .into_iter()
    .flatten()
    {
        log::info!("[screens] tag={tag} lifecycle={event}");
        handle.dispatch_event(tag, event, &serde_json::json!({}), cx);
    }
    // A timer can complete after the display-frame chain has gone idle, so the
    // JavaScript that handles these events needs a render to arrive in.
    handle.wake(cx);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activity_state_edges_emit_lifecycle_in_order() {
        assert_eq!(lifecycle_events(0.0, 1.0), &["topWillAppear"]);
        assert_eq!(lifecycle_events(1.0, 2.0), &["topAppear"]);
        assert_eq!(lifecycle_events(2.0, 1.0), &["topWillDisappear"]);
        assert_eq!(lifecycle_events(1.0, 0.0), &["topDisappear"]);
        assert_eq!(lifecycle_events(0.0, 2.0), &["topWillAppear", "topAppear"]);
        assert_eq!(
            lifecycle_events(2.0, 0.0),
            &["topWillDisappear", "topDisappear"]
        );
        assert!(lifecycle_events(1.0, 1.0).is_empty());
    }
}
