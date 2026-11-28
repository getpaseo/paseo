//! The momentum of a touchpad flick where the system sends none: how fast the
//! scroll was going when the fingers lifted, and how it slows after.
//!
//! macOS delivers the momentum as wheel events of its own. Windows and Linux
//! deliver the finger movement and then stop, so the scroll view carries on.

use serde_json::Value;
use std::time::{Duration, Instant};

/// React Native's `decelerationRate` for `normal` and `fast`.
const NORMAL: f32 = 0.998;
const FAST: f32 = 0.99;

/// The wheel samples this far back make up the speed of the flick.
const WINDOW: Duration = Duration::from_millis(100);
/// Fewer samples, or samples closer together than this, are not a flick.
const MIN_SAMPLES: usize = 3;
const MIN_SPAN: Duration = Duration::from_millis(24);
/// Slower than this, in points per millisecond, there is no momentum.
const MIN_SPEED: f32 = 0.3;
/// Where the flick has slowed enough to stop.
const STOP_SPEED: f32 = 0.02;

/// The deceleration a `decelerationRate` prop asks for: a number, or `normal`
/// or `fast`. It is the fraction of its speed the scroll keeps each
/// millisecond, kept within what is a deceleration at all.
pub(crate) fn deceleration_from(props: &Value) -> f32 {
    let rate = match props.get("decelerationRate") {
        Some(Value::Number(number)) => number.as_f64().map_or(NORMAL, |rate| rate as f32),
        Some(Value::String(name)) if name == "fast" => FAST,
        _ => NORMAL,
    };
    rate.clamp(0.9, 0.9999)
}

/// Adds a wheel delta to the samples of the flick in progress. A delta that
/// reverses the direction starts a new flick, so scrolling back after a long
/// scroll is not carried on in the direction it came from.
pub(crate) fn push_sample(samples: &mut Vec<(Instant, f32)>, at: Instant, delta: f32) {
    if samples
        .last()
        .is_some_and(|(_, last)| last.signum() != delta.signum())
    {
        samples.clear();
    }
    samples.push((at, delta));
    if samples.len() > 32 {
        samples.remove(0);
    }
}

/// The speed at the end of `samples`, in points per millisecond with the sign
/// of the deltas, or `None` when it was not a flick.
pub(crate) fn flick_speed(samples: &[(Instant, f32)]) -> Option<f32> {
    let last = samples.last()?.0;
    let recent: Vec<&(Instant, f32)> = samples
        .iter()
        .filter(|(at, _)| last.duration_since(*at) <= WINDOW)
        .collect();
    let first = recent.first()?.0;
    let span = last.duration_since(first);
    if recent.len() < MIN_SAMPLES || span < MIN_SPAN {
        return None;
    }
    // The first sample only marks when the movement began.
    let moved: f32 = recent.iter().skip(1).map(|(_, delta)| delta).sum();
    let speed = moved / span.as_secs_f32() / 1000.0;
    (speed.abs() >= MIN_SPEED).then_some(speed)
}

/// One step of `elapsed_ms`: how far the scroll goes, and its speed after.
pub(crate) fn step(speed: f32, rate: f32, elapsed_ms: f32) -> (f32, f32) {
    let next = speed * rate.powf(elapsed_ms);
    // The distance of a speed that decays exponentially over the step.
    let distance = if (1.0 - rate).abs() < f32::EPSILON {
        speed * elapsed_ms
    } else {
        (speed - next) / -rate.ln()
    };
    (distance, next)
}

/// Whether a speed is too slow to go on.
pub(crate) fn stopped(speed: f32) -> bool {
    speed.abs() < STOP_SPEED
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn at(start: Instant, ms: u64) -> Instant {
        start + Duration::from_millis(ms)
    }

    #[test]
    fn the_prop_is_a_number_or_a_name() {
        assert_eq!(deceleration_from(&json!({})), NORMAL);
        assert_eq!(
            deceleration_from(&json!({"decelerationRate": "fast"})),
            FAST
        );
        assert_eq!(deceleration_from(&json!({"decelerationRate": 0.95})), 0.95);
        assert_eq!(deceleration_from(&json!({"decelerationRate": 5.0})), 0.9999);
    }

    #[test]
    fn a_reversal_starts_a_new_flick() {
        let start = Instant::now();
        let mut samples = Vec::new();
        for i in 0..4 {
            push_sample(&mut samples, at(start, i * 8), -500.0);
        }
        push_sample(&mut samples, at(start, 40), 30.0);
        assert_eq!(samples.len(), 1);
        assert_eq!(flick_speed(&samples), None);
        for i in 0..40 {
            push_sample(&mut samples, at(start, 48 + i), 30.0);
        }
        assert_eq!(samples.len(), 32);
    }

    #[test]
    fn a_steady_run_of_deltas_is_a_flick_at_its_speed() {
        let start = Instant::now();
        // 12 points every 8 ms: 1.5 points per millisecond.
        let samples: Vec<_> = (0..6).map(|i| (at(start, i * 8), 12.0)).collect();
        let speed = flick_speed(&samples).unwrap();
        assert!((speed - 1.5).abs() < 0.01, "{speed}");
    }

    #[test]
    fn a_leftward_flick_has_a_negative_speed() {
        let start = Instant::now();
        let samples: Vec<_> = (0..6).map(|i| (at(start, i * 8), -12.0)).collect();
        assert!(flick_speed(&samples).unwrap() < 0.0);
    }

    #[test]
    fn a_few_events_at_once_are_not_a_flick() {
        let start = Instant::now();
        let samples: Vec<_> = (0..40).map(|_| (start, 100.0)).collect();
        assert_eq!(flick_speed(&samples), None);
        assert_eq!(flick_speed(&[(start, 100.0), (at(start, 30), 100.0)]), None);
    }

    #[test]
    fn a_slow_drag_is_not_a_flick() {
        let start = Instant::now();
        let samples: Vec<_> = (0..6).map(|i| (at(start, i * 8), 0.4)).collect();
        assert_eq!(flick_speed(&samples), None);
    }

    #[test]
    fn only_the_last_hundred_milliseconds_count() {
        let start = Instant::now();
        let mut samples: Vec<_> = (0..4).map(|i| (at(start, i * 8), 40.0)).collect();
        samples.extend((0..6).map(|i| (at(start, 500 + i * 8), 8.0)));
        let speed = flick_speed(&samples).unwrap();
        assert!((speed - 1.0).abs() < 0.01, "{speed}");
    }

    #[test]
    fn the_speed_decays_and_the_distance_adds_up() {
        let (mut speed, mut travelled) = (2.0f32, 0.0f32);
        for _ in 0..100 {
            let (distance, next) = step(speed, NORMAL, 16.0);
            assert!(next < speed && distance > 0.0);
            travelled += distance;
            speed = next;
        }
        // The whole run is speed / -ln(rate) however it is cut up.
        let total = 2.0 / -NORMAL.ln();
        assert!(
            travelled < total && travelled > total * 0.6,
            "{travelled} of {total}"
        );
    }

    #[test]
    fn fast_stops_sooner_than_normal() {
        let travelled = |rate: f32| {
            let (mut speed, mut sum) = (2.0f32, 0.0f32);
            while !stopped(speed) {
                let (distance, next) = step(speed, rate, 16.0);
                sum += distance;
                speed = next;
            }
            sum
        };
        assert!(travelled(FAST) < travelled(NORMAL) / 2.0);
    }
}
