#[cfg(target_os = "linux")]
use std::sync::atomic::{AtomicU8, Ordering};

pub const fn native_app_menu() -> bool {
    cfg!(any(target_os = "macos", target_os = "windows"))
}

pub const fn native_context_menu() -> bool {
    cfg!(any(target_os = "macos", target_os = "windows"))
}

pub const fn tray() -> bool {
    cfg!(any(
        target_os = "macos",
        target_os = "windows",
        target_os = "linux"
    ))
}

/// Whether the tray popover can be placed at the icon, rather than wherever the
/// compositor decides.
///
/// macOS places it natively. Linux is decided at run time: X11 can position a
/// window (`_NET_WM_WINDOW_TYPE_UTILITY` + `USPosition`), Wayland cannot. The
/// Wayland layer-shell path (KDE, wlroots, COSMIC) is not implemented yet; when
/// it lands this becomes true there too, and stays false on GNOME, which has no
/// layer-shell. Windows has no anchored popover.
pub fn tray_popover_anchored() -> bool {
    #[cfg(target_os = "macos")]
    {
        true
    }
    #[cfg(target_os = "linux")]
    {
        !is_wayland()
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        false
    }
}

/// Wayland has no absolute window positioning and no raise-above.
pub fn is_wayland() -> bool {
    #[cfg(target_os = "linux")]
    {
        std::env::var_os("WAYLAND_DISPLAY").is_some()
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

pub fn window_position() -> bool {
    !is_wayland()
}

pub fn always_on_top() -> bool {
    !is_wayland()
}

/// Whether a window can have its title bar removed while keeping the traffic
/// lights or the app's own caption buttons.
///
/// macOS and Windows always can. Linux cannot on its own: the title bar belongs
/// to the window manager, and the only way to remove it is client-side
/// decorations, so the answer follows [`client_decorations`] there. Anywhere
/// else the shell does not run at all, so the answer is false rather than a
/// promise nothing can keep.
pub fn transparent_titlebar() -> bool {
    #[cfg(target_os = "linux")]
    {
        client_decorations()
    }
    #[cfg(not(target_os = "linux"))]
    {
        cfg!(any(target_os = "macos", target_os = "windows"))
    }
}

/// Whether a frameless window can be frameless *and* still resized.
///
/// macOS and Windows keep a native resize border around a title-bar-less window,
/// so a custom title bar needs nothing more from them. Linux has to ask the
/// compositor for client-side decorations, and only some window managers and
/// compositors grant that: X11 needs a compositor that advertises
/// `_GTK_FRAME_EXTENTS`, Wayland needs `zxdg_decoration_manager_v1`. Where the
/// request is refused the window keeps its server-side frame — and its title bar
/// — so an app must draw caption buttons only where this is true, or it draws a
/// second set beside the window manager's own.
///
/// On Linux the answer comes from the window itself rather than a guess: the
/// bootstrap records what `window.window_decorations()` reported once the main
/// window exists, which is the only authority on whether the request was
/// granted. Before that the answer is "unknown", and the safe answer to an
/// unknown is false.
pub fn client_decorations() -> bool {
    #[cfg(target_os = "linux")]
    {
        match OBSERVED_CLIENT_DECORATIONS.load(Ordering::Relaxed) {
            DECORATIONS_CLIENT => true,
            DECORATIONS_SERVER => false,
            // A Wayland window starts on client-side decorations and only
            // switches when the compositor insists, so before the first window
            // exists that is the better guess.
            _ => is_wayland(),
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        // The same platforms `transparent_titlebar` is true on: a window only
        // exists there, and both keep a native resize border when the caption is
        // removed.
        cfg!(any(target_os = "macos", target_os = "windows"))
    }
}

#[cfg(target_os = "linux")]
const DECORATIONS_UNKNOWN: u8 = 0;
#[cfg(target_os = "linux")]
const DECORATIONS_SERVER: u8 = 1;
#[cfg(target_os = "linux")]
const DECORATIONS_CLIENT: u8 = 2;

/// What the compositor gave the windows opened so far.
///
/// An atomic rather than a `OnceLock` because a second window can be refused
/// after the first was granted, and the later answer is the one that matters:
/// the caption buttons are drawn per window, but the capability is read once.
#[cfg(target_os = "linux")]
static OBSERVED_CLIENT_DECORATIONS: AtomicU8 = AtomicU8::new(DECORATIONS_UNKNOWN);

/// Records whether a window ended up with client-side decorations.
#[cfg(target_os = "linux")]
pub fn note_window_decorations(decorations: gpui::Decorations) {
    let value = match decorations {
        gpui::Decorations::Client { .. } => DECORATIONS_CLIENT,
        gpui::Decorations::Server => DECORATIONS_SERVER,
    };
    OBSERVED_CLIENT_DECORATIONS.store(value, Ordering::Relaxed);
}

/// Nothing to record: these platforms always have a native border to resize by.
#[cfg(not(target_os = "linux"))]
pub fn note_window_decorations(_decorations: gpui::Decorations) {}

/// Whether the menu bar is drawn inside the window, so hiding it does something.
///
/// macOS is false: its menu bar is the system's, at the top of the screen, and
/// nothing an app does can remove it. Windows and Linux draw theirs inside the
/// window, which is why `Menu.setMenuBarVisible` only means something there.
pub const fn menu_bar_in_window() -> bool {
    cfg!(any(target_os = "windows", target_os = "linux"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_supports_native_menus_and_anchored_popovers() {
        if cfg!(target_os = "macos") {
            assert!(native_app_menu());
            assert!(native_context_menu());
            assert!(tray());
            assert!(tray_popover_anchored());
            assert!(transparent_titlebar());
            assert!(!menu_bar_in_window());
        }
    }

    #[test]
    fn the_menu_bar_is_only_in_window_where_it_can_be_hidden() {
        if cfg!(any(target_os = "windows", target_os = "linux")) {
            assert!(menu_bar_in_window());
        }
    }

    #[test]
    fn a_custom_title_bar_is_resizable_off_linux_without_asking_the_compositor() {
        // Windows and macOS keep their native resize border when the caption is
        // removed, so the capability is unconditional there and `TitleBar` can
        // draw caption buttons on any window it is put in.
        if cfg!(any(target_os = "macos", target_os = "windows")) {
            assert!(client_decorations());
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_reports_what_the_compositor_actually_granted() {
        // The bootstrap records the answer per window; until it does, an X11
        // session has to assume the request will be refused, because guessing
        // "granted" would draw caption buttons next to the window manager's own.
        note_window_decorations(gpui::Decorations::Server);
        assert!(!client_decorations());

        note_window_decorations(gpui::Decorations::Client {
            tiling: gpui::Tiling::default(),
        });
        assert!(client_decorations());

        // A later window that was refused wins: the capability must describe
        // what the newest window actually looks like.
        note_window_decorations(gpui::Decorations::Server);
        assert!(!client_decorations());
        // A transparent title bar is the same question on Linux: without
        // client-side decorations the window manager keeps its own bar, and the
        // app cannot remove it.
        assert!(!transparent_titlebar());
    }
}
