use std::any::Any;
use std::sync::{Mutex, OnceLock};

use crate::{ModuleError, Value};

/// A JS function passed as an argument, which appears as `Value::Callback` and
/// never in a result. Calling it consumes it, so it can be called at most once;
/// dropping it without calling releases the JS function.
pub struct RawCallback {
    id: u64,
}

impl RawCallback {
    pub fn new(id: u64) -> Self {
        Self { id }
    }

    pub fn id(&self) -> u64 {
        self.id
    }

    pub fn invoke(self, args: Vec<Value>) {
        let this = std::mem::ManuallyDrop::new(self);
        (hooks().invoke_callback)(this.id, args);
    }
}

impl std::fmt::Debug for RawCallback {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_tuple("RawCallback")
            .field(&self.id)
            .finish()
    }
}

impl Drop for RawCallback {
    fn drop(&mut self) {
        (hooks().drop_callback)(self.id);
    }
}

/// Emits one module instance's typed and device events. Cheap to clone and
/// usable from any thread; emitting before JS subscribes, or after a reload,
/// does nothing.
#[derive(Clone, Debug)]
pub struct EventEmitter {
    module: u64,
}

impl EventEmitter {
    pub fn new(module: u64) -> Self {
        Self { module }
    }

    pub fn emit(&self, event: &str, value: Option<Value>) {
        (hooks().emit_event)(self.module, event, value);
    }

    pub fn send_event(&self, name: &str, body: Value) {
        (hooks().send_event)(self.module, name, body);
    }
}

/// What the host installs so the crate can reach JS; without hooks the calls
/// are recorded in the sink instead.
#[derive(Clone, Copy)]
pub struct HostHooks {
    pub invoke_callback: fn(u64, Vec<Value>),
    pub drop_callback: fn(u64),
    pub emit_event: fn(u64, &str, Option<Value>),
    pub send_event: fn(u64, &str, Value),
    /// Reports a failure with nowhere else to go, such as a `void` method that
    /// failed on the module thread.
    pub log: fn(&str),
}

static HOST_HOOKS: OnceLock<HostHooks> = OnceLock::new();

pub fn set_host_hooks(hooks: HostHooks) {
    let _ = HOST_HOOKS.set(hooks);
}

fn hooks() -> HostHooks {
    *HOST_HOOKS.get().unwrap_or(&HostHooks {
        invoke_callback: sink_invoke_callback,
        drop_callback: sink_drop_callback,
        emit_event: sink_emit_event,
        send_event: sink_send_event,
        log: sink_log,
    })
}

#[derive(Debug)]
pub enum SinkCall {
    InvokeCallback {
        id: u64,
        args: Vec<Value>,
    },
    DropCallback {
        id: u64,
    },
    EmitEvent {
        module: u64,
        event: String,
        value: Option<Value>,
    },
    SendEvent {
        module: u64,
        name: String,
        body: Value,
    },
    Log {
        message: String,
    },
}

static SINK: OnceLock<Mutex<Vec<SinkCall>>> = OnceLock::new();

fn sink() -> &'static Mutex<Vec<SinkCall>> {
    SINK.get_or_init(|| Mutex::new(Vec::new()))
}

pub fn sink_calls() -> Vec<SinkCall> {
    let mut calls = sink()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    std::mem::take(&mut *calls)
}

fn sink_invoke_callback(id: u64, args: Vec<Value>) {
    sink()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .push(SinkCall::InvokeCallback { id, args });
}

fn sink_drop_callback(id: u64) {
    sink()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .push(SinkCall::DropCallback { id });
}

fn sink_emit_event(module: u64, event: &str, value: Option<Value>) {
    sink()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .push(SinkCall::EmitEvent {
            module,
            event: event.to_string(),
            value,
        });
}

fn sink_send_event(module: u64, name: &str, body: Value) {
    sink()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .push(SinkCall::SendEvent {
            module,
            name: name.to_string(),
            body,
        });
}

fn sink_log(message: &str) {
    sink()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .push(SinkCall::Log {
            message: message.to_string(),
        });
}

pub fn log_error(location: &str, error: &ModuleError) {
    (hooks().log)(&format!("{location}: {error}"));
}

/// Runs a queued `void` call, turning a panic or an error into a log line.
pub fn run_void(location: &str, body: impl FnOnce()) {
    if let Err(error) = catch(body) {
        log_error(location, &error);
    }
}

/// Turns a caught panic into an error, so it never unwinds into C++ or kills a
/// module thread.
pub fn panic_error(payload: Box<dyn Any + Send>) -> ModuleError {
    let message = payload
        .downcast_ref::<&str>()
        .map(|text| (*text).to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "panicked".to_string());
    ModuleError::new(format!("the module panicked: {message}"))
}

pub fn catch<T>(body: impl FnOnce() -> T) -> Result<T, ModuleError> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(body)).map_err(panic_error)
}

pub async fn catch_async<F: std::future::Future>(future: F) -> Result<F::Output, ModuleError> {
    use futures::FutureExt;
    std::panic::AssertUnwindSafe(future)
        .catch_unwind()
        .await
        .map_err(panic_error)
}
