pub(crate) mod accessibility;
pub(crate) mod animation_policy;
pub mod builtins;
pub(crate) mod counters;
pub(crate) mod desktop;
pub(crate) mod events;
pub mod extensions;
pub(crate) mod frame;
pub(crate) mod host;
pub mod host_component;
pub(crate) mod image_loader;
pub mod native_surface;
#[cfg(target_os = "macos")]
pub mod native_view;
#[cfg(all(target_os = "macos", feature = "visual-capture"))]
pub(crate) mod native_view_probe;
pub(crate) mod node_view;
pub(crate) mod pointer_area;
pub mod runtime;
pub(crate) mod scroll_indicator;
pub(crate) mod scroll_layers;
pub(crate) mod store;
pub(crate) mod style;
pub mod surface;
#[cfg(feature = "test-driver")]
mod test_driver;
pub(crate) mod text;

mod bootstrap;
mod http_client;
mod resources;
pub use bootstrap::{run, run_with, DesktopAppConfig, WindowTitleBar};
pub use desktop::tray::TrayConfig;
/// The runtime a Rust TurboModule is written against.
pub use http_client::RnHttpClient;
pub use rn_gpui_module as module;
pub use rn_gpui_module::{register as register_module, ModuleError, ModuleThread, Value};
pub use runtime::ReactRuntime;
pub use surface::{ReactSurface, SurfaceSizing};
