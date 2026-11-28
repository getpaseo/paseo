//! The alert as a small GPUI window, for platforms with no native sheet: it
//! has the text fields and button styles GPUI's own prompt has no room for.

use gpui::prelude::FluentBuilder as _;
use gpui::AppContext as _;
use gpui::{
    div, px, rgb, size, App, Bounds, Context, FocusHandle, Focusable, InteractiveElement,
    IntoElement, KeyDownEvent, MouseButton, ParentElement, Render, SharedString, Styled,
    TitlebarOptions, Window, WindowBounds, WindowKind, WindowOptions,
};
use std::cell::RefCell;
use std::rc::Rc;

use super::{Input, Outcome, Request};

const WIDTH: f32 = 400.0;

struct Field {
    placeholder: &'static str,
    value: String,
    secure: bool,
}

thread_local! {
    static CURRENT: RefCell<Option<gpui::WindowHandle<Dialog>>> = const { RefCell::new(None) };
}

pub(crate) struct Dialog {
    request: Request,
    fields: Vec<Field>,
    focused_field: usize,
    focus: FocusHandle,
    answer: Rc<RefCell<Option<Box<dyn FnOnce(Outcome)>>>>,
}

/// Opens the dialog. `done` is called once, with the button chosen or
/// `Dismissed` when the window closes without one.
pub(crate) fn present(cx: &mut App, request: Request, done: Box<dyn FnOnce(Outcome)>) {
    let fields = match request.input {
        Input::None => Vec::new(),
        Input::Plain => vec![Field {
            placeholder: "",
            value: request.default_value.clone(),
            secure: false,
        }],
        Input::Secure => vec![Field {
            placeholder: "",
            value: request.default_value.clone(),
            secure: true,
        }],
        Input::Login => vec![
            Field {
                placeholder: "Login",
                value: request.default_value.clone(),
                secure: false,
            },
            Field {
                placeholder: "Password",
                value: String::new(),
                secure: true,
            },
        ],
    };
    let height =
        120.0 + fields.len() as f32 * 38.0 + if request.message.is_some() { 24.0 } else { 0.0 };
    let bounds = Bounds::centered(None, size(px(WIDTH), px(height)), cx);
    let title = request.title.clone();
    let answer: Rc<RefCell<Option<Box<dyn FnOnce(Outcome)>>>> = Rc::new(RefCell::new(Some(done)));
    let opened = cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: Some(TitlebarOptions {
                title: Some(SharedString::from(title)),
                ..Default::default()
            }),
            is_resizable: false,
            kind: WindowKind::Dialog,
            ..Default::default()
        },
        {
            let answer = answer.clone();
            move |window, cx| {
                let focus = cx.focus_handle();
                window.focus(&focus, cx);
                window.on_window_should_close(cx, {
                    let answer = answer.clone();
                    move |_window, _cx| {
                        if let Some(done) = answer.borrow_mut().take() {
                            done(Outcome::Dismissed);
                        }
                        true
                    }
                });
                cx.new(|_| Dialog {
                    request,
                    fields,
                    focused_field: 0,
                    focus,
                    answer,
                })
            }
        },
    );
    match opened {
        Ok(handle) => CURRENT.with(|current| *current.borrow_mut() = Some(handle)),
        Err(_) => {
            if let Some(done) = answer.borrow_mut().take() {
                done(Outcome::Dismissed);
            }
        }
    }
}

/// The dialog on screen: its title, button labels and text field values.
#[cfg(feature = "test-driver")]
pub fn describe(cx: &mut App) -> Option<serde_json::Value> {
    let handle = CURRENT.with(|current| *current.borrow())?;
    handle
        .read_with(cx, |dialog, _| {
            serde_json::json!({
                "title": dialog.request.title,
                "buttons": dialog.request.buttons.iter().map(|(_, label)| label.clone()).collect::<Vec<_>>(),
                "fields": dialog.fields.iter().map(|field| field.value.clone()).collect::<Vec<_>>(),
            })
        })
        .ok()
}

/// Presses Escape in the dialog.
#[cfg(feature = "test-driver")]
pub fn press_escape(cx: &mut App) -> bool {
    let Some(handle) = CURRENT.with(|current| *current.borrow()) else {
        return false;
    };
    handle
        .update(cx, |dialog, window, _cx| dialog.escape(window))
        .is_ok()
}

/// Types into the dialog's fields and presses a button.
#[cfg(feature = "test-driver")]
pub fn respond(cx: &mut App, button: usize, texts: &[String]) -> bool {
    let Some(handle) = CURRENT.with(|current| *current.borrow()) else {
        return false;
    };
    handle
        .update(cx, |dialog, window, _cx| {
            if button >= dialog.request.buttons.len() {
                return false;
            }
            for (field, text) in dialog.fields.iter_mut().zip(texts) {
                field.value = text.clone();
            }
            dialog.press(button, window);
            true
        })
        .unwrap_or(false)
}

impl Dialog {
    fn finish(&mut self, outcome: Outcome, window: &mut Window) {
        CURRENT.with(|current| *current.borrow_mut() = None);
        if let Some(done) = self.answer.borrow_mut().take() {
            done(outcome);
        }
        window.remove_window();
    }

    fn escape(&mut self, window: &mut Window) {
        if let Some(cancel) = self.request.cancel {
            self.press(cancel, window);
        } else if self.request.cancelable {
            self.finish(Outcome::Dismissed, window);
        }
    }

    fn press(&mut self, position: usize, window: &mut Window) {
        let text = match self.request.input {
            Input::None => String::new(),
            Input::Plain | Input::Secure => self.fields[0].value.clone(),
            // The same shape the native sheet answers with.
            Input::Login => serde_json::json!({
                "login": self.fields[0].value,
                "password": self.fields[1].value,
            })
            .to_string(),
        };
        self.finish(Outcome::Button { position, text }, window);
    }

    fn key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let keystroke = &event.keystroke;
        match keystroke.key.as_str() {
            "escape" => {
                self.escape(window);
                return;
            }
            "enter" => {
                let position = self
                    .request
                    .preferred
                    .unwrap_or(self.request.buttons.len().saturating_sub(1));
                self.press(position, window);
                return;
            }
            "tab" if !self.fields.is_empty() => {
                self.focused_field = (self.focused_field + 1) % self.fields.len();
            }
            "backspace" => {
                if let Some(field) = self.fields.get_mut(self.focused_field) {
                    field.value.pop();
                }
            }
            "v" if keystroke.modifiers.secondary(cx) => {
                if let (Some(field), Some(text)) = (
                    self.fields.get_mut(self.focused_field),
                    cx.read_from_clipboard().and_then(|item| item.text()),
                ) {
                    field.value.push_str(&text.replace('\n', " "));
                }
            }
            _ => {
                if keystroke.modifiers.control || keystroke.modifiers.platform {
                    return;
                }
                if let (Some(field), Some(text)) =
                    (self.fields.get_mut(self.focused_field), &keystroke.key_char)
                {
                    field.value.push_str(text);
                }
            }
        }
        cx.notify();
    }
}

impl Focusable for Dialog {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for Dialog {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let dark = self.request.dark.unwrap_or(false);
        let (background, foreground, muted, field_background) = if dark {
            (0x2b2b2b, 0xf2f2f2, 0xa0a0a0, 0x1e1e1e)
        } else {
            (0xf6f6f6, 0x1c1c1e, 0x6e6e73, 0xffffff)
        };
        let fields: Vec<_> = self
            .fields
            .iter()
            .enumerate()
            .map(|(index, field)| {
                let shown = if field.secure {
                    "•".repeat(field.value.chars().count())
                } else {
                    field.value.clone()
                };
                let focused = index == self.focused_field;
                div()
                    .id(SharedString::from(format!("alert-field-{index}")))
                    .h(px(28.0))
                    .px_2()
                    .flex()
                    .items_center()
                    .rounded(px(5.0))
                    .bg(rgb(field_background))
                    .border_1()
                    .border_color(rgb(if focused { 0x0a84ff } else { 0xc7c7cc }))
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, _event, _window, cx| {
                            this.focused_field = index;
                            cx.notify();
                        }),
                    )
                    .child(if shown.is_empty() {
                        div()
                            .text_color(rgb(muted))
                            .child(field.placeholder.to_string())
                    } else {
                        div().child(shown)
                    })
            })
            .collect();
        let buttons: Vec<_> = self
            .request
            .buttons
            .iter()
            .enumerate()
            .map(|(position, (_, label))| {
                let preferred = self.request.preferred == Some(position)
                    || (self.request.preferred.is_none()
                        && position + 1 == self.request.buttons.len());
                let destructive = self.request.destructive == Some(position);
                div()
                    .id(SharedString::from(format!("alert-button-{position}")))
                    .h(px(28.0))
                    .px_3()
                    .flex()
                    .items_center()
                    .rounded(px(5.0))
                    .cursor_pointer()
                    .when(preferred, |button| {
                        button.bg(rgb(0x0a84ff)).text_color(rgb(0xffffff))
                    })
                    .when(!preferred, |button| {
                        button
                            .bg(rgb(field_background))
                            .border_1()
                            .border_color(rgb(0xc7c7cc))
                            .text_color(rgb(if destructive { 0xff3b30 } else { foreground }))
                    })
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, _event, window, _cx| {
                            this.press(position, window);
                        }),
                    )
                    .child(label.clone())
            })
            .collect();
        div()
            .id("alert-dialog")
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                this.key(event, window, cx);
            }))
            .size_full()
            .p_4()
            .flex()
            .flex_col()
            .gap_3()
            .bg(rgb(background))
            .text_color(rgb(foreground))
            .text_size(px(13.0))
            .child(
                div()
                    .font_weight(gpui::FontWeight::BOLD)
                    .text_size(px(15.0))
                    .child(self.request.title.clone()),
            )
            .when_some(self.request.message.clone(), |dialog, message| {
                dialog.child(div().text_color(rgb(muted)).child(message))
            })
            .children(fields)
            .child(
                div()
                    .flex()
                    .flex_row()
                    .justify_end()
                    .gap_2()
                    .children(buttons),
            )
    }
}
