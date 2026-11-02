//! The module's own state, kept outside core.
//!
//! Core hands an observer facts about a batch and forgets them; everything a
//! stack has to remember between batches — which stacks are nested, which cards
//! are leaving, what a dismissal already animated — is here.
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// What `decorate` learned about a header, for `content` to use.
#[derive(Clone, Copy, Debug, Default)]
pub struct HeaderFacts {
    pub is_top: bool,
    pub shows_back: bool,
    pub has_title_subview: bool,
    /// The screen this header belongs to, which is where a back-button event
    /// has to go: React Native declares `onHeaderBackButtonClicked` on
    /// `RNSScreen`, not on the header config.
    pub screen: Option<i32>,
}

/// Records what `decorate` learned, so `content` can read it.
pub fn set_header_facts(
    tag: i32,
    is_top: bool,
    shows_back: bool,
    has_title_subview: bool,
    screen: Option<i32>,
) {
    with(|state| {
        state.headers.insert(
            tag,
            HeaderFacts {
                is_top,
                shows_back,
                has_title_subview,
                screen,
            },
        );
    });
}

/// Whether this header is the top screen's, as of the last `decorate` call.
pub fn header_is_top(tag: i32) -> bool {
    with(|state| state.headers.get(&tag).is_some_and(|facts| facts.is_top))
}

/// Whether this header carries a `title` subview, as of the last `decorate` call.
///
/// When it does, that subview paints the title and core must not paint its own.
pub fn header_has_title_subview(tag: i32) -> bool {
    with(|state| {
        state
            .headers
            .get(&tag)
            .is_some_and(|facts| facts.has_title_subview)
    })
}

/// The screen a header belongs to, as of the last `decorate` call.
pub fn header_screen(tag: i32) -> Option<i32> {
    with(|state| state.headers.get(&tag).and_then(|facts| facts.screen))
}

/// Whether this header shows a back button, as of the last `decorate` call.
pub fn header_shows_back(tag: i32) -> bool {
    with(|state| {
        state
            .headers
            .get(&tag)
            .is_some_and(|facts| facts.shows_back)
    })
}

/// A card that is leaving, and what should happen when it is gone.
#[derive(Clone, Debug)]
pub struct PopPlan {
    /// The screen that becomes top when this one is gone.
    pub revealed: Option<i32>,
    /// The animation name React Native asked for, unparsed.
    pub animation: String,
    /// How long the exit runs.
    pub duration: Duration,
    /// Whether the card must stay attached so its exit can paint.
    pub retain: bool,
}

/// Everything the module remembers between batches.
#[derive(Default)]
pub struct State {
    /// A native dismissal already ran the exit animation, so the removal must
    /// not run a second one and must not send the "will" events again.
    pub native_dismiss_pending: Option<i32>,
    /// Stacks that sit inside a screen, so only the outer stack animates.
    pub nested_stacks: HashSet<i32>,
    /// Cards leaving in this batch, by tag.
    pub pop_plans: HashMap<i32, PopPlan>,
    /// The cards this module started a transition on: whether it is an entry
    /// (the screen is arriving) or an exit, and how far it travels.
    pub roles: HashMap<i32, (Role, f32)>,
    /// The latest facts about each header, written by `decorate`.
    pub headers: HashMap<i32, HeaderFacts>,
}

/// Whether a transition the module started is an arrival or a departure.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Enter,
    Exit,
}

fn state() -> &'static Mutex<State> {
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(State::default()))
}

/// Runs `f` with the module state.
pub fn with<R>(f: impl FnOnce(&mut State) -> R) -> R {
    let mut state = state()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    f(&mut state)
}

/// Forgets the per-batch decisions. Call from `after_batch`.
pub fn clear_batch_state() {
    with(|state| {
        state.pop_plans.clear();
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batch_state_is_cleared_but_lifetimes_are_not() {
        with(|state| {
            state.pop_plans.insert(
                7,
                PopPlan {
                    revealed: Some(3),
                    animation: "slide_from_right".to_string(),
                    duration: Duration::from_millis(240),
                    retain: true,
                },
            );
            state.nested_stacks.insert(9);
            state.native_dismiss_pending = Some(7);
        });
        clear_batch_state();
        with(|state| {
            assert!(state.pop_plans.is_empty());
            assert!(state.nested_stacks.contains(&9));
            assert_eq!(state.native_dismiss_pending, Some(7));
        });
        with(|state| {
            state.nested_stacks.clear();
            state.native_dismiss_pending = None;
        });
    }
}
