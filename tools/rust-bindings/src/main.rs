use sgd_rust_bindings::{analyze_with_generated, Error};
use std::path::PathBuf;

fn run() -> Result<(), Error> {
    let mut root = None;
    let mut binding = None;
    let mut generated = None;
    let mut args = std::env::args().skip(1);
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
fn main() {
    if let Err(error) = run() {
        eprintln!(
            "{}",
            serde_json::to_string(&error).unwrap_or_else(|_| {
                "{\"ruleId\":\"TLC305\",\"message\":\"binding analysis failed\"}".into()
            })
        );
        std::process::exit(2);
    }
}
