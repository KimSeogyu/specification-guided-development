use sgd_rust_bindings::{analyze_source_scope, analyze_with_generated, Error};
use std::path::PathBuf;

fn run() -> Result<(), Error> {
    let mut root = None;
    let mut binding = None;
    let mut generated = None;
    let mut args = std::env::args().skip(1).peekable();
    if args.peek().is_some_and(|arg| arg == "source-scope") {
        args.next();
        if args.next().as_deref() != Some("--root") {
            return Err(scope_argument("use source-scope --root APP"));
        }
        let root = args
            .next()
            .ok_or_else(|| scope_argument("missing --root APP"))?;
        if args.next().is_some() {
            return Err(scope_argument("source-scope accepts only --root APP"));
        }
        let report = analyze_source_scope(&PathBuf::from(root))?;
        println!(
            "{}",
            serde_json::to_string(&report)
                .map_err(|e| scope_argument(&format!("cannot encode source report: {e}")))?
        );
        return Ok(());
    }
    while let Some(flag) = args.next() {
        let value = args
            .next()
            .ok_or_else(|| Error::new(format!("missing value for {flag}")))?;
        match flag.as_str() {
            "--root" if root.is_none() => root = Some(PathBuf::from(value)),
            "--binding" if binding.is_none() => binding = Some(PathBuf::from(value)),
            "--generated-root" if generated.is_none() => generated = Some(PathBuf::from(value)),
            _ => {
                return Err(Error::new(format!(
                    "unsupported or repeated argument {flag}; use --root APP --binding JSON"
                )))
            }
        }
    }
    let plan = analyze_with_generated(
        &root.ok_or_else(|| Error::new("missing --root APP"))?,
        &binding.ok_or_else(|| Error::new("missing --binding JSON"))?,
        generated.as_deref(),
    )?;
    println!(
        "{}",
        serde_json::to_string(&plan)
            .map_err(|error| Error::new(format!("cannot encode binding plan: {error}")))?
    );
    Ok(())
}
fn scope_argument(message: &str) -> Error {
    let mut error = Error::new(message);
    error.rule_id = "TLC308";
    error
}
fn main() {
    if let Err(error) = run() {
        if std::env::args().nth(1).as_deref() == Some("source-scope") {
            let mut diagnostic = serde_json::to_value(&error).expect("diagnostic serialization");
            diagnostic["storageAuthority"] = serde_json::Value::Bool(false);
            diagnostic["profile"] = serde_json::Value::String("rust-source-scope-v1".into());
            eprintln!("{diagnostic}");
            std::process::exit(2);
        }
        eprintln!(
            "{}",
            serde_json::to_string(&error).unwrap_or_else(|_| {
                "{\"ruleId\":\"TLC305\",\"message\":\"binding analysis failed\"}".into()
            })
        );
        std::process::exit(2);
    }
}
