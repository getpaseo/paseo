#[cxx::bridge(namespace = "rngpui")]
pub mod ffi {
    // SAFETY: the signature matches the declaration in `GpuiImageLoader.h`.
    unsafe extern "C++" {
        include!("GpuiImageLoader.h");
        fn rn_gpui_on_image_load_result(request_id: u64, width: f64, height: f64, error: String);
        fn rn_gpui_on_image_progress(request_id: u64, loaded: i64, total: i64);
    }

    #[derive(Clone, Copy, Debug, Default, PartialEq)]
    pub struct RectF {
        pub x: f32,
        pub y: f32,
        pub w: f32,
        pub h: f32,
    }

    #[derive(Clone, Copy, Debug, Default)]
    pub struct EdgesF {
        pub left: f32,
        pub top: f32,
        pub right: f32,
        pub bottom: f32,
    }

    #[derive(Clone, Copy, Debug, Default)]
    pub struct CornersF {
        pub tl: f32,
        pub tr: f32,
        pub br: f32,
        pub bl: f32,
    }

    #[derive(Clone, Debug, Default)]
    pub struct ShadowF {
        pub dx: f32,
        pub dy: f32,
        pub blur: f32,
        pub spread: f32,
        pub color: u32,
        pub inset: bool,
    }

    #[derive(Clone, Debug, Default)]
    pub struct AccessibilityActionFlat {
        pub name: String,
        pub label: String,
    }

    /// Colors are 0xAARRGGBB, 0 = none.
    #[derive(Clone, Debug, Default)]
    pub struct ViewPropsFlat {
        pub opacity: f32,
        pub background_color: u32,
        pub border_widths: EdgesF,
        pub content_insets: EdgesF,  // RN layout border + padding insets
        pub border_colors: [u32; 4], // left, top, right, bottom
        pub border_styles: [u8; 4],  // 0 solid, 1 dotted, 2 dashed
        pub border_radii: CornersF,
        pub outline_color: u32,
        pub outline_width: f32,
        pub outline_offset: f32,
        pub outline_style: u8,
        pub overflow_hidden: bool,
        pub display_none: bool, // Fabric layout visibility, including retained descendants
        pub pointer_events: u8, // 0 auto, 1 none, 2 box-none, 3 box-only
        pub cursor: u8,         // RN's `Cursor` ordinal; 0 = auto
        pub shadows: Vec<ShadowF>,
        pub background_json: String, // gradients with their size, position and repeat; empty = none
        pub filter_json: String,     // `[[name, amount], ...]` from `filter`; empty = none
        pub mix_blend_mode: u8,      // RN's `BlendMode` ordinal; 0 = normal
        pub isolate: bool,           // `isolation: 'isolate'`
        pub hit_slop: [f32; 4],      // `hitSlop`: left, top, right, bottom
        pub transform: [f32; 16],    // column-major 4x4, resolved with layout
        pub has_transform: bool,
        pub backface_hidden: bool, // `backfaceVisibility: 'hidden'`
        /// Whether `transformOrigin` is in the matrix; when it is not, the view turns about its centre.
        pub transform_origin_set: bool,
        pub test_id: String,
        pub accessibility_label: String,
        pub accessibility_hint: String,
        pub accessibility_language: String,
        pub accessibility_role: String,
        pub accessibility_traits: u32,
        pub accessibility_value_text: String,
        pub accessibility_value_min: i32,
        pub accessibility_value_max: i32,
        pub accessibility_value_now: i32,
        pub accessibility_has_value_min: bool,
        pub accessibility_has_value_max: bool,
        pub accessibility_has_value_now: bool,
        pub accessibility_actions: Vec<AccessibilityActionFlat>,
        pub accessibility_labelled_by: Vec<String>,
        pub accessibility_order: Vec<String>,
        pub accessible: bool,
        pub accessibility_disabled: bool,
        pub accessibility_selected: bool,
        pub accessibility_busy: bool,
        pub accessibility_checked: u8, // 0 absent, 1 unchecked, 2 checked, 3 mixed
        pub accessibility_expanded: i8, // -1 absent, 0 false, 1 true
        pub accessibility_important: u8, // Auto, Yes, No, NoHideDescendants
        pub accessibility_live_region: u8, // None, Polite, Assertive
        pub accessibility_hidden: bool,
        pub accessibility_modal: bool,
        pub accessibility_responds_to_interaction: bool,
        pub accessibility_has_action_listener: bool,
        pub accessibility_has_tap_listener: bool,
        pub accessibility_has_escape_listener: bool,
        pub accessibility_has_magic_tap_listener: bool,
        pub accessibility_native_id: String,
        pub accessibility_ignores_invert_colors: bool,
        pub accessibility_large_content_enabled: bool,
        pub accessibility_large_content_title: String,
        pub focusable: bool,
        pub desktop_drag_region: bool,
        /// "minimize" | "maximize" | "close" for a custom caption button.
        pub on_context_menu: bool,
        pub on_wheel: bool,
        pub on_layout: bool,
        /// A node's group name, and the JSON of each state style prop; empty = not set.
        pub group: String,
        pub hover_style: String,
        pub active_style: String,
        pub focus_style: String,
        pub focus_visible_style: String,
        pub group_hover_style: String,
        pub group_active_style: String,
        pub drag_over_style: String,
        /// Whether the view takes files dropped from the operating system.
        pub accepts_files: bool,
        pub tooltip: String,
        pub draggable: bool,
        pub droppable: bool,
    }

    #[derive(Clone, Debug, Default)]
    pub struct TextFragmentFlat {
        pub text: String,
        pub font_family: String,
        pub font_size: f32,
        pub font_weight: u16, // 100..900
        pub italic: bool,
        pub color: u32,
        pub line_height: f32, // 0 = default
        pub letter_spacing: f32,
        pub underline: bool,
        pub strikethrough: bool,
        pub text_transform: u8, // 0 none, 1 uppercase, 2 lowercase, 3 capitalize
        pub font_variant: u32,  // RN's FontVariant bitmask
        pub background_color: u32, // ARGB, 0 = none
    }

    #[derive(Clone, Debug, Default)]
    pub struct ParagraphFlat {
        pub fragments: Vec<TextFragmentFlat>,
        pub max_lines: i32, // 0 = unlimited
        pub text_align: u8, // 0 natural, 1 left, 2 center, 3 right, 4 justify, 5 start, 6 end
        pub ellipsize: u8,  // 0 tail, 1 head, 2 middle, 3 clip
        pub adjusts_to_fit: bool,
        pub selectable: bool,
        pub min_font_scale: f32, // 0 = no lower bound
        pub shadow_color: u32,   // ARGB, 0 = none
        pub shadow_dx: f32,
        pub shadow_dy: f32,
        pub shadow_radius: f32,
        /// An empty single-line input measured for the height of one line of
        /// its font.
        pub measure_empty_line: bool,
        /// A shaped layout of this paragraph (`rn_gpui_prepare_text`) that the
        /// op owns, and the content width it was shaped for. 0 for none.
        pub prepared: u64,
        pub prepared_width: f32,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    #[repr(u8)]
    pub enum MountKind {
        Create = 1,
        Delete = 2,
        Insert = 4,
        Remove = 8,
        Update = 16,
    }

    /// One validated command argument. `kind` says which field holds it: 0 a
    /// number (`number`), 1 a bool (`number` as 0 or 1), 2 a string (`text`),
    /// 3 an array of numbers, 4 of bools (`numbers`, each 0 or 1), 5 of strings.
    #[derive(Clone, Debug, Default)]
    pub struct HostCommandArg {
        pub kind: u8,
        pub number: f64,
        pub text: String,
        pub numbers: Vec<f64>,
        pub texts: Vec<String>,
    }

    #[derive(Clone, Debug)]
    pub struct MountOp {
        pub kind: MountKind,
        pub tag: i32,
        pub parent_tag: i32, // Insert/Remove/Update, else -1
        pub index: i32,      // Insert/Remove, else -1
        /// "View", "Paragraph", "Image", "ScrollView", ...: interned by the host
        /// for the life of the process, so an op does not allocate its name.
        pub component: &'static str,
        pub frame: RectF, // layoutMetrics.frame, relative to parent, DIPs
        pub props_changed: bool,
        pub view: ViewPropsFlat,
        pub extension_props_json: String,
        /// The registry index of the host component this op is for, or `-1`.
        pub host_index: i32,
        /// An owned handle to the node's Fabric props (a `shared_ptr<const
        /// Props>`), or zero. Set on `Create`, and on an `Update` only when the
        /// props changed in a way the component can see: Rust takes ownership and
        /// the generated accessors read the C++ fields in place.
        pub host_props_handle: usize,
        /// An owned handle to the node's event emitter, on `Create` only.
        pub host_emitter_handle: usize,
        /// The props that changed since the props Rust last received, one bit per
        /// prop: the first 64 here, any more in `host_changed_more`. Computed in
        /// C++ against `oldChildShadowView`, so it is relative to what the
        /// component has seen even when several clones happened in between.
        pub host_changed: u64,
        pub host_changed_more: Vec<u64>,
        pub has_paragraph: bool,
        pub paragraph: ParagraphFlat, // filled for "Paragraph" from its state's AttributedString
        pub layout_changed: bool,
        /// What changed in a node whose view props did not (the op then carries
        /// no whole view). 1 content insets and display, 2 border widths, 4
        /// border radii, 8 transform (these four are groups of `view`), 16 the
        /// paragraph's `selectable`, 32 the extension props.
        pub layout_patch: u8,
    }

    #[derive(Clone, Debug, Default)]
    pub struct MountBatch {
        pub surface_id: i32,
        pub ops: Vec<MountOp>,
        /// The size Fabric laid this surface's root out at, in DIPs.
        pub content_width: f32,
        pub content_height: f32,
        /// Whether the surface's root was laid out at all in this commit. A
        /// batch from a surface whose root has not been measured yet reports
        /// zeros, which must not be mistaken for an empty tree.
        pub has_content_size: bool,
    }

    #[derive(Clone, Copy, Debug, Default)]
    pub struct AnimatedPropsFlat {
        pub tag: i32,
        pub opacity: f32,
        pub has_opacity: bool,
        pub transform: [f32; 16],
        pub has_transform: bool,
        pub reset_transform: bool,
        pub background_color: u32,
        pub has_background_color: bool,
        pub text_color: u32,
        pub has_text_color: bool,
    }

    #[derive(Clone, Debug)]
    pub struct RustModuleMethod {
        pub name: String,
        pub arg_count: u32,
        /// Arguments JS has to pass; the rest may be omitted.
        pub required_args: u32,
        /// 0 value, 1 void, 2 promise.
        pub kind: u8,
        /// Whether the spec returns `void`, which makes a promise resolve with
        /// `undefined`.
        pub returns_void: bool,
        pub callback_args: Vec<u32>,
    }

    #[derive(Clone, Debug)]
    pub struct RustModuleEvent {
        pub name: String,
        pub has_value: bool,
    }

    /// What a host component measured under a constraint, if it measures.
    #[derive(Clone, Copy, Debug, Default)]
    pub struct HostMeasure {
        pub width: f32,
        pub height: f32,
        pub measured: bool,
    }

    /// A paragraph shaped by `rn_gpui_prepare_text`: the handle owns a
    /// reference to the layout until `rn_gpui_release_prepared`.
    #[derive(Clone, Copy, Debug, Default)]
    pub struct PreparedText {
        pub handle: u64,
        pub width: f32,
        pub height: f32,
    }

    #[derive(Clone, Copy, Debug, Default)]
    pub struct MeasureResult {
        pub width: f32,
        pub height: f32,
    }

    /// One laid-out row of a paragraph, for `onTextLayout`.
    #[derive(Default)]
    pub struct LineFlat {
        pub text: String,
        pub x: f32,
        pub y: f32,
        pub width: f32,
        pub height: f32,
        pub ascender: f32,
        pub descender: f32,
        pub cap_height: f32,
        pub x_height: f32,
    }

    extern "Rust" {
        fn rn_gpui_load_image(uri: String, request_id: u64);
        fn rn_gpui_image_is_cached(uri: &str) -> bool;
        fn rn_gpui_load_font(family: &str, uri: &str) -> bool;
        fn rn_gpui_render_text_image(
            family: &str,
            text: &str,
            font_size: f64,
            color: u32,
        ) -> String;
        /// Called on the JS/Fabric thread. Must not block, must not touch GPUI.
        fn rn_gpui_on_mount(batch: MountBatch);
        fn rn_gpui_on_animated_props(props: AnimatedPropsFlat);
        fn rn_gpui_on_text_input_command(tag: i32, focus: bool);
        fn rn_gpui_request_accessibility_focus(tag: i32);
        fn rn_gpui_on_text_input_clear(tag: i32);
        /// A wheel event's JS handlers have run: `prevented` is whether one called
        /// `preventDefault` or `stopPropagation`. Called on the JS thread.
        fn rn_gpui_on_wheel_done(id: u64, prevented: bool);
        /// Whether scrollers are drawn the legacy way, always shown.
        fn rn_gpui_scroller_legacy() -> bool;
        /// A batch of operations for a native tree, as JSON, from JavaScript.
        fn rn_gpui_native_root_ops(root: u32, ops: &str);
        /// Measures a host component under a constraint on the layout thread.
        /// `props` is the address of the node's props handle.
        fn rn_gpui_host_measure(
            index: u32,
            props: usize,
            min_width: f32,
            min_height: f32,
            max_width: f32,
            max_height: f32,
        ) -> HostMeasure;
        /// Whether surfaces start right to left, and whether left and right
        /// swap in that direction.
        fn rn_gpui_layout_direction_rtl() -> bool;
        fn rn_gpui_swap_left_and_right_in_rtl() -> bool;
        /// A command Fabric dispatched to a built-in component other than
        /// `TextInput`; `args_json` is the JSON array of its arguments.
        fn rn_gpui_on_builtin_command(tag: i32, component: &str, name: &str, args_json: &str);
        /// A command Fabric dispatched to a host component. The generated C++
        /// dispatcher already validated the arguments against the spec and
        /// resolved the command to its index in the spec's `COMMANDS`.
        fn rn_gpui_on_host_command(tag: i32, command: u32, args: Vec<HostCommandArg>);
        fn rn_gpui_set_animated_active(active: bool);
        fn rn_gpui_dev_menu_show();
        fn rn_gpui_dev_setting(name: &str, enabled: bool);
        /// Called from a module thread to run a task on the GPUI main thread.
        /// The task stays in C++ under `id`; the main loop calls
        /// `rn_gpui_run_main_task` for it.
        fn rn_gpui_run_on_main(id: u64);
        /// Whether the calling thread is the GPUI main thread.
        fn rn_gpui_is_main_thread() -> bool;
        /// Called on the JS/Fabric thread during layout. Thread-safe.
        fn rn_gpui_measure_text(
            p: &ParagraphFlat,
            max_width: f32,
            max_height: f32,
        ) -> MeasureResult;
        /// Shapes a paragraph for `max_width` like `rn_gpui_measure_text` and
        /// returns the layout with it, so the main thread paints it without
        /// shaping. Thread-safe.
        fn rn_gpui_prepare_text(p: &ParagraphFlat, max_width: f32) -> PreparedText;
        /// Another reference to a prepared layout, for an op to carry.
        fn rn_gpui_retain_prepared(handle: u64) -> u64;
        fn rn_gpui_release_prepared(handle: u64);
        /// Called on the JS/Fabric thread when a paragraph asks for `onTextLayout`.
        fn rn_gpui_measure_lines(p: &ParagraphFlat, max_width: f32) -> Vec<LineFlat>;
        fn rn_gpui_log(level: i32, message: &str);
        /// Whether `rn_gpui_log` at `level` is written anywhere, so a caller
        /// can skip formatting a message nobody reads.
        fn rn_gpui_log_enabled(level: i32) -> bool;
        fn rn_gpui_on_surface_stopped(surface_id: i32);
    }

    extern "Rust" {
        /// Returns the handle of a registered module, or 0 when no module has
        /// that name.
        fn rn_gpui_rust_module_create(name: &str) -> u64;
        fn rn_gpui_rust_module_methods(handle: u64) -> Vec<RustModuleMethod>;
        fn rn_gpui_rust_module_events(handle: u64) -> Vec<RustModuleEvent>;
        /// Runs a value method on the calling (JS) thread. The result is written
        /// into `scope` and returned, or `kDynamicNoNode` when `ok` is false.
        fn rn_gpui_rust_module_call_value(
            handle: u64,
            method: u32,
            scope: u32,
            args: u32,
            ok: &mut bool,
            code: &mut String,
            message: &mut String,
        ) -> u32;
        /// Converts the arguments on the calling thread, then queues the call on
        /// the module's thread; `ok` reports a conversion failure.
        fn rn_gpui_rust_module_call_void(
            handle: u64,
            method: u32,
            scope: u32,
            args: u32,
            ok: &mut bool,
            code: &mut String,
            message: &mut String,
        );
        /// The same, settling the promise `request` identifies.
        fn rn_gpui_rust_module_call_promise(
            handle: u64,
            method: u32,
            scope: u32,
            args: u32,
            request: i32,
        );
        /// Drops the module instance, which stops its thread.
        fn rn_gpui_rust_module_drop(handle: u64);
    }

    // SAFETY: the signatures match the declarations in `GpuiHostComponent.h`.
    unsafe extern "C++" {
        include!("GpuiHostComponent.h");

        /// Releases a props handle a mount op gave Rust.
        fn releaseHostPropsHandle(handle: usize);
        /// Releases an event emitter handle a `Create` op gave Rust.
        fn releaseHostEmitterHandle(handle: usize);
        /// How many times the C++ registry was asked for a component since the
        /// last reset. Only the test driver reads it.
        fn hostEntryLookups() -> u64;
        fn resetHostEntryLookups();
        /// Pushes a size a host component measured into its shadow node's state,
        /// which is what Yoga reads, and asks for the commit that re-measures.
        fn reportHostComponentSize(tag: i32, width: f32, height: f32);
        /// Pushes the size a native root laid its tree out at into its shadow
        /// node's state, where it becomes Yoga's size for the box.
        fn reportNativeRootSize(
            tag: i32,
            height: f32,
            has_width: bool,
            width: f32,
            min_width: f32,
        ) -> bool;
        /// Pushes the size the native layout gave a slot's placeholder into the
        /// slot's shadow node's state, where it becomes the content's size.
        fn reportNativeSlotSize(
            tag: i32,
            has_width: bool,
            width: f32,
            has_height: bool,
            height: f32,
        ) -> bool;
        /// Pushes the insets a container reported for its chrome into its shadow
        /// node's state, where they become Yoga padding around the children.
        fn reportHostComponentInsets(tag: i32, top: f32, right: f32, bottom: f32, left: f32);
    }

    // SAFETY: the signatures match the declarations in `GpuiCppHostBridge.h`.
    unsafe extern "C++" {
        include!("GpuiCppHostBridge.h");

        /// Creates the C++ view of a `cpp` host component node and gives it its
        /// first props. Zero when no C++ implementation is registered.
        fn rn_gpui_cpp_host_create(index: u32, tag: i32, props: usize) -> u64;
        fn rn_gpui_cpp_host_update(id: u64, props: usize);
        /// Creates the node's native view. `kind` is 0 for a composited view,
        /// 1 for an NSView and 2 for an X11 window; the result is the view.
        #[allow(clippy::too_many_arguments)]
        fn rn_gpui_cpp_host_create_view(
            id: u64,
            windows_visual: usize,
            wayland: bool,
            x11_window: u32,
            xcb_connection: usize,
            wayland_display: usize,
            wayland_surface: usize,
            kind: &mut u8,
        ) -> u64;
        fn rn_gpui_cpp_host_destroy(id: u64);
    }

    // SAFETY: the signatures match the declarations in `GpuiDynamic.h`.
    unsafe extern "C++" {
        include!("GpuiDynamic.h");

        /// Values cross as nodes in a C++-owned arena, one scope per call, so
        /// nothing is serialised to text.
        fn dynamic_scope_open() -> u32;
        fn dynamic_scope_close(scope: u32);
        fn dynamic_node_new(scope: u32, kind: u8) -> u32;
        fn dynamic_node_set_bool(scope: u32, node: u32, value: bool);
        fn dynamic_node_set_number(scope: u32, node: u32, value: f64);
        fn dynamic_node_set_text(scope: u32, node: u32, text: &str);
        fn dynamic_node_set_buffer(scope: u32, node: u32, bytes: &[u8]);
        fn dynamic_node_append(scope: u32, parent: u32, child: u32, key: &str);
        fn dynamic_node_kind(scope: u32, node: u32) -> u8;
        fn dynamic_node_bool(scope: u32, node: u32) -> bool;
        fn dynamic_node_number(scope: u32, node: u32) -> f64;
        fn dynamic_node_text(scope: u32, node: u32) -> String;
        fn dynamic_node_buffer_len(scope: u32, node: u32) -> usize;
        fn dynamic_node_buffer(scope: u32, node: u32) -> Vec<u8>;
        fn dynamic_node_len(scope: u32, node: u32) -> usize;
        fn dynamic_node_child(scope: u32, node: u32, index: usize) -> u32;
        fn dynamic_node_key(scope: u32, node: u32, index: usize) -> String;
    }

    // SAFETY: the signatures match the declarations in `GpuiRustTurboModules.h`.
    unsafe extern "C++" {
        include!("GpuiRustTurboModules.h");

        fn rn_gpui_rust_module_result(
            request: i32,
            ok: bool,
            scope: u32,
            root: u32,
            code: String,
            message: String,
        );
        fn rn_gpui_rust_callback_invoke(id: u64, scope: u32, root: u32);
        fn rn_gpui_rust_callback_drop(id: u64);
        fn rn_gpui_rust_module_emit(
            handle: u64,
            event: &str,
            has_value: bool,
            scope: u32,
            root: u32,
        );
        fn rn_gpui_rust_module_send_event(handle: u64, name: &str, scope: u32, root: u32);
        /// Drops the promises and JS functions of the runtime that is going
        /// away.
        fn rn_gpui_rust_module_clear_pending();
    }

    // SAFETY: the signatures match the declarations in `GpuiHttpBridge.h`.
    unsafe extern "C++" {
        include!("GpuiHttpBridge.h");

        /// Issue a request; the response arrives through `rn_gpui_http_complete`.
        fn rn_gpui_http_request(
            request_id: u64,
            method: &str,
            url: &str,
            headers: &str,
            body: &str,
        );
        fn rn_gpui_http_request_cancel(request_id: u64);
    }

    // SAFETY: the signatures match the declarations in `GpuiNetworkConfig.h`.
    unsafe extern "C++" {
        include!("GpuiNetworkConfig.h");

        /// Replaces the proxy and DNS settings; returns an error message or an
        /// empty string.
        fn rn_gpui_network_configure(mode: &str, rules: &str, bypass: &str, doh: &str) -> String;
        /// The proxy a request to `url` uses: `DIRECT` or the proxy's URL.
        fn rn_gpui_network_proxy_for(url: &str) -> String;
    }

    extern "Rust" {
        /// Called by the C++ bridge when a request finishes. Implemented in
        /// `rn-gpui`, which owns the future waiting for it.
        fn rn_gpui_http_complete(
            request_id: u64,
            status: i32,
            headers: &str,
            // Bytes, not text: GPUI loads images and fonts through this client,
            // and cxx rejects non-UTF-8 for `&str` by throwing. An image response
            // crashed the app with "data for rust::Str is not utf-8".
            body: &[u8],
            error: &str,
        );
    }

    // SAFETY: the signature matches the declaration in `GpuiStartupSignpost.h`.
    unsafe extern "C++" {
        include!("GpuiStartupSignpost.h");

        /// A startup stage, as an `os_signpost` point event. A no-op off Apple.
        fn rn_gpui_startup_signpost(stage: &str, elapsed_ms: u64);
    }

    // SAFETY: the signatures match the declarations in `GpuiHost.h`.
    unsafe extern "C++" {
        include!("GpuiHost.h");
        type GpuiHost;

        fn new_gpui_host(
            app_id: &str,
            dev_server_host: &str,
            dev_server_port: u32,
            js_engine: &str,
            js_thread: &str,
            dev_mode: bool,
        ) -> UniquePtr<GpuiHost>;
        fn load_script(self: Pin<&mut GpuiHost>, bundle_path: &str, source_url: &str) -> bool;
        fn start_surface(
            self: Pin<&mut GpuiHost>,
            surface_id: i32,
            module_name: &str,
            width: f32,
            height: f32,
            scale: f32,
        );
        fn start_surface_with_props(
            self: Pin<&mut GpuiHost>,
            surface_id: i32,
            module_name: &str,
            props_json: &str,
            width: f32,
            height: f32,
            scale: f32,
        );
        fn set_surface_size(
            self: Pin<&mut GpuiHost>,
            surface_id: i32,
            width: f32,
            height: f32,
            scale: f32,
        );
        /// Starts a surface whose size is a range rather than a point. Fabric
        /// lays the root out against the constraints and reports the size it
        /// used in every mount batch.
        fn start_surface_with_constraints(
            self: Pin<&mut GpuiHost>,
            surface_id: i32,
            module_name: &str,
            props_json: &str,
            min_width: f32,
            min_height: f32,
            max_width: f32,
            max_height: f32,
            scale: f32,
        );
        /// Changes a running surface's constraints.
        fn set_surface_constraints(
            self: Pin<&mut GpuiHost>,
            surface_id: i32,
            min_width: f32,
            min_height: f32,
            max_width: f32,
            max_height: f32,
            scale: f32,
        );
        fn set_window_top_inset(self: Pin<&mut GpuiHost>, top: f32);
        fn set_app_state(self: Pin<&mut GpuiHost>, state: &str);
        fn emit_memory_warning(self: &GpuiHost);
        fn set_window_metrics(self: Pin<&mut GpuiHost>, width: f32, height: f32, scale: f32);
        fn set_display_metrics(
            self: Pin<&mut GpuiHost>,
            screen_width: f32,
            screen_height: f32,
            font_scale: f32,
        );
        fn set_system_appearance(self: Pin<&mut GpuiHost>, appearance: &str);
        fn rn_gpui_run_main_task(id: u64);
        fn stop_surface(self: Pin<&mut GpuiHost>, surface_id: i32);
        fn request_reload(self: Pin<&mut GpuiHost>);
        fn set_dev_server(self: Pin<&mut GpuiHost>, host: &str, port: u32) -> bool;
        fn dev_server_address(self: &GpuiHost) -> String;
        fn open_debugger(self: &GpuiHost);
        fn js_frame_probe(self: &GpuiHost) -> u64;
        fn js_heap_bytes(self: &GpuiHost) -> u64;
        fn on_render(self: &GpuiHost) -> Result<()>;
        fn on_frame(self: &GpuiHost, timestamp: f64) -> Result<()>;
        fn on_pointer_frame(self: &GpuiHost, timestamp: f64) -> Result<()>;
        /// payload_json is a JSON object string, e.g. {"pageX":10,"pageY":20}
        fn dispatch_event(self: &GpuiHost, tag: i32, event_type: &str, payload_json: &str);
        /// Delivers a `topWheel` event whose `nativeEvent` can be prevented, then
        /// reports through `rn_gpui_on_wheel_done` once its handlers have run.
        fn dispatch_wheel(self: &GpuiHost, tag: i32, id: u64, payload_json: &str);
        fn emit_device_event(self: &GpuiHost, event_name: &str);
        fn emit_device_event_bool(self: &GpuiHost, event_name: &str, value: bool);
        fn emit_device_event_json(self: &GpuiHost, event_name: &str, payload_json: &str);
        fn dispatch_pointer_event(
            self: &GpuiHost,
            target_chain_json: &str,
            x: f32,
            y: f32,
            phase: i32,
            timestamp: f64,
        );
        fn set_scroll_offset(self: &GpuiHost, tag: i32, x: f32, y: f32);
    }
}

mod rust_module;

// The `extern "Rust"` declarations in the bridge resolve in this module, so the
// implementations are re-exported here.
pub use rust_module::{
    args_from_dynamic, rn_gpui_rust_module_call_promise, rn_gpui_rust_module_call_value,
    rn_gpui_rust_module_call_void, rn_gpui_rust_module_create, rn_gpui_rust_module_drop,
    rn_gpui_rust_module_events, rn_gpui_rust_module_methods, value_from_node, value_to_node,
};

use std::sync::OnceLock;

pub use ffi::{
    CornersF, EdgesF, LineFlat, MeasureResult, MountBatch, MountKind, MountOp, ParagraphFlat,
    PreparedText, RectF, ShadowF, TextFragmentFlat, ViewPropsFlat,
};

/// Where JavaScript runs with the Loom renderer: the `jsThread` autolink
/// recorded, fixed when the app is built.
pub const JS_THREAD: &str = env!("RN_GPUI_JS_THREAD_BUILT");
/// Whether the Loom renderer was active when this crate was built.
pub const LOOM_RENDERER: bool = match option_env!("RN_GPUI_LOOM_RENDERER_BUILT") {
    Some(value) => matches!(value.as_bytes(), b"1"),
    None => false,
};

pub type MountHandler = Box<dyn Fn(ffi::MountBatch) + Send + Sync>;
pub type MeasureHandler =
    Box<dyn Fn(&ffi::ParagraphFlat, f32, f32) -> ffi::MeasureResult + Send + Sync>;
pub type SurfaceStoppedHandler = Box<dyn Fn(i32) + Send + Sync>;
pub type AnimatedPropsHandler = Box<dyn Fn(ffi::AnimatedPropsFlat) + Send + Sync>;
pub type AnimatedActiveHandler = Box<dyn Fn(bool) + Send + Sync>;
pub type TextInputCommandHandler = Box<dyn Fn(i32, bool) + Send + Sync>;
pub type TextInputClearHandler = Box<dyn Fn(i32) + Send + Sync>;
pub type WheelDoneHandler = Box<dyn Fn(u64, bool) + Send + Sync>;
pub type ScrollerLegacyHandler = Box<dyn Fn() -> bool + Send + Sync>;
pub type LayoutDirectionHandler = Box<dyn Fn() -> (bool, bool) + Send + Sync>;
pub static LAYOUT_DIRECTION_HANDLER: OnceLock<LayoutDirectionHandler> = OnceLock::new();
pub type BuiltinCommandHandler = Box<dyn Fn(i32, &str, &str, &str) + Send + Sync>;
/// One command for one tag: the command's index and its validated arguments.
/// Called on the JS/Fabric thread.
pub type HostCommandHandler = Box<dyn Fn(i32, u32, Vec<ffi::HostCommandArg>) + Send + Sync>;
pub type AccessibilityFocusHandler = Box<dyn Fn(i32) + Send + Sync>;
pub static MOUNT_HANDLER: OnceLock<MountHandler> = OnceLock::new();
pub type LinesHandler = Box<dyn Fn(&ffi::ParagraphFlat, f32) -> Vec<ffi::LineFlat> + Send + Sync>;

pub type PreparedLayout = std::sync::Arc<dyn std::any::Any + Send + Sync>;
pub type PrepareHandler =
    Box<dyn Fn(&ffi::ParagraphFlat, f32) -> (PreparedLayout, ffi::MeasureResult) + Send + Sync>;
pub static PREPARE_HANDLER: OnceLock<PrepareHandler> = OnceLock::new();
pub static LINES_HANDLER: OnceLock<LinesHandler> = OnceLock::new();
pub static MEASURE_HANDLER: OnceLock<MeasureHandler> = OnceLock::new();
pub static SURFACE_STOPPED_HANDLER: OnceLock<SurfaceStoppedHandler> = OnceLock::new();
pub static ANIMATED_PROPS_HANDLER: OnceLock<AnimatedPropsHandler> = OnceLock::new();
pub static ANIMATED_ACTIVE_HANDLER: OnceLock<AnimatedActiveHandler> = OnceLock::new();
pub static TEXT_INPUT_COMMAND_HANDLER: OnceLock<TextInputCommandHandler> = OnceLock::new();
pub static TEXT_INPUT_CLEAR_HANDLER: OnceLock<TextInputClearHandler> = OnceLock::new();
pub static WHEEL_DONE_HANDLER: OnceLock<WheelDoneHandler> = OnceLock::new();
pub static SCROLLER_LEGACY_HANDLER: OnceLock<ScrollerLegacyHandler> = OnceLock::new();
pub type NativeRootOpsHandler = Box<dyn Fn(u32, &str) + Send + Sync>;
pub static NATIVE_ROOT_OPS_HANDLER: OnceLock<NativeRootOpsHandler> = OnceLock::new();
pub type HostMeasureHandler = Box<dyn Fn(u32, usize, [f32; 4]) -> Option<(f32, f32)> + Send + Sync>;
pub static HOST_MEASURE_HANDLER: OnceLock<HostMeasureHandler> = OnceLock::new();
pub static BUILTIN_COMMAND_HANDLER: OnceLock<BuiltinCommandHandler> = OnceLock::new();
pub static HOST_COMMAND_HANDLER: OnceLock<HostCommandHandler> = OnceLock::new();
pub static ACCESSIBILITY_FOCUS_HANDLER: OnceLock<AccessibilityFocusHandler> = OnceLock::new();
pub type MainTaskHandler = Box<dyn Fn(u64) + Send + Sync>;
pub static MAIN_TASK_HANDLER: OnceLock<MainTaskHandler> = OnceLock::new();
pub static MAIN_THREAD_ID: OnceLock<std::thread::ThreadId> = OnceLock::new();

/// Records the calling thread as the GPUI main thread. The main loop calls this
/// before it can receive main-thread tasks.
pub fn note_main_thread() {
    let _ = MAIN_THREAD_ID.set(std::thread::current().id());
}
pub type DevMenuShowHandler = Box<dyn Fn() + Send + Sync>;
pub static DEV_MENU_SHOW_HANDLER: OnceLock<DevMenuShowHandler> = OnceLock::new();
pub type DevSettingHandler = Box<dyn Fn(String, bool) + Send + Sync>;
pub static DEV_SETTING_HANDLER: OnceLock<DevSettingHandler> = OnceLock::new();
pub type DevMenuPerformHandler = Box<dyn Fn(String) + Send + Sync>;
pub static DEV_MENU_PERFORM_HANDLER: OnceLock<DevMenuPerformHandler> = OnceLock::new();
pub type TrayClickHandler = Box<dyn Fn(f32, f32, f32, f32, u8) + Send + Sync>;
pub static TRAY_CLICK_HANDLER: OnceLock<TrayClickHandler> = OnceLock::new();
pub type TrayMenuPerformHandler = Box<dyn Fn(String) + Send + Sync>;
pub static TRAY_MENU_PERFORM_HANDLER: OnceLock<TrayMenuPerformHandler> = OnceLock::new();
pub type MenuBarPerformHandler = Box<dyn Fn(String) + Send + Sync>;
pub static MENU_BAR_PERFORM_HANDLER: OnceLock<MenuBarPerformHandler> = OnceLock::new();
/// A finished HTTP request, reported by the bridge.
pub type HttpCompleteHandler = Box<dyn Fn(u64, i32, String, Vec<u8>, String) + Send + Sync>;
pub static HTTP_COMPLETE_HANDLER: OnceLock<HttpCompleteHandler> = OnceLock::new();

pub type ImageHandler = Box<dyn Fn(String, u64) + Send + Sync>;
pub static IMAGE_HANDLER: OnceLock<ImageHandler> = OnceLock::new();
pub type ImageCacheQueryHandler = Box<dyn Fn(&str) -> bool + Send + Sync>;
pub static IMAGE_CACHE_QUERY_HANDLER: OnceLock<ImageCacheQueryHandler> = OnceLock::new();
pub type FontLoadHandler = Box<dyn Fn(&str, &str) -> bool + Send + Sync>;
pub type TextImageHandler = Box<dyn Fn(&str, &str, f64, u32) -> String + Send + Sync>;
pub static FONT_LOAD_HANDLER: OnceLock<FontLoadHandler> = OnceLock::new();
pub static TEXT_IMAGE_HANDLER: OnceLock<TextImageHandler> = OnceLock::new();

fn rn_gpui_load_font(family: &str, uri: &str) -> bool {
    FONT_LOAD_HANDLER
        .get()
        .is_some_and(|handler| handler(family, uri))
}

fn rn_gpui_render_text_image(family: &str, text: &str, font_size: f64, color: u32) -> String {
    TEXT_IMAGE_HANDLER
        .get()
        .map_or_else(String::new, |handler| {
            handler(family, text, font_size, color)
        })
}

/// The C++ bridge reports a finished request here.
fn rn_gpui_http_complete(request_id: u64, status: i32, headers: &str, body: &[u8], error: &str) {
    if let Some(handler) = HTTP_COMPLETE_HANDLER.get() {
        handler(
            request_id,
            status,
            headers.to_string(),
            body.to_vec(),
            error.to_string(),
        );
    }
}

fn rn_gpui_load_image(uri: String, request_id: u64) {
    if let Some(handler) = IMAGE_HANDLER.get() {
        handler(uri, request_id);
    } else {
        ffi::rn_gpui_on_image_load_result(
            request_id,
            0.0,
            0.0,
            "image loader is not initialized".into(),
        );
    }
}

fn rn_gpui_image_is_cached(uri: &str) -> bool {
    IMAGE_CACHE_QUERY_HANDLER
        .get()
        .map(|handler| handler(uri))
        .unwrap_or(false)
}

pub const ALL_SURFACES: i32 = -1;

/// Fabric emits no Delete mutations for a dying surface, so this is the only
/// cleanup signal.
fn rn_gpui_on_surface_stopped(surface_id: i32) {
    match SURFACE_STOPPED_HANDLER.get() {
        Some(handler) => handler(surface_id),
        None => log::debug!(
            "rn_gpui_on_surface_stopped({surface_id}): no handler registered yet — dropped"
        ),
    }
}

/// Called on the Fabric thread. Queues the batch for the GPUI main thread and
/// returns at once, so mounting never blocks on rendering.
fn rn_gpui_on_mount(batch: ffi::MountBatch) {
    match MOUNT_HANDLER.get() {
        Some(handler) => handler(batch),
        None => {
            log::debug!(
                "rn_gpui_on_mount: dropping batch for surface {} ({} ops) — no handler registered",
                batch.surface_id,
                batch.ops.len()
            );
        }
    }
}

fn rn_gpui_on_animated_props(props: ffi::AnimatedPropsFlat) {
    if let Some(handler) = ANIMATED_PROPS_HANDLER.get() {
        handler(props);
    }
}

fn rn_gpui_set_animated_active(active: bool) {
    if let Some(handler) = ANIMATED_ACTIVE_HANDLER.get() {
        handler(active);
    }
}

fn rn_gpui_on_text_input_command(tag: i32, focus: bool) {
    if let Some(handler) = TEXT_INPUT_COMMAND_HANDLER.get() {
        handler(tag, focus);
    }
}

fn rn_gpui_on_text_input_clear(tag: i32) {
    if let Some(handler) = TEXT_INPUT_CLEAR_HANDLER.get() {
        handler(tag);
    }
}

fn rn_gpui_host_measure(
    index: u32,
    props: usize,
    min_width: f32,
    min_height: f32,
    max_width: f32,
    max_height: f32,
) -> ffi::HostMeasure {
    let measured = HOST_MEASURE_HANDLER
        .get()
        .and_then(|handler| handler(index, props, [min_width, min_height, max_width, max_height]));
    match measured {
        Some((width, height)) => ffi::HostMeasure {
            width,
            height,
            measured: true,
        },
        None => ffi::HostMeasure::default(),
    }
}

fn rn_gpui_native_root_ops(root: u32, ops: &str) {
    if let Some(handler) = NATIVE_ROOT_OPS_HANDLER.get() {
        handler(root, ops);
    }
}

fn rn_gpui_scroller_legacy() -> bool {
    SCROLLER_LEGACY_HANDLER
        .get()
        .is_some_and(|handler| handler())
}

fn rn_gpui_on_wheel_done(id: u64, prevented: bool) {
    if let Some(handler) = WHEEL_DONE_HANDLER.get() {
        handler(id, prevented);
    }
}

fn rn_gpui_layout_direction_rtl() -> bool {
    LAYOUT_DIRECTION_HANDLER
        .get()
        .is_some_and(|handler| handler().0)
}

fn rn_gpui_swap_left_and_right_in_rtl() -> bool {
    LAYOUT_DIRECTION_HANDLER
        .get()
        .map_or(true, |handler| handler().1)
}

fn rn_gpui_on_builtin_command(tag: i32, component: &str, name: &str, args_json: &str) {
    if let Some(handler) = BUILTIN_COMMAND_HANDLER.get() {
        handler(tag, component, name, args_json);
    }
}

fn rn_gpui_on_host_command(tag: i32, command: u32, args: Vec<ffi::HostCommandArg>) {
    if let Some(handler) = HOST_COMMAND_HANDLER.get() {
        handler(tag, command, args);
    }
}

fn rn_gpui_request_accessibility_focus(tag: i32) {
    if let Some(handler) = ACCESSIBILITY_FOCUS_HANDLER.get() {
        handler(tag);
    }
}

fn rn_gpui_dev_menu_show() {
    if let Some(handler) = DEV_MENU_SHOW_HANDLER.get() {
        handler();
    }
}

fn rn_gpui_run_on_main(id: u64) {
    match MAIN_TASK_HANDLER.get() {
        Some(handler) => handler(id),
        None => {
            // No main loop is listening (startup, or a build without the
            // desktop module), so the task would never run. Say so once.
            static WARNED: std::sync::Once = std::sync::Once::new();
            WARNED.call_once(|| {
                log::warn!("rn_gpui_run_on_main: no main-thread handler installed; task dropped");
            });
        }
    }
}

fn rn_gpui_is_main_thread() -> bool {
    MAIN_THREAD_ID
        .get()
        .is_some_and(|id| *id == std::thread::current().id())
}

fn rn_gpui_dev_setting(name: &str, enabled: bool) {
    if let Some(handler) = DEV_SETTING_HANDLER.get() {
        handler(name.to_string(), enabled);
    }
}

fn rn_gpui_measure_text(
    p: &ffi::ParagraphFlat,
    max_width: f32,
    max_height: f32,
) -> ffi::MeasureResult {
    match MEASURE_HANDLER.get() {
        Some(handler) => handler(p, max_width, max_height),
        None => ffi::MeasureResult::default(),
    }
}

fn rn_gpui_prepare_text(p: &ffi::ParagraphFlat, max_width: f32) -> ffi::PreparedText {
    let Some(handler) = PREPARE_HANDLER.get() else {
        return ffi::PreparedText::default();
    };
    let (layout, measured) = handler(p, max_width);
    ffi::PreparedText {
        handle: Box::into_raw(Box::new(layout)) as u64,
        width: measured.width,
        height: measured.height,
    }
}

fn rn_gpui_retain_prepared(handle: u64) -> u64 {
    if handle == 0 {
        return 0;
    }
    // SAFETY: a nonzero handle is a live `Box<PreparedLayout>` this module made.
    let layout = unsafe { &*(handle as *const PreparedLayout) };
    Box::into_raw(Box::new(layout.clone())) as u64
}

fn rn_gpui_release_prepared(handle: u64) {
    if handle != 0 {
        // SAFETY: as above, and released once.
        drop(unsafe { Box::from_raw(handle as *mut PreparedLayout) });
    }
}

/// Takes ownership of the layout an op carries, once.
pub fn take_prepared(handle: u64) -> Option<PreparedLayout> {
    // SAFETY: as above; the caller does not use `handle` again.
    (handle != 0).then(|| *unsafe { Box::from_raw(handle as *mut PreparedLayout) })
}

fn rn_gpui_measure_lines(p: &ffi::ParagraphFlat, max_width: f32) -> Vec<ffi::LineFlat> {
    match LINES_HANDLER.get() {
        Some(handler) => handler(p, max_width),
        None => Vec::new(),
    }
}

fn rn_gpui_log_enabled(level: i32) -> bool {
    log::log_enabled!(match level {
        0 => log::Level::Debug,
        1 => log::Level::Info,
        2 => log::Level::Warn,
        _ => log::Level::Error,
    })
}

fn rn_gpui_log(level: i32, message: &str) {
    match level {
        0 => log::debug!("{message}"),
        1 => log::info!("{message}"),
        2 => log::warn!("{message}"),
        _ => log::error!("{message}"),
    }
}

// SAFETY: the C++ GpuiHost is created, driven and dropped from the GPUI main
// thread; the wrapper is moved to Rust, so cxx needs this declared explicitly.
unsafe impl Send for ffi::GpuiHost {}
// SAFETY: as for `Send`, every call goes through the GPUI main thread.
unsafe impl Sync for ffi::GpuiHost {}
