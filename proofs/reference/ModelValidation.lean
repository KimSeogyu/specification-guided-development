import GraphLintBridge

/- Formal model validation, distinct from program conformance checking.

   Fin n is the complete supported source-state domain. The raw machine below
   includes EVERY compiled source edge; it never filters edges by the invariant.
   Collapsing events into one label is justified only for STATE reachability and
   state-invariant safety. This file proves no labeled/temporal/liveness claim.

   The decision procedure enumerates static finite invariant regions. It needs
   no TLC success flag, runtime log, or assumed source-safety conclusion. Actual
   TLA/DOT/native parsing and independently intended requirement interpretation
   remain separate boundaries, as in CompilerPipeline.
-/
namespace SGDModelValidation
open SGDMethod SGDCompilerPipeline SGDSemanticConstraints

/- This safety proposition is defined directly from original source semantics,
   independently of compilation, the finite machine, and the checker. -/
def SourceReachable {n : Nat} {E : Type} (source : Source n E) (state : Fin n) : Prop :=
  Reach (fun s => s = source.initial) (fun s t => ∃ event, SourceStep source s event t) state

def SourceInvariant {n : Nat} {E : Type} (source : Source n E)
    (invariant : Fin n → Bool) : Prop :=
  ∀ state, SourceReachable source state → invariant state = true

def sourceMachine {n : Nat} {E : Type} (automaton : TypedAutomaton (Fin n) E) : RawMachine n 1 where
  initial state := decide (state = automaton.initial)
  step before _ after := automaton.table.any (fun entry =>
    decide (entry.1.1 = before ∧ entry.2 = after))

def invariantContract {n : Nat} (invariant : Fin n → Bool) : Contract n 1 where
  initialOK _ := true
  stateOK := invariant
  edgeOK _ _ _ := true

theorem source_machine_initial_nonempty {n : Nat} {E : Type}
    (automaton : TypedAutomaton (Fin n) E) :
    ∃ state, (sourceMachine automaton).initial state = true := by
  exact ⟨automaton.initial, by simp [sourceMachine]⟩

theorem source_machine_step_exact {n : Nat} {E : Type}
    (automaton : TypedAutomaton (Fin n) E) (before after : Fin n) (label : Fin 1) :
    (sourceMachine automaton).step before label after = true ↔
      TableStep automaton.table before after := by
  simp only [sourceMachine, List.any_eq_true, decide_eq_true_eq, TableStep]
  constructor
  · rintro ⟨⟨⟨state, event⟩, next⟩, member, sameBefore, sameAfter⟩
    simp only at sameBefore sameAfter
    subst state
    subst next
    exact ⟨event, member⟩
  · rintro ⟨event, member⟩
    exact ⟨((before, event), after), member, rfl, rfl⟩

theorem source_machine_raw_step_exact {n : Nat} {E : Type}
    (automaton : TypedAutomaton (Fin n) E) (before after : Fin n) :
    RawStep (sourceMachine automaton) before after ↔ TableStep automaton.table before after := by
  constructor
  · rintro ⟨label, actual⟩
    exact (source_machine_step_exact automaton before after label).mp actual
  · intro edge
    exact ⟨0, (source_machine_step_exact automaton before after 0).mpr edge⟩

theorem source_machine_reachability_exact {n : Nat} {E : Type}
    (automaton : TypedAutomaton (Fin n) E) (state : Fin n) :
    RawReachable (sourceMachine automaton) state ↔
      Reach (fun s => s = automaton.initial) (TableStep automaton.table) state := by
  have initialSame : (fun s => (sourceMachine automaton).initial s = true) =
      (fun s => s = automaton.initial) := by
    funext s
    apply propext
    simp [sourceMachine]
  have stepSame : RawStep (sourceMachine automaton) = TableStep automaton.table := by
    funext before after
    exact propext (source_machine_raw_step_exact automaton before after)
  simp only [RawReachable, initialSame, stepSame]

theorem compiled_source_machine_reachability_exact
    {n : Nat} {E : Type} [DecidableEq E]
    (source : Source n E) (automaton : TypedAutomaton (Fin n) E)
    (compiled : compileSource source = .ok automaton) (state : Fin n) :
    RawReachable (sourceMachine automaton) state ↔ SourceReachable source state := by
  exact (source_machine_reachability_exact automaton state).trans
    (compiled_source_reachability_exact source automaton compiled state)

theorem compiled_model_check_iff_source_invariant
    {n : Nat} {E : Type} [DecidableEq E]
    (source : Source n E) (automaton : TypedAutomaton (Fin n) E)
    (compiled : compileSource source = .ok automaton) (invariant : Fin n → Bool) :
    checkGeneratedConstraints (sourceMachine automaton) (invariantContract invariant) = true ↔
      SourceInvariant source invariant := by
  rw [generated_constraints_iff_semantic_conformance]
  constructor
  · intro conforms state reachable
    exact (conforms.2 state
      ((compiled_source_machine_reachability_exact source automaton compiled state).mpr reachable)).1
  · intro safe
    refine ⟨fun _ _ => rfl, ?_⟩
    intro state reachable
    exact ⟨safe state
      ((compiled_source_machine_reachability_exact source automaton compiled state).mp reachable),
      fun _ _ _ => rfl⟩

/- Rejection also covers unsupported or ambiguous source profiles. It must not
   be described as proof that every rejected source has an unsafe execution. -/
def validateModel {n : Nat} {E : Type} [DecidableEq E]
    (source : Source n E) (invariant : Fin n → Bool) : Bool :=
  match compileSource source with
  | .error _ => false
  | .ok automaton => checkGeneratedConstraints (sourceMachine automaton) (invariantContract invariant)

theorem model_validation_iff_supported_deterministic_source_safety
    {n : Nat} {E : Type} [DecidableEq E]
    (source : Source n E) (invariant : Fin n → Bool) :
    validateModel source invariant = true ↔
      SourceAdmitted source ∧ SourceDeterministic source ∧ SourceInvariant source invariant := by
  constructor
  · intro passed
    cases compiled : compileSource source with
    | error error => simp [validateModel, compiled] at passed
    | ok automaton =>
      have profile := (compile_success_iff_admitted_deterministic source).mp ⟨automaton, compiled⟩
      exact ⟨profile.1, profile.2,
        (compiled_model_check_iff_source_invariant source automaton compiled invariant).mp
          (by simpa [validateModel, compiled] using passed)⟩
  · rintro ⟨supported, deterministic, safe⟩
    obtain ⟨automaton, compiled⟩ :=
      (compile_success_iff_admitted_deterministic source).mpr ⟨supported, deterministic⟩
    simpa [validateModel, compiled] using
      (compiled_model_check_iff_source_invariant source automaton compiled invariant).mpr safe

theorem unsupported_model_validation_fails_closed
    {n : Nat} {E : Type} [DecidableEq E]
    (source : Source n E) (invariant : Fin n → Bool) (unsupported : ¬ SourceAdmitted source) :
    validateModel source invariant = false := by
  simp [validateModel, unsupported_source_is_refused source unsupported]

theorem ambiguous_model_validation_fails_closed
    {n : Nat} {E : Type} [DecidableEq E]
    (source : Source n E) (invariant : Fin n → Bool)
    (supported : SourceAdmitted source) (ambiguous : ¬ SourceDeterministic source) :
    validateModel source invariant = false := by
  simp [validateModel, ambiguous_source_is_refused source supported ambiguous]

/- Reachability strengthens the invariant into an inductive predicate. It is
   NOT globally equivalent to the intended invariant: an unreachable safe state
   may have an unsafe outgoing edge. Do not replace the intended requirement
   with this stronger predicate and then assert an unproved global equivalence.
-/
def ReachableInvariant {n : Nat} {E : Type} (source : Source n E)
    (invariant : Fin n → Bool) (state : Fin n) : Prop :=
  SourceReachable source state ∧ invariant state = true

theorem validated_model_initial_is_inductive
    {n : Nat} {E : Type} [DecidableEq E]
    (source : Source n E) (invariant : Fin n → Bool)
    (validated : validateModel source invariant = true) :
    ReachableInvariant source invariant source.initial := by
  have safe := (model_validation_iff_supported_deterministic_source_safety source invariant).mp validated
  exact ⟨.start rfl, safe.2.2 source.initial (.start rfl)⟩

theorem validated_model_source_edge_preserves_strengthening
    {n : Nat} {E : Type} [DecidableEq E]
    (source : Source n E) (invariant : Fin n → Bool)
    (validated : validateModel source invariant = true)
    (before : Fin n) (event : E) (after : Fin n)
    (admitted : ReachableInvariant source invariant before)
    (edge : SourceStep source before event after) :
    ReachableInvariant source invariant after := by
  have reached : SourceReachable source after := .advance admitted.1 ⟨event, edge⟩
  have safe := (model_validation_iff_supported_deterministic_source_safety source invariant).mp validated
  exact ⟨reached, safe.2.2 after reached⟩

theorem validation_discharges_compiled_inductive_obligations
    {n : Nat} {E : Type} [DecidableEq E]
    (source : Source n E) (automaton : TypedAutomaton (Fin n) E)
    (compiled : compileSource source = .ok automaton) (invariant : Fin n → Bool)
    (validated : validateModel source invariant = true) :
    ReachableInvariant source invariant automaton.initial ∧
    ∀ before event after, ReachableInvariant source invariant before →
      ((before, event), after) ∈ automaton.table → ReachableInvariant source invariant after := by
  have shape := compile_success_shape source automaton compiled
  refine ⟨?_, ?_⟩
  · rw [shape.2.1]
    exact validated_model_initial_is_inductive source invariant validated
  · intro before event after admitted edge
    rw [shape.2.2] at edge
    exact validated_model_source_edge_preserves_strengthening source invariant validated before event after
      admitted ((extracted_edges_exact source before event after).mp edge)

theorem strengthened_invariant_implies_intended_requirement
    {n : Nat} {E : Type} (source : Source n E) (invariant : Fin n → Bool)
    (required : Fin n → Prop) (meaning : ∀ state, invariant state = true ↔ required state)
    (state : Fin n) (admitted : ReachableInvariant source invariant state) : required state :=
  (meaning state).mp admitted.2

theorem validated_model_preserves_intended_requirement
    {n : Nat} {E : Type} [DecidableEq E]
    (source : Source n E) (invariant : Fin n → Bool)
    (required : Fin n → Prop) (meaning : ∀ state, invariant state = true ↔ required state)
    (validated : validateModel source invariant = true) (state : Fin n)
    (reachable : SourceReachable source state) : required state := by
  have safe := (model_validation_iff_supported_deterministic_source_safety source invariant).mp validated
  exact (meaning state).mp (safe.2.2 state reachable)

/- A supported source with useful 0→1 behavior and a bad but unreachable state. -/
def usefulSafeSource : Source 3 Unit :=
  ⟨0, [⟨(), .stateIs 0, .set 1⟩, ⟨(), .stateIs 1, .keep⟩]⟩
def avoidTwo (state : Fin 3) : Bool := state != 2

theorem useful_source_is_accepted_with_unreachable_bad_state :
    validateModel usefulSafeSource avoidTwo = true ∧
    SourceReachable usefulSafeSource 1 ∧ avoidTwo 2 = false := by
  refine ⟨by decide, ?_, rfl⟩
  have initial : SourceReachable usefulSafeSource 0 := .start rfl
  exact .advance initial
    ⟨(), ⟨⟨(), .stateIs 0, .set 1⟩, List.mem_cons_self, rfl, rfl, rfl⟩⟩

/- GuardedSource permits 0→1→2. Program-level conformance can avoid Submit,
   but model validation must inspect every source-permitted reachable edge. -/
def cautiousProgram : RawMachine 3 1 where
  initial state := state == 0
  step before _ after := before == 0 && after == 1

theorem source_unsafe_state_is_reachable : SourceReachable guardedSource 2 := by
  have initial : SourceReachable guardedSource 0 := .start rfl
  have first : SourceReachable guardedSource 1 := .advance initial
    ⟨false, ⟨⟨false, .stateIs 0, .set 1⟩, List.mem_cons_self, rfl, rfl, rfl⟩⟩
  exact .advance first
    ⟨true, ⟨⟨true, .stateIs 1, .set 2⟩,
      List.mem_cons_of_mem _ List.mem_cons_self, rfl, rfl, rfl⟩⟩

theorem program_conformance_does_not_establish_model_safety :
    SGDCompilerLintBridge.pipelineLint guardedSource cautiousProgram id
      (fun _ => .accepted false) avoidTwo = true ∧
    validateModel guardedSource avoidTwo = false ∧ SourceReachable guardedSource 2 := by
  exact ⟨by decide, by decide, source_unsafe_state_is_reachable⟩

/- The checker validates reachable safety, not closure from every safe state. -/
def unreachableUnsafeEdgeSource : Source 3 Unit :=
  ⟨0, [⟨(), .stateIs 0, .keep⟩, ⟨(), .stateIs 1, .set 2⟩]⟩

theorem reachable_safety_does_not_imply_all_safe_state_closure :
    validateModel unreachableUnsafeEdgeSource avoidTwo = true ∧
    avoidTwo 1 = true ∧ SourceStep unreachableUnsafeEdgeSource 1 () 2 ∧ avoidTwo 2 = false := by
  refine ⟨by decide, rfl, ?_, rfl⟩
  exact ⟨⟨(), .stateIs 1, .set 2⟩, List.mem_cons_of_mem _ List.mem_cons_self, rfl, rfl, rfl⟩

theorem strengthening_is_not_an_implicit_new_requirement :
    avoidTwo 1 = true ∧ ¬ ReachableInvariant unreachableUnsafeEdgeSource avoidTwo 1 := by
  refine ⟨rfl, ?_⟩
  intro strengthened
  have validated : validateModel unreachableUnsafeEdgeSource avoidTwo = true := by decide
  have violatingNext := validated_model_source_edge_preserves_strengthening
    unreachableUnsafeEdgeSource avoidTwo validated 1 () 2 strengthened
    ⟨⟨(), .stateIs 1, .set 2⟩, List.mem_cons_of_mem _ List.mem_cons_self, rfl, rfl, rfl⟩
  cases violatingNext.2

/- Once the SPECIFICATION invariant is established, exact protocol conformance
   alone entails that invariant for every actual raw-program reachable owner.
   No runtime invariant log/check is inserted. The raw machine is unchanged;
   in particular, its forbidden edges are not filtered out before checking.
-/
def ProtocolConforms {n cfg labels : Nat} {E : Type}
    (source : Source n E) (machine : RawMachine cfg labels)
    (owner : Fin cfg → Fin n) (observe : Fin labels → SGDCompilerLintBridge.Observation E) : Prop :=
  SGDCompilerLintBridge.SourceConforms source machine owner observe (fun _ => true)

theorem validated_protocol_conformance_preserves_invariant
    {n cfg labels : Nat} {E : Type} [DecidableEq E]
    (source : Source n E) (machine : RawMachine cfg labels)
    (owner : Fin cfg → Fin n) (observe : Fin labels → SGDCompilerLintBridge.Observation E)
    (invariant : Fin n → Bool) (validated : validateModel source invariant = true)
    (protocol : ProtocolConforms source machine owner observe)
    (state : Fin cfg) (reachable : RawReachable machine state) :
    invariant (owner state) = true := by
  have sourceReached := SGDGraphLintBridge.source_conformance_projects_reachability
    source machine owner observe (fun _ => true) protocol reachable
  have safe := (model_validation_iff_supported_deterministic_source_safety source invariant).mp validated
  exact safe.2.2 (owner state) sourceReached

theorem validated_protocol_conformance_iff_full_conformance
    {n cfg labels : Nat} {E : Type} [DecidableEq E]
    (source : Source n E) (machine : RawMachine cfg labels)
    (owner : Fin cfg → Fin n) (observe : Fin labels → SGDCompilerLintBridge.Observation E)
    (invariant : Fin n → Bool) (validated : validateModel source invariant = true) :
    ProtocolConforms source machine owner observe ↔
      SGDCompilerLintBridge.SourceConforms source machine owner observe invariant := by
  constructor
  · intro protocol
    refine ⟨protocol.1, ?_⟩
    intro state reachable
    exact ⟨validated_protocol_conformance_preserves_invariant source machine owner observe invariant
      validated protocol state reachable, (protocol.2 state reachable).2⟩
  · intro conforms
    exact ⟨conforms.1, fun state reachable => ⟨rfl, (conforms.2 state reachable).2⟩⟩

theorem validated_protocol_lint_iff_invariant_lint
    {n cfg labels : Nat} {E : Type} [DecidableEq E]
    (source : Source n E) (machine : RawMachine cfg labels)
    (owner : Fin cfg → Fin n) (observe : Fin labels → SGDCompilerLintBridge.Observation E)
    (invariant : Fin n → Bool) (validated : validateModel source invariant = true) :
    SGDCompilerLintBridge.pipelineLint source machine owner observe (fun _ => true) = true ↔
      SGDCompilerLintBridge.pipelineLint source machine owner observe invariant = true := by
  have profile := (model_validation_iff_supported_deterministic_source_safety source invariant).mp validated
  obtain ⟨automaton, compiled⟩ := (compile_success_iff_admitted_deterministic source).mpr
    ⟨profile.1, profile.2.1⟩
  rw [SGDCompilerLintBridge.compiled_lint_iff_source_conformance source automaton compiled machine owner observe (fun _ => true),
      SGDCompilerLintBridge.compiled_lint_iff_source_conformance source automaton compiled machine owner observe invariant]
  exact validated_protocol_conformance_iff_full_conformance source machine owner observe invariant validated

theorem model_and_protocol_lint_exact
    {n cfg labels : Nat} {E : Type} [DecidableEq E]
    (source : Source n E) (machine : RawMachine cfg labels)
    (owner : Fin cfg → Fin n) (observe : Fin labels → SGDCompilerLintBridge.Observation E)
    (invariant : Fin n → Bool) :
    (validateModel source invariant &&
      SGDCompilerLintBridge.pipelineLint source machine owner observe (fun _ => true)) = true ↔
      SourceAdmitted source ∧ SourceDeterministic source ∧ SourceInvariant source invariant ∧
        ProtocolConforms source machine owner observe := by
  rw [Bool.and_eq_true]
  constructor
  · rintro ⟨validated, linted⟩
    have model := (model_validation_iff_supported_deterministic_source_safety source invariant).mp validated
    have protocol := (SGDCompilerLintBridge.compiler_generated_lint_iff_supported_deterministic_source_compliance
      source machine owner observe (fun _ => true)).mp linted
    exact ⟨model.1, model.2.1, model.2.2, protocol.2.2⟩
  · rintro ⟨supported, deterministic, safe, protocol⟩
    exact ⟨(model_validation_iff_supported_deterministic_source_safety source invariant).mpr
        ⟨supported, deterministic, safe⟩,
      (SGDCompilerLintBridge.compiler_generated_lint_iff_supported_deterministic_source_compliance
        source machine owner observe (fun _ => true)).mpr ⟨supported, deterministic, protocol⟩⟩

/- Intended full-configuration meaning remains a separate fixed semantic
   obligation. This theorem does not make a caller-chosen erasing owner/label
   map faithful, and it does not prove arbitrary native-source coverage.
-/
theorem model_and_protocol_lint_preserve_intended_program_requirement
    {n cfg labels : Nat} {E : Type} [DecidableEq E]
    (source : Source n E) (machine : RawMachine cfg labels)
    (owner : Fin cfg → Fin n) (observe : Fin labels → SGDCompilerLintBridge.Observation E)
    (invariant : Fin n → Bool) (required : Fin cfg → Prop)
    (meaning : ∀ state, required state ↔ invariant (owner state) = true)
    (validated : validateModel source invariant = true)
    (linted : SGDCompilerLintBridge.pipelineLint source machine owner observe (fun _ => true) = true)
    (state : Fin cfg) (reachable : RawReachable machine state) : required state := by
  have protocol := (SGDCompilerLintBridge.compiler_generated_lint_iff_supported_deterministic_source_compliance
    source machine owner observe (fun _ => true)).mp linted
  exact (meaning state).mpr
    (validated_protocol_conformance_preserves_invariant source machine owner observe invariant
      validated protocol.2.2 state reachable)

end SGDModelValidation

#print axioms SGDModelValidation.source_machine_initial_nonempty
#print axioms SGDModelValidation.source_machine_step_exact
#print axioms SGDModelValidation.source_machine_raw_step_exact
#print axioms SGDModelValidation.source_machine_reachability_exact
#print axioms SGDModelValidation.compiled_source_machine_reachability_exact
#print axioms SGDModelValidation.compiled_model_check_iff_source_invariant
#print axioms SGDModelValidation.model_validation_iff_supported_deterministic_source_safety
#print axioms SGDModelValidation.unsupported_model_validation_fails_closed
#print axioms SGDModelValidation.ambiguous_model_validation_fails_closed
#print axioms SGDModelValidation.validated_model_initial_is_inductive
#print axioms SGDModelValidation.validated_model_source_edge_preserves_strengthening
#print axioms SGDModelValidation.validation_discharges_compiled_inductive_obligations
#print axioms SGDModelValidation.strengthened_invariant_implies_intended_requirement
#print axioms SGDModelValidation.validated_model_preserves_intended_requirement
#print axioms SGDModelValidation.useful_source_is_accepted_with_unreachable_bad_state
#print axioms SGDModelValidation.source_unsafe_state_is_reachable
#print axioms SGDModelValidation.program_conformance_does_not_establish_model_safety
#print axioms SGDModelValidation.reachable_safety_does_not_imply_all_safe_state_closure
#print axioms SGDModelValidation.strengthening_is_not_an_implicit_new_requirement
#print axioms SGDModelValidation.sourceMachine
#print axioms SGDModelValidation.validateModel

#print axioms SGDModelValidation.validated_protocol_conformance_preserves_invariant
#print axioms SGDModelValidation.validated_protocol_conformance_iff_full_conformance
#print axioms SGDModelValidation.validated_protocol_lint_iff_invariant_lint
#print axioms SGDModelValidation.model_and_protocol_lint_exact
#print axioms SGDModelValidation.model_and_protocol_lint_preserve_intended_program_requirement
