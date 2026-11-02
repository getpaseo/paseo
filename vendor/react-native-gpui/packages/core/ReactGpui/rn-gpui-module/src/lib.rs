//! The runtime a Rust TurboModule is written against: the value tree, errors,
//! events and threads the generated glue uses. It depends on nothing but
//! `futures`, so it needs no C++ toolchain and no JS runtime to test.

mod error;
mod host;
mod private;
mod queue;
mod registry;
mod value;

pub use error::ModuleError;
pub use host::{
    log_error, run_void, set_host_hooks, sink_calls, EventEmitter, HostHooks, RawCallback, SinkCall,
};
pub use private::Path;
pub use queue::{
    is_main_thread, note_main_thread, set_main_spawner, spawn_main, Job, LocalBoxFuture,
    ModuleQueue,
};
pub use registry::{
    descriptor, descriptors, register, EventInfo, MethodInfo, MethodKind, ModuleDescriptor,
    ModuleInstance, ModuleThread,
};
pub use value::{ArrayBuffer, FromValue, IntoValue, Value};

#[doc(hidden)]
pub mod __private {
    pub use crate::private::{
        catch, catch_async, field, location, log_error, panic_error, run_void, Args, FieldMap, Path,
    };
}

/// Includes what `rn-gpui-module-build` generated from the crate's specs.
#[macro_export]
macro_rules! include_specs {
    () => {
        #[allow(clippy::all, unused)]
        pub mod rn_gpui_specs {
            include!(concat!(env!("OUT_DIR"), "/rn_gpui_specs.rs"));
        }
        pub use rn_gpui_specs::*;
    };
}
