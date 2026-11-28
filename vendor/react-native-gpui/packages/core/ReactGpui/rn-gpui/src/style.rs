use crate::view_props::ViewProps;
use gpui::{
    point, px, rgba, BoxShadow, CursorStyle, Fill, Hsla, Overflow, SharedString, StyleRefinement,
};
use serde_json::Value;

/// RN colors are 0xAARRGGBB; GPUI's `rgba()` takes 0xRRGGBBAA.
pub fn color(argb: u32) -> Hsla {
    let alpha = argb >> 24;
    rgba((argb << 8) | alpha).into()
}

/// `ViewPropsFlat::cursor` is the ordinal of RN's `Cursor` enum; the arms
/// below are in that order.
pub(crate) fn cursor_style(ordinal: u8) -> Option<CursorStyle> {
    let style = match ordinal {
        0 => return None,                         // Auto
        1 => CursorStyle::DragLink,               // Alias
        2 => CursorStyle::Arrow,                  // AllScroll
        3 => CursorStyle::Arrow,                  // Cell
        4 => CursorStyle::ResizeColumn,           // ColResize
        5 => CursorStyle::ContextualMenu,         // ContextMenu
        6 => CursorStyle::DragCopy,               // Copy
        7 => CursorStyle::Crosshair,              // Crosshair
        8 => CursorStyle::Arrow,                  // Default
        9 => CursorStyle::ResizeRight,            // EResize
        10 => CursorStyle::ResizeLeftRight,       // EWResize
        11 => CursorStyle::OpenHand,              // Grab
        12 => CursorStyle::ClosedHand,            // Grabbing
        13 => CursorStyle::Arrow,                 // Help
        14 => CursorStyle::Arrow,                 // Move
        15 => CursorStyle::ResizeUpRightDownLeft, // NEResize
        16 => CursorStyle::ResizeUpRightDownLeft, // NESWResize
        17 => CursorStyle::ResizeUp,              // NResize
        18 => CursorStyle::ResizeUpDown,          // NSResize
        19 => CursorStyle::ResizeUpLeftDownRight, // NWResize
        20 => CursorStyle::ResizeUpLeftDownRight, // NWSEResize
        21 => CursorStyle::OperationNotAllowed,   // NoDrop
        22 => CursorStyle::Arrow,                 // None
        23 => CursorStyle::OperationNotAllowed,   // NotAllowed
        24 => CursorStyle::PointingHand,          // Pointer
        25 => CursorStyle::Arrow,                 // Progress
        26 => CursorStyle::ResizeRow,             // RowResize
        27 => CursorStyle::ResizeDown,            // SResize
        28 => CursorStyle::ResizeUpLeftDownRight, // SEResize
        29 => CursorStyle::ResizeUpRightDownLeft, // SWResize
        30 => CursorStyle::IBeam,                 // Text
        31 => CursorStyle::PointingHand,          // Url
        32 => CursorStyle::ResizeLeft,            // WResize
        33 => CursorStyle::Arrow,                 // Wait
        34 => CursorStyle::Arrow,                 // ZoomIn
        35 => CursorStyle::Arrow,                 // ZoomOut
        unknown => {
            log::warn!("[style] unknown cursor ordinal {unknown}; using the default");
            CursorStyle::Arrow
        }
    };
    Some(style)
}

pub fn to_refinement(v: &ViewProps) -> StyleRefinement {
    let mut s = StyleRefinement::default();
    if v.background_color != 0 {
        s.background = Some(Fill::from(color(v.background_color)));
    }
    // RN borders are painted as four independent edge rules by `node_view`.
    // GPUI border widths would add a second, default-colored edge on top.
    s.corner_radii.top_left = Some(px(v.border_radii.tl).into());
    s.corner_radii.top_right = Some(px(v.border_radii.tr).into());
    s.corner_radii.bottom_right = Some(px(v.border_radii.br).into());
    s.corner_radii.bottom_left = Some(px(v.border_radii.bl).into());
    if v.overflow_hidden {
        s.overflow.x = Some(Overflow::Hidden);
        s.overflow.y = Some(Overflow::Hidden);
        // React Native clips children to the rounded corners, not only the box.
        s.overflow_clips_corners = Some(true);
    }
    if let Some(cursor) = cursor_style(v.cursor) {
        log::debug!("[style] cursor ordinal {} -> {cursor:?}", v.cursor);
        s.mouse_cursor = Some(cursor);
    }
    if v.opacity < 1.0 {
        s.opacity = Some(v.opacity);
    }
    if !v.shadows.is_empty() {
        s.box_shadow = Some(
            v.shadows
                .iter()
                .map(|sh| BoxShadow {
                    color: color(sh.color),
                    offset: point(px(sh.dx), px(sh.dy)),
                    blur_radius: px(sh.blur / 2.0),
                    spread_radius: px(sh.spread),
                    inset: sh.inset,
                })
                .collect(),
        );
    }
    s
}

/// The properties a state style prop can change.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StateStyle {
    background_color: Option<u32>,
    opacity: Option<f32>,
    box_shadow: Option<Vec<ShadowSpec>>,
    /// Left, top, right, bottom: the order of `ViewPropsFlat::border_colors`.
    border_colors: [Option<u32>; 4],
    color: Option<u32>,
    transform: Option<[f32; 16]>,
    outline_color: Option<u32>,
    outline_width: Option<f32>,
    outline_offset: Option<f32>,
}

#[derive(Clone, Debug, Default, PartialEq)]
struct ShadowSpec {
    offset_x: f32,
    offset_y: f32,
    color: Option<u32>,
    blur_radius: f32,
    spread_distance: f32,
    inset: bool,
}

fn number(value: &Value, key: &str) -> Option<f32> {
    value.get(key)?.as_f64().map(|n| n as f32)
}

fn argb(value: &Value, key: &str) -> Option<u32> {
    u32::try_from(value.get(key)?.as_u64()?).ok()
}

impl ShadowSpec {
    fn from_json(value: &Value) -> Self {
        Self {
            offset_x: number(value, "offsetX").unwrap_or(0.0),
            offset_y: number(value, "offsetY").unwrap_or(0.0),
            color: argb(value, "color"),
            blur_radius: number(value, "blurRadius").unwrap_or(0.0),
            spread_distance: number(value, "spreadDistance").unwrap_or(0.0),
            inset: value.get("inset").and_then(Value::as_bool).unwrap_or(false),
        }
    }
}

/// The properties a running animation owns, which a state style leaves alone.
#[derive(Clone, Copy, Debug, Default)]
pub struct Animating {
    pub background: bool,
    pub opacity: bool,
}

impl StateStyle {
    pub(crate) fn from_json(value: &Value) -> Self {
        let all = argb(value, "borderColor");
        let side = |name: &str| argb(value, name).or(all);
        Self {
            background_color: argb(value, "backgroundColor"),
            opacity: number(value, "opacity"),
            box_shadow: value
                .get("boxShadow")
                .and_then(Value::as_array)
                .map(|shadows| shadows.iter().map(ShadowSpec::from_json).collect()),
            border_colors: [
                side("borderLeftColor"),
                side("borderTopColor"),
                side("borderRightColor"),
                side("borderBottomColor"),
            ],
            color: argb(value, "color"),
            outline_color: argb(value, "outlineColor"),
            outline_width: number(value, "outlineWidth"),
            outline_offset: number(value, "outlineOffset"),
            transform: value
                .get("transform")
                .and_then(Value::as_array)
                .and_then(|m| {
                    let matrix: Vec<f32> = m
                        .iter()
                        .filter_map(|n| n.as_f64())
                        .map(|n| n as f32)
                        .collect();
                    <[f32; 16]>::try_from(matrix).ok()
                }),
        }
    }

    /// Lays `other` over this style: what it sets wins.
    pub(crate) fn merge(&mut self, other: &StateStyle) {
        self.background_color = other.background_color.or(self.background_color);
        self.opacity = other.opacity.or(self.opacity);
        if other.box_shadow.is_some() {
            self.box_shadow.clone_from(&other.box_shadow);
        }
        for (mine, theirs) in self.border_colors.iter_mut().zip(other.border_colors) {
            *mine = theirs.or(*mine);
        }
        self.color = other.color.or(self.color);
        self.transform = other.transform.or(self.transform);
        self.outline_color = other.outline_color.or(self.outline_color);
        self.outline_width = other.outline_width.or(self.outline_width);
        self.outline_offset = other.outline_offset.or(self.outline_offset);
    }

    /// The border colors this style leaves to `base`, left, top, right, bottom.
    pub(crate) fn border_colors(&self, base: [u32; 4]) -> [u32; 4] {
        std::array::from_fn(|side| self.border_colors[side].unwrap_or(base[side]))
    }

    /// The outline color, width and offset, with what this style leaves to `base`.
    pub(crate) fn outline(&self, base: (u32, f32, f32)) -> (u32, f32, f32) {
        (
            self.outline_color.unwrap_or(base.0),
            self.outline_width.unwrap_or(base.1),
            self.outline_offset.unwrap_or(base.2),
        )
    }

    pub(crate) fn background(&self) -> Option<u32> {
        self.background_color
    }

    pub(crate) fn opacity(&self) -> Option<f32> {
        self.opacity
    }

    pub(crate) fn text_color(&self) -> Option<u32> {
        self.color
    }

    pub(crate) fn transform(&self) -> Option<[f32; 16]> {
        self.transform
    }

    /// The refinement gpui layers over the base style while the state holds.
    /// `scale` is the node's accumulated transform scale, applied to shadows the
    /// way the base style's are.
    pub fn refinement(&self, scale: (f32, f32), animating: Animating) -> StyleRefinement {
        let mut s = StyleRefinement::default();
        if let Some(argb) = self.background_color.filter(|_| !animating.background) {
            s.background = Some(Fill::from(color(argb)));
        }
        if let Some(opacity) = self.opacity.filter(|_| !animating.opacity) {
            s.opacity = Some(opacity.clamp(0.0, 1.0));
        }
        if let Some(shadows) = &self.box_shadow {
            let radius_scale = scale.0.min(scale.1);
            s.box_shadow = Some(
                shadows
                    .iter()
                    .map(|shadow| BoxShadow {
                        color: color(shadow.color.unwrap_or(0xFF00_0000)),
                        offset: point(px(shadow.offset_x * scale.0), px(shadow.offset_y * scale.1)),
                        blur_radius: px(shadow.blur_radius * radius_scale / 2.0),
                        spread_radius: px(shadow.spread_distance * radius_scale),
                        inset: shadow.inset,
                    })
                    .collect(),
            );
        }
        s
    }
}

/// A style that applies while a named ancestor group is hovered or pressed.
#[derive(Clone, Debug, PartialEq)]
pub struct GroupStateStyle {
    pub group: SharedString,
    pub style: StateStyle,
}

/// Everything a view declares through `group` and the `*Style` state props.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StateStyles {
    pub group: Option<SharedString>,
    pub hover: Option<StateStyle>,
    pub active: Option<StateStyle>,
    pub focus: Option<StateStyle>,
    pub focus_visible: Option<StateStyle>,
    pub drag_over: Option<StateStyle>,
    pub group_hover: Option<GroupStateStyle>,
    pub group_active: Option<GroupStateStyle>,
}

fn parse_json(prop: &str, json: &str) -> Option<Value> {
    if json.is_empty() {
        return None;
    }
    match serde_json::from_str(json) {
        Ok(parsed) => Some(parsed),
        Err(error) => {
            log::warn!("[style] ignoring invalid {prop}: {error}");
            None
        }
    }
}

fn parse_state(prop: &str, json: &str) -> Option<StateStyle> {
    parse_json(prop, json).map(|value| StateStyle::from_json(&value))
}

fn parse_group(prop: &str, json: &str) -> Option<GroupStateStyle> {
    let value = parse_json(prop, json)?;
    let group = value
        .get("group")?
        .as_str()
        .filter(|group| !group.is_empty())?;
    Some(GroupStateStyle {
        group: group.to_owned().into(),
        style: StateStyle::from_json(value.get("style")?),
    })
}

impl StateStyles {
    /// Whether any state sets the text color.
    pub fn sets_color(&self) -> bool {
        [
            self.focus.as_ref(),
            self.focus_visible.as_ref(),
            self.drag_over.as_ref(),
            self.hover.as_ref(),
            self.active.as_ref(),
            self.group_hover.as_ref().map(|grouped| &grouped.style),
            self.group_active.as_ref().map(|grouped| &grouped.style),
        ]
        .into_iter()
        .flatten()
        .any(|style| style.text_color().is_some())
    }

    /// `None` when the view declares nothing, which is the case for almost every view.
    pub fn from_flat(v: &ViewProps) -> Option<std::rc::Rc<Self>> {
        let styles = Self {
            group: (!v.group.is_empty()).then(|| v.group.clone().into()),
            hover: parse_state("hoverStyle", &v.hover_style),
            active: parse_state("activeStyle", &v.active_style),
            focus: parse_state("focusStyle", &v.focus_style),
            focus_visible: parse_state("focusVisibleStyle", &v.focus_visible_style),
            drag_over: parse_state("dragOverStyle", &v.drag_over_style),
            group_hover: parse_group("groupHoverStyle", &v.group_hover_style),
            group_active: parse_group("groupActiveStyle", &v.group_active_style),
        };
        (styles != Self::default()).then(|| std::rc::Rc::new(styles))
    }
}

#[cfg(test)]
mod state_style_tests {
    use super::*;
    use serde_json::json;

    fn state(value: Value) -> StateStyle {
        StateStyle::from_json(&value)
    }

    #[test]
    fn a_side_color_overrides_border_color() {
        let style = state(json!({"borderColor": 1, "borderBottomColor": 2}));
        assert_eq!(style.border_colors([9; 4]), [1, 1, 1, 2]);
    }

    #[test]
    fn a_style_without_border_colors_keeps_the_base() {
        assert_eq!(state(json!({})).border_colors([7, 8, 9, 10]), [7, 8, 9, 10]);
    }

    #[test]
    fn a_later_layer_wins_only_the_properties_it_sets() {
        let mut base = state(json!({"backgroundColor": 1, "opacity": 0.5, "color": 3}));
        base.merge(&state(json!({"backgroundColor": 2})));
        assert_eq!(base.background_color, Some(2));
        assert_eq!(base.opacity, Some(0.5));
        assert_eq!(base.text_color(), Some(3));
    }

    #[test]
    fn an_outline_overrides_only_what_it_sets() {
        let style = state(json!({"outlineColor": 5, "outlineWidth": 2.0}));
        assert_eq!(style.outline((1, 9.0, 3.0)), (5, 2.0, 3.0));
    }

    #[test]
    fn a_transform_needs_all_sixteen_numbers() {
        assert!(state(json!({"transform": [1, 0]})).transform().is_none());
        let matrix: Vec<f64> = (0..16).map(f64::from).collect();
        assert_eq!(
            state(json!({"transform": matrix})).transform().unwrap()[5],
            5.0
        );
    }

    #[test]
    fn an_animated_property_is_left_out_of_the_refinement() {
        let style = state(json!({"backgroundColor": 4278190080u32, "opacity": 0.2}));
        let animating = Animating {
            background: true,
            opacity: false,
        };
        let refinement = style.refinement((1.0, 1.0), animating);
        assert!(refinement.background.is_none());
        assert_eq!(refinement.opacity, Some(0.2));
    }

    #[test]
    fn a_view_with_no_state_props_has_no_state_styles() {
        assert!(StateStyles::from_flat(&ViewProps::default()).is_none());
    }

    #[test]
    fn a_group_style_needs_a_group_name() {
        let mut view = ViewProps::default();
        view.group_hover_style = r#"{"group":"","style":{"opacity":1}}"#.to_string();
        assert!(StateStyles::from_flat(&view).is_none());
        view.group_hover_style = r#"{"group":"row","style":{"opacity":1}}"#.to_string();
        let styles = StateStyles::from_flat(&view).unwrap();
        assert_eq!(styles.group_hover.as_ref().unwrap().group.as_ref(), "row");
    }

    #[test]
    fn invalid_json_is_ignored() {
        let mut view = ViewProps::default();
        view.hover_style = "{".to_string();
        assert!(StateStyles::from_flat(&view).is_none());
    }

    #[test]
    fn any_state_can_set_the_text_color() {
        let mut view = ViewProps::default();
        view.active_style = r#"{"color":4294901760}"#.to_string();
        assert!(StateStyles::from_flat(&view).unwrap().sets_color());
    }
}
