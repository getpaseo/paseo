//! The Rust side of the TurboModule bridge: the handle registry, the value
//! conversions, and the hooks the module crate calls back through.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use rn_gpui_module::{
    descriptor, EventEmitter, HostHooks, ModuleDescriptor, ModuleInstance, ModuleQueue,
    ModuleThread, RawCallback, Value,
};

use crate::ffi;

const DYNAMIC_NULL: u8 = 0;
const DYNAMIC_BOOL: u8 = 1;
const DYNAMIC_NUMBER: u8 = 2;
const DYNAMIC_STRING: u8 = 3;
const DYNAMIC_ARRAY: u8 = 4;
const DYNAMIC_OBJECT: u8 = 5;
const DYNAMIC_BUFFER: u8 = 6;
const NO_NODE: u32 = 0xffff_ffff;

/// A module instance JS asked for, with the queue its `void` and `Promise`
/// methods run on.
struct Handle {
    instance: Arc<dyn ModuleInstance>,
    descriptor: &'static ModuleDescriptor,
    queue: OnceLock<ModuleQueue>,
}

static HANDLES: OnceLock<Mutex<HashMap<u64, Arc<Handle>>>> = OnceLock::new();
static NEXT_HANDLE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn handles() -> &'static Mutex<HashMap<u64, Arc<Handle>>> {
    HANDLES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn handle_for(id: u64) -> Option<Arc<Handle>> {
    handles()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(&id)
        .cloned()
}

impl Handle {
    fn queue(&self) -> &ModuleQueue {
        self.queue
            .get_or_init(|| ModuleQueue::new(self.descriptor.name))
    }
}

/// Converts the JS arguments of a call; the positions in `callback_args` hold a
/// `RawCallback` id the C++ side put there.
pub fn args_from_dynamic(scope: u32, args: u32, callback_args: &[usize]) -> Vec<Value> {
    let converted = value_from_node(scope, args);
    let Value::Array(items) = converted else {
        return vec![converted];
    };
    items
        .into_iter()
        .enumerate()
        .map(|(index, item)| {
            if callback_args.contains(&index) {
                match item {
                    Value::Number(id) => Value::Callback(RawCallback::new(id as u64)),
                    other => other,
                }
            } else {
                item
            }
        })
        .collect()
}

pub fn value_from_node(scope: u32, node: u32) -> Value {
    match ffi::dynamic_node_kind(scope, node) {
        DYNAMIC_BOOL => Value::Bool(ffi::dynamic_node_bool(scope, node)),
        DYNAMIC_NUMBER => Value::Number(ffi::dynamic_node_number(scope, node)),
        DYNAMIC_STRING => Value::String(ffi::dynamic_node_text(scope, node)),
        DYNAMIC_BUFFER => Value::Buffer(ffi::dynamic_node_buffer(scope, node)),
        DYNAMIC_ARRAY => Value::Array(
            (0..ffi::dynamic_node_len(scope, node))
                .map(|index| value_from_node(scope, ffi::dynamic_node_child(scope, node, index)))
                .collect(),
        ),
        DYNAMIC_OBJECT => Value::Object(
            (0..ffi::dynamic_node_len(scope, node))
                .map(|index| {
                    let key = ffi::dynamic_node_key(scope, node, index);
                    let child = ffi::dynamic_node_child(scope, node, index);
                    (key, value_from_node(scope, child))
                })
                .collect(),
        ),
        _ => Value::Null,
    }
}

/// Writes the value tree into a scope and returns its root node. A callback
/// never appears in a result, so it becomes null instead of failing the call.
pub fn value_to_node(scope: u32, value: Value) -> u32 {
    let (kind, number, text) = match &value {
        Value::Null | Value::Callback(_) => (DYNAMIC_NULL, 0.0, String::new()),
        Value::Bool(flag) => (DYNAMIC_BOOL, if *flag { 1.0 } else { 0.0 }, String::new()),
        Value::Number(number) => (DYNAMIC_NUMBER, *number, String::new()),
        Value::String(text) => (DYNAMIC_STRING, 0.0, text.clone()),
        Value::Buffer(_) => (DYNAMIC_BUFFER, 0.0, String::new()),
        Value::Array(_) => (DYNAMIC_ARRAY, 0.0, String::new()),
        Value::Object(_) => (DYNAMIC_OBJECT, 0.0, String::new()),
    };
    let node = ffi::dynamic_node_new(scope, kind);
    match kind {
        DYNAMIC_BOOL => ffi::dynamic_node_set_bool(scope, node, number != 0.0),
        DYNAMIC_NUMBER => ffi::dynamic_node_set_number(scope, node, number),
        DYNAMIC_STRING => ffi::dynamic_node_set_text(scope, node, &text),
        DYNAMIC_BUFFER => {
            if let Value::Buffer(bytes) = value {
                ffi::dynamic_node_set_buffer(scope, node, &bytes);
            }
        }
        DYNAMIC_ARRAY | DYNAMIC_OBJECT => {
            let children = match value {
                Value::Array(items) => items
                    .into_iter()
                    .map(|item| (String::new(), item))
                    .collect::<Vec<_>>(),
                Value::Object(fields) => fields,
                _ => Vec::new(),
            };
            for (key, item) in children {
                let child = value_to_node(scope, item);
                ffi::dynamic_node_append(scope, node, child, &key);
            }
        }
        _ => {}
    }
    node
}

/// Builds a value in a fresh scope for a result that crosses later. The caller
/// closes the scope.
fn scope_for_value(value: Value) -> (u32, u32) {
    let scope = ffi::dynamic_scope_open();
    let root = value_to_node(scope, value);
    (scope, root)
}

fn result_parts(error: rn_gpui_module::ModuleError) -> (bool, String, String) {
    (false, error.code.unwrap_or_default(), error.message)
}

fn report_result(request: i32, result: Result<Value, rn_gpui_module::ModuleError>) {
    let (ok, value, code, message) = match result {
        Ok(value) => (true, Some(value), String::new(), String::new()),
        Err(error) => {
            let (_, code, message) = result_parts(error);
            (false, None, code, message)
        }
    };
    let (scope, root) = match value {
        Some(value) => scope_for_value(value),
        None => (ffi::dynamic_scope_open(), NO_NODE),
    };
    ffi::rn_gpui_rust_module_result(request, ok, scope, root, code, message);
    ffi::dynamic_scope_close(scope);
}

fn install_hooks() {
    static INSTALLED: OnceLock<()> = OnceLock::new();
    INSTALLED.get_or_init(|| {
        rn_gpui_module::set_host_hooks(HostHooks {
            invoke_callback: |id, args| {
                let (scope, root) = scope_for_value(Value::Array(args));
                ffi::rn_gpui_rust_callback_invoke(id, scope, root);
                ffi::dynamic_scope_close(scope);
            },
            drop_callback: |id| ffi::rn_gpui_rust_callback_drop(id),
            emit_event: |module, event, value| {
                let has_value = value.is_some();
                let (scope, root) = match value {
                    Some(value) => scope_for_value(value),
                    None => (ffi::dynamic_scope_open(), NO_NODE),
                };
                ffi::rn_gpui_rust_module_emit(module, event, has_value, scope, root);
                ffi::dynamic_scope_close(scope);
            },
            send_event: |module, name, body| {
                let (scope, root) = scope_for_value(body);
                ffi::rn_gpui_rust_module_send_event(module, name, scope, root);
                ffi::dynamic_scope_close(scope);
            },
            log: |message| log::error!("{message}"),
        });
    });
}

pub fn rn_gpui_rust_module_create(name: &str) -> u64 {
    let Some(descriptor) = descriptor(name) else {
        return 0;
    };
    install_hooks();
    let id = NEXT_HANDLE.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let instance = (descriptor.create)(EventEmitter::new(id));
    handles()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(
            id,
            Arc::new(Handle {
                instance,
                descriptor,
                queue: OnceLock::new(),
            }),
        );
    id
}

pub fn rn_gpui_rust_module_methods(handle: u64) -> Vec<ffi::RustModuleMethod> {
    let Some(handle) = handle_for(handle) else {
        return Vec::new();
    };
    handle
        .descriptor
        .methods
        .iter()
        .map(|method| ffi::RustModuleMethod {
            name: method.name.to_string(),
            arg_count: method.arg_count as u32,
            required_args: method.required_args as u32,
            kind: match method.kind {
                rn_gpui_module::MethodKind::Value => 0,
                rn_gpui_module::MethodKind::Void => 1,
                rn_gpui_module::MethodKind::Promise => 2,
            },
            returns_void: method.returns_void,
            callback_args: method
                .callback_args
                .iter()
                .map(|index| *index as u32)
                .collect(),
        })
        .collect()
}

pub fn rn_gpui_rust_module_events(handle: u64) -> Vec<ffi::RustModuleEvent> {
    let Some(handle) = handle_for(handle) else {
        return Vec::new();
    };
    handle
        .descriptor
        .events
        .iter()
        .map(|event| ffi::RustModuleEvent {
            name: event.name.to_string(),
            has_value: event.has_value,
        })
        .collect()
}

pub fn rn_gpui_rust_module_call_value(
    handle: u64,
    method: u32,
    scope: u32,
    args: u32,
    ok: &mut bool,
    code: &mut String,
    message: &mut String,
) -> u32 {
    let Some(handle) = handle_for(handle) else {
        *ok = false;
        *message = "the Rust module is gone".to_string();
        return NO_NODE;
    };
    let Some(info) = handle.descriptor.methods.get(method as usize) else {
        *ok = false;
        *message = "unknown method".to_string();
        return NO_NODE;
    };
    let converted = args_from_dynamic(scope, args, info.callback_args);
    match handle.instance.call_value(method as usize, converted) {
        Ok(value) => {
            *ok = true;
            value_to_node(scope, value)
        }
        Err(error) => {
            let (_, error_code, error_message) = result_parts(error);
            *ok = false;
            *code = error_code;
            *message = error_message;
            NO_NODE
        }
    }
}

pub fn rn_gpui_rust_module_call_void(
    handle: u64,
    method: u32,
    scope: u32,
    args: u32,
    ok: &mut bool,
    code: &mut String,
    message: &mut String,
) {
    let Some(handle) = handle_for(handle) else {
        *ok = false;
        *message = "the Rust module is gone".to_string();
        return;
    };
    let Some(info) = handle.descriptor.methods.get(method as usize) else {
        *ok = false;
        *message = "unknown method".to_string();
        return;
    };
    // Arguments are converted here, on the calling thread, so a bad argument is
    // a thrown JS error rather than a silent failure on the module thread.
    let converted = args_from_dynamic(scope, args, info.callback_args);
    match handle
        .instance
        .clone()
        .prepare_void(method as usize, converted)
    {
        Ok(work) => {
            *ok = true;
            post(
                &handle,
                Box::new(move || {
                    work();
                    Box::pin(async {})
                }),
            );
        }
        Err(error) => {
            let (_, error_code, error_message) = result_parts(error);
            *ok = false;
            *code = error_code;
            *message = error_message;
        }
    }
}

pub fn rn_gpui_rust_module_call_promise(
    handle: u64,
    method: u32,
    scope: u32,
    args: u32,
    request: i32,
) {
    let Some(module) = handle_for(handle) else {
        report_result(
            request,
            Err(rn_gpui_module::ModuleError::new("the Rust module is gone")),
        );
        return;
    };
    let Some(info) = module.descriptor.methods.get(method as usize) else {
        report_result(
            request,
            Err(rn_gpui_module::ModuleError::new("unknown method")),
        );
        return;
    };
    let converted = args_from_dynamic(scope, args, info.callback_args);
    // The future is created on the module's thread: it does not have to be
    // `Send`, only the job that builds it does.
    let instance = module.instance.clone();
    let job: rn_gpui_module::Job = Box::new(move || {
        let future = instance.call_promise(method as usize, converted);
        Box::pin(async move {
            // A panic here would kill the module thread, and the host is the
            // only side that can settle the promise.
            let reported = rn_gpui_module::__private::catch_async(async move {
                match future {
                    Ok(future) => report_result(request, future.await),
                    Err(error) => report_result(request, Err(error)),
                }
            })
            .await;
            if let Err(error) = reported {
                rn_gpui_module::log_error("a Rust promise result", &error);
            }
        })
    });
    post(&module, job);
}

pub fn rn_gpui_rust_module_drop(handle_id: u64) {
    // Removing the last reference stops the queue, which ends its thread and
    // drops unfinished futures; results still in flight are discarded by C++
    // because their request ids are gone.
    handles()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(&handle_id);
}

fn post(handle: &Handle, job: rn_gpui_module::Job) {
    match handle.descriptor.thread {
        ModuleThread::Own => handle.queue().post(job),
        ModuleThread::Main => rn_gpui_module::spawn_main(job),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_nested_value_round_trips_through_a_scope() {
        let value = Value::Object(vec![
            ("text".into(), Value::String("hello".into())),
            ("count".into(), Value::Number(2.5)),
            ("whole".into(), Value::Number(3.0)),
            ("flag".into(), Value::Bool(true)),
            ("nothing".into(), Value::Null),
            (
                "items".into(),
                Value::Array(vec![
                    Value::Number(1.0),
                    Value::Object(vec![("deep".into(), Value::String("yes".into()))]),
                ]),
            ),
        ]);
        let scope = ffi::dynamic_scope_open();
        let root = value_to_node(scope, value);
        let round_tripped = value_from_node(scope, root);
        ffi::dynamic_scope_close(scope);

        let Value::Object(fields) = &round_tripped else {
            panic!("expected an object, got {round_tripped:?}");
        };
        let field = |name: &str| {
            fields
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value)
                .unwrap_or_else(|| panic!("missing field {name}"))
        };
        assert!(matches!(field("text"), Value::String(text) if text == "hello"));
        assert!(matches!(field("count"), Value::Number(number) if *number == 2.5));
        assert!(matches!(field("whole"), Value::Number(number) if *number == 3.0));
        assert!(matches!(field("flag"), Value::Bool(true)));
        assert!(matches!(field("nothing"), Value::Null));
        let Value::Array(items) = field("items") else {
            panic!("expected an array");
        };
        assert_eq!(items.len(), 2);
        assert!(matches!(&items[0], Value::Number(number) if *number == 1.0));
        let Value::Object(nested) = &items[1] else {
            panic!("expected a nested object");
        };
        assert!(matches!(&nested[0].1, Value::String(text) if text == "yes"));
    }

    #[test]
    fn callback_positions_become_raw_callbacks() {
        let scope = ffi::dynamic_scope_open();
        let args = value_to_node(
            scope,
            Value::Array(vec![Value::String("key".into()), Value::Number(41.0)]),
        );
        let converted = args_from_dynamic(scope, args, &[1]);
        ffi::dynamic_scope_close(scope);
        assert!(matches!(&converted[0], Value::String(text) if text == "key"));
        match &converted[1] {
            Value::Callback(callback) => assert_eq!(callback.id(), 41),
            other => panic!("expected a callback, got {other:?}"),
        }
    }
}

/// `GpuiHost.cpp` calls this hook, which the `rn-gpui` crate defines. This
/// crate's own unit-test binary links the C++ core without `rn-gpui`, so on
/// Linux the reference is unresolved. Windows uses an `/alternatename` fallback
/// in the C++ instead. Lives here rather than in `lib.rs` because `lib.rs` is a
/// prebuilt input and this is test-only.
#[cfg(test)]
#[no_mangle]
pub extern "C" fn rn_gpui_accessibility_active() -> bool {
    false
}
