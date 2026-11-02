//! The screens module.
//!
//! Everything react-native-screens needs lives here: its props extraction in
//! `cpp/`, and its layout, painting and lifecycle in the modules below. Core is
//! told only what any library can say — a component name, a props reader, and a
//! set of generic hooks.
pub mod lifecycle;
pub mod props;
pub mod render;
pub mod stack;
pub mod state;
pub mod transition;
pub mod unsupported;

/// Registers this module's renderers and observer.
///
/// Autolink calls this from `ensure_linked()` while `main` starts, before any
/// `gpui::App` exists, so nothing here may touch the app.
pub fn rn_gpui_register() {
    react_native_gpui::extensions::register_store_observer(std::sync::Arc::new(
        stack::StackObserver,
    ));
    for (component, build) in render::RENDERED_COMPONENTS {
        react_native_gpui::extensions::register_component_renderer(
            *component,
            std::sync::Arc::from(build()),
        );
    }
}
