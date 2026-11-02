use gpui::{point, px, rgba, BoxShadow, CursorStyle, Fill, Hsla, Overflow, StyleRefinement};
use rn_gpui_sys::ffi::ViewPropsFlat;

/// RN colors are 0xAARRGGBB; GPUI's `rgba()` takes 0xRRGGBBAA.
pub fn color(argb: u32) -> Hsla {
    let alpha = argb >> 24;
    rgba((argb << 8) | alpha).into()
}

/// `ViewPropsFlat::cursor` is the ordinal of RN's `Cursor` enum; the arms
/// below are in that order.
fn cursor_style(ordinal: u8) -> Option<CursorStyle> {
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

pub fn to_refinement(v: &ViewPropsFlat) -> StyleRefinement {
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
        log::info!("[style] cursor ordinal {} -> {cursor:?}", v.cursor);
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
                    blur_radius: px(sh.blur),
                    spread_radius: px(sh.spread),
                    inset: sh.inset,
                })
                .collect(),
        );
    }
    s
}
