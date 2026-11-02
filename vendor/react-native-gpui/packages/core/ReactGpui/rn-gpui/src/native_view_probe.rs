use anyhow::{Context as _, Result};
use cocoa::{
    appkit::{NSView, NSViewHeightSizable, NSViewWidthSizable},
    base::{id, nil, YES},
    foundation::{NSPoint, NSRect, NSSize, NSString},
};
use gpui::{
    deferred, div, px, relative, rgb, App, AppContext, Bounds, Context, Element, ElementId, Entity,
    GlobalElementId, InteractiveElement, IntoElement, LayoutId, MouseButton, ParentElement, Render,
    Style, Styled, Window, WindowCompositionSurface,
};
use objc::{class, msg_send, sel, sel_impl};
use std::{cell::Cell, rc::Rc};

#[link(name = "WebKit", kind = "framework")]
// SAFETY: an empty block whose only job is to link the WebKit framework.
unsafe extern "C" {}

#[derive(Clone, Copy)]
pub enum NativeContentKind {
    AppKitView,
    WebView,
}

const WEBVIEW_HTML: &str = r#"<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>
html,body{margin:0;width:100%;height:100%;font:16px -apple-system,BlinkMacSystemFont,sans-serif;color:#102033;background:linear-gradient(135deg,#e5f4fa,#c2e1ef)}
main{box-sizing:border-box;padding:28px;height:100%;display:flex;flex-direction:column;justify-content:center;gap:10px}h1{font-size:22px;margin:0}p{margin:0;line-height:1.45}
</style></head><body><main><h1>WKWebView native surface</h1><p>This page is rendered by WebKit in an AppKit view attached to the GPUI composition surface.</p><p>Resize the window and use the GPUI overlay control above this area.</p></main></body></html>"#;

pub struct NativeViewCompositionProbe {
    surface: WindowCompositionSurface,
    view: id,
    last_bounds: Cell<Option<Bounds<gpui::DevicePixels>>>,
}

impl NativeViewCompositionProbe {
    pub fn new(window: &Window, kind: NativeContentKind) -> Result<Self> {
        let composition = window.enable_window_composition()?;
        let surface = composition.create_native_surface()?;
        let container = surface
            .platform_surface()?
            .platform_handle()?
            .downcast::<usize>()
            .map(|handle| *handle as id)
            .map_err(|_| anyhow::anyhow!("native composition surface is not an AppKit view"))?;

        // SAFETY: the views are created and configured on the main thread and owned by the returned probe.
        unsafe {
            let frame = NSRect::new(NSPoint::new(0., 0.), NSSize::new(0., 0.));
            let view: id = match kind {
                NativeContentKind::AppKitView => {
                    let view: id = msg_send![class!(NSView), alloc];
                    msg_send![view, initWithFrame: frame]
                }
                NativeContentKind::WebView => {
                    let configuration: id = msg_send![class!(WKWebViewConfiguration), new];
                    let allocated: id = msg_send![class!(WKWebView), alloc];
                    let view: id =
                        msg_send![allocated, initWithFrame: frame configuration: configuration];
                    let _: () = msg_send![configuration, release];
                    view
                }
            };
            anyhow::ensure!(!view.is_null(), "failed to create native composition view");

            let _: () = msg_send![view, setWantsLayer: YES];
            let _: () = msg_send![
                view,
                setAutoresizingMask: NSViewWidthSizable | NSViewHeightSizable
            ];
            let layer: id = msg_send![view, layer];
            let _: () = msg_send![layer, setCornerRadius: 12.0];
            let _: () = msg_send![layer, setMasksToBounds: YES];
            if matches!(kind, NativeContentKind::AppKitView) {
                let color: id = msg_send![
                    class!(NSColor),
                    colorWithSRGBRed: 0.08
                    green: 0.48
                    blue: 0.68
                    alpha: 1.0
                ];
                let color: id = msg_send![color, CGColor];
                let _: () = msg_send![layer, setBackgroundColor: color];
            } else {
                #[allow(
                    clippy::disallowed_methods,
                    reason = "NSString is released after WebKit copies the HTML"
                )]
                let html = NSString::alloc(nil).init_str(WEBVIEW_HTML);
                let _: id = msg_send![view, loadHTMLString: html baseURL: nil];
                let _: () = msg_send![html, release];
            }
            let _: () = msg_send![container, addSubview: view];

            log::info!(
                "[native-view-probe] attached {:?} to composition surface",
                match kind {
                    NativeContentKind::AppKitView => "AppKit NSView",
                    NativeContentKind::WebView => "WKWebView",
                }
            );
            Ok(Self {
                surface,
                view,
                last_bounds: Cell::new(None),
            })
        }
    }

    fn set_bounds(&self, bounds: Bounds<gpui::Pixels>, scale_factor: f32) -> Result<()> {
        let device_bounds = bounds.to_device_pixels(scale_factor);
        if self.last_bounds.get() != Some(device_bounds) {
            log::info!("[native-view-probe] device bounds={device_bounds:?}");
            self.last_bounds.set(Some(device_bounds));
        }
        self.surface
            .platform_surface()?
            .set_bounds(device_bounds)
            .context("setting AppKit test surface bounds")
    }
}

impl Drop for NativeViewCompositionProbe {
    fn drop(&mut self) {
        // SAFETY: `self.view` is the owned view created in `new`; it is detached and released once, on drop.
        unsafe {
            NSView::removeFromSuperview(self.view);
            let _: () = msg_send![self.view, release];
        }
    }
}

pub struct NativeViewCompositionProbeView {
    fixture: Option<Rc<NativeViewCompositionProbe>>,
    overlay_visible: bool,
    kind: NativeContentKind,
}

impl NativeViewCompositionProbeView {
    pub fn new(kind: NativeContentKind) -> Self {
        Self {
            fixture: None,
            overlay_visible: false,
            kind,
        }
    }
}

impl Render for NativeViewCompositionProbeView {
    fn render(&mut self, window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        if self.fixture.is_none() {
            match NativeViewCompositionProbe::new(window, self.kind) {
                Ok(fixture) => self.fixture = Some(Rc::new(fixture)),
                Err(error) => log::error!("[native-view-probe] initialization failed: {error:#}"),
            }
        }

        let mut root = div().absolute().inset_0().size_full();
        if let Some(fixture) = self.fixture.clone() {
            root = root.child(
                div()
                    .absolute()
                    .left(px(32.))
                    .right(px(32.))
                    .top(px(260.))
                    .bottom(px(24.))
                    .child(NativeViewSurfaceElement { fixture }),
            );
        }

        let label = if self.overlay_visible {
            "Hide composition overlay"
        } else {
            "Show composition overlay"
        };
        root = root.child(
            div()
                .absolute()
                .left(px(32.))
                .top(px(190.))
                .px_4()
                .py_2()
                .rounded_md()
                .bg(rgb(0x26384a))
                .text_color(rgb(0xffffff))
                .cursor_pointer()
                .on_mouse_down(
                    MouseButton::Left,
                    _cx.listener(|this, _, _, cx| {
                        this.overlay_visible = !this.overlay_visible;
                        log::info!(
                            "[native-view-probe] overlay visible={}",
                            this.overlay_visible
                        );
                        cx.notify();
                    }),
                )
                .child(label),
        );

        if self.overlay_visible {
            root = root.child(
                deferred(
                    div()
                        .absolute()
                        .left(px(92.))
                        .top(px(316.))
                        .w(px(420.))
                        .h(px(116.))
                        .flex()
                        .flex_col()
                        .justify_center()
                        .gap_2()
                        .px_5()
                        .rounded_lg()
                        .border_2()
                        .border_color(rgb(0xffffff))
                        .bg(rgb(0xffffff).opacity(0.82))
                        .text_color(rgb(0x18212f))
                        .child(match self.kind {
                            NativeContentKind::AppKitView => {
                                "GPUI overlay above the blue AppKit NSView"
                            }
                            NativeContentKind::WebView => "GPUI overlay above the WKWebView",
                        })
                        .child("Native content should remain visible through this panel."),
                )
                .priority(100),
            );
        }
        root
    }
}

struct NativeViewSurfaceElement {
    fixture: Rc<NativeViewCompositionProbe>,
}

impl IntoElement for NativeViewSurfaceElement {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for NativeViewSurfaceElement {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&gpui::InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        style.size.height = relative(1.).into();
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&gpui::InspectorElementId>,
        bounds: Bounds<gpui::Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        _window: &mut Window,
        _cx: &mut App,
    ) -> Self::PrepaintState {
        if let Err(error) = self.fixture.set_bounds(bounds, _window.scale_factor()) {
            log::error!("[native-view-probe] updating surface bounds failed: {error:#}");
        }
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&gpui::InspectorElementId>,
        _bounds: Bounds<gpui::Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        _prepaint: &mut Self::PrepaintState,
        _window: &mut Window,
        _cx: &mut App,
    ) {
    }
}

pub fn create_probe_entity(cx: &mut App) -> Entity<NativeViewCompositionProbeView> {
    cx.new(|_| NativeViewCompositionProbeView::new(NativeContentKind::AppKitView))
}

pub fn create_webview_probe_entity(cx: &mut App) -> Entity<NativeViewCompositionProbeView> {
    cx.new(|_| NativeViewCompositionProbeView::new(NativeContentKind::WebView))
}
