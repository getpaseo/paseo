use std::fmt;

use crate::{ModuleError, RawCallback};

/// A JS value detached from the JS runtime. `Callback` is the one member that
/// is not data; it is consumed by calling it.
#[derive(Debug)]
pub enum Value {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    /// The bytes of an `ArrayBuffer`.
    Buffer(Vec<u8>),
    Array(Vec<Value>),
    Object(Vec<(String, Value)>),
    Callback(RawCallback),
}

impl Value {
    pub fn object(fields: impl IntoIterator<Item = (impl Into<String>, Value)>) -> Self {
        Self::Object(
            fields
                .into_iter()
                .map(|(key, value)| (key.into(), value))
                .collect(),
        )
    }

    pub fn type_name(&self) -> &'static str {
        match self {
            Self::Null => "null",
            Self::Bool(_) => "boolean",
            Self::Number(_) => "number",
            Self::String(_) => "string",
            Self::Buffer(_) => "ArrayBuffer",
            Self::Array(_) => "array",
            Self::Object(_) => "object",
            Self::Callback(_) => "function",
        }
    }
}

/// The bytes of an `ArrayBuffer`, which the spec's `ArrayBuffer` maps to. A
/// `Vec<u8>` cannot: it already converts as an array of numbers.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ArrayBuffer(pub Vec<u8>);

impl ArrayBuffer {
    pub fn as_slice(&self) -> &[u8] {
        &self.0
    }

    pub fn into_vec(self) -> Vec<u8> {
        self.0
    }
}

impl std::ops::Deref for ArrayBuffer {
    type Target = [u8];

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl From<Vec<u8>> for ArrayBuffer {
    fn from(bytes: Vec<u8>) -> Self {
        Self(bytes)
    }
}

impl From<ArrayBuffer> for Vec<u8> {
    fn from(buffer: ArrayBuffer) -> Self {
        buffer.0
    }
}

impl FromValue for ArrayBuffer {
    fn from_value(value: Value, path: &mut Path) -> Result<Self, ModuleError> {
        match value {
            Value::Buffer(bytes) => Ok(Self(bytes)),
            other => Err(path.error(format!("expected ArrayBuffer, got {}", other.type_name()))),
        }
    }
}

impl IntoValue for ArrayBuffer {
    fn into_value(self) -> Value {
        Value::Buffer(self.0)
    }
}

/// Where a conversion is, for error messages:
/// `NativeFixture.summarize: argument 1 (options).label`.
pub struct Path {
    module: &'static str,
    method: &'static str,
    argument: Option<(&'static str, usize)>,
    fields: Vec<String>,
}

impl Path {
    pub fn argument(
        module: &'static str,
        method: &'static str,
        index: usize,
        name: &'static str,
    ) -> Self {
        Self {
            module,
            method,
            argument: Some((name, index)),
            fields: Vec::new(),
        }
    }

    /// For a value a method converts itself, such as JSON a lower layer built.
    pub fn result(module: &'static str, method: &'static str) -> Self {
        Self {
            module,
            method,
            argument: None,
            fields: Vec::new(),
        }
    }

    pub fn location(&self) -> String {
        let mut location = format!("{}.{}", self.module, self.method);
        if let Some((name, index)) = self.argument {
            location.push_str(&format!(": argument {index} ({name})"));
        }
        for field in &self.fields {
            location.push('.');
            location.push_str(field);
        }
        location
    }

    pub fn error(&self, detail: impl fmt::Display) -> ModuleError {
        ModuleError::new(format!("{}: {detail}", self.location()))
    }

    pub fn push_field(&mut self, name: impl fmt::Display) {
        self.fields.push(name.to_string());
    }

    pub fn pop_field(&mut self) {
        self.fields.pop();
    }
}

/// A Rust type a `Value` can be read as; generated structs and enums implement
/// it field by field.
pub trait FromValue: Sized {
    fn from_value(value: Value, path: &mut Path) -> Result<Self, ModuleError>;
}

pub trait IntoValue {
    fn into_value(self) -> Value;
}

impl FromValue for Value {
    fn from_value(value: Value, _path: &mut Path) -> Result<Self, ModuleError> {
        Ok(value)
    }
}

impl IntoValue for Value {
    fn into_value(self) -> Value {
        self
    }
}

impl FromValue for String {
    fn from_value(value: Value, path: &mut Path) -> Result<Self, ModuleError> {
        match value {
            Value::String(text) => Ok(text),
            other => Err(path.error(format!("expected string, got {}", other.type_name()))),
        }
    }
}

impl IntoValue for String {
    fn into_value(self) -> Value {
        Value::String(self)
    }
}

impl FromValue for f64 {
    fn from_value(value: Value, path: &mut Path) -> Result<Self, ModuleError> {
        match value {
            Value::Number(number) => Ok(number),
            other => Err(path.error(format!("expected number, got {}", other.type_name()))),
        }
    }
}

impl IntoValue for f64 {
    fn into_value(self) -> Value {
        Value::Number(self)
    }
}

impl FromValue for i32 {
    fn from_value(value: Value, path: &mut Path) -> Result<Self, ModuleError> {
        match value {
            Value::Number(number)
                if number.fract() == 0.0
                    && number >= f64::from(i32::MIN)
                    && number <= f64::from(i32::MAX) =>
            {
                Ok(number as i32)
            }
            Value::Number(number) => Err(path.error(format!("expected Int32, got {number}"))),
            other => Err(path.error(format!("expected Int32, got {}", other.type_name()))),
        }
    }
}

impl IntoValue for i32 {
    fn into_value(self) -> Value {
        Value::Number(f64::from(self))
    }
}

impl FromValue for bool {
    fn from_value(value: Value, path: &mut Path) -> Result<Self, ModuleError> {
        match value {
            Value::Bool(flag) => Ok(flag),
            other => Err(path.error(format!("expected boolean, got {}", other.type_name()))),
        }
    }
}

impl IntoValue for bool {
    fn into_value(self) -> Value {
        Value::Bool(self)
    }
}

impl FromValue for () {
    fn from_value(value: Value, path: &mut Path) -> Result<Self, ModuleError> {
        match value {
            Value::Null => Ok(()),
            other => Err(path.error(format!("expected null, got {}", other.type_name()))),
        }
    }
}

impl IntoValue for () {
    fn into_value(self) -> Value {
        Value::Null
    }
}

impl<T: FromValue> FromValue for Option<T> {
    fn from_value(value: Value, path: &mut Path) -> Result<Self, ModuleError> {
        match value {
            Value::Null => Ok(None),
            value => T::from_value(value, path).map(Some),
        }
    }
}

impl<T: IntoValue> IntoValue for Option<T> {
    fn into_value(self) -> Value {
        match self {
            Some(value) => value.into_value(),
            None => Value::Null,
        }
    }
}

impl<T: FromValue> FromValue for Vec<T> {
    fn from_value(value: Value, path: &mut Path) -> Result<Self, ModuleError> {
        match value {
            Value::Array(items) => items
                .into_iter()
                .enumerate()
                .map(|(index, item)| {
                    path.push_field(index);
                    let converted = T::from_value(item, path);
                    path.pop_field();
                    converted
                })
                .collect(),
            other => Err(path.error(format!("expected array, got {}", other.type_name()))),
        }
    }
}

impl<T: IntoValue> IntoValue for Vec<T> {
    fn into_value(self) -> Value {
        Value::Array(self.into_iter().map(IntoValue::into_value).collect())
    }
}
