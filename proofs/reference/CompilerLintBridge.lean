import CompilerPipeline
import SemanticConstraints

/- Proof-level composition, not a native compiler/linter implementation.
   The raw machine is independent of source policy and compiled constraints.
   `owner` and label interpretation must be faithful language-profile bindings;
   this module does not infer that arbitrary caller-supplied maps are faithful. -/
namespace SGDCompilerLintBridge
open SGDMethod SGDCompilerPipeline SGDSemanticConstraints

inductive Observation (E : Type)
  | accepted : E → Observation E
  | rejected : E → Observation E
  | internal : Observation E
  | forbidden : Observation E

/- Independent source protocol: labels distinguish acceptance, rejection,
   silent internal work, and forbidden ownership/effect operations. -/
def SourceObservation {n : Nat} {E : Type} (source : Source n E) :
    Observation E → Fin n → Fin n → Prop
  | .accepted event, before, after => SourceStep source before event after
  | .rejected event, before, after =>
      before = after ∧ ¬ ∃ next, SourceStep source before event next
  | .internal, before, after => before = after
  | .forbidden, _, _ => False

def SourceConforms {n cfg labels : Nat} {E : Type}
    (source : Source n E) (machine : RawMachine cfg labels)
    (owner : Fin cfg → Fin n) (observe : Fin labels → Observation E)
    (invariant : Fin n → Bool) : Prop :=
  (∀ state, machine.initial state = true → owner state = source.initial) ∧
  ∀ state, RawReachable machine state →
    invariant (owner state) = true ∧
    ∀ label next, machine.step state label next = true →
      SourceObservation source (observe label) (owner state) (owner next)

def compiledEdge {n : Nat} {E : Type} [DecidableEq E]
    (automaton : TypedAutomaton (Fin n) E) : Observation E → Fin n → Fin n → Bool
  | .accepted event, before, after =>
      decide (evalDispatch (compileTable automaton.table) (before, event) = some after)
  | .rejected event, before, after => decide (before = after) &&
      decide (evalDispatch (compileTable automaton.table) (before, event) = none)
  | .internal, before, after => decide (before = after)
  | .forbidden, _, _ => false

theorem compiled_edge_iff_source_observation {n : Nat} {E : Type} [DecidableEq E]
    (source : Source n E) (automaton : TypedAutomaton (Fin n) E)
    (compiled : compileSource source = .ok automaton)
    (observation : Observation E) (before after : Fin n) :
    compiledEdge automaton observation before after = true ↔
      SourceObservation source observation before after := by
  cases observation with
  | accepted event =>
    simpa [compiledEdge, SourceObservation] using
      compile_success_accepts_iff_source_step source automaton compiled before event after
  | rejected event =>
    simp only [compiledEdge, SourceObservation, Bool.and_eq_true, decide_eq_true_eq]
    exact and_congr Iff.rfl
      (compile_success_rejects_iff_no_source_step source automaton compiled before event)
  | internal => simp [compiledEdge, SourceObservation]
  | forbidden => simp [compiledEdge, SourceObservation]

def compiledContract {n cfg labels : Nat} {E : Type} [DecidableEq E]
    (automaton : TypedAutomaton (Fin n) E)
    (owner : Fin cfg → Fin n) (observe : Fin labels → Observation E)
    (invariant : Fin n → Bool) : Contract cfg labels where
  initialOK state := decide (owner state = automaton.initial)
  stateOK state := invariant (owner state)
  edgeOK state label next := compiledEdge automaton (observe label) (owner state) (owner next)

theorem compiled_contract_iff_source_conformance
    {n cfg labels : Nat} {E : Type} [DecidableEq E]
    (source : Source n E) (automaton : TypedAutomaton (Fin n) E)
    (compiled : compileSource source = .ok automaton)
    (machine : RawMachine cfg labels)
    (owner : Fin cfg → Fin n) (observe : Fin labels → Observation E)
    (invariant : Fin n → Bool) :
    Conforms machine (compiledContract automaton owner observe invariant) ↔
      SourceConforms source machine owner observe invariant := by
  have initialSame := (compile_success_shape source automaton compiled).2.1
  simp only [Conforms, SourceConforms, compiledContract, decide_eq_true_eq, initialSame]
  constructor
  · rintro ⟨initials, steps⟩
    refine ⟨initials, ?_⟩
    intro state reachable
    refine ⟨(steps state reachable).1, ?_⟩
    intro label next actual
    exact (compiled_edge_iff_source_observation source automaton compiled
      (observe label) (owner state) (owner next)).mp ((steps state reachable).2 label next actual)
  · rintro ⟨initials, steps⟩
    refine ⟨initials, ?_⟩
    intro state reachable
    refine ⟨(steps state reachable).1, ?_⟩
    intro label next actual
    exact (compiled_edge_iff_source_observation source automaton compiled
      (observe label) (owner state) (owner next)).mpr ((steps state reachable).2 label next actual)

def pipelineLint {n cfg labels : Nat} {E : Type} [DecidableEq E]
    (source : Source n E) (machine : RawMachine cfg labels)
    (owner : Fin cfg → Fin n) (observe : Fin labels → Observation E)
    (invariant : Fin n → Bool) : Bool :=
  match compileSource source with
  | .error _ => false
  | .ok automaton =>
      checkGeneratedConstraints machine (compiledContract automaton owner observe invariant)

theorem compiled_lint_iff_source_conformance
    {n cfg labels : Nat} {E : Type} [DecidableEq E]
    (source : Source n E) (automaton : TypedAutomaton (Fin n) E)
    (compiled : compileSource source = .ok automaton)
    (machine : RawMachine cfg labels)
    (owner : Fin cfg → Fin n) (observe : Fin labels → Observation E)
    (invariant : Fin n → Bool) :
    pipelineLint source machine owner observe invariant = true ↔
      SourceConforms source machine owner observe invariant := by
  simp only [pipelineLint, compiled]
  exact (generated_constraints_iff_semantic_conformance machine _).trans
    (compiled_contract_iff_source_conformance source automaton compiled machine owner observe invariant)

theorem compiler_generated_lint_iff_supported_deterministic_source_compliance
    {n cfg labels : Nat} {E : Type} [DecidableEq E]
    (source : Source n E) (machine : RawMachine cfg labels)
    (owner : Fin cfg → Fin n) (observe : Fin labels → Observation E)
    (invariant : Fin n → Bool) :
    pipelineLint source machine owner observe invariant = true ↔
      SourceAdmitted source ∧ SourceDeterministic source ∧
        SourceConforms source machine owner observe invariant := by
  constructor
  · intro passed
    cases compiled : compileSource source with
    | error reason => simp [pipelineLint, compiled] at passed
    | ok automaton =>
      have admitted := (compile_success_iff_admitted_deterministic source).mp ⟨automaton, compiled⟩
      exact ⟨admitted.1, admitted.2,
        (compiled_lint_iff_source_conformance source automaton compiled machine owner observe invariant).mp passed⟩
  · rintro ⟨supported, deterministic, conforms⟩
    obtain ⟨automaton, compiled⟩ := (compile_success_iff_admitted_deterministic source).mpr
      ⟨supported, deterministic⟩
    exact (compiled_lint_iff_source_conformance source automaton compiled machine owner observe invariant).mpr conforms

end SGDCompilerLintBridge

#print axioms SGDCompilerLintBridge.compiled_edge_iff_source_observation
#print axioms SGDCompilerLintBridge.compiled_contract_iff_source_conformance
#print axioms SGDCompilerLintBridge.compiled_lint_iff_source_conformance
#print axioms SGDCompilerLintBridge.compiler_generated_lint_iff_supported_deterministic_source_compliance
#print axioms SGDCompilerLintBridge.pipelineLint
