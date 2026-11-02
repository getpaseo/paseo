rn_gpui_module::include_specs!();

pub mod alert;
pub mod app_menu;
pub mod clipboard;
pub mod context_menu;
pub mod context_menu_view;
pub mod dev_menu;
pub mod image;
pub mod linking;
pub mod main_thread;
pub mod modal;
pub mod perf_monitor;
pub mod scrollview;
pub mod shortcut_scope;
pub mod shortcuts;
pub mod textinput;
pub mod tray;
pub mod window_control;
pub mod windows;

pub fn register() {
    alert::register();
    app_menu::register();
    clipboard::register();
    context_menu::register();
    context_menu_view::register();
    dev_menu::register();
    image::register();
    linking::register();
    modal::register();
    perf_monitor::register();
    scrollview::register();
    shortcut_scope::register();
    shortcuts::register();
    tray::register();
    window_control::register();
    windows::register();
}
