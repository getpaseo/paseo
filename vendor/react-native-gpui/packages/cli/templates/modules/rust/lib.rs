//! A Rust TurboModule: the trait, the events handle and the value structs come
//! from the spec file next to it.

rn_gpui_module::include_specs!();

use rn_gpui_module::ModuleError;

pub struct RNModule;

impl NativeModuleSpec for RNModule {
    fn new(_events: NativeModuleEvents) -> Self {
        Self
    }

    /// A method that returns a value runs on the JS thread. A method that
    /// returns `void` or a `Promise` runs on the module's own thread unless the
    /// impl adds `const THREAD: ModuleThread = ModuleThread::Main;`.
    fn greet(&self, name: String) -> Result<String, ModuleError> {
        Ok(format!("Hello from Rust, {name}!"))
    }
}

/// Called by the app's autolink shim, which keeps these modules linked in.
pub fn rn_gpui_register() {
    rn_gpui_module::register(native_RNMODULESNAKE_module::<RNModule>());
}
