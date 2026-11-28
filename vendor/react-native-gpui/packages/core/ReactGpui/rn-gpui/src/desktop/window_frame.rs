//! The frame a client-decorated window draws for itself: rounded corners, a
//! hairline border and a shadow, in a margin around the content.
//!
//! Only Linux asks the app for these: the compositor draws none of it for a
//! window that has taken its decorations over. Elsewhere every function answers
//! "no frame", so callers need no platform checks.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

/// How far the content is pushed in from each side of the window.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Insets {
    pub left: f32,
    pub top: f32,
    pub right: f32,
    pub bottom: f32,
}

impl Insets {
    pub fn horizontal(self) -> f32 {
        self.left + self.right
    }

    pub fn vertical(self) -> f32 {
        self.top + self.bottom
    }
}

/// What the frame looks like.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Frame {
    /// Corner radius of the window, in points.
    pub radius: f32,
    /// How far the shadow reaches beyond the window, and so the margin around it.
    pub shadow_extent: f32,
    /// `0xRRGGBBAA`, painted as a one-point line just inside the edge.
    pub border: u32,
    /// Opacity of the shadow at its densest, 0 to 1.
    pub shadow_alpha: f32,
    /// Standard deviation of the shadow's blur, in points.
    pub shadow_blur: f32,
    /// How far the shadow grows beyond the window before it blurs, in points.
    pub shadow_spread: f32,
    /// How far the shadow is shifted down, in points.
    pub shadow_dy: f32,
}

/// Used where the desktop's own frame has not been measured.
const DEFAULT: Frame = Frame {
    radius: 12.0,
    shadow_extent: 14.0,
    border: 0x0000_0040,
    shadow_alpha: 0.35,
    shadow_blur: 7.0,
    shadow_spread: 0.0,
    shadow_dy: 0.0,
};

static FALLBACK_RADIUS: AtomicU32 = AtomicU32::new(0);
static FRAME_ENABLED: AtomicBool = AtomicBool::new(true);

/// Whether a window gets the frame at all. A window that asked for no shadow, for
/// no system chrome, or for a see-through background draws its own look: the
/// frame's shadow sits under the content, so it would show through, and its
/// rounding and margin are not what such a window wants.
pub fn wanted(opaque: bool, shadow: bool, borderless: bool) -> bool {
    opaque && shadow && !borderless
}

/// Applies the `desktop.json` window options: the radius to use when the
/// desktop's cannot be measured, and whether to draw the shadow.
pub fn configure(fallback_radius: Option<f32>, shadow: bool) {
    FALLBACK_RADIUS.store(fallback_radius.unwrap_or(0.0).to_bits(), Ordering::Relaxed);
    FRAME_ENABLED.store(shadow, Ordering::Relaxed);
}

/// The frame to draw.
pub fn frame() -> Frame {
    let mut frame = measured().unwrap_or(DEFAULT);
    let fallback = f32::from_bits(FALLBACK_RADIUS.load(Ordering::Relaxed));
    if measured().is_none() && fallback > 0.0 {
        frame.radius = fallback;
    }
    if !FRAME_ENABLED.load(Ordering::Relaxed) {
        frame.shadow_extent = 0.0;
        frame.shadow_alpha = 0.0;
        frame.shadow_blur = 0.0;
        frame.shadow_spread = 0.0;
        frame.shadow_dy = 0.0;
    }
    frame
}

static MEASURED: std::sync::OnceLock<Option<Frame>> = std::sync::OnceLock::new();

fn measured() -> Option<Frame> {
    MEASURED.get().copied().flatten()
}

/// Measures the desktop's frame, or reads the last measurement while nothing it
/// depends on has changed. Runs once, before the first window, and costs a
/// child process only on a first launch or after a theme or library update.
pub fn load(app_id: &str) {
    #[cfg(target_os = "linux")]
    cache::name_for(app_id);
    #[cfg(not(target_os = "linux"))]
    let _ = app_id;
    MEASURED.get_or_init(measure_or_cached);
}

#[cfg(not(target_os = "linux"))]
fn measure_or_cached() -> Option<Frame> {
    None
}

#[cfg(target_os = "linux")]
fn measure_or_cached() -> Option<Frame> {
    if std::env::var_os("RN_GPUI_FRAME_PROBE").is_some_and(|value| value == "off")
        || std::env::var_os("RN_GPUI_TEST_OFFSCREEN").is_some()
    {
        return None;
    }
    let key = cache::key();
    if let Some(cached) = cache::read(&key) {
        return cached;
    }
    // A probe that could not run is not kept: the next launch tries again.
    let frame = cache::probe()?;
    cache::write(&key, frame);
    frame
}

#[cfg(target_os = "linux")]
mod cache {
    use std::io::Read;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    use super::Frame;

    const PROBE_TIMEOUT: Duration = Duration::from_millis(2500);

    static APP_DIRECTORY: std::sync::OnceLock<String> = std::sync::OnceLock::new();

    /// The app's own folder in the cache: its id, with anything a file name should
    /// not hold replaced, so each app keeps its own measurement.
    pub fn name_for(app_id: &str) {
        let name: String = app_id
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        let _ = APP_DIRECTORY.set(if name.trim_matches('.').is_empty() {
            "react-native-gpui".to_string()
        } else {
            name
        });
    }

    fn path() -> Option<PathBuf> {
        let base = crate::desktop::app_dir::data_dir_override()
            .map(|dir| dir.join("cache"))
            .or_else(|| std::env::var_os("XDG_CACHE_HOME").map(PathBuf::from))
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".cache")))?;
        let directory = APP_DIRECTORY
            .get()
            .map_or("react-native-gpui", String::as_str);
        Some(base.join(directory).join("window-frame.json"))
    }

    fn setting(schema: &str, key: &str) -> String {
        Command::new("gsettings")
            .args(["get", schema, key])
            .stderr(Stdio::null())
            .output()
            .ok()
            .and_then(|output| String::from_utf8(output.stdout).ok())
            .unwrap_or_default()
            .trim()
            .to_string()
    }

    /// `size:modified` of the first of `candidates` that exists.
    fn stamp(candidates: &[String]) -> String {
        candidates
            .iter()
            .find_map(|path| std::fs::metadata(path).ok())
            .map(|meta| {
                let modified = meta
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map_or(0, |elapsed| elapsed.as_secs());
                format!("{}:{modified}", meta.len())
            })
            .unwrap_or_default()
    }

    /// Everything the measurement depends on: the toolkit and theme in use, the
    /// libraries that draw it, and this runtime.
    pub fn key() -> String {
        let theme = setting("org.gnome.desktop.interface", "gtk-theme");
        let scheme = setting("org.gnome.desktop.interface", "color-scheme");
        let libraries = [
            "lib",
            "lib64",
            "lib/x86_64-linux-gnu",
            "lib/aarch64-linux-gnu",
        ];
        let find = |name: &str| -> Vec<String> {
            libraries
                .iter()
                .map(|dir| format!("/usr/{dir}/{name}"))
                .collect()
        };
        let theme_files: Vec<String> = {
            let name = theme.trim_matches('\'');
            let home = std::env::var("HOME").unwrap_or_default();
            let roots = [
                format!("{home}/.themes"),
                format!("{home}/.local/share/themes"),
                "/usr/share/themes".to_string(),
            ];
            let mut files = Vec::new();
            for version in ["gtk-4.0", "gtk-3.0"] {
                for file in ["gtk.css", "gtk.gresource"] {
                    files.extend(
                        roots
                            .iter()
                            .map(|root| format!("{root}/{name}/{version}/{file}")),
                    );
                }
            }
            files
        };
        format!(
            "v2|{}|{theme}|{scheme}|gtk:{}|adw:{}|css:{}",
            env!("CARGO_PKG_VERSION"),
            stamp(&find("libgtk-4.so.1")),
            stamp(&find("libadwaita-1.so.0")),
            theme_files
                .iter()
                .map(|file| stamp(std::slice::from_ref(file)))
                .collect::<Vec<_>>()
                .join(","),
        )
    }

    /// `Some(frame)` for a stored measurement of the same `key`, where `frame`
    /// is `None` if the toolkit could not be measured then.
    pub fn read(key: &str) -> Option<Option<Frame>> {
        let text = std::fs::read_to_string(path()?).ok()?;
        let value: serde_json::Value = serde_json::from_str(&text).ok()?;
        if value.get("key")?.as_str()? != key {
            return None;
        }
        match value.get("frame")? {
            serde_json::Value::Null => Some(None),
            frame => parse(frame).map(Some),
        }
    }

    pub fn write(key: &str, frame: Option<Frame>) {
        let Some(path) = path() else { return };
        let value = serde_json::json!({
            "key": key,
            "frame": frame.map(|frame| serde_json::json!({
                "radius": frame.radius,
                "shadow_extent": frame.shadow_extent,
                "border": frame.border,
                "shadow_alpha": frame.shadow_alpha,
                "shadow_blur": frame.shadow_blur,
                "shadow_spread": frame.shadow_spread,
                "shadow_dy": frame.shadow_dy,
            })),
        });
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(path, value.to_string());
    }

    fn parse(value: &serde_json::Value) -> Option<Frame> {
        Some(Frame {
            radius: value.get("radius")?.as_f64()? as f32,
            shadow_extent: value.get("shadow_extent")?.as_f64()? as f32,
            border: u32::try_from(value.get("border")?.as_u64()?).ok()?,
            shadow_alpha: value.get("shadow_alpha")?.as_f64()? as f32,
            shadow_blur: value.get("shadow_blur")?.as_f64()? as f32,
            shadow_spread: value.get("shadow_spread")?.as_f64()? as f32,
            shadow_dy: value.get("shadow_dy")?.as_f64()? as f32,
        })
    }

    /// Runs this executable as the probe and reads what it prints, giving up
    /// after a short while so a toolkit that hangs cannot hold the app back.
    ///
    /// `None` means the probe could not be run or did not finish, which says
    /// nothing about the toolkit; `Some(None)` is the probe's own answer that
    /// there is nothing to measure.
    pub fn probe() -> Option<Option<Frame>> {
        let mut child = Command::new(std::env::current_exe().ok()?)
            .arg("--rn-gpui-probe-frame")
            .env("GSK_RENDERER", "cairo")
            .env("GTK_CSD", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let started = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(status)) if status.success() => break,
                Ok(Some(_)) | Err(_) => return None,
                Ok(None) if started.elapsed() > PROBE_TIMEOUT => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            }
        }
        let mut output = String::new();
        child.stdout.take()?.read_to_string(&mut output).ok()?;
        let value: serde_json::Value = serde_json::from_str(output.lines().last()?).ok()?;
        match value {
            serde_json::Value::Null => Some(None),
            frame => parse(&frame).map(Some),
        }
    }
}

#[cfg(target_os = "linux")]
pub use linux::*;

#[cfg(target_os = "linux")]
mod linux {
    use std::cell::RefCell;
    use std::collections::HashMap;

    use gpui::{Decorations, Window};

    use super::{frame, Insets};
    use crate::desktop::popover_placement::{self, Anchor, Reserved};

    /// A popover drawn at a corner of a window that covers the work area, instead
    /// of being a window the compositor places.
    #[derive(Clone, Copy, Debug, PartialEq)]
    pub struct Placement {
        pub anchor: Anchor,
        pub offset: (f32, f32),
        pub reserved: Reserved,
        /// The popover's own size, which is the size of its content.
        pub size: (f32, f32),
        /// Where the click on the icon was, on the screen, when the desktop said,
        /// and where the work area starts on it.
        pub click: Option<(f32, f32)>,
        pub work_origin: (f32, f32),
        /// The window draws its own look, so the overlay adds no frame to it.
        pub bare: bool,
    }

    thread_local! {
        /// The windows that draw a frame, by surface id, and their current margin.
        static WINDOWS: RefCell<HashMap<i32, Insets>> = RefCell::new(HashMap::new());
        static PLACEMENTS: RefCell<HashMap<i32, Placement>> = RefCell::new(HashMap::new());
        static LAUNCHERS: RefCell<std::collections::HashSet<i32>> = RefCell::new(Default::default());
    }

    /// Records the window of `surface_id` as a launcher, which closes when it
    /// loses focus.
    pub fn mark_launcher(surface_id: i32) {
        LAUNCHERS.with(|launchers| launchers.borrow_mut().insert(surface_id));
    }

    pub fn is_launcher(surface_id: i32) -> bool {
        LAUNCHERS.with(|launchers| launchers.borrow().contains(&surface_id))
    }

    /// Makes the window of `surface_id` an overlay with the popover placed in it.
    pub fn place(surface_id: i32, placement: Placement) {
        enroll(surface_id);
        PLACEMENTS.with(|placements| placements.borrow_mut().insert(surface_id, placement));
    }

    pub fn placement_of(surface_id: i32) -> Option<Placement> {
        PLACEMENTS.with(|placements| placements.borrow().get(&surface_id).copied())
    }

    /// Makes the window of `surface_id` draw the frame.
    pub fn enroll(surface_id: i32) {
        WINDOWS.with(|windows| {
            windows.borrow_mut().entry(surface_id).or_default();
        });
    }

    pub fn is_framed(surface_id: i32) -> bool {
        WINDOWS.with(|windows| windows.borrow().contains_key(&surface_id))
    }

    /// The margin around a window's content as last synced; none for a window
    /// that draws no frame.
    pub fn insets_of(surface_id: i32) -> Insets {
        WINDOWS.with(|windows| {
            windows
                .borrow()
                .get(&surface_id)
                .copied()
                .unwrap_or_default()
        })
    }

    /// The margin a window gets: the shadow's reach on every side it does not
    /// share with the screen or a neighbour, none while the compositor draws the
    /// frame.
    pub fn insets_for(window: &Window, surface_id: i32) -> Insets {
        if let Some(placement) = placement_of(surface_id) {
            let view = window.viewport_size();
            let (width, height) = (f32::from(view.width), f32::from(view.height));
            let (x, y) = match placement.click {
                Some((click_x, click_y)) if placement.anchor == Anchor::Auto => {
                    popover_placement::place_near(
                        (
                            click_x - placement.work_origin.0,
                            click_y - placement.work_origin.1,
                        ),
                        placement.reserved,
                        (width, height),
                        placement.size,
                        popover_placement::MARGIN,
                        placement.offset,
                    )
                }
                _ => popover_placement::place(
                    placement.anchor,
                    placement.reserved,
                    (width, height),
                    placement.size,
                    popover_placement::MARGIN,
                    placement.offset,
                ),
            };
            return Insets {
                left: x,
                top: y,
                right: (width - x - placement.size.0).max(0.0),
                bottom: (height - y - placement.size.1).max(0.0),
            };
        }
        let Decorations::Client { tiling } = window.window_decorations() else {
            return Insets::default();
        };
        let extent = frame().shadow_extent;
        let side = |tiled: bool| if tiled { 0.0 } else { extent };
        Insets {
            left: side(tiling.left),
            top: side(tiling.top),
            right: side(tiling.right),
            bottom: side(tiling.bottom),
        }
    }

    /// Records the margin of an enrolled window; true when it changed.
    pub fn sync(window: &Window, surface_id: i32) -> bool {
        if !is_framed(surface_id) {
            return false;
        }
        let insets = insets_for(window, surface_id);
        WINDOWS.with(|windows| windows.borrow_mut().insert(surface_id, insets)) != Some(insets)
    }
}

#[cfg(not(target_os = "linux"))]
pub fn insets_of(_surface_id: i32) -> Insets {
    Insets::default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_window_that_draws_its_own_look_gets_no_frame() {
        assert!(wanted(true, true, false));
        assert!(!wanted(false, true, false));
        assert!(!wanted(true, false, false));
        assert!(!wanted(true, true, true));
    }

    #[test]
    fn the_options_shape_the_unmeasured_frame() {
        configure(Some(6.0), true);
        assert_eq!(frame().radius, 6.0);
        configure(None, true);
        assert_eq!(frame().radius, DEFAULT.radius);
        configure(None, false);
        assert_eq!(frame().shadow_extent, 0.0);
        configure(None, true);
    }
}
