use proc_macro2::Span;
use serde::Serialize;
use std::fmt;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Error {
    pub rule_id: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<usize>,
}
impl Error {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            rule_id: "TLC305",
            message: message.into(),
            file: None,
            line: None,
            column: None,
        }
    }
    pub fn at(file: &str, span: Span, message: impl Into<String>) -> Self {
        let start = span.start();
        Self {
            rule_id: "TLC305",
            message: message.into(),
            file: Some(file.into()),
            line: Some(start.line.max(1)),
            column: Some(start.column + 1),
        }
    }
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.rule_id, self.message)
    }
}
impl std::error::Error for Error {}
pub type Result<T> = std::result::Result<T, Error>;
