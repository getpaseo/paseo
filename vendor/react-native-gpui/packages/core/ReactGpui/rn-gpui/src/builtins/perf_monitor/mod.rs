use rn_gpui_module::{FromValue, ModuleError, ModuleThread, Path, Value};

use crate::builtins::main_thread::on_main;
use crate::builtins::rn_gpui_specs::{
    NativeGpuiPerfMonitorEvents, NativeGpuiPerfMonitorSpec, PerfMetrics, PerfToggle,
};

const MODULE: &str = "GpuiPerfMonitor";

struct PerfMonitorModule;

fn typed<T: FromValue>(method: &'static str, value: &serde_json::Value) -> Result<T, ModuleError> {
    let mut path = Path::result(MODULE, method);
    let value = json_value(value);
    T::from_value(value, &mut path).map_err(|error| ModuleError::new(error.message))
}

fn json_value(value: &serde_json::Value) -> Value {
    match value {
        serde_json::Value::Null => Value::Null,
        serde_json::Value::Bool(flag) => Value::Bool(*flag),
        serde_json::Value::Number(number) => {
            number.as_f64().map(Value::Number).unwrap_or(Value::Null)
        }
        serde_json::Value::String(text) => Value::String(text.clone()),
        serde_json::Value::Array(items) => Value::Array(items.iter().map(json_value).collect()),
        serde_json::Value::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(key, item)| (key.clone(), json_value(item)))
                .collect(),
        ),
    }
}

impl NativeGpuiPerfMonitorSpec for PerfMonitorModule {
    const THREAD: ModuleThread = ModuleThread::Main;

    fn new(_events: NativeGpuiPerfMonitorEvents) -> Self {
        Self
    }

    async fn perf_monitor_set_enabled(&self, enabled: bool) -> Result<PerfToggle, ModuleError> {
        let value =
            on_main(move |cx| crate::desktop::perf_monitor::set_enabled(cx, enabled)).await?;
        typed("perfMonitorSetEnabled", &value)
    }

    async fn perf_monitor_get_metrics(&self) -> Result<PerfMetrics, ModuleError> {
        let value = on_main(|cx| crate::desktop::perf_monitor::metrics(cx)).await?;
        typed("perfMonitorGetMetrics", &value)
    }

    fn add_listener(&self, _event_name: String) {}

    fn remove_listeners(&self, _count: f64) {}
}

pub fn register() {
    rn_gpui_module::register(
        crate::builtins::rn_gpui_specs::native_gpui_perf_monitor_module::<PerfMonitorModule>(),
    );
}
