use gpui::{App, AppContext};
use rn_gpui_module::{ModuleThread, Value};

use crate::builtins::rn_gpui_specs::{
    AlertArgs, NativeGpuiAlertManagerEvents, NativeGpuiAlertManagerSpec,
};

pub(crate) mod dialog;
#[cfg(target_os = "macos")]
pub(crate) mod mac;

struct AlertManagerModule;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Input {
    None,
    Plain,
    Secure,
    Login,
}

/// What a dialog was asked to show.
pub(crate) struct Request {
    pub title: String,
    pub message: Option<String>,
    /// `(key, label)` for each button, in display order.
    pub buttons: Vec<(String, String)>,
    pub cancel: Option<usize>,
    pub destructive: Option<usize>,
    pub preferred: Option<usize>,
    pub cancelable: bool,
    pub input: Input,
    pub default_value: String,
    pub dark: Option<bool>,
}

pub(crate) enum Outcome {
    Button { position: usize, text: String },
    Dismissed,
}

fn buttons_of(buttons: Option<Vec<Value>>) -> Vec<(String, String)> {
    let Some(buttons) = buttons else {
        return Vec::new();
    };
    let mut labelled: Vec<(usize, String, String)> = buttons
        .into_iter()
        .enumerate()
        .filter_map(|(position, button)| match button {
            Value::String(text) => Some((position, position.to_string(), text)),
            Value::Object(fields) => fields.iter().find_map(|(key, value)| match value {
                Value::String(text) => {
                    Some((key.parse().unwrap_or(position), key.clone(), text.clone()))
                }
                _ => None,
            }),
            _ => None,
        })
        .collect();
    labelled.sort_by_key(|(order, _, _)| *order);
    labelled
        .into_iter()
        .map(|(_, key, text)| (key, text))
        .collect()
}

fn position_of(buttons: &[(String, String)], key: Option<&String>) -> Option<usize> {
    let key = key?;
    buttons.iter().position(|(candidate, _)| candidate == key)
}

fn input_of(kind: Option<&str>) -> Input {
    match kind {
        Some("plain-text") => Input::Plain,
        Some("secure-text") => Input::Secure,
        Some("login-password") => Input::Login,
        _ => Input::None,
    }
}

impl NativeGpuiAlertManagerSpec for AlertManagerModule {
    const THREAD: ModuleThread = ModuleThread::Main;

    fn new(_events: NativeGpuiAlertManagerEvents) -> Self {
        Self
    }

    fn alert_with_args(&self, args: AlertArgs, callback: Box<dyn FnOnce(f64, String) + Send>) {
        let mut buttons = buttons_of(args.buttons);
        if buttons.is_empty() {
            buttons.push(("0".to_string(), "OK".to_string()));
        }
        let request = Request {
            title: args.title.unwrap_or_default(),
            message: args.message.filter(|message| !message.is_empty()),
            cancel: position_of(&buttons, args.cancel_button_key.as_ref()),
            destructive: position_of(&buttons, args.destructive_button_key.as_ref()),
            preferred: position_of(&buttons, args.preferred_button_key.as_ref()),
            cancelable: args.cancelable.unwrap_or(false),
            input: input_of(args.r#type.as_deref()),
            default_value: args.default_value.unwrap_or_default(),
            dark: match args.user_interface_style.as_deref() {
                Some("dark") => Some(true),
                Some("light") => Some(false),
                _ => None,
            },
            buttons,
        };
        crate::desktop::post_to_main(Box::new(move |cx: &mut App| {
            let store = match cx.try_global::<crate::store::StoreGlobal>() {
                Some(store) => store.0.clone(),
                None => {
                    callback(-1.0, String::new());
                    return;
                }
            };
            let mut window = None;
            store.update(cx, |store, _cx| window = Some(store.window));
            let Some(window) = window else {
                callback(-1.0, String::new());
                return;
            };
            let keys: Vec<String> = request.buttons.iter().map(|(key, _)| key.clone()).collect();
            let answer = move |outcome: Outcome| match outcome {
                Outcome::Button { position, text } => {
                    let id = keys
                        .get(position)
                        .and_then(|key| key.parse::<f64>().ok())
                        .unwrap_or(position as f64);
                    callback(id, text)
                }
                Outcome::Dismissed => callback(-1.0, String::new()),
            };
            #[cfg(target_os = "macos")]
            if std::env::var_os("RN_GPUI_ALERT_DIALOG").is_some() {
                dialog::present(cx, request, Box::new(answer));
            } else {
                let mut answer = Some(answer);
                let shown = cx.update_window(window, |_root, window, _cx| {
                    mac::present(
                        window,
                        request,
                        Box::new(answer.take().expect("answer taken once")),
                    );
                });
                if shown.is_err() {
                    if let Some(answer) = answer {
                        answer(Outcome::Dismissed);
                    }
                }
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = window;
                dialog::present(cx, request, Box::new(answer));
            }
        }));
    }
}

pub fn register() {
    rn_gpui_module::register(
        crate::builtins::rn_gpui_specs::native_gpui_alert_manager_module::<AlertManagerModule>(),
    );
}
