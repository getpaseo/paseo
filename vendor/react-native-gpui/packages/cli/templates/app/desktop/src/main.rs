//! Project-owned desktop launch configuration.
//!
//! A local Rust TurboModule is a `Native*.ts` spec beside this file plus a
//! `mod` that implements the trait generated from it. `build.rs` lists the
//! specs, and `main` registers each module before the app starts. See
//! `desktop/README.md` for the full example.

rn_gpui_module::include_specs!();

// mod greeting;
// use greeting::{native_greeting_module, Greeting};

fn main() {
    // A debug build knows where its own bundle is; a release build does not, and
    // must not: the path would name the machine that built it. A packaged release
    // app resolves the bundle beside its executable instead (see `resources`).
    #[cfg(debug_assertions)]
    if std::env::var_os("RN_GPUI_BUNDLE").is_none() {
        std::env::set_var("RN_GPUI_BUNDLE", env!("RN_GPUI_DEFAULT_BUNDLE"));
    }
    // App-local modules are registered before the app starts; a module the
    // platform already provides would panic here.
    // react_native_gpui::register_module(native_greeting_module::<Greeting>());

    let config = react_native_gpui::DesktopAppConfig::from_env_with_defaults(
        env!("RN_GPUI_APP_NAME"),
        env!("RN_GPUI_APP_ID"),
    )
    .window_title(env!("RN_GPUI_APP_NAME"))
    .window_size(1024.0, 768.0)
    // Uncomment to choose a fixed initial top-left location (screen DIPs).
    // .window_position(120.0, 80.0)
    // .restore_window_state(false)
    .configure_window(|options| {
        // GPUI window options are public: titlebar, resizability, display,
        // decorations, min size, and other native window behavior.
        options.is_resizable = true;
    });

    react_native_gpui::run_with(config);
}
