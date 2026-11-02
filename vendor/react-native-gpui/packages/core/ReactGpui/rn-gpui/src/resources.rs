//! Where a release build finds its JavaScript bundle and assets.
//!
//! In development the bundle and assets come from environment variables that
//! the CLI sets, and they point into the source tree. A packaged app has no
//! source tree: the files sit in whatever layout its installer chose, so the
//! paths are derived from the executable instead.
//!
//! | OS | Bundle | Assets |
//! | --- | --- | --- |
//! | macOS | `<exe>/../Resources/index.bundle` | `<exe>/../Resources/assets` |
//! | Windows | `<exe dir>/index.bundle` | `<exe dir>/assets` |
//! | Linux | `<exe>/../lib/<app>/index.bundle` | `<that dir>/assets` |
//!
//! Inside an AppImage the executable is at `usr/bin` and the libraries at
//! `usr/lib/<app>`, and `$APPDIR` names the mount root.
use std::path::{Path, PathBuf};

/// The operating system whose install layout applies.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Host {
    Macos,
    Windows,
    Linux,
    Other,
}

impl Host {
    /// The OS this binary was built for.
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::Macos
        } else if cfg!(target_os = "windows") {
            Self::Windows
        } else if cfg!(target_os = "linux") {
            Self::Linux
        } else {
            Self::Other
        }
    }
}

/// The directory holding the bundle and the assets, given an executable path.
///
/// `app_name` is the crate name the Linux installers use for the library
/// directory. `appdir` is `$APPDIR`, set only inside an AppImage. Pure: every
/// path it needs is passed in.
pub fn resource_dir(host: Host, exe: &Path, app_name: &str, appdir: Option<&Path>) -> PathBuf {
    let exe_dir = exe.parent().unwrap_or_else(|| Path::new("."));
    match host {
        // A macOS app bundle puts the executable in Contents/MacOS and the
        // resources in Contents/Resources.
        Host::Macos => exe_dir
            .parent()
            .map(|contents| contents.join("Resources"))
            .unwrap_or_else(|| exe_dir.join("Resources")),
        Host::Windows | Host::Other => exe_dir.to_path_buf(),
        Host::Linux => {
            // An AppImage mounts itself and sets APPDIR; the executable reports
            // its path inside that mount.
            if let Some(appdir) = appdir {
                return appdir.join("usr").join("lib").join(app_name);
            }
            exe_dir
                .parent()
                .map(|prefix| prefix.join("lib").join(app_name))
                .unwrap_or_else(|| exe_dir.join("lib").join(app_name))
        }
    }
}

/// The bundle in `directory`.
///
/// One name, always: a packaged release ships exactly one bundle and calls it
/// `index.bundle`, whether its content is Hermes bytecode or plain JavaScript.
/// Nothing here branches on the extension, and neither does the loader — Hermes
/// identifies its output by content, so a `.bundle` holding bytecode loads as
/// bytecode.
pub fn bundle_in(directory: &Path) -> PathBuf {
    directory.join("index.bundle")
}

/// The assets directory in `directory`.
pub fn assets_in(directory: &Path) -> PathBuf {
    directory.join("assets")
}

/// The directory this executable's resources live in, or `None` when the
/// executable path cannot be read.
///
/// The Linux library directory is named after the binary: the installers put
/// the executable at `bin/<name>` and its libraries at `lib/<name>`, so the
/// executable's own file name is the name to use, with nothing to plumb through.
pub fn packaged_resource_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let app_name = exe
        .file_stem()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let appdir = std::env::var_os("APPDIR").map(PathBuf::from);
    Some(resource_dir(
        Host::current(),
        &exe,
        &app_name,
        appdir.as_deref(),
    ))
}

/// The bundle path a build should use.
///
/// `RN_GPUI_BUNDLE` wins: the CLI sets it in development, pointing into the
/// source tree. A release build with the variable unset is a packaged app, and
/// looks beside its own executable.
pub fn default_bundle(fallback: &str) -> String {
    if let Some(bundle) = std::env::var_os("RN_GPUI_BUNDLE") {
        return bundle.to_string_lossy().into_owned();
    }
    resolve_bundle(fallback, !cfg!(debug_assertions), packaged_resource_dir())
}

/// The decision `default_bundle` makes, with its inputs passed in.
///
/// Split out so a debug test run can check the release path, which
/// `cfg!(debug_assertions)` would otherwise make unreachable.
fn resolve_bundle(fallback: &str, release: bool, resources: Option<PathBuf>) -> String {
    match (release, resources) {
        (true, Some(directory)) => bundle_in(&directory).to_string_lossy().into_owned(),
        _ => fallback.to_string(),
    }
}

/// The assets directory a build should use, or `None` when it has none.
///
/// `RN_GPUI_ASSETS_DIR` wins, for the same reason as [`default_bundle`].
pub fn default_assets_dir() -> Option<PathBuf> {
    if let Some(assets) = std::env::var_os("RN_GPUI_ASSETS_DIR") {
        return Some(PathBuf::from(assets));
    }
    resolve_assets_dir(!cfg!(debug_assertions), packaged_resource_dir())
}

/// The decision `default_assets_dir` makes, with its inputs passed in.
fn resolve_assets_dir(release: bool, resources: Option<PathBuf>) -> Option<PathBuf> {
    match (release, resources) {
        (true, Some(directory)) => Some(assets_in(&directory)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_macos_bundle_reads_from_contents_resources() {
        let dir = resource_dir(
            Host::Macos,
            Path::new("/Applications/My App.app/Contents/MacOS/my-app"),
            "my-app",
            None,
        );
        assert_eq!(
            dir,
            Path::new("/Applications/My App.app/Contents/Resources")
        );
    }

    #[test]
    fn windows_reads_beside_the_executable() {
        // The separator has to be the host's: `Path` on Unix does not treat a
        // backslash as one, so a Windows path only splits into components when
        // this runs on Windows.
        #[cfg(windows)]
        let (exe, expected) = (
            r"C:\Program Files\My App\my-app.exe",
            r"C:\Program Files\My App",
        );
        #[cfg(not(windows))]
        let (exe, expected) = ("/Program Files/My App/my-app.exe", "/Program Files/My App");
        let dir = resource_dir(Host::Windows, Path::new(exe), "my-app", None);
        assert_eq!(dir, Path::new(expected));
    }

    #[test]
    fn linux_reads_from_the_install_lib_directory() {
        let dir = resource_dir(Host::Linux, Path::new("/usr/bin/my-app"), "my-app", None);
        assert_eq!(dir, Path::new("/usr/lib/my-app"));
    }

    #[test]
    fn an_appimage_reads_from_inside_its_mount() {
        // Inside an AppImage the executable reports a path in the temporary
        // mount, and APPDIR names that mount's root.
        let dir = resource_dir(
            Host::Linux,
            Path::new("/tmp/.mount_myapp/usr/bin/my-app"),
            "my-app",
            Some(Path::new("/tmp/.mount_myapp")),
        );
        assert_eq!(dir, Path::new("/tmp/.mount_myapp/usr/lib/my-app"));
    }

    #[test]
    fn a_bare_executable_name_still_resolves() {
        // `current_exe` rarely returns a bare name, but the function must not
        // panic on one.
        assert_eq!(
            resource_dir(Host::Windows, Path::new("my-app.exe"), "my-app", None),
            Path::new("")
        );
    }

    #[test]
    fn a_debug_build_keeps_the_value_it_was_given() {
        // Development reads from the source tree, through the variable or the
        // built-in default; it must not go looking beside the executable.
        let resources = Some(PathBuf::from("/opt/my-app/Resources"));
        assert_eq!(
            resolve_bundle("build/index.bundle", false, resources.clone()),
            "build/index.bundle"
        );
        assert_eq!(resolve_assets_dir(false, resources), None);
    }

    #[test]
    fn a_release_build_with_no_resources_does_not_name_a_checkout() {
        // `bootstrap` passes a bare file name as the fallback. A release binary
        // must never carry an absolute path to the machine that built it: on the
        // installing machine that path does not exist, and the app cannot start.
        let fallback = resolve_bundle("index.bundle", true, None);
        assert_eq!(fallback, "index.bundle");
        assert!(!fallback.contains('/'), "fallback must not be a path");
    }

    #[test]
    fn a_release_build_looks_beside_the_executable() {
        let root =
            std::env::temp_dir().join(format!("rn-gpui-resources-release-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let resources = Some(root.clone());
        assert_eq!(
            resolve_bundle("build/index.bundle", true, resources.clone()),
            root.join("index.bundle").to_string_lossy()
        );
        assert_eq!(
            resolve_assets_dir(true, resources),
            Some(root.join("assets"))
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_release_build_with_no_executable_path_falls_back() {
        assert_eq!(
            resolve_bundle("build/index.bundle", true, None),
            "build/index.bundle"
        );
        assert_eq!(resolve_assets_dir(true, None), None);
    }

    #[test]
    fn a_bytecode_bundle_is_preferred_when_present() {
        let root = std::env::temp_dir().join(format!(
            "rn-gpui-resources-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        ));
        std::fs::create_dir_all(&root).unwrap();
        assert_eq!(bundle_in(&root), root.join("index.bundle"));
        // A stray bytecode-named file must not win: the packaged name is fixed,
        // and a second candidate is exactly how the wrong file got shipped before.
        std::fs::write(root.join("index.bundle.hbc"), b"bytecode").unwrap();
        assert_eq!(bundle_in(&root), root.join("index.bundle"));
        std::fs::remove_dir_all(&root).ok();
    }
}
