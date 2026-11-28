//! Where a scroll view comes to rest when it snaps: `pagingEnabled`,
//! `snapToInterval`, `snapToOffsets`, `snapToStart` and `snapToEnd`.

use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum SnapAlignment {
    Start,
    Center,
    End,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SnapSpec {
    pub paging: bool,
    pub interval: f32,
    pub offsets: Vec<f32>,
    pub start: bool,
    pub end: bool,
    pub alignment: SnapAlignment,
    pub disable_interval_momentum: bool,
}

impl SnapSpec {
    /// The snapping the props ask for, or `None` when none is configured.
    pub fn from_props(props: &Value) -> Option<Self> {
        let flag =
            |key: &str, default: bool| props.get(key).and_then(Value::as_bool).unwrap_or(default);
        let paging = flag("pagingEnabled", false);
        let interval = props
            .get("snapToInterval")
            .and_then(Value::as_f64)
            .unwrap_or(0.0) as f32;
        let offsets: Vec<f32> = props
            .get("snapToOffsets")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(|value| value.as_f64().map(|offset| offset as f32))
                    .collect()
            })
            .unwrap_or_default();
        if !paging && interval <= 0.0 && offsets.is_empty() {
            return None;
        }
        let alignment = match props.get("snapToAlignment").and_then(Value::as_str) {
            Some("center") => SnapAlignment::Center,
            Some("end") => SnapAlignment::End,
            _ => SnapAlignment::Start,
        };
        Some(Self {
            paging,
            interval,
            offsets,
            start: flag("snapToStart", true),
            end: flag("snapToEnd", true),
            alignment,
            disable_interval_momentum: flag("disableIntervalMomentum", false),
        })
    }

    /// The offsets a scroll can come to rest at, along one axis.
    fn stops(&self, viewport: f32, content: f32) -> Vec<f32> {
        let max = (content - viewport).max(0.0);
        let align = |offset: f32, size: f32| match self.alignment {
            SnapAlignment::Start => offset,
            SnapAlignment::Center => offset - (viewport - size) / 2.0,
            SnapAlignment::End => offset - (viewport - size),
        };
        let mut stops = Vec::new();
        if self.paging && viewport > 0.0 {
            let mut offset = 0.0;
            while offset < max + 0.5 {
                stops.push(offset);
                offset += viewport;
            }
        } else if self.interval > 0.0 {
            let mut offset = 0.0;
            while offset < content + 0.5 {
                stops.push(align(offset, self.interval));
                offset += self.interval;
            }
        }
        stops.extend(self.offsets.iter().map(|offset| align(*offset, 0.0)));
        if self.start {
            stops.push(0.0);
        }
        if self.end {
            stops.push(max);
        }
        stops
            .iter_mut()
            .for_each(|stop| *stop = stop.clamp(0.0, max));
        stops.sort_by(f32::total_cmp);
        stops.dedup_by(|a, b| (*a - *b).abs() < 0.5);
        stops
    }

    /// The stop nearest `offset`. With `disableIntervalMomentum` a scroll that
    /// began at `drag_start` rests no further than one interval from it.
    pub fn target(&self, offset: f32, drag_start: Option<f32>, viewport: f32, content: f32) -> f32 {
        let reach = if self.paging { viewport } else { self.interval };
        let mut stops = self.stops(viewport, content);
        if let (true, Some(start)) = (self.disable_interval_momentum, drag_start) {
            if reach > 0.0 {
                let bounded: Vec<f32> = stops
                    .iter()
                    .copied()
                    .filter(|stop| (stop - start).abs() <= reach + 0.5)
                    .collect();
                if !bounded.is_empty() {
                    stops = bounded;
                }
            }
        }
        stops
            .into_iter()
            .min_by(|a, b| (a - offset).abs().total_cmp(&(b - offset).abs()))
            .unwrap_or(offset)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn nothing_is_configured_without_a_snapping_prop() {
        assert_eq!(SnapSpec::from_props(&json!({"horizontal": true})), None);
    }

    #[test]
    fn paging_rests_on_a_multiple_of_the_viewport() {
        let spec = SnapSpec::from_props(&json!({"pagingEnabled": true})).unwrap();
        assert_eq!(spec.target(130.0, None, 100.0, 500.0), 100.0);
        assert_eq!(spec.target(160.0, None, 100.0, 500.0), 200.0);
        assert_eq!(spec.target(999.0, None, 100.0, 500.0), 400.0);
    }

    #[test]
    fn an_interval_can_align_to_the_centre() {
        let spec = SnapSpec::from_props(&json!({
            "snapToInterval": 100.0,
            "snapToAlignment": "center",
            "snapToStart": false,
            "snapToEnd": false
        }))
        .unwrap();
        // Items of 100 in a 300 viewport: the centre of item 3 is offset 200.
        assert_eq!(spec.target(190.0, None, 300.0, 1000.0), 200.0);
    }

    #[test]
    fn offsets_and_the_ends_are_stops() {
        let spec = SnapSpec::from_props(&json!({"snapToOffsets": [150.0, 420.0]})).unwrap();
        assert_eq!(spec.target(140.0, None, 100.0, 500.0), 150.0);
        assert_eq!(spec.target(10.0, None, 100.0, 500.0), 0.0);
        assert_eq!(spec.target(395.0, None, 100.0, 500.0), 400.0);
        let spec = SnapSpec::from_props(&json!({
            "snapToOffsets": [150.0],
            "snapToStart": false
        }))
        .unwrap();
        assert_eq!(spec.target(10.0, None, 100.0, 500.0), 150.0);
    }

    #[test]
    fn disabled_interval_momentum_stays_within_one_interval() {
        let spec = SnapSpec::from_props(&json!({
            "snapToInterval": 100.0,
            "disableIntervalMomentum": true
        }))
        .unwrap();
        assert_eq!(spec.target(460.0, Some(100.0), 100.0, 1000.0), 200.0);
        assert_eq!(spec.target(460.0, None, 100.0, 1000.0), 500.0);
    }
}
