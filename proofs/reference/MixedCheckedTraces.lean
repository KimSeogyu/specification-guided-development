import MixedProfiles
import GraphCheckedTraces

/- Exact operational lowering transports finite labeled traces, not just final
   states. The mixed runtime installs each actor's generated authority. Its
   policy table remains independent of the specification checked below. -/
namespace SGDMixedCheckedTraces
open SGDCompilerPipeline SGDCompilerLintBridge SGDProfileComposition SGDWholeProgram
open SGDCheckedTraces SGDGraphCheckedTraces

def MixedLabeledStep {states pcs events components : Nat}
    (table : GlobalTable states events components)
    (bodies : Actor components → SGDMixedProfiles.Body states pcs events)
    (label : RuntimeLabel components events)
    (before after : RuntimeConfiguration states pcs components) : Prop :=
  SGDMixedProfiles.runtimeRun table bodies before label.1 = (label.2, after)

theorem lower_labeled_trace_exact {states pcs events components : Nat}
    (table : GlobalTable states events components)
    (bodies : Actor components → SGDMixedProfiles.Body states pcs events)
    (before after : RuntimeConfiguration states pcs components)
    (labels : List (RuntimeLabel components events)) :
    Trace (MixedLabeledStep table bodies) before labels after ↔
      Trace (LabeledRuntimeStep table (fun actor => SGDMixedProfiles.lowerBody (bodies actor)))
        before labels after := by
  have same : MixedLabeledStep table bodies =
      LabeledRuntimeStep table (fun actor => SGDMixedProfiles.lowerBody (bodies actor)) := by
    funext label first last
    simp only [MixedLabeledStep, LabeledRuntimeStep, SGDMixedProfiles.lower_runtime_execution_exact]
  rw [same]

theorem accepted_mixed_source_preserves_labeled_trace
    {states pcs events components : Nat}
    {source : Source (states + 1) (Actor components × Fin events)}
    {table : GlobalTable states events components}
    {bodies : Actor components → SGDMixedProfiles.Body states pcs events}
    {initial final : RuntimeConfiguration states pcs components}
    {invariant : Fin (states + 1) → Bool} {labels : List (RuntimeLabel components events)}
    (passed : SGDMixedProfiles.lint source table bodies initial invariant = true)
    (trace : Trace (MixedLabeledStep table bodies) initial labels final) :
    (∀ actor, SGDMixedProfiles.Admitted (bodies actor)) ∧
      Trace (SourceLabelStep source) source.initial labels final.owner ∧ invariant final.owner = true := by
  have result := accepted_whole_program_preserves_fixed_epoch_trace passed
    ((lower_labeled_trace_exact table bodies initial final labels).mp trace)
  exact ⟨fun actor => (SGDMixedProfiles.lower_body_admission_exact (bodies actor)).mp (result.1 actor), result.2⟩

def graphLint {states pcs events components : Nat}
    (source : Source (states + 1) (Actor components × Fin events))
    (input : GraphInput (Fin (states + 1)) (Actor components × Fin events))
    (table : GlobalTable states events components)
    (bodies : Actor components → SGDMixedProfiles.Body states pcs events)
    (initial : RuntimeConfiguration states pcs components) (invariant : Fin (states + 1) → Bool) : Bool :=
  graphGlobalCombinedLint source input table (fun actor => SGDMixedProfiles.lowerBody (bodies actor)) initial invariant

theorem accepted_mixed_graph_preserves_labeled_trace
    {states pcs events components : Nat}
    {source : Source (states + 1) (Actor components × Fin events)}
    {graph : ExactGraph (Fin (states + 1)) (Actor components × Fin events)}
    {automaton : TypedAutomaton (Fin (states + 1)) (Actor components × Fin events)}
    (imported : importGraph source (.exact graph) = .ok automaton)
    {table : GlobalTable states events components}
    {bodies : Actor components → SGDMixedProfiles.Body states pcs events}
    {initial final : RuntimeConfiguration states pcs components}
    {invariant : Fin (states + 1) → Bool} {labels : List (RuntimeLabel components events)}
    (passed : graphLint source (.exact graph) table bodies initial invariant = true)
    (trace : Trace (MixedLabeledStep table bodies) initial labels final) :
    (∀ actor, SGDMixedProfiles.Admitted (bodies actor)) ∧
      Trace (SourceLabelStep source) source.initial labels final.owner ∧ invariant final.owner = true := by
  have result := accepted_graph_whole_program_preserves_fixed_epoch_trace imported passed
    ((lower_labeled_trace_exact table bodies initial final labels).mp trace)
  exact ⟨fun actor => (SGDMixedProfiles.lower_body_admission_exact (bodies actor)).mp (result.1 actor), result.2⟩

end SGDMixedCheckedTraces

#print axioms SGDMixedCheckedTraces.lower_labeled_trace_exact
#print axioms SGDMixedCheckedTraces.accepted_mixed_source_preserves_labeled_trace
#print axioms SGDMixedCheckedTraces.accepted_mixed_graph_preserves_labeled_trace
