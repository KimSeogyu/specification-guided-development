import CertifiedPipeline

/- Reachable-only graph development over the actual checked CFG worlds.
   Migration has two separate obligations: preserve the old live meaning and
   enter the new source's reachable domain. Neither follows from the other.
   Adjacent refinement below is deliberately the full source-edge obligation;
   this theorem does not pretend that checking graph edges establishes it.
   No native parser, scheduler, heap or external-effect semantics are assumed.
-/
namespace SGDGraphDevelopment
open SGDMethod SGDCompilerPipeline SGDGraphLintBridge SGDModelValidation
open SGDDevelopmentRefinement SGDProfileComposition

theorem imported_nodes_exact_source_domain {n : Nat} {E : Type} [DecidableEq E]
    (source : Source n E) (graph : ExactGraph (Fin n) E)
    (automaton : TypedAutomaton (Fin n) E)
    (imported : importGraph source (.exact graph) = .ok automaton) (state : Fin n) :
    state ∈ graph.nodes ↔ SourceReachable source state := by
  obtain ⟨reference, compiled, checked, _, _⟩ :=
    import_success_has_checked_source source graph automaton imported
  exact (checked_graph_nodes_exact reference graph checked state).trans
    (compiled_source_reachability_exact source reference compiled state)

def checkMigration {old new : Nat} {E : Type}
    (graph : ExactGraph (Fin new) E) (previous : Fin new → Fin old)
    (before : Fin old) (after : Fin new) : Bool :=
  decide (previous after = before) && graph.nodes.contains after

theorem migration_check_exact {old new : Nat} {E : Type} [DecidableEq E]
    (source : Source new E) (graph : ExactGraph (Fin new) E)
    (automaton : TypedAutomaton (Fin new) E)
    (imported : importGraph source (.exact graph) = .ok automaton)
    (previous : Fin new → Fin old) (before : Fin old) (after : Fin new) :
    checkMigration graph previous before after = true ↔
      previous after = before ∧ SourceReachable source after := by
  simp only [checkMigration, Bool.and_eq_true, decide_eq_true_eq, List.contains_iff_mem]
  exact and_congr Iff.rfl (imported_nodes_exact_source_domain source graph automaton imported after)

structure GraphFamily {states events components : Nat → Nat}
    (sources : (n : Nat) → Source (states n + 1) (Actor (components n) × Fin (events n))) where
  graphs : (n : Nat) → ExactGraph (Fin (states n + 1)) (Actor (components n) × Fin (events n))
  automata : (n : Nat) → TypedAutomaton (Fin (states n + 1)) (Actor (components n) × Fin (events n))
  imported : ∀ n, importGraph (sources n) (.exact (graphs n)) = .ok (automata n)

abbrev GraphWorld {states events components : Nat → Nat} (pcs : Nat → Nat)
    (sources : (n : Nat) → Source (states n + 1) (Actor (components n) × Fin (events n))) (n : Nat) :=
  { world : CheckedWorld (states n) (pcs n) (events n) (components n) //
    SourceReachable (sources n) world.val.owner }

def graphProject {states events components pcs : Nat → Nat}
    {sources : (n : Nat) → Source (states n + 1) (Actor (components n) × Fin (events n))}
    (n : Nat) (world : GraphWorld pcs sources n) : Fin (states n + 1) := world.val.val.owner

def graphLocalStep {states events components pcs : Nat → Nat}
    {sources : (n : Nat) → Source (states n + 1) (Actor (components n) × Fin (events n))}
    (family : GraphFamily sources) (n : Nat) (before after : GraphWorld pcs sources n) : Prop :=
  CheckedStep (family.automata n).table before.val after.val

def sourceStep {states events components : Nat → Nat}
    (sources : (n : Nat) → Source (states n + 1) (Actor (components n) × Fin (events n)))
    (n : Nat) (before after : Fin (states n + 1)) : Prop :=
  ∃ event, SourceStep (sources n) before event after

theorem graph_local_step_refines_source {states events components pcs : Nat → Nat}
    {sources : (n : Nat) → Source (states n + 1) (Actor (components n) × Fin (events n))}
    (family : GraphFamily sources) (n : Nat) :
    StepRefines (graphLocalStep (pcs := pcs) family n) (sourceStep sources n) (graphProject n) := by
  intro before after step
  rcases checked_step_projection (family.automata n).table before.val after.val step with same | moved
  · exact Or.inl same
  · obtain ⟨actor, event, member⟩ := moved
    exact Or.inr ⟨(actor, event),
      (imported_graph_accepts_iff_reachable_source_step (sources n) (family.graphs n)
        (family.automata n) (family.imported n) _ _ _ before.property).mp
        ((generated_dispatch_exact (family.automata n).table (family.automata n).functional _ _).mpr member)⟩

/- Domain membership is a logical admission condition, not a stored receipt.
   Runtime steps cannot escape it: their projection is a source edge or stutter.
-/
theorem checked_step_preserves_graph_domain {states events components pcs : Nat → Nat}
    {sources : (n : Nat) → Source (states n + 1) (Actor (components n) × Fin (events n))}
    (family : GraphFamily sources) (n : Nat)
    (before : GraphWorld pcs sources n)
    (after : CheckedWorld (states n) (pcs n) (events n) (components n))
    (step : CheckedStep (family.automata n).table before.val after) :
    SourceReachable (sources n) after.val.owner := by
  rcases checked_step_projection (family.automata n).table before.val after step with same | moved
  · change before.val.val.owner = after.val.owner at same
    rw [← same]
    exact before.property
  · obtain ⟨actor, event, member⟩ := moved
    exact .advance before.property ⟨(actor, event),
      (imported_graph_accepts_iff_reachable_source_step (sources n) (family.graphs n)
        (family.automata n) (family.imported n) _ _ _ before.property).mp
        ((generated_dispatch_exact (family.automata n).table (family.automata n).functional _ _).mpr member)⟩

abbrev GraphEvolution {states events components pcs : Nat → Nat}
    {sources : (n : Nat) → Source (states n + 1) (Actor (components n) × Fin (events n))}
    (family : GraphFamily sources)
    (previous : (n : Nat) → Fin (states (n + 1) + 1) → Fin (states n + 1))
    (approved : Nat → Prop) :=
  EvolutionStep (C := GraphWorld pcs sources) (graphLocalStep family)
    (sourceStep sources) graphProject previous approved

theorem every_checked_runtime_or_edit_step_is_admitted
    {states events components pcs : Nat → Nat}
    {sources : (n : Nat) → Source (states n + 1) (Actor (components n) × Fin (events n))}
    (family : GraphFamily sources)
    (previous : (n : Nat) → Fin (states (n + 1) + 1) → Fin (states n + 1))
    (approved : Nat → Prop) (n : Nat) (before : GraphWorld pcs sources n)
    (after : CheckedWorld (states n) (pcs n) (events n) (components n))
    (step : CheckedStep (family.automata n).table before.val after) :
    ∃ admitted : GraphWorld pcs sources n, admitted.val = after ∧
      GraphEvolution family previous approved ⟨n, before⟩ ⟨n, admitted⟩ := by
  refine ⟨⟨after, checked_step_preserves_graph_domain family n before after step⟩, rfl, ?_⟩
  exact .execute n before _ step

theorem checked_migration_is_admitted
    {states events components pcs : Nat → Nat}
    {sources : (n : Nat) → Source (states n + 1) (Actor (components n) × Fin (events n))}
    (family : GraphFamily sources)
    (previous : (n : Nat) → Fin (states (n + 1) + 1) → Fin (states n + 1))
    (approved : Nat → Prop) (n : Nat) (before : GraphWorld pcs sources n)
    (after : CheckedWorld (states (n + 1)) (pcs (n + 1)) (events (n + 1)) (components (n + 1)))
    (permission : approved n)
    (refinement : AdjacentRefines (sourceStep sources) previous n)
    (checked : checkMigration (family.graphs (n + 1)) (previous n)
      before.val.val.owner after.val.owner = true) :
    ∃ admitted : GraphWorld pcs sources (n + 1), admitted.val = after ∧
      GraphEvolution family previous approved ⟨n, before⟩ ⟨n + 1, admitted⟩ := by
  have facts := (migration_check_exact (sources (n + 1)) (family.graphs (n + 1))
    (family.automata (n + 1)) (family.imported (n + 1)) (previous n)
    before.val.val.owner after.val.owner).mp checked
  refine ⟨⟨after, facts.2⟩, rfl, ?_⟩
  exact .revise n before _ permission refinement facts.1

theorem graph_development_preserves_source_reachability
    {states events components pcs : Nat → Nat}
    {sources : (n : Nat) → Source (states n + 1) (Actor (components n) × Fin (events n))}
    (family : GraphFamily sources)
    (previous : (n : Nat) → Fin (states (n + 1) + 1) → Fin (states n + 1))
    (approved : Nat → Prop) {world : Versioned (GraphWorld pcs sources)}
    (history : Reach (RootInitial graphProject (fun state => state = (sources 0).initial))
      (GraphEvolution family previous approved) world) :
    ApprovedChain (sourceStep sources) previous approved world.1 ∧
      SourceReachable (sources 0) (projectedRoot graphProject previous world) := by
  exact arbitrary_development_composes_refinements (graphLocalStep family) (sourceStep sources)
    graphProject previous approved (fun state => state = (sources 0).initial)
    (graph_local_step_refines_source family) history

theorem graph_development_preserves_validated_root
    {states events components pcs : Nat → Nat}
    {sources : (n : Nat) → Source (states n + 1) (Actor (components n) × Fin (events n))}
    (family : GraphFamily sources)
    (previous : (n : Nat) → Fin (states (n + 1) + 1) → Fin (states n + 1))
    (approved : Nat → Prop) (invariant : Fin (states 0 + 1) → Bool)
    (validated : validateModel (sources 0) invariant = true)
    {world : Versioned (GraphWorld pcs sources)}
    (history : Reach (RootInitial graphProject (fun state => state = (sources 0).initial))
      (GraphEvolution family previous approved) world) :
    invariant (projectedRoot graphProject previous world) = true := by
  exact ((model_validation_iff_supported_deterministic_source_safety (sources 0) invariant).mp
    validated).2.2 _ (graph_development_preserves_source_reachability family previous approved history).2

/- A representation map can commute while sending the new live owner outside
   the imported graph's domain. Exact source behavior is then no longer assured.
-/
theorem commuting_alone_does_not_admit_live_migration :
    (fun _ : Fin 2 => (0 : Fin 2)) 1 = 0 ∧
    checkMigration reachableOnlyGraph (fun _ => (0 : Fin 2)) 0 1 = false ∧
    evalDispatch (compileTable reachableOnlyGraph.table) ((1 : Fin 2), ()) = none ∧
    SourceStep unreachableRuleSource 1 () 1 := by
  exact ⟨rfl, by decide, by decide, reachable_only_is_not_all_states_equality.2.2⟩

theorem valid_live_migration_is_not_vacuous :
    checkMigration reachableOnlyGraph (fun state => state) 0 0 = true := by decide

/- A successful revision followed by actual generated dispatch. State 2 and
   its self-edge are absent from the graph, so this is not full-domain copying.
-/
def witnessSource : Source 3 (Actor 0 × Fin 1) :=
  ⟨0, [⟨(.environment, 0), .stateIs 0, .set 1⟩,
       ⟨(.environment, 0), .stateIs 2, .keep⟩]⟩
def witnessGraph : ExactGraph (Fin 3) (Actor 0 × Fin 1) :=
  ⟨0, [0, 1], [((0, (.environment, 0)), 1)], [[], [((.environment, 0), 1)]]⟩
def witnessAutomaton : TypedAutomaton (Fin 3) (Actor 0 × Fin 1) :=
  ⟨0, witnessGraph.table, (functional_check_exact _).mp (by decide)⟩
def witnessFamily : GraphFamily (fun _ => witnessSource) :=
  ⟨fun _ => witnessGraph, fun _ => witnessAutomaton, fun _ => by rfl⟩
def witnessWorld : CheckedWorld 2 0 1 0 :=
  ⟨⟨0, fun _ => .ts ⟨[], fun _ => .send .authority 0 0 0⟩, fun _ => 0⟩,
    (world_check_exact _).mp (by decide)⟩
def witnessStart (n : Nat) : GraphWorld (fun _ => 0) (fun _ => witnessSource) n :=
  ⟨witnessWorld, .start rfl⟩
def witnessFinish : CheckedWorld 2 0 1 0 :=
  checkedRun witnessAutomaton.table witnessWorld .environment

theorem reachable_graph_revision_then_dispatch_executes :
    ∃ final : GraphWorld (fun _ => 0) (fun _ => witnessSource) 1,
      Reach (RootInitial graphProject (fun state => state = witnessSource.initial))
        (GraphEvolution witnessFamily (fun _ state => state) (fun _ => True)) ⟨1, final⟩ ∧
      final.val.val.owner = 1 := by
  have initial : Reach (RootInitial graphProject (fun state => state = witnessSource.initial))
      (GraphEvolution witnessFamily (fun _ state => state) (fun _ => True))
      ⟨0, witnessStart 0⟩ := .start rfl
  have revised : GraphEvolution witnessFamily (fun _ state => state) (fun _ => True)
      ⟨0, witnessStart 0⟩ ⟨1, witnessStart 1⟩ :=
    .revise 0 _ _ True.intro (fun _ _ edge => Or.inr edge) rfl
  obtain ⟨final, same, ran⟩ := every_checked_runtime_or_edit_step_is_admitted witnessFamily
    (fun _ state => state) (fun _ => True) 1 (witnessStart 1) witnessFinish
    (checked_run_is_actual_raw_step witnessAutomaton.table witnessWorld .environment)
  refine ⟨final, .advance (.advance initial revised) ran, ?_⟩
  rw [same]
  rfl

end SGDGraphDevelopment

#print axioms SGDGraphDevelopment.imported_nodes_exact_source_domain
#print axioms SGDGraphDevelopment.migration_check_exact
#print axioms SGDGraphDevelopment.graph_local_step_refines_source
#print axioms SGDGraphDevelopment.checked_step_preserves_graph_domain
#print axioms SGDGraphDevelopment.every_checked_runtime_or_edit_step_is_admitted
#print axioms SGDGraphDevelopment.checked_migration_is_admitted
#print axioms SGDGraphDevelopment.graph_development_preserves_source_reachability
#print axioms SGDGraphDevelopment.graph_development_preserves_validated_root
#print axioms SGDGraphDevelopment.commuting_alone_does_not_admit_live_migration
#print axioms SGDGraphDevelopment.valid_live_migration_is_not_vacuous
#print axioms SGDGraphDevelopment.reachable_graph_revision_then_dispatch_executes
