//! The animation modes a stack accepts, and the poses each one corresponds to.
//!
//! Core owns the timing and the paint; this file is the module's own statement
//! of what "slide from the right" and "fade" mean as movement between two
//! poses, so core never learns a navigation name.
use react_native_gpui::extensions::{Pose, Transition};
use std::time::Duration;

/// A stack animation, as `stackAnimation` names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransitionMode {
    Fade,
    SlideFromRight,
    SlideFromLeft,
}

impl TransitionMode {
    /// The mode the reverse of this one uses, so a pop plays the entry mirrored.
    #[must_use]
    pub fn reverse(self) -> Self {
        match self {
            Self::SlideFromRight => Self::SlideFromLeft,
            Self::SlideFromLeft => Self::SlideFromRight,
            Self::Fade => Self::Fade,
        }
    }

    /// How long this mode runs.
    pub fn duration(self) -> Duration {
        match self {
            Self::Fade => Duration::from_millis(150),
            _ => Duration::from_millis(240),
        }
    }
}

/// The mode a `stackAnimation` string asks for. Unknown values fade, which is
/// what the platform's own default is.
pub fn transition_mode(animation: &str) -> Option<TransitionMode> {
    match animation {
        "none" => None,
        "slide_from_right" | "simple_push" => Some(TransitionMode::SlideFromRight),
        "slide_from_left" => Some(TransitionMode::SlideFromLeft),
        "default" | "" | "fade" => Some(TransitionMode::Fade),
        _ => Some(TransitionMode::Fade),
    }
}

/// Whether entering or leaving.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Enter,
    Exit,
}

/// The poses a mode and role correspond to.
///
/// Entering slides from off-screen to rest; leaving slides from rest to
/// off-screen; a fade keeps the node still while its opacity moves. The offset
/// is a fraction of the node's own width, so `distance` is how far it travels.
pub fn poses(mode: TransitionMode, role: Role, distance: f32) -> (Pose, Pose) {
    let rest = Pose {
        offset_x: 0.0,
        opacity: 1.0,
    };
    let transparent = Pose {
        offset_x: 0.0,
        opacity: 0.0,
    };
    let off_screen = |sign: f32| Pose {
        offset_x: sign * distance,
        opacity: 1.0,
    };
    match (mode, role) {
        (TransitionMode::Fade, Role::Enter) => (transparent, rest),
        (TransitionMode::Fade, Role::Exit) => (rest, transparent),
        (TransitionMode::SlideFromRight, Role::Enter) => (off_screen(1.0), rest),
        (TransitionMode::SlideFromLeft, Role::Enter) => (off_screen(-1.0), rest),
        (TransitionMode::SlideFromRight, Role::Exit) => (rest, off_screen(-1.0)),
        (TransitionMode::SlideFromLeft, Role::Exit) => (rest, off_screen(1.0)),
    }
}

/// The transition a mode and role describe.
pub fn transition(mode: TransitionMode, role: Role, distance: f32) -> Transition {
    let (from, to) = poses(mode, role, distance);
    Transition {
        from,
        to,
        duration: mode.duration(),
    }
}

/// The card underneath a push parallaxes a short way rather than leaving.
pub const PARALLAX_DISTANCE: f32 = 0.12;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_supported_animations_and_falls_back_to_fade() {
        assert_eq!(transition_mode("none"), None);
        assert_eq!(transition_mode("fade"), Some(TransitionMode::Fade));
        assert_eq!(transition_mode("default"), Some(TransitionMode::Fade));
        assert_eq!(transition_mode(""), Some(TransitionMode::Fade));
        assert_eq!(
            transition_mode("slide_from_right"),
            Some(TransitionMode::SlideFromRight)
        );
        assert_eq!(
            transition_mode("simple_push"),
            Some(TransitionMode::SlideFromRight)
        );
        assert_eq!(
            transition_mode("slide_from_left"),
            Some(TransitionMode::SlideFromLeft)
        );
        assert_eq!(transition_mode("unsupported"), Some(TransitionMode::Fade));
    }

    #[test]
    fn reversing_a_slide_swaps_its_direction() {
        assert_eq!(
            TransitionMode::SlideFromRight.reverse(),
            TransitionMode::SlideFromLeft
        );
        assert_eq!(
            TransitionMode::SlideFromLeft.reverse(),
            TransitionMode::SlideFromRight
        );
        assert_eq!(TransitionMode::Fade.reverse(), TransitionMode::Fade);
    }

    #[test]
    fn the_poses_reproduce_the_original_slide_and_fade_curves() {
        for (mode, role, distance, expected) in [
            (
                TransitionMode::SlideFromRight,
                Role::Enter,
                1.0,
                [1.0, 0.5, 0.0],
            ),
            (
                TransitionMode::SlideFromLeft,
                Role::Enter,
                1.0,
                [-1.0, -0.5, 0.0],
            ),
            (
                TransitionMode::SlideFromRight,
                Role::Exit,
                1.0,
                [0.0, -0.5, -1.0],
            ),
            (
                TransitionMode::SlideFromLeft,
                Role::Exit,
                1.0,
                [0.0, 0.5, 1.0],
            ),
            (
                TransitionMode::SlideFromRight,
                Role::Exit,
                PARALLAX_DISTANCE,
                [0.0, -0.06, -0.12],
            ),
        ] {
            let transition = transition(mode, role, distance);
            for (progress, expected_offset) in
                [(0.0, expected[0]), (0.5, expected[1]), (1.0, expected[2])]
            {
                let pose = transition.pose_at(progress);
                assert!(
                    (pose.offset_x - expected_offset).abs() < 0.001,
                    "{mode:?} {role:?} at {progress}: {} != {expected_offset}",
                    pose.offset_x
                );
            }
        }
    }

    #[test]
    fn a_fade_moves_opacity_and_nothing_else() {
        let transition = transition(TransitionMode::Fade, Role::Enter, 1.0);
        for (progress, expected) in [(0.0, 0.0), (0.5, 0.5), (1.0, 1.0)] {
            let pose = transition.pose_at(progress);
            assert!((pose.opacity - expected).abs() < 0.001);
            assert!(pose.offset_x.abs() < 0.001);
        }
        assert_eq!(transition.duration, Duration::from_millis(150));
    }
}
