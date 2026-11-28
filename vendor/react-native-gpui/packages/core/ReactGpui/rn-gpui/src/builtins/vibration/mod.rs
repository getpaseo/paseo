//! `Vibration`: a haptic tap on a macOS trackpad, nothing elsewhere.

use rn_gpui_module::ModuleThread;

use crate::builtins::rn_gpui_specs::{NativeVibrationEvents, NativeVibrationSpec};

struct VibrationModule;

#[cfg(target_os = "macos")]
fn tap() {
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};
    // SAFETY: `defaultPerformer` returns the shared haptic performer; the
    // generic pattern (0) is played immediately (performance time 1).
    unsafe {
        let performer: *mut Object = msg_send![class!(NSHapticFeedbackManager), defaultPerformer];
        if !performer.is_null() {
            let _: () =
                msg_send![performer, performFeedbackPattern: 0isize performanceTime: 1usize];
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn tap() {}

impl NativeVibrationSpec for VibrationModule {
    const THREAD: ModuleThread = ModuleThread::Main;

    fn new(_events: NativeVibrationEvents) -> Self {
        Self
    }

    fn vibrate(&self, _pattern: f64) {
        tap();
    }

    fn cancel(&self) {}
}

pub fn register() {
    rn_gpui_module::register(crate::builtins::rn_gpui_specs::native_vibration_module::<
        VibrationModule,
    >());
}
