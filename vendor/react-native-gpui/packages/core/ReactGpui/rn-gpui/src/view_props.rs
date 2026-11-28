//! A node's view props, with the rarely set ones out of line.
//!
//! `ViewPropsFlat` holds two dozen strings and lists, a matrix, and the scalar
//! props. Most nodes set none of the strings and lists, so they live in a
//! [`ViewExtras`] allocated only for a node that sets one; every other node
//! reads them from one shared empty set. Fields are read as they are on
//! `ViewPropsFlat`, through `Deref`.

use rn_gpui_sys::ffi::{AccessibilityActionFlat, CornersF, EdgesF, ShadowF, ViewPropsFlat};

const IDENTITY: [f32; 16] = [
    1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
];

/// The scalar view props, and the rest behind [`ViewProps::extras`].
#[derive(Clone, Debug)]
pub struct ViewProps {
    pub opacity: f32,
    pub background_color: u32,
    pub border_widths: EdgesF,
    pub content_insets: EdgesF,
    pub border_colors: [u32; 4],
    pub border_styles: [u8; 4],
    pub border_radii: CornersF,
    pub outline_color: u32,
    pub outline_width: f32,
    pub outline_offset: f32,
    pub outline_style: u8,
    pub overflow_hidden: bool,
    pub display_none: bool,
    pub pointer_events: u8,
    pub cursor: u8,
    pub mix_blend_mode: u8,
    pub isolate: bool,
    pub hit_slop: [f32; 4],
    pub has_transform: bool,
    pub backface_hidden: bool,
    pub transform_origin_set: bool,
    pub accessibility_traits: u32,
    pub accessibility_value_min: i32,
    pub accessibility_value_max: i32,
    pub accessibility_value_now: i32,
    pub accessibility_has_value_min: bool,
    pub accessibility_has_value_max: bool,
    pub accessibility_has_value_now: bool,
    pub accessible: bool,
    pub accessibility_disabled: bool,
    pub accessibility_selected: bool,
    pub accessibility_busy: bool,
    pub accessibility_checked: u8,
    pub accessibility_expanded: i8,
    pub accessibility_important: u8,
    pub accessibility_live_region: u8,
    pub accessibility_hidden: bool,
    pub accessibility_modal: bool,
    pub accessibility_responds_to_interaction: bool,
    pub accessibility_has_action_listener: bool,
    pub accessibility_has_tap_listener: bool,
    pub accessibility_has_escape_listener: bool,
    pub desktop_drag_region: bool,
    pub on_context_menu: bool,
    pub on_wheel: bool,
    pub on_layout: bool,
    pub accepts_files: bool,
    pub draggable: bool,
    pub droppable: bool,
    extras: Option<Box<ViewExtras>>,
}

/// The view props a node usually leaves unset.
#[derive(Clone, Debug)]
pub struct ViewExtras {
    pub shadows: Vec<ShadowF>,
    pub background_json: String,
    pub filter_json: String,
    pub transform: [f32; 16],
    pub test_id: String,
    pub accessibility_label: String,
    pub accessibility_hint: String,
    pub accessibility_language: String,
    pub accessibility_role: String,
    pub accessibility_value_text: String,
    pub accessibility_actions: Vec<AccessibilityActionFlat>,
    pub accessibility_labelled_by: Vec<String>,
    pub accessibility_order: Vec<String>,
    pub accessibility_native_id: String,
    pub accessibility_large_content_title: String,
    pub group: String,
    pub hover_style: String,
    pub active_style: String,
    pub focus_style: String,
    pub focus_visible_style: String,
    pub group_hover_style: String,
    pub group_active_style: String,
    pub drag_over_style: String,
    pub tooltip: String,
}

static EMPTY: ViewExtras = ViewExtras {
    shadows: Vec::new(),
    background_json: String::new(),
    filter_json: String::new(),
    transform: IDENTITY,
    test_id: String::new(),
    accessibility_label: String::new(),
    accessibility_hint: String::new(),
    accessibility_language: String::new(),
    accessibility_role: String::new(),
    accessibility_value_text: String::new(),
    accessibility_actions: Vec::new(),
    accessibility_labelled_by: Vec::new(),
    accessibility_order: Vec::new(),
    accessibility_native_id: String::new(),
    accessibility_large_content_title: String::new(),
    group: String::new(),
    hover_style: String::new(),
    active_style: String::new(),
    focus_style: String::new(),
    focus_visible_style: String::new(),
    group_hover_style: String::new(),
    group_active_style: String::new(),
    drag_over_style: String::new(),
    tooltip: String::new(),
};

impl ViewExtras {
    fn is_empty(&self) -> bool {
        self.shadows.is_empty()
            && self.background_json.is_empty()
            && self.filter_json.is_empty()
            && self.transform == IDENTITY
            && self.test_id.is_empty()
            && self.accessibility_label.is_empty()
            && self.accessibility_hint.is_empty()
            && self.accessibility_language.is_empty()
            && self.accessibility_role.is_empty()
            && self.accessibility_value_text.is_empty()
            && self.accessibility_actions.is_empty()
            && self.accessibility_labelled_by.is_empty()
            && self.accessibility_order.is_empty()
            && self.accessibility_native_id.is_empty()
            && self.accessibility_large_content_title.is_empty()
            && self.group.is_empty()
            && self.hover_style.is_empty()
            && self.active_style.is_empty()
            && self.focus_style.is_empty()
            && self.focus_visible_style.is_empty()
            && self.group_hover_style.is_empty()
            && self.group_active_style.is_empty()
            && self.drag_over_style.is_empty()
            && self.tooltip.is_empty()
    }
}

impl Default for ViewExtras {
    fn default() -> Self {
        EMPTY.clone()
    }
}

impl std::ops::Deref for ViewProps {
    type Target = ViewExtras;

    fn deref(&self) -> &ViewExtras {
        self.extras.as_deref().unwrap_or(&EMPTY)
    }
}

impl std::ops::DerefMut for ViewProps {
    fn deref_mut(&mut self) -> &mut ViewExtras {
        self.extras.get_or_insert_with(Default::default)
    }
}

impl Default for ViewProps {
    fn default() -> Self {
        Self::from(ViewPropsFlat::default())
    }
}

impl From<ViewPropsFlat> for ViewProps {
    fn from(flat: ViewPropsFlat) -> Self {
        let extras = ViewExtras {
            shadows: flat.shadows,
            background_json: flat.background_json,
            filter_json: flat.filter_json,
            transform: flat.transform,
            test_id: flat.test_id,
            accessibility_label: flat.accessibility_label,
            accessibility_hint: flat.accessibility_hint,
            accessibility_language: flat.accessibility_language,
            accessibility_role: flat.accessibility_role,
            accessibility_value_text: flat.accessibility_value_text,
            accessibility_actions: flat.accessibility_actions,
            accessibility_labelled_by: flat.accessibility_labelled_by,
            accessibility_order: flat.accessibility_order,
            accessibility_native_id: flat.accessibility_native_id,
            accessibility_large_content_title: flat.accessibility_large_content_title,
            group: flat.group,
            hover_style: flat.hover_style,
            active_style: flat.active_style,
            focus_style: flat.focus_style,
            focus_visible_style: flat.focus_visible_style,
            group_hover_style: flat.group_hover_style,
            group_active_style: flat.group_active_style,
            drag_over_style: flat.drag_over_style,
            tooltip: flat.tooltip,
        };
        Self {
            opacity: flat.opacity,
            background_color: flat.background_color,
            border_widths: flat.border_widths,
            content_insets: flat.content_insets,
            border_colors: flat.border_colors,
            border_styles: flat.border_styles,
            border_radii: flat.border_radii,
            outline_color: flat.outline_color,
            outline_width: flat.outline_width,
            outline_offset: flat.outline_offset,
            outline_style: flat.outline_style,
            overflow_hidden: flat.overflow_hidden,
            display_none: flat.display_none,
            pointer_events: flat.pointer_events,
            cursor: flat.cursor,
            mix_blend_mode: flat.mix_blend_mode,
            isolate: flat.isolate,
            hit_slop: flat.hit_slop,
            has_transform: flat.has_transform,
            backface_hidden: flat.backface_hidden,
            transform_origin_set: flat.transform_origin_set,
            accessibility_traits: flat.accessibility_traits,
            accessibility_value_min: flat.accessibility_value_min,
            accessibility_value_max: flat.accessibility_value_max,
            accessibility_value_now: flat.accessibility_value_now,
            accessibility_has_value_min: flat.accessibility_has_value_min,
            accessibility_has_value_max: flat.accessibility_has_value_max,
            accessibility_has_value_now: flat.accessibility_has_value_now,
            accessible: flat.accessible,
            accessibility_disabled: flat.accessibility_disabled,
            accessibility_selected: flat.accessibility_selected,
            accessibility_busy: flat.accessibility_busy,
            accessibility_checked: flat.accessibility_checked,
            accessibility_expanded: flat.accessibility_expanded,
            accessibility_important: flat.accessibility_important,
            accessibility_live_region: flat.accessibility_live_region,
            accessibility_hidden: flat.accessibility_hidden,
            accessibility_modal: flat.accessibility_modal,
            accessibility_responds_to_interaction: flat.accessibility_responds_to_interaction,
            accessibility_has_action_listener: flat.accessibility_has_action_listener,
            accessibility_has_tap_listener: flat.accessibility_has_tap_listener,
            accessibility_has_escape_listener: flat.accessibility_has_escape_listener,
            desktop_drag_region: flat.desktop_drag_region,
            on_context_menu: flat.on_context_menu,
            on_wheel: flat.on_wheel,
            on_layout: flat.on_layout,
            accepts_files: flat.accepts_files,
            draggable: flat.draggable,
            droppable: flat.droppable,
            extras: (!extras.is_empty()).then(|| Box::new(extras)),
        }
    }
}

impl From<&ViewPropsFlat> for ViewProps {
    fn from(flat: &ViewPropsFlat) -> Self {
        Self::from(flat.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_view_without_strings_or_lists_has_no_extras() {
        let props = ViewProps::from(ViewPropsFlat {
            transform: IDENTITY,
            opacity: 0.5,
            ..Default::default()
        });
        assert!(props.extras.is_none());
        assert_eq!(props.opacity, 0.5);
        assert!(props.test_id.is_empty());
        assert_eq!(props.transform, IDENTITY);
    }

    #[test]
    fn a_set_string_or_matrix_is_kept() {
        let mut flat = ViewPropsFlat {
            transform: IDENTITY,
            ..Default::default()
        };
        flat.test_id = "cell".into();
        let props = ViewProps::from(flat);
        assert_eq!(props.test_id, "cell");
        let mut moved = ViewPropsFlat::default();
        moved.transform[12] = 4.0;
        assert_eq!(ViewProps::from(moved).transform[12], 4.0);
    }

    #[test]
    fn writing_an_extra_allocates_it() {
        let mut props = ViewProps::from(ViewPropsFlat {
            transform: IDENTITY,
            ..Default::default()
        });
        props.tooltip = "tip".into();
        assert_eq!(props.tooltip, "tip");
    }
}
