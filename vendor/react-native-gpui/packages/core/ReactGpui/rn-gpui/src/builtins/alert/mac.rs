//! `NSAlert` shown as a sheet, with the options and text fields GPUI's prompt
//! has no room for.

use block::ConcreteBlock;
use cocoa::base::{id, nil, YES};
use cocoa::foundation::{NSPoint, NSRect, NSSize, NSString};
use objc::{class, msg_send, sel, sel_impl};
use std::cell::RefCell;

use super::{Input, Outcome, Request};

const FIRST_BUTTON_RETURN: isize = 1000;
const ESCAPE_KEY_CODE: u16 = 53;
const KEY_DOWN_MASK: u64 = 1 << 10;
const FIELD_WIDTH: f64 = 260.0;
const FIELD_HEIGHT: f64 = 24.0;

unsafe fn ns(text: &str) -> id {
    NSString::alloc(nil).init_str(text)
}

unsafe fn text_field(secure: bool, placeholder: &str, value: &str, y: f64) -> id {
    let class = if secure {
        class!(NSSecureTextField)
    } else {
        class!(NSTextField)
    };
    let frame = NSRect::new(NSPoint::new(0.0, y), NSSize::new(FIELD_WIDTH, FIELD_HEIGHT));
    let field: id = msg_send![class, alloc];
    let field: id = msg_send![field, initWithFrame: frame];
    let _: () = msg_send![field, setPlaceholderString: ns(placeholder)];
    let _: () = msg_send![field, setStringValue: ns(value)];
    field
}

unsafe fn string_of(field: id) -> String {
    let value: id = msg_send![field, stringValue];
    let bytes: *const std::os::raw::c_char = msg_send![value, UTF8String];
    if bytes.is_null() {
        return String::new();
    }
    std::ffi::CStr::from_ptr(bytes)
        .to_string_lossy()
        .into_owned()
}

struct Pending {
    alert: id,
    window: id,
    buttons: Vec<String>,
    fields: Vec<id>,
}

thread_local! {
    static CURRENT: RefCell<Option<Pending>> = const { RefCell::new(None) };
}

/// The sheet on screen: its title, button labels and text field values.
#[cfg(feature = "test-driver")]
pub fn describe() -> Option<serde_json::Value> {
    CURRENT.with(|current| {
        let current = current.borrow();
        let pending = current.as_ref()?;
        // SAFETY: main thread, and the sheet is alive while it is in `CURRENT`.
        unsafe {
            let title: id = msg_send![pending.alert, messageText];
            let bytes: *const std::os::raw::c_char = msg_send![title, UTF8String];
            let title = std::ffi::CStr::from_ptr(bytes)
                .to_string_lossy()
                .into_owned();
            let fields: Vec<String> = pending.fields.iter().map(|f| string_of(*f)).collect();
            Some(serde_json::json!({
                "title": title,
                "buttons": pending.buttons,
                "fields": fields,
            }))
        }
    })
}

/// Types into the sheet's fields and presses a button.
#[cfg(feature = "test-driver")]
pub fn respond(button: usize, texts: &[String]) -> bool {
    // The press completes the sheet, which clears `CURRENT`: take what is
    // needed out first so nothing is borrowed while it runs.
    let Some((alert, fields)) = CURRENT.with(|current| {
        current
            .borrow()
            .as_ref()
            .map(|pending| (pending.alert, pending.fields.clone()))
    }) else {
        return false;
    };
    // SAFETY: main thread, and the sheet is alive until its completion runs.
    unsafe {
        for (field, text) in fields.iter().zip(texts) {
            let _: () = msg_send![*field, setStringValue: ns(text)];
        }
        let buttons: id = msg_send![alert, buttons];
        let count: usize = msg_send![buttons, count];
        if button >= count {
            return false;
        }
        let target: id = msg_send![buttons, objectAtIndex: button];
        let _: () = msg_send![target, performClick: nil];
    }
    true
}

/// Sends an Escape key press to the sheet.
#[cfg(feature = "test-driver")]
pub fn press_escape() -> bool {
    let Some(window) = CURRENT.with(|current| current.borrow().as_ref().map(|p| p.window)) else {
        return false;
    };
    {
        // SAFETY: main thread, and the sheet is alive until its completion runs.
        unsafe {
            let number: isize = msg_send![window, windowNumber];
            let escape = ns("\u{1b}");
            let event: id = msg_send![
                class!(NSEvent),
                keyEventWithType: 10usize
                location: NSPoint::new(0.0, 0.0)
                modifierFlags: 0usize
                timestamp: 0.0f64
                windowNumber: number
                context: nil
                characters: escape
                charactersIgnoringModifiers: escape
                isARepeat: false
                keyCode: ESCAPE_KEY_CODE
            ];
            let app: id = msg_send![class!(NSApplication), sharedApplication];
            let _: () = msg_send![app, sendEvent: event];
        }
        true
    }
}

/// Shows `request` as a sheet on `window`; `done` runs once, on the main thread.
pub fn present(window: &gpui::Window, request: Request, done: Box<dyn FnOnce(Outcome)>) {
    let Ok(parent) = crate::desktop::platform_window::ns_window(window) else {
        done(Outcome::Dismissed);
        return;
    };
    // SAFETY: AppKit is only messaged from the main thread, where GPUI runs this.
    unsafe {
        let alert: id = msg_send![class!(NSAlert), new];
        let _: () = msg_send![alert, setMessageText: ns(&request.title)];
        if let Some(message) = &request.message {
            let _: () = msg_send![alert, setInformativeText: ns(message)];
        }
        for (position, (_, label)) in request.buttons.iter().enumerate() {
            let button: id = msg_send![alert, addButtonWithTitle: ns(label)];
            let key = if request.cancel == Some(position) {
                "\u{1b}"
            } else if request.preferred == Some(position) {
                "\r"
            } else if request.preferred.is_some() {
                ""
            } else {
                continue;
            };
            let _: () = msg_send![button, setKeyEquivalent: ns(key)];
            if request.destructive == Some(position) {
                let responds: bool =
                    msg_send![button, respondsToSelector: sel!(setHasDestructiveAction:)];
                if responds {
                    let _: () = msg_send![button, setHasDestructiveAction: YES];
                }
            }
        }
        if let (Some(position), true) = (request.destructive, request.cancel != request.destructive)
        {
            let buttons: id = msg_send![alert, buttons];
            let button: id = msg_send![buttons, objectAtIndex: position];
            let responds: bool =
                msg_send![button, respondsToSelector: sel!(setHasDestructiveAction:)];
            if responds {
                let _: () = msg_send![button, setHasDestructiveAction: YES];
            }
        }
        let alert_window: id = msg_send![alert, window];
        if let Some(dark) = request.dark {
            let name = if dark {
                "NSAppearanceNameDarkAqua"
            } else {
                "NSAppearanceNameAqua"
            };
            let appearance: id = msg_send![class!(NSAppearance), appearanceNamed: ns(name)];
            let _: () = msg_send![alert_window, setAppearance: appearance];
        }

        let fields: Vec<id> = match request.input {
            Input::None => Vec::new(),
            Input::Plain => vec![text_field(false, "", &request.default_value, 0.0)],
            Input::Secure => vec![text_field(true, "", &request.default_value, 0.0)],
            Input::Login => vec![
                text_field(false, "Login", &request.default_value, FIELD_HEIGHT + 8.0),
                text_field(true, "Password", "", 0.0),
            ],
        };
        if !fields.is_empty() {
            let height = FIELD_HEIGHT * fields.len() as f64 + 8.0 * (fields.len() - 1) as f64;
            let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(FIELD_WIDTH, height));
            let container: id = msg_send![class!(NSView), alloc];
            let container: id = msg_send![container, initWithFrame: frame];
            for field in &fields {
                let _: () = msg_send![container, addSubview: *field];
            }
            let _: () = msg_send![alert, setAccessoryView: container];
            let _: () = msg_send![alert, layout];
            let _: () = msg_send![alert_window, setInitialFirstResponder: fields[0]];
        }

        // A cancelable alert with no cancel button still has to close on Escape.
        let monitor: RefCell<id> = RefCell::new(nil);
        if request.cancelable && request.cancel.is_none() {
            let handler = ConcreteBlock::new(move |event: id| -> id {
                let code: u16 = msg_send![event, keyCode];
                if code == ESCAPE_KEY_CODE {
                    let _: () = msg_send![parent, endSheet: alert_window returnCode: 0isize];
                    return nil;
                }
                event
            })
            .copy();
            *monitor.borrow_mut() = msg_send![
                class!(NSEvent),
                addLocalMonitorForEventsMatchingMask: KEY_DOWN_MASK
                handler: &*handler
            ];
        }

        let monitor = std::rc::Rc::new(monitor);
        let done = RefCell::new(Some(done));
        let keys = request.buttons.len();
        let fields_for_result = fields.clone();
        let input = request.input;
        let completion = ConcreteBlock::new(move |code: isize| {
            CURRENT.with(|current| current.borrow_mut().take());
            let existing = *monitor.borrow();
            if existing != nil {
                let _: () = msg_send![class!(NSEvent), removeMonitor: existing];
            }
            let outcome = match code - FIRST_BUTTON_RETURN {
                position if (0..keys as isize).contains(&position) => Outcome::Button {
                    position: position as usize,
                    text: match input {
                        Input::None => String::new(),
                        Input::Plain | Input::Secure => string_of(fields_for_result[0]),
                        Input::Login => serde_json::json!({
                            "login": string_of(fields_for_result[0]),
                            "password": string_of(fields_for_result[1]),
                        })
                        .to_string(),
                    },
                },
                _ => Outcome::Dismissed,
            };
            if let Some(done) = done.borrow_mut().take() {
                done(outcome);
            }
        })
        .copy();
        CURRENT.with(|current| {
            *current.borrow_mut() = Some(Pending {
                alert,
                window: alert_window,
                buttons: request
                    .buttons
                    .iter()
                    .map(|(_, label)| label.clone())
                    .collect(),
                fields: fields.clone(),
            });
        });
        let _: () = msg_send![
            alert,
            beginSheetModalForWindow: parent
            completionHandler: &*completion
        ];
    }
}
