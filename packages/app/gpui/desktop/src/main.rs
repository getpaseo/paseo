rn_gpui_module::include_specs!();

mod services;

fn main() {
    react_native_gpui::register_module(native_paseo_desktop_module::<services::PaseoDesktop>());
    rn_gpui_autolink::ensure_linked();
    // A debug build knows where its own bundle is; a release build does not, and
    // must not: the path would name the machine that built it. A packaged release
    // app resolves the bundle beside its executable instead.
    #[cfg(debug_assertions)]
    if std::env::var_os("RN_GPUI_BUNDLE").is_none() {
        std::env::set_var("RN_GPUI_BUNDLE", env!("RN_GPUI_DEFAULT_BUNDLE"));
    }
    let config = react_native_gpui::DesktopAppConfig::from_env_with_defaults(
        env!("RN_GPUI_APP_NAME"),
        env!("RN_GPUI_APP_ID"),
    )
    .window_title("Paseo GPUI")
    .window_size(1024.0, 768.0)
    .dev_menu(true)
    .configure_window(|options| {
        // GPUI window options are public: titlebar, resizability, display,
        // decorations, min size, and other native window behavior.
        options.is_resizable = true;
    });

    react_native_gpui::run_with(config);
}
