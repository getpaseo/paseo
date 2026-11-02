//! Compiles the generator's output for a spec that uses every type in the
//! mapping table and calls each method through the descriptor.

rn_gpui_module::include_specs!();

use rn_gpui_module::{ArrayBuffer, ModuleError, ModuleThread, Value};

pub struct Probe {
    events: NativeProbeEvents,
    recorded: std::sync::Mutex<Vec<String>>,
}

impl NativeProbeSpec for Probe {
    const THREAD: ModuleThread = ModuleThread::Main;

    fn new(events: NativeProbeEvents) -> Self {
        Self {
            events,
            recorded: std::sync::Mutex::new(Vec::new()),
        }
    }

    fn scalar(
        &self,
        text: String,
        count: f64,
        whole: i32,
        flag: bool,
    ) -> Result<bool, ModuleError> {
        Ok(!text.is_empty() && count > 0.0 && whole == 1 && flag)
    }

    fn optional_value(
        &self,
        maybe: Option<String>,
        nullable: Option<String>,
    ) -> Result<Option<String>, ModuleError> {
        Ok(match (maybe, nullable) {
            (Some(maybe), Some(nullable)) => Some(format!("{maybe}/{nullable}")),
            (Some(maybe), None) => Some(maybe),
            (None, Some(nullable)) => Some(nullable),
            (None, None) => None,
        })
    }

    fn lists(&self, items: Vec<String>, readonly_items: Vec<f64>) -> Result<Vec<i32>, ModuleError> {
        Ok(items
            .iter()
            .map(|item| item.len() as i32 + readonly_items.len() as i32)
            .collect())
    }

    fn options(&self, value: Options, again: Options) -> Result<Options, ModuleError> {
        Ok(Options {
            r#type: value.r#type,
            label: value.label.or(again.label),
            count: value.count + again.count,
            mode: value.mode,
            ratio: value.ratio.or(again.ratio),
            nested: value.nested,
        })
    }

    fn meta(&self, value: Meta) -> Result<Meta, ModuleError> {
        Ok(value)
    }

    fn rank(&self, value: Rank) -> Result<Rank, ModuleError> {
        Ok(value)
    }

    fn r#match(&self, text: String) -> Result<String, ModuleError> {
        Ok(format!("matched {text}"))
    }

    fn level(&self, level: Level) -> Result<LevelResult, ModuleError> {
        Ok(match level {
            Level::Low => LevelResult::Left,
            Level::High => LevelResult::Right,
        })
    }

    fn anything(&self, value: Value) -> Result<Value, ModuleError> {
        Ok(value)
    }

    fn nothing(&self) {}

    fn inline(&self, value: InlineValue) {
        self.recorded.lock().unwrap().push(format!(
            "inline {} {}",
            value.x,
            value.y.unwrap_or_default()
        ));
    }

    async fn later(&self, text: String) -> Result<String, ModuleError> {
        Ok(format!("later {text}"))
    }

    async fn done(&self) -> Result<(), ModuleError> {
        self.events.on_done();
        Ok(())
    }

    fn lookup(&self, key: String, callback: Box<dyn FnOnce(String, bool) + Send>) {
        callback(format!("value of {key}"), key == "gpui");
    }

    async fn lookup_later(
        &self,
        key: String,
        callback: Box<dyn FnOnce(String, bool) + Send>,
    ) -> Result<String, ModuleError> {
        let found = key == "gpui";
        if found {
            callback(format!("later value of {key}"), true);
        }
        Ok(if found { "called" } else { "dropped" }.to_string())
    }

    fn sum(&self, data: ArrayBuffer) -> Result<f64, ModuleError> {
        Ok(data.iter().map(|byte| f64::from(*byte)).sum())
    }

    fn reversed(&self, data: ArrayBuffer) -> Result<ArrayBuffer, ModuleError> {
        let mut bytes = data.into_vec();
        bytes.reverse();
        Ok(bytes.into())
    }

    fn start(&self, steps: f64) {
        for step in 1..=(steps as i32) {
            self.events.on_progress(f64::from(step));
        }
        self.events.send_event(
            "fixtureTick",
            Value::Object(vec![("n".into(), Value::Number(1.0))]),
        );
    }

    fn add_listener(&self, _event_name: String) {}

    fn remove_listeners(&self, _count: f64) {}
}

#[cfg(test)]
/// The sink is process-wide, so tests that read it take turns.
#[cfg(test)]
static SINK_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
fn probe() -> std::sync::Arc<dyn rn_gpui_module::ModuleInstance> {
    (native_probe_module::<Probe>().create)(rn_gpui_module::EventEmitter::new(7))
}

#[cfg(test)]
fn index(name: &str) -> usize {
    native_probe_module::<Probe>()
        .methods
        .iter()
        .position(|method| method.name == name)
        .expect("the spec has this method")
}

#[cfg(test)]
fn call(name: &str, args: Vec<Value>) -> Result<Value, ModuleError> {
    probe().call_value(index(name), args)
}

#[test]
fn the_descriptor_describes_the_spec() {
    let descriptor = native_probe_module::<Probe>();
    assert_eq!(descriptor.name, "NativeProbe");
    assert_eq!(descriptor.thread, ModuleThread::Main);
    assert_eq!(descriptor.methods.len(), 20);
    assert_eq!(descriptor.events.len(), 2);
    assert_eq!(descriptor.events[0].name, "onProgress");
    assert!(descriptor.events[0].has_value);
    assert!(!descriptor.events[1].has_value);
    let lookup = &descriptor.methods[index("lookup")];
    assert_eq!(lookup.callback_args, &[1]);
    assert_eq!(lookup.kind, rn_gpui_module::MethodKind::Void);
    let done = &descriptor.methods[index("done")];
    assert!(done.returns_void, "Promise<void> resolves with undefined");
    let optional = &descriptor.methods[index("optionalValue")];
    assert_eq!(optional.arg_count, 2);
    assert_eq!(optional.required_args, 2);
    let nothing = &descriptor.methods[index("nothing")];
    assert_eq!(nothing.arg_count, 0);
    assert_eq!(nothing.required_args, 0);
}

#[test]
fn value_methods_convert_arguments_and_results() {
    let value = call(
        "scalar",
        vec![
            Value::String("text".into()),
            Value::Number(2.5),
            Value::Number(1.0),
            Value::Bool(true),
        ],
    )
    .expect("scalar works");
    assert!(matches!(value, Value::Bool(true)));

    let value = call(
        "optionalValue",
        vec![Value::Null, Value::String("here".into())],
    )
    .expect("optionalValue works");
    assert!(matches!(value, Value::String(text) if text == "here"));
    let value = call(
        "optionalValue",
        vec![Value::String("a".into()), Value::Null],
    )
    .expect("optionalValue works");
    assert!(matches!(value, Value::String(text) if text == "a"));

    let value = call(
        "lists",
        vec![
            Value::Array(vec![Value::String("ab".into())]),
            Value::Array(vec![Value::Number(1.0), Value::Number(2.0)]),
        ],
    )
    .expect("lists works");
    assert!(matches!(value, Value::Array(items) if items.len() == 1));

    let options = Value::Object(vec![
        ("type".into(), Value::String("first".into())),
        ("label".into(), Value::String("first".into())),
        ("count".into(), Value::Number(2.0)),
        ("mode".into(), Value::String("right".into())),
        ("ratio".into(), Value::Null),
        (
            "nested".into(),
            Value::Object(vec![
                ("flag".into(), Value::Bool(true)),
                (
                    "names".into(),
                    Value::Array(vec![Value::String("n".into())]),
                ),
            ]),
        ),
    ]);
    let second = Value::Object(vec![
        ("type".into(), Value::String("second".into())),
        ("count".into(), Value::Number(3.0)),
        ("mode".into(), Value::String("left".into())),
        (
            "nested".into(),
            Value::Object(vec![
                ("flag".into(), Value::Bool(false)),
                ("names".into(), Value::Array(Vec::new())),
            ]),
        ),
    ]);
    let value = call("options", vec![options, second]).expect("options works");
    let Value::Object(fields) = &value else {
        panic!("options returns an object");
    };
    let field = |name: &str| {
        fields
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value)
            .expect("field")
    };
    assert!(matches!(field("label"), Value::String(text) if text == "first"));
    assert!(matches!(field("count"), Value::Number(count) if *count == 5.0));
    assert!(matches!(field("mode"), Value::String(mode) if mode == "right"));

    let value = call("level", vec![Value::String("high".into())]).expect("level works");
    assert!(matches!(value, Value::String(mode) if mode == "right"));

    let value = call(
        "anything",
        vec![Value::Object(vec![("a".into(), Value::Number(1.0))])],
    )
    .expect("anything works");
    assert!(matches!(value, Value::Object(fields) if fields.len() == 1));
}

#[test]
fn void_and_promise_methods_go_through_their_own_entry_points() {
    let _guard = SINK_LOCK.lock().unwrap();
    let _ = rn_gpui_module::sink_calls();
    let module = probe();
    module
        .clone()
        .prepare_void(index("nothing"), Vec::new())
        .expect("nothing converts")();
    module
        .clone()
        .prepare_void(
            index("inline"),
            vec![Value::Object(vec![
                ("x".into(), Value::Number(1.5)),
                ("y".into(), Value::String("why".into())),
            ])],
        )
        .expect("inline converts")();

    let future = module
        .clone()
        .call_promise(index("later"), vec![Value::String("gpui".into())])
        .expect("later builds a future");
    let value = futures::executor::block_on(future).expect("later resolves");
    assert!(matches!(value, Value::String(text) if text == "later gpui"));

    let future = module
        .clone()
        .call_promise(index("done"), Vec::new())
        .expect("done builds a future");
    let value = futures::executor::block_on(future).expect("done resolves");
    assert!(matches!(value, Value::Null), "Promise<void> resolves null");
    let events = rn_gpui_module::sink_calls();
    assert!(
        events.iter().any(|call| matches!(
            call,
            rn_gpui_module::SinkCall::EmitEvent {
                event,
                value: None,
                ..
            } if event == "onDone"
        )),
        "an event without a payload reaches the host"
    );
}

#[test]
fn callbacks_and_events_reach_the_host() {
    let _guard = SINK_LOCK.lock().unwrap();
    let _ = rn_gpui_module::sink_calls();
    let module = probe();
    module
        .clone()
        .prepare_void(
            index("lookup"),
            vec![
                Value::String("gpui".into()),
                Value::Callback(rn_gpui_module::RawCallback::new(21)),
            ],
        )
        .expect("lookup converts")();
    module
        .clone()
        .prepare_void(index("start"), vec![Value::Number(2.0)])
        .expect("start converts")();

    let calls = rn_gpui_module::sink_calls();
    let invoked = calls.iter().find_map(|call| match call {
        rn_gpui_module::SinkCall::InvokeCallback { id, args } => Some((*id, args)),
        _ => None,
    });
    let (id, args) = invoked.expect("the callback was invoked");
    assert_eq!(id, 21);
    assert!(matches!(&args[0], Value::String(text) if text == "value of gpui"));
    assert!(matches!(&args[1], Value::Bool(true)));
    let progress: Vec<f64> = calls
        .iter()
        .filter_map(|call| match call {
            rn_gpui_module::SinkCall::EmitEvent { event, value, .. } if event == "onProgress" => {
                match value {
                    Some(Value::Number(number)) => Some(*number),
                    _ => None,
                }
            }
            _ => None,
        })
        .collect();
    assert_eq!(progress, vec![1.0, 2.0]);
    assert!(calls.iter().any(|call| matches!(
        call,
        rn_gpui_module::SinkCall::SendEvent { name, .. } if name == "fixtureTick"
    )));
}

#[test]
fn an_array_buffer_crosses_as_bytes() {
    let value = call("sum", vec![Value::Buffer(vec![1, 2, 3, 250])]).expect("sum reads the bytes");
    assert!(matches!(value, Value::Number(total) if total == 256.0));

    let value =
        call("reversed", vec![Value::Buffer(vec![1, 2, 3])]).expect("reversed builds a buffer");
    assert!(matches!(value, Value::Buffer(bytes) if bytes == vec![3, 2, 1]));

    let error =
        call("sum", vec![Value::Array(Vec::new())]).expect_err("an array is not an ArrayBuffer");
    assert_eq!(
        error.message,
        "NativeProbe.sum: argument 0 (data): expected ArrayBuffer, got array"
    );
}

#[test]
fn a_callback_on_a_promise_method_is_invoked_while_it_runs() {
    let _guard = SINK_LOCK.lock().unwrap();
    let _ = rn_gpui_module::sink_calls();
    let module = probe();

    let future = module
        .clone()
        .call_promise(
            index("lookupLater"),
            vec![
                Value::String("gpui".into()),
                Value::Callback(rn_gpui_module::RawCallback::new(31)),
            ],
        )
        .expect("lookupLater builds a future");
    let value = futures::executor::block_on(future).expect("lookupLater resolves");
    assert!(matches!(value, Value::String(text) if text == "called"));

    // A callback the method does not call is released without being invoked.
    let future = module
        .clone()
        .call_promise(
            index("lookupLater"),
            vec![
                Value::String("missing".into()),
                Value::Callback(rn_gpui_module::RawCallback::new(32)),
            ],
        )
        .expect("lookupLater builds a future");
    let value = futures::executor::block_on(future).expect("lookupLater resolves");
    assert!(matches!(value, Value::String(text) if text == "dropped"));

    let calls = rn_gpui_module::sink_calls();
    let invoked: Vec<u64> = calls
        .iter()
        .filter_map(|call| match call {
            rn_gpui_module::SinkCall::InvokeCallback { id, args }
                if matches!(&args[0], Value::String(text) if text == "later value of gpui") =>
            {
                Some(*id)
            }
            _ => None,
        })
        .collect();
    assert_eq!(invoked, vec![31], "only the found key invokes its callback");
    let dropped: Vec<u64> = calls
        .iter()
        .filter_map(|call| match call {
            rn_gpui_module::SinkCall::DropCallback { id } => Some(*id),
            _ => None,
        })
        .collect();
    assert_eq!(dropped, vec![32], "the other callback is dropped");
}

#[test]
fn a_wrong_argument_reports_the_module_method_and_field() {
    let error = call("options", vec![Value::Number(1.0), Value::Number(1.0)])
        .expect_err("a wrong argument type is an error");
    assert_eq!(
        error.message,
        "NativeProbe.options: argument 0 (value): expected object, got number"
    );

    let error = call(
        "options",
        vec![
            Value::Object(vec![
                ("type".into(), Value::String("first".into())),
                ("count".into(), Value::String("nope".into())),
                ("mode".into(), Value::String("left".into())),
                (
                    "nested".into(),
                    Value::Object(vec![
                        ("flag".into(), Value::Bool(true)),
                        ("names".into(), Value::Array(Vec::new())),
                    ]),
                ),
            ]),
            Value::Object(vec![
                ("type".into(), Value::String("second".into())),
                ("count".into(), Value::Number(1.0)),
                ("mode".into(), Value::String("left".into())),
                (
                    "nested".into(),
                    Value::Object(vec![
                        ("flag".into(), Value::Bool(true)),
                        ("names".into(), Value::Array(Vec::new())),
                    ]),
                ),
            ]),
        ],
    )
    .expect_err("a wrong field type is an error");
    assert_eq!(
        error.message,
        "NativeProbe.options: argument 0 (value).count: expected Int32, got string"
    );

    let error = call("level", vec![Value::String("sideways".into())]).expect_err("bad enum");
    assert_eq!(
        error.message,
        "NativeProbe.level: argument 0 (level): expected one of \"low\", \"high\", got \"sideways\""
    );

    let error = call("scalar", Vec::new()).expect_err("missing argument");
    assert_eq!(
        error.message,
        "NativeProbe.scalar: argument 0 (text) is missing"
    );
}
