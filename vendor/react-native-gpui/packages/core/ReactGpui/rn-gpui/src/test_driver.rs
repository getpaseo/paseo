use crate::{node_view::RNNodeView, store::ViewStore};
use async_channel::{Receiver, Sender};
use base64::Engine;
use gpui::{point, px, AnyWindowHandle, App, AppContext, Entity};
use rn_gpui_sys::ffi::RectF;
use serde_json::{json, Value};
use std::{
    io::Write,
    net::TcpListener,
    sync::mpsc::{self, SyncSender},
    thread,
    time::{Duration, Instant},
};
use tungstenite::{accept, Message};

const PROTOCOL_VERSION: u32 = 1;

// SAFETY: the signatures match the definitions in the C++ host.
unsafe extern "C" {
    fn rn_gpui_http_requests_not_ignored(patterns: *const std::ffi::c_char) -> u64;
    fn rn_gpui_mount_batches_in_flight() -> u64;
    fn rn_gpui_pending_timers_due_within(window_ms: u64) -> u64;
    fn rn_gpui_pending_timers_dump(window_ms: u64, buffer: *mut u8, capacity: u64) -> u64;
    fn rn_gpui_websocket_messages_in_flight() -> u64;
    fn rn_gpui_pending_js_tasks() -> u64;
    fn rn_gpui_pending_js_tasks_dump(buffer: *mut u8, capacity: u64) -> u64;
    fn rn_gpui_native_animations_active() -> u64;
    fn rn_gpui_frame_demand() -> u64;
    fn rn_gpui_pending_work() -> u64;
    fn rn_gpui_rust_promises_in_flight(younger_than_ms: u64) -> u64;
    fn rn_gpui_request_reload();
    fn rn_gpui_reload_in_progress() -> bool;
    /// Counts the React instances created so far. It changes when a reload
    /// mounts a new one, which is how a caller waits for the replacement
    /// instead of guessing from an empty tree.
    fn rn_gpui_instance_generation() -> u64;
}

struct Request {
    value: Value,
    reply: SyncSender<Value>,
}

/// The generation of the React instance currently mounted, or 0 before the host
/// has created one. Reported by `hello`, `tree` and `reload` so a client can
/// wait for a *particular* instance after a reload.
#[cfg(target_os = "macos")]
fn dock_menu(command: &str, params: &Value) -> Value {
    use cocoa::base::id;
    use objc::{class, msg_send, sel, sel_impl};
    // SAFETY: AppKit is messaged on the main thread, where the driver runs; the
    // menu is the delegate's own and outlives this call.
    unsafe {
        let app: id = msg_send![class!(NSApplication), sharedApplication];
        let delegate: id = msg_send![app, delegate];
        let menu: id = msg_send![delegate, applicationDockMenu: app];
        if menu.is_null() {
            return json!({"titles": Vec::<String>::new()});
        }
        if command == "dockMenuPress" {
            let index = params.get("index").and_then(Value::as_i64).unwrap_or(0);
            let _: () = msg_send![menu, performActionForItemAtIndex: index as isize];
            return json!({"pressed": index});
        }
        let count: isize = msg_send![menu, numberOfItems];
        let titles: Vec<String> = (0..count)
            .map(|index| {
                let item: id = msg_send![menu, itemAtIndex: index];
                let title: id = msg_send![item, title];
                let bytes: *const std::os::raw::c_char = msg_send![title, UTF8String];
                std::ffi::CStr::from_ptr(bytes)
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        json!({"titles": titles})
    }
}

#[cfg(not(target_os = "macos"))]
fn dock_menu(_command: &str, _params: &Value) -> Value {
    json!({"error": "the Dock menu is only available on macOS"})
}

fn instance_generation() -> u64 {
    // SAFETY: the C++ function takes no arguments and reads an atomic.
    unsafe { rn_gpui_instance_generation() }
}

pub(crate) fn start(app: &mut App, store: Entity<ViewStore>, window: AnyWindowHandle) {
    let token = std::env::var("RN_GPUI_TEST_DRIVER_TOKEN")
        .expect("RN_GPUI_TEST_DRIVER=1 requires RN_GPUI_TEST_DRIVER_TOKEN");
    let listener =
        TcpListener::bind("127.0.0.1:0").expect("could not bind the GPUI test driver to loopback");
    let port = listener
        .local_addr()
        .expect("driver listener has address")
        .port();
    let (tx, rx) = async_channel::unbounded::<Request>();

    app.spawn(async move |cx| serve_commands(rx, store, window, cx).await)
        .detach();

    thread::Builder::new()
        .name("rn-gpui-test-driver".into())
        .spawn(move || serve_socket(listener, token, tx))
        .expect("could not start GPUI test driver thread");
    println!("RN_GPUI_TEST_DRIVER_PORT={port}");
    let _ = std::io::stdout().flush();
}

async fn serve_commands(
    rx: Receiver<Request>,
    store: Entity<ViewStore>,
    window: AnyWindowHandle,
    cx: &mut gpui::AsyncApp,
) {
    while let Ok(request) = rx.recv().await {
        let id = request.value.get("id").cloned().unwrap_or(Value::Null);
        let method = request
            .value
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or("");
        let params = request.value.get("params").cloned().unwrap_or(json!({}));

        let result = match method {
            "hello" => {
                let (width, height, scale) = cx
                    .update_window(window, |_, window, _| {
                        let size = window.viewport_size();
                        (
                            f32::from(size.width),
                            f32::from(size.height),
                            window.scale_factor(),
                        )
                    })
                    .unwrap_or((0.0, 0.0, 1.0));
                json!({"protocol": PROTOCOL_VERSION, "platform": "desktop", "scale": scale,
                    // The React instance this tree belongs to. A client uses it
                    // to wait for the replacement after a reload; it is 0 only
                    // before the host has created any instance at all.
                    "generation": instance_generation(),
                    // Every backend that implements `Window::render_to_image` can
                    // answer `screenshot`: gpui_macos/metal, gpui_linux (X11 and
                    // Wayland) and gpui_windows/Direct3D all do.
                    "capture": cfg!(feature = "visual-capture") && cfg!(any(target_os = "macos", target_os = "linux", target_os = "windows")),
                    "animationsDisabled": crate::animation_policy::animations_disabled(),
                    "windowSize": {"width": width, "height": height}, "appName": std::env::var("RN_GPUI_APP_ID").unwrap_or_default()})
            }
            "getWindowBounds" => cx.update_window(window, |_,window,_| {
                let bounds = window.bounds();
                    #[cfg(target_os = "macos")]
                    let hidden = !crate::native_view::test_window_visible(window);
                    // Offscreen test windows are created unmapped on Linux, so
                    // the X11 map state reports them as hidden; a real window
                    // session stays viewable.
                    #[cfg(target_os = "linux")]
                    let hidden = crate::desktop::platform_window::is_minimized(window);
                    // A window created with `show: false` (the offscreen test
                    // mode) is not `IsWindowVisible`; a real one is, even when
                    // another window covers it.
                    #[cfg(target_os = "windows")]
                    let hidden = crate::desktop::platform_window::is_hidden(window);
                    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
                    let hidden = false;
                json!({"x":f32::from(bounds.origin.x),"y":f32::from(bounds.origin.y),"width":f32::from(bounds.size.width),"height":f32::from(bounds.size.height), "hidden":hidden})
            }).unwrap_or_else(|error|json!({"error":error.to_string()})),
            #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
            "compositeCapture" => cx
                .update_window(window, |_, window, _| {
                    match composite_png(window) {
                        Ok((png, width, height)) => json!({
                            "png": base64::engine::general_purpose::STANDARD.encode(png),
                            "width": width,
                            "height": height,
                            "scale": window.scale_factor(),
                            "viewport": {
                                "width": f32::from(window.viewport_size().width),
                                "height": f32::from(window.viewport_size().height),
                            },
                        }),
                        Err(error) => json!({"error": error}),
                    }
                })
                .unwrap_or_else(|error| json!({"error": error.to_string()})),
            "compositionLayers" => cx
                .update_window(window, |_, window, _| {
                    json!({"count": window.composed_scene_layers().len()})
                })
                .unwrap_or_else(|error| json!({"error": error.to_string()})),
            "nativeSurfaces" => {
                let (scale, layers) = cx
                    .update_window(window, |_, window, _| {
                        (window.scale_factor(), window.composed_scene_layers())
                    })
                    .unwrap_or((1.0, Vec::new()));
                let ops = |surface| {
                    layers
                        .iter()
                        .find(|layer| layer.surface == surface)
                        .map_or(0, |layer| layer.ranges.iter().map(|range| range.len()).sum())
                };
                let base_ops: usize = layers.first().map_or(0, |layer| {
                    layer.ranges.iter().map(|range| range.len()).sum()
                });
                cx.update_entity(&store, |store, cx| {
                    let mut surfaces: Vec<Value> = store
                        .nodes
                        .iter()
                        .filter_map(|(tag, entity)| {
                            let node = entity.read(cx);
                            let surface = node.native_surface()?;
                            let mut state = surface.test_state(scale);
                            state["tag"] = json!(tag);
                            state["testID"] = json!(node.view.test_id);
                            state["aboveOps"] = json!(ops(surface.above()));
                            state["baseOps"] = json!(base_ops);
                            Some(state)
                        })
                        .collect();
                    surfaces.sort_by_key(|surface| surface["tag"].as_i64());
                    json!({"surfaces": surfaces})
                })
            }
            "hostCounters" => {
                use crate::counters::{read, reset, Counter};
                let counters = json!({
                    "hostRegistryLookups": read(Counter::HostRegistryLookups),
                    "hostEntryLookups": rn_gpui_sys::ffi::hostEntryLookups(),
                    "nativeSurfaceWalkNodes": read(Counter::NativeSurfaceWalkNodes),
                    "hostPropsBytesCopied": read(Counter::HostPropsBytesCopied),
                    "hostUpdateCalls": read(Counter::HostUpdateCalls),
                    "hostReportsDelivered": read(Counter::HostReportsDelivered),
                    "nativeOpsApplied": read(Counter::NativeOpsApplied),
                    "nativeApplyMicros": read(Counter::NativeApplyMicros),
                    "nativeRenderMicros": read(Counter::NativeRenderMicros),
                    "nativeInstancesCreated": read(Counter::NativeInstancesCreated),
                    "nativeInstancesRecycled": read(Counter::NativeInstancesRecycled),
                    "nativeRootHolds": read(Counter::NativeRootHolds),
                    "nativeRootHeldMs": read(Counter::NativeRootHeldMicros) as f64 / 1000.0,
                    "nativeRootHoldsSkipped": read(Counter::NativeRootHoldsSkipped),
                });
                if params.get("reset").and_then(Value::as_bool).unwrap_or(false) {
                    reset();
                    rn_gpui_sys::ffi::resetHostEntryLookups();
                }
                counters
            }
            "displays" => cx.update(|cx| {
                let primary = cx.primary_display().map(|display| display.id());
                let rect = |bounds: gpui::Bounds<gpui::Pixels>| {
                    json!({
                        "x": f32::from(bounds.origin.x),
                        "y": f32::from(bounds.origin.y),
                        "width": f32::from(bounds.size.width),
                        "height": f32::from(bounds.size.height),
                    })
                };
                json!(cx
                    .displays()
                    .iter()
                    .map(|display| json!({
                        "primary": Some(display.id()) == primary,
                        "bounds": rect(display.bounds()),
                        "visibleBounds": rect(display.visible_bounds()),
                        "scaleFactor": crate::desktop::background::display_scale(
                            display.id().into()
                        ),
                    }))
                    .collect::<Vec<_>>())
            }),
            "getWindowSize" => cx
                .update_window(window, |_, window, _| {
                    let size = window.viewport_size();
                    json!({"width": f32::from(size.width), "height":f32::from(size.height)})
                })
                .unwrap_or_else(|error| json!({"error":error.to_string()})),
            "dockMenu" | "dockMenuPress" => dock_menu(method, &params),
            "layoutStats" => {
                let reset = params.get("reset").and_then(Value::as_bool).unwrap_or(false);
                cx.update_window(window, |_, window, cx| {
                    let views = crate::store::store_from(cx)
                        .map_or(0, |store| store.read(cx).nodes.len());
                    let stats = window.layout_stats();
                    let target_at = crate::wheel::target_at_stats(reset);
                    let scroll_deltas = crate::wheel::scroll_delta_stats(reset);
                    let ms = |duration: std::time::Duration| duration.as_secs_f64() * 1000.0;
                    let report = json!({
                        "frames": stats.frames,
                        "nodesCreated": stats.nodes_created,
                        "nodesReused": stats.nodes_reused,
                        "nodesFreed": stats.nodes_freed,
                        "styleCompares": stats.style_compares,
                        "styleWrites": stats.style_writes,
                        "childrenWrites": stats.children_writes,
                        "measureRebinds": stats.measure_rebinds,
                        "measurementsKept": stats.measurements_kept,
                        "measurementsReplayed": stats.measurements_replayed,
                        "measureCalls": stats.measure_calls,
                        "measureMs": ms(stats.measure_time),
                        "computeLayoutCalls": stats.compute_layout_calls,
                        "buildMs": ms(stats.build_time),
                        "prepaintMs": ms(stats.prepaint_time),
                        "paintMs": ms(stats.paint_time),
                        "computeLayoutMs": ms(stats.compute_layout_time),
                        "linesShaped": stats.lines_shaped,
                        "shapeMs": ms(stats.shape_time),
                        "viewsBuilt": stats.views_built,
                        "viewsReused": stats.views_reused,
                        "layerFramesComposited": stats.layer_frames_composited,
                        "layerFramesRepainted": stats.layer_frames_repainted,
                        "tilesDirtied": stats.tiles_dirtied,
                        "layerRebuildsForInput": stats.layer_rebuilds_for_input,
                        "layersDemoted": stats.layers_demoted,
                        "layoutNodes": window.layout_node_count(),
                        "views": views,
                        "targetAtCalls": target_at.0,
                        "targetAtMs": target_at.1,
                        "scrollEvents": scroll_deltas.0,
                        "scrollEventsWholePixel": scroll_deltas.1,
                    });
                    if reset {
                        window.reset_layout_stats();
                    }
                    report
                })
                .unwrap_or_else(|error| json!({"error": error.to_string()}))
            }
            "windowAlpha" => cx
                .update_window(window, |_, window, _| {
                    json!({
                        "alpha": crate::desktop::platform_window::window_alpha(window),
                        "revealedBy": crate::desktop::windows::last_reveal(),
                    })
                })
                .unwrap_or_else(|error| json!({"error": error.to_string()})),
            "tooltip" => {
                let active = crate::tooltip::active();
                #[cfg(target_os = "macos")]
                let (owner_text, tracking_areas) = cx
                    .update_window(window, |_, window, _| {
                        crate::tooltip::native_probe(window, active.as_ref().map_or(0, |a| a.tag))
                    })
                    .unwrap_or((None, 0));
                #[cfg(not(target_os = "macos"))]
                let (owner_text, tracking_areas): (Option<String>, usize) = (None, 0);
                let drawn = crate::tooltip::drawn();
                json!({
                    "mode": crate::tooltip::mode(),
                    "tag": active.as_ref().map(|active| active.tag),
                    "text": active.as_ref().map(|active| active.text.clone()),
                    "rect": active.as_ref().map(|active| active.rect),
                    "drawn": drawn.map(|drawn| drawn.text),
                    "ownerText": owner_text,
                    "trackingAreas": tracking_areas,
                })
            }
            "focusWindow" => {
                let offscreen = std::env::var("RN_GPUI_TEST_OFFSCREEN").as_deref() == Ok("1");
                if !offscreen && crate::desktop::background::enabled() {
                    // A background run is never the operating system's active
                    // application, so the window is made active logically.
                    cx.update(|cx| {
                        crate::desktop::windows::simulate_activation(cx, 1, true)
                            .map(|_| json!({"focused": true}))
                            .unwrap_or_else(|error| error.to_json_value())
                    })
                } else {
                let hwnd = cx.update_window(window, |_, window, _| {
                    if offscreen {
                        return None;
                    }
                    window.activate_window();
                    #[cfg(target_os = "windows")]
                    return window_hwnd(window);
                    #[cfg(not(target_os = "windows"))]
                    None::<isize>
                });
                // The calls send activation messages that re-enter the window
                // procedure, so they run after the window update has returned.
                #[cfg(target_os = "windows")]
                if let Ok(Some(hwnd)) = hwnd {
                    bring_to_front(hwnd);
                }
                match hwnd {
                    Ok(_) => json!({"focused":true}),
                    Err(error) => json!({"error":error.to_string()}),
                }
                }
            }
            "setScrollerStyle" => {
                let legacy = params.get("legacy").and_then(Value::as_bool).unwrap_or(false);
                cx.update(|cx| crate::scroller_style::set_for_test(legacy, cx));
                json!({"legacy": legacy})
            }
            "setWindowActive" => {
                let key = params.get("windowId").and_then(Value::as_u64).unwrap_or(1) as u32;
                let active = params.get("active").and_then(Value::as_bool).unwrap_or(true);
                cx.update(|cx| {
                    crate::desktop::windows::simulate_activation(cx, key, active)
                        .unwrap_or_else(|error| error.to_json_value())
                })
            }
            "focusReadout" => {
                let mirror = crate::desktop::window_mirror::get(1)
                    .and_then(|state| state.get("isFocused").cloned())
                    .unwrap_or(Value::Null);
                #[cfg(target_os = "windows")]
                let mut readout = cx
                    .update_window(window, |_, window, _| window_hwnd(window))
                    .ok()
                    .flatten()
                    .map(focus_readout)
                    .unwrap_or_else(|| json!({}));
                #[cfg(not(target_os = "windows"))]
                let mut readout = json!({});
                readout["mirrorIsFocused"] = mirror;
                readout
            }
            "a11yTree" => {
                let activated = cx
                    .update_window(window, |_, window, _| {
                        static ASKED: std::sync::atomic::AtomicBool =
                            std::sync::atomic::AtomicBool::new(false);
                        if window.is_a11y_active()
                            || ASKED.swap(true, std::sync::atomic::Ordering::Relaxed)
                        {
                            return false;
                        }
                        #[cfg(target_os = "macos")]
                        crate::native_view::activate_accessibility_probe(window);
                        #[cfg(target_os = "windows")]
                        activate_accessibility_probe(window);
                        window.refresh();
                        true
                    })
                    .unwrap_or(false);
                if activated {
                    wait_for_frame(window, cx, Duration::from_millis(16)).await;
                    wait_for_frame(window, cx, Duration::from_millis(16)).await;
                }
                cx.update_window(window, |_, window, _| window.debug_a11y_tree_json())
                    .map(|tree| {
                        tree.and_then(|tree| serde_json::from_str::<Value>(&tree).ok())
                            .unwrap_or(Value::Null)
                    })
                    .unwrap_or_else(|error| json!({"error":error.to_string()}))
            }
            "a11yNode" => {
                #[cfg(target_os = "macos")]
                {
                    let identifier = params
                        .get("identifier")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    cx.update_window(window, |_, window, _| {
                        crate::native_view::test_accessibility_node(window, identifier)
                    })
                    .ok()
                    .flatten()
                    .unwrap_or(Value::Null)
                }
                #[cfg(any(target_os = "linux", target_os = "windows"))]
                {
                    // Resolve through GPUI's own AccessKit tree: the node whose
                    // author id (Element::accessibility_id, set from the React
                    // Native testID) matches. On Linux AccessKit's AT-SPI adapter
                    // publishes the same tree; on Windows it maps the author id
                    // to the UI Automation `AutomationId`, so no external client
                    // is needed to read it back here.
                    #[cfg(target_os = "windows")]
                    let _ = cx.update_window(window, |_, window, _| {
                        activate_accessibility_probe(window);
                        window.refresh();
                    });
                    let identifier = params
                        .get("identifier")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let tree = cx
                        .update_window(window, |_, window, _| window.debug_a11y_tree_json())
                        .ok()
                        .flatten()
                        .and_then(|tree| serde_json::from_str::<Value>(&tree).ok());
                    match tree {
                        None => {
                            json!({"error":"the native accessibility tree is unavailable"})
                        }
                        Some(tree) => {
                            let node = tree
                                .get("nodes")
                                .and_then(Value::as_object)
                                .and_then(|nodes| {
                                    nodes.values().find(|node| {
                                        node.get("author_id").and_then(Value::as_str)
                                            == Some(identifier)
                                            && node
                                                .get("aria")
                                                .and_then(|aria| aria.get("hidden"))
                                                .and_then(Value::as_bool)
                                                != Some(true)
                                    })
                                })
                                .cloned();
                            match node {
                                Some(node) => {
                                    let aria =
                                        node.get("aria").cloned().unwrap_or(Value::Null);
                                    let text = |key: &str| {
                                        aria.get(key).and_then(Value::as_str).unwrap_or("")
                                    };
                                    let label = text("label");
                                    let value = text("value");
                                    json!({
                                        "identifier": identifier,
                                        "name": if label.is_empty() { value } else { label },
                                        "role": text("role"),
                                        "hint": text("description"),
                                        "enabled": aria.get("disabled").and_then(Value::as_bool) != Some(true),
                                    })
                                }
                                None => Value::Null,
                            }
                        }
                    }
                }
                #[cfg(not(any(
                    target_os = "macos",
                    target_os = "linux",
                    target_os = "windows"
                )))]
                {
                    json!({"error":"Native identifier lookup is pending platform testing; use a11yTree"})
                }
            }
            "reload" => {
                // The generation *before* the request: the reload happens on
                // another thread, so the reply carries the value the caller has
                // to wait past, not the one it will end up at.
                let generation = instance_generation();
                // SAFETY: the C++ function takes no arguments and queues a reload.
                unsafe {
                    rn_gpui_request_reload();
                }
                json!({"reloading":true, "generation": generation})
            }
            "setAnimationsEnabled" => match params.get("enabled").and_then(Value::as_bool) {
                Some(enabled) => {
                    crate::animation_policy::set_animations_disabled(!enabled);
                    json!({"enabled": enabled})
                }
                None => {
                    json!({"error": "setAnimationsEnabled requires a boolean enabled value"})
                }
            },
            "setWindowSize" => {
                let width = params.get("width").and_then(Value::as_f64).unwrap_or(0.0) as f32;
                let height = params.get("height").and_then(Value::as_f64).unwrap_or(0.0) as f32;
                if !width.is_finite() || !height.is_finite() || width < 1.0 || height < 1.0 {
                    json!({"error": "setWindowSize requires positive finite width and height"})
                } else {
                    let requested = gpui::size(px(width), px(height));
                    let resized = cx.update_window(window, move |_root, window, app| {
                        window.resize(requested);
                        window.bounds_changed(app);
                    });
                    match resized {
                        Err(error) => json!({"error": error.to_string()}),
                        Ok(()) => {
                            // A window manager applies the resize asynchronously,
                            // so wait (bounded) until the new size takes effect. A
                            // never-mapped window has it immediately.
                            let deadline =
                                std::time::Instant::now() + std::time::Duration::from_secs(2);
                            let reply = loop {
                                let size = cx
                                    .update_window(window, |_, window, app| {
                                        window.bounds_changed(app);
                                        window.viewport_size()
                                    })
                                    .unwrap_or_default();
                                if (f32::from(size.width), f32::from(size.height))
                                    == (width, height)
                                    || std::time::Instant::now() >= deadline
                                {
                                    break json!({
                                        "width": f32::from(size.width),
                                        "height": f32::from(size.height),
                                    });
                                }
                                wait_for_frame(window, cx, std::time::Duration::from_millis(16))
                                    .await;
                            };
                            // React lays the surface out at the new size later: a
                            // resize soon after another is held back for the
                            // store's resize interval, and the layout is a JS
                            // commit. Frames, hit tests and screenshots taken
                            // before it lands see the old layout, so wait
                            // (bounded) until the surface's top views fill it.
                            let deadline =
                                std::time::Instant::now() + std::time::Duration::from_secs(5);
                            let mut laid_out = false;
                            while std::time::Instant::now() < deadline {
                                laid_out = cx.update_entity(&store, |store, cx| {
                                    store.window_layout_matches_size(window, cx)
                                });
                                if laid_out {
                                    break;
                                }
                                wait_for_frame(window, cx, std::time::Duration::from_millis(16))
                                    .await;
                            }
                            let mut reply = reply;
                            reply["laidOut"] = json!(laid_out);
                            reply
                        }
                    }
                }
            }
            "query" | "tree" | "getProps" => {
                let viewport = cx
                    .update_window(window, |_, window, _| {
                        let size = window.viewport_size();
                        RectF {
                            x: 0.0,
                            y: 0.0,
                            w: f32::from(size.width) / crate::desktop::zoom::get(crate::store::APP_SURFACE_ID),
                            h: f32::from(size.height) / crate::desktop::zoom::get(crate::store::APP_SURFACE_ID),
                        }
                    })
                    .unwrap_or_default();
                cx.update_entity(&store, |store, cx| match method {
                    "query" => query(store, &params, viewport, cx),
                    "tree" => tree(store, cx),
                    _ => get_props(store, &params, cx),
                })
            }
            "click" => {
                // A screen transition paints its card away from the frame
                // `node_visible_frame` reports, so a click dispatched now would
                // land next to the node it names (`waitForIdle` waits for it, but
                // a click that follows a push does not always reach that wait).
                // `wait_for_frame` keeps drawing, which is what advances the
                // transition.
                let settle_until = Instant::now() + Duration::from_millis(1_000);
                while Instant::now() < settle_until
                    && cx.update_entity(&store, |store, cx| {
                        store
                            .nodes
                            .values()
                            .any(|node| node.read(cx).transition_active(cx))
                    })
                {
                    if !wait_for_frame(window, cx, Duration::from_millis(16)).await {
                        break;
                    }
                }
                let viewport = cx
                    .update_window(window, |_, window, _| {
                        let size = window.viewport_size();
                        RectF {
                            x: 0.0,
                            y: 0.0,
                            w: f32::from(size.width) / crate::desktop::zoom::get(crate::store::APP_SURFACE_ID),
                            h: f32::from(size.height) / crate::desktop::zoom::get(crate::store::APP_SURFACE_ID),
                        }
                    })
                    .ok();
                let target = viewport.and_then(|viewport| {
                    cx.update_entity(&store, |store, cx| {
                        let tag = params.get("tag").and_then(Value::as_i64)? as i32;
                        if let Some((position, root_tag)) =
                            crate::builtins::native_root::pointer_target(tag)
                        {
                            return Some(Ok((position, root_tag)));
                        }
                        let node = store.nodes.get(&tag)?;
                        if node.read(cx).view.accessibility_disabled {
                            return Some(Err("click target is disabled"));
                        }
                        let frame = node_visible_frame(store, tag, viewport, cx);
                        Some(frame.map_or(Err("click target is not visible"), |frame| {
                            Ok((
                                frame_center(frame, window_offset(store, tag, cx)),
                                tag,
                            ))
                        }))
                    })
                });
                match target {
                    Some(Ok((position, tag))) => {
                        let button = match params.get("button").and_then(Value::as_str) {
                            Some("right") => gpui::MouseButton::Right,
                            Some("middle") => gpui::MouseButton::Middle,
                            Some("back") => gpui::MouseButton::Navigate(gpui::NavigationDirection::Back),
                            Some("forward") => gpui::MouseButton::Navigate(gpui::NavigationDirection::Forward),
                            _ => gpui::MouseButton::Left,
                        };
                        let click_count = params
                            .get("clickCount")
                            .and_then(Value::as_u64)
                            .unwrap_or(1)
                            .clamp(1, 3) as usize;
                        let modifiers = params.get("modifiers").cloned().unwrap_or(Value::Null);
                        let modifiers = gpui::Modifiers {
                            control: modifiers
                                .get("control")
                                .and_then(Value::as_bool)
                                .unwrap_or(false),
                            alt: modifiers
                                .get("alt")
                                .and_then(Value::as_bool)
                                .unwrap_or(false),
                            shift: modifiers
                                .get("shift")
                                .and_then(Value::as_bool)
                                .unwrap_or(false),
                            platform: modifiers
                                .get("platform")
                                .and_then(Value::as_bool)
                                .unwrap_or(false),
                            function: modifiers
                                .get("function")
                                .and_then(Value::as_bool)
                                .unwrap_or(false),
                        };
                        let moved = cx.update_window(window, move |_root, window, app| {
                            draw_frame(window, app);
                            window.dispatch_event(
                                gpui::PlatformInput::MouseMove(gpui::MouseMoveEvent {
                                    position,
                                    pressed_button: None,
                                    ..Default::default()
                                }),
                                app,
                            );
                        });
                        if let Err(error) = moved {
                            json!({"error": error.to_string()})
                        } else {
                            let hit = cx.read_entity(&store, |store, _| {
                                let hit_chain = store.hovered.borrow().clone();
                                (hit_chain.contains(&tag), hit_chain.first().copied())
                            });
                            if !hit.0 {
                                let cover = hit
                                    .1
                                    .and_then(|cover_tag| {
                                        cx.update_entity(&store, |store, cx| {
                                            store.nodes.get(&cover_tag).map(|node| {
                                                let node = node.read(cx);
                                                format!("{} tag={cover_tag}", node.component)
                                            })
                                        })
                                    })
                                    .unwrap_or_else(|| "no hit target".to_owned());
                                json!({"error": format!("click target tag {tag} is covered by {cover}")})
                            } else {
                                let dispatched =
                                    cx.update_window(window, move |_root, window, app| {
                                        draw_frame(window, app);
                                        trace_input_dispatch("input");
                                        window.dispatch_event(
                                            gpui::PlatformInput::MouseDown(gpui::MouseDownEvent {
                                                button,
                                                position,
                                                click_count,
                                                modifiers,
                                                ..Default::default()
                                            }),
                                            app,
                                        );
                                        window.dispatch_event(
                                            gpui::PlatformInput::MouseUp(gpui::MouseUpEvent {
                                                button,
                                                position,
                                                click_count,
                                                modifiers,
                                                ..Default::default()
                                            }),
                                            app,
                                        );
                                    });
                                match dispatched {
                                    Ok(()) => json!({"clicked": true}),
                                    Err(error) => json!({"error": error.to_string()}),
                                }
                            }
                        }
                    }
                    Some(Err(error)) => json!({"error": error}),
                    None => json!({"error": "click requires a mounted tag"}),
                }
            }
            "hover" | "scroll" | "pinch" => {
                let viewport = cx
                    .update_window(window, |_, window, _| {
                        let size = window.viewport_size();
                        RectF {
                            x: 0.0,
                            y: 0.0,
                            w: f32::from(size.width) / crate::desktop::zoom::get(crate::store::APP_SURFACE_ID),
                            h: f32::from(size.height) / crate::desktop::zoom::get(crate::store::APP_SURFACE_ID),
                        }
                    })
                    .ok();
                let target = viewport.and_then(|viewport| {
                    cx.read_entity(&store, |store, cx| {
                        let tag = params.get("tag").and_then(Value::as_i64)? as i32;
                        if let Some((position, root_tag)) =
                            crate::builtins::native_root::pointer_target(tag)
                        {
                            return Some(Ok((root_tag, position)));
                        }
                        let node = store.nodes.get(&tag)?;
                        if node.read(cx).view.accessibility_disabled {
                            return Some(Err("pointer target is disabled"));
                        }
                        Some(node_visible_frame(store, tag, viewport, cx).map_or(
                            Err("pointer target is not visible"),
                            |frame| {
                                Ok((
                                    tag,
                                    frame_center(frame, window_offset(store, tag, cx)),
                                ))
                            },
                        ))
                    })
                });
                match target {
                    Some(Ok((tag, position))) => {
                        let kind = method.to_owned();
                        let dx = params.get("dx").and_then(Value::as_f64).unwrap_or(0.0) as f32;
                        let dy = params.get("dy").and_then(Value::as_f64).unwrap_or(0.0) as f32;
                        let phased = params.get("phase").is_some();
                        let touch_phase = match params.get("phase").and_then(Value::as_str) {
                            Some("started") => gpui::TouchPhase::Started,
                            Some("ended") => gpui::TouchPhase::Ended,
                            _ => gpui::TouchPhase::Moved,
                        };
                        let lines = params.get("lines").and_then(Value::as_bool).unwrap_or(false);
                        let held = |name: &str| {
                            params
                                .get("modifiers")
                                .and_then(|modifiers| modifiers.get(name))
                                .and_then(Value::as_bool)
                                .unwrap_or(false)
                        };
                        let modifiers = gpui::Modifiers {
                            shift: held("shift"),
                            control: held("control"),
                            alt: held("alt"),
                            platform: held("platform"),
                            ..Default::default()
                        };
                        let pinch_delta = params.get("delta").and_then(Value::as_f64).unwrap_or(0.0) as f32;
                        let scroll_delta = if lines {
                            gpui::ScrollDelta::Lines(point(dx, dy))
                        } else {
                            gpui::ScrollDelta::Pixels(point(px(dx), px(dy)))
                        };
                        let preflight = cx.update_window(window, move |_root, window, app| {
                            draw_frame(window, app);
                            window.dispatch_event(
                                gpui::PlatformInput::MouseMove(gpui::MouseMoveEvent {
                                    position,
                                    pressed_button: None,
                                    ..Default::default()
                                }),
                                app,
                            );
                        });
                        let hit = if preflight.is_ok() {
                            Some(cx.read_entity(&store, |store, _| {
                                let chain = store.hovered.borrow().clone();
                                (chain.contains(&tag), chain.first().copied())
                            }))
                        } else {
                            None
                        };
                        let mut draw_ms = 0.0f64;
                        let mut rendered = 0usize;
                        let mut rendered_total = 0usize;
                        let mut a11y_active = false;
                        let interval_ms = params
                            .get("intervalMs")
                            .and_then(Value::as_u64)
                            .unwrap_or(0)
                            .min(200);
                        let repeat = params
                            .get("repeat")
                            .and_then(Value::as_u64)
                            .unwrap_or(1)
                            .clamp(1, 1000);
                        let result: Result<(), String> = match hit {
                            Some((true, _)) if kind == "hover" => Ok(()),
                            Some((true, _)) if kind == "pinch" => cx
                                .update_window(window, |_root, window, app| {
                                    draw_frame(window, app);
                                    window.dispatch_event(
                                        gpui::PlatformInput::Pinch(gpui::PinchEvent {
                                            position,
                                            delta: pinch_delta,
                                            modifiers,
                                            phase: touch_phase,
                                        }),
                                        app,
                                    );
                                    draw_frame(window, app);
                                })
                                .map_err(|error| error.to_string()),
                            Some((true, _)) => cx
                                .update_window(window, |_root, window, app| {
                                    draw_frame(window, app);
                                    if kind == "scroll" && !phased {
                                        // A wheel tick within the latching window of the
                                        // last one belongs to its sequence and stays with
                                        // its container. Each driver scroll is a separate
                                        // gesture, so a tick of the other delta kind that
                                        // moves nothing ends that sequence first.
                                        window.dispatch_event(
                                            gpui::PlatformInput::Scroll(gpui::ScrollEvent {
                                                position,
                                                delta: if lines {
                                                    gpui::ScrollDelta::Pixels(point(px(0.0), px(0.0)))
                                                } else {
                                                    gpui::ScrollDelta::Lines(point(0.0, 0.0))
                                                },
                                                modifiers,
                                                touch_phase,
                                                ..Default::default()
                                            }),
                                            app,
                                        );
                                    }
                                    window.dispatch_event(
                                        gpui::PlatformInput::Scroll(gpui::ScrollEvent {
                                            position,
                                            delta: scroll_delta,
                                            modifiers,
                                            touch_phase,
                                            ..Default::default()
                                        }),
                                        app,
                                    );
                                    a11y_active = window.is_a11y_active();
                                    // Delta k goes out `k * interval_ms` after the
                                    // first, whatever the frames in between cost, so
                                    // a gesture's speed does not depend on how
                                    // loaded the machine is.
                                    let first_sent = std::time::Instant::now();
                                    for step in 0..repeat {
                                        if step > 0 && interval_ms > 0 {
                                            let due = first_sent
                                                + std::time::Duration::from_millis(
                                                    interval_ms * step,
                                                );
                                            let now = std::time::Instant::now();
                                            if due > now {
                                                std::thread::sleep(due - now);
                                            }
                                        }
                                        if step > 0 {
                                            window.dispatch_event(
                                                gpui::PlatformInput::Scroll(
                                                    gpui::ScrollEvent {
                                                        position,
                                                        delta: scroll_delta,
                                                        modifiers,
                                                        touch_phase,
                                                        ..Default::default()
                                                    },
                                                ),
                                                app,
                                            );
                                        }
                                        let rendered_before = crate::node_view::RENDER_COUNT
                                            .load(std::sync::atomic::Ordering::Relaxed);
                                        let started = std::time::Instant::now();
                                        draw_frame(window, app);
                                        draw_ms = started.elapsed().as_secs_f64() * 1000.0;
                                        rendered = crate::node_view::RENDER_COUNT
                                            .load(std::sync::atomic::Ordering::Relaxed)
                                            - rendered_before;
                                        rendered_total += rendered;
                                    }
                                })
                                .map_err(|error| error.to_string()),
                            Some((false, cover_tag)) => {
                                let cover = cover_tag
                                    .and_then(|cover_tag| {
                                        cx.update_entity(&store, |store, cx| {
                                            store.nodes.get(&cover_tag).map(|node| {
                                                let node = node.read(cx);
                                                format!("{} tag={cover_tag}", node.component)
                                            })
                                        })
                                    })
                                    .unwrap_or_else(|| "no hit target".to_owned());
                                Err(format!("{method} target tag {tag} is covered by {cover}"))
                            }
                            None => Err(preflight.err().map_or_else(
                                || "pointer preflight failed".to_owned(),
                                |error| error.to_string(),
                            )),
                        };
                        match result {
                            Ok(()) => json!({"dispatched": true, "drawMs": draw_ms, "renderedViews": rendered, "renderedViewsTotal": rendered_total, "a11yActive": a11y_active}),
                            Err(error) => json!({"error": error}),
                        }
                    }
                    Some(Err(error)) => json!({"error": error}),
                    None => json!({"error": format!("{method} requires a mounted tag")}),
                }
            }
            "mouseDown" | "mouseUp" | "mouseMove" => {
                let x = params.get("x").and_then(Value::as_f64);
                let y = params.get("y").and_then(Value::as_f64);
                if let (Some(x), Some(y)) = (x, y) {
                    if !x.is_finite() || !y.is_finite() {
                        json!({"error":"Pointer coordinates must be finite"})
                    } else {
                        let position = point(px(x as f32), px(y as f32));
                        let button = match params.get("button").and_then(Value::as_str) {
                            Some("right") => gpui::MouseButton::Right,
                            Some("middle") => gpui::MouseButton::Middle,
                            Some("back") => gpui::MouseButton::Navigate(gpui::NavigationDirection::Back),
                            Some("forward") => gpui::MouseButton::Navigate(gpui::NavigationDirection::Forward),
                            _ => gpui::MouseButton::Left,
                        };
                        let modifiers = params.get("modifiers").cloned().unwrap_or(Value::Null);
                        let modifiers = gpui::Modifiers {
                            control: modifiers["control"].as_bool().unwrap_or(false),
                            alt: modifiers["alt"].as_bool().unwrap_or(false),
                            shift: modifiers["shift"].as_bool().unwrap_or(false),
                            platform: modifiers["platform"].as_bool().unwrap_or(false),
                            function: modifiers["function"].as_bool().unwrap_or(false),
                        };
                        // A button pressed by this driver stays held until it is
                        // released, so a move in between is a drag, as with a mouse.
                        static HELD: std::sync::Mutex<Option<gpui::MouseButton>> =
                            std::sync::Mutex::new(None);
                        let held = {
                            let mut held = HELD.lock().unwrap_or_else(|e| e.into_inner());
                            match method {
                                "mouseDown" => *held = Some(button),
                                "mouseUp" => *held = None,
                                _ => {}
                            }
                            *held
                        };
                        let event = match method {
                            "mouseDown" => gpui::PlatformInput::MouseDown(gpui::MouseDownEvent {
                                position,
                                button,
                                modifiers,
                                click_count: params
                                    .get("clickCount")
                                    .and_then(Value::as_u64)
                                    .unwrap_or(1)
                                    .clamp(1, 3) as usize,
                                ..Default::default()
                            }),
                            "mouseUp" => gpui::PlatformInput::MouseUp(gpui::MouseUpEvent {
                                position,
                                button,
                                modifiers,
                                ..Default::default()
                            }),
                            _ => gpui::PlatformInput::MouseMove(gpui::MouseMoveEvent {
                                position,
                                modifiers,
                                pressed_button: params
                                    .get("button")
                                    .and_then(Value::as_str)
                                    .map(|_| button)
                                    .or(held),
                                ..Default::default()
                            }),
                        };
                        cx.update_window(window, move |_, window, app| {
                            let clear = window.draw(app);
                            clear.clear(app);
                            window.dispatch_event(event, app);
                            json!({"dispatched":true})
                        })
                        .unwrap_or_else(|error| json!({"error":error.to_string()}))
                    }
                } else {
                    json!({"error":"Pointer command requires x and y"})
                }
            }
            "dragFiles" | "dropFiles" | "dragFilesExit" => {
                let x = params.get("x").and_then(Value::as_f64).unwrap_or(0.0) as f32;
                let y = params.get("y").and_then(Value::as_f64).unwrap_or(0.0) as f32;
                let position = point(px(x), px(y));
                let paths: Vec<std::path::PathBuf> = params
                    .get("paths")
                    .and_then(Value::as_array)
                    .map(|paths| {
                        paths
                            .iter()
                            .filter_map(Value::as_str)
                            .map(std::path::PathBuf::from)
                            .collect()
                    })
                    .unwrap_or_default();
                let method = method.to_owned();
                cx.update_window(window, move |_, window, app| {
                    draw_frame(window, app);
                    let mut send = |event: gpui::FileDropEvent| {
                        window.dispatch_event(gpui::PlatformInput::FileDrop(event), app);
                        draw_frame(window, app);
                    };
                    match method.as_str() {
                        "dragFiles" => {
                            if !paths.is_empty() {
                                send(gpui::FileDropEvent::Entered {
                                    position,
                                    paths: gpui::ExternalPaths(paths.into_iter().collect()),
                                });
                            }
                            send(gpui::FileDropEvent::Pending { position });
                        }
                        "dropFiles" => {
                            send(gpui::FileDropEvent::Submit { position });
                            send(gpui::FileDropEvent::Ended);
                        }
                        _ => {
                            send(gpui::FileDropEvent::Exited);
                            send(gpui::FileDropEvent::Ended);
                        }
                    }
                    json!({"dispatched": true})
                })
                .unwrap_or_else(|error| json!({"error": error.to_string()}))
            }
            "focus" => {
                let node = params
                    .get("tag")
                    .and_then(Value::as_i64)
                    .and_then(|tag| store.read_with(cx, |store, _| store.nodes.get(&(tag as i32)).cloned()));
                cx.update_window(window, move |_, window, app| {
                    match node.and_then(|node| crate::node_view::RNNodeView::press_focus_handle(&node, window, app)) {
                        Some(handle) => {
                            window.focus(&handle, app);
                            draw_frame(window, app);
                            json!({"focused": true})
                        }
                        None => json!({"error": "Target has no focusable ancestor"}),
                    }
                })
                .unwrap_or_else(|error| json!({"error": error.to_string()}))
            },
            "press" => {
                let key = params.get("key").and_then(Value::as_str).unwrap_or("");
                let key = key.replace(
                    "mod-",
                    if cfg!(target_os = "macos") {
                        "cmd-"
                    } else {
                        "ctrl-"
                    },
                );
                // Modifiers first, the key last: `mod-ArrowDown`, `shift-PageUp`.
                let key = match key.rsplit_once('-') {
                    Some((modifiers, name)) if !name.is_empty() => {
                        format!("{modifiers}-{}", crate::desktop::keymap::gpui_key_name(name))
                    }
                    _ => crate::desktop::keymap::gpui_key_name(&key),
                };
                match gpui::Keystroke::parse_with_os(&key, crate::desktop::keymap::host_os()) {
                    Ok(keystroke) => {
                        let dispatched = cx.update_window(window, move |_root, window, app| {
                            draw_frame(window, app);
                            window.dispatch_keystroke(keystroke.clone(), app);
                            window.dispatch_event(
                                gpui::PlatformInput::KeyUp(gpui::KeyUpEvent { keystroke }),
                                app,
                            );
                        });
                        match dispatched {
                            Ok(()) => json!({"dispatched": true}),
                            Err(error) => json!({"error": error.to_string()}),
                        }
                    }
                    Err(error) => json!({"error": format!("invalid keystroke {key:?}: {error}")}),
                }
            }
            "ime" => {
                let tag = params.get("tag").and_then(Value::as_i64).unwrap_or(0) as i32;
                let steps = params
                    .get("steps")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let target = cx.update_entity(&store, |store, cx| {
                    if let Some((position, _)) = crate::builtins::native_root::pointer_target(tag) {
                        return Some(position);
                    }
                    let node = store.nodes.get(&tag)?.read(cx);
                    if node.component != "TextInput" || !node.input().editable {
                        return None;
                    }
                    node_frame(store, tag, cx)
                        .map(|frame| frame_center(frame, window_offset(store, tag, cx)))
                });
                match target {
                    None => json!({"error": "ime requires a mounted, editable text input"}),
                    Some(position) => {
                        let store = store.clone();
                        let result = cx.update_window(window, move |_root, window, app| {
                            draw_frame(window, app);
                            let focused = store
                                .read(app)
                                .nodes
                                .get(&tag)
                                .and_then(|node| node.read(app).accessibility_focus_handle())
                                .is_some_and(|handle| handle.is_focused(window));
                            if !focused {
                                window.dispatch_event(
                                    gpui::PlatformInput::MouseDown(gpui::MouseDownEvent {
                                        button: gpui::MouseButton::Left,
                                        position,
                                        ..Default::default()
                                    }),
                                    app,
                                );
                                window.dispatch_event(
                                    gpui::PlatformInput::MouseUp(gpui::MouseUpEvent {
                                        button: gpui::MouseButton::Left,
                                        position,
                                        ..Default::default()
                                    }),
                                    app,
                                );
                            }
                            draw_frame(window, app);
                            let mut all = true;
                            for step in &steps {
                                if let Some(text) = step.get("mark").and_then(Value::as_str) {
                                    all &= window.simulate_marked_text(text, app);
                                } else if let Some(text) =
                                    step.get("commit").and_then(Value::as_str)
                                {
                                    all &= window.simulate_committed_text(text, app);
                                }
                                draw_frame(window, app);
                            }
                            all
                        });
                        match result {
                            Ok(true) => json!({"composed": true}),
                            Ok(false) => json!({"error": "focused view has no text input handler"}),
                            Err(error) => json!({"error": error.to_string()}),
                        }
                    }
                }
            }
            "type" => {
                let target = cx.update_entity(&store, |store, cx| {
                    let tag = params.get("tag").and_then(Value::as_i64)? as i32;
                    if let Some((position, _)) = crate::builtins::native_root::pointer_target(tag) {
                        return Some(position);
                    }
                    let entity = store.nodes.get(&tag)?;
                    let node = entity.read(cx);
                    if node.component != "TextInput" || !node.input().editable {
                        return None;
                    }
                    node_frame(store, tag, cx).map(|frame| {
                        frame_center(frame, window_offset(store, tag, cx))
                    })
                });
                let text = params
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                match target {
                    None => json!({"error": "type requires a mounted, editable TextInput"}),
                    Some(position) => {
                        let tag = params.get("tag").and_then(Value::as_i64).unwrap_or(0) as i32;
                        let store = store.clone();
                        let dispatched = cx.update_window(window, move |_root, window, app| {
                            draw_frame(window, app);
                            let focused = store
                                .read(app)
                                .nodes
                                .get(&tag)
                                .and_then(|node| node.read(app).accessibility_focus_handle())
                                .is_some_and(|handle| handle.is_focused(window));
                            if !focused {
                                window.dispatch_event(
                                    gpui::PlatformInput::MouseDown(gpui::MouseDownEvent {
                                        button: gpui::MouseButton::Left,
                                        position,
                                        ..Default::default()
                                    }),
                                    app,
                                );
                                window.dispatch_event(
                                    gpui::PlatformInput::MouseUp(gpui::MouseUpEvent {
                                        button: gpui::MouseButton::Left,
                                        position,
                                        ..Default::default()
                                    }),
                                    app,
                                );
                            }
                            // Focusing can install a new InputHandler during
                            // paint. Native OS input arrives on a later turn;
                            // synthetic typing must complete that paint first.
                            draw_frame(window, app);
                            let keystroke = gpui::Keystroke {
                                modifiers: Default::default(),
                                key: "a".to_owned(),
                                key_char: Some(text),
                            };
                            trace_input_dispatch("input");
                            let handled = window.dispatch_keystroke(keystroke.clone(), app);
                            window.dispatch_event(
                                gpui::PlatformInput::KeyUp(gpui::KeyUpEvent { keystroke }),
                                app,
                            );
                            handled
                        });
                        match dispatched {
                            Ok(true) => json!({"typed": true}),
                            Ok(false) => json!({"error": "focused view has no text input handler"}),
                            Err(error) => json!({"error": error.to_string()}),
                        }
                    }
                }
            }
            "drag" => {
                let points = cx.update_entity(&store, |store, cx| {
                    let from_tag = params.get("fromTag").and_then(Value::as_i64)? as i32;
                    let to_tag = params.get("toTag").and_then(Value::as_i64)? as i32;
                    let from = node_frame(store, from_tag, cx)?;
                    let to = node_frame(store, to_tag, cx)?;
                    Some((
                        frame_center(from, window_offset(store, from_tag, cx)),
                        frame_center(to, window_offset(store, to_tag, cx)),
                    ))
                });
                match points {
                    None => json!({"error": "drag requires mounted source and destination tags"}),
                    Some((start, end)) => {
                        let from_tag = params
                            .get("fromTag")
                            .and_then(Value::as_i64)
                            .unwrap_or_default() as i32;
                        let preflight = cx.update_window(window, move |_root, window, app| {
                            draw_frame(window, app);
                            window.dispatch_event(
                                gpui::PlatformInput::MouseMove(gpui::MouseMoveEvent {
                                    position: start,
                                    pressed_button: None,
                                    ..Default::default()
                                }),
                                app,
                            );
                        });
                        if let Err(error) = preflight {
                            json!({"error": format!("drag pointer preflight failed: {error}")})
                        } else {
                            let hit = cx.read_entity(&store, |store, _| {
                                let chain = store.hovered.borrow().clone();
                                (chain.contains(&from_tag), chain.first().copied())
                            });
                            if !hit.0 {
                                let cover = hit
                                    .1
                                    .and_then(|cover_tag| {
                                        cx.update_entity(&store, |store, cx| {
                                            store.nodes.get(&cover_tag).map(|node| {
                                                let node = node.read(cx);
                                                format!("{} tag={cover_tag}", node.component)
                                            })
                                        })
                                    })
                                    .unwrap_or_else(|| "no hit target".to_owned());
                                json!({"error": format!("drag source tag {from_tag} is covered by {cover}")})
                            } else {
                                let steps = params
                                    .get("steps")
                                    .and_then(Value::as_u64)
                                    .unwrap_or(8)
                                    .clamp(1, 120)
                                    as usize;
                                let duration_ms = if crate::animation_policy::animations_disabled()
                                {
                                    0
                                } else {
                                    params
                                        .get("duration")
                                        .and_then(Value::as_u64)
                                        .unwrap_or(128)
                                        .min(10_000)
                                };
                                let down = cx.update_window(window, move |_root, window, app| {
                                    draw_frame(window, app);
                                    window.dispatch_event(
                                        gpui::PlatformInput::MouseDown(gpui::MouseDownEvent {
                                            button: gpui::MouseButton::Left,
                                            position: start,
                                            click_count: 1,
                                            ..Default::default()
                                        }),
                                        app,
                                    );
                                });
                                if let Err(error) = down {
                                    json!({"error": error.to_string()})
                                } else {
                                    cx.read_entity(&store, |store, _| store.host.clone())
                                        .on_render();
                                    wait_for_frame(window, cx, Duration::from_millis(16)).await;
                                    let mut failure = None;
                                    for step in 1..=steps {
                                        let progress = step as f32 / steps as f32;
                                        let position = point(
                                            px(f32::from(start.x)
                                                + (f32::from(end.x) - f32::from(start.x))
                                                    * progress),
                                            px(f32::from(start.y)
                                                + (f32::from(end.y) - f32::from(start.y))
                                                    * progress),
                                        );
                                        let moved =
                                            cx.update_window(window, move |_root, window, app| {
                                                draw_frame(window, app);
                                                window.dispatch_event(
                                                    gpui::PlatformInput::MouseMove(
                                                        gpui::MouseMoveEvent {
                                                            position,
                                                            pressed_button: Some(
                                                                gpui::MouseButton::Left,
                                                            ),
                                                            ..Default::default()
                                                        },
                                                    ),
                                                    app,
                                                );
                                                window.refresh();
                                            });
                                        if let Err(error) = moved {
                                            failure = Some(error.to_string());
                                            break;
                                        }
                                        cx.read_entity(&store, |store, _| store.host.clone())
                                            .on_render();
                                        cx.background_executor()
                                            .timer(Duration::from_millis(
                                                (duration_ms / steps as u64).max(16),
                                            ))
                                            .await;
                                    }
                                    let released =
                                        cx.update_window(window, move |_root, window, app| {
                                            window.dispatch_event(
                                                gpui::PlatformInput::MouseUp(gpui::MouseUpEvent {
                                                    button: gpui::MouseButton::Left,
                                                    position: end,
                                                    ..Default::default()
                                                }),
                                                app,
                                            );
                                        });
                                    match failure
                                        .or_else(|| released.err().map(|error| error.to_string()))
                                    {
                                        Some(error) => json!({"error": error}),
                                        None => json!({"dragged": true, "steps": steps}),
                                    }
                                }
                            }
                        }
                    }
                }
            }
            "idleStatus" => {
                let ignore = ignore_sources(&params);
                let ignore_urls = ignore_url_patterns(&params);
                cx.update_entity(&store, |store, cx| {
                    idle_status(store, cx, &ignore, &ignore_urls, None)
                })
            }
            "waitForIdle" => {
                let ignore = ignore_sources(&params);
                let ignore_urls = ignore_url_patterns(&params);
                let timeout_ms = params
                    .get("timeout")
                    .and_then(Value::as_u64)
                    .unwrap_or(5_000)
                    .clamp(100, 30_000);
                let started = std::time::Instant::now();
                let mut stable_frames = 0u8;
                let mut status = json!({"idle": false, "stableFrames": 0});
                loop {
                    let remaining =
                        Duration::from_millis(timeout_ms).saturating_sub(started.elapsed());
                    if remaining.is_zero() {
                        break;
                    }
                    if !wait_for_frame(window, cx, remaining.min(Duration::from_millis(250))).await
                    {
                        continue;
                    }
                    let sources_idle = cx.update_entity(&store, |store, cx| {
                        idle_status(store, cx, &ignore, &ignore_urls, None)["idle"] == json!(true)
                    });
                    stable_frames = if sources_idle {
                        stable_frames.saturating_add(1).min(2)
                    } else {
                        0
                    };
                    status = cx.update_entity(&store, |store, cx| {
                        idle_status(store, cx, &ignore, &ignore_urls, Some(stable_frames))
                    });
                    if status.get("idle").and_then(Value::as_bool) == Some(true) {
                        break;
                    }
                }
                if status.get("idle").and_then(Value::as_bool) != Some(true) {
                    status = cx.update_entity(&store, |store, cx| {
                        idle_status(store, cx, &ignore, &ignore_urls, Some(stable_frames))
                    });
                    status["timeout"] = json!(true);
                }
                status
            }
            "screenshot" => {
                let path = std::env::temp_dir().join(format!(
                    "rn-gpui-test-{}-{}.png",
                    std::process::id(),
                    id.as_u64().unwrap_or(0)
                ));
                let tag = params
                    .get("tag")
                    .and_then(Value::as_i64)
                    .map(|tag| tag as i32);
                let (viewport, scale) = cx
                    .update_window(window, |_, window, _| {
                        let size = window.viewport_size();
                        (
                            RectF {
                                x: 0.0,
                                y: 0.0,
                                w: f32::from(size.width) / crate::desktop::zoom::get(crate::store::APP_SURFACE_ID),
                                h: f32::from(size.height) / crate::desktop::zoom::get(crate::store::APP_SURFACE_ID),
                            },
                            window.scale_factor(),
                        )
                    })
                    .unwrap_or((
                        RectF {
                            x: 0.0,
                            y: 0.0,
                            w: 0.0,
                            h: 0.0,
                        },
                        1.0,
                    ));
                let frame = tag.and_then(|tag| {
                    cx.update_entity(&store, |store, cx| {
                        node_visible_frame(store, tag, viewport, cx)
                            .map(|frame| (frame, window_offset(store, tag, cx)))
                    })
                });
                let capture_started = Instant::now();
                // An element is drawn as its own device-pixel region of the
                // frame, not as the whole frame cropped afterwards.
                let captured = cx.update_window(window, |_root, window, app| {
                    draw_frame(window, app);
                    match frame {
                        Some((frame, offset)) => {
                            let size = window.viewport_size();
                            let (width, height) = (
                                (f32::from(size.width) * scale).round() as i32,
                                (f32::from(size.height) * scale).round() as i32,
                            );
                            match device_region(frame, offset, scale, width, height) {
                                Some((x, y, w, h)) => window
                                    .render_region_to_image(gpui::Bounds {
                                        origin: point(
                                            gpui::DevicePixels(x),
                                            gpui::DevicePixels(y),
                                        ),
                                        size: gpui::size(
                                            gpui::DevicePixels(w),
                                            gpui::DevicePixels(h),
                                        ),
                                    })
                                    .map(Some),
                                None => Ok(None),
                            }
                        }
                        None => window.render_to_image().map(Some),
                    }
                });
                if std::env::var_os("RN_GPUI_TEST_SCREENSHOT_TIMING").is_some() {
                    eprintln!(
                        "[rn-gpui-test] screenshot tag={:?} capture_ms={:.1}",
                        tag,
                        capture_started.elapsed().as_secs_f64() * 1000.0
                    );
                }
                match captured {
                    Ok(Ok(image)) => {
                        if tag.is_some() && frame.is_none() {
                            json!({"error": "screenshot target is not mounted or visible"})
                        } else {
                            match image {
                                None => json!({"error": "screenshot target has no visible pixels"}),
                                Some(image) => match image.save(&path) {
                                    Ok(()) => match std::fs::read(&path) {
                                        Ok(bytes) => {
                                            let _ = std::fs::remove_file(&path);
                                            json!({"png": base64::engine::general_purpose::STANDARD.encode(bytes)})
                                        }
                                        Err(error) => json!({"error": error.to_string()}),
                                    },
                                    Err(error) => json!({"error": error.to_string()}),
                                },
                            }
                        }
                    }
                    Ok(Err(error)) => json!({"error": error.to_string()}),
                    Err(error) => json!({"error": error.to_string()}),
                }
            }
            "getAppMenu" => cx.update(|cx| crate::desktop::app_menu::menu_json(cx)),
            "triggerMenuItem" => {
                let id = params
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                cx.update(|cx| {
                    crate::desktop::app_menu::trigger_item(cx, &id);
                    json!({"triggered": id})
                })
            }
            "showDevMenu" => cx.update(|cx| {
                crate::desktop::dev_menu::show(cx);
                json!({"shown": true})
            }),
            "closeDevMenu" => cx.update(|cx| {
                crate::desktop::dev_menu::hide(cx);
                json!({"closed": true})
            }),
            "devMenuState" => cx.update(|cx| {
                let open = cx
                    .try_global::<crate::desktop::dev_menu::DevMenuPanelGlobal>()
                    .is_some_and(|panel| panel.0.borrow().is_some());
                let model = crate::desktop::dev_menu::menu_model(cx);
                json!({
                    "installed": crate::desktop::dev_menu::is_installed(cx),
                    "open": open,
                    "items": crate::desktop::context_menu::nodes_json(&model.items),
                })
            }),
            "getDevMenu" => cx.update(|cx| {
                let model = crate::desktop::dev_menu::menu_model(cx);
                json!({"items": crate::desktop::context_menu::nodes_json(&model.items)})
            }),
            "devMenuPerform" => {
                let id = params
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                cx.update(|cx| {
                    crate::desktop::dev_menu::perform(cx, &id);
                    json!({"performed": id})
                })
            }
            "getPerfMonitor" => cx.update(|cx| crate::desktop::perf_monitor::metrics(cx)),
            "trayInstall" => cx.update(|cx| {
                let mut config = crate::desktop::tray::TrayConfig::default();
                if let Some(id) = params.get("id").and_then(Value::as_str) {
                    config.id = id.to_string();
                }
                if let Some(tooltip) = params.get("tooltip").and_then(Value::as_str) {
                    config.tooltip = Some(tooltip.to_string());
                }
                if let Some(component) = params.get("component").and_then(Value::as_str) {
                    config.component = Some(component.to_string());
                }
                if let Some(menu) = params.get("menu") {
                    match crate::desktop::menu_model::parse_menu(menu) {
                        Ok(menu) => config.menu = Some(menu),
                        Err(error) => return error.to_json_value(),
                    }
                }
                if let Some(quit) = params
                    .get("quitOnLastWindowClosed")
                    .and_then(Value::as_bool)
                {
                    config.quit_on_last_window_closed = quit;
                }
                if let Some(hide) = params.get("hideWindowOnClose").and_then(Value::as_bool) {
                    config.hide_window_on_close = hide;
                }
                crate::desktop::tray::install(cx, config)
                    .unwrap_or_else(|error| error.to_json_value())
            }),
            "trayState" => cx.update(|cx| crate::desktop::tray::state(cx)),
            "trayClick" => {
                let rect = crate::desktop::tray::TrayRect {
                    x: params.get("x").and_then(Value::as_f64).unwrap_or(0.0) as f32,
                    y: params.get("y").and_then(Value::as_f64).unwrap_or(0.0) as f32,
                    width: params.get("width").and_then(Value::as_f64).unwrap_or(24.0) as f32,
                    height: params.get("height").and_then(Value::as_f64).unwrap_or(24.0) as f32,
                };
                let button = match params.get("button").and_then(Value::as_str) {
                    Some("right") => crate::desktop::tray::TrayButton::Right,
                    Some("middle") => crate::desktop::tray::TrayButton::Middle,
                    _ => crate::desktop::tray::TrayButton::Left,
                };
                cx.update(|cx| {
                    crate::desktop::tray::handle_click(cx, rect, button);
                    crate::desktop::tray::state(cx)
                })
            }
            "trayHide" => cx.update(|cx| {
                crate::desktop::tray::hide_popover(cx);
                crate::desktop::tray::state(cx)
            }),
            "trayDestroy" => cx.update(|cx| {
                crate::desktop::tray::destroy(cx)
                    .unwrap_or_else(|error| error.to_json_value())
            }),
            "menuBarState" => cx.update(|cx| {
                json!({
                    "enabled": crate::desktop::gpui_menu::should_use_gpui_menu_bar(),
                    "inset": crate::desktop::gpui_menu::menu_bar_inset_for_window_id(
        crate::desktop::windows::MAIN_WINDOW_KEY,
    ),
                    "titles": crate::desktop::gpui_menu::menu_bar_entries(cx)
                        .into_iter()
                        .map(|(label, _)| label)
                        .collect::<Vec<_>>(),
                })
            }),
            "openMenuBarMenu" => {
                let title = params
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                cx.update(|cx| {
                    json!({"opened": crate::desktop::gpui_menu::open_menu_bar_menu(cx, &title)})
                })
            }
            "clipboardText" => cx.update(|cx| {
                json!({"text": cx.read_from_clipboard().and_then(|item| item.text())})
            }),
            "setClipboardText" => {
                let text = params
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                cx.update(|cx| {
                    cx.write_to_clipboard(gpui::ClipboardItem::new_string(text));
                    json!({"set": true})
                })
            }
            "contextMenuPresenter" => {
                cx.update(|cx| json!({"presenter": crate::desktop::context_menu::presenter_name(cx)}))
            }
            "gpuiMenuState" => cx.update(|cx| match crate::desktop::gpui_menu::MenuPopup::pending(cx) {
                Some((_window, items)) => json!({
                    "open": true,
                    "items": crate::desktop::context_menu::nodes_json(&items),
                }),
                None => json!({"open": false}),
            }),
            "selectGpuiMenuItem" => {
                let id = params
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                cx.update(|cx| json!({"selected": crate::desktop::gpui_menu::MenuPopup::select(cx, &id)}))
            }
            "dismissGpuiMenu" => cx.update(|cx| {
                json!({"dismissed": crate::desktop::gpui_menu::MenuPopup::dismiss(cx)})
            }),
            "getContextMenu" => cx.update(|cx| {
                crate::desktop::context_menu::fake_model(cx).unwrap_or(Value::Null)
            }),
            "selectContextMenuItem" => {
                let id = params
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                cx.update(|cx| {
                    json!({"selected": crate::desktop::context_menu::fake_select(cx, &id)})
                })
            }
            "dismissContextMenu" => cx.update(|cx| {
                json!({"dismissed": crate::desktop::context_menu::fake_dismiss(cx)})
            }),
            "windowClose" => {
                let key = params.get("windowId").and_then(Value::as_u64).unwrap_or(0) as u32;
                let force = params.get("force").and_then(Value::as_bool).unwrap_or(false);
                cx.update(|cx| {
                    crate::desktop::windows::close_window(cx, key, force)
                        .unwrap_or_else(|error| error.to_json_value())
                })
            }
            // What the window's close button does first when a Modal is shown.
            "modalCloseRequest" => cx
                .update_window(window, |_, window, app| {
                    json!({"handled": crate::desktop::windows::request_modal_close(window, app)})
                })
                .unwrap_or_else(|error| json!({"error": error.to_string()})),
            "osCloseWindow" => {
                let key = params.get("windowId").and_then(Value::as_u64).unwrap_or(0) as u32;
                cx.update(|cx| json!({"closed": crate::desktop::windows::os_close(cx, key)}))
            }
            "menuBarIcons" => json!({
                "titles": crate::desktop::app_menu::menu_bar_image_titles(),
            }),
            "appReopen" => cx.update(|cx| {
                crate::desktop::windows::reopen(cx);
                crate::desktop::windows::list_windows(cx).unwrap_or(Value::Null)
            }),
            // Stands in for the OS opening one of the app's URL schemes.
            "openUrl" => {
                let url = params
                    .get("url")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                crate::desktop::deep_link::handle_url(url);
                json!({"delivered": true})
            }
            #[cfg(target_os = "macos")]
            "shareOpen" => json!({
                "open": crate::builtins::share::mac::is_open(),
                "anchor": crate::builtins::share::mac::last_anchor()
                    .map(|(x, y, w, h, flipped)| json!({"x": x, "y": y, "width": w, "height": h, "flipped": flipped})),
            }),
            #[cfg(target_os = "macos")]
            "shareChoose" => {
                let name = params.get("service").and_then(Value::as_str);
                json!({"sent": crate::builtins::share::mac::simulate_choice(name)})
            }
            "alertState" => cx.update(|cx| {
                crate::builtins::alert::dialog::describe(cx).unwrap_or_else(|| {
                    #[cfg(target_os = "macos")]
                    {
                        crate::builtins::alert::mac::describe().unwrap_or(Value::Null)
                    }
                    #[cfg(not(target_os = "macos"))]
                    {
                        Value::Null
                    }
                })
            }),
            "alertRespond" => {
                let button = params.get("button").and_then(Value::as_u64).unwrap_or(0) as usize;
                let texts: Vec<String> = params
                    .get("texts")
                    .and_then(Value::as_array)
                    .map(|texts| {
                        texts
                            .iter()
                            .filter_map(|text| text.as_str().map(str::to_string))
                            .collect()
                    })
                    .unwrap_or_default();
                let responded = cx.update(|cx| {
                    if crate::builtins::alert::dialog::respond(cx, button, &texts) {
                        return true;
                    }
                    #[cfg(target_os = "macos")]
                    {
                        crate::builtins::alert::mac::respond(button, &texts)
                    }
                    #[cfg(not(target_os = "macos"))]
                    {
                        false
                    }
                });
                json!({ "responded": responded })
            }
            "alertEscape" => cx.update(|cx| {
                if crate::builtins::alert::dialog::press_escape(cx) {
                    return json!({"sent": true});
                }
                #[cfg(target_os = "macos")]
                {
                    json!({"sent": crate::builtins::alert::mac::press_escape()})
                }
                #[cfg(not(target_os = "macos"))]
                {
                    json!({"sent": false})
                }
            }),
            "listWindows" => cx.update(|cx| {
                crate::desktop::windows::list_windows(cx).unwrap_or(Value::Null)
            }),
            // One window's state, by the id `listWindows` gives it. The popover is
            // not the main window, so `getWindowBounds` cannot answer for it.
            "windowState" => {
                let key = params.get("windowId").and_then(Value::as_u64).unwrap_or(0) as u32;
                cx.update(|cx| {
                    let mut state = crate::desktop::windows::window_state(cx, key)
                        .unwrap_or_else(|error| error.to_json_value());
                    if let Some(object) = state.as_object_mut() {
                        object.insert(
                            "nativeFrame".to_string(),
                            crate::desktop::windows::native_frame_json(cx, key),
                        );
                    }
                    state
                })
            }
            _ => json!({"error": format!("unknown test-driver method: {method}")}),
        };

        if matches!(
            method,
            "click"
                | "hover"
                | "scroll"
                | "press"
                | "type"
                | "mouseDown"
                | "mouseUp"
                | "mouseMove"
                | "drag"
        ) {
            cx.read_entity(&store, |store, _| store.host.clone())
                .on_render();
        }
        let _ = request
            .reply
            .send(json!({"jsonrpc":"2.0", "id": id, "result": result}));
    }
}

/// A forced draw does not run the compositor's frame callbacks, so this also
/// advances any host-driven screen transition.
fn draw_frame(window: &mut gpui::Window, app: &mut App) {
    let needs_clear = window.draw(app);
    needs_clear.clear(app);
    crate::events::flush_hover_retarget(window, app);
    let Some(store) = app.try_global::<crate::store::StoreGlobal>() else {
        return;
    };
    let store = store.0.clone();
    let transitioning: Vec<Entity<RNNodeView>> = {
        let store = store.read(app);
        let mut tracked = store.transitioning.borrow_mut();
        tracked.retain(|tag| {
            store
                .nodes
                .get(tag)
                .is_some_and(|node| node.read(app).transition_active(app))
        });
        tracked
            .iter()
            .filter_map(|tag| store.nodes.get(tag).cloned())
            .collect()
    };
    for node in transitioning {
        node.update(app, |_, cx| cx.notify());
    }
}

/// A window the driver can draw.
///
/// The handle the driver was started with is the main window's, and a test that
/// closes it leaves the handle dead: every draw then fails and a caller that
/// waits for frames spins until its timeout. The remaining windows are still
/// real, so fall back to one of them.
fn drawable_window(window: AnyWindowHandle, cx: &mut gpui::AsyncApp) -> Option<AnyWindowHandle> {
    if cx.update_window(window, |_, _, _| ()).is_ok() {
        return Some(window);
    }
    let windows = cx.update(|cx| {
        cx.try_global::<crate::desktop::windows::DesktopWindowsGlobal>()
            .map(|windows| {
                windows
                    .0
                    .keys()
                    .into_iter()
                    .filter_map(|key| windows.0.get(key).map(|entry| entry.handle))
                    .collect::<Vec<_>>()
            })
    })?;
    windows
        .into_iter()
        .find(|candidate| cx.update_window(*candidate, |_, _, _| ()).is_ok())
}

async fn wait_for_frame(
    window: AnyWindowHandle,
    cx: &mut gpui::AsyncApp,
    timeout: Duration,
) -> bool {
    let drawn = drawable_window(window, cx).is_some_and(|window| {
        cx.update_window(window, move |_root, window, app| {
            draw_frame(window, app);
            // A forced draw does not run the compositor's frame callbacks.
            // Deliver Fabric's EventBeat too, so buffered native events reach JS.
            let host = app
                .try_global::<crate::store::StoreGlobal>()
                .map(|store| store.0.read(app).host.clone());
            if let Some(host) = host {
                host.on_render();
            }
        })
        .is_ok()
    });
    if !drawn {
        // No window could be drawn: none is open yet, or it is in the middle of
        // an update. Callers retry in a loop, and returning at once never
        // yields the main thread, so the window could not open or finish its
        // update until their timeout ran out. Give the app a frame first.
        cx.background_executor()
            .timer(timeout.min(Duration::from_millis(16)))
            .await;
        return false;
    }

    // The pause after a forced draw lets JS answer the frame's events. A test
    // does not need a display's 16 ms for that: 4 ms halves the cost of every
    // idle wait. 1 ms was fast enough to let a scroll bar hover race ahead of
    // the thumb under load, so `RN_GPUI_TEST_FRAME_MS` stays an override.
    static FRAME_MS: std::sync::OnceLock<u64> = std::sync::OnceLock::new();
    let frame_ms = *FRAME_MS.get_or_init(|| {
        std::env::var("RN_GPUI_TEST_FRAME_MS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(4)
    });
    let interval = timeout.min(Duration::from_millis(frame_ms));
    cx.background_executor().timer(interval).await;
    true
}

fn ignore_sources(params: &Value) -> Vec<String> {
    params
        .get("ignore")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn ignore_url_patterns(params: &Value) -> Vec<String> {
    params
        .get("ignoreUrls")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .filter(|pattern| !pattern.contains('\n'))
        .collect()
}

fn idle_status(
    store: &ViewStore,
    cx: &gpui::App,
    ignore: &[String],
    ignore_urls: &[String],
    stable_frames: Option<u8>,
) -> Value {
    let mut busy = Vec::new();
    // SAFETY: these C++ probes take no pointers and only read counters.
    let js_tasks = unsafe { rn_gpui_pending_js_tasks() };
    if (js_tasks > 0 || unsafe { rn_gpui_reload_in_progress() })
        && !ignore.iter().any(|item| item == "js")
    {
        let mut detail = format!("{js_tasks} queued or running JS task(s)");
        if std::env::var_os("RN_GPUI_DEBUG_JS_TASKS").is_some() {
            let mut buffer = vec![0u8; 64 * 1024];
            // SAFETY: the buffer is valid for the capacity given, and the call
            // writes at most that many bytes.
            let length =
                unsafe { rn_gpui_pending_js_tasks_dump(buffer.as_mut_ptr(), buffer.len() as u64) }
                    as usize;
            buffer.truncate(length.min(buffer.len()));
            detail.push_str(":\n");
            detail.push_str(&String::from_utf8_lossy(&buffer));
        }
        busy.push(json!({"source":"js", "detail": detail}));
    }
    // SAFETY: these C++ probes take no pointers and only read counters.
    let native_animations = unsafe { rn_gpui_native_animations_active() };
    let pending_work = unsafe { rn_gpui_pending_work() };
    let frame_demand = unsafe { rn_gpui_frame_demand() };
    if (native_animations > 0 || pending_work > 0)
        && !ignore.iter().any(|item| item == "animations")
    {
        busy.push(
            json!({"source": "animations", "detail": format!("{native_animations} native animation driver(s), {pending_work} pending module work item(s), frame demand {frame_demand}")}),
        );
    }
    // SAFETY: the C++ probe takes no pointers and only reads its table.
    let promises = unsafe { rn_gpui_rust_promises_in_flight(1_000) };
    if promises > 0 && !ignore.iter().any(|item| item == "modules") {
        busy.push(json!({"source": "modules", "detail": format!("{promises} Rust module promise call(s) made in the last second and not settled")}));
    }
    if crate::builtins::native_slot::layouts_pending() && !ignore.iter().any(|item| item == "slots")
    {
        busy.push(json!({"source": "slots", "detail": "a native slot is waiting for its content to get its width"}));
    }
    if store.has_pending_resize() && !ignore.iter().any(|item| item == "resize") {
        busy.push(
            json!({"source": "resize", "detail": "a surface has a window size React has not been given yet"}),
        );
    }
    if crate::wheel::pending() && !ignore.iter().any(|item| item == "wheel") {
        busy.push(
            json!({"source": "wheel", "detail": "a wheel event is waiting for its JS handlers"}),
        );
    }
    if store.frame_hook.gesture_is_active() && !ignore.iter().any(|item| item == "gestures") {
        busy.push(json!({"source": "gestures", "detail": "native pointer gesture is active"}));
    }
    let patterns = std::ffi::CString::new(ignore_urls.join("\n")).unwrap_or_default();
    // SAFETY: `patterns` is a NUL-terminated string that outlives the call; the other probe reads a counter.
    let http_requests = unsafe { rn_gpui_http_requests_not_ignored(patterns.as_ptr()) };
    let websocket_messages = unsafe { rn_gpui_websocket_messages_in_flight() };
    if (http_requests > 0 || websocket_messages > 0) && !ignore.iter().any(|item| item == "network")
    {
        busy.push(json!({"source": "network", "detail": format!("{http_requests} HTTP request(s), {websocket_messages} WebSocket message write(s) in flight after URL exclusions")}));
    }
    let image_loads = crate::image_loader::loads_in_flight();
    if image_loads > 0 && !ignore.iter().any(|item| item == "images") {
        busy.push(
            json!({"source": "images", "detail": format!("{image_loads} image load(s) in flight")}),
        );
    }
    // SAFETY: these C++ probes take no pointers and only read counters.
    let mount_batches = unsafe { rn_gpui_mount_batches_in_flight() };
    if mount_batches > 0 && !ignore.iter().any(|item| item == "mount") {
        busy.push(json!({"source": "mount", "detail": format!("{mount_batches} Fabric mount batch(es) queued for GPUI")}));
    }
    // SAFETY: these C++ probes take no pointers and only read counters.
    let pending_timers = unsafe { rn_gpui_pending_timers_due_within(1_500) };
    if pending_timers > 0 && !ignore.iter().any(|item| item == "timers") {
        let mut detail = format!("{pending_timers} one-shot timer(s) due within 1500 ms");
        let mut buffer = vec![0u8; 2048];
        // SAFETY: the buffer is valid for the capacity given, and the call
        // writes at most that many bytes.
        let length =
            unsafe { rn_gpui_pending_timers_dump(1_500, buffer.as_mut_ptr(), buffer.len() as u64) }
                as usize;
        buffer.truncate(length.min(buffer.len()));
        detail.push_str(":\n");
        detail.push_str(&String::from_utf8_lossy(&buffer));
        busy.push(json!({"source": "timers", "detail": detail}));
    }
    if !ignore.iter().any(|item| item == "animations") {
        for (tag, entity) in &store.nodes {
            let node = entity.read(cx);
            if node.transition_active(cx) {
                busy.push(
                    json!({"source": "animations", "detail": format!("transition on tag {tag}")}),
                );
            }
        }
    }
    let stable_count = stable_frames.unwrap_or(0);
    let stable = stable_count >= 2 || ignore.iter().any(|item| item == "frames");
    if stable_frames.is_some() && !stable {
        busy.push(
            json!({"source": "frames", "detail": format!("{stable_count}/2 stable GPUI frames")}),
        );
    }
    json!({
        "idle": busy.is_empty(),
        "stableFrames": stable_count,
        "busySources": busy,
        "trackedSources": ["frames", "animations", "gestures", "mount", "timers", "network", "images", "js", "slots", "resize"],
        "untrackedSources": []
    })
}

fn serve_socket(listener: TcpListener, token: String, tx: Sender<Request>) {
    for incoming in listener.incoming() {
        let Ok(stream) = incoming else { break };
        let Ok(mut socket) = accept(stream) else {
            continue;
        };
        loop {
            let message = match socket.read() {
                Ok(Message::Text(text)) => text,
                Ok(Message::Close(_)) | Err(_) => break,
                Ok(Message::Ping(data)) => {
                    let _ = socket.send(Message::Pong(data));
                    continue;
                }
                Ok(_) => continue,
            };
            let value: Value = match serde_json::from_str(&message) {
                Ok(value) => value,
                Err(error) => {
                    let _ = socket.send(Message::Text(
                        json!({"error": error.to_string()}).to_string().into(),
                    ));
                    continue;
                }
            };
            let id = value.get("id").cloned().unwrap_or(Value::Null);
            if value.pointer("/params/token").and_then(Value::as_str) != Some(&token) {
                let _ = socket.send(Message::Text(
                    json!({"jsonrpc":"2.0", "id": id,
                    "error": {"code": -32001, "message": "invalid test-driver token"}})
                    .to_string()
                    .into(),
                ));
                continue;
            }
            let (reply, response) = mpsc::sync_channel(1);
            if tx.send_blocking(Request { value, reply }).is_err() {
                break;
            }
            let Ok(response) = response.recv() else { break };
            if socket
                .send(Message::Text(response.to_string().into()))
                .is_err()
            {
                break;
            }
        }
    }
}

fn extension_props(node: &RNNodeView) -> Value {
    match node.extension_props() {
        Value::Null => Value::Object(serde_json::Map::new()),
        props => props.clone(),
    }
}

fn paragraph_text(node: &RNNodeView) -> String {
    if node.component == "TextInput" {
        return node.input().text.clone();
    }
    node.paragraph
        .as_ref()
        .map(|paragraph| {
            paragraph
                .fragments
                .iter()
                .map(|fragment| fragment.text.as_str())
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn node_frame(store: &ViewStore, tag: i32, cx: &gpui::App) -> Option<RectF> {
    let entity = store.nodes.get(&tag)?;
    let node = entity.read(cx);
    let origin = node.absolute_origin(cx);
    let (scale_x, scale_y) = node.cumulative_scale(cx);
    let (x, y, w, h) = node.transformed_bounds(
        cx,
        (
            f32::from(origin.x),
            f32::from(origin.y),
            node.frame.w * scale_x,
            node.frame.h * scale_y,
        ),
    );
    Some(RectF { x, y, w, h })
}

/// The GPUI menu bar is drawn inside the window (Linux by default), so the RN
/// surface starts below it: surface frames become window coordinates by adding
/// the inset. It is zero on platforms whose menu bar is native.
pub(crate) fn menu_bar_offset() -> f32 {
    crate::desktop::gpui_menu::menu_bar_inset_for_window_id(
        crate::desktop::windows::MAIN_WINDOW_KEY,
    )
}

/// Asks GPUI to start publishing accessibility data on Windows.
///
/// `gpui_windows` creates its AccessKit (UI Automation) adapter when the window
/// is built, but the adapter discards every tree update until a client requests
/// the tree: `a11y_tree_update` funnels through `Adapter::update_if_active`, and
/// activation happens in `handle_wm_getobject`, which only runs when Windows
/// sends the window `WM_GETOBJECT` on behalf of a UI Automation client. Without
/// that, `debug_a11y_tree_json()` has no tree and `a11yNode`/`a11yTree` report
/// "the native accessibility tree is unavailable".
///
/// Sending `WM_GETOBJECT` with `OBJID_CLIENT` is exactly what such a client
/// does, and it is what the macOS probe does in spirit by asking AppKit for
/// `accessibilityChildren`. The call is synchronous and handled on this (the
/// GPUI) thread.
///
/// Only compiled for the test driver: the message is otherwise a client's job.
///
/// The reply is discarded deliberately, and it is safe to: `UiaReturnRawElementProvider`
/// returns an `LRESULT`, not an owned reference. AccessKit keeps the provider
/// alive inside its own `Context` (the adapter's `State::Active`) and answers
/// later WM_GETOBJECT messages from it; the reference Windows takes on the
/// caller's behalf is released by the client that asked, through the standard
/// WM_GETOBJECT contract. There is nothing here to free or release.
///
/// It is sent once per window: `is_a11y_active()` is true forever after the
/// first successful activation, so resending it would only re-enter the window
/// procedure and make Windows hand out another provider reference for no gain.
#[cfg(all(target_os = "windows", feature = "test-driver"))]
fn activate_accessibility_probe(window: &gpui::Window) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use windows_sys::Win32::UI::WindowsAndMessaging::{SendMessageW, WM_GETOBJECT};
    // OBJID_CLIENT: the window's own accessibility tree, which is what
    // `AccessKit`'s `handle_wm_getobject` answers.
    const OBJID_CLIENT: isize = 0xFFFF_FFFCu32 as i32 as isize;
    if window.is_a11y_active() {
        return;
    }
    let Ok(handle) = HasWindowHandle::window_handle(window) else {
        return;
    };
    let RawWindowHandle::Win32(win32) = handle.as_raw() else {
        return;
    };
    let hwnd = win32.hwnd.get() as *mut core::ffi::c_void;
    // SAFETY: `hwnd` is the live window handle taken from the window's raw handle.
    unsafe {
        SendMessageW(hwnd, WM_GETOBJECT, 0, OBJID_CLIENT);
    }
}

/// The window-space center of a surface-space frame. Pointer events dispatched
/// with it land on the node the frame names, not `menu_bar_offset()` above it.
fn frame_center(frame: RectF, offset: f32) -> gpui::Point<gpui::Pixels> {
    let zoom = crate::desktop::zoom::get(crate::store::APP_SURFACE_ID);
    point(
        px((frame.x + frame.w / 2.0) * zoom),
        px((frame.y + frame.h / 2.0) * zoom + offset),
    )
}

/// The inset to add to `tag`'s frame to get window coordinates: none for a
/// surface GPUI placed, whose frames are window coordinates already.
fn window_offset(store: &ViewStore, tag: i32, cx: &gpui::App) -> f32 {
    match store.nodes.get(&tag) {
        Some(node) if node.read(cx).surface_is_placed() => 0.0,
        _ => menu_bar_offset(),
    }
}

pub(crate) fn node_visible_frame(
    store: &ViewStore,
    tag: i32,
    viewport: RectF,
    cx: &gpui::App,
) -> Option<RectF> {
    let mut visible = node_frame(store, tag, cx)?;
    let node = store.nodes.get(&tag)?.read(cx);
    if node.view.display_none || node.view.opacity <= 0.0 || node.inherited.hides_subtree_self {
        return None;
    }
    visible = intersect(visible, viewport)?;

    let mut parent = node.parent.as_ref().and_then(|parent| parent.upgrade());
    while let Some(ancestor) = parent {
        let ancestor = ancestor.read(cx);
        if ancestor.view.display_none
            || ancestor.view.opacity <= 0.0
            || ancestor.inherited.hides_subtree_self
        {
            return None;
        }
        if ancestor.view.overflow_hidden || ancestor.scroll.is_some() {
            visible = intersect(visible, node_frame(store, ancestor.tag, cx)?)?;
        }
        parent = ancestor.parent.as_ref().and_then(|parent| parent.upgrade());
    }
    Some(visible)
}

fn intersect(frame: RectF, clip: RectF) -> Option<RectF> {
    let x = frame.x.max(clip.x);
    let y = frame.y.max(clip.y);
    let right = (frame.x + frame.w).min(clip.x + clip.w);
    let bottom = (frame.y + frame.h).min(clip.y + clip.h);
    (right > x && bottom > y).then_some(RectF {
        x,
        y,
        w: right - x,
        h: bottom - y,
    })
}

fn query_label(store: &ViewStore, node: &RNNodeView, cx: &gpui::App) -> String {
    if !node.view.accessibility_label.is_empty() {
        return node.view.accessibility_label.clone();
    }
    let text = paragraph_text(node);
    if !text.is_empty() {
        return text;
    }
    let mut parts = Vec::new();
    let mut pending: Vec<i32> = node.children.iter().map(|(tag, _)| *tag).collect();
    let mut visited = std::collections::HashSet::new();
    while let Some(tag) = pending.pop() {
        if !visited.insert(tag) {
            continue;
        }
        if let Some(entity) = store.nodes.get(&tag) {
            let child = entity.read(cx);
            let text = paragraph_text(child);
            if !child.view.accessibility_label.is_empty() {
                parts.push(child.view.accessibility_label.clone());
            } else if !text.is_empty() && child.component != "TextInput" {
                parts.push(text);
            } else {
                pending.extend(child.children.iter().rev().map(|(tag, _)| *tag));
            }
        }
    }
    parts.join(" ")
}

fn query(store: &ViewStore, params: &Value, viewport: RectF, cx: &gpui::App) -> Value {
    let by = params.get("by").and_then(Value::as_str).unwrap_or("testID");
    let value = params.get("value").and_then(Value::as_str).unwrap_or("");
    let exact = params
        .get("exact")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let name = params.get("name").and_then(Value::as_str).unwrap_or("");
    let items: Vec<Value> = store.nodes.iter().filter_map(|(tag, entity)| {
        let node = entity.read(cx);
        if let Some(root) = params.get("within").and_then(Value::as_i64) {
            let mut parent = node.parent.as_ref().and_then(|parent| parent.upgrade());
            let mut found = false;
            while let Some(entity) = parent {
                let ancestor = entity.read(cx);
                if ancestor.tag == root as i32 { found = true; break; }
                parent = ancestor.parent.as_ref().and_then(|parent| parent.upgrade());
            }
            if !found { return None; }
        }
        let text = paragraph_text(node);
        let label = query_label(store, node, cx);
        let actual = match by {
            "testID" => node.view.test_id.as_str(),
            "text" => text.as_str(),
            "role" => node.view.accessibility_role.as_str(),
            "label" => label.as_str(),
            _ => return None,
        };
        if actual.is_empty()
            || !matches_query(actual, value, exact)
            || (!name.is_empty() && !label.contains(name) && !text.contains(name))
        {
            return None;
        }
        let frame = node_frame(store, *tag, cx).unwrap_or(node.frame);
        Some(json!({"tag": tag, "component": node.component, "testID": node.view.test_id,
            "text": text, "role": node.view.accessibility_role, "label": label,
            "state": {"disabled": node.view.accessibility_disabled, "selected": node.view.accessibility_selected, "checked": match node.view.accessibility_checked { 1 => json!(false), 2 => json!(true), 3 => json!("mixed"), _ => Value::Null }},
            "frame": {"x": frame.x, "y": frame.y, "width": frame.w, "height": frame.h},
            "visible": node_visible_frame(store, *tag, viewport, cx).is_some(),
            "enabled": !node.view.accessibility_disabled}))
    }).collect();
    let mut items = items;
    items.extend(native_query(by, value, exact, name));
    json!(items)
}

fn matches_query(actual: &str, expected: &str, exact: bool) -> bool {
    if exact {
        actual == expected
    } else {
        actual.contains(expected)
    }
}

fn tree(store: &ViewStore, cx: &gpui::Context<ViewStore>) -> Value {
    let children = store
        .roots
        .get(&store.primary_surface_id)
        .map(|root| {
            root.read(cx)
                .children
                .iter()
                .filter_map(|(tag, _)| store.nodes.get(tag))
                .map(|node| tree_node(node, store, cx))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    // `generation` says which React instance this tree came from, so a client
    // that reloaded can tell "the old instance is gone" from "the new one has
    // not mounted yet" without inferring it from an empty `children`.
    json!({"surface": store.primary_surface_id, "generation": instance_generation(), "children": children})
}

/// The color of each border side as ARGB, `0` for none.
fn border_colors_json(node: &RNNodeView) -> Value {
    let colors = node
        .resolved_state()
        .map_or(node.view.border_colors, |state| {
            state.border_colors(node.view.border_colors)
        });
    json!({"left": colors[0], "top": colors[1], "right": colors[2], "bottom": colors[3]})
}

/// The color of a node's text: the one a state style gives it, else its first
/// non-empty fragment's, as ARGB.
fn text_color(node: &RNNodeView) -> Value {
    if let Some(color) = node.state_text_color() {
        return json!(color);
    }
    node.paragraph
        .as_ref()
        .and_then(|paragraph| {
            paragraph
                .fragments
                .iter()
                .find(|fragment| !fragment.text.is_empty())
        })
        .map_or(Value::Null, |fragment| json!(fragment.color))
}

/// The background and opacity a node paints with, the state styles applied.
fn effective_background(node: &RNNodeView) -> u32 {
    node.resolved_state()
        .and_then(|state| state.background())
        .unwrap_or(node.view.background_color)
}

fn effective_opacity(node: &RNNodeView) -> f32 {
    node.resolved_state()
        .and_then(|state| state.opacity())
        .unwrap_or(node.view.opacity)
}

fn tree_node(
    entity: &Entity<RNNodeView>,
    store: &ViewStore,
    cx: &gpui::Context<ViewStore>,
) -> Value {
    let node = entity.read(cx);
    let mut children = node
        .children
        .iter()
        .map(|(_, child)| tree_node(child, store, cx))
        .collect::<Vec<_>>();
    if node.component == crate::builtins::native_root::COMPONENT {
        let root = node
            .extension_props
            .get("rootId")
            .and_then(Value::as_u64)
            .unwrap_or(0) as u32;
        children.extend(native_tree_json(root));
    }
    json!({"tag": node.tag, "component": node.component, "testID": node.view.test_id,
        "text": paragraph_text(node), "role": node.view.accessibility_role,
        "label": node.view.accessibility_label,
        "backgroundColor": effective_background(node), "opacity": effective_opacity(node),
        "borderColors": border_colors_json(node), "textColor": text_color(node),
        "frame": [node.frame.x, node.frame.y, node.frame.w, node.frame.h],
        "contentSize": node.scroll.as_ref().map(|scroll| json!([scroll.content_size.0, scroll.content_size.1])).unwrap_or(Value::Null),
        "scrollOffset": [node.scroll_offset().x, node.scroll_offset().y],
        "scrollIndicatorShown": node.scroll_indicator_shown(cx),
        "intrinsicSize": node.intrinsic_size().map(|(width, height)| json!([width, height])).unwrap_or(Value::Null),
        "children": children})
}

/// The frame of an instance as the test driver reports frames: the window's
/// coordinates less the menu bar the surface starts below.
fn native_frame(bounds: Option<gpui::Bounds<gpui::Pixels>>) -> [f32; 4] {
    bounds.map_or([0.0; 4], |bounds| {
        [
            f32::from(bounds.origin.x),
            f32::from(bounds.origin.y) - menu_bar_offset(),
            f32::from(bounds.size.width),
            f32::from(bounds.size.height),
        ]
    })
}

fn native_text(props: &serde_json::Map<String, Value>, name: &str) -> String {
    props
        .get(name)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// The instances of a native tree, nested as the tree is.
fn native_tree_json(root: u32) -> Vec<Value> {
    let infos = crate::builtins::native_root::instances(root);
    let by_tag: std::collections::HashMap<i32, usize> = infos
        .iter()
        .enumerate()
        .map(|(index, info)| (info.tag, index))
        .collect();
    fn build(
        infos: &[crate::builtins::native_root::InstanceInfo],
        by_tag: &std::collections::HashMap<i32, usize>,
        index: usize,
    ) -> Value {
        let info = &infos[index];
        let children: Vec<Value> = info
            .children
            .iter()
            .filter_map(|tag| by_tag.get(tag))
            .map(|child| build(infos, by_tag, *child))
            .collect();
        json!({
            "tag": info.tag,
            "component": info.type_name,
            "native": true,
            "testID": native_text(&info.props, "testID"),
            "text": native_text(&info.props, "text"),
            "role": native_text(&info.props, "accessibilityRole"),
            "label": native_text(&info.props, "accessibilityLabel"),
            "frame": native_frame(info.bounds),
            "children": children,
        })
    }
    infos
        .first()
        .map(|_| vec![build(&infos, &by_tag, 0)])
        .unwrap_or_default()
}

fn native_query(by: &str, value: &str, exact: bool, name: &str) -> Vec<Value> {
    let mut items = Vec::new();
    for root in crate::builtins::native_root::root_ids() {
        for info in crate::builtins::native_root::instances(root) {
            let text = native_text(&info.props, "text");
            let label = {
                let label = native_text(&info.props, "accessibilityLabel");
                if label.is_empty() {
                    text.clone()
                } else {
                    label
                }
            };
            let role = native_text(&info.props, "accessibilityRole");
            let test_id = native_text(&info.props, "testID");
            let actual = match by {
                "testID" => test_id.as_str(),
                "text" => text.as_str(),
                "role" => role.as_str(),
                "label" => label.as_str(),
                _ => continue,
            };
            if actual.is_empty()
                || !matches_query(actual, value, exact)
                || (!name.is_empty() && !label.contains(name) && !text.contains(name))
            {
                continue;
            }
            let frame = native_frame(info.bounds);
            items.push(json!({
                "tag": info.tag, "component": info.type_name, "testID": test_id,
                "text": text, "role": role, "label": label,
                "state": {"disabled": false, "selected": false, "checked": Value::Null},
                "frame": {"x": frame[0], "y": frame[1], "width": frame[2], "height": frame[3]},
                "visible": info.bounds.is_some(), "enabled": true,
            }));
        }
    }
    items
}

fn get_props(store: &ViewStore, params: &Value, cx: &gpui::Context<ViewStore>) -> Value {
    let Some(tag) = params
        .get("tag")
        .and_then(Value::as_i64)
        .map(|tag| tag as i32)
    else {
        return json!({"error": "getProps requires a tag"});
    };
    let Some(entity) = store.nodes.get(&tag) else {
        return json!({"error": format!("tag {tag} is not mounted")});
    };
    let node = entity.read(cx);
    let outline = node.resolved_state().map_or(
        (
            node.view.outline_color,
            node.view.outline_width,
            node.view.outline_offset,
        ),
        |state| {
            state.outline((
                node.view.outline_color,
                node.view.outline_width,
                node.view.outline_offset,
            ))
        },
    );
    let paragraph_fragments = node
        .paragraph
        .as_ref()
        .map(|paragraph| {
            paragraph
                .fragments
                .iter()
                .map(|fragment| {
                    json!({
                        "text": fragment.text,
                        "fontFamily": fragment.font_family,
                        "fontSize": fragment.font_size,
                        "fontWeight": fragment.font_weight,
                        "italic": fragment.italic,
                        "color": fragment.color,
                        "lineHeight": fragment.line_height,
                        "letterSpacing": fragment.letter_spacing,
                        "underline": fragment.underline,
                        "strikethrough": fragment.strikethrough,
                        "textTransform": fragment.text_transform,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    json!({"tag": tag, "component": node.component, "testID": node.view.test_id,
        "accessibilityLabel": node.view.accessibility_label, "accessibilityRole": node.view.accessibility_role,
        "disabled": node.view.accessibility_disabled, "text": paragraph_text(node),
        "paragraphFragments": paragraph_fragments,
        "borderWidths": {"left": node.view.border_widths.left, "top": node.view.border_widths.top,
            "right": node.view.border_widths.right, "bottom": node.view.border_widths.bottom},
        "borderStyles": node.view.border_styles,
        "borderColors": border_colors_json(node),
        "borderRadii": {"topLeft": node.view.border_radii.tl, "topRight": node.view.border_radii.tr,
            "bottomRight": node.view.border_radii.br, "bottomLeft": node.view.border_radii.bl},
        "boxShadows": node.view.shadows.iter().map(|shadow| json!({
            "offsetX": shadow.dx, "offsetY": shadow.dy, "blurRadius": shadow.blur,
            "spreadDistance": shadow.spread, "color": shadow.color, "inset": shadow.inset,
        })).collect::<Vec<_>>(),
        "textColor": text_color(node),
        "textAlign": node.paragraph.as_ref().map(|paragraph| paragraph.text_align),
        "numberOfLines": node.paragraph.as_ref().map(|paragraph| paragraph.max_lines),
        "outlineColor": outline.0,
        "outlineOffset": outline.2,
        "outlineWidth": outline.1,
        "imageUri": extension_props(node).get("uri").cloned().unwrap_or(Value::Null),
        "imageResizeMode": extension_props(node).get("resizeMode").cloned().unwrap_or(Value::Null),
        "opacity":effective_opacity(node),"backgroundColor":effective_background(node),"baseBackgroundColor":node.view.background_color,"baseOpacity":node.view.opacity,"states":node.active_state_names(),"transform":node.view.transform,"renderCount":node.test_render_count(),
        "scrollStrategy": node.scroll_strategy_name(),
        "selection": if node.component == "TextInput" { json!({
            "start": node.input().text[..node.input().selection.start].encode_utf16().count(),
            "end": node.input().text[..node.input().selection.end].encode_utf16().count()
        }) } else { Value::Null },
        "inputScrollX": if node.component == "TextInput" { json!(node.input().scroll_x) } else { Value::Null },
        "frame": node_frame(store, tag, cx).map(|frame| json!({"x":frame.x,"y":frame.y,"width":frame.w,"height":frame.h}))})
}

/// The whole device pixels (x, y, width, height) an element's `frame`, shifted
/// down by `offset`, covers in a window of `width` x `height` device pixels, or
/// `None` when none are inside it.
fn device_region(
    frame: RectF,
    offset: f32,
    scale: f32,
    width: i32,
    height: i32,
) -> Option<(i32, i32, i32, i32)> {
    let (width, height) = (width.max(0) as u32, height.max(0) as u32);
    let x = ((frame.x * scale).floor().max(0.0) as u32).min(width);
    let y = (((frame.y + offset) * scale).floor().max(0.0) as u32).min(height);
    let right = (((frame.x + frame.w) * scale).ceil().max(0.0) as u32).min(width);
    let bottom = (((frame.y + offset + frame.h) * scale).ceil().max(0.0) as u32).min(height);
    if x >= right || y >= bottom {
        return None;
    }
    Some((x as i32, y as i32, (right - x) as i32, (bottom - y) as i32))
}

#[cfg(test)]
mod tests {
    use super::{device_region, intersect, matches_query, RectF};

    #[test]
    fn device_region_scales_to_whole_device_pixels_and_clamps() {
        let frame = RectF {
            x: 10.25,
            y: 4.0,
            w: 20.0,
            h: 10.5,
        };
        // 2x: x 20.5 -> 20, right 60.5 -> 61; y (4 + 1) * 2 = 10, bottom 31
        assert_eq!(
            device_region(frame, 1.0, 2.0, 200, 100),
            Some((20, 10, 41, 21))
        );
        // Clamped to the window.
        assert_eq!(
            device_region(frame, 0.0, 2.0, 30, 100),
            Some((20, 8, 10, 21))
        );
        // Outside it.
        assert_eq!(device_region(frame, 0.0, 2.0, 10, 100), None);
    }

    #[test]
    fn query_matching_supports_exact_and_substring_modes() {
        assert!(matches_query("Home title", "Home title", true));
        assert!(!matches_query("Home title", "Home", true));
        assert!(matches_query("Home title", "Home", false));
        assert!(!matches_query("Details", "Home", false));
    }

    #[test]
    fn screenshot_frame_is_clipped_to_viewport() {
        let frame = RectF {
            x: -4.0,
            y: 12.0,
            w: 20.0,
            h: 30.0,
        };
        let viewport = RectF {
            x: 0.0,
            y: 0.0,
            w: 10.0,
            h: 20.0,
        };

        let clipped = intersect(frame, viewport).expect("frame intersects viewport");
        assert_eq!(clipped.x, 0.0);
        assert_eq!(clipped.y, 12.0);
        assert_eq!(clipped.w, 10.0);
        assert_eq!(clipped.h, 8.0);
    }

    #[test]
    fn screenshot_frame_outside_clip_has_no_visible_pixels() {
        let frame = RectF {
            x: 20.0,
            y: 20.0,
            w: 5.0,
            h: 5.0,
        };
        let clip = RectF {
            x: 0.0,
            y: 0.0,
            w: 10.0,
            h: 10.0,
        };

        assert!(intersect(frame, clip).is_none());
    }
}

/// The window as the compositor shows it, native views included, as PNG bytes
/// with its size in pixels.
#[cfg(target_os = "macos")]
fn composite_png(window: &gpui::Window) -> Result<(Vec<u8>, usize, usize), String> {
    crate::native_view::test_composite_png(window)
}

/// The window as the X server shows it: `XGetImage` includes the child windows
/// native views live in. Wayland offers no such read.
#[cfg(target_os = "linux")]
fn composite_png(window: &gpui::Window) -> Result<(Vec<u8>, usize, usize), String> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use x11_dl::xlib;

    let id = match HasWindowHandle::window_handle(window)
        .map_err(|error| error.to_string())?
        .as_raw()
    {
        RawWindowHandle::Xcb(handle) => u64::from(handle.window.get()),
        RawWindowHandle::Xlib(handle) => handle.window,
        _ => return Err("the window cannot be captured outside X11".into()),
    };
    let scale = window.scale_factor();
    let size = window.viewport_size();
    let (width, height) = (
        (f32::from(size.width) * scale).round() as u32,
        (f32::from(size.height) * scale).round() as u32,
    );
    let xlib = xlib::Xlib::open().map_err(|error| error.to_string())?;
    // SAFETY: the display is opened and closed here, the image is destroyed once, and its pixels are read within its own `bytes_per_line` and height.
    unsafe {
        let display = (xlib.XOpenDisplay)(std::ptr::null());
        if display.is_null() {
            return Err("could not open the X display".into());
        }
        let image = (xlib.XGetImage)(display, id, 0, 0, width, height, !0, xlib::ZPixmap);
        if image.is_null() {
            (xlib.XCloseDisplay)(display);
            return Err("XGetImage failed".into());
        }
        let (red, green, blue) = ((*image).red_mask, (*image).green_mask, (*image).blue_mask);
        let channel =
            |mask: u64, pixel: u64| -> u8 { ((pixel & mask) >> mask.trailing_zeros()) as u8 };
        let mut rgba = image::RgbaImage::new(width, height);
        for y in 0..height {
            for x in 0..width {
                let pixel = ((xlib.XGetPixel)(image, x as i32, y as i32)) as u64;
                rgba.put_pixel(
                    x,
                    y,
                    image::Rgba([
                        channel(red, pixel),
                        channel(green, pixel),
                        channel(blue, pixel),
                        255,
                    ]),
                );
            }
        }
        (xlib.XDestroyImage)(image);
        (xlib.XCloseDisplay)(display);
        let mut png = std::io::Cursor::new(Vec::new());
        rgba.write_to(&mut png, image::ImageFormat::Png)
            .map_err(|error| error.to_string())?;
        Ok((png.into_inner(), width as usize, height as usize))
    }
}

/// The window as the desktop shows it, DirectComposition content included: the
/// screen is copied at the window's client rectangle, so the window must be on
/// screen and not covered.
#[cfg(target_os = "windows")]
fn composite_png(window: &gpui::Window) -> Result<(Vec<u8>, usize, usize), String> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use windows_sys::Win32::Foundation::HWND;

    let RawWindowHandle::Win32(handle) = HasWindowHandle::window_handle(window)
        .map_err(|error| error.to_string())?
        .as_raw()
    else {
        return Err("the window is not a Win32 window".into());
    };
    capture_client(handle.hwnd.get() as HWND)
}

#[cfg(target_os = "windows")]
fn window_hwnd(window: &gpui::Window) -> Option<isize> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    match HasWindowHandle::window_handle(window).ok()?.as_raw() {
        RawWindowHandle::Win32(win32) => Some(win32.hwnd.get()),
        _ => None,
    }
}

/// Which window holds the foreground, the active state and the keyboard focus,
/// next to this process's window.
#[cfg(target_os = "windows")]
fn focus_readout(hwnd: isize) -> Value {
    use windows_sys::Win32::UI::{
        Input::KeyboardAndMouse::{GetActiveWindow, GetFocus},
        WindowsAndMessaging::GetForegroundWindow,
    };
    // SAFETY: the calls only read the calling thread's input state.
    let (foreground, active, focus) = unsafe {
        (
            GetForegroundWindow() as isize,
            GetActiveWindow() as isize,
            GetFocus() as isize,
        )
    };
    json!({
        "hwnd": hwnd,
        "foreground": foreground,
        "active": active,
        "focus": focus,
        "foregroundIsWindow": foreground == hwnd,
        "activeIsWindow": active == hwnd,
        "focusIsWindow": focus == hwnd,
    })
}

/// Takes the foreground for the window. A new process is refused it by
/// default, so an Alt key press, which Windows counts as input from the
/// process, comes first; the window is then raised above the others.
#[cfg(target_os = "windows")]
fn bring_to_front(hwnd: isize) {
    use windows_sys::Win32::UI::{
        Input::KeyboardAndMouse::{keybd_event, KEYEVENTF_KEYUP, VK_MENU},
        WindowsAndMessaging::{
            AllowSetForegroundWindow, SetForegroundWindow, SetWindowPos, ASFW_ANY, HWND_NOTOPMOST,
            HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE,
        },
    };
    let hwnd = hwnd as windows_sys::Win32::Foundation::HWND;
    // SAFETY: `hwnd` is the live handle of this process's window; the calls only
    // change its z-order and foreground state.
    unsafe {
        AllowSetForegroundWindow(ASFW_ANY);
        keybd_event(VK_MENU as u8, 0, 0, 0);
        keybd_event(VK_MENU as u8, 0, KEYEVENTF_KEYUP, 0);
        SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
        SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
        SetForegroundWindow(hwnd);
    }
}

#[cfg(target_os = "windows")]
fn capture_client(
    hwnd: windows_sys::Win32::Foundation::HWND,
) -> Result<(Vec<u8>, usize, usize), String> {
    use windows_sys::Win32::{
        Foundation::{POINT, RECT},
        Graphics::Dwm::DwmFlush,
        Graphics::Gdi::{
            BitBlt, ClientToScreen, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject,
            GetDC, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT,
            DIB_RGB_COLORS, SRCCOPY,
        },
        UI::WindowsAndMessaging::{
            GetClientRect, SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        },
    };
    // SAFETY: every GDI object created here is released before returning; the pixel buffer is the section's own memory, read within its width and height.
    unsafe {
        let mut client = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        GetClientRect(hwnd, &mut client);
        let (width, height) = (client.right - client.left, client.bottom - client.top);
        if width <= 0 || height <= 0 {
            return Err("the window has no client area".into());
        }
        // The screen is copied, so a window in front of this one (a console
        // another test left on the desktop) would be copied with it. Put this
        // one on top and let the compositor present it.
        SetWindowPos(
            hwnd,
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
        DwmFlush();
        let mut origin = POINT { x: 0, y: 0 };
        ClientToScreen(hwnd, &mut origin);
        let screen = GetDC(std::ptr::null_mut());
        let memory = CreateCompatibleDC(screen);
        let mut info: BITMAPINFO = std::mem::zeroed();
        info.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            ..std::mem::zeroed()
        };
        let mut bits: *mut std::ffi::c_void = std::ptr::null_mut();
        let section = CreateDIBSection(
            screen,
            &info,
            DIB_RGB_COLORS,
            &mut bits,
            std::ptr::null_mut(),
            0,
        );
        let previous = SelectObject(memory, section);
        let copied = BitBlt(
            memory,
            0,
            0,
            width,
            height,
            screen,
            origin.x,
            origin.y,
            SRCCOPY | CAPTUREBLT,
        );
        let result = if copied == 0 || bits.is_null() {
            Err("the screen could not be copied".to_string())
        } else {
            let bgra = std::slice::from_raw_parts(bits as *const u8, (width * height * 4) as usize);
            let mut rgba = image::RgbaImage::new(width as u32, height as u32);
            for (pixel, source) in rgba.pixels_mut().zip(bgra.chunks_exact(4)) {
                *pixel = image::Rgba([source[2], source[1], source[0], 255]);
            }
            let mut png = std::io::Cursor::new(Vec::new());
            rgba.write_to(&mut png, image::ImageFormat::Png)
                .map(|()| (png.into_inner(), width as usize, height as usize))
                .map_err(|error| error.to_string())
        };
        SelectObject(memory, previous);
        DeleteObject(section);
        DeleteDC(memory);
        ReleaseDC(std::ptr::null_mut(), screen);
        result
    }
}

/// Logs when an input event reaches the window, for latency measured from the
/// event rather than from the driver call that sent it (`RN_GPUI_MOUNT_TRACE`).
fn trace_input_dispatch(kind: &str) {
    if crate::bootstrap::mount_trace_enabled() {
        eprintln!(
            "[mount-trace] {kind} epoch_ms={:.3}",
            crate::bootstrap::epoch_ms()
        );
    }
}
