use gpui::{App, AppContext};
use rn_gpui_module::{ModuleThread, Value};

use crate::builtins::rn_gpui_specs::{
    AlertArgs, NativeGpuiAlertManagerEvents, NativeGpuiAlertManagerSpec,
};

struct AlertManagerModule;

fn button_labels(buttons: Option<Vec<Value>>) -> Vec<String> {
    let Some(buttons) = buttons else {
        return Vec::new();
    };
    let mut labels: Vec<(usize, String)> = buttons
        .into_iter()
        .enumerate()
        .filter_map(|(position, button)| match button {
            Value::String(text) => Some((position, text)),
            Value::Object(fields) => fields.iter().find_map(|(key, value)| match value {
                Value::String(text) => Some((key.parse().unwrap_or(position), text.clone())),
                _ => None,
            }),
            _ => None,
        })
        .collect();
    labels.sort_by_key(|(position, _)| *position);
    labels.into_iter().map(|(_, text)| text).collect()
}

impl NativeGpuiAlertManagerSpec for AlertManagerModule {
    const THREAD: ModuleThread = ModuleThread::Main;

    fn new(_events: NativeGpuiAlertManagerEvents) -> Self {
        Self
    }

    fn alert_with_args(&self, args: AlertArgs, callback: Box<dyn FnOnce(f64, String) + Send>) {
        let title = args.title.unwrap_or_default();
        let message = args.message.unwrap_or_default();
        let mut buttons = button_labels(args.buttons);
        if buttons.is_empty() {
            buttons.push("OK".to_string());
        }
        let answers: Vec<gpui::PromptButton> = buttons
            .iter()
            .map(|button| gpui::PromptButton::new(button.clone()))
            .collect();
        crate::desktop::post_to_main(Box::new(move |cx: &mut App| {
            let store = match cx.try_global::<crate::store::StoreGlobal>() {
                Some(store) => store.0.clone(),
                None => {
                    callback(0.0, String::new());
                    return;
                }
            };
            let mut window = None;
            store.update(cx, |store, _cx| window = Some(store.window));
            let Some(window) = window else {
                callback(0.0, String::new());
                return;
            };
            let receiver = cx.update_window(window, move |_root, window, cx| {
                window.prompt(
                    gpui::PromptLevel::Info,
                    &title,
                    (!message.is_empty()).then_some(message.as_str()),
                    &answers,
                    cx,
                )
            });
            match receiver {
                Ok(receiver) => {
                    cx.spawn(async move |_cx| {
                        let index = receiver.await.unwrap_or(0);
                        callback(index as f64, String::new());
                    })
                    .detach();
                }
                Err(_) => callback(0.0, String::new()),
            }
        }));
    }
}

pub fn register() {
    rn_gpui_module::register(
        crate::builtins::rn_gpui_specs::native_gpui_alert_manager_module::<AlertManagerModule>(),
    );
}
