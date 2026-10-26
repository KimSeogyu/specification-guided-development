import CompilerLintBridge

/- Connect reachable-only imported graphs to semantic lint. Graph tables need
   not equal full-domain source tables. The proof derives the reachability of
   every actually observed owner before using the graph correspondence. -/
namespace SGDGraphLintBridge
open SGDMethod SGDCompilerPipeline SGDSemanticConstraints SGDCompilerLintBridge

abbrev SourceReach {n : Nat} {E : Type} (source : Source n E) :=
  Reach (fun s => s = source.initial) (fun s t => ∃ e, SourceStep source s e t)

theorem source_conformance_projects_reachability
    {n cfg labels : Nat} {E : Type}
    (source : Source n E) (machine : RawMachine cfg labels)
    (owner : Fin cfg → Fin n) (observe : Fin labels → Observation E)
    (invariant : Fin n → Bool)
    (conforms : SourceConforms source machine owner observe invariant)
    {state : Fin cfg} (reachable : RawReachable machine state) :
    SourceReach source (owner state) := by
  induction reachable with
  | start initial => exact .start (conforms.1 _ initial)
  | @advance before after previous edge ih =>
    obtain ⟨label, step⟩ := edge
    have follows := (conforms.2 before previous).2 label after step
    cases observed : observe label with
    | accepted event =>
      exact .advance ih ⟨event, by simpa [SourceObservation, observed] using follows⟩
    | rejected event =>
      have same : owner before = owner after :=
        (show owner before = owner after ∧ _ by
          simpa [SourceObservation, observed] using follows).1
      simpa only [← same] using ih
    | internal =>
      have same : owner before = owner after := by simpa [SourceObservation, observed] using follows
      simpa only [← same] using ih
    | forbidden => simp [SourceObservation, observed] at follows

theorem compiled_conformance_projects_reachability
    {n cfg labels : Nat} {E : Type} [DecidableEq E]
    (automaton : TypedAutomaton (Fin n) E) (machine : RawMachine cfg labels)
    (owner : Fin cfg → Fin n) (observe : Fin labels → Observation E)
    (invariant : Fin n → Bool)
    (conforms : Conforms machine (compiledContract automaton owner observe invariant))
    {state : Fin cfg} (reachable : RawReachable machine state) :
    Reach (fun s => s = automaton.initial) (TableStep automaton.table) (owner state) := by
  induction reachable with
  | start initial =>
    exact .start (by simpa [compiledContract] using conforms.1 _ initial)
  | @advance before after previous edge ih =>
    obtain ⟨label, step⟩ := edge
    have follows := (conforms.2 before previous).2 label after step
    change compiledEdge automaton (observe label) (owner before) (owner after) = true at follows
    cases observed : observe label with
    | accepted event =>
      have result : evalDispatch (compileTable automaton.table) (owner before, event) = some (owner after) := by
        simpa [compiledEdge, observed] using follows
      exact .advance ih ⟨event,
        (generated_dispatch_exact automaton.table automaton.functional _ _).mp result⟩
    | rejected event =>
      have same : owner before = owner after :=
        (show owner before = owner after ∧ _ by simpa [compiledEdge, observed] using follows).1
      simpa only [← same] using ih
    | internal =>
      have same : owner before = owner after := by simpa [compiledEdge, observed] using follows
      simpa only [← same] using ih
    | forbidden => simp [compiledEdge, observed] at follows

theorem imported_initial_matches_source {n : Nat} {E : Type} [DecidableEq E]
    (source : Source n E) (graph : ExactGraph (Fin n) E)
    (automaton : TypedAutomaton (Fin n) E)
    (imported : importGraph source (.exact graph) = .ok automaton) :
    automaton.initial = source.initial := by
  obtain ⟨reference, compiled, checked, initial, _⟩ :=
    import_success_has_checked_source source graph automaton imported
  exact initial.trans (((graph_check_exact reference graph).mp checked).1.trans
    (compile_success_shape source reference compiled).2.1)

theorem imported_edge_exact_on_reachable_owner
    {n : Nat} {E : Type} [DecidableEq E]
    (source : Source n E) (graph : ExactGraph (Fin n) E)
    (automaton : TypedAutomaton (Fin n) E)
    (imported : importGraph source (.exact graph) = .ok automaton)
    (observation : Observation E) (before after : Fin n)
    (reachable : SourceReach source before) :
    compiledEdge automaton observation before after = true ↔
      SourceObservation source observation before after := by
  cases observation with
  | accepted event =>
    simpa [compiledEdge, SourceObservation] using
      imported_graph_accepts_iff_reachable_source_step source graph automaton imported before event after reachable
  | rejected event =>
    simp only [compiledEdge, SourceObservation, Bool.and_eq_true, decide_eq_true_eq]
    exact and_congr Iff.rfl
      (imported_graph_rejects_iff_no_reachable_source_step source graph automaton imported before event reachable)
  | internal => simp [compiledEdge, SourceObservation]
  | forbidden => simp [compiledEdge, SourceObservation]

theorem imported_contract_iff_source_conformance
    {n cfg labels : Nat} {E : Type} [DecidableEq E]
    (source : Source n E) (graph : ExactGraph (Fin n) E)
    (automaton : TypedAutomaton (Fin n) E)
    (imported : importGraph source (.exact graph) = .ok automaton)
    (machine : RawMachine cfg labels)
    (owner : Fin cfg → Fin n) (observe : Fin labels → Observation E)
    (invariant : Fin n → Bool) :
    Conforms machine (compiledContract automaton owner observe invariant) ↔
      SourceConforms source machine owner observe invariant := by
  have initialSame := imported_initial_matches_source source graph automaton imported
  constructor
  · intro conforms
    refine ⟨?_, ?_⟩
    · intro state initial
      simpa [compiledContract, initialSame] using conforms.1 state initial
    · intro state reachable
      refine ⟨(conforms.2 state reachable).1, ?_⟩
      have graphReach := compiled_conformance_projects_reachability automaton machine owner observe invariant conforms reachable
      have sourceReach := (imported_graph_source_reachability_exact source graph automaton imported _).mp graphReach
      intro label next step
      exact (imported_edge_exact_on_reachable_owner source graph automaton imported
        (observe label) (owner state) (owner next) sourceReach).mp
        ((conforms.2 state reachable).2 label next step)
  · intro conforms
    refine ⟨?_, ?_⟩
    · intro state initial
      simpa [compiledContract, initialSame] using conforms.1 state initial
    · intro state reachable
      refine ⟨(conforms.2 state reachable).1, ?_⟩
      have sourceReach := source_conformance_projects_reachability source machine owner observe invariant conforms reachable
      intro label next step
      exact (imported_edge_exact_on_reachable_owner source graph automaton imported
        (observe label) (owner state) (owner next) sourceReach).mpr
        ((conforms.2 state reachable).2 label next step)

def graphPipelineLint {n cfg labels : Nat} {E : Type} [DecidableEq E]
    (source : Source n E) (graph : ExactGraph (Fin n) E)
    (machine : RawMachine cfg labels)
    (owner : Fin cfg → Fin n) (observe : Fin labels → Observation E)
    (invariant : Fin n → Bool) : Bool :=
  match importGraph source (.exact graph) with
  | .error _ => false
  | .ok automaton =>
      checkGeneratedConstraints machine (compiledContract automaton owner observe invariant)

theorem checked_graph_lint_iff_source_conformance
    {n cfg labels : Nat} {E : Type} [DecidableEq E]
    (source : Source n E) (graph : ExactGraph (Fin n) E)
    (automaton : TypedAutomaton (Fin n) E)
    (imported : importGraph source (.exact graph) = .ok automaton)
    (machine : RawMachine cfg labels)
    (owner : Fin cfg → Fin n) (observe : Fin labels → Observation E)
    (invariant : Fin n → Bool) :
    graphPipelineLint source graph machine owner observe invariant = true ↔
      SourceConforms source machine owner observe invariant := by
  simp only [graphPipelineLint, imported]
  exact (generated_constraints_iff_semantic_conformance machine _).trans
    (imported_contract_iff_source_conformance source graph automaton imported machine owner observe invariant)

/- The graph legitimately omits a source edge at an unreachable state.
   Both pipelines accept the actual looping program despite that difference. -/
def loopingRaw : RawMachine 2 1 where
  initial state := state == 0
  step before _ after := before == after

theorem reachable_only_graph_and_full_source_agree_on_program :
    pipelineLint unreachableRuleSource loopingRaw id (fun _ => .rejected ()) (fun _ => true) = true ∧
    graphPipelineLint unreachableRuleSource reachableOnlyGraph loopingRaw id
      (fun _ => .rejected ()) (fun _ => true) = true := by decide

theorem agreement_does_not_require_unreachable_dispatch_equality :
    evalDispatch (compileTable (extract unreachableRuleSource)) ((1 : Fin 2), ()) = some 1 ∧
    evalDispatch (compileTable reachableOnlyGraph.table) ((1 : Fin 2), ()) = none := by decide

theorem wrong_live_origin_is_not_silently_reinitialized :
    graphPipelineLint unreachableRuleSource reachableOnlyGraph
      (⟨fun state => state == 1, fun before _ after => before == after⟩ : RawMachine 2 1)
      id (fun _ => .rejected ()) (fun _ => true) = false := by decide

end SGDGraphLintBridge

#print axioms SGDGraphLintBridge.source_conformance_projects_reachability
#print axioms SGDGraphLintBridge.compiled_conformance_projects_reachability
#print axioms SGDGraphLintBridge.imported_contract_iff_source_conformance
#print axioms SGDGraphLintBridge.checked_graph_lint_iff_source_conformance
#print axioms SGDGraphLintBridge.reachable_only_graph_and_full_source_agree_on_program
#print axioms SGDGraphLintBridge.agreement_does_not_require_unreachable_dispatch_equality
#print axioms SGDGraphLintBridge.wrong_live_origin_is_not_silently_reinitialized
