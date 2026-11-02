use rn_gpui_sys::ffi;
use std::sync::{Arc, Mutex, OnceLock};

/// The live host, for the paths that must reach C++ without an `App`.
static LIVE_HOST: OnceLock<Host> = OnceLock::new();

/// Stops a surface by id, for code that has no `App`.
pub(crate) fn stop_surface_without_app(id: i32) {
    if let Some(host) = LIVE_HOST.get() {
        host.stop_surface(id);
    }
}

/// The app's host, if one has been made.
pub(crate) fn live_host() -> Option<&'static Host> {
    LIVE_HOST.get()
}

// Unit tests build a Rust-only GPUI TestAppContext without the consuming app's
// generated C++ component registry. Keep the host seam inert in that target;
// the app-level e2e tests exercise the real C++/Fabric boundary.
#[derive(Clone)]
#[cfg_attr(test, allow(dead_code))]
pub struct Host(Arc<Mutex<cxx::UniquePtr<ffi::GpuiHost>>>);

impl Host {
    pub fn new(app_id: &str, dev_host: &str, port: u32, js_engine: &str, dev_mode: bool) -> Self {
        #[cfg(test)]
        {
            let _ = (app_id, dev_host, port, js_engine, dev_mode);
            return Self::test_stub();
        }
        #[cfg(not(test))]
        {
            crate::host_component::freeze();
            let host = Self(Arc::new(Mutex::new(ffi::new_gpui_host(
                app_id, dev_host, port, js_engine, dev_mode,
            ))));
            let _ = LIVE_HOST.set(host.clone());
            host
        }
    }

    /// The C++ host. A panic in another thread while it held the lock leaves
    /// only a raw handle behind, so a poisoned lock is still usable.
    #[cfg(not(test))]
    fn lock(&self) -> std::sync::MutexGuard<'_, cxx::UniquePtr<ffi::GpuiHost>> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    #[cfg(test)]
    pub(crate) fn test_stub() -> Self {
        Self(Arc::new(Mutex::new(cxx::UniquePtr::null())))
    }

    pub fn load_script(&self, bundle: &str, url: &str) -> bool {
        #[cfg(test)]
        {
            let _ = (self, bundle, url);
            false
        }
        #[cfg(not(test))]
        self.lock().pin_mut().load_script(bundle, url)
    }

    pub fn start_surface(&self, id: i32, module: &str, w: f32, h: f32, scale: f32) {
        #[cfg(test)]
        let _ = (self, id, module, w, h, scale);
        #[cfg(not(test))]
        self.lock().pin_mut().start_surface(id, module, w, h, scale)
    }

    pub fn start_surface_with_props(
        &self,
        id: i32,
        module: &str,
        props_json: &str,
        w: f32,
        h: f32,
        scale: f32,
    ) {
        #[cfg(test)]
        let _ = (self, id, module, props_json, w, h, scale);
        #[cfg(not(test))]
        self.lock()
            .pin_mut()
            .start_surface_with_props(id, module, props_json, w, h, scale)
    }

    pub fn set_surface_size(&self, id: i32, w: f32, h: f32, scale: f32) {
        #[cfg(test)]
        let _ = (self, id, w, h, scale);
        #[cfg(not(test))]
        self.lock().pin_mut().set_surface_size(id, w, h, scale)
    }

    /// Starts a surface whose size is a range, not a point.
    #[allow(clippy::too_many_arguments)]
    pub fn start_surface_with_constraints(
        &self,
        id: i32,
        module: &str,
        props_json: &str,
        min_width: f32,
        min_height: f32,
        max_width: f32,
        max_height: f32,
        scale: f32,
    ) {
        #[cfg(test)]
        let _ = (
            self, id, module, props_json, min_width, min_height, max_width, max_height, scale,
        );
        #[cfg(not(test))]
        self.lock().pin_mut().start_surface_with_constraints(
            id, module, props_json, min_width, min_height, max_width, max_height, scale,
        )
    }

    /// Changes a running surface's constraints, which resizes an embedded
    /// surface when the taffy box around it changes.
    #[allow(clippy::too_many_arguments)]
    pub fn set_surface_constraints(
        &self,
        id: i32,
        min_width: f32,
        min_height: f32,
        max_width: f32,
        max_height: f32,
        scale: f32,
    ) {
        #[cfg(test)]
        let _ = (
            self, id, min_width, min_height, max_width, max_height, scale,
        );
        #[cfg(not(test))]
        self.lock()
            .pin_mut()
            .set_surface_constraints(id, min_width, min_height, max_width, max_height, scale)
    }

    pub fn stop_surface(&self, id: i32) {
        #[cfg(test)]
        let _ = (self, id);
        #[cfg(not(test))]
        self.lock().pin_mut().stop_surface(id)
    }

    pub fn set_window_top_inset(&self, top: f32) {
        #[cfg(test)]
        let _ = (self, top);
        #[cfg(not(test))]
        self.lock().pin_mut().set_window_top_inset(top)
    }

    pub fn set_window_metrics(&self, w: f32, h: f32, scale: f32) {
        #[cfg(test)]
        let _ = (self, w, h, scale);
        #[cfg(not(test))]
        self.lock().pin_mut().set_window_metrics(w, h, scale)
    }

    pub fn request_reload(&self) {
        #[cfg(test)]
        let _ = self;
        #[cfg(not(test))]
        self.lock().pin_mut().request_reload()
    }

    pub fn set_dev_server(&self, host: &str, port: u32) -> bool {
        #[cfg(test)]
        {
            let _ = (self, host, port);
            false
        }
        #[cfg(not(test))]
        self.lock().pin_mut().set_dev_server(host, port)
    }

    pub fn dev_server_address(&self) -> String {
        #[cfg(test)]
        {
            let _ = self;
            String::new()
        }
        #[cfg(not(test))]
        self.lock().dev_server_address()
    }

    pub fn open_debugger(&self) {
        #[cfg(test)]
        let _ = self;
        #[cfg(not(test))]
        self.lock().open_debugger()
    }

    pub fn js_frame_probe(&self) -> u64 {
        #[cfg(test)]
        {
            let _ = self;
            0
        }
        #[cfg(not(test))]
        self.lock().js_frame_probe()
    }

    pub fn js_heap_bytes(&self) -> u64 {
        #[cfg(test)]
        {
            let _ = self;
            0
        }
        #[cfg(not(test))]
        self.lock().js_heap_bytes()
    }

    pub fn set_system_appearance(&self, appearance: &str) {
        #[cfg(test)]
        let _ = (self, appearance);
        #[cfg(not(test))]
        self.lock().pin_mut().set_system_appearance(appearance)
    }

    pub fn on_render(&self) {
        #[cfg(not(test))]
        if let Err(error) = self.lock().on_render() {
            log::error!("[event-beat] {error}");
        }
    }

    pub fn on_frame(&self, timestamp: f64) {
        #[cfg(test)]
        let _ = timestamp;
        #[cfg(not(test))]
        if let Err(error) = self.lock().on_frame(timestamp) {
            log::error!("[animation-frame] {error}");
        }
    }

    pub fn on_pointer_frame(&self, timestamp: f64) {
        #[cfg(test)]
        let _ = timestamp;
        #[cfg(not(test))]
        if let Err(error) = self.lock().on_pointer_frame(timestamp) {
            log::error!("[gesture-frame] {error}");
        }
    }

    pub fn dispatch_event(&self, tag: i32, ty: &str, payload: &serde_json::Value) {
        #[cfg(test)]
        let _ = (self, tag, ty, payload);
        #[cfg(not(test))]
        self.lock().dispatch_event(tag, ty, &payload.to_string())
    }

    pub fn emit_device_event(&self, event_name: &str) {
        #[cfg(test)]
        let _ = (self, event_name);
        #[cfg(not(test))]
        self.lock().emit_device_event(event_name)
    }

    pub fn emit_device_event_bool(&self, event_name: &str, value: bool) {
        #[cfg(test)]
        let _ = (self, event_name, value);
        #[cfg(not(test))]
        self.lock().emit_device_event_bool(event_name, value)
    }

    /// Device event with a JSON object payload. The string
    /// must be a JSON object; the native side drops a malformed payload with a
    /// warning rather than throwing on the main thread.
    pub fn emit_device_event_json(&self, event_name: &str, payload_json: &str) {
        #[cfg(test)]
        let _ = (self, event_name, payload_json);
        #[cfg(not(test))]
        self.lock().emit_device_event_json(event_name, payload_json)
    }

    pub fn dispatch_pointer_event(
        &self,
        target_chain: &[i32],
        x: f32,
        y: f32,
        phase: i32,
        timestamp: f64,
    ) {
        #[cfg(test)]
        let _ = (self, target_chain, x, y, phase, timestamp);
        #[cfg(not(test))]
        {
            let target_chain = serde_json::to_string(target_chain).unwrap_or_default();
            self.lock()
                .dispatch_pointer_event(&target_chain, x, y, phase, timestamp);
        }
    }

    pub fn set_scroll_offset(&self, tag: i32, x: f32, y: f32) {
        #[cfg(test)]
        let _ = (self, tag, x, y);
        #[cfg(not(test))]
        self.lock().set_scroll_offset(tag, x, y)
    }
}
