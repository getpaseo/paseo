//! The runtime handle a GPUI-first app is given.
//!
//! A GPUI-first app is one whose windows are its own GPUI trees, with React
//! content where it places a [`ReactSurface`](crate::ReactSurface):
//!
//! ```ignore
//! run_with(DesktopAppConfig::from_env().gpui_first(|cx, runtime| {
//!     // Any GPUI tree, with React content where it wants it:
//!     cx.new(|cx| {
//!         let sidebar = cx.new(|cx| ReactSurface::new("Sidebar", cx));
//!         let details = cx.new(|cx| {
//!             ReactSurface::new("Details", cx).sizing(SurfaceSizing::fit_content())
//!         });
//!         Root { sidebar, details }
//!     })
//!     .into()
//! }));
//! ```
//!
//! [`DesktopAppConfig::gpui_first`](crate::DesktopAppConfig::gpui_first) is the
//! entry point. The runtime boots the way [`run_with`](crate::run_with) always
//! does — the JS engine, the bundle, the modules and the store — and then the
//! main window shows the app's view instead of a React tree started on surface 1.
//! The boot cannot be separated from that window any further: the store that
//! routes mount batches needs a window to exist, so the app supplies the window's
//! content rather than a window of its own making.
//!
//! What makes several surfaces work is that a surface is not tied to a window: a
//! `ReactSurface` asks for its own odd id, mount batches are routed by surface
//! id, and the store keeps one root per surface. One window can hold several
//! surfaces, and [`ReactRuntime::open_window`] opens more windows that hold
//! their own.

use gpui::{App, Bounds, Render, Size, Window, WindowBounds, WindowOptions};

/// What a GPUI-first app needs from the runtime once JS is running.
#[derive(Clone, Copy, Debug)]
pub struct ReactRuntime {
    scale: f32,
}

impl ReactRuntime {
    /// A handle for a runtime that started at `scale`.
    pub(crate) fn new(scale: f32) -> Self {
        Self { scale }
    }

    /// The scale the runtime started at: what a surface is told until its own
    /// window reports one.
    pub fn scale(&self) -> f32 {
        self.scale
    }

    /// Opens another GPUI window whose root `build` makes, and returns it.
    pub fn open_window<V: Render + 'static>(
        &self,
        cx: &mut App,
        title: impl Into<String>,
        size: impl Into<Size<gpui::Pixels>>,
        build: impl FnOnce(&mut Window, &mut App) -> gpui::Entity<V> + 'static,
    ) -> gpui::WindowHandle<V> {
        let mut options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                None,
                size.into(),
                cx,
            ))),
            ..Default::default()
        };
        options.titlebar = Some(gpui::TitlebarOptions {
            title: Some(title.into().into()),
            ..Default::default()
        });
        cx.open_window(options, build)
            .expect("failed to open a GPUI window")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_handle_reports_the_scale_the_runtime_started_at() {
        assert_eq!(ReactRuntime::new(2.0).scale(), 2.0);
    }

    #[test]
    fn the_handle_is_a_cheap_copy() {
        let runtime = ReactRuntime::new(1.5);
        let copy = runtime;
        assert_eq!(runtime.scale(), copy.scale());
    }
}
