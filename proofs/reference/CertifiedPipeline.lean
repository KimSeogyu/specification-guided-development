import ModelValidation
import ProfileComposition

/- Static SOURCE-BOUND reference pipeline, not a product API or runtime audit.
   Each epoch's authority table must be the actual successful compiler output
   for its declared source. Root safety comes from the executable finite model
   validation theorem, not an assumed global invariant or arbitrary safe table.

   This module uses FULL-DOMAIN direct compilation. Reachable-only imported
   graphs need an additional new-live-domain migration obligation; root-view
   commuting alone does not supply it. That companion boundary is separate.

   Proof fields and Reach are logical derivations, not stored runtime receipts.
   The source/invariant and independently intended world requirement are fixed
   outside candidate execution. Native parsers, native schedulers, I/O and full
   native TypeScript semantics are not claimed by these closed CFG profiles.
-/
namespace SGDCertifiedPipeline
open SGDMethod SGDCompilerPipeline SGDModelValidation
open SGDDevelopmentRefinement SGDProfileComposition

structure CertifiedSourceFamily {states events components : Nat → Nat}
    (sources : (n : Nat) → Source (states n + 1) (Actor (components n) × Fin (events n)))
    (rootInvariant : Fin (states 0 + 1) → Bool) where
  automata : (n : Nat) → TypedAutomaton (Fin (states n + 1)) (Actor (components n) × Fin (events n))
  compiled : ∀ n, compileSource (sources n) = .ok (automata n)
  modelValidated : validateModel (sources 0) rootInvariant = true

def familyTables {states events components : Nat → Nat}
    {sources : (n : Nat) → Source (states n + 1) (Actor (components n) × Fin (events n))}
    {rootInvariant : Fin (states 0 + 1) → Bool}
    (family : CertifiedSourceFamily sources rootInvariant) :
    (n : Nat) → GlobalTable (states n) (events n) (components n) :=
  fun n => (family.automata n).table

theorem family_tables_are_exact_source_extractions {states events components : Nat → Nat}
    {sources : (n : Nat) → Source (states n + 1) (Actor (components n) × Fin (events n))}
    {rootInvariant : Fin (states 0 + 1) → Bool}
    (family : CertifiedSourceFamily sources rootInvariant) (n : Nat) :
    familyTables family n = extract (sources n) ∧
      (family.automata n).initial = (sources n).initial := by
  have shape := compile_success_shape (sources n) (family.automata n) (family.compiled n)
  exact ⟨shape.2.2, shape.2.1⟩

theorem source_bound_actor_acceptance_exact {states events components : Nat → Nat}
    {sources : (n : Nat) → Source (states n + 1) (Actor (components n) × Fin (events n))}
    {rootInvariant : Fin (states 0 + 1) → Bool}
    (family : CertifiedSourceFamily sources rootInvariant) (n : Nat)
    (actor : Actor (components n)) (before after : Fin (states n + 1)) (event : Fin (events n)) :
    evalDispatch (compileTable (specialize (familyTables family n) actor)) (before, event) = some after ↔
      SourceStep (sources n) before (actor, event) after := by
  have functional : Functional (specialize (familyTables family n) actor) :=
    specialization_is_functional (familyTables family n) (family.automata n).functional actor
  rw [generated_dispatch_exact (specialize (familyTables family n) actor) functional]
  rw [specialized_membership_exact]
  rw [(family_tables_are_exact_source_extractions family n).1]
  exact extracted_edges_exact (sources n) before (actor, event) after

theorem source_bound_actor_rejection_exact {states events components : Nat → Nat}
    {sources : (n : Nat) → Source (states n + 1) (Actor (components n) × Fin (events n))}
    {rootInvariant : Fin (states 0 + 1) → Bool}
    (family : CertifiedSourceFamily sources rootInvariant) (n : Nat)
    (actor : Actor (components n)) (before : Fin (states n + 1)) (event : Fin (events n)) :
    evalDispatch (compileTable (specialize (familyTables family n) actor)) (before, event) = none ↔
      ¬ ∃ after, SourceStep (sources n) before (actor, event) after := by
  rw [generated_rejection_exact]
  simp only [specialized_membership_exact, (family_tables_are_exact_source_extractions family n).1,
    extracted_edges_exact]

/- The inductive certificate is reachability AND the intended invariant. This
   stronger predicate is not falsely equated with the invariant on all states.
-/
def RootPredicate {states events components : Nat → Nat}
    {sources : (n : Nat) → Source (states n + 1) (Actor (components n) × Fin (events n))}
    {rootInvariant : Fin (states 0 + 1) → Bool}
    (family : CertifiedSourceFamily sources rootInvariant) (state : Fin (states 0 + 1)) : Prop :=
  Reach (fun initial => initial = (family.automata 0).initial)
    (TableStep (familyTables family 0)) state ∧ rootInvariant state = true

theorem root_predicate_iff_source_strengthening {states events components : Nat → Nat}
    {sources : (n : Nat) → Source (states n + 1) (Actor (components n) × Fin (events n))}
    {rootInvariant : Fin (states 0 + 1) → Bool}
    (family : CertifiedSourceFamily sources rootInvariant) (state : Fin (states 0 + 1)) :
    RootPredicate family state ↔ ReachableInvariant (sources 0) rootInvariant state := by
  exact and_congr
    (compiled_source_reachability_exact (sources 0) (family.automata 0) (family.compiled 0) state) Iff.rfl

theorem certified_root_initial {states events components : Nat → Nat}
    {sources : (n : Nat) → Source (states n + 1) (Actor (components n) × Fin (events n))}
    {rootInvariant : Fin (states 0 + 1) → Bool}
    (family : CertifiedSourceFamily sources rootInvariant) :
    RootPredicate family (sources 0).initial :=
  (root_predicate_iff_source_strengthening family _).mpr
    (validated_model_initial_is_inductive (sources 0) rootInvariant family.modelValidated)

theorem certified_root_edge_preserves_strengthening {states events components : Nat → Nat}
    {sources : (n : Nat) → Source (states n + 1) (Actor (components n) × Fin (events n))}
    {rootInvariant : Fin (states 0 + 1) → Bool}
    (family : CertifiedSourceFamily sources rootInvariant)
    (before : Fin (states 0 + 1)) (actor : Actor (components 0))
    (event : Fin (events 0)) (after : Fin (states 0 + 1))
    (admitted : RootPredicate family before)
    (edge : ((before, (actor, event)), after) ∈ familyTables family 0) :
    RootPredicate family after := by
  have sourceBefore := (root_predicate_iff_source_strengthening family before).mp admitted
  rw [(family_tables_are_exact_source_extractions family 0).1] at edge
  have sourceAfter := validated_model_source_edge_preserves_strengthening
    (sources 0) rootInvariant family.modelValidated before (actor, event) after sourceBefore
    ((extracted_edges_exact (sources 0) before (actor, event) after).mp edge)
  exact (root_predicate_iff_source_strengthening family after).mpr sourceAfter

/- Actual ProfileEvolution contains actor-bound TypeScript-profile CFG steps,
   checked body edits, semantic adjacent refinement, and live migration
   commuting. It does not turn an arbitrary table or approval flag into policy.
-/
def CertifiedEvolution {states pcs events components : Nat → Nat}
    {sources : (n : Nat) → Source (states n + 1) (Actor (components n) × Fin (events n))}
    {rootInvariant : Fin (states 0 + 1) → Bool}
    (family : CertifiedSourceFamily sources rootInvariant)
    (previous : (n : Nat) → Fin (states (n + 1) + 1) → Fin (states n + 1))
    (approved : Nat → Prop) :
    Versioned (ProfileStates states pcs events components) →
      Versioned (ProfileStates states pcs events components) → Prop :=
  ProfileEvolution (familyTables family) previous approved

theorem certified_profile_development_retains_inductive_root
    {states pcs events components : Nat → Nat}
    {sources : (n : Nat) → Source (states n + 1) (Actor (components n) × Fin (events n))}
    {rootInvariant : Fin (states 0 + 1) → Bool}
    (family : CertifiedSourceFamily sources rootInvariant)
    (previous : (n : Nat) → Fin (states (n + 1) + 1) → Fin (states n + 1))
    (approved : Nat → Prop)
    {world : Versioned (ProfileStates states pcs events components)}
    (history : Reach (RootInitial profileProject (fun state => state = (sources 0).initial))
      (CertifiedEvolution family previous approved) world) :
    RootPredicate family (projectedRoot profileProject previous world) := by
  apply profile_evolution_preserves_root_safety (familyTables family) previous approved
    (fun state => state = (sources 0).initial) (RootPredicate family) ?_
    (certified_root_edge_preserves_strengthening family) history
  intro state initial
  subst state
  exact certified_root_initial family

theorem certified_profile_development_preserves_root_invariant
    {states pcs events components : Nat → Nat}
    {sources : (n : Nat) → Source (states n + 1) (Actor (components n) × Fin (events n))}
    {rootInvariant : Fin (states 0 + 1) → Bool}
    (family : CertifiedSourceFamily sources rootInvariant)
    (previous : (n : Nat) → Fin (states (n + 1) + 1) → Fin (states n + 1))
    (approved : Nat → Prop)
    {world : Versioned (ProfileStates states pcs events components)}
    (history : Reach (RootInitial profileProject (fun state => state = (sources 0).initial))
      (CertifiedEvolution family previous approved) world) :
    rootInvariant (projectedRoot profileProject previous world) = true :=
  (certified_profile_development_retains_inductive_root family previous approved history).2

/- Independently fixed actual-world meaning is an implication from the derived
   inductive certificate, NOT a false global equivalence inv ↔ reachable∧inv.
   If a relevant PC, alias, identity or effect is missing from that meaning,
   the certificate cannot be presented as proof of that omitted requirement.
-/
theorem certified_profile_development_preserves_intended_world_requirement
    {states pcs events components : Nat → Nat}
    {sources : (n : Nat) → Source (states n + 1) (Actor (components n) × Fin (events n))}
    {rootInvariant : Fin (states 0 + 1) → Bool}
    (family : CertifiedSourceFamily sources rootInvariant)
    (previous : (n : Nat) → Fin (states (n + 1) + 1) → Fin (states n + 1))
    (approved : Nat → Prop)
    (required : (n : Nat) → World (states n) (pcs n) (events n) (components n) → Prop)
    (meaning : ∀ n (world : World (states n) (pcs n) (events n) (components n)),
      RootPredicate family (rootView (S := fun k => Fin (states k + 1)) previous n world.owner) →
        required n world)
    {world : Versioned (ProfileStates states pcs events components)}
    (history : Reach (RootInitial profileProject (fun state => state = (sources 0).initial))
      (CertifiedEvolution family previous approved) world) :
    required world.1 world.2.val :=
  meaning world.1 world.2.val
    (certified_profile_development_retains_inductive_root family previous approved history)

end SGDCertifiedPipeline

#print axioms SGDCertifiedPipeline.family_tables_are_exact_source_extractions
#print axioms SGDCertifiedPipeline.source_bound_actor_acceptance_exact
#print axioms SGDCertifiedPipeline.source_bound_actor_rejection_exact
#print axioms SGDCertifiedPipeline.root_predicate_iff_source_strengthening
#print axioms SGDCertifiedPipeline.certified_root_initial
#print axioms SGDCertifiedPipeline.certified_root_edge_preserves_strengthening
#print axioms SGDCertifiedPipeline.certified_profile_development_retains_inductive_root
#print axioms SGDCertifiedPipeline.certified_profile_development_preserves_root_invariant
#print axioms SGDCertifiedPipeline.certified_profile_development_preserves_intended_world_requirement
