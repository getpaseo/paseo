//! The watcher behind `watch` and `unwatch`.
//!
//! `notify` gives each watcher a thread of its own and calls the handler on it.
//! That handler cannot borrow the module — it may outlive any single call and
//! runs on a thread the module does not own — so it is handed a clone of the
//! event emitter and an `Arc` of the debounce table instead. The module only
//! stores the `RecommendedWatcher`; dropping that value stops the OS watch, and
//! with it the thread, which is how a JS reload closes every watcher at once.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::event::EventKind;
use notify::Watcher as _;
use notify::{RecommendedWatcher, RecursiveMode};
use rn_gpui_module::ModuleError;

use crate::{errors, RNFsModule, WatchEvent};

/// How long a path stays quiet after being reported.
///
/// An editor saving a file usually writes it several times in a burst (write,
/// rename over the original, a truncated open), and a recursive watch on a build
/// directory can see dozens of events for one logical change. Fifty milliseconds
/// collapses a burst into the single event a caller can act on without making a
/// genuinely repeated edit invisible.
const DEBOUNCE: Duration = Duration::from_millis(50);

/// An installed watch, kept alive by the module's table.
///
/// The field is never read: it exists so that removing the entry drops it, which
/// is what stops notify's thread and the platform watch.
pub struct Watcher {
    _watcher: RecommendedWatcher,
}

/// What was last reported for a path, and when.
#[derive(Clone, Copy)]
struct LastReport {
    at: Instant,
    kind: EventKindTag,
}

/// Which of the three stable names an event carries.
///
/// A copy of the mapping `kind_name` produces, so the debounce can compare two
/// events without allocating the string it will not send.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum EventKindTag {
    Create,
    Modify,
    Remove,
    Other,
}

/// Per-path timestamps of the last event that was reported.
///
/// Shared with the handler through an `Arc` because the handler owns its state
/// for as long as the watcher lives, which is longer than any borrow of the
/// module. Paths that fall out of the window are pruned on every report, so a
/// long-running recursive watch cannot grow this without bound.
///
/// The rule, in one sentence: **a burst is collapsed per path and per kind, and a
/// removal is never collapsed away.** Keeping only the first event of a burst
/// lost the end of it — a create followed by a remove reported only `create`, so
/// a caller was told about a file that no longer existed. Two adjustments fix
/// that without giving up the collapsing that makes an editor's write burst
/// readable:
///
/// - a path's window is per kind, so a `remove` after a `create` is a different
///   event rather than a suppressed one;
/// - a removal always reports, whatever the window, because it is the last state
///   a path can reach and swallowing it leaves the caller's view permanently
///   wrong. The cost is a possible duplicate removal for one logical deletion,
///   which a watcher callback can tolerate; a missing one it cannot.
#[derive(Default)]
struct Debounce {
    last: Mutex<HashMap<(PathBuf, EventKindTag), Instant>>,
}

impl Debounce {
    /// Whether this event should be delivered now.
    ///
    /// Takes `now` rather than reading the clock so the window can be tested
    /// without sleeping.
    fn should_report_at(&self, path: &Path, kind: EventKindTag, now: Instant) -> bool {
        let mut last = self.last.lock().unwrap_or_else(|error| error.into_inner());
        let key = (path.to_path_buf(), kind);
        let report = match last.get(&key).copied() {
            Some(previous) => {
                kind == EventKindTag::Remove || now.saturating_duration_since(previous) >= DEBOUNCE
            }
            None => true,
        };
        if report {
            last.retain(|_, previous| now.saturating_duration_since(*previous) < DEBOUNCE);
            last.insert(key, now);
        }
        report
    }

    fn should_report(&self, path: &Path, kind: EventKindTag) -> bool {
        self.should_report_at(path, kind, Instant::now())
    }
}

/// The stable string the JS layer matches on.
///
/// Everything that is not a create, modify or remove — access events, and the
/// catch-all notify reports when a backend cannot be more precise — becomes
/// `other` rather than leaking a platform-specific spelling.
fn kind_name(kind: &EventKind) -> &'static str {
    match kind {
        EventKind::Create(_) => "create",
        EventKind::Modify(_) => "modify",
        EventKind::Remove(_) => "remove",
        _ => "other",
    }
}

/// The tag `kind_name` corresponds to, for the debounce to compare by.
fn kind_tag(kind: &EventKind) -> EventKindTag {
    match kind {
        EventKind::Create(_) => EventKindTag::Create,
        EventKind::Modify(_) => EventKindTag::Modify,
        EventKind::Remove(_) => EventKindTag::Remove,
        _ => EventKindTag::Other,
    }
}

/// An event path as the caller should see it.
///
/// Node reports the path relative to the watch root, and a name alone for a
/// single-file watch. The platform reports an absolute path, and on macOS a
/// *canonical* one: FSEvents resolves `/var` to `/private/var`, so a plain string
/// prefix check against the path the caller gave strips nothing and the callback
/// receives an absolute path. Both roots are therefore tried, and the given one
/// last so a caller watching through a symlink still gets a relative name.
fn relative_event_path(path: &Path, roots: &[PathBuf], watching_file: bool) -> String {
    if watching_file {
        return path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string_lossy().into_owned());
    }
    for root in roots {
        if let Ok(rest) = path.strip_prefix(root) {
            // Normalised to `/`: Node reports relative paths with forward
            // slashes on every platform, and a Windows caller would otherwise get
            // `nested\file.txt` where Node gives `nested/file.txt`.
            return rest.to_string_lossy().replace('\\', "/");
        }
    }
    path.to_string_lossy().into_owned()
}

/// A notify failure as the error JS expects.
///
/// Most failures wrap an `io::Error` that already maps through `errors::from_io`;
/// the ones that do not are described well enough by notify to be reported with
/// the closest Node code.
fn watcher_error(error: notify::Error, path: &str) -> ModuleError {
    use notify::ErrorKind;
    let io = match error.kind {
        ErrorKind::Io(error) => error,
        ErrorKind::PathNotFound => std::io::Error::new(std::io::ErrorKind::NotFound, "not found"),
        ErrorKind::MaxFilesWatch => {
            std::io::Error::new(std::io::ErrorKind::Other, "OS file watch limit reached")
        }
        other => std::io::Error::new(std::io::ErrorKind::Other, format!("{other:?}")),
    };
    errors::from_io(io, path)
}

/// Starts watching `path`, returning the id events carry.
pub fn watch(module: &RNFsModule, path: String, recursive: bool) -> Result<f64, ModuleError> {
    // Node fails a watch on a missing path immediately, and so must this: the
    // platform watchers otherwise accept the path and then go silent, which is
    // indistinguishable at the call site from a directory nothing ever touches.
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err(errors::from_io(
            std::io::Error::new(std::io::ErrorKind::NotFound, "not found"),
            &path,
        ));
    }

    let id = module.take_watcher_id();
    let debounce = Arc::new(Debounce::default());
    let events = module.events.clone();
    // The canonical root is what macOS actually reports inside, and the given
    // root is what the caller passed; keeping both means the relative name
    // survives either spelling.
    let watching_file = target.is_file();
    let roots: Vec<PathBuf> = {
        let mut roots = Vec::new();
        if let Ok(canonical) = target.canonicalize() {
            roots.push(canonical);
        }
        roots.push(target.clone());
        roots
    };
    let handler = move |result: notify::Result<notify::Event>| {
        // A backend error has nowhere to go: it is not tied to a call, and
        // reporting it through the event stream would make it look like a file
        // change. notify's thread keeps running, so later events still arrive.
        let Ok(event) = result else { return };
        let kind = kind_name(&event.kind);
        let tag = kind_tag(&event.kind);
        // One platform event can name several paths — a directory move, for
        // instance — and a caller wants one delivery per path.
        for path in &event.paths {
            if !debounce.should_report(path, tag) {
                continue;
            }
            events.on_watch_event(WatchEvent {
                id: f64::from(id),
                kind: kind.to_string(),
                path: relative_event_path(path, &roots, watching_file),
            });
        }
    };

    let mut watcher =
        notify::recommended_watcher(handler).map_err(|error| watcher_error(error, &path))?;
    let mode = if recursive {
        RecursiveMode::Recursive
    } else {
        RecursiveMode::NonRecursive
    };
    watcher
        .watch(&target, mode)
        .map_err(|error| watcher_error(error, &path))?;

    module
        .watchers
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(id, Watcher { _watcher: watcher });
    Ok(f64::from(id))
}

/// Stops a watcher. An id that is already gone is not a failure: JS may close a
/// watcher twice, or close one whose module has already dropped it.
pub fn unwatch(module: &RNFsModule, id: f64) {
    let Ok(id) = crate::module::descriptor(id) else {
        return;
    };
    // Removing the entry drops the watcher, which stops notify's thread.
    module
        .watchers
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .remove(&id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, ModifyKind, RemoveKind};

    #[test]
    fn event_kinds_map_to_stable_names() {
        assert_eq!(kind_name(&EventKind::Create(CreateKind::File)), "create");
        assert_eq!(kind_name(&EventKind::Create(CreateKind::Any)), "create");
        assert_eq!(kind_name(&EventKind::Modify(ModifyKind::Any)), "modify");
        assert_eq!(kind_name(&EventKind::Remove(RemoveKind::Any)), "remove");
        assert_eq!(kind_name(&EventKind::Any), "other");
    }

    #[test]
    fn the_first_event_for_a_path_is_reported() {
        let debounce = Debounce::default();
        let now = Instant::now();
        assert!(debounce.should_report_at(Path::new("/a"), EventKindTag::Modify, now));
    }

    #[test]
    fn a_burst_is_collapsed_into_one_event() {
        let debounce = Debounce::default();
        let start = Instant::now();
        assert!(debounce.should_report_at(Path::new("/a"), EventKindTag::Modify, start));
        assert!(!debounce.should_report_at(
            Path::new("/a"),
            EventKindTag::Modify,
            start + Duration::from_millis(10)
        ));
        assert!(!debounce.should_report_at(
            Path::new("/a"),
            EventKindTag::Modify,
            start + Duration::from_millis(49)
        ));
        assert!(debounce.should_report_at(
            Path::new("/a"),
            EventKindTag::Modify,
            start + Duration::from_millis(50)
        ));
    }

    #[test]
    fn a_remove_inside_a_burst_is_not_swallowed() {
        let debounce = Debounce::default();
        let start = Instant::now();
        let path = Path::new("/a");
        // A create and the removal that follows it are two states of the path,
        // not one event seen twice: reporting only the create tells a caller
        // about a file that is already gone.
        assert!(debounce.should_report_at(path, EventKindTag::Create, start));
        assert!(debounce.should_report_at(
            path,
            EventKindTag::Remove,
            start + Duration::from_millis(5)
        ));
        // A second removal for the same deletion may arrive; a missing one may
        // not, so this is deliberately the lenient side of the trade.
        assert!(debounce.should_report_at(
            path,
            EventKindTag::Remove,
            start + Duration::from_millis(10)
        ));
    }

    #[test]
    fn a_modify_burst_still_collapses() {
        let debounce = Debounce::default();
        let start = Instant::now();
        let path = Path::new("/a");
        assert!(debounce.should_report_at(path, EventKindTag::Modify, start));
        // Two writes a millisecond apart are one logical change.
        assert!(!debounce.should_report_at(
            path,
            EventKindTag::Modify,
            start + Duration::from_millis(1)
        ));
    }

    #[test]
    fn a_canonical_root_still_yields_a_relative_name() {
        // macOS reports canonical paths, so a watch on `/var/...` sees
        // `/private/var/...`. Both roots are tried, and the caller gets a name
        // relative to the one they asked about either way.
        let canonical = PathBuf::from("/private/var/folders/x/tmp");
        let given = PathBuf::from("/var/folders/x/tmp");
        let roots = vec![canonical.clone(), given];
        let event = canonical.join("nested").join("file.txt");
        assert_eq!(
            relative_event_path(&event, &roots, false),
            "nested/file.txt"
        );
        // A path outside every root is passed through rather than mangled.
        assert_eq!(
            relative_event_path(Path::new("/elsewhere/file.txt"), &roots, false),
            "/elsewhere/file.txt"
        );
        // Watching a single file reports its name, which is what Node does.
        assert_eq!(relative_event_path(&event, &roots, true), "file.txt");
    }

    #[test]
    fn debouncing_is_per_path() {
        let debounce = Debounce::default();
        let start = Instant::now();
        assert!(debounce.should_report_at(Path::new("/a"), EventKindTag::Modify, start));
        assert!(debounce.should_report_at(
            Path::new("/b"),
            EventKindTag::Modify,
            start + Duration::from_millis(1)
        ));
        assert!(!debounce.should_report_at(
            Path::new("/a"),
            EventKindTag::Modify,
            start + Duration::from_millis(2)
        ));
    }

    #[test]
    fn paths_outside_the_window_are_forgotten() {
        let debounce = Debounce::default();
        let start = Instant::now();
        assert!(debounce.should_report_at(Path::new("/a"), EventKindTag::Modify, start));
        assert!(debounce.should_report_at(
            Path::new("/b"),
            EventKindTag::Modify,
            start + Duration::from_millis(60)
        ));
        let last = debounce.last.lock().unwrap();
        assert_eq!(last.len(), 1, "the stale path should have been pruned");
        assert!(last.contains_key(&(PathBuf::from("/b"), EventKindTag::Modify)));
    }
}
