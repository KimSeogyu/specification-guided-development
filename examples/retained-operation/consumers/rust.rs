use authority::{finalize, FinalizationStatus, FiniteValue};
use serde_json::json;
struct Evidence { rows: Vec<String>, execution: &'static str, ledger: &'static str }
fn main() {
    for mode in ["ok", "err"] {
        let payload = Evidence { rows: vec!["earlier-complete".into(), "technical-prefix".into()], execution: "original execution error", ledger: "terminal uncertain" };
        let original = payload.rows.as_ptr();
        let mut calls = 0;
        let result = finalize(payload, |evidence| {
            calls += 1;
            assert_eq!(evidence.rows.as_ptr(), original);
            if mode == "ok" { Ok("reported") } else { Err("report write failed") }
        });
        let (observed, observed_value) = match result.status() {
            FinalizationStatus::Refused(_) => ("refused", "disabled"),
            FinalizationStatus::Completed(Ok(value)) => ("ok", *value),
            FinalizationStatus::Completed(Err(error)) => ("err", *error),
            FinalizationStatus::TransitionRejected { .. } => panic!("unexpected completion rejection"),
        };
        let actual = result.payload();
        let state = result.snapshot();
        let phase = match &state.values["phase"] { FiniteValue::String(value) => value, _ => panic!("phase type") };
        let resident = match state.values["resident"] { FiniteValue::Boolean(value) => value, _ => panic!("resident type") };
        println!("{}", json!({ "mode": mode, "calls": calls, "payloadSame": actual.rows.as_ptr() == original,
            "rows": actual.rows, "execution": actual.execution, "ledger": actual.ledger,
            "observed": observed, "observedValue": observed_value, "phase": phase,
            "resident": resident, "revision": state.revision }));
    }
}
