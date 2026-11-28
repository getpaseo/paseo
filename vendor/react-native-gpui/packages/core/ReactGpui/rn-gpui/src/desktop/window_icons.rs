//! The caption button icons of the desktop's icon theme.
//!
//! A theme ships `window-close-symbolic.svg` and its siblings: single-colour
//! shapes meant to take the colour of the text around them. They are looked up
//! the way GTK does, through the theme and the themes it inherits from, and
//! recoloured here because the app's images cannot.

use std::path::{Path, PathBuf};

const FALLBACK_THEMES: [&str; 3] = ["Adwaita", "breeze", "hicolor"];
const MAX_DEPTH: usize = 4;

/// The icon for a caption button (`close`, `minimize`, `maximize`, `restore`)
/// as an SVG data URI painted in `color` (`#rrggbb`), or `None` when no theme
/// has one.
pub fn window_icon(action: &str, color: &str) -> Option<String> {
    use base64::Engine;
    if !matches!(action, "close" | "minimize" | "maximize" | "restore") {
        return None;
    }
    let file = find_icon(&format!("window-{action}-symbolic.svg"))?;
    let icon = recolored(&std::fs::read_to_string(file).ok()?, color);
    Some(format!(
        "data:image/svg+xml;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(icon)
    ))
}

fn find_icon(file_name: &str) -> Option<PathBuf> {
    let roots = icon_roots();
    let mut themes = Vec::new();
    for theme in current_theme()
        .into_iter()
        .chain(FALLBACK_THEMES.map(String::from))
    {
        add_with_parents(&roots, &theme, &mut themes);
    }
    themes.iter().find_map(|theme| {
        roots
            .iter()
            .find_map(|root| search(&root.join(theme), file_name, 0))
    })
}

/// Appends `theme` and the themes it inherits, once each, nearest first.
fn add_with_parents(roots: &[PathBuf], theme: &str, themes: &mut Vec<String>) {
    if themes.iter().any(|known| known == theme) {
        return;
    }
    themes.push(theme.to_string());
    let parents = roots.iter().find_map(|root| {
        let text = std::fs::read_to_string(root.join(theme).join("index.theme")).ok()?;
        text.lines()
            .find_map(|line| line.strip_prefix("Inherits="))
            .map(|list| {
                list.split(',')
                    .map(|name| name.trim().to_string())
                    .collect::<Vec<_>>()
            })
    });
    for parent in parents.into_iter().flatten() {
        add_with_parents(roots, &parent, themes);
    }
}

fn icon_roots() -> Vec<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let data_home = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| home.as_ref().map(|home| home.join(".local/share")));
    let data_dirs = std::env::var("XDG_DATA_DIRS")
        .unwrap_or_else(|_| "/usr/local/share:/usr/share".to_string());
    let mut roots: Vec<PathBuf> = home.iter().map(|home| home.join(".icons")).collect();
    roots.extend(data_home.map(|dir| dir.join("icons")));
    roots.extend(
        data_dirs
            .split(':')
            .filter(|dir| !dir.is_empty())
            .map(|dir| Path::new(dir).join("icons")),
    );
    roots
}

fn search(dir: &Path, file_name: &str, depth: usize) -> Option<PathBuf> {
    let direct = dir.join(file_name);
    if direct.is_file() {
        return Some(direct);
    }
    if depth >= MAX_DEPTH {
        return None;
    }
    let mut children: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    children.sort();
    children
        .iter()
        .find_map(|child| search(child, file_name, depth + 1))
}

/// The icon theme in use: GTK's `icon-theme` setting, or KDE's `kdeglobals`.
fn current_theme() -> Option<String> {
    gsettings_theme().or_else(kde_theme)
}

fn gsettings_theme() -> Option<String> {
    let output = std::process::Command::new("gsettings")
        .args(["get", "org.gnome.desktop.interface", "icon-theme"])
        .stderr(std::process::Stdio::null())
        .output()
        .ok()
        .filter(|output| output.status.success())?;
    let text = String::from_utf8(output.stdout).ok()?;
    let name = text.trim().trim_matches('\'');
    (!name.is_empty()).then(|| name.to_string())
}

fn kde_theme() -> Option<String> {
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| Path::new(&home).join(".config")))?;
    let text = std::fs::read_to_string(config.join("kdeglobals")).ok()?;
    let mut in_icons = false;
    for line in text.lines() {
        let line = line.trim();
        if let Some(section) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            in_icons = section == "Icons";
        } else if in_icons {
            if let Some(name) = line.strip_prefix("Theme=") {
                return Some(name.to_string());
            }
        }
    }
    None
}

/// Paints every fill of a symbolic icon in `color`, in attributes and in `style`
/// declarations, and gives the root a fill for shapes that have none.
fn recolored(source: &str, color: &str) -> String {
    let mut out = replace_values(source, "fill=\"", '"', color);
    out = replace_values(&out, "fill:", ';', color);
    match out.find("<svg") {
        Some(at) => {
            out.insert_str(at + 4, &format!(" fill=\"{color}\""));
            out
        }
        None => out,
    }
}

/// Replaces the value that follows each `prefix` up to `end`, except `none`.
fn replace_values(text: &str, prefix: &str, end: char, color: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find(prefix) {
        let value_start = at + prefix.len();
        out.push_str(&rest[..value_start]);
        let tail = &rest[value_start..];
        let stop = tail
            .find(|c| c == end || c == '"' || c == '}')
            .unwrap_or(tail.len());
        if &tail[..stop] == "none" {
            out.push_str("none");
        } else {
            out.push_str(color);
        }
        rest = &tail[stop..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_fill_takes_the_colour_but_none() {
        let source = r#"<svg viewBox="0 0 16 16"><path d="m0 0" fill="gray" style="fill-rule:evenodd;fill:#808080;stroke:none"/><path fill="none"/></svg>"#;
        let out = recolored(source, "#fff");
        assert!(out.starts_with(r##"<svg fill="#fff" viewBox"##));
        assert!(out.contains(r##"fill="#fff" style"##));
        assert!(out.contains("fill:#fff;stroke:none"));
        assert!(out.contains(r#"fill="none""#));
        assert!(!out.contains("gray") && !out.contains("808080"));
    }
}
