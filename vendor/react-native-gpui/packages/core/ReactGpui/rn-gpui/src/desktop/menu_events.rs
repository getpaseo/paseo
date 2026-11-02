//! One route for every `muda` menu event.
//!
//! `muda` has exactly one `MenuEvent` channel, and `MenuEvent::set_event_handler`
//! takes it over: its documentation is explicit that a handler installed with
//! `Some` means `MenuEvent::receiver()` **stops receiving events at all**. The
//! setter is backed by a `OnceLock`, so the first caller wins and every later
//! call is silently ignored.
//!
//! Three parts of this app build `muda` menus — the Win32 menu bar, the tray
//! menu, and native context menus. Each used to install its own handler or read
//! the receiver, so only one of them could ever work: whichever installed first
//! took the channel, a menu-bar click had nowhere to go because its items
//! carried no id at all, and a native context menu could not read its selection
//! once either of the others had installed a handler.
//!
//! This module owns the single handler. Consumers register a predicate and a
//! callback; each event is offered to the registered consumers in order and the
//! first predicate that claims the id handles it. A context menu that is
//! currently showing is offered every event first, because it is modal.

use std::sync::{Mutex, OnceLock};

/// Claims an id and handles it. Returning `true` means this consumer took the
/// event and no later one should see it.
type Consumer = Box<dyn Fn(&str) -> bool + Send + Sync>;

/// Resolves the id a native context menu reported, while one is showing.
type ContextWaiter = Box<dyn Fn(String) + Send + Sync>;

/// Who handled an event, for the tests and for a caller that wants to know.
#[derive(Debug, PartialEq, Eq)]
enum Handled {
    /// A pending native context menu.
    ContextMenu,
    /// A registered consumer, by its position in the registration order.
    Consumer(usize),
    /// Nobody claimed the id; it was dropped.
    Unclaimed,
}

static CONSUMERS: Mutex<Vec<Consumer>> = Mutex::new(Vec::new());
static CONTEXT_WAITER: Mutex<Option<ContextWaiter>> = Mutex::new(None);
static INSTALLED: OnceLock<()> = OnceLock::new();

/// Offers `id` to the consumers, in registration order, and returns who took it.
///
/// This is the whole routing rule, and the installed handler is a thin wrapper
/// over it, so a test can exercise the real decision instead of a copy of it.
/// A context menu is checked first because it is modal: while one is showing it
/// is the only menu that can have produced an event.
fn route(id: &str) -> Handled {
    if let Ok(mut slot) = CONTEXT_WAITER.lock() {
        if let Some(callback) = slot.take() {
            callback(id.to_string());
            return Handled::ContextMenu;
        }
    }
    if let Ok(consumers) = CONSUMERS.lock() {
        for (index, consumer) in consumers.iter().enumerate() {
            if consumer(id) {
                return Handled::Consumer(index);
            }
        }
    }
    Handled::Unclaimed
}

/// Installs the single handler. Idempotent: the first call installs it and later
/// calls do nothing, which is what stops a second menu system from taking the
/// channel away from the first.
///
/// Two crates deliver menu events, each with exactly one channel, and this app
/// builds menus with both:
///
/// - `muda`, this crate's own dependency, builds the Win32 menu bar and the native
///   context menus on macOS and Windows.
/// - `tray_icon` bundles its own, newer `muda` and re-exports it as
///   `tray_icon::menu`, and the tray's menu is built with that copy on every
///   platform. The two are different versions — the lockfile holds both — so their
///   `MenuEvent`s are different channels even though the type has the same name,
///   and a selection from a tray menu arrives on `tray_icon`'s, never on `muda`'s.
///   Listening only on `muda`'s is what left a tray menu's items doing nothing on
///   macOS and Windows.
///
/// Linux's GPUI-drawn menus (the menu bar and context menus) do not use an event
/// channel at all; they report through their own responder.
fn ensure_installed() {
    INSTALLED.get_or_init(|| {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            let _ = muda::MenuEvent::set_event_handler(Some(|event: muda::MenuEvent| {
                route(&event.id.0);
            }));
        }
        let _ = tray_icon::menu::MenuEvent::set_event_handler(Some(
            |event: tray_icon::menu::MenuEvent| {
                route(&event.id.0);
            },
        ));
    });
}

/// Registers a consumer for menu ids it recognises. Registration order is the
/// order ids are offered in, so the first registration that claims an id wins.
pub fn register(consumer: Consumer) {
    if let Ok(mut consumers) = CONSUMERS.lock() {
        consumers.push(consumer);
    }
    ensure_installed();
}

/// Runs `show`, collecting the id the native context menu reports.
///
/// The menu is modal and `show` returns when it closes, so the selection has
/// already arrived by the time this returns. Replacing a previous waiter is
/// deliberate: a stale one belongs to a menu that is no longer up.
pub fn with_context_menu<F>(show: F) -> Option<String>
where
    F: FnOnce(),
{
    ensure_installed();
    let (sender, receiver) = std::sync::mpsc::channel::<String>();
    if let Ok(mut slot) = CONTEXT_WAITER.lock() {
        *slot = Some(Box::new(move |id| {
            let _ = sender.send(id);
        }));
    }
    show();
    // Clear the reservation whether or not anything was chosen, so a later
    // application-menu event is not swallowed by a menu that has closed.
    if let Ok(mut slot) = CONTEXT_WAITER.lock() {
        *slot = None;
    }
    receiver.try_recv().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each test owns the routing state it asserts on. The statics are
    /// process-wide, so tests that share them would interleave; this replaces
    /// the consumer list and the waiter for the duration of one test.
    struct Isolated {
        _guard: std::sync::MutexGuard<'static, ()>,
    }

    static TEST_LOCK: Mutex<()> = Mutex::new(());

    impl Isolated {
        fn new() -> Self {
            let guard = TEST_LOCK.lock().unwrap_or_else(|error| error.into_inner());
            CONSUMERS.lock().unwrap().clear();
            *CONTEXT_WAITER.lock().unwrap() = None;
            Self { _guard: guard }
        }
    }

    impl Drop for Isolated {
        fn drop(&mut self) {
            CONSUMERS.lock().unwrap().clear();
            *CONTEXT_WAITER.lock().unwrap() = None;
        }
    }

    #[test]
    fn the_first_consumer_that_claims_an_id_handles_it() {
        let _isolated = Isolated::new();
        register(Box::new(|id| id == "second-claims-this"));
        register(Box::new(|id| id == "second-claims-this"));
        register(Box::new(|_| false));
        // The first registration that claims it wins, so the second is never
        // consulted for this id.
        assert_eq!(route("second-claims-this"), Handled::Consumer(0));
    }

    #[test]
    fn a_consumer_that_does_not_claim_an_id_is_passed_over() {
        let _isolated = Isolated::new();
        register(Box::new(|id| id == "not-this-one"));
        register(Box::new(|id| id == "mine"));
        assert_eq!(route("mine"), Handled::Consumer(1));
    }

    #[test]
    fn an_unclaimed_id_is_dropped_rather_than_misrouted() {
        let _isolated = Isolated::new();
        register(Box::new(|id| id == "mine"));
        // An unrelated menu's id must not be handed to this consumer: the two
        // emit different JS events, so a misroute is a wrong action.
        assert_eq!(route("someone-elses"), Handled::Unclaimed);
    }

    #[test]
    fn a_pending_context_menu_takes_every_event_and_then_stops() {
        let _isolated = Isolated::new();
        register(Box::new(|_| true));
        // Reserve the channel the way `with_context_menu` does, then route an
        // id: it goes to the context menu, not to the registered consumer.
        let (sender, receiver) = std::sync::mpsc::channel::<String>();
        *CONTEXT_WAITER.lock().unwrap() = Some(Box::new(move |id| {
            let _ = sender.send(id);
        }));
        assert_eq!(route("cm-open"), Handled::ContextMenu);
        assert_eq!(receiver.try_recv().ok().as_deref(), Some("cm-open"));
        // The reservation is one-shot: the next event belongs to the normal
        // route again, so a menu that has closed cannot swallow it.
        assert_eq!(route("cm-open"), Handled::Consumer(0));
    }

    #[test]
    fn with_context_menu_reports_the_selection_and_clears_itself() {
        let _isolated = Isolated::new();
        register(Box::new(|_| true));
        // Simulate the menu closing with a choice: the callback is taken while
        // `show` runs, exactly as `muda` does when the menu closes.
        let selection = with_context_menu(|| {
            if let Some(callback) = CONTEXT_WAITER.lock().unwrap().take() {
                callback("cm-nested".to_string());
            }
        });
        assert_eq!(selection.as_deref(), Some("cm-nested"));
        assert!(
            CONTEXT_WAITER.lock().unwrap().is_none(),
            "the reservation must not outlive the menu"
        );
    }

    #[test]
    fn with_context_menu_reports_nothing_when_the_menu_is_dismissed() {
        let _isolated = Isolated::new();
        let selection = with_context_menu(|| {});
        assert_eq!(selection, None);
        assert!(CONTEXT_WAITER.lock().unwrap().is_none());
    }
}
