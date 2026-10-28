import MixedProfiles
import GraphDevelopment

/- Reachable-graph development for the mixed finite languages. Lowering keeps
   the actual mixed bodies and scheduler steps; it does not replace execution
   with an assumed safe relation. New live states must enter the new source's
   reachable domain, in addition to commuting with the previous live meaning.
   Adjacent refinement remains a full-source obligation. No native-language
   parsing, FFI, heap, concurrency or persistence theorem is claimed.
-/
namespace SGDMixedGraphDevelopment
open SGDMethod SGDCompilerPipeline SGDModelValidation SGDDevelopmentRefinement
open SGDProfileComposition SGDGraphDevelopment

def lowerChecked {states pcs events components : Nat}
    (world : SGDMixedProfiles.CheckedWorld states pcs events components) :
    SGDProfileComposition.CheckedWorld states pcs events components :=
  ⟨SGDMixedProfiles.lowerWorld world.val,
    (SGDMixedProfiles.lower_world_admission_exact world.val).mpr world.property⟩

abbrev World {states events components : Nat → Nat} (pcs : Nat → Nat)
    (sources : (n : Nat) → Source (states n + 1) (Actor (components n) × Fin (events n))) (n : Nat) :=
  { world : SGDMixedProfiles.CheckedWorld (states n) (pcs n) (events n) (components n) //
    SourceReachable (sources n) world.val.owner }

def lower {states events components pcs : Nat → Nat}
    {sources : (n : Nat) → Source (states n + 1) (Actor (components n) × Fin (events n))}
    (n : Nat) (world : World pcs sources n) : GraphWorld pcs sources n :=
  ⟨lowerChecked world.val, world.property⟩

def project {states events components pcs : Nat → Nat}
    {sources : (n : Nat) → Source (states n + 1) (Actor (components n) × Fin (events n))}
    (n : Nat) (world : World pcs sources n) : Fin (states n + 1) := world.val.val.owner

def LocalStep {states events components pcs : Nat → Nat}
    {sources : (n : Nat) → Source (states n + 1) (Actor (components n) × Fin (events n))}
    (family : GraphFamily sources) (n : Nat) (before after : World pcs sources n) : Prop :=
  SGDMixedProfiles.CheckedStep (family.automata n).table before.val after.val

theorem lower_local_step {states events components pcs : Nat → Nat}
    {sources : (n : Nat) → Source (states n + 1) (Actor (components n) × Fin (events n))}
    (family : GraphFamily sources) (n : Nat) (before after : World pcs sources n)
    (step : LocalStep family n before after) :
    graphLocalStep family n (lower n before) (lower n after) :=
  SGDMixedProfiles.lower_raw_step step

theorem runtime_and_edit_preserve_live_domain {states events components pcs : Nat → Nat}
    {sources : (n : Nat) → Source (states n + 1) (Actor (components n) × Fin (events n))}
    (family : GraphFamily sources) (n : Nat) (before : World pcs sources n)
    (after : SGDMixedProfiles.CheckedWorld (states n) (pcs n) (events n) (components n))
    (step : SGDMixedProfiles.CheckedStep (family.automata n).table before.val after) :
    SourceReachable (sources n) after.val.owner :=
  checked_step_preserves_graph_domain family n (lower n before) (lowerChecked after)
    (SGDMixedProfiles.lower_raw_step step)

abbrev Evolution {states events components pcs : Nat → Nat}
    {sources : (n : Nat) → Source (states n + 1) (Actor (components n) × Fin (events n))}
    (family : GraphFamily sources)
    (previous : (n : Nat) → Fin (states (n + 1) + 1) → Fin (states n + 1))
    (approved : Nat → Prop) :=
  EvolutionStep (C := World pcs sources) (LocalStep family)
    (sourceStep sources) project previous approved

theorem actual_runtime_or_edit_step_is_admitted
    {states events components pcs : Nat → Nat}
    {sources : (n : Nat) → Source (states n + 1) (Actor (components n) × Fin (events n))}
    (family : GraphFamily sources)
    (previous : (n : Nat) → Fin (states (n + 1) + 1) → Fin (states n + 1))
    (approved : Nat → Prop) (n : Nat) (before : World pcs sources n)
    (after : SGDMixedProfiles.CheckedWorld (states n) (pcs n) (events n) (components n))
    (step : SGDMixedProfiles.CheckedStep (family.automata n).table before.val after) :
    ∃ admitted : World pcs sources n, admitted.val = after ∧
      Evolution family previous approved ⟨n, before⟩ ⟨n, admitted⟩ := by
  refine ⟨⟨after, runtime_and_edit_preserve_live_domain family n before after step⟩, rfl, ?_⟩
  exact .execute n before _ step

theorem executable_migration_check_constructs_revision
    {states events components pcs : Nat → Nat}
    {sources : (n : Nat) → Source (states n + 1) (Actor (components n) × Fin (events n))}
    (family : GraphFamily sources)
    (previous : (n : Nat) → Fin (states (n + 1) + 1) → Fin (states n + 1))
    (approved : Nat → Prop) (n : Nat) (before : World pcs sources n)
    (after : SGDMixedProfiles.CheckedWorld (states (n + 1)) (pcs (n + 1))
      (events (n + 1)) (components (n + 1)))
    (permission : approved n)
    (refinement : AdjacentRefines (sourceStep sources) previous n)
    (checked : checkMigration (family.graphs (n + 1)) (previous n)
      before.val.val.owner after.val.owner = true) :
    ∃ admitted : World pcs sources (n + 1), admitted.val = after ∧
      Evolution family previous approved ⟨n, before⟩ ⟨n + 1, admitted⟩ := by
  have facts := (migration_check_exact (sources (n + 1)) (family.graphs (n + 1))
    (family.automata (n + 1)) (family.imported (n + 1)) (previous n)
    before.val.val.owner after.val.owner).mp checked
  refine ⟨⟨after, facts.2⟩, rfl, ?_⟩
  exact .revise n before _ permission refinement facts.1

theorem lower_evolution_step {states events components pcs : Nat → Nat}
    {sources : (n : Nat) → Source (states n + 1) (Actor (components n) × Fin (events n))}
    (family : GraphFamily sources)
    (previous : (n : Nat) → Fin (states (n + 1) + 1) → Fin (states n + 1))
    (approved : Nat → Prop) {before after : Versioned (World pcs sources)}
    (step : Evolution family previous approved before after) :
    GraphEvolution family previous approved ⟨before.1, lower before.1 before.2⟩
      ⟨after.1, lower after.1 after.2⟩ := by
  cases step with
  | execute n before after step =>
      exact .execute n _ _ (lower_local_step family n before after step)
  | revise n before after permission refinement migration =>
      exact .revise n _ _ permission refinement migration

theorem lower_development_history {states events components pcs : Nat → Nat}
    {sources : (n : Nat) → Source (states n + 1) (Actor (components n) × Fin (events n))}
    (family : GraphFamily sources)
    (previous : (n : Nat) → Fin (states (n + 1) + 1) → Fin (states n + 1))
    (approved : Nat → Prop) {world : Versioned (World pcs sources)}
    (history : Reach (RootInitial project (fun state => state = (sources 0).initial))
      (Evolution family previous approved) world) :
    Reach (RootInitial graphProject (fun state => state = (sources 0).initial))
      (GraphEvolution family previous approved) ⟨world.1, lower world.1 world.2⟩ := by
  induction history with
  | @start world initial =>
      rcases world with ⟨n, world⟩
      cases n with
      | zero => exact .start initial
      | succ n => exact False.elim initial
  | advance history step ih =>
      exact .advance ih (lower_evolution_step family previous approved step)

theorem source_bound_mixed_graph_development_preserves_root
    {states events components pcs : Nat → Nat}
    {sources : (n : Nat) → Source (states n + 1) (Actor (components n) × Fin (events n))}
    (family : GraphFamily sources)
    (previous : (n : Nat) → Fin (states (n + 1) + 1) → Fin (states n + 1))
    (approved : Nat → Prop) (invariant : Fin (states 0 + 1) → Bool)
    (validated : validateModel (sources 0) invariant = true)
    {world : Versioned (World pcs sources)}
    (history : Reach (RootInitial project (fun state => state = (sources 0).initial))
      (Evolution family previous approved) world) :
    invariant (projectedRoot project previous world) = true :=
  graph_development_preserves_validated_root family previous approved invariant validated
    (lower_development_history family previous approved history)

/- A real Rust transition, an approved live migration to a TypeScript body,
   and a refused TypeScript call occur in one history. The graph still omits
   the source's unreachable state 2 and its self-edge.
-/
def rustStart : SGDMixedProfiles.CheckedWorld 2 0 1 0 :=
  ⟨⟨0, fun _ => .rust ⟨7, fun _ => .withOwnerMut (.reborrow (.root 7)) 0 0 0⟩,
    fun _ => 0⟩, by intro actor pc; rfl⟩
def mixedStart : World (fun _ => 0) (fun _ => witnessSource) 0 :=
  ⟨rustStart, .start rfl⟩
def rustDone : SGDMixedProfiles.CheckedWorld 2 0 1 0 :=
  ⟨SGDMixedProfiles.runWorld witnessAutomaton.table rustStart.val .environment,
    rustStart.property⟩
def tsMigrated : SGDMixedProfiles.CheckedWorld 2 0 1 0 :=
  ⟨⟨1, fun _ => .ts ⟨[], fun _ => .send .authority 0 0 0⟩, fun _ => 0⟩,
    (SGDMixedProfiles.lower_world_admission_exact _).mp ((world_check_exact _).mp (by decide))⟩
def tsDone : SGDMixedProfiles.CheckedWorld 2 0 1 0 :=
  ⟨SGDMixedProfiles.runWorld witnessAutomaton.table tsMigrated.val .environment,
    tsMigrated.property⟩

theorem rust_progress_migration_and_typescript_refusal_are_one_history :
    ∃ final : World (fun _ => 0) (fun _ => witnessSource) 1,
      Reach (RootInitial project (fun state => state = witnessSource.initial))
        (Evolution witnessFamily (fun _ state => state) (fun _ => True)) ⟨1, final⟩ ∧
      final.val.val.owner = 1 ∧
      (SGDMixedProfiles.runBody witnessAutomaton.table .environment
        (tsMigrated.val.code .environment) ⟨1, 0⟩).1 = .rejected 0 := by
  have initial : Reach (RootInitial project (fun state => state = witnessSource.initial))
      (Evolution witnessFamily (fun _ state => state) (fun _ => True))
      ⟨0, mixedStart⟩ := .start rfl
  obtain ⟨ran, ranValue, runStep⟩ := actual_runtime_or_edit_step_is_admitted witnessFamily
    (fun _ state => state) (fun _ => True) 0 mixedStart rustDone
    (SGDMixedProfiles.RawStep.run rustStart.val .environment)
  have migrationChecked : checkMigration (witnessFamily.graphs 1) (fun state => state)
      ran.val.val.owner tsMigrated.val.owner = true := by
    rw [ranValue]
    decide
  obtain ⟨migrated, migratedValue, revision⟩ := executable_migration_check_constructs_revision
    witnessFamily (fun _ state => state) (fun _ => True) 0 ran tsMigrated True.intro
    (fun _ _ edge => Or.inr edge) migrationChecked
  have rawFinal : SGDMixedProfiles.CheckedStep witnessAutomaton.table migrated.val tsDone := by
    rw [migratedValue]
    exact SGDMixedProfiles.RawStep.run tsMigrated.val .environment
  obtain ⟨final, finalValue, refused⟩ := actual_runtime_or_edit_step_is_admitted witnessFamily
    (fun _ state => state) (fun _ => True) 1 migrated tsDone rawFinal
  refine ⟨final, .advance (.advance (.advance initial runStep) revision) refused, ?_, rfl⟩
  rw [finalValue]
  rfl

end SGDMixedGraphDevelopment

#print axioms SGDMixedGraphDevelopment.lower_local_step
#print axioms SGDMixedGraphDevelopment.runtime_and_edit_preserve_live_domain
#print axioms SGDMixedGraphDevelopment.actual_runtime_or_edit_step_is_admitted
#print axioms SGDMixedGraphDevelopment.executable_migration_check_constructs_revision
#print axioms SGDMixedGraphDevelopment.lower_evolution_step
#print axioms SGDMixedGraphDevelopment.lower_development_history
#print axioms SGDMixedGraphDevelopment.source_bound_mixed_graph_development_preserves_root
#print axioms SGDMixedGraphDevelopment.rust_progress_migration_and_typescript_refusal_are_one_history
