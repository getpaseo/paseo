use std::sync::{Arc, Mutex, OnceLock};

use crate::{EventEmitter, LocalBoxFuture, ModuleError, Value};

/// Where a module's `void` and `Promise` methods run; value methods always run
/// on the JS thread.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModuleThread {
    Own,
    Main,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MethodKind {
    Value,
    Void,
    Promise,
}

pub struct MethodInfo {
    pub name: &'static str,
    pub arg_count: usize,
    /// How many arguments JS has to pass: the parameters up to the last one
    /// that is not `Option<_>`, since an optional parameter may be left out.
    pub required_args: usize,
    pub kind: MethodKind,
    /// Whether the spec returns `void`, which makes a promise resolve with
    /// `undefined` rather than `null`.
    pub returns_void: bool,
    /// Positions that hold a callback, which the host replaces with a
    /// `RawCallback` id before converting the arguments.
    pub callback_args: &'static [usize],
}

pub struct EventInfo {
    pub name: &'static str,
    pub has_value: bool,
}

/// Implemented for the author's type by the generated glue.
pub trait ModuleInstance: Send + Sync + 'static {
    fn call_value(&self, method: usize, args: Vec<Value>) -> Result<Value, ModuleError>;

    /// Converts the arguments and returns the call for the host to run on the
    /// module's thread, so a conversion failure reaches JS before anything is
    /// queued.
    fn prepare_void(
        self: Arc<Self>,
        method: usize,
        args: Vec<Value>,
    ) -> Result<Box<dyn FnOnce() + Send + 'static>, ModuleError>;

    /// Called on the JS thread; the future it returns is polled on the module's
    /// thread.
    fn call_promise(
        self: Arc<Self>,
        method: usize,
        args: Vec<Value>,
    ) -> Result<LocalBoxFuture<Result<Value, ModuleError>>, ModuleError>;
}

pub struct ModuleDescriptor {
    pub name: &'static str,
    pub thread: ModuleThread,
    pub methods: &'static [MethodInfo],
    pub events: &'static [EventInfo],
    pub create: fn(EventEmitter) -> Arc<dyn ModuleInstance>,
}

static REGISTRY: OnceLock<Mutex<Vec<&'static ModuleDescriptor>>> = OnceLock::new();

fn registry() -> &'static Mutex<Vec<&'static ModuleDescriptor>> {
    REGISTRY.get_or_init(|| Mutex::new(Vec::new()))
}

/// Registering a duplicate panics, which would otherwise poison the lock and
/// fail every later lookup: the list itself is left unchanged by that panic, so
/// recovering it is safe.
fn modules() -> std::sync::MutexGuard<'static, Vec<&'static ModuleDescriptor>> {
    registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Registers a module, panicking on a duplicate name.
pub fn register(descriptor: ModuleDescriptor) {
    let descriptor: &'static ModuleDescriptor = Box::leak(Box::new(descriptor));
    let mut modules = modules();
    if modules.iter().any(|module| module.name == descriptor.name) {
        panic!(
            "a Rust TurboModule named {} is already registered",
            descriptor.name
        );
    }
    modules.push(descriptor);
}

pub fn descriptor(name: &str) -> Option<&'static ModuleDescriptor> {
    modules().iter().find(|module| module.name == name).copied()
}

pub fn descriptors() -> Vec<&'static ModuleDescriptor> {
    modules().clone()
}
