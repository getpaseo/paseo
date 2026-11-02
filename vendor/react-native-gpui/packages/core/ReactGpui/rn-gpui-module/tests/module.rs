use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rn_gpui_module::{
    descriptor, register, sink_calls, spawn_main, EventEmitter, EventInfo, FromValue, IntoValue,
    Job, MethodInfo, MethodKind, ModuleDescriptor, ModuleError, ModuleInstance, ModuleQueue,
    ModuleThread, Path, RawCallback, SinkCall, Value,
};

/// The sink is process-wide, so tests that read it take turns.
static SINK_LOCK: Mutex<()> = Mutex::new(());

fn read<T: FromValue>(value: Value, module: &'static str, method: &'static str) -> T {
    let mut path = Path::argument(module, method, 0, "value");
    T::from_value(value, &mut path).expect("value converts")
}

fn read_err<T: FromValue>(value: Value) -> ModuleError {
    let mut path = Path::argument("Fixture", "summarize", 1, "options");
    match T::from_value(value, &mut path) {
        Ok(_) => panic!("expected a conversion error"),
        Err(error) => error,
    }
}

#[test]
fn values_round_trip_through_every_type() {
    assert_eq!(read::<String>(Value::String("hi".into()), "M", "m"), "hi");
    assert_eq!(read::<f64>(Value::Number(1.5), "M", "m"), 1.5);
    assert_eq!(read::<i32>(Value::Number(7.0), "M", "m"), 7);
    assert!(read::<bool>(Value::Bool(true), "M", "m"));
    assert_eq!(read::<()>(Value::Null, "M", "m"), ());
    assert_eq!(read::<Option<String>>(Value::Null, "M", "m"), None);
    assert_eq!(
        read::<Option<String>>(Value::String("x".into()), "M", "m"),
        Some("x".to_string())
    );
    assert_eq!(
        read::<Vec<i32>>(
            Value::Array(vec![Value::Number(1.0), Value::Number(2.0)]),
            "M",
            "m"
        ),
        vec![1, 2]
    );
    let nested = Value::Object(vec![(
        "tags".to_string(),
        Value::Array(vec![Value::String("a".into())]),
    )]);
    let Value::Object(fields) = nested else {
        unreachable!()
    };
    assert_eq!(fields.len(), 1);

    assert_eq!(String::from("s").into_value().type_name(), "string");
    assert_eq!(1.5f64.into_value().type_name(), "number");
    assert_eq!(3i32.into_value().type_name(), "number");
    assert_eq!(true.into_value().type_name(), "boolean");
    assert_eq!(().into_value().type_name(), "null");
    assert_eq!(None::<String>.into_value().type_name(), "null");
    assert_eq!(
        vec![1i32, 2].into_value().type_name(),
        "array",
        "Vec<T> converts to an array"
    );
    assert_eq!(Value::Null.into_value().type_name(), "null");
}

#[test]
fn conversion_errors_name_the_argument_and_field() {
    let error = read_err::<String>(Value::Number(1.0));
    assert_eq!(
        error.message,
        "Fixture.summarize: argument 1 (options): expected string, got number"
    );

    let mut path = Path::argument("Fixture", "summarize", 1, "options");
    let error = rn_gpui_module::__private::field::<String>(&mut path, "label", Value::Number(1.0))
        .expect_err("expected a conversion error");
    assert_eq!(
        error.message,
        "Fixture.summarize: argument 1 (options).label: expected string, got number"
    );

    let error = read_err::<Vec<String>>(Value::Array(vec![Value::Number(2.0)]));
    assert_eq!(
        error.message,
        "Fixture.summarize: argument 1 (options).0: expected string, got number"
    );

    let error = read_err::<Vec<String>>(Value::Null);
    assert_eq!(
        error.message,
        "Fixture.summarize: argument 1 (options): expected array, got null"
    );

    let error = read_err::<i32>(Value::Number(1.5));
    assert_eq!(
        error.message,
        "Fixture.summarize: argument 1 (options): expected Int32, got 1.5"
    );

    let error = ModuleError::with_code("E_X", "bad");
    assert_eq!(error.code.as_deref(), Some("E_X"));
    assert_eq!(error.to_string(), "bad");
    assert_eq!(ModuleError::from("plain").message, "plain");
    assert_eq!(ModuleError::from(String::from("owned")).message, "owned");
}

#[test]
fn callbacks_and_events_reach_the_sink() {
    let _guard = SINK_LOCK.lock().unwrap();
    let _ = sink_calls();
    let callback = RawCallback::new(11);
    assert_eq!(callback.id(), 11);
    callback.invoke(vec![Value::String("value".into()), Value::Bool(true)]);
    let dropped = RawCallback::new(12);
    drop(dropped);
    let events = EventEmitter::new(3);
    events.emit("onProgress", Some(Value::Number(1.0)));
    events.emit("onDone", None);
    events.send_event(
        "fixtureTick",
        Value::Object(vec![("n".into(), Value::Number(1.0))]),
    );

    let calls = sink_calls();
    assert_eq!(calls.len(), 5, "unexpected calls: {calls:?}");
    match &calls[0] {
        SinkCall::InvokeCallback { id, args } => {
            assert_eq!(*id, 11);
            assert_eq!(args.len(), 2);
            assert!(matches!(&args[0], Value::String(text) if text == "value"));
            assert!(matches!(&args[1], Value::Bool(true)));
        }
        other => panic!("expected an invoke, got {other:?}"),
    }
    assert!(matches!(&calls[1], SinkCall::DropCallback { id } if *id == 12));
    assert!(
        matches!(&calls[2], SinkCall::EmitEvent { module, event, value } if *module == 3 && event == "onProgress" && matches!(value, Some(Value::Number(_))))
    );
    assert!(
        matches!(&calls[3], SinkCall::EmitEvent { event, value, .. } if event == "onDone" && value.is_none())
    );
    assert!(matches!(&calls[4], SinkCall::SendEvent { name, .. } if name == "fixtureTick"));
}

struct Fixture {
    _events: EventEmitter,
    calls: Arc<AtomicUsize>,
}

impl Fixture {
    fn greet(&self, name: String) -> Result<String, ModuleError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(format!("hi {name}"))
    }

    fn boom(&self) {
        panic!("boom");
    }
}

impl ModuleInstance for Fixture {
    fn call_value(&self, method: usize, args: Vec<Value>) -> Result<Value, ModuleError> {
        match method {
            0 => {
                let mut args = rn_gpui_module::__private::Args::new("Fixture", "greet", args);
                let name: String = args.next("name")?;
                let greeting = rn_gpui_module::__private::catch(|| self.greet(name))??;
                Ok(greeting.into_value())
            }
            _ => Err(ModuleError::new("Fixture: unknown method")),
        }
    }

    fn prepare_void(
        self: Arc<Self>,
        method: usize,
        _args: Vec<Value>,
    ) -> Result<Box<dyn FnOnce() + Send + 'static>, ModuleError> {
        match method {
            1 => Ok(Box::new(move || {
                rn_gpui_module::__private::run_void("Fixture.boom", move || self.boom())
            })),
            _ => Err(ModuleError::new("Fixture: unknown method")),
        }
    }

    fn call_promise(
        self: Arc<Self>,
        _method: usize,
        _args: Vec<Value>,
    ) -> Result<rn_gpui_module::LocalBoxFuture<Result<Value, ModuleError>>, ModuleError> {
        Err(ModuleError::new("Fixture: no promise method"))
    }
}

static FIXTURE_CALLS: Mutex<Option<Arc<AtomicUsize>>> = Mutex::new(None);

fn create_fixture(events: EventEmitter) -> Arc<dyn ModuleInstance> {
    let calls = Arc::new(AtomicUsize::new(0));
    *FIXTURE_CALLS.lock().unwrap() = Some(calls.clone());
    Arc::new(Fixture {
        _events: events,
        calls,
    })
}

const METHODS: &[MethodInfo] = &[
    MethodInfo {
        name: "greet",
        arg_count: 1,
        required_args: 1,
        kind: MethodKind::Value,
        returns_void: false,
        callback_args: &[],
    },
    MethodInfo {
        name: "boom",
        arg_count: 0,
        required_args: 0,
        kind: MethodKind::Void,
        returns_void: true,
        callback_args: &[],
    },
];

const EVENTS: &[EventInfo] = &[EventInfo {
    name: "onProgress",
    has_value: true,
}];

#[test]
fn the_registry_finds_a_module_and_rejects_a_duplicate() {
    register(ModuleDescriptor {
        name: "Fixture",
        thread: ModuleThread::Own,
        methods: METHODS,
        events: EVENTS,
        create: create_fixture,
    });
    let found = descriptor("Fixture").expect("registered");
    assert_eq!(found.methods.len(), 2);
    assert_eq!(found.methods[0].name, "greet");
    assert_eq!(found.thread, ModuleThread::Own);
    assert!(descriptor("Missing").is_none());

    let duplicate = std::panic::catch_unwind(|| {
        register(ModuleDescriptor {
            name: "Fixture",
            thread: ModuleThread::Own,
            methods: METHODS,
            events: EVENTS,
            create: create_fixture,
        })
    });
    assert!(duplicate.is_err(), "a duplicate name must panic");
}

#[test]
fn a_module_instance_converts_arguments_and_turns_panics_into_errors() {
    register(ModuleDescriptor {
        name: "FixtureCalls",
        thread: ModuleThread::Main,
        methods: METHODS,
        events: EVENTS,
        create: create_fixture,
    });
    let module = (descriptor("FixtureCalls").expect("registered").create)(EventEmitter::new(9));
    let value = module
        .call_value(0, vec![Value::String("gpui".into())])
        .expect("greet works");
    assert!(matches!(value, Value::String(text) if text == "hi gpui"));

    let error = module
        .call_value(0, Vec::new())
        .expect_err("missing argument");
    let _ = &error;
    assert_eq!(
        error.message, "Fixture.greet: argument 0 (name) is missing",
        "the generated glue names the argument"
    );

    let work = module
        .clone()
        .prepare_void(1, Vec::new())
        .expect("prepared");
    work();
    let calls = sink_calls();
    assert!(
        calls.iter().any(|call| matches!(
            call,
            SinkCall::Log { message } if message == "Fixture.boom: the module panicked: boom"
        )),
        "unexpected calls: {calls:?}"
    );
}

#[test]
fn a_panic_becomes_an_error() {
    let error = rn_gpui_module::__private::catch(|| panic!("boom")).expect_err("caught");
    assert_eq!(error.message, "the module panicked: boom");
    let ok = rn_gpui_module::__private::catch(|| 7).expect("no panic");
    assert_eq!(ok, 7);

    let error = futures::executor::block_on(async {
        rn_gpui_module::__private::catch_async(async { panic!("async boom") })
            .await
            .expect_err("caught")
    });
    assert_eq!(error.message, "the module panicked: async boom");
}

#[test]
fn the_queue_runs_jobs_in_order_on_one_other_thread() {
    let queue = ModuleQueue::new("FixtureQueue");
    let caller = std::thread::current().id();
    let threads = Arc::new(Mutex::new(Vec::new()));
    let order = Arc::new(Mutex::new(Vec::new()));
    let done = Arc::new(AtomicUsize::new(0));
    for index in 0..8 {
        let threads = threads.clone();
        let order = order.clone();
        let done = done.clone();
        queue.post(Box::new(move || {
            threads.lock().unwrap().push(std::thread::current().id());
            order.lock().unwrap().push(index);
            done.fetch_add(1, Ordering::SeqCst);
            Box::pin(async {})
        }));
    }
    let awaited = Arc::new(AtomicUsize::new(0));
    let awaited_job = awaited.clone();
    queue.post(Box::new(move || {
        Box::pin(async move {
            futures::future::ready(()).await;
            std::thread::sleep(Duration::from_millis(20));
            awaited_job.fetch_add(1, Ordering::SeqCst);
        })
    }));
    let after = awaited.clone();
    queue.post(Box::new(move || {
        Box::pin(async move {
            assert_eq!(
                after.load(Ordering::SeqCst),
                1,
                "the awaiting job ran first"
            );
        })
    }));
    for _ in 0..500 {
        if done.load(Ordering::SeqCst) == 8 && awaited.load(Ordering::SeqCst) == 1 {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(done.load(Ordering::SeqCst), 8);
    assert_eq!(awaited.load(Ordering::SeqCst), 1);
    assert_eq!(*order.lock().unwrap(), (0..8).collect::<Vec<_>>());
    assert!(
        threads.lock().unwrap().iter().all(|id| *id != caller),
        "jobs must not run on the caller's thread"
    );
    assert_eq!(threads.lock().unwrap().len(), 8);
    assert!(
        threads
            .lock()
            .unwrap()
            .windows(2)
            .all(|pair| pair[0] == pair[1]),
        "every job must run on the same thread"
    );
}

#[test]
fn dropping_the_queue_with_pending_jobs_does_not_hang() {
    let queue = ModuleQueue::new("FixtureDrop");
    let started = Arc::new(AtomicUsize::new(0));
    for _ in 0..4 {
        let started = started.clone();
        queue.post(Box::new(move || {
            Box::pin(async move {
                started.fetch_add(1, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(10));
            })
        }));
    }
    queue.post(Box::new(|| {
        Box::pin(async {
            futures::future::pending::<()>().await;
        })
    }));
    drop(queue);
    assert!(started.load(Ordering::SeqCst) <= 4);
}

#[test]
fn spawn_main_without_a_spawner_drops_the_job() {
    let ran = Arc::new(AtomicUsize::new(0));
    let job_ran = ran.clone();
    let job: Job = Box::new(move || {
        Box::pin(async move {
            job_ran.fetch_add(1, Ordering::SeqCst);
        })
    });
    spawn_main(job);
    assert_eq!(ran.load(Ordering::SeqCst), 0);
}

#[test]
fn a_value_callback_is_debug_only() {
    let _guard = SINK_LOCK.lock().unwrap();
    let value = Value::Callback(RawCallback::new(1));
    let text = format!("{value:?}");
    assert!(text.contains("RawCallback"), "{text}");
    drop(value);
}
