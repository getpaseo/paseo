//! Helpers the generated glue calls; anything here can change with the
//! generator.
#![doc(hidden)]

use crate::{FromValue, ModuleError, Value};

pub use crate::value::Path;

/// The cursor over one call's arguments, converted on the thread that received
/// them.
pub struct Args {
    module: &'static str,
    method: &'static str,
    values: Vec<Value>,
    index: usize,
}

impl Args {
    pub fn new(module: &'static str, method: &'static str, values: Vec<Value>) -> Self {
        Self {
            module,
            method,
            values,
            index: 0,
        }
    }

    pub fn next_callback(&mut self, name: &'static str) -> Result<crate::RawCallback, ModuleError> {
        let index = self.index;
        self.index += 1;
        let value = match self.values.get_mut(index) {
            Some(slot) => std::mem::replace(slot, Value::Null),
            None => {
                return Err(ModuleError::new(format!(
                    "{}.{}: argument {index} ({name}) is missing",
                    self.module, self.method
                )))
            }
        };
        let path = Path::argument(self.module, self.method, index, name);
        match value {
            Value::Callback(callback) => Ok(callback),
            other => Err(path.error(format!("expected function, got {}", other.type_name()))),
        }
    }

    pub fn next<T: FromValue>(&mut self, name: &'static str) -> Result<T, ModuleError> {
        let index = self.index;
        self.index += 1;
        let value = match self.values.get_mut(index) {
            Some(slot) => std::mem::replace(slot, Value::Null),
            None => {
                return Err(ModuleError::new(format!(
                    "{}.{}: argument {index} ({name}) is missing",
                    self.module, self.method
                )))
            }
        };
        let mut path = Path::argument(self.module, self.method, index, name);
        T::from_value(value, &mut path)
    }
}

/// The fields of one object, so a generated struct can take them by name and
/// report a missing or mistyped one.
pub struct FieldMap {
    fields: Vec<(String, Value)>,
}

impl FieldMap {
    pub fn new(fields: Vec<(String, Value)>) -> Self {
        Self { fields }
    }

    pub fn take<T: FromValue>(&mut self, path: &mut Path, name: &str) -> Result<T, ModuleError> {
        match self.remove(name) {
            Some(value) => field(path, name, value),
            None => {
                path.push_field(name);
                let error = path.error("missing field");
                path.pop_field();
                Err(error)
            }
        }
    }

    pub fn take_optional<T: FromValue>(
        &mut self,
        path: &mut Path,
        name: &str,
    ) -> Result<Option<T>, ModuleError> {
        match self.remove(name) {
            Some(Value::Null) => Ok(None),
            Some(value) => field(path, name, value).map(Some),
            None => Ok(None),
        }
    }

    fn remove(&mut self, name: &str) -> Option<Value> {
        let index = self
            .fields
            .iter()
            .position(|(key, _)| key.as_str() == name)?;
        Some(self.fields.remove(index).1)
    }
}

pub fn field<T: FromValue>(path: &mut Path, name: &str, value: Value) -> Result<T, ModuleError> {
    path.push_field(name);
    let converted = T::from_value(value, path);
    path.pop_field();
    converted
}

pub fn location(module: &'static str, method: &'static str) -> String {
    format!("{module}.{method}")
}

pub use crate::host::{catch, catch_async, log_error, panic_error, run_void};
