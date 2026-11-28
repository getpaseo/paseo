//! Where the app keeps small files of its own.

use std::path::PathBuf;

/// `<per-user config dir>/rn-gpui`, which holds window state, I18nManager
/// settings and the single-instance lock. `RN_GPUI_APP_DATA_DIR` replaces the
/// per-user config dir.
pub fn app_dir() -> PathBuf {
    app_dir_in(data_dir_override())
}

/// The folder `RN_GPUI_APP_DATA_DIR` names, when it is set and not empty.
pub fn data_dir_override() -> Option<PathBuf> {
    std::env::var_os("RN_GPUI_APP_DATA_DIR")
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
}

fn app_dir_in(override_dir: Option<PathBuf>) -> PathBuf {
    if let Some(dir) = override_dir {
        return dir.join("rn-gpui");
    }
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME")
        .map(|home| PathBuf::from(home).join("Library/Application Support"));
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")));
    base.unwrap_or_else(std::env::temp_dir).join("rn-gpui")
}

/// An app id as a file name part.
pub fn safe_id(app_id: &str) -> String {
    app_id.replace(
        |c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_',
        "_",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn override_replaces_the_base_folder() {
        assert_eq!(
            app_dir_in(Some(PathBuf::from("/data/one"))),
            PathBuf::from("/data/one").join("rn-gpui")
        );
        assert_ne!(app_dir_in(None), PathBuf::from("/data/one").join("rn-gpui"));
    }
}
