//! Where the window's caption buttons sit, as the desktop has it configured.
//!
//! The answer is a GTK `button-layout` string such as
//! `appmenu:minimize,maximize,close`: the names left of the colon go on the left
//! of the title bar, the ones after it on the right.

/// GTK's own default, used where the desktop states nothing.
pub const DEFAULT_LAYOUT: &str = ":minimize,maximize,close";
const DEFAULT_LAYOUT_LEFT: &str = "close,minimize,maximize:";

static FALLBACK_LEFT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Puts the buttons on the left where the desktop states no layout. Must run
/// before the first [`button_layout`] call.
pub fn set_fallback_left(left: bool) {
    FALLBACK_LEFT.store(left, std::sync::atomic::Ordering::Relaxed);
}

#[cfg(target_os = "linux")]
pub fn button_layout() -> String {
    static LAYOUT: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    LAYOUT
        .get_or_init(|| {
            gnome_layout().or_else(kde_layout).unwrap_or_else(|| {
                if FALLBACK_LEFT.load(std::sync::atomic::Ordering::Relaxed) {
                    DEFAULT_LAYOUT_LEFT.to_string()
                } else {
                    DEFAULT_LAYOUT.to_string()
                }
            })
        })
        .clone()
}

#[cfg(not(target_os = "linux"))]
pub fn button_layout() -> String {
    DEFAULT_LAYOUT.to_string()
}

/// The `org.gnome.desktop.wm.preferences` key, as GTK reads it: through
/// `gsettings`, so the session's own overrides apply. The settings portal gives
/// the schema default instead, which is not what GTK apps on the same desktop
/// show.
#[cfg(target_os = "linux")]
fn gnome_layout() -> Option<String> {
    let output = std::process::Command::new("gsettings")
        .args(["get", "org.gnome.desktop.wm.preferences", "button-layout"])
        .stderr(std::process::Stdio::null())
        .output()
        .ok()
        .filter(|output| output.status.success())?;
    let text = String::from_utf8(output.stdout).ok()?;
    let layout = text.trim().trim_matches('\'');
    (!layout.is_empty()).then(|| layout.to_string())
}

/// KDE keeps the buttons in `kwinrc` as letters: `M` menu, `I` minimize,
/// `A` maximize, `X` close.
#[cfg(target_os = "linux")]
fn kde_layout() -> Option<String> {
    let home = std::env::var_os("XDG_CONFIG_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| std::path::Path::new(&home).join(".config"))
        })?;
    let text = std::fs::read_to_string(home.join("kwinrc")).ok()?;
    kde_layout_from(&text)
}

fn kde_layout_from(text: &str) -> Option<String> {
    let mut in_section = false;
    let (mut left, mut right) = (None, None);
    for line in text.lines() {
        let line = line.trim();
        if let Some(section) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            in_section = section == "org.kde.kdecoration2";
        } else if in_section {
            if let Some(value) = line.strip_prefix("ButtonsOnLeft=") {
                left = Some(value);
            } else if let Some(value) = line.strip_prefix("ButtonsOnRight=") {
                right = Some(value);
            }
        }
    }
    if left.is_none() && right.is_none() {
        return None;
    }
    let names = |letters: &str| {
        letters
            .chars()
            .filter_map(|letter| match letter {
                'M' => Some("menu"),
                'I' => Some("minimize"),
                'A' => Some("maximize"),
                'X' => Some("close"),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join(",")
    };
    Some(format!(
        "{}:{}",
        names(left.unwrap_or("M")),
        names(right.unwrap_or("IAX"))
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kwin_letters_become_a_gtk_layout() {
        let text = "[org.kde.kdecoration2]\nButtonsOnLeft=XIA\nButtonsOnRight=\n";
        assert_eq!(kde_layout_from(text).unwrap(), "close,minimize,maximize:");
        assert_eq!(kde_layout_from("[General]\nx=1\n"), None);
    }
}
