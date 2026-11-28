//! A window's zoom factor: how much its content is scaled up or down.
//!
//! The surface is laid out at the window's size divided by the factor, with the
//! factor folded into the scale React sees, and drawn under a matrix that scales
//! it back up. Pointer positions are divided by the factor on their way in.

use std::cell::RefCell;
use std::collections::HashMap;

pub const MIN: f32 = 0.25;
pub const MAX: f32 = 5.0;

thread_local! {
    static FACTORS: RefCell<HashMap<i32, f32>> = RefCell::new(HashMap::new());
}

/// The factor of the window a surface is shown in, `1.0` when never set.
pub fn get(surface_id: i32) -> f32 {
    FACTORS.with_borrow(|factors| factors.get(&surface_id).copied().unwrap_or(1.0))
}

/// Records a factor, clamped to the supported range, and returns it.
pub fn set(surface_id: i32, factor: f32) -> f32 {
    let factor = if factor.is_finite() {
        factor.clamp(MIN, MAX)
    } else {
        1.0
    };
    FACTORS.with_borrow_mut(|factors| {
        if (factor - 1.0).abs() < f32::EPSILON {
            factors.remove(&surface_id);
        } else {
            factors.insert(surface_id, factor);
        }
    });
    factor
}

pub fn forget(surface_id: i32) {
    FACTORS.with_borrow_mut(|factors| {
        factors.remove(&surface_id);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_factor_is_clamped_and_one_is_forgotten() {
        assert_eq!(set(9101, 100.0), MAX);
        assert_eq!(get(9101), MAX);
        assert_eq!(set(9101, 0.0), MIN);
        assert_eq!(set(9101, f32::NAN), 1.0);
        assert_eq!(get(9101), 1.0);
        forget(9101);
    }
}
