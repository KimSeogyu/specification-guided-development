// Synthetic reproduction of the ownership-loss class, not the full Parangsae replay.
use serde_json::json;
use std::cell::Cell;
use std::rc::Rc;
struct Evidence {
    rows: Vec<String>, execution: &'static str, ledger: &'static str,
    drop_witness: Rc<Cell<usize>>,
}
impl Drop for Evidence {
    fn drop(&mut self) { self.drop_witness.set(self.drop_witness.get() + 1); }
}
fn legacy_finalization(payload: Evidence, fail: bool) -> Result<(), &'static str> {
    assert_eq!(payload.rows.len(), 2);
    assert_eq!(payload.execution, "original execution error");
    assert_eq!(payload.ledger, "terminal uncertain");
    // Returning only the reporting result drops the owned evidence in both branches.
    if fail { Err("report write failed") } else { Ok(()) }
}
fn main() {
    for mode in ["ok", "err"] {
        // The observer holds only a lifetime counter, never a copy of the domain evidence.
        let witness = Rc::new(Cell::new(0));
        let payload = Evidence {
            rows: vec!["earlier-complete".into(), "technical-prefix".into()],
            execution: "original execution error", ledger: "terminal uncertain",
            drop_witness: Rc::clone(&witness),
        };
        let before = witness.get();
        assert_eq!(before, 0);
        let result = legacy_finalization(payload, mode == "err");
        let after = witness.get();
        assert_eq!(after, 1, "the error-only boundary must actually drop its evidence");
        eprintln!("{}", json!({ "event": "payload-drop", "mode": mode, "before": before, "after": after }));
        let retained = after == before;
        let (observed, value) = match result { Ok(()) => ("ok", "reported"), Err(error) => ("err", error) };
        println!("{}", json!({ "mode": mode, "calls": 1, "payloadSame": retained,
            "rows": null, "execution": null, "ledger": null, "observed": observed,
            "observedValue": value, "phase": if mode == "ok" { "Succeeded" } else { "Failed" },
            "resident": retained, "revision": "2" }));
    }
}
