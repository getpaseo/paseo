use std::fmt;

/// A rejected call: the message reaches JS as the error's message, the code as
/// its `code` property.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModuleError {
    pub code: Option<String>,
    pub message: String,
}

impl ModuleError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            code: None,
            message: message.into(),
        }
    }

    pub fn with_code(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: Some(code.into()),
            message: message.into(),
        }
    }
}

impl fmt::Display for ModuleError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ModuleError {}

impl From<String> for ModuleError {
    fn from(message: String) -> Self {
        Self::new(message)
    }
}

impl From<&str> for ModuleError {
    fn from(message: &str) -> Self {
        Self::new(message)
    }
}
