pub(crate) mod accessibility;
pub(crate) mod animation_policy;
pub mod app_hooks;
pub mod builtins;
pub(crate) mod counters;
mod cpp_host;
pub(crate) mod desktop;
pub(crate) mod drag_drop;
pub(crate) mod events;
pub mod extensions;
pub(crate) mod file_drop;
mod filter;
pub(crate) mod frame;
pub(crate) mod gradient;
#[cfg(feature = "test-driver")]
mod headless;
pub(crate) mod host;
pub mod host_component;
pub(crate) mod image_loader;
pub(crate) mod interaction;
pub mod native_surface;
pub mod native_tree;
#[cfg(target_os = "macos")]
pub mod native_view;
#[cfg(all(target_os = "macos", feature = "visual-capture"))]
pub(crate) mod native_view_probe;
pub(crate) mod node_view;
pub(crate) mod pointer_area;
pub mod runtime;
pub(crate) mod scroll_indicator;
pub(crate) mod scroll_layers;
pub(crate) mod scroll_momentum;
pub(crate) mod scroll_snap;
mod scroller_style;
pub(crate) mod store;
pub(crate) mod style;
pub mod surface;
#[cfg(feature = "test-driver")]
mod test_driver;
pub(crate) mod text;
pub(crate) mod tooltip;
mod transform;
pub(crate) mod view_props;
pub(crate) mod virtual_view;
mod wheel;

mod bootstrap;
mod http_client;
mod resources;
pub use animation_policy::animations_disabled;
pub use app_hooks::{register_app_init, register_asset_source, register_root_wrapper};
pub use bootstrap::{
    run, run_with, set_desktop_defaults, DesktopAppConfig, WindowBackground, WindowTitleBar,
};
pub use desktop::tray::TrayConfig;
/// The runtime a Rust TurboModule is written against.
pub use http_client::RnHttpClient;
pub use rn_gpui_module as module;
pub use rn_gpui_module::{register as register_module, ModuleError, ModuleThread, Value};
pub use runtime::ReactRuntime;
pub use surface::{ReactSurface, SurfaceSizing};
