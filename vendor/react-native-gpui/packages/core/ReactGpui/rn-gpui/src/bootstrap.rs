use crate::host::Host;
use crate::store::{OverlayHost, StoreGlobal, SurfaceRootView, ViewStore, APP_SURFACE_ID};
use gpui::{point, px, size, App, AppContext, Application, Bounds, WindowBounds, WindowOptions};
use rn_gpui_sys::ffi::MountBatch;
use std::cell::Cell;
use std::rc::Rc;
use std::time::Duration;

// SAFETY: `rn_gpui_mount_batch_applied` is defined in `GpuiMountingManager.cpp` with this signature.
unsafe extern "C" {
    fn rn_gpui_mount_batch_applied();
}

fn env_string(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

/// Smoke mode answers "does the app start and render?" for CI and packaging
/// checks: `run_with` exits with a single result line instead of opening a
/// window for a human. Exit codes: 0 first frame, 1 timeout, 2 JS error.
fn smoke_enabled() -> bool {
    matches!(
        std::env::var("RN_GPUI_SMOKE").as_deref(),
        Ok("1") | Ok("true")
    )
}

fn smoke_exit(code: i32, message: String) -> ! {
    use std::io::Write;
    println!("{message}");
    let _ = std::io::stdout().flush();
    let _ = std::io::stderr().flush();
    // `_exit`, not `std::process::exit`: `exit` runs C++ static destructors
    // while the JS, network and inspector threads are still running, and one
    // of them then calls into a destroyed object ("Pure virtual function
    // called", SIGABRT). The result line is already flushed, so nothing is lost.
    extern "C" {
        fn _exit(code: i32) -> !;
    }
    // SAFETY: `_exit` ends the process without unwinding, and nothing is borrowed across it.
    unsafe { _exit(code) }
}

fn smoke_first_frame() -> ! {
    smoke_exit(0, "RN_GPUI_SMOKE: first frame rendered".to_string());
}

/// The last stage: the frame the user is waiting for is on screen.
///
/// Separate from `smoke_first_frame` because that only runs in smoke mode, and
/// this trace should describe a real launch too.
fn trace_first_frame() {
    startup_trace("first frame presented");
}

fn smoke_timeout() -> ! {
    smoke_exit(1, "RN_GPUI_SMOKE: timeout".to_string());
}

fn smoke_js_error(message: &str) -> ! {
    smoke_exit(2, format!("RN_GPUI_SMOKE: js error: {message}"));
}

/// The C++ `onJsError` handler reports a JS error by logging it at error level
/// from `rn-gpui-sys`; that crate logs nothing else at error level except the
/// failure of a `void` TurboModule method. Smoke mode therefore watches for
/// that record and reports the first one before the first frame.
struct SmokeLogger {
    inner: env_logger::Logger,
}

impl log::Log for SmokeLogger {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        self.inner.enabled(metadata)
    }

    fn log(&self, record: &log::Record<'_>) {
        if record.level() == log::Level::Error && record.target() == "rn_gpui_sys" {
            smoke_js_error(&record.args().to_string());
        }
        self.inner.log(record);
    }

    fn flush(&self) {
        self.inner.flush();
    }
}

/// Installs the process logger. Smoke mode wraps `env_logger` so a JS error can
/// fail the run; otherwise this is the usual one-line init.
fn install_logger(smoke: bool) {
    let inner = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_millis()
        .build();
    let max_level = inner.filter();
    if smoke {
        log::set_boxed_logger(Box::new(SmokeLogger { inner })).expect("install the smoke logger");
    } else {
        log::set_boxed_logger(Box::new(inner)).expect("install the logger");
    }
    log::set_max_level(max_level);
}

/// Starts the smoke deadline. A run that never draws a frame has to fail on its
/// own, because nothing else in the process is watching the clock.
fn smoke_start_timeout() {
    let timeout_ms = env_u32("RN_GPUI_SMOKE_TIMEOUT_MS", 60_000);
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(u64::from(timeout_ms)));
        smoke_timeout();
    });
}

/// Reports the first frame that draws React content. A mount batch dirties the
/// window, so the frame GPUI draws after it carries the content, but
/// `on_next_frame` callbacks run *before* that draw. The callback therefore
/// re-arms once and exits at the start of the following frame.
fn smoke_arm_first_frame(cx: &mut gpui::AsyncApp, window: gpui::AnyWindowHandle) {
    let armed = cx.update_window(
        window,
        |_root: gpui::AnyView, window: &mut gpui::Window, _cx: &mut gpui::App| {
            window.on_next_frame(|window, _cx| {
                window.on_next_frame(|_window, _cx| {
                    trace_first_frame();
                    smoke_first_frame()
                });
            });
        },
    );
    if let Err(error) = armed {
        log::warn!("could not arm the smoke first-frame callback: {error}");
    }
}

/// Milliseconds since the process started, measured once.
///
/// A wall-clock delta from `main` would miss dyld and the C++ static
/// initialisers, which are part of what startup costs. Each platform has a way to
/// ask when the process began; the fallback is simply when this was first called.
fn process_elapsed() -> std::time::Duration {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    static PROCESS_START: std::sync::OnceLock<Option<std::time::SystemTime>> =
        std::sync::OnceLock::new();
    let now = START.get_or_init(std::time::Instant::now);
    let started = PROCESS_START.get_or_init(process_start_time);
    match started {
        Some(start) => start.elapsed().unwrap_or_else(|_| now.elapsed()),
        None => now.elapsed(),
    }
}

/// When the current process started, where the OS will say.
#[cfg(target_os = "macos")]
fn process_start_time() -> Option<std::time::SystemTime> {
    use std::os::raw::c_int;

    // `proc_pidinfo(PROC_PIDTBSDINFO)` fills a struct whose first two fields are
    // `pbi_flags` and `pbi_status`; the start time is the pair after them.
    #[repr(C)]
    #[derive(Default)]
    struct ProcBsdInfo {
        pbi_flags: u32,
        pbi_status: u32,
        pbi_xstatus: u32,
        pbi_pid: u32,
        pbi_ppid: u32,
        pbi_uid: u32,
        pbi_gid: u32,
        pbi_ruid: u32,
        pbi_rgid: u32,
        pbi_svuid: u32,
        // The saved-group id. Named for its position in `proc_bsdinfo`, not read
        // here; the layout is what matters for `proc_pidinfo` to fill it.
        #[allow(dead_code)]
        pbi_saved_gid: u32,
        rfu_1: u32,
        pbi_comm: [u8; 16],
        pbi_name: [u8; 32],
        pbi_nfiles: u32,
        pbi_pgid: u32,
        pbi_pjobc: u32,
        e_tdev: u32,
        e_tpgid: u32,
        pbi_nice: i32,
        pbi_start_tvsec: u64,
        pbi_start_tvusec: u64,
    }

    extern "C" {
        fn proc_pidinfo(
            pid: c_int,
            flavor: c_int,
            arg: u64,
            buffer: *mut std::os::raw::c_void,
            buffersize: c_int,
        ) -> c_int;
    }
    const PROC_PIDTBSDINFO: c_int = 3;

    let mut info = ProcBsdInfo::default();
    let size = std::mem::size_of::<ProcBsdInfo>() as c_int;
    // SAFETY: `info` is a correctly sized, writable struct of the layout the
    // call expects, and the return value is checked before it is read.
    let written = unsafe {
        proc_pidinfo(
            std::process::id() as c_int,
            PROC_PIDTBSDINFO,
            0,
            &mut info as *mut _ as *mut std::os::raw::c_void,
            size,
        )
    };
    if written != size {
        return None;
    }
    std::time::UNIX_EPOCH.checked_add(std::time::Duration::new(
        info.pbi_start_tvsec,
        info.pbi_start_tvusec as u32 * 1_000,
    ))
}

#[cfg(target_os = "linux")]
fn process_start_time() -> Option<std::time::SystemTime> {
    // `/proc/self/stat` field 22 is the start time in clock ticks since boot, and
    // `/proc/uptime` gives the boot instant's age. Together they date the process.
    let stat = std::fs::read_to_string("/proc/self/stat").ok()?;
    let start_ticks: u64 = stat
        .rsplit_once(") ")?
        .1
        .split_whitespace()
        .nth(19)?
        .parse()
        .ok()?;
    let uptime: f64 = std::fs::read_to_string("/proc/uptime")
        .ok()?
        .split_whitespace()
        .next()?
        .parse()
        .ok()?;
    // `_SC_CLK_TCK` is 100 on every Linux that matters here.
    let started_ago = uptime - (start_ticks as f64 / 100.0);
    std::time::SystemTime::now()
        .checked_sub(std::time::Duration::from_secs_f64(started_ago.max(0.0)))
}

#[cfg(target_os = "windows")]
fn process_start_time() -> Option<std::time::SystemTime> {
    #[repr(C)]
    #[derive(Default)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    extern "system" {
        fn GetCurrentProcess() -> *mut std::os::raw::c_void;
        fn GetProcessTimes(
            process: *mut std::os::raw::c_void,
            creation: *mut FileTime,
            exit: *mut FileTime,
            kernel: *mut FileTime,
            user: *mut FileTime,
        ) -> i32;
    }
    let mut creation = FileTime::default();
    let mut exit = FileTime::default();
    let mut kernel = FileTime::default();
    let mut user = FileTime::default();
    // SAFETY: all four pointers are to initialised, writable local structs.
    let ok = unsafe {
        GetProcessTimes(
            GetCurrentProcess(),
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        )
    };
    if ok == 0 {
        return None;
    }
    // FILETIME counts 100 ns intervals since 1601-01-01.
    let ticks = ((creation.high as u64) << 32) | creation.low as u64;
    let since_unix = ticks.checked_sub(116_444_736_000_000_000)?;
    std::time::UNIX_EPOCH.checked_add(std::time::Duration::from_nanos(since_unix * 100))
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn process_start_time() -> Option<std::time::SystemTime> {
    None
}

/// Emit a startup stage, when `RN_GPUI_STARTUP_TRACE` is set.
///
/// One cached env check when off, which is the only cost a shipped app pays. On
/// macOS each stage is also an `os_signpost` interval, so Instruments shows the
/// phases by name instead of a flat profile.
fn startup_trace(stage: &str) {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    if !*ENABLED.get_or_init(|| std::env::var_os("RN_GPUI_STARTUP_TRACE").is_some()) {
        return;
    }
    let elapsed = process_elapsed();
    eprintln!("[startup] +{} {stage}", elapsed.as_millis());
    signpost_stage(stage, elapsed);
}

/// Emit the signpost for a stage.
///
/// The macros in `os/signpost.h` are variadic and expand to a call whose ABI is
/// easy to get wrong from Rust; one wrong argument crashed the app on the very
/// first stage. The C++ side expands them as Apple intends.
fn signpost_stage(stage: &str, elapsed: std::time::Duration) {
    rn_gpui_sys::ffi::rn_gpui_startup_signpost(stage, elapsed.as_millis() as u64);
}

fn window_state_path(app_id: &str) -> std::path::PathBuf {
    #[cfg(feature = "visual-capture")]
    if let Some(path) = std::env::var_os("RN_GPUI_WINDOW_STATE") {
        return path.into();
    }
    let safe_id = app_id.replace(
        |c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_',
        "_",
    );
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME")
        .map(|home| std::path::PathBuf::from(home).join("Library/Application Support"));
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("APPDATA").map(std::path::PathBuf::from);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| std::path::PathBuf::from(home).join(".config"))
        });
    base.unwrap_or_else(std::env::temp_dir)
        .join("rn-gpui")
        .join(format!("{safe_id}-window.json"))
}

fn load_window_bounds(path: &std::path::Path) -> Option<(f32, f32, f32, f32)> {
    let value: serde_json::Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    let number = |key| value.get(key)?.as_f64().map(|value| value as f32);
    let (x, y, width, height) = (
        number("x")?,
        number("y")?,
        number("width")?,
        number("height")?,
    );
    (x.is_finite()
        && y.is_finite()
        && width.is_finite()
        && height.is_finite()
        && width >= 320.0
        && height >= 240.0)
        .then_some((x, y, width, height))
}

fn save_window_bounds(
    path: &std::path::Path,
    bounds: Bounds<gpui::Pixels>,
    viewport: gpui::Size<gpui::Pixels>,
) {
    let value = serde_json::json!({
        "x": f32::from(bounds.origin.x),
        "y": f32::from(bounds.origin.y),
        // Persist the content size used in `WindowBounds`; GPUI adds the
        // platform title-bar inset to `window.bounds()` on restore.
        "width": f32::from(viewport.width),
        "height": f32::from(viewport.height),
    });
    let result = (|| -> std::io::Result<()> {
        let parent = path.parent().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "window state path has no parent",
            )
        })?;
        std::fs::create_dir_all(parent)?;
        let temporary = path.with_extension("json.tmp");
        std::fs::write(&temporary, serde_json::to_vec(&value)?)?;
        std::fs::rename(temporary, path)
    })();
    if let Err(error) = result {
        log::warn!(
            "could not save window bounds to {}: {error}",
            path.display()
        );
    }
}

fn env_f32(key: &str, default: f32) -> f32 {
    std::env::var(key)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

fn env_u32(key: &str, default: u32) -> u32 {
    std::env::var(key)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

/// Whether the runtime should talk to Metro instead of loading `bundle_path`.
///
/// This is a runtime decision, not a compile-time one. The ReactCommon headers
/// default `enableDevMode` from `REACT_NATIVE_DEBUG`, but the prebuilt runtime
/// is always built in Release, so a debug app that links it would otherwise
/// never reach the dev server. The `rn-gpui` crate is compiled in the app's own
/// Cargo profile, so `debug_assertions` is the right default here and
/// `RN_GPUI_DEV_MODE` overrides it either way.
fn dev_mode() -> bool {
    std::env::var("RN_GPUI_DEV_MODE")
        .ok()
        .map(|value| matches!(value.as_str(), "1" | "true" | "yes"))
        .unwrap_or(cfg!(debug_assertions))
}

#[cfg(feature = "visual-capture")]
fn env_bool(key: &str, default: bool) -> bool {
    std::env::var(key)
        .ok()
        .map(|value| matches!(value.as_str(), "1" | "true" | "yes"))
        .unwrap_or(default)
}

#[cfg(feature = "visual-capture")]
fn env_opt_f32(key: &str) -> Option<f32> {
    std::env::var(key).ok().and_then(|value| value.parse().ok())
}

#[cfg(feature = "visual-capture")]
fn env_points(key: &str) -> Vec<(f32, f32)> {
    std::env::var(key)
        .ok()
        .map(|value| {
            value
                .split(';')
                .filter_map(|pair| {
                    let (x, y) = pair.split_once(',')?;
                    Some((x.trim().parse().ok()?, y.trim().parse().ok()?))
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(feature = "visual-capture")]
fn env_drags(key: &str) -> Vec<(f32, f32, f32, f32, bool)> {
    std::env::var(key)
        .unwrap_or_default()
        .split(';')
        .filter_map(|entry| {
            let mut parts = entry.split(':');
            let start = parts.next()?;
            let end = parts.next()?;
            let cancel = parts.next().is_some_and(|phase| phase.trim() == "cancel");
            let (start_x, start_y) = start.split_once(',')?;
            let (end_x, end_y) = end.split_once(',')?;
            Some((
                start_x.trim().parse().ok()?,
                start_y.trim().parse().ok()?,
                end_x.trim().parse().ok()?,
                end_y.trim().parse().ok()?,
                cancel,
            ))
        })
        .collect()
}

#[cfg(feature = "visual-capture")]
fn env_scrolls(key: &str) -> Vec<(f32, f32, f32, f32)> {
    std::env::var(key)
        .unwrap_or_default()
        .split(';')
        .filter_map(|entry| {
            let mut values = entry
                .split(',')
                .filter_map(|v| v.trim().parse::<f32>().ok());
            Some((
                values.next()?,
                values.next()?,
                values.next()?,
                values.next()?,
            ))
        })
        .collect()
}

/// macOS stops delivering frames while the display is asleep, so JS work a
/// synthetic click queued would never run; the input loops call this instead.
#[cfg(feature = "visual-capture")]
async fn flush_js(host: &Host, cx: &mut gpui::AsyncApp) {
    for _ in 0..6 {
        host.on_render();
        cx.background_executor()
            .timer(Duration::from_millis(16))
            .await;
    }
}

pub(crate) enum MainEvent {
    Mount(MountBatch),
    SurfaceStopped(i32),
    AnimatedProps(rn_gpui_sys::ffi::AnimatedPropsFlat),
    AnimatedActivity(bool),
    TextInputCommand {
        tag: i32,
        focus: bool,
    },
    AccessibilityFocus(i32),
    TextInputClear(i32),
    /// A command Fabric sent to a host component: its index in the spec's
    /// `COMMANDS` and its arguments, already validated by the generated C++
    /// dispatcher.
    HostCommand {
        tag: i32,
        command: u32,
        args: Vec<crate::host_component::HostArg>,
    },
    DevMenuShow,
    DevSetting {
        name: String,
        enabled: bool,
    },
    DevMenuPerform(String),
    TrayClick {
        x: f32,
        y: f32,
        width: f32,
        height: f32,
        button: u8,
    },
    TrayMenuPerform(String),
    MenuBarPerform(String),
    /// One desktop-shell command, run with the app context the main loop holds.
    /// It answers through the channel it was built with, which may be later:
    /// a context menu answers when it closes.
    DesktopCommand(Box<dyn FnOnce(&mut gpui::App) + Send + 'static>),
    MainTask(u64),
    /// Work a Rust module asked to run on the main thread.
    RustJob(rn_gpui_module::Job),
}

pub type WindowOptionsHook = Box<dyn FnOnce(&mut WindowOptions) + 'static>;
pub type AppReadyHook = Box<dyn FnOnce(&mut App) + 'static>;

pub type WindowOpenedHook = Box<dyn FnOnce(gpui::WindowId, &mut gpui::Window, &mut App) + 'static>;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum WindowTitleBar {
    #[default]
    Default,
    Transparent,
    /// No system title bar at all. GPUI only has "transparent" on macOS, so
    /// this is the same as [`WindowTitleBar::Transparent`] there.
    Hidden,
}

impl WindowTitleBar {
    /// What a `desktop.json` value or a `titleBar` prop names.
    ///
    /// An unknown name falls back to the default bar rather than failing: the
    /// schema is what rejects a typo in `desktop.json`, and a secondary window
    /// opened by an app built against an older schema must still open.
    pub fn from_name(name: &str) -> Self {
        match name {
            "transparent" => Self::Transparent,
            "hidden" => Self::Hidden,
            _ => Self::Default,
        }
    }

    /// Whether the app draws the bar itself, which is what lets the platform
    /// drop its own chrome.
    pub fn is_custom(self) -> bool {
        !matches!(self, Self::Default)
    }
}

/// Keeps the traffic lights inside the window they belong to.
///
/// A position from `desktop.json` is app-authored, so it can name somewhere the
/// window does not reach; AppKit would then move the buttons off screen with no
/// way to drag them back. A non-finite coordinate is treated as the origin rather
/// than propagated, because `f32::clamp` panics on `NaN`.
pub fn clamp_traffic_light_position(x: f32, y: f32, width: f32, height: f32) -> (f32, f32) {
    fn clamp(value: f32, limit: f32) -> f32 {
        if !value.is_finite() || !(limit > 0.0) {
            0.0
        } else {
            value.clamp(0.0, limit)
        }
    }
    (clamp(x, width), clamp(y, height))
}

/// Builds the GPUI view that is a GPUI-first app's main window content.
type GpuiRootHook = Box<dyn FnOnce(&mut App, crate::runtime::ReactRuntime) -> gpui::AnyView>;

pub struct DesktopAppConfig {
    pub app_id: String,
    pub module: String,
    /// Name of the installed JS engine package to run, e.g. `"hermes"`. Empty
    /// uses the only installed engine. `RN_GPUI_JS_ENGINE` overrides this.
    pub js_engine: String,
    pub width: f32,
    pub height: f32,
    pub title: Option<String>,
    pub position: Option<(f32, f32)>,
    pub restore_window_state: bool,
    pub quit_on_last_window_closed: bool,
    pub title_bar: WindowTitleBar,
    /// Whether the Dev Menu is available. `None` follows the build: on in a
    /// debug build, off in a release build.
    pub dev_menu: Option<bool>,
    pub tray: Option<crate::desktop::tray::TrayConfig>,
    pub traffic_light_position: Option<(f32, f32)>,
    /// Whether the main window shows a menu bar. Windows and Linux only.
    pub menu_bar: bool,
    pub configure_window: Option<WindowOptionsHook>,
    pub on_app_ready: Option<AppReadyHook>,

    pub on_window_opened: Option<WindowOpenedHook>,
    /// A GPUI-first app's main window content. When set,
    /// the main window shows this view instead of starting `module` on surface 1;
    /// React content lives in the `ReactSurface`s the view places.
    pub gpui_root: Option<GpuiRootHook>,
}

impl DesktopAppConfig {
    pub fn from_env() -> Self {
        Self::from_env_with_defaults("App", "com.example.rngpui")
    }

    pub fn from_env_with_defaults(module: &str, app_id: &str) -> Self {
        Self {
            app_id: env_string("RN_GPUI_APP_ID", app_id),
            module: env_string("RN_GPUI_MODULE", module),
            js_engine: String::new(),
            width: env_f32("RN_GPUI_WIDTH", 800.0),
            height: env_f32("RN_GPUI_HEIGHT", 600.0),
            title: None,
            position: None,
            restore_window_state: true,
            quit_on_last_window_closed: true,
            title_bar: WindowTitleBar::Default,
            dev_menu: None,
            tray: None,
            traffic_light_position: None,
            menu_bar: true,
            configure_window: None,
            on_app_ready: None,
            on_window_opened: None,
            gpui_root: None,
        }
    }

    #[must_use]
    pub fn js_engine(mut self, name: impl Into<String>) -> Self {
        self.js_engine = name.into();
        self
    }

    #[must_use]
    pub fn tray(mut self, config: crate::desktop::tray::TrayConfig) -> Self {
        self.tray = Some(config);
        self
    }

    #[must_use]
    pub fn dev_menu(mut self, enabled: bool) -> Self {
        self.dev_menu = Some(enabled);
        self
    }

    #[must_use]
    pub fn window_title(mut self, title: impl Into<String>) -> Self {
        self.title = Some(title.into());
        self
    }

    #[must_use]
    pub fn window_size(mut self, width: f32, height: f32) -> Self {
        self.width = width.max(320.0);
        self.height = height.max(240.0);
        self
    }

    #[must_use]
    pub fn window_position(mut self, x: f32, y: f32) -> Self {
        self.position = Some((x, y));
        self
    }

    #[must_use]
    pub fn restore_window_state(mut self, restore: bool) -> Self {
        self.restore_window_state = restore;
        self
    }

    #[must_use]
    pub fn quit_on_last_window_closed(mut self, quit: bool) -> Self {
        self.quit_on_last_window_closed = quit;
        self
    }

    #[must_use]
    pub fn title_bar(mut self, title_bar: WindowTitleBar) -> Self {
        self.title_bar = title_bar;
        self
    }

    #[must_use]
    pub fn traffic_light_position(mut self, x: f32, y: f32) -> Self {
        self.traffic_light_position = Some((x, y));
        self
    }

    /// Whether the main window shows a menu bar.
    ///
    /// Only Windows and Linux draw one inside the window; on macOS the bar is the
    /// system's, so this is ignored there.
    #[must_use]
    pub fn menu_bar(mut self, visible: bool) -> Self {
        self.menu_bar = visible;
        self
    }

    #[must_use]
    pub fn configure_window(
        mut self,
        configure: impl FnOnce(&mut WindowOptions) + 'static,
    ) -> Self {
        self.configure_window = Some(Box::new(configure));
        self
    }

    #[must_use]
    pub fn on_app_ready(mut self, callback: impl FnOnce(&mut App) + 'static) -> Self {
        self.on_app_ready = Some(Box::new(callback));
        self
    }

    #[must_use]
    pub fn on_window_opened(
        mut self,
        callback: impl FnOnce(gpui::WindowId, &mut gpui::Window, &mut App) + 'static,
    ) -> Self {
        self.on_window_opened = Some(Box::new(callback));
        self
    }

    /// Makes this a GPUI-first app: the main window shows the view `build`
    /// returns, and React content appears where that view places a
    /// [`ReactSurface`](crate::ReactSurface).
    ///
    /// The runtime still boots the way `run_with` always does — the JS engine, the
    /// bundle, the modules, the store — but no React tree is started on the main
    /// surface, so the window belongs to the app. `build` runs once, with the
    /// [`ReactRuntime`](crate::ReactRuntime) it can open further windows through.
    ///
    /// ```ignore
    /// run_with(DesktopAppConfig::from_env().gpui_first(|cx, _runtime| {
    ///     cx.new(|cx| {
    ///         let details = cx.new(|cx| ReactSurface::new("Details", cx));
    ///         Root { details }
    ///     })
    ///     .into()
    /// }));
    /// ```
    #[must_use]
    pub fn gpui_first(
        mut self,
        build: impl FnOnce(&mut App, crate::runtime::ReactRuntime) -> gpui::AnyView + 'static,
    ) -> Self {
        self.gpui_root = Some(Box::new(build));
        self
    }
}

impl Default for DesktopAppConfig {
    fn default() -> Self {
        Self::from_env()
    }
}

pub fn run() {
    run_with(DesktopAppConfig::from_env());
}

pub fn run_with(mut config: DesktopAppConfig) {
    #[cfg(not(feature = "test-driver"))]
    if std::env::var_os("RN_GPUI_TEST_DRIVER").is_some_and(|value| value != "0") {
        panic!("RN_GPUI_TEST_DRIVER is enabled, but this app was not built with --features test-driver");
    }
    startup_trace("main entered");
    rn_gpui_sys::note_main_thread();
    rn_gpui_module::note_main_thread();
    let smoke = smoke_enabled();
    install_logger(smoke);
    if smoke {
        smoke_start_timeout();
    }

    // A packaged release build has no source tree: the bundle is beside the
    // executable. `RN_GPUI_BUNDLE`, which the CLI sets in development, still
    // wins, and a debug build bakes in the path it was developed against.
    //
    // A release build with neither is a packaging mistake — no resources were
    // installed — so the fallback names the file it looked for rather than a
    // path into some checkout. That path must never be a repository path: it
    // would resolve on the machine that built the app, and nowhere else.
    let bundle = crate::resources::default_bundle("index.bundle");
    let source_url = env_string("RN_GPUI_SOURCE_URL", "index");
    let app_id = config.app_id.clone();
    let js_engine = env_string("RN_GPUI_JS_ENGINE", &config.js_engine);
    let dev_host = env_string("RN_GPUI_DEV_HOST", "localhost");
    let dev_port = env_u32("RN_GPUI_DEV_PORT", 8081);
    let module = config.module.clone();
    let width = config.width;
    let height = config.height;
    let window_state_path = window_state_path(&app_id);
    #[cfg(feature = "visual-capture")]
    let scale_override = env_opt_f32("RN_GPUI_SCALE");
    #[cfg(not(feature = "visual-capture"))]
    let scale_override: Option<f32> = None;
    #[cfg(feature = "visual-capture")]
    let run_ms = env_u32("RN_GPUI_RUN_MS", 0);
    #[cfg(feature = "perf-timing")]
    let benchmark_ms = env_u32("RN_GPUI_BENCHMARK_MS", 0);
    #[cfg(feature = "perf-timing")]
    let benchmark_mode = crate::store::benchmark_mode()
        .unwrap_or("unspecified")
        .to_owned();
    #[cfg(feature = "visual-capture")]
    let resize_ms = env_u32("RN_GPUI_RESIZE_MS", 0);
    #[cfg(feature = "visual-capture")]
    let resize_width = env_f32("RN_GPUI_RESIZE_WIDTH", 1200.0);
    #[cfg(feature = "visual-capture")]
    let resize_height = env_f32("RN_GPUI_RESIZE_HEIGHT", 400.0);
    #[cfg(feature = "visual-capture")]
    let clicks = env_points("RN_GPUI_CLICK");
    #[cfg(feature = "visual-capture")]
    let click_ms = env_u32("RN_GPUI_CLICK_MS", 1500);
    #[cfg(feature = "visual-capture")]
    let click_hold_ms = env_u32("RN_GPUI_CLICK_HOLD_MS", 0);
    #[cfg(feature = "visual-capture")]
    let drags = env_drags("RN_GPUI_DRAG");
    #[cfg(feature = "visual-capture")]
    let drag_ms = env_u32("RN_GPUI_DRAG_MS", 1800);
    #[cfg(feature = "visual-capture")]
    let drag_start_ms = env_u32("RN_GPUI_DRAG_START_MS", drag_ms);
    #[cfg(feature = "visual-capture")]
    let skip_synthetic_input_flush = env_bool("RN_GPUI_SKIP_INPUT_FLUSH", false);
    #[cfg(feature = "visual-capture")]
    let hovers = env_points("RN_GPUI_HOVER");
    #[cfg(feature = "visual-capture")]
    let hover_ms = env_u32("RN_GPUI_HOVER_MS", 800);
    #[cfg(feature = "visual-capture")]
    let scrolls = env_scrolls("RN_GPUI_SCROLL");
    #[cfg(feature = "visual-capture")]
    let scroll_ms = env_u32("RN_GPUI_SCROLL_MS", 1500);
    #[cfg(feature = "visual-capture")]
    let scroll_start_ms = env_u32("RN_GPUI_SCROLL_START_MS", scroll_ms);
    #[cfg(feature = "visual-capture")]
    let keys: Vec<String> = std::env::var("RN_GPUI_KEY")
        .unwrap_or_default()
        .split(';')
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(str::to_owned)
        .collect();
    #[cfg(feature = "visual-capture")]
    let key_ms = env_u32("RN_GPUI_KEY_MS", 1500);
    #[cfg(feature = "visual-capture")]
    let mouse_navigation: Vec<String> = std::env::var("RN_GPUI_MOUSE_NAV")
        .unwrap_or_default()
        .split(';')
        .map(str::trim)
        .filter(|direction| matches!(*direction, "back" | "forward"))
        .map(str::to_owned)
        .collect();
    #[cfg(feature = "visual-capture")]
    let mouse_navigation_ms = env_u32("RN_GPUI_MOUSE_NAV_MS", 1500);
    #[cfg(feature = "visual-capture")]
    let screenshot = std::env::var("RN_GPUI_SCREENSHOT").ok();
    #[cfg(feature = "visual-capture")]
    let screenshot_delay_ms = env_u32("RN_GPUI_SCREENSHOT_DELAY_MS", 500);
    #[cfg(feature = "visual-capture")]
    let screenshots: Vec<(u32, String)> = std::env::var("RN_GPUI_SCREENSHOTS")
        .unwrap_or_default()
        .split(';')
        .filter_map(|entry| {
            let (delay, path) = entry.split_once(':')?;
            Some((delay.parse().ok()?, path.to_owned()))
        })
        .collect();

    // Installed before any surface starts, otherwise the first mount batch would
    // be dropped.
    let (tx, rx) = async_channel::unbounded::<MainEvent>();
    let mount_tx = tx.clone();
    let _ = rn_gpui_sys::MOUNT_HANDLER.set(Box::new(move |batch: MountBatch| {
        let _ = mount_tx.send_blocking(MainEvent::Mount(batch));
    }));
    let surface_tx = tx.clone();
    let _ = rn_gpui_sys::SURFACE_STOPPED_HANDLER.set(Box::new(move |surface_id: i32| {
        let _ = surface_tx.send_blocking(MainEvent::SurfaceStopped(surface_id));
    }));
    let animated_tx = tx.clone();
    let _ = rn_gpui_sys::ANIMATED_PROPS_HANDLER.set(Box::new(move |props| {
        let _ = animated_tx.send_blocking(MainEvent::AnimatedProps(props));
    }));
    let activity_tx = tx.clone();
    let _ = rn_gpui_sys::ANIMATED_ACTIVE_HANDLER.set(Box::new(move |active| {
        let _ = activity_tx.send_blocking(MainEvent::AnimatedActivity(active));
    }));
    let text_input_command_tx = tx.clone();
    let _ = rn_gpui_sys::TEXT_INPUT_COMMAND_HANDLER.set(Box::new(move |tag, focus| {
        let _ = text_input_command_tx.send_blocking(MainEvent::TextInputCommand { tag, focus });
    }));
    let host_command_tx = tx.clone();
    let _ = rn_gpui_sys::HOST_COMMAND_HANDLER.set(Box::new(move |tag, command, args| {
        let _ = host_command_tx.send_blocking(MainEvent::HostCommand {
            tag,
            command,
            args: args
                .into_iter()
                .map(crate::host_component::HostArg::from_ffi)
                .collect(),
        });
    }));
    let accessibility_focus_tx = tx.clone();
    let _ = rn_gpui_sys::ACCESSIBILITY_FOCUS_HANDLER.set(Box::new(move |tag| {
        let _ = accessibility_focus_tx.send_blocking(MainEvent::AccessibilityFocus(tag));
    }));
    let text_input_clear_tx = tx.clone();
    let _ = rn_gpui_sys::TEXT_INPUT_CLEAR_HANDLER.set(Box::new(move |tag| {
        let _ = text_input_clear_tx.send_blocking(MainEvent::TextInputClear(tag));
    }));
    let desktop_tx = tx.clone();
    crate::desktop::set_command_sender(desktop_tx);
    let main_task_tx = tx.clone();
    let _ = rn_gpui_sys::MAIN_TASK_HANDLER.set(Box::new(move |id| {
        let _ = main_task_tx.send_blocking(MainEvent::MainTask(id));
    }));
    // Rust modules that ask for the main thread hand their work over here; the
    // future is created and polled on the main thread, so it never has to be
    // `Send`.
    let rust_job_tx = tx.clone();
    rn_gpui_module::set_main_spawner(move |job| {
        let _ = rust_job_tx.send_blocking(MainEvent::RustJob(job));
    });
    let dev_menu_tx = tx.clone();
    let _ = rn_gpui_sys::DEV_MENU_SHOW_HANDLER.set(Box::new(move || {
        let _ = dev_menu_tx.send_blocking(MainEvent::DevMenuShow);
    }));
    let dev_setting_tx = tx.clone();
    let _ = rn_gpui_sys::DEV_SETTING_HANDLER.set(Box::new(move |name, enabled| {
        let _ = dev_setting_tx.send_blocking(MainEvent::DevSetting { name, enabled });
    }));
    let dev_perform_tx = tx.clone();
    let _ = rn_gpui_sys::DEV_MENU_PERFORM_HANDLER.set(Box::new(move |id| {
        let _ = dev_perform_tx.send_blocking(MainEvent::DevMenuPerform(id));
    }));
    let tray_click_tx = tx.clone();
    let _ = rn_gpui_sys::TRAY_CLICK_HANDLER.set(Box::new(move |x, y, width, height, button| {
        let _ = tray_click_tx.send_blocking(MainEvent::TrayClick {
            x,
            y,
            width,
            height,
            button,
        });
    }));
    let menu_bar_tx = tx.clone();
    let _ = rn_gpui_sys::MENU_BAR_PERFORM_HANDLER.set(Box::new(move |id| {
        let _ = menu_bar_tx.send_blocking(MainEvent::MenuBarPerform(id));
    }));
    let tray_menu_tx = tx;
    let _ = rn_gpui_sys::TRAY_MENU_PERFORM_HANDLER.set(Box::new(move |id| {
        let _ = tray_menu_tx.send_blocking(MainEvent::TrayMenuPerform(id));
    }));
    // The snapshot is read on the JS thread during module initialization, so it
    // has to be installed before the bundle loads.
    crate::desktop::install_snapshot(&app_id);
    // The desktop shell is a Rust TurboModule: JS asks for it by name.
    crate::desktop::module::register();
    crate::builtins::register();

    #[cfg(feature = "visual-capture")]
    let headless = env_bool("RN_GPUI_HEADLESS", false);
    #[cfg(not(feature = "visual-capture"))]
    let headless = false;
    startup_trace(if headless {
        "using GPUI headless platform"
    } else {
        "using GPUI AppKit platform"
    });
    let platform = gpui_platform::current_platform(headless);
    startup_trace("platform created");
    // A locked or absent session on macOS cannot launch AppKit, and the platform
    // reports no display until it can. Nothing else does: on Linux GPUI starts on
    // a placeholder connection and attaches X11 or Wayland once the app runs, so
    // its display list is legitimately empty here — waiting for it never ends.
    #[cfg(target_os = "macos")]
    {
        let mut waited_for_display = 0u64;
        while platform.displays().is_empty() {
            if waited_for_display == 0 {
                log::warn!("no active display; waiting before entering AppKit launch");
                startup_trace("waiting for an active display");
            }
            std::thread::sleep(Duration::from_secs(2));
            waited_for_display += 2;
            if waited_for_display % 30 == 0 {
                log::warn!("still waiting for an active display ({waited_for_display}s)");
            }
        }
    }
    startup_trace("active display detected");
    let application = Application::with_platform(platform);
    // Before any request can arrive: the C++ bridge reports completions through
    // this handler, and it is registered once.
    crate::http_client::install();
    application.on_reopen(crate::desktop::windows::reopen);
    application
        .with_http_client(std::sync::Arc::new(crate::http_client::RnHttpClient::new()))
        .run(move |cx: &mut App| {
        startup_trace("application run");
        crate::image_loader::install(cx);
        crate::desktop::icon::install(cx);
        crate::text::install_fonts(cx);
        // Installed before the host starts a surface: Fabric measures paragraphs
        // from the JS thread and would otherwise fall back to a zero-size stub.
        crate::text::install_measure_handler(cx);
        if let Some(icon) = std::env::var_os("RN_GPUI_APP_ICON") {
            crate::desktop::platform_window::set_dock_icon(std::path::Path::new(&icon));
        }
        // Has to happen before the first window opens.
        if let Some(tray) = &config.tray {
            if tray.accessory {
                crate::desktop::platform_window::set_accessory_app(true);
            }
        }
        if let Some(on_app_ready) = config.on_app_ready.take() {
            on_app_ready(cx);
        }

        // Both must exist before the main window opens: the registry adopts it
        // below, and the close hook reads the policy while the window is live.
        cx.set_global(crate::desktop::windows::DesktopWindowsGlobal(
            crate::desktop::windows::DesktopWindows::new(),
        ));
        cx.set_global(crate::desktop::windows::QuitOnLastWindowClosed(
            config.quit_on_last_window_closed,
        ));
        // Installed before the bundle loads so a startup failure still leaves a
        // working menu bar.
        let menu_app_name = config
            .title
            .clone()
            .unwrap_or_else(|| config.module.clone());
        let dev_menu = config.dev_menu.unwrap_or(cfg!(debug_assertions));
        crate::desktop::dev_menu::install(cx, dev_menu);
        crate::desktop::app_menu::install(cx, &menu_app_name, dev_menu);
        crate::desktop::context_menu::install(cx);
        // The tray icon needs a running NSApplication, so it is created here
        // rather than while parsing the config.
        if let Some(tray) = config.tray.take() {
            if let Err(error) = crate::desktop::tray::install(cx, tray) {
                log::error!("[desktop][tray] {error}");
            }
        }
        crate::desktop::perf_monitor::install(cx);
        // Shortcut bindings are ordinary keymap bindings; this only installs the
        // handler for the ones with no scope element, which is the last stop
        // after every element on the focus path had its turn.
        crate::desktop::keymap::register(cx);

        // The overlay slot (LogBox) has to be in the app root's element tree from the
        // first frame: GPUI only re-renders entities the window tracked while drawing.
        let overlay_host = cx.new(|_| OverlayHost::new());
        let root_view = SurfaceRootView::new(APP_SURFACE_ID).with_overlay_host(overlay_host.clone());
        #[cfg(all(target_os = "macos", feature = "visual-capture"))]
        let root_view = if env_bool("RN_GPUI_NATIVE_WEBVIEW_PROBE", false) {
            root_view.with_native_view_probe(
                crate::native_view_probe::create_webview_probe_entity(cx),
            )
        } else if env_bool("RN_GPUI_NATIVE_COMPOSITION_PROBE", false) {
            root_view.with_native_view_probe(
                crate::native_view_probe::create_probe_entity(cx),
            )
        } else {
            root_view
        };
        let root = cx.new(|_| root_view);
        let restored_bounds = config
            .restore_window_state
            .then(|| load_window_bounds(&window_state_path))
            .flatten();
        startup_trace("window state loaded");
        let bounds = restored_bounds
            .map(|(x, y, width, height)| Bounds::new(point(px(x), px(y)), size(px(width), px(height))))
            .unwrap_or_else(|| {
                let size = size(px(width), px(height));
                if let Some((x, y)) = config.position {
                    Bounds::new(point(px(x), px(y)), size)
                } else {
                    Bounds::centered(None, size, cx)
                }
            });
        #[cfg(feature = "test-driver")]
        let bounds = if env_bool("RN_GPUI_TEST_OFFSCREEN", false) {
            Bounds::new(point(px(-10000.0), px(-10000.0)), bounds.size)
        } else { bounds };
        let (width, height) = restored_bounds.map_or((width, height), |(_, _, width, height)| (width, height));
        if let Some((x, y, restored_width, restored_height)) = restored_bounds {
            log::info!("restoring window at ({x:.0},{y:.0} {restored_width:.0}x{restored_height:.0})");
        }
        // Start React Native before the window exists.
        //
        // JS runs on its own thread, and a real app's startup is 50-300 ms that
        // used to happen entirely after AppKit finished. The size and scale here
        // are the values the window is about to be created with; anything the
        // window alone can report (its top inset, its final scale) is applied
        // once it exists, through the same path a resize takes.
        // GPUI reports the scale from a window, and there is no window yet.
        // `RN_GPUI_SCALE` overrides it for tests; otherwise the estimate is the
        // Retina default on macOS and 1.0 elsewhere. The surface is corrected
        // below if the window disagrees, so a wrong guess costs one resize, not a
        // wrong layout.
        let estimated_scale = scale_override.unwrap_or(if cfg!(target_os = "macos") {
            2.0
        } else {
            1.0
        });
        // A surface must not start at zero: `RN_GPUI_WIDTH=0` would otherwise
        // reach JS as a 0x0 viewport, and Fabric would lay out the whole tree in
        // no space at all. The window's own size is authoritative once it opens.
        let surface_width = width.max(320.0);
        let surface_height = height.max(240.0);
        let host = Host::new(&app_id, &dev_host, dev_port, &js_engine, dev_mode());
        startup_trace("host created");
        host.set_window_metrics(surface_width, surface_height, estimated_scale);
        startup_trace("bundle load start");
        if !host.load_script(&bundle, &source_url) {
            log::error!("load_script failed for {bundle}");
            std::process::exit(1);
        }
        startup_trace("bundle load end");
        log::info!("loaded {bundle}");
        // The surface starts now as well: mount batches queue on the main-thread
        // channel until the store and its window exist, which is the same path a
        // background surface already uses.
        let menu_bar_inset = crate::desktop::gpui_menu::menu_bar_inset();
        let gpui_first = config.gpui_root.is_some();
        if let Some(build) = config.gpui_root.take() {
            let view = build(cx, crate::runtime::ReactRuntime::new(estimated_scale));
            root.update(cx, |root, _cx| root.set_app_content(view));
        } else {
            host.start_surface(
                1,
                &module,
                surface_width,
                (surface_height - menu_bar_inset).max(1.0),
                estimated_scale,
            );
        }
        startup_trace("surface started");
        if !gpui_first {
            cx.set_global(crate::desktop::windows::ReopenWindow(
                crate::desktop::windows::OpenWindowOptions {
                    component: module.clone(),
                    title: Some(config.title.clone().unwrap_or_else(|| module.clone())),
                    width: Some(width),
                    height: Some(height),
                    resizable: true,
                    title_bar: config.title_bar,
                    traffic_light_position: config.traffic_light_position,
                    ..Default::default()
                },
            ));
        }

        startup_trace("opening GPUI window");
        let mut window_options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            ..Default::default()
        };
        if config.title_bar.is_custom() {
            let titlebar = window_options.titlebar.get_or_insert_with(Default::default);
            // macOS and Windows both express "no system chrome" as a transparent
            // title bar. Linux has no such flag: it asks the compositor for
            // client-side decorations instead, which is the same outcome — the
            // window keeps no title bar and the app draws and moves its own.
            titlebar.appears_transparent = true;
            if let Some((x, y)) = config.traffic_light_position {
                let (x, y) = clamp_traffic_light_position(x, y, width, height);
                titlebar.traffic_light_position = Some(point(px(x), px(y)));
            }
            // The app draws and moves the bar itself, so AppKit must not also
            // treat the content view as titlebar chrome.
            window_options.app_owns_titlebar_drag = true;
            // Ignored on macOS and Windows; on X11 and Wayland it is what
            // removes the server-side frame. A compositor that cannot do
            // client-side decorations falls back to the server's, and
            // `window.window_decorations()` then says so.
            window_options.window_decorations = Some(gpui::WindowDecorations::Client);
        }
        #[cfg(feature = "test-driver")]
        if env_bool("RN_GPUI_TEST_OFFSCREEN", false) {
            // AppKit clamps remote coordinates into the visible desktop.
            // Hidden windows still support forced draws and injected input.
            window_options.show = false;
            window_options.focus = false;
        }
        if let Some(configure_window) = config.configure_window.take() {
            configure_window(&mut window_options);
        }
        #[cfg(feature = "visual-capture")]
        if std::env::var_os("RN_GPUI_TRANSPARENT_TITLEBAR").is_some() {
            window_options.titlebar.get_or_insert_with(Default::default).appears_transparent = true;
        }
        #[cfg(target_os = "windows")]
        let opens_hidden = !window_options.show;
        let window = cx
            .open_window(
                window_options,
                {
                    let root = root.clone();
                    move |_window, _cx| root
                },
            )
            .expect("failed to open the GPUI window");
        startup_trace("window open");
        // Set per window, not once: a dev run's executable carries no icon, and
        // on Windows the icon belongs to the window, not the application. Windows
        // opened later get it in `windows::open_window`.
        let _ = window.update(cx, |_root, window, _cx| {
            crate::desktop::platform_window::apply_app_icon(window);
        });
        let window_id = window.window_id();
        // What the compositor actually gave, which is the only authority on
        // whether the request for client-side decorations was granted. A window
        // manager that ignored it kept its own frame, and the app then has to
        // know not to draw a second set of caption buttons beside it.
        let applied_decorations = window
            .update(cx, |_root, window, _cx| window.window_decorations())
            .ok();
        if let Some(decorations) = applied_decorations {
            crate::desktop::capabilities::note_window_decorations(decorations);
        }

        // A window created with `show: false` never receives the message that
        // carries its initial size on Windows, and GPUI creates the HWND with
        // `CW_USEDEFAULT`, so `window.bounds()` reports that sentinel
        // (`-1717986944`) until something resizes the window. Laying out at that
        // size fails React Native's own assertion (`minimumSize.width >= 0`) and
        // kills the process. Resizing delivers the `WM_SIZE` a shown window
        // would have received at creation, which is what publishes the real
        // size to the bounds observers. `bounds_changed` is deliberately not
        // called here: it would lay the surface out at the sentinel size before
        // that message arrives.
        #[cfg(target_os = "windows")]
        if opens_hidden {
            let requested = bounds.size;
            let applied = window.update(cx, move |_root, window, _cx| {
                if window.viewport_size() != requested {
                    window.resize(requested);
                }
            });
            if let Err(error) = applied {
                log::warn!("could not size the hidden window: {error}");
            }
        }

        if config.title.is_some() || config.on_window_opened.is_some() {
            let title = config.title.take();
            let on_window_opened = config.on_window_opened.take();
            window
                .update(cx, move |_root, window, cx| {
                    if let Some(title) = title.as_deref() {
                        window.set_window_title(title);
                    }
                    if let Some(on_window_opened) = on_window_opened {
                        on_window_opened(window_id, window, cx);
                    }
                })
                .expect("failed to configure the opened GPUI window");
        }

        let window_bounds = window
            .update(cx, |_root, window, _cx| {
                let bounds = window.bounds();
                (
                    f32::from(bounds.origin.x),
                    f32::from(bounds.origin.y),
                    f32::from(bounds.size.width),
                    f32::from(bounds.size.height),
                )
            })
            .map(|bounds| {
                format!(
                    "({:.0},{:.0} {:.0}x{:.0})",
                    bounds.0, bounds.1, bounds.2, bounds.3
                )
            })
            .unwrap_or_else(|error| format!("<unavailable: {error}>"));
        log::info!("window {window_id:?} open at {window_bounds}");

        #[cfg(any(feature = "visual-capture", feature = "perf-timing"))]
        let any_window = *window;

        // React Native is already running; the window supplies the three values
        // only it knows, and the surface is corrected if the estimate was wrong.
        let window_scale = window
            .update(cx, |_root, window, _cx| window.scale_factor())
            .unwrap_or(estimated_scale);
        let scale = scale_override.unwrap_or(window_scale);

        let top_inset = window.update(cx, |_root, window, _cx| {
            #[cfg(target_os = "macos")]
            { crate::native_view::window_top_inset(window) }
            #[cfg(not(target_os = "macos"))]
            { 0.0 }
        }).unwrap_or(0.0);
        host.set_window_top_inset(top_inset);
        log::info!("[window-inset] native window top inset={top_inset}");
        let appearance = match cx.window_appearance() {
            gpui::WindowAppearance::Dark | gpui::WindowAppearance::VibrantDark => "dark",
            _ => "light",
        };
        host.set_system_appearance(appearance);
        // The window may have opened at a different size or scale than the
        // estimate — a restore onto another display, or a maximized window — so
        // the surface is told, through the path a resize takes.
        // A wrong estimate is corrected here, not tolerated: JS reads Dimensions at
        // module initialization, so a surface told the wrong size or scale lays out
        // against it until something resizes it. Size is checked as well as scale,
        // because they are wrong for different reasons — the scale is a guess from
        // the platform, the size comes from the config or the restored window
        // state, and a window manager can override either.
        let size_moved = (width - surface_width).abs() > f32::EPSILON
            || (height - surface_height).abs() > f32::EPSILON;
        if size_moved || (window_scale - estimated_scale).abs() > f32::EPSILON {
            log::info!(
                "surface corrected {surface_width}x{surface_height}@{estimated_scale}x -> \
                 {width}x{height}@{window_scale}x after the window opened"
            );
            if gpui_first {
                // No React surface: only `Dimensions` has to learn the values.
                host.set_window_metrics(width, height, scale);
            } else {
                // The surface itself, not only `Dimensions`. It was started at the
                // estimated scale, and Yoga rounds the layout to that scale's pixel
                // grid: told only about `Dimensions`, a surface started at 1x kept
                // its 1x layout, so a 1230.4-point window laid out 1230 points —
                // 1537.5 pixels at 1.25x — and the window's last pixel column was
                // never painted until something resized it. `set_surface_size` is
                // what a resize calls, and it updates `Dimensions` as well.
                host.set_surface_size(
                    APP_SURFACE_ID,
                    width,
                    (height - menu_bar_inset).max(1.0),
                    scale,
                );
            }
        }
        if gpui_first {
            log::info!(
                "GPUI-first app: no React tree on surface 1 (window scale {window_scale})"
            );
        } else {
            log::info!(
                "started surface 1 ({module}) at {width}x{}@{scale}x (window scale {window_scale}, \
                 menu bar inset {menu_bar_inset})",
                height - menu_bar_inset
            );
        }

        let frame_hook = crate::frame::FrameHook::new(host.clone());
        window
            .update(cx, |_root, window, _cx| frame_hook.arm(window))
            .expect("failed to arm the per-frame hook");
        let appearance_host = host.clone();
        let appearance_subscription = window
            .update(cx, |_root, window, _cx| {
                window.observe_window_appearance(move |window, _cx| {
                    let appearance = match window.appearance() {
                        gpui::WindowAppearance::Dark | gpui::WindowAppearance::VibrantDark => "dark",
                        _ => "light",
                    };
                    appearance_host.set_system_appearance(appearance);
                })
            })
            .expect("failed to observe window appearance");

        #[cfg(feature = "visual-capture")]
        let host_for_input = host.clone();
        let store = cx.new(|_| ViewStore::new(host, window, frame_hook.clone(), overlay_host));
        cx.set_global(StoreGlobal(store.clone()));
        #[cfg(feature = "test-driver")]
        if std::env::var("RN_GPUI_TEST_DRIVER").as_deref() == Ok("1") {
            let animations_disabled = std::env::var("RN_GPUI_TEST_DISABLE_ANIMATIONS")
                .map(|value| matches!(value.as_str(), "1" | "true" | "yes"))
                .unwrap_or(false);
            crate::animation_policy::set_animations_disabled(animations_disabled);
            crate::test_driver::start(cx, store.clone(), (*window).into());
        }
        let keyboard_host = store.read(cx).host.clone();
        let keyboard_hook = frame_hook.clone();
        let navigation_keyboard_subscription = cx.intercept_keystrokes(move |event, window, cx| {
            if window.window_handle().window_id() != window_id { return; }
            if let Some(event_name) = crate::builtins::textinput::input::desktop_navigation_event(&event.keystroke) {
                keyboard_host.emit_device_event(event_name);
                keyboard_hook.arm(window);
                log::info!("[navigation] emitted {event_name} from keyboard");
                cx.stop_propagation();
            }
        });

        crate::desktop::perf_monitor::attach(cx, &root, 1);
        // The menu bar is prepared inside a window update (it needs the window
        // for the activation observer) and attached to the root afterwards,
        // outside any update that has already leased the root.
        // `window.menuBar: false` hides the bar before it is ever drawn, so the
        // window opens at the right size instead of shrinking once the bar goes.
        if !config.menu_bar {
            crate::desktop::gpui_menu::set_menu_bar_visible(
                crate::desktop::windows::MAIN_WINDOW_KEY,
                false,
            );
        }
        let menu_bar = window
            .update(cx, |_root, window, cx| {
                crate::desktop::gpui_menu::prepare(window, cx, 1)
            })
            .ok()
            .flatten();
        if let Some(prepared) = menu_bar {
            crate::desktop::gpui_menu::attach(cx, &root, prepared);
        }
        store.update(cx, |store, cx| {
            store.register_root(1, root);
            store.top_inset = top_inset;
            store.refresh_inherited(1, cx);
            store.navigation_keyboard_subscription = Some(navigation_keyboard_subscription);
            store.window_appearance_subscription = Some(appearance_subscription);
            cx.notify();
        });

        cx.global_mut::<crate::desktop::windows::DesktopWindowsGlobal>()
            .0
            .adopt(
                crate::desktop::windows::MAIN_WINDOW_KEY,
                (*window).into(),
                1,
                module.clone(),
                serde_json::json!({}),
                crate::desktop::windows::WindowRole::Main,
            );

        // Without the close hook `closeRequested` never fires for the main window.
        crate::desktop::windows::install_close_hook_for(
            cx,
            (*window).into(),
            crate::desktop::windows::MAIN_WINDOW_KEY,
        );

        #[cfg(feature = "visual-capture")]
        if !clicks.is_empty() {
            let host = host_for_input.clone();
            cx.spawn(async move |cx| {
                for (x, y) in clicks {
                    let timer = cx
                        .background_executor()
                        .timer(Duration::from_millis(u64::from(click_ms)));
                    timer.await;
                    let position = gpui::point(px(x), px(y));
                    log::info!("clicking at {x},{y}");
                    let clicked = cx.update_window(
                        any_window,
                        move |_root: gpui::AnyView, window: &mut gpui::Window, cx: &mut App| {
                            let arena_clear_needed = window.draw(cx);
                            arena_clear_needed.clear(cx);
                            let down = gpui::PlatformInput::MouseDown(gpui::MouseDownEvent {
                                button: gpui::MouseButton::Left,
                                position,
                                ..Default::default()
                            });
                            window.dispatch_event(down, cx);
                        },
                    );
                    if let Err(error) = clicked {
                        log::error!("click at {x},{y} failed: {error}");
                    }
                    if click_hold_ms > 0 {
                        cx.background_executor()
                            .timer(Duration::from_millis(u64::from(click_hold_ms)))
                            .await;
                    }
                    let _ = cx.update_window(
                        any_window,
                        move |_root: gpui::AnyView, window: &mut gpui::Window, cx: &mut App| {
                            window.dispatch_event(
                                gpui::PlatformInput::MouseUp(gpui::MouseUpEvent {
                                    button: gpui::MouseButton::Left,
                                    position,
                                    ..Default::default()
                                }),
                                cx,
                            );
                        },
                    );
                    if !skip_synthetic_input_flush {
                        flush_js(&host, cx).await;
                    }
                }
            })
            .detach();
        }

        #[cfg(feature = "visual-capture")]
        if !drags.is_empty() {
            let host = host_for_input.clone();
            let frame_hook = frame_hook.clone();
            cx.spawn(async move |cx| {
                for (index, (start_x, start_y, end_x, end_y, cancel)) in
                    drags.into_iter().enumerate()
                {
                    let delay = if index == 0 { drag_start_ms } else { drag_ms };
                    cx.background_executor()
                        .timer(Duration::from_millis(u64::from(delay)))
                        .await;
                    log::info!("dragging from {start_x},{start_y} to {end_x},{end_y}");
                    let start = gpui::point(px(start_x), px(start_y));
                    let down = cx.update_window(
                        any_window,
                        move |_root: gpui::AnyView, window: &mut gpui::Window, cx: &mut App| {
                            let arena_clear_needed = window.draw(cx);
                            arena_clear_needed.clear(cx);
                            window.dispatch_event(
                                gpui::PlatformInput::MouseDown(gpui::MouseDownEvent {
                                    button: gpui::MouseButton::Left,
                                    position: start,
                                    ..Default::default()
                                }),
                                cx,
                            );
                        },
                    );
                    if let Err(error) = down {
                        log::error!("drag down failed: {error}");
                        continue;
                    }
                    flush_js(&host, cx).await;

                    for step in 1..=8 {
                        let amount = step as f32 / 8.0;
                        let position = gpui::point(
                            px(start_x + (end_x - start_x) * amount),
                            px(start_y + (end_y - start_y) * amount),
                        );
                        let hook = frame_hook.clone();
                        let moved = cx.update_window(
                            any_window,
                            move |_root: gpui::AnyView,
                                  window: &mut gpui::Window,
                                  cx: &mut App| {
                                let arena_clear_needed = window.draw(cx);
                                arena_clear_needed.clear(cx);
                                window.dispatch_event(
                                    gpui::PlatformInput::MouseMove(gpui::MouseMoveEvent {
                                        position,
                                        pressed_button: Some(gpui::MouseButton::Left),
                                        ..Default::default()
                                    }),
                                    cx,
                                );
                                hook.arm(window);
                            },
                        );
                        if let Err(error) = moved {
                            log::error!("drag move {step} failed: {error}");
                            break;
                        }
                        flush_js(&host, cx).await;
                    }

                    let end = gpui::point(px(end_x), px(end_y));
                    let hook = frame_hook.clone();
                    let released = cx.update_window(
                        any_window,
                        move |_root: gpui::AnyView, window: &mut gpui::Window, cx: &mut App| {
                            let arena_clear_needed = window.draw(cx);
                            arena_clear_needed.clear(cx);
                            if cancel {
                                crate::events::cancel_active_touch(window, cx, end);
                            }
                            window.dispatch_event(
                                gpui::PlatformInput::MouseUp(gpui::MouseUpEvent {
                                    button: gpui::MouseButton::Left,
                                    position: end,
                                    ..Default::default()
                                }),
                                cx,
                            );
                            hook.arm(window);
                        },
                    );
                    if let Err(error) = released {
                        log::error!("drag release failed: {error}");
                    }
                    flush_js(&host, cx).await;
                }
            })
            .detach();
        }

        #[cfg(feature = "visual-capture")]
        if !hovers.is_empty() {
            let frame_hook = frame_hook.clone();
            let host = host_for_input.clone();
            cx.spawn(async move |cx| {
                for (x, y) in hovers {
                    let timer = cx
                        .background_executor()
                        .timer(Duration::from_millis(u64::from(hover_ms)));
                    timer.await;
                    let position = gpui::point(px(x), px(y));
                    log::info!("hovering at {x},{y}");
                    let hook = frame_hook.clone();
                    let hovered = cx.update_window(
                        any_window,
                        move |_root: gpui::AnyView, window: &mut gpui::Window, cx: &mut App| {
                            // Hit testing uses the last drawn frame, and a
                            // headless run cannot rely on the platform asking
                            // for one after a mount batch, so draw first.
                            let arena_clear_needed = window.draw(cx);
                            arena_clear_needed.clear(cx);
                            let input = gpui::PlatformInput::MouseMove(gpui::MouseMoveEvent {
                                position,
                                pressed_button: None,
                                ..Default::default()
                            });
                            window.dispatch_event(input, cx);
                            hook.arm(window);
                        },
                    );
                    if let Err(error) = hovered {
                        log::error!("hover at {x},{y} failed: {error}");
                    }
                    flush_js(&host, cx).await;
                }
            })
            .detach();
        }

        #[cfg(feature = "visual-capture")]
        if !scrolls.is_empty() {
            let frame_hook = frame_hook.clone();
            let host = host_for_input.clone();
            cx.spawn(async move |cx| {
                for (index, (x, y, dx, dy)) in scrolls.into_iter().enumerate() {
                    let delay = if index == 0 { scroll_start_ms } else { scroll_ms };
                    cx.background_executor()
                        .timer(Duration::from_millis(u64::from(delay)))
                        .await;
                    let position = gpui::point(px(x), px(y));
                    log::info!("scrolling at {x},{y} by {dx},{dy}");
                    let hook = frame_hook.clone();
                    let scrolled = cx.update_window(
                        any_window,
                        move |_root: gpui::AnyView, window: &mut gpui::Window, cx: &mut App| {
                            let arena_clear_needed = window.draw(cx);
                            arena_clear_needed.clear(cx);
                            window.dispatch_event(
                                gpui::PlatformInput::ScrollWheel(gpui::ScrollWheelEvent {
                                    position,
                                    delta: gpui::ScrollDelta::Pixels(gpui::point(px(dx), px(dy))),
                                    ..Default::default()
                                }),
                                cx,
                            );
                            hook.arm(window);
                        },
                    );
                    if let Err(error) = scrolled {
                        log::error!("scroll at {x},{y} failed: {error}");
                    }
                    flush_js(&host, cx).await;
                }
            })
            .detach();
        }

        #[cfg(feature = "visual-capture")]
        if !keys.is_empty() {
            let frame_hook = frame_hook.clone();
            let host = host_for_input.clone();
            cx.spawn(async move |cx| {
                for key in keys {
                    cx.background_executor()
                        .timer(Duration::from_millis(u64::from(key_ms)))
                        .await;
                    let Ok(keystroke) = gpui::Keystroke::parse(&key) else {
                        log::warn!("invalid synthetic keystroke: {key}");
                        continue;
                    };
                    log::info!("pressing key {key}");
                    let hook = frame_hook.clone();
                    let pressed = cx.update_window(
                        any_window,
                        move |_root: gpui::AnyView, window: &mut gpui::Window, cx: &mut App| {
                            let arena_clear_needed = window.draw(cx);
                            arena_clear_needed.clear(cx);
                            window.dispatch_keystroke(keystroke.clone(), cx);
                            window.dispatch_event(
                                gpui::PlatformInput::KeyUp(gpui::KeyUpEvent { keystroke }),
                                cx,
                            );
                            hook.arm(window);
                        },
                    );
                    if let Err(error) = pressed {
                        log::error!("key {key} failed: {error}");
                    }
                    flush_js(&host, cx).await;
                }
            })
            .detach();
        }

        #[cfg(feature = "visual-capture")]
        if !mouse_navigation.is_empty() {
            let host = host_for_input.clone();
            let frame_hook = frame_hook.clone();
            cx.spawn(async move |cx| {
                for direction in mouse_navigation {
                    cx.background_executor()
                        .timer(Duration::from_millis(u64::from(mouse_navigation_ms)))
                        .await;
                    let button = match direction.as_str() {
                        "back" => gpui::MouseButton::Navigate(gpui::NavigationDirection::Back),
                        _ => gpui::MouseButton::Navigate(gpui::NavigationDirection::Forward),
                    };
                    let hook = frame_hook.clone();
                    let dispatched = cx.update_window(
                        any_window,
                        move |_root: gpui::AnyView, window: &mut gpui::Window, cx: &mut App| {
                            let arena_clear_needed = window.draw(cx);
                            arena_clear_needed.clear(cx);
                            let position = gpui::point(px(1.), px(1.));
                            window.dispatch_event(
                                gpui::PlatformInput::MouseDown(gpui::MouseDownEvent {
                                    button,
                                    position,
                                    ..Default::default()
                                }),
                                cx,
                            );
                            window.dispatch_event(
                                gpui::PlatformInput::MouseUp(gpui::MouseUpEvent {
                                    button,
                                    position,
                                    ..Default::default()
                                }),
                                cx,
                            );
                            hook.arm(window);
                        },
                    );
                    if let Err(error) = dispatched {
                        log::error!("synthetic mouse navigation {direction} failed: {error}");
                    } else {
                        log::info!("pressed mouse navigation {direction}");
                    }
                    flush_js(&host, cx).await;
                }
            })
            .detach();
        }

        #[cfg(all(target_os = "macos", feature = "visual-capture"))]
        if env_u32("RN_GPUI_TITLEBAR_TOGGLE_MS", 0) > 0 {
            let delay = env_u32("RN_GPUI_TITLEBAR_TOGGLE_MS", 0);
            cx.spawn(async move |cx| {
                for transparent in [false, true] {
                    cx.background_executor().timer(Duration::from_millis(u64::from(delay))).await;
                    let _ = cx.update_window(any_window, move |_, window, cx| {
                        crate::native_view::set_probe_titlebar_transparent(window, transparent);
                        window.bounds_changed(cx);
                        window.refresh();
                        log::info!("[window-inset] probe titlebar transparent={transparent}");
                    });
                }
            }).detach();
        }
        #[cfg(feature = "visual-capture")]
        if env_u32("RN_GPUI_FULLSCREEN_MS", 0) > 0 {
            let delay = env_u32("RN_GPUI_FULLSCREEN_MS", 0);
            cx.spawn(async move |cx| {
                for interval in [delay, 3000] {
                    cx.background_executor().timer(Duration::from_millis(u64::from(interval))).await;
                    let _ = cx.update_window(any_window, |_, window, _| window.toggle_fullscreen());
                }
            }).detach();
        }

        // The subscription unsubscribes the moment it drops, so it is handed to the
        // store.
        let last_surface_size = Rc::new(Cell::new((width, height, scale, 0.0, 0.0)));
        let bounds_subscription = window
            .update(cx, |_root, window, cx| {
                let store = cx.global::<StoreGlobal>().0.clone();
                let frame_hook = frame_hook.clone();
                let window_state_path = window_state_path.clone();
                let last_surface_size = last_surface_size.clone();
                cx.observe_window_bounds(window, move |_root, window, cx| {
                    // GPUI calls bounds observers on every resize notification and layout, so
                    // nothing here may write to disk or log unless a value changed.
                    let size = window.viewport_size();
                    let scale = scale_override.unwrap_or_else(|| window.scale_factor());
                    let (width, height) = (f32::from(size.width), f32::from(size.height));
                    let bounds = window.bounds();
                    let origin = (
                        f32::from(bounds.origin.x),
                        f32::from(bounds.origin.y),
                    );
                    let previous = last_surface_size.get();
                    let resized = (previous.0 - width).abs() > 0.01
                        || (previous.1 - height).abs() > 0.01
                        || (previous.2 - scale).abs() > 0.001;
                    let moved = (previous.3 - origin.0).abs() > 0.01
                        || (previous.4 - origin.1).abs() > 0.01;
                    #[cfg(target_os = "macos")]
                    let top = crate::native_view::window_top_inset(window);
                    #[cfg(not(target_os = "macos"))]
                    let top = 0.0;
                    let inset_changed = cx
                        .try_global::<StoreGlobal>()
                        .is_some_and(|global| (global.0.read(cx).top_inset - top).abs() > 0.01);
                    if !resized && !moved && !inset_changed {
                        return;
                    }
                    last_surface_size.set((width, height, scale, origin.0, origin.1));
                    save_window_bounds(&window_state_path, bounds, size);
                    if inset_changed {
                        store.update(cx, |store, cx| {
                            store.top_inset = top;
                            store.host.set_window_top_inset(top);
                            store.frame_hook.arm(window);
                            for node in store.nodes.values() {
                                let component = node.read(cx).component.clone();
                                let depends = crate::extensions::component_renderer(&component)
                                    .is_some_and(|renderer| renderer.depends_on_window_insets());
                                if depends {
                                    node.update(cx, |_, cx| cx.notify());
                                }
                            }
                            store.refresh_inherited(1, cx);
                        });
                        log::info!(
                            "[window-inset] native window top inset={top} fullscreen={}",
                            window.is_fullscreen()
                        );
                    }
                    if resized {
                        log::info!("window resized to {width}x{height}@{scale}x");
                        let handle: gpui::AnyWindowHandle = window.window_handle().into();
                        store.update(cx, |store, _cx| {
                            store.resize_window(handle, width, height, scale)
                        });
                        frame_hook.arm(window);
                    }
                })
            })
            .expect("failed to observe the window's bounds");
        // Windows only: its caption buttons and the title bar's double click maximize
        // the window without the app being told, which this is how it learns.
        let state_subscription = if cfg!(windows) {
            Some(
                window
                    .update(cx, |_root, window, cx| {
                        crate::desktop::windows::install_state_observer(window, cx)
                    })
                    .expect("failed to observe the window's state"),
            )
        } else {
            None
        };
        store.update(cx, |store, _cx| {
            store.window_bounds_subscription = Some(bounds_subscription);
            store.window_state_subscription = state_subscription;
        });

        #[cfg(feature = "visual-capture")]
        if resize_ms > 0 {
            let target = size(px(resize_width), px(resize_height));
            let timer = cx
                .background_executor()
                .timer(Duration::from_millis(u64::from(resize_ms)));
            cx.spawn(async move |cx| {
                timer.await;
                log::info!("resizing the window to {resize_width}x{resize_height}");
                let resized = cx.update_window(
                    any_window,
                    move |_root: gpui::AnyView, window: &mut gpui::Window, _cx: &mut App| {
                        window.resize(target)
                    },
                );
                if let Err(error) = resized {
                    log::error!("window resize failed: {error}");
                }
            })
            .detach();
        }

        #[cfg(feature = "visual-capture")]
        if run_ms > 0 {
            let timer = cx
                .background_executor()
                .timer(Duration::from_millis(u64::from(run_ms)));
            cx.spawn(async move |cx| {
                timer.await;
                log::info!("staying alive for {run_ms} ms — closing");
                cx.update(|cx| cx.quit());
            })
            .detach();
        }

        #[cfg(feature = "perf-timing")]
        if benchmark_ms > 0 {
            let timer = cx
                .background_executor()
                .timer(Duration::from_millis(u64::from(benchmark_ms)));
            cx.spawn(async move |cx| {
                timer.await;
                let result = cx.update_window(
                    any_window,
                    move |_root: gpui::AnyView, window: &mut gpui::Window, _cx: &mut App| {
                        let snapshot = window.frame_duration_snapshot();
                        let draw = &snapshot.draw_duration_histogram;
                        let interval = &snapshot.present_interval_histogram;
                        log::info!(
                            "[bench] mode={benchmark_mode} draw_frames={} draw_mean_ms={:.3} draw_p50_ms={:.3} draw_p95_ms={:.3} draw_p99_ms={:.3} draw_max_ms={:.3} present_intervals={} present_mean_ms={:.3} present_p95_ms={:.3}",
                            draw.len(),
                            draw.mean() / 1_000_000.0,
                            draw.value_at_quantile(0.50) as f64 / 1_000_000.0,
                            draw.value_at_quantile(0.95) as f64 / 1_000_000.0,
                            draw.value_at_quantile(0.99) as f64 / 1_000_000.0,
                            draw.max() as f64 / 1_000_000.0,
                            interval.len(),
                            interval.mean() / 1_000_000.0,
                            interval.value_at_quantile(0.95) as f64 / 1_000_000.0,
                        );
                    },
                );
                if let Err(error) = result {
                    log::error!("benchmark snapshot failed: {error}");
                }
            })
            .detach();
        }

        cx.spawn(async move |cx| {
            let mut smoke_frame_armed = false;
            #[cfg(feature = "visual-capture")]
            for (delay_ms, path) in screenshots {
                let store = store.clone();
                let mut path = Some(path);
                cx.spawn(async move |cx| {
                    capture_and_quit(cx, &store, &mut path, delay_ms).await;
                })
                .detach();
            }
            #[cfg(feature = "visual-capture")]
            if let Some(path) = screenshot {
                let store = store.clone();
                let mut path = Some(path);
                cx.spawn(async move |cx| {
                    capture_and_quit(cx, &store, &mut path, screenshot_delay_ms).await;
                })
                .detach();
            }
            while let Ok(event) = rx.recv().await {
                match event {
                    MainEvent::Mount(batch) => {
                        let surface_id = batch.surface_id;
                        let started = std::time::Instant::now();
                        store.update(cx, |store, cx| store.apply_batch(batch, cx));
                        let elapsed = started.elapsed().as_secs_f32() * 1000.0;
                        cx.update(|cx| crate::desktop::perf_monitor::record_mount(cx, elapsed));
                        // SAFETY: the C++ function decrements an atomic counter and takes no arguments.
                        unsafe { rn_gpui_mount_batch_applied() };
                        // Smoke mode: an app-surface batch is React content, so
                        // the frame GPUI draws after it is the one a human sees.
                        if smoke && !smoke_frame_armed && surface_id == APP_SURFACE_ID {
                            smoke_frame_armed = true;
                            let window = store.read_with(cx, |store, _| store.window);
                            smoke_arm_first_frame(cx, window);
                        }
                    }
                    MainEvent::SurfaceStopped(surface_id) => {
                        if surface_id == rn_gpui_sys::ALL_SURFACES {
                            rn_gpui_sys::ffi::rn_gpui_rust_module_clear_pending();
                        }
                        store.update(cx, |store, cx| store.surface_stopped(surface_id, cx));
                    }
                    MainEvent::DevMenuShow => {
                        cx.update(|cx| crate::desktop::dev_menu::show(cx));
                    }
                    MainEvent::TrayClick {
                        x,
                        y,
                        width,
                        height,
                        button,
                    } => {
                        cx.update(|cx| {
                            crate::desktop::tray::handle_click(
                                cx,
                                crate::desktop::tray::TrayRect {
                                    x,
                                    y,
                                    width,
                                    height,
                                },
                                match button {
                                    1 => crate::desktop::tray::TrayButton::Right,
                                    2 => crate::desktop::tray::TrayButton::Middle,
                                    _ => crate::desktop::tray::TrayButton::Left,
                                },
                            )
                        });
                    }
                    MainEvent::MenuBarPerform(id) => {
                        cx.update(|cx| crate::desktop::app_menu::trigger_item(cx, &id));
                    }
                    MainEvent::TrayMenuPerform(id) => {
                        cx.update(|cx| crate::desktop::tray::perform_menu(cx, &id));
                    }
                    MainEvent::DevMenuPerform(id) => {
                        cx.update(|cx| crate::desktop::dev_menu::perform(cx, &id));
                    }
                    MainEvent::DevSetting { name, enabled } => {
                        cx.update(|cx| {
                            crate::desktop::dev_menu::apply_setting(cx, &name, enabled)
                        });
                    }
                    MainEvent::DesktopCommand(command) => {
                        cx.update(|cx| command(cx));
                    }
                    MainEvent::MainTask(id) => {
                        rn_gpui_sys::ffi::rn_gpui_run_main_task(id);
                    }
                    MainEvent::RustJob(job) => {
                        cx.spawn(async move |_| {
                            job().await;
                        })
                        .detach();
                    }
                    MainEvent::AnimatedProps(props) => {
                        if props.has_opacity
                            || props.has_transform
                            || props.reset_transform
                            || props.has_background_color
                            || props.has_text_color
                        {
                            let mut target = None;
                            store.update(cx, |store, cx| {
                                target = store
                                    .nodes
                                    .get(&props.tag)
                                    .cloned()
                                    .map(|node| (node.read(cx).surface_id, node));
                            });
                            if let Some((surface_id, node)) = target {
                                node.update(cx, |node, cx| {
                                    if props.has_opacity {
                                        node.set_animated_opacity(props.opacity);
                                    }
                                    if props.has_background_color {
                                        node.set_animated_background_color(props.background_color);
                                    }
                                    if props.has_text_color {
                                        node.set_animated_text_color(props.text_color);
                                    }
                                    if props.has_transform {
                                        node.set_animated_transform(Some(props.transform));
                                    } else if props.reset_transform {
                                        node.set_animated_transform(None);
                                    }
                                    cx.notify();
                                });
                                if props.has_transform || props.reset_transform {
                                    store.update(cx, |store, cx| {
                                        store.refresh_inherited(surface_id, cx)
                                    });
                                }
                            }
                        }
                    }
                    MainEvent::AnimatedActivity(active) => {
                        let mut target = None;
                        store.update(cx, |store, _cx| {
                            target = Some((store.window, store.frame_hook.clone()));
                        });
                        if let Some((window, frame_hook)) = target {
                            if let Err(error) =
                                cx.update_window(window, move |_root, window, cx| {
                                    frame_hook.set_animation_active(active, window, cx);
                                })
                            {
                                log::debug!(
                                    "[native-animated] failed to update GPUI window activity: {error}"
                                );
                            }
                        } else if std::env::var_os("RN_GPUI_DEBUG_ANIMATION").is_some() {
                            log::warn!("[native-animated] animation activity has no window");
                        }
                    }
                    MainEvent::TextInputCommand { tag, focus } => {
                        let target = {
                            let mut target = None;
                            store.update(cx, |store, _cx| {
                                target = store.nodes.get(&tag).cloned().map(|node| (store.window, node));
                            });
                            target
                        };
                        if let Some((window_handle, node)) = target {
                            let _ = cx.update_window(window_handle, move |_root, window, cx| {
                                node.update(cx, |node, cx| {
                                    node.apply_text_input_focus_command(focus, window, cx);
                                });
                            });
                        }
                    }
                    MainEvent::AccessibilityFocus(tag) => {
                        let target = {
                            let mut target = None;
                            store.update(cx, |store, _cx| {
                                target = store
                                    .nodes
                                    .get(&tag)
                                    .cloned()
                                    .map(|node| (store.window, node));
                            });
                            target
                        };
                        if let Some((window_handle, node)) = target {
                            let _ = cx.update_window(window_handle, move |_root, window, cx| {
                                node.update(cx, |node, cx| {
                                    node.focus_for_accessibility(window, cx);
                                });
                            });
                        }
                    }
                    MainEvent::HostCommand { tag, command, args } => {
                        let target = {
                            let mut target = None;
                            store.update(cx, |store, _cx| {
                                target = store.nodes.get(&tag).cloned().map(|node| (store.window, node));
                            });
                            target
                        };
                        if let Some((window_handle, node)) = target {
                            let _ = cx.update_window(window_handle, move |_root, _window, cx| {
                                node.update(cx, |node, cx| {
                                    node.dispatch_host_command(command, &args, cx);
                                });
                            });
                        }
                    }
                    MainEvent::TextInputClear(tag) => {
                        let target = {
                            let mut target = None;
                            store.update(cx, |store, _cx| {
                                target = store.nodes.get(&tag).cloned().map(|node| (store.window, node));
                            });
                            target
                        };
                        if let Some((window_handle, node)) = target {
                            let _ = cx.update_window(window_handle, move |_root, window, cx| {
                                node.update(cx, |node, cx| {
                                    crate::builtins::textinput::input::clear_text_input(node, window, cx);
                                });
                            });
                        }
                    }
                }
            }
            log::info!("mount channel closed");
        })
        .detach();

        // A hidden test run must not take focus or pull the user to the
        // desktop the app launched on.
        #[cfg(feature = "test-driver")]
        let background = env_bool("RN_GPUI_TEST_OFFSCREEN", false);
        #[cfg(not(feature = "test-driver"))]
        let background = false;
        if background {
            #[cfg(all(target_os = "macos", feature = "test-driver"))]
            run_as_accessory_app();
        } else {
            cx.activate(true);
        }
        log::info!("waiting for mount batches");
    });
}

#[cfg(feature = "visual-capture")]
async fn capture_and_quit(
    cx: &mut gpui::AsyncApp,
    store: &gpui::Entity<ViewStore>,
    path: &mut Option<String>,
    delay_ms: u32,
) {
    let timer = cx
        .background_executor()
        .timer(Duration::from_millis(u64::from(delay_ms)));
    timer.await;

    let Some(path) = path.take() else { return };
    let window = store.read_with(cx, |store, _| store.window);
    let captured = cx.update_window(
        window,
        |_root: gpui::AnyView, window: &mut gpui::Window, cx: &mut App| {
            // `render_to_image` only replays the last drawn scene, and a headless
            // run can go idle after the first frame. Draw synchronously so the capture
            // reflects the current element tree.
            let arena_clear_needed = window.draw(cx);
            arena_clear_needed.clear(cx);
            window.render_to_image()
        },
    );
    match captured {
        Ok(Ok(image)) => match image.save(&path) {
            Ok(()) => log::info!("screenshot saved to {path}"),
            Err(error) => log::error!("could not save {path}: {error}"),
        },
        Ok(Err(error)) => log::error!("render_to_image failed: {error}"),
        Err(error) => log::error!("update_window failed: {error}"),
    }
    if env_bool("RN_GPUI_KEEP_ALIVE", false) {
        log::info!("screenshot saved; keeping the GPUI window open");
    } else {
        cx.update(|cx| cx.quit());
    }
}

#[cfg(all(target_os = "macos", feature = "test-driver"))]
fn run_as_accessory_app() {
    use objc::{class, msg_send, sel, sel_impl};
    const ACCESSORY: isize = 1;
    // SAFETY: `NSApplication` is messaged from the main thread.
    unsafe {
        let app: cocoa::base::id = msg_send![class!(NSApplication), sharedApplication];
        let _: bool = msg_send![app, setActivationPolicy: ACCESSORY];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_title_bar_name_maps_to_the_enum_the_schema_documents() {
        assert_eq!(
            WindowTitleBar::from_name("default"),
            WindowTitleBar::Default
        );
        assert_eq!(
            WindowTitleBar::from_name("transparent"),
            WindowTitleBar::Transparent
        );
        assert_eq!(WindowTitleBar::from_name("hidden"), WindowTitleBar::Hidden);
    }

    #[test]
    fn an_unknown_title_bar_name_keeps_the_platform_bar() {
        // The schema rejects a typo in `desktop.json`, but a secondary window's
        // `titleBar` prop comes from JS and an older app can send anything. A
        // window with the platform's own bar is the harmless outcome; a failed
        // `open` would leave the app with no window at all.
        assert_eq!(WindowTitleBar::from_name(""), WindowTitleBar::Default);
        assert_eq!(WindowTitleBar::from_name("Hidden"), WindowTitleBar::Default);
        assert_eq!(
            WindowTitleBar::from_name("nonsense"),
            WindowTitleBar::Default
        );
    }

    #[test]
    fn only_the_two_custom_kinds_are_custom() {
        assert!(!WindowTitleBar::Default.is_custom());
        assert!(WindowTitleBar::Transparent.is_custom());
        assert!(WindowTitleBar::Hidden.is_custom());
    }

    #[test]
    fn a_traffic_light_position_inside_the_window_is_unchanged() {
        assert_eq!(
            clamp_traffic_light_position(14.0, 10.0, 520.0, 360.0),
            (14.0, 10.0)
        );
        assert_eq!(
            clamp_traffic_light_position(0.0, 0.0, 520.0, 360.0),
            (0.0, 0.0)
        );
    }

    #[test]
    fn a_traffic_light_position_outside_the_window_is_pulled_back() {
        // AppKit would move the buttons past the edge and leave no way to drag
        // them back, so the host clamps instead.
        assert_eq!(
            clamp_traffic_light_position(900.0, 700.0, 520.0, 360.0),
            (520.0, 360.0)
        );
        assert_eq!(
            clamp_traffic_light_position(-4.0, -8.0, 520.0, 360.0),
            (0.0, 0.0)
        );
    }

    #[test]
    fn a_non_finite_or_degenerate_traffic_light_position_is_the_origin() {
        // `f32::clamp` panics on NaN, and a window with no size has nowhere to
        // put the buttons, so both answers are the origin rather than a panic.
        assert_eq!(
            clamp_traffic_light_position(f32::NAN, f32::INFINITY, 520.0, 360.0),
            (0.0, 0.0)
        );
        assert_eq!(
            clamp_traffic_light_position(10.0, 10.0, 0.0, 0.0),
            (0.0, 0.0)
        );
    }
}
