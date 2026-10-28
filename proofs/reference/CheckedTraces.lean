import ProfileComposition

/- Fixed-epoch finite traces of the actual finite CFG runtime. Code and the
   installed table stay fixed during a trace. Scheduler choices remain arbitrary.
   Observations retain actor identity and distinguish rejection from acceptance.
   This theorem does not cover native parsing, infinite-trace liveness or I/O. -/
namespace SGDCheckedTraces
open SGDMethod SGDCompilerPipeline SGDCompilerLintBridge SGDLanguageProfiles
open SGDProfileComposition SGDWholeProgram

def LabeledRuntimeStep {states pcs events components : Nat}
    (table : GlobalTable states events components)
    (bodies : Actor components → Controller states pcs events)
    (label : RuntimeLabel components events)
    (before after : RuntimeConfiguration states pcs components) : Prop :=
  runtimeRun table bodies before label.1 = (label.2, after)

def SourceLabelStep {states events components : Nat}
    (source : Source (states + 1) (Actor components × Fin events))
    (label : RuntimeLabel components events) (before after : Fin (states + 1)) : Prop :=
  SourceObservation source (liftObservation label.1 label.2) before after

theorem conforming_trace_preserves_labels_and_invariant
    {states pcs events components : Nat}
    {source : Source (states + 1) (Actor components × Fin events)}
    {table : GlobalTable states events components}
    {bodies : Actor components → Controller states pcs events}
    {initial before after : RuntimeConfiguration states pcs components}
    {invariant : Fin (states + 1) → Bool} {labels : List (RuntimeLabel components events)}
    (conforms : RuntimeConforms source table bodies initial invariant)
    (reached : Reach (fun c => c = initial) (RuntimeStep table bodies) before)
    (trace : Trace (LabeledRuntimeStep table bodies) before labels after) :
    Trace (SourceLabelStep source) before.owner labels after.owner ∧ invariant after.owner = true := by
  induction trace with
  | nil state => exact ⟨.nil state.owner, (conforms.2 state reached).1⟩
  | @cons state middle final label rest first later ih =>
    have nextReached : Reach (fun c => c = initial) (RuntimeStep table bodies) middle :=
      .advance reached ⟨label.1, label.2, first⟩
    have tail := ih nextReached
    exact ⟨.cons ((conforms.2 state reached).2 label.1 label.2 middle first) tail.1, tail.2⟩

theorem accepted_whole_program_preserves_fixed_epoch_trace
    {states pcs events components : Nat}
    {source : Source (states + 1) (Actor components × Fin events)}
    {table : GlobalTable states events components}
    {bodies : Actor components → Controller states pcs events}
    {initial final : RuntimeConfiguration states pcs components}
    {invariant : Fin (states + 1) → Bool} {labels : List (RuntimeLabel components events)}
    (passed : globalCombinedLint source table bodies initial invariant = true)
    (trace : Trace (LabeledRuntimeStep table bodies) initial labels final) :
    (∀ actor, BodyAdmitted (bodies actor)) ∧
      Trace (SourceLabelStep source) source.initial labels final.owner ∧
      invariant final.owner = true := by
  have contract := (global_combined_lint_iff_explicit_contract source table bodies initial invariant).mp passed
  have result := conforming_trace_preserves_labels_and_invariant contract.2.2.2 (.start rfl) trace
  rw [contract.2.2.2.1] at result
  exact ⟨contract.1, result⟩

end SGDCheckedTraces

#print axioms SGDCheckedTraces.conforming_trace_preserves_labels_and_invariant
#print axioms SGDCheckedTraces.accepted_whole_program_preserves_fixed_epoch_trace
