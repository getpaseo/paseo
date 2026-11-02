//! A rejection is the JSON encoding of this struct: the C++ promise only
//! carries a string.

#[derive(Clone, Debug)]
pub struct DesktopError {
    pub code: &'static str,
    pub message: String,
}

pub mod codes {
    pub const UNSUPPORTED: &str = "unsupported";
    pub const INVALID_ARGUMENT: &str = "invalid_argument";
    pub const NOT_FOUND: &str = "not_found";
    pub const RELOADED: &str = "reloaded";
    pub const FAILED: &str = "failed";
}

impl DesktopError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn unsupported(message: impl Into<String>) -> Self {
        Self::new(codes::UNSUPPORTED, message)
    }

    pub fn invalid_argument(message: impl Into<String>) -> Self {
        Self::new(codes::INVALID_ARGUMENT, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(codes::NOT_FOUND, message)
    }

    pub fn failed(message: impl Into<String>) -> Self {
        Self::new(codes::FAILED, message)
    }

    pub fn to_json(&self) -> String {
        serde_json::json!({"code": self.code, "message": self.message}).to_string()
    }

    pub fn to_json_value(&self) -> serde_json::Value {
        serde_json::json!({"error": {"code": self.code, "message": self.message}})
    }
}

impl std::fmt::Display for DesktopError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for DesktopError {}

pub type DesktopResult = Result<serde_json::Value, DesktopError>;
