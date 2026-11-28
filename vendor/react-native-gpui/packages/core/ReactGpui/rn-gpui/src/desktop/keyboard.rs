//! The on-screen keyboard as `Keyboard` events: Windows reports the area the
//! touch keyboard covers through `InputPane`. Other desktop platforms have no
//! on-screen keyboard and emit nothing.

use serde_json::json;

/// A rectangle in DIPs, relative to the window's client area.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Occluded {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

/// The `DeviceEventEmitter` events React Native's `Keyboard` listens for, with
/// their JSON payloads, in the order they are sent.
pub fn keyboard_events(shown: bool, occluded: Occluded) -> Vec<(&'static str, String)> {
    let rect = if shown {
        occluded
    } else {
        Occluded {
            height: 0.0,
            width: occluded.width,
            ..occluded
        }
    };
    let coordinates = json!({
        "screenX": rect.x,
        "screenY": rect.y,
        "width": rect.width,
        "height": rect.height,
    });
    let payload = json!({
        "duration": 0,
        "easing": "keyboard",
        "startCoordinates": coordinates,
        "endCoordinates": coordinates,
        "isEventFromThisApp": true,
    })
    .to_string();
    let names: [&'static str; 4] = if shown {
        [
            "keyboardWillChangeFrame",
            "keyboardWillShow",
            "keyboardDidChangeFrame",
            "keyboardDidShow",
        ]
    } else {
        [
            "keyboardWillChangeFrame",
            "keyboardWillHide",
            "keyboardDidChangeFrame",
            "keyboardDidHide",
        ]
    };
    names
        .into_iter()
        .map(|name| (name, payload.clone()))
        .collect()
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{keyboard_events, Occluded};
    use crate::host::Host;
    use windows::{
        core::{factory, Ref},
        Foundation::TypedEventHandler,
        Win32::{Foundation::HWND, System::WinRT::IInputPaneInterop},
        UI::ViewManagement::{InputPane, InputPaneVisibilityEventArgs},
    };

    thread_local! {
        static PANES: std::cell::RefCell<Vec<InputPane>> = const { std::cell::RefCell::new(Vec::new()) };
    }

    /// Subscribes to the window's input pane. The pane stays registered for the
    /// life of the thread, which is the life of the window's UI.
    pub fn watch(hwnd: isize, host: Host) {
        if let Err(error) = subscribe(hwnd, host) {
            log::warn!("input pane unavailable: {error}");
        }
    }

    fn subscribe(hwnd: isize, host: Host) -> windows::core::Result<()> {
        let interop = factory::<InputPane, IInputPaneInterop>()?;
        // SAFETY: `hwnd` is the live handle of a window owned by this thread.
        let pane: InputPane = unsafe { interop.GetForWindow(HWND(hwnd as _))? };
        for shown in [true, false] {
            let host = host.clone();
            let handler = TypedEventHandler::new(
                move |_: Ref<'_, InputPane>, args: Ref<'_, InputPaneVisibilityEventArgs>| {
                    let Some(args) = args.as_ref() else {
                        return Ok(());
                    };
                    let rect = args.OccludedRect()?;
                    let occluded = Occluded {
                        x: rect.X,
                        y: rect.Y,
                        width: rect.Width,
                        height: rect.Height,
                    };
                    for (name, payload) in keyboard_events(shown, occluded) {
                        host.emit_device_event_json(name, &payload);
                    }
                    Ok(())
                },
            );
            if shown {
                pane.Showing(&handler)?;
            } else {
                pane.Hiding(&handler)?;
            }
        }
        PANES.with(|panes| panes.borrow_mut().push(pane));
        Ok(())
    }
}

/// Starts reporting the on-screen keyboard of `window`.
#[cfg(target_os = "windows")]
pub fn watch(window: &gpui::Window, host: crate::host::Host) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    let Ok(handle) = HasWindowHandle::window_handle(window) else {
        return;
    };
    if let RawWindowHandle::Win32(win32) = handle.as_raw() {
        platform::watch(win32.hwnd.get(), host);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RECT: Occluded = Occluded {
        x: 0.0,
        y: 420.0,
        width: 800.0,
        height: 180.0,
    };

    fn names(events: &[(&'static str, String)]) -> Vec<&'static str> {
        events.iter().map(|(name, _)| *name).collect()
    }

    #[test]
    fn showing_sends_the_show_sequence() {
        let events = keyboard_events(true, RECT);
        assert_eq!(
            names(&events),
            [
                "keyboardWillChangeFrame",
                "keyboardWillShow",
                "keyboardDidChangeFrame",
                "keyboardDidShow"
            ]
        );
    }

    #[test]
    fn hiding_sends_the_hide_sequence() {
        let events = keyboard_events(false, RECT);
        assert_eq!(
            names(&events),
            [
                "keyboardWillChangeFrame",
                "keyboardWillHide",
                "keyboardDidChangeFrame",
                "keyboardDidHide"
            ]
        );
    }

    #[test]
    fn shown_end_coordinates_are_the_occluded_rect() {
        let (_, payload) = &keyboard_events(true, RECT)[1];
        let value: serde_json::Value = serde_json::from_str(payload).unwrap();
        let end = &value["endCoordinates"];
        assert_eq!(end["screenX"], 0.0);
        assert_eq!(end["screenY"], 420.0);
        assert_eq!(end["width"], 800.0);
        assert_eq!(end["height"], 180.0);
        assert_eq!(value["isEventFromThisApp"], true);
    }

    #[test]
    fn hidden_end_coordinates_have_no_height() {
        let (_, payload) = &keyboard_events(false, RECT)[1];
        let value: serde_json::Value = serde_json::from_str(payload).unwrap();
        assert_eq!(value["endCoordinates"]["height"], 0.0);
        assert_eq!(value["endCoordinates"]["screenY"], 420.0);
    }
}
