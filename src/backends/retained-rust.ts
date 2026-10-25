import type { GeneratedFile } from '../types.js';
import { validateRetainedOperation, type RetainedOperationInput } from '../retained-operation.js';
import { generateOwnedRust } from './owned-rust.js';

/** Keep the actual payload outside the fallible callback and retain it on every ordinary return. */
export function generateRetainedRust(input: RetainedOperationInput): GeneratedFile[] {
  validateRetainedOperation(input);
  const files = generateOwnedRust(input, 'embedded');
  const machine = files.find(file => file.path === 'src/lib.rs');
  if (machine === undefined) throw new Error('TLC207: finite Rust backend omitted its authority');
  const { start, success, failure } = input.operation;
  const action = (name: string): string => `machine::Event::from_model_name(${JSON.stringify(name)}).expect("validated operation action")`;
  return [
    ...files.filter(file => file.path !== 'src/lib.rs' && file.path !== 'README.md'),
    { path: 'src/machine.rs', content: machine.content },
    { path: 'src/lib.rs', content: `// Generated retained operation. Regenerate from the verified model.
//! One synchronous operation retains its concrete payload on ordinary returns.
//! The callback borrows the payload. Its actual Result selects the model outcome.
//! No promise covers panic, abort, process loss, interior mutation, caller disposal,
//! durable custody, or application-wide source coverage.
#![forbid(unsafe_code)]

mod machine;
pub use machine::{FiniteValue, Snapshot, TransitionError, TransitionErrorReason, MODEL, MODEL_REVISION};

#[derive(Debug)]
pub enum FinalizationStatus<R, E> {
    /// The model refused admission. The callback did not run.
    Refused(TransitionError),
    /// The actual callback result, retained independently of the payload.
    Completed(Result<R, E>),
    /// Preserve the observed callback result even if the completion transition fails.
    TransitionRejected { outcome: Result<R, E>, error: TransitionError },
}

/// Fields are private: callers cannot construct an error-only finalization.
#[must_use = "finalization retains the original payload and the observed operation result"]
#[derive(Debug)]
pub struct Finalized<T, R, E> {
    payload: T,
    status: FinalizationStatus<R, E>,
    snapshot: Snapshot,
}

impl<T, R, E> Finalized<T, R, E> {
    pub fn payload(&self) -> &T { &self.payload }
    pub fn status(&self) -> &FinalizationStatus<R, E> { &self.status }
    pub fn snapshot(&self) -> &Snapshot { &self.snapshot }

    /// Explicitly transfer all owned parts to the caller. This is not a durable acknowledgement.
    pub fn into_parts(self) -> (T, FinalizationStatus<R, E>, Snapshot) {
        (self.payload, self.status, self.snapshot)
    }
}

/// Attempt once. A model refusal does not call the writer. Both callback outcomes
/// retain the supplied payload, including after successful reporting.
pub fn finalize<T, R, E>(payload: T, writer: impl FnOnce(&T) -> Result<R, E>) -> Finalized<T, R, E> {
    let mut machine = machine::${input.className}::new();
    if let Err(error) = machine.send(${action(start)}) {
        return Finalized { payload, status: FinalizationStatus::Refused(error), snapshot: machine.read() };
    }
    let outcome = writer(&payload);
    let event = if outcome.is_ok() { ${action(success)} } else { ${action(failure)} };
    let status = match machine.send(event) {
        Ok(_) => FinalizationStatus::Completed(outcome),
        Err(error) => FinalizationStatus::TransitionRejected { outcome, error },
    };
    Finalized { payload, status, snapshot: machine.read() }
}
` },
    { path: 'README.md', content: `# Generated retained-operation Rust boundary

Call \`finalize(payload, |payload| write_report(payload))\`. The writer receives \`&T\` and returns \`Result<R, E>\`. The generated boundary owns the original payload before the callback and returns it on every ordinary success, failure, or admission refusal. The model's start action gates callback admission. The actual callback result chooses the success or failure action. Callers cannot send those events through this API.

\`Finalized<T, R, E>\` has private fields. Inspect \`payload()\`, \`status()\`, and \`snapshot()\`. \`FinalizationStatus::Completed(Err(error))\` preserves the report failure separately from execution and persistence facts in the payload. A refusal invokes no callback. An unexpected completion-transition rejection retains the observed callback outcome. \`into_parts()\` explicitly transfers all three parts to the caller.

Keep this generated crate as a separate dependency. Safe Rust prevents the writer from moving ordinary owned data through its shared borrow. Interior mutability, panic, abort, process termination, caller drop or forget, and changed generated code remain outside this contract. The callback's success does not prove durable storage. Payload remains retained even on success. This finite lower contract does not prove refinement of an enclosing model, source coverage, or application-wide preservation.
` },
  ];
}
