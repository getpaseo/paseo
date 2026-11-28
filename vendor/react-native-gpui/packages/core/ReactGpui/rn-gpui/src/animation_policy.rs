//! Test-only override for platform-owned transitions.
//!
//! This does not change the operating system's reduce-motion preference and
//! does not suppress React Native's frame callbacks (which animated values
//! need in order to reach their final state).

#[cfg(feature = "test-driver")]
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(feature = "test-driver")]
static DISABLED: AtomicBool = AtomicBool::new(false);

/// Whether the test driver turned platform transitions off. A component library
/// with transitions of its own follows it, as it follows the system's reduce-motion
/// setting, so a test sees the end state at once.
pub fn animations_disabled() -> bool {
    #[cfg(feature = "test-driver")]
    {
        return DISABLED.load(Ordering::Relaxed);
    }

    #[cfg(not(feature = "test-driver"))]
    false
}

#[cfg(feature = "test-driver")]
pub(crate) fn set_animations_disabled(disabled: bool) {
    DISABLED.store(disabled, Ordering::Relaxed);
}

#[cfg(all(test, feature = "test-driver"))]
mod tests {
    use super::{animations_disabled, set_animations_disabled};

    #[test]
    fn test_driver_can_toggle_animations_without_changing_reduce_motion() {
        set_animations_disabled(false);
        assert!(!animations_disabled());
        set_animations_disabled(true);
        assert!(animations_disabled());
        set_animations_disabled(false);
        assert!(!animations_disabled());
    }
}
