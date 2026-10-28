import CheckedTraces
import GraphLintBridge

/- Fixed-epoch whole-runtime checking against constraints generated from an
   imported reachable graph. The actual installed table is an independent
   input. Complete configurations and scheduler labels use the existing exact
   runtime lowering. No equality of unreachable graph/source edges is assumed.
   Native parsers, heaps, I/O and infinite-trace liveness remain outside scope. -/
namespace SGDGraphCheckedTraces
open SGDMethod SGDCompilerPipeline SGDCompilerLintBridge SGDLanguageProfiles
open SGDProfileComposition SGDWholeProgram SGDCheckedTraces SGDGraphLintBridge
open SGDFiniteConfigurations SGDSemanticConstraints

def loweredOwner {states pcs components : Nat}
    (index : Fin (runtimeEnumeration states pcs components).values.length) : Fin (states + 1) :=
  (decode (runtimeEnumeration states pcs components) index).owner

def loweredObservation {components events : Nat}
    (index : EncodedRuntimeLabel components events) : Observation (Actor components × Fin events) :=
  let label := decodeRuntimeLabel index
  liftObservation label.1 label.2

theorem lowered_runtime_contract_exact {states pcs events components : Nat}
    (automaton : TypedAutomaton (Fin (states + 1)) (Actor components × Fin events))
    (actualTable : GlobalTable states events components)
    (bodies : Actor components → Controller states pcs events)
    (initial : RuntimeConfiguration states pcs components) (invariant : Fin (states + 1) → Bool) :
    Conforms
      (lowerMachine (runtimeEnumeration states pcs components) (runtimeMachine actualTable bodies initial))
      (compiledContract automaton loweredOwner loweredObservation invariant) ↔
    NativeConforms (runtimeMachine actualTable bodies initial) (compiledRuntimeContract automaton invariant) := by
  exact indexed_conformance_exact (runtimeEnumeration states pcs components)
    (runtimeMachine actualTable bodies initial) (compiledRuntimeContract automaton invariant)

theorem imported_global_contract_iff_actual_source_compliance {states pcs events components : Nat}
    (source : Source (states + 1) (Actor components × Fin events))
    (graph : ExactGraph (Fin (states + 1)) (Actor components × Fin events))
    (automaton : TypedAutomaton (Fin (states + 1)) (Actor components × Fin events))
    (imported : importGraph source (.exact graph) = .ok automaton)
    (actualTable : GlobalTable states events components)
    (bodies : Actor components → Controller states pcs events)
    (initial : RuntimeConfiguration states pcs components) (invariant : Fin (states + 1) → Bool) :
    NativeConforms (runtimeMachine actualTable bodies initial) (compiledRuntimeContract automaton invariant) ↔
      RuntimeConforms source actualTable bodies initial invariant := by
  obtain ⟨reference, compiled, _, _, _⟩ := import_success_has_checked_source source graph automaton imported
  exact (lowered_runtime_contract_exact automaton actualTable bodies initial invariant).symm.trans
    ((imported_contract_iff_source_conformance source graph automaton imported _
      loweredOwner loweredObservation invariant).trans
      ((compiled_contract_iff_source_conformance source reference compiled _
        loweredOwner loweredObservation invariant).symm.trans
        ((lowered_runtime_contract_exact reference actualTable bodies initial invariant).trans
          (compiled_global_contract_iff_actual_source_compliance source reference compiled
            actualTable bodies initial invariant))))

def graphGlobalSemanticLint {states pcs events components : Nat}
    (source : Source (states + 1) (Actor components × Fin events))
    (input : GraphInput (Fin (states + 1)) (Actor components × Fin events))
    (actualTable : GlobalTable states events components)
    (bodies : Actor components → Controller states pcs events)
    (initial : RuntimeConfiguration states pcs components) (invariant : Fin (states + 1) → Bool) : Bool :=
  match importGraph source input with
  | .error _ => false
  | .ok automaton => checkFiniteConfigurations (runtimeEnumeration states pcs components)
      (runtimeMachine actualTable bodies initial) (compiledRuntimeContract automaton invariant)

def graphGlobalCombinedLint {states pcs events components : Nat}
    (source : Source (states + 1) (Actor components × Fin events))
    (input : GraphInput (Fin (states + 1)) (Actor components × Fin events))
    (actualTable : GlobalTable states events components)
    (bodies : Actor components → Controller states pcs events)
    (initial : RuntimeConfiguration states pcs components) (invariant : Fin (states + 1) → Bool) : Bool :=
  checkWorld (runtimeWorld bodies initial) &&
    graphGlobalSemanticLint source input actualTable bodies initial invariant

theorem imported_global_lint_iff_explicit_contract {states pcs events components : Nat}
    (source : Source (states + 1) (Actor components × Fin events))
    (graph : ExactGraph (Fin (states + 1)) (Actor components × Fin events))
    (automaton : TypedAutomaton (Fin (states + 1)) (Actor components × Fin events))
    (imported : importGraph source (.exact graph) = .ok automaton)
    (actualTable : GlobalTable states events components)
    (bodies : Actor components → Controller states pcs events)
    (initial : RuntimeConfiguration states pcs components) (invariant : Fin (states + 1) → Bool) :
    graphGlobalCombinedLint source (.exact graph) actualTable bodies initial invariant = true ↔
      (∀ actor, BodyAdmitted (bodies actor)) ∧ RuntimeConforms source actualTable bodies initial invariant := by
  simp only [graphGlobalCombinedLint, graphGlobalSemanticLint, imported, Bool.and_eq_true,
    world_check_exact, finite_configuration_checker_iff_native_conformance,
    imported_global_contract_iff_actual_source_compliance source graph automaton imported,
    WorldAdmitted, runtimeWorld]

theorem accepted_graph_whole_program_preserves_fixed_epoch_trace
    {states pcs events components : Nat}
    {source : Source (states + 1) (Actor components × Fin events)}
    {graph : ExactGraph (Fin (states + 1)) (Actor components × Fin events)}
    {automaton : TypedAutomaton (Fin (states + 1)) (Actor components × Fin events)}
    (imported : importGraph source (.exact graph) = .ok automaton)
    {actualTable : GlobalTable states events components}
    {bodies : Actor components → Controller states pcs events}
    {initial final : RuntimeConfiguration states pcs components}
    {invariant : Fin (states + 1) → Bool} {labels : List (RuntimeLabel components events)}
    (passed : graphGlobalCombinedLint source (.exact graph) actualTable bodies initial invariant = true)
    (trace : Trace (LabeledRuntimeStep actualTable bodies) initial labels final) :
    (∀ actor, BodyAdmitted (bodies actor)) ∧
      Trace (SourceLabelStep source) source.initial labels final.owner ∧ invariant final.owner = true := by
  have contract := (imported_global_lint_iff_explicit_contract source graph automaton imported
    actualTable bodies initial invariant).mp passed
  have result := conforming_trace_preserves_labels_and_invariant contract.2 (.start rfl) trace
  rw [contract.2.1] at result
  exact ⟨contract.1, result⟩

theorem refused_import_cannot_pass {states pcs events components : Nat}
    (source : Source (states + 1) (Actor components × Fin events))
    (input : GraphInput (Fin (states + 1)) (Actor components × Fin events))
    (reason : GraphImportError) (refused : importGraph source input = .error reason)
    (actualTable : GlobalTable states events components)
    (bodies : Actor components → Controller states pcs events)
    (initial : RuntimeConfiguration states pcs components) (invariant : Fin (states + 1) → Bool) :
    graphGlobalCombinedLint source input actualTable bodies initial invariant = false := by
  simp [graphGlobalCombinedLint, graphGlobalSemanticLint, refused]

/- The graph omits an unreachable source self-loop. Its generated constraints
   still accept real progress followed by rejection, and reject a wrong installed
   table. The runtime table is not replaced with graph output by the checker. -/
def exampleSource : Source 3 (Actor 0 × Fin 1) :=
  ⟨0, [⟨(.environment, 0), .stateIs 0, .set 1⟩,
       ⟨(.environment, 0), .stateIs 2, .keep⟩]⟩

def exampleGraph : ExactGraph (Fin 3) (Actor 0 × Fin 1) :=
  ⟨0, [0, 1], [((0, (.environment, 0)), 1)], [[], [((.environment, 0), 1)]]⟩

def exampleBodies : Actor 0 → Controller 2 0 1 :=
  fun _ => .ts ⟨[], fun _ => .send .authority 0 0 0⟩

def exampleInitial : RuntimeConfiguration 2 0 0 := ⟨0, fun i => Fin.elim0 i, 0⟩
def exampleAfter : RuntimeConfiguration 2 0 0 := { exampleInitial with owner := 1 }

theorem imported_graph_constraints_allow_actual_progress_and_rejection :
    graphGlobalCombinedLint exampleSource (.exact exampleGraph) exampleGraph.table exampleBodies
      exampleInitial (fun state => state != 2) = true ∧
    (runtimeRun exampleGraph.table exampleBodies exampleInitial .environment).1 = .accepted 0 ∧
    (runtimeRun exampleGraph.table exampleBodies exampleInitial .environment).2.owner = 1 ∧
    (runtimeRun exampleGraph.table exampleBodies exampleAfter .environment).1 = .rejected 0 ∧
    (runtimeRun exampleGraph.table exampleBodies exampleAfter .environment).2.owner = 1 := by
  decide

theorem wrong_actual_policy_is_rejected :
    graphGlobalCombinedLint exampleSource (.exact exampleGraph)
      [((0, (.environment, 0)), 2)] exampleBodies exampleInitial (fun _ => true) = false := by
  decide

end SGDGraphCheckedTraces

#print axioms SGDGraphCheckedTraces.lowered_runtime_contract_exact
#print axioms SGDGraphCheckedTraces.imported_global_contract_iff_actual_source_compliance
#print axioms SGDGraphCheckedTraces.imported_global_lint_iff_explicit_contract
#print axioms SGDGraphCheckedTraces.accepted_graph_whole_program_preserves_fixed_epoch_trace
#print axioms SGDGraphCheckedTraces.refused_import_cannot_pass

#print axioms SGDGraphCheckedTraces.imported_graph_constraints_allow_actual_progress_and_rejection
#print axioms SGDGraphCheckedTraces.wrong_actual_policy_is_rejected
