//! `tooltip`: text shown after the pointer rests over a view.
//!
//! The view under the pointer, or its nearest ancestor with a `tooltip`, is
//! the one that counts. On macOS the text is handed to the system: one
//! `NSView` tooltip rectangle is kept over that view's frame, so the delay,
//! the look and the place are the operating system's and the tooltip can
//! leave the window. Elsewhere, and with `RN_GPUI_TOOLTIP=drawn`, the app
//! draws it after the same delay, in front of everything in the window.

use crate::events::Target;
use crate::store::{store_from, StoreGlobal};
use gpui::{point, px, App, AppContext as _, Pixels, Point, Window};
use std::cell::{Cell, RefCell};
use std::time::Duration;

#[cfg(target_os = "macos")]
mod mac;

const DRAWN_DELAY: Duration = Duration::from_millis(500);

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Active {
    pub tag: i32,
    pub text: String,
    /// The view's frame in the window: x, y, width, height.
    pub rect: (f32, f32, f32, f32),
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Drawn {
    pub text: String,
    pub x: f32,
    pub y: f32,
}

thread_local! {
    static ACTIVE: RefCell<Option<Active>> = const { RefCell::new(None) };
    static DRAWN: RefCell<Option<Drawn>> = const { RefCell::new(None) };
    static GENERATION: Cell<u64> = const { Cell::new(0) };
}

fn native() -> bool {
    cfg!(target_os = "macos") && std::env::var("RN_GPUI_TOOLTIP").as_deref() != Ok("drawn")
}

#[cfg(target_os = "macos")]
pub(crate) fn native_probe(window: &Window, tag: i32) -> (Option<String>, usize) {
    mac::probe(window, tag)
}

/// What the system tooltip would show, and for which view, if the pointer rests
/// at `position` in the window.
pub(crate) fn active() -> Option<Active> {
    ACTIVE.with_borrow(Clone::clone)
}

pub(crate) fn drawn() -> Option<Drawn> {
    DRAWN.with_borrow(Clone::clone)
}

pub(crate) fn mode() -> &'static str {
    if native() {
        "native"
    } else {
        "drawn"
    }
}

fn tooltip_view(cx: &App, chain: &[i32]) -> Option<(i32, String)> {
    let store = cx.try_global::<StoreGlobal>()?.0.read(cx);
    chain.iter().find_map(|tag| {
        let node = store.nodes.get(tag)?.read(cx);
        let text = node.tooltip();
        (!text.is_empty()).then(|| (*tag, text.to_string()))
    })
}

fn frame_in_window(cx: &App, tag: i32, target: &Target) -> Option<(f32, f32, f32, f32)> {
    let store = cx.try_global::<StoreGlobal>()?.0.read(cx);
    let node = store.nodes.get(&tag)?.read(cx);
    let origin = target.window_point(node.absolute_origin(cx));
    let (scale_x, scale_y) = node.cumulative_scale(cx);
    let zoom = target.zoom();
    Some((
        f32::from(origin.x),
        f32::from(origin.y),
        node.frame.w * scale_x * zoom,
        node.frame.h * scale_y * zoom,
    ))
}

/// The pointer is at `position` over `target` (the hover chain is current).
pub(crate) fn pointer_over(
    window: &mut Window,
    cx: &mut App,
    target: Option<&Target>,
    position: Point<Pixels>,
) {
    let found = target.and_then(|target| {
        let (tag, text) = tooltip_view(cx, &target.chain)?;
        let rect = frame_in_window(cx, tag, target)?;
        Some(Active { tag, text, rect })
    });
    let Some(next) = found else {
        dismiss(window, cx);
        return;
    };
    let same = ACTIVE.with_borrow(|active| active.as_ref() == Some(&next));
    if same && native() {
        return;
    }
    let same_view = ACTIVE.with_borrow(|active| {
        active
            .as_ref()
            .is_some_and(|active| active.tag == next.tag && active.text == next.text)
    });
    ACTIVE.with_borrow_mut(|active| *active = Some(next.clone()));
    if native() {
        #[cfg(target_os = "macos")]
        mac::apply(window, Some(&next));
        return;
    }
    if same_view && DRAWN.with_borrow(Option::is_some) {
        return;
    }
    hide_drawn(cx);
    let generation = GENERATION.with(|generation| {
        generation.set(generation.get() + 1);
        generation.get()
    });
    let Some(store) = store_from(cx) else {
        return;
    };
    let window_handle = store.read(cx).window;
    let text = next.text;
    let at = point(f32::from(position.x) + 12.0, f32::from(position.y) + 22.0);
    cx.spawn(async move |cx| {
        cx.background_executor().timer(DRAWN_DELAY).await;
        let _ = cx.update(|cx| {
            if GENERATION.with(Cell::get) != generation {
                return;
            }
            DRAWN.with_borrow_mut(|drawn| {
                *drawn = Some(Drawn {
                    text,
                    x: at.x,
                    y: at.y,
                })
            });
            let _ = cx.update_window(window_handle, |_, window, _| window.refresh());
        });
    })
    .detach();
}

fn hide_drawn(cx: &mut App) {
    let was = DRAWN.with_borrow_mut(Option::take).is_some();
    if was {
        if let Some(store) = store_from(cx) {
            let handle = store.read(cx).window;
            let _ = cx.update_window(handle, |_, window, _| window.refresh());
        }
    }
}

/// The pointer left, pressed, scrolled, or the window lost focus.
pub(crate) fn dismiss(window: &mut Window, cx: &mut App) {
    GENERATION.with(|generation| generation.set(generation.get() + 1));
    let had = ACTIVE.with_borrow_mut(Option::take).is_some();
    let drawn = DRAWN.with_borrow_mut(Option::take).is_some();
    if drawn {
        window.refresh();
    }
    #[cfg(target_os = "macos")]
    if had && native() {
        mac::apply(window, None);
    }
    let _ = (had, cx);
}

/// The element that draws the tooltip, in window coordinates.
pub(crate) fn drawn_element(window: &Window) -> Option<gpui::AnyElement> {
    use gpui::{div, prelude::*, rgb, rgba};
    let drawn = drawn()?;
    let size = window.viewport_size();
    let width = 260.0f32;
    let x = drawn.x.min(f32::from(size.width) - width - 4.0).max(4.0);
    let y = drawn.y.min(f32::from(size.height) - 28.0).max(4.0);
    Some(
        gpui::deferred(
            div()
                .id("tooltip")
                .absolute()
                .left(px(x))
                .top(px(y))
                .max_w(px(width))
                .px(px(6.0))
                .py(px(3.0))
                .rounded(px(4.0))
                .border_1()
                .border_color(rgba(0x00000033))
                .bg(rgb(0xf5f5f5))
                .text_color(rgb(0x1a1a1a))
                .text_size(px(12.0))
                .child(drawn.text),
        )
        .priority(1000)
        .into_any_element(),
    )
}
