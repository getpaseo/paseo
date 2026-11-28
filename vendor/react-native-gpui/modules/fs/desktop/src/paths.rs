//! The well-known folders, as one `KnownPaths` object.
//!
//! `dirs` answers for the folders every platform has. The per-application three
//! — `appData`, `appCache`, `appLogs` — are this module's own convention, because
//! the host does not yet tell modules which app they belong to; see
//! `app_id` below. All three are created on the first read, as the design asks,
//! so a caller can write a log file without a `mkdir` first.

use std::path::{Path, PathBuf};

use rn_gpui_module::ModuleError;

use crate::KnownPaths;

/// The public folders plus the three per-application ones, created if needed.
///
/// Nothing here fails: a folder that does not exist is reported as the temp
/// directory instead. The design treats these as conveniences, and a caller
/// asking where to put a log file is better served by a working stand-in than by
/// a thrown error it cannot recover from — the alternative is a crash on a
/// system where, say, `Desktop` was never created.
pub fn known_paths() -> Result<KnownPaths, ModuleError> {
    let temp = std::env::temp_dir();
    let id = app_id();

    let root = std::env::var_os("RN_GPUI_APP_DATA_DIR");
    let (app_data, app_cache, app_logs) = app_folders(root.as_deref(), &id);

    Ok(KnownPaths {
        home: fallback(dirs::home_dir(), &temp),
        documents: fallback(dirs::document_dir(), &temp),
        downloads: fallback(dirs::download_dir(), &temp),
        desktop: fallback(dirs::desktop_dir(), &temp),
        temp: path_string(&temp),
        app_data: ensure_directory(app_data, &temp),
        app_cache: ensure_directory(app_cache, &temp),
        app_logs: ensure_directory(app_logs, &temp),
    })
}

/// The `appData`, `appCache` and `appLogs` folders for an app id.
///
/// A non-empty `RN_GPUI_APP_DATA_DIR` moves all three under that root so several
/// copies of an app can run side by side with separate data without overriding
/// `HOME`: `<root>/<id>`, `<root>/cache/<id>` and `<root>/logs/<id>`.
fn app_folders(
    root: Option<&std::ffi::OsStr>,
    id: &str,
) -> (Option<PathBuf>, Option<PathBuf>, Option<PathBuf>) {
    match root.filter(|root| !root.is_empty()).map(PathBuf::from) {
        Some(root) => (
            Some(root.join(id)),
            Some(root.join("cache").join(id)),
            Some(root.join("logs").join(id)),
        ),
        None => (
            dirs::data_dir().map(|dir| dir.join(id)),
            dirs::cache_dir().map(|dir| dir.join(id)),
            logs_dir(id),
        ),
    }
}

/// A folder as a string, with the temp directory standing in when the platform
/// cannot name it.
fn fallback(found: Option<PathBuf>, temp: &Path) -> String {
    path_string(found.as_deref().unwrap_or(temp))
}

/// A path as `KnownPaths` carries it. A non-UTF-8 path cannot be a JS string, so
/// the lossy form is used rather than failing: it is still a path the platform
/// will resolve, and the folder is only a suggestion to the caller.
fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Creates a directory that the returned path promises exists, falling back to
/// the temp directory if it cannot be created.
///
/// A failure here means the platform gave no base directory at all, or that it
/// exists but is not writable; temp is the one directory a process can normally
/// count on, so the caller still gets somewhere to write.
fn ensure_directory(found: Option<PathBuf>, temp: &Path) -> String {
    let Some(directory) = found else {
        return path_string(temp);
    };
    match std::fs::create_dir_all(&directory) {
        Ok(()) => path_string(&directory),
        Err(_) => path_string(temp),
    }
}

/// Where `appLogs` lives, which is the one app folder whose convention differs
/// by platform: macOS keeps logs under `~/Library/Logs`, the others under the
/// data directory. Both get the app id as their last component so two apps do
/// not share a log folder.
fn logs_dir(id: &str) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        dirs::home_dir().map(|home| home.join("Library").join("Logs").join(id))
    }
    #[cfg(not(target_os = "macos"))]
    {
        dirs::data_dir().map(|dir| dir.join(id).join("logs"))
    }
}

/// The id the three per-app folders are namespaced by.
///
/// This is a **placeholder**. The design wants these paths to be per-app and
/// says the host already knows the id (`DesktopAppConfig::app_id`), but no host
/// function exposes it to modules yet: `host_info().app_id` does not exist. Until
/// that API lands, `RN_GPUI_APP_ID` is honoured when the app sets it, and the
/// executable's file stem is the fallback — stable for a given binary, which is
/// enough to keep the folders apart and across runs.
///
/// When `host_info().app_id` is added, this function should read it and the two
/// fallbacks should go, because a renamed binary would otherwise move the app's
/// data and cache out from under the user.
fn app_id() -> String {
    let from_environment = std::env::var("RN_GPUI_APP_ID").ok();
    let from_executable = std::env::current_exe().ok().and_then(|exe| {
        exe.file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
    });
    pick_app_id(from_environment.as_deref(), from_executable.as_deref())
}

/// The selection half of `app_id`, split out so the precedence and the fallback
/// can be tested without touching the environment, which other tests share.
fn pick_app_id(from_environment: Option<&str>, from_executable: Option<&str>) -> String {
    [from_environment, from_executable]
        .into_iter()
        .flatten()
        .map(sanitise)
        .find(|id| !id.is_empty())
        // A process whose executable has no usable name still needs folders, and
        // the name only has to be stable, not accurate.
        .unwrap_or_else(|| "rn-gpui-app".to_string())
}

/// Strips the characters that cannot appear in a directory name on any of the
/// three platforms, so an id from the environment cannot escape its parent
/// directory or fail `create_dir_all` on Windows.
///
/// Leading and trailing dots and dashes go too: an id that was only separators
/// sanitises to nothing rather than to a directory named `-`, and one that began
/// with `..` cannot end up looking like a parent reference.
fn sanitise(id: &str) -> String {
    id.trim()
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0' => '-',
            other => other,
        })
        .collect::<String>()
        .trim_matches(|character| character == '.' || character == '-')
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_known_path_is_a_non_empty_string() {
        let paths = known_paths().expect("known paths");
        for (name, value) in [
            ("home", &paths.home),
            ("documents", &paths.documents),
            ("downloads", &paths.downloads),
            ("desktop", &paths.desktop),
            ("temp", &paths.temp),
            ("appData", &paths.app_data),
            ("appCache", &paths.app_cache),
            ("appLogs", &paths.app_logs),
        ] {
            assert!(!value.is_empty(), "{name} was empty");
        }
    }

    #[test]
    fn the_app_folders_exist_after_the_first_read() {
        let paths = known_paths().expect("known paths");
        for (name, value) in [
            ("appData", &paths.app_data),
            ("appCache", &paths.app_cache),
            ("appLogs", &paths.app_logs),
        ] {
            assert!(
                Path::new(value).is_dir(),
                "{name} was not created at {value}"
            );
        }
    }

    #[test]
    fn the_app_folders_are_distinct() {
        let paths = known_paths().expect("known paths");
        let app_data = Path::new(&paths.app_data);
        let app_cache = Path::new(&paths.app_cache);
        let app_logs = Path::new(&paths.app_logs);

        assert_ne!(app_data, app_cache);
        assert_ne!(app_data, app_logs);
        assert_ne!(app_cache, app_logs);
    }

    #[test]
    fn a_second_read_returns_the_same_folders() {
        // Creating a directory that already exists has to keep succeeding, since
        // the JS layer may call `getPaths()` more than once per run.
        let first = known_paths().expect("known paths");
        let second = known_paths().expect("known paths");
        assert_eq!(first.app_data, second.app_data);
        assert_eq!(first.app_cache, second.app_cache);
        assert_eq!(first.app_logs, second.app_logs);
    }

    #[test]
    fn an_id_from_the_environment_names_the_app_folders() {
        // Only the pure part is asserted: mutating the environment would race
        // with the other tests in this module, which read it concurrently.
        assert_eq!(sanitise("my-app"), "my-app");
        assert_eq!(sanitise(" ../escape "), "escape");
        assert_eq!(sanitise("a/b\\c"), "a-b-c");
        assert_eq!(sanitise("  "), "");
    }

    #[test]
    fn a_data_dir_override_roots_the_three_app_folders() {
        use std::ffi::OsStr;
        let (data, cache, logs) = app_folders(Some(OsStr::new("/srv/instance")), "notes");
        assert_eq!(data, Some(PathBuf::from("/srv/instance/notes")));
        assert_eq!(cache, Some(PathBuf::from("/srv/instance/cache/notes")));
        assert_eq!(logs, Some(PathBuf::from("/srv/instance/logs/notes")));
    }

    #[test]
    fn an_empty_or_missing_data_dir_override_keeps_the_platform_folders() {
        use std::ffi::OsStr;
        let default = app_folders(None, "notes");
        assert_eq!(app_folders(Some(OsStr::new("")), "notes"), default);
        assert_eq!(default.0, dirs::data_dir().map(|dir| dir.join("notes")));
        assert_eq!(default.1, dirs::cache_dir().map(|dir| dir.join("notes")));
    }

    #[test]
    fn the_environment_id_wins_over_the_executable_name() {
        assert_eq!(pick_app_id(Some("from-env"), Some("from-exe")), "from-env");
    }

    #[test]
    fn an_unusable_environment_id_falls_through_to_the_executable_name() {
        assert_eq!(pick_app_id(Some("   "), Some("from-exe")), "from-exe");
        // A separator-only id would escape its parent, which `sanitise` turns
        // into a name rather than a path.
        assert_eq!(pick_app_id(Some("/"), Some("from-exe")), "from-exe");
    }

    #[test]
    fn no_id_at_all_still_yields_a_stable_name() {
        assert_eq!(pick_app_id(None, None), "rn-gpui-app");
        assert_eq!(pick_app_id(Some(""), Some("")), "rn-gpui-app");
    }

    #[test]
    fn a_hostile_executable_name_cannot_escape_the_base_directory() {
        assert_eq!(pick_app_id(None, Some("../../etc/passwd")), "etc-passwd");
    }
}
