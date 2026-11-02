//! The native pickers, Finder/Explorer reveal, and "open with the default app".
//!
//! `rfd` owns the dialogs, so the platform differences (AppKit panels, the
//! Windows common dialogs, the XDG portal on Linux) stay out of this crate. All
//! of `rfd`'s dialog entry points are blocking, which is acceptable here: the
//! module has a thread of its own (`THREAD = Own`), so a panel left open blocks
//! neither JS nor a frame.
//!
//! # Open question: dialogs on macOS and the main thread
//!
//! The design flags that macOS may require the panel to be created on the main
//! thread, and that this has to be confirmed under GPUI's run loop before it can
//! be called done. What `rfd` 0.15's blocking API actually does on macOS is
//! dispatch the panel onto the main queue when the process already has a running
//! `NSApplication`, run it inline when the caller is already on the main thread,
//! and panic when neither holds. This module is on its own thread, so the first
//! branch is the one that applies, and the call should hop to the main thread and
//! block this module's thread until the panel closes.
//!
//! That is the theory, and it is **not yet verified** under GPUI's run loop. The
//! spike is: run the app, open a dialog from JS, and check that the panel
//! appears, that no main-thread warning is logged, that the module thread
//! resumes when it closes, and that the app does not deadlock while the panel is
//! up. If any of that fails, the fallback is the one the design names: a second
//! module, `GpuiFsDialogs`, with `THREAD = Main`, holding only the two pickers;
//! the rest of this module stays off the main thread. Attaching the panel to the
//! calling window (a sheet on macOS) is a further step that needs a host
//! function exposing the active window's raw handle for `rfd`'s `set_parent`,
//! which does not exist yet either.

use std::path::{Path, PathBuf};
use std::process::Command;

use rn_gpui_module::ModuleError;

use crate::errors;
use crate::{DialogFilter, OpenDialogOptions, SaveDialogOptions};

/// The open picker. An empty list means the user cancelled, which is what the JS
/// layer expects; a cancelled dialog is not a failure.
pub fn show_open(options: OpenDialogOptions) -> Result<Vec<String>, ModuleError> {
    let dialog = configured(
        options.title.as_deref(),
        options.default_path.as_deref(),
        &options.filters,
    );

    let picked = if options.directory {
        // A folder picker cannot return files, and `pick_folder` selects a
        // single folder — rfd's blocking folder call has no multi-select mode.
        // So `multiple` is honoured only as far as the platform allows: a
        // caller asking for `{ directory: true, multiple: true }` gets at most
        // one path, which is better than refusing the call outright.
        dialog.pick_folder().into_iter().collect()
    } else if options.multiple {
        dialog.pick_files().unwrap_or_default()
    } else {
        dialog.pick_file().into_iter().collect()
    };

    Ok(utf8_paths(picked))
}

/// The save picker. `None` means the user cancelled; no file is created here
/// either way, the caller decides what to write.
pub fn show_save(options: SaveDialogOptions) -> Result<Option<String>, ModuleError> {
    let (_, from_path) = split_default_path(options.default_path.as_deref());
    // `defaultName` wins over the name implied by `defaultPath`, but a path
    // ending in a file name is still the only hint a caller may give.
    let name = options
        .default_name
        .filter(|name| !name.trim().is_empty())
        .or(from_path);

    let mut dialog = configured(
        options.title.as_deref(),
        options.default_path.as_deref(),
        &options.filters,
    );
    if let Some(name) = name {
        dialog = dialog.set_file_name(name);
    }

    let picked = dialog.save_file();
    // The picker never writes, so a chosen name the bridge cannot represent is
    // reported as "nothing chosen" rather than as an error the user has no way
    // to act on; the alternative is a file the caller would try to write at a
    // path JS could not have named.
    Ok(picked.as_deref().and_then(utf8_path))
}

/// Shows `path` in the platform's file manager, selected where the platform has
/// a verb for it.
pub fn reveal(path: String) -> Result<(), ModuleError> {
    ensure_exists(&path)?;
    run(reveal_command(Path::new(&path)), &path)
}

/// Opens `path` with whatever the platform associates with it.
pub fn open_external(path: String) -> Result<(), ModuleError> {
    ensure_exists(&path)?;
    run(open_external_command(Path::new(&path)), &path)
}

/// A dialog carrying everything the three calls configure the same way: title,
/// starting directory, and the extension filters.
fn configured(
    title: Option<&str>,
    default_path: Option<&str>,
    filters: &[DialogFilter],
) -> rfd::FileDialog {
    let mut dialog = rfd::FileDialog::new();
    if let Some(title) = title {
        dialog = dialog.set_title(title);
    }
    if let Some(directory) = split_default_path(default_path).0 {
        dialog = dialog.set_directory(directory);
    }
    for filter in filters {
        // An empty extension list carries no information, and on some backends
        // a filter is applied as an allow-list, which would hide every file.
        if !filter.extensions.is_empty() {
            dialog = dialog.add_filter(filter.name.as_str(), &filter.extensions);
        }
    }
    dialog
}

/// Splits `defaultPath` into the directory a picker should open in, and the file
/// name to prefill when the path names a file rather than a folder.
///
/// The two pickers need different halves: the open dialog only starts in the
/// directory, the save dialog also offers the name.
fn split_default_path(default_path: Option<&str>) -> (Option<PathBuf>, Option<String>) {
    let Some(raw) = default_path.map(str::trim).filter(|path| !path.is_empty()) else {
        return (None, None);
    };
    let path = Path::new(raw);

    let is_directory = match std::fs::metadata(path) {
        Ok(metadata) => metadata.is_dir(),
        // A save dialog is usually given a path that does not exist yet, so fall
        // back to the spelling: a trailing separator promises a directory, and
        // anything else is a proposed file name whose parent is the start.
        Err(_) => ends_with_separator(raw),
    };

    if is_directory {
        (Some(path.to_path_buf()), None)
    } else {
        (
            path.parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .map(Path::to_path_buf),
            path.file_name()
                .and_then(|name| name.to_str())
                .map(str::to_string),
        )
    }
}

/// Whether a path is spelled as a directory on any of the platforms this module
/// runs on, so a Windows path still splits correctly when read elsewhere.
fn ends_with_separator(path: &str) -> bool {
    path.ends_with('/') || path.ends_with('\\')
}

/// The picked paths as strings, dropping any the bridge cannot represent.
///
/// A Unix file name need not be UTF-8, but JS can only hold strings. Failing the
/// whole selection because one of several files has an unusual name would throw
/// away the files the user can use, so the others are returned instead.
fn utf8_paths(paths: Vec<PathBuf>) -> Vec<String> {
    paths
        .into_iter()
        .filter_map(|path| utf8_path(&path))
        .collect()
}

fn utf8_path(path: &Path) -> Option<String> {
    path.to_str().map(str::to_string)
}

/// Fails with the same code `stat` would before a platform command can turn the
/// problem into an opaque non-zero exit.
fn ensure_exists(path: &str) -> Result<(), ModuleError> {
    // `symlink_metadata` rather than `metadata`: a dangling symlink is still a
    // row in Finder or Explorer, so revealing it is meaningful.
    std::fs::symlink_metadata(path)
        .map(|_| ())
        .map_err(|error| errors::from_io(error, path))
}

/// A command line, kept separate from running it so the platform branches can be
/// asserted on without opening anything.
#[derive(Debug, Clone, PartialEq, Eq)]
struct CommandSpec {
    program: &'static str,
    args: Vec<String>,
}

/// The command that reveals `path` in the platform's file manager.
fn reveal_command(path: &Path) -> CommandSpec {
    let shown = path.to_string_lossy().into_owned();

    #[cfg(target_os = "macos")]
    {
        // `open -R` is the only thing that selects the item rather than opening
        // its containing folder.
        CommandSpec {
            program: "open",
            args: vec!["-R".to_string(), shown],
        }
    }

    #[cfg(target_os = "windows")]
    {
        // `/select,<path>` is a single argument, comma included.
        //
        // Note: explorer.exe is known to return exit code 1 even when it does
        // open the window, which the non-zero check below would report as a
        // failure. That needs a check on a Windows machine; if it does bite,
        // this branch should treat a successful spawn as success instead of
        // reading the exit code.
        CommandSpec {
            program: "explorer",
            args: vec![format!("/select,{shown}")],
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        // `xdg-open` has no portable "select this item" verb, so the containing
        // folder is the closest equivalent. A path with no parent is its own
        // directory and is opened as it is.
        let folder = path.parent().unwrap_or(path);
        CommandSpec {
            program: "xdg-open",
            args: vec![folder.to_string_lossy().into_owned()],
        }
    }
}

/// The command that opens `path` with the platform's default application.
fn open_external_command(path: &Path) -> CommandSpec {
    let shown = path.to_string_lossy().into_owned();

    #[cfg(target_os = "macos")]
    {
        CommandSpec {
            program: "open",
            args: vec![shown],
        }
    }

    #[cfg(target_os = "windows")]
    {
        // `start` reads its first quoted argument as the window title, so the
        // empty string is required for a path containing spaces to survive.
        CommandSpec {
            program: "cmd",
            args: vec!["/C".to_string(), "start".to_string(), String::new(), shown],
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        CommandSpec {
            program: "xdg-open",
            args: vec![shown],
        }
    }
}

/// Runs a command and turns a refusal into a Node-shaped error.
///
/// `Command` is used without a shell, so a path is one argument no matter what
/// characters it contains; quoting and escaping are the platform's problem, not
/// a shell's.
fn run(spec: CommandSpec, path: &str) -> Result<(), ModuleError> {
    let status = Command::new(spec.program)
        .args(&spec.args)
        .status()
        // The program itself could not be started (missing, or not executable),
        // which is an I/O failure on the path the caller asked about.
        .map_err(|error| errors::from_io(error, path))?;

    if status.success() {
        return Ok(());
    }
    Err(errors::invalid(
        "EIO",
        format!(
            "EIO: i/o error, {path} ({} exited with {status})",
            spec.program
        ),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_default_path_that_names_a_file_splits_into_parent_and_name() {
        let file = std::env::temp_dir().join("rn-gpui-fs-dialog-default.txt");
        let (directory, name) = split_default_path(Some(&file.to_string_lossy()));
        assert_eq!(directory.as_deref(), Some(std::env::temp_dir().as_path()));
        assert_eq!(name.as_deref(), Some("rn-gpui-fs-dialog-default.txt"));
    }

    #[test]
    fn a_default_path_that_names_an_existing_directory_stays_a_directory() {
        let directory = std::env::temp_dir();
        let (found, name) = split_default_path(Some(&directory.to_string_lossy()));
        assert_eq!(found, Some(directory));
        assert_eq!(name, None);
    }

    #[test]
    fn a_bare_file_name_has_no_directory_to_open_in() {
        let (directory, name) = split_default_path(Some("rn-gpui-fs-report.csv"));
        assert_eq!(directory, None);
        assert_eq!(name.as_deref(), Some("rn-gpui-fs-report.csv"));
    }

    #[test]
    fn a_trailing_separator_marks_a_path_that_does_not_exist_as_a_directory() {
        let missing = std::env::temp_dir().join("rn-gpui-fs-not-created");
        let spelled = format!("{}/", missing.to_string_lossy());
        let (directory, name) = split_default_path(Some(&spelled));
        assert_eq!(directory, Some(missing));
        assert_eq!(name, None);
    }

    #[test]
    fn no_default_path_means_no_directory_and_no_name() {
        assert_eq!(split_default_path(None), (None, None));
        assert_eq!(split_default_path(Some("   ")), (None, None));
    }

    #[test]
    fn reveal_targets_the_platform_file_manager() {
        let spec = reveal_command(Path::new("/tmp/example.txt"));
        #[cfg(target_os = "macos")]
        {
            assert_eq!(spec.program, "open");
            assert_eq!(spec.args, ["-R", "/tmp/example.txt"]);
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            assert_eq!(spec.program, "xdg-open");
            // Only the folder, because xdg-open cannot select an item in it.
            assert_eq!(spec.args, ["/tmp"]);
        }
        #[cfg(target_os = "windows")]
        {
            assert_eq!(spec.program, "explorer");
            assert_eq!(spec.args, ["/select,/tmp/example.txt"]);
        }
    }

    #[test]
    fn open_external_hands_the_path_to_the_default_application() {
        let spec = open_external_command(Path::new("/tmp/example.txt"));
        assert_eq!(
            spec.args.last().map(String::as_str),
            Some("/tmp/example.txt")
        );
        #[cfg(target_os = "macos")]
        {
            assert_eq!(spec.program, "open");
            assert_eq!(spec.args.len(), 1);
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        assert_eq!(spec.program, "xdg-open");
        #[cfg(target_os = "windows")]
        {
            assert_eq!(spec.program, "cmd");
            // `/C start "" <path>`: the empty argument is the title `start`
            // would otherwise take the path for.
            assert_eq!(&spec.args[..3], ["/C", "start", ""]);
        }
    }

    #[test]
    fn a_path_with_spaces_is_still_a_single_argument() {
        let spec = open_external_command(Path::new("/tmp/two words.txt"));
        assert_eq!(
            spec.args.last().map(String::as_str),
            Some("/tmp/two words.txt")
        );
    }
}
