import DevelopmentRefinement

/- A static proof boundary for the reference methodology, not a product API.
   Requirements are parameters fixed independently of candidate tables/views.
   Proof terms are logical evidence; no runtime log or mutable approval receipt
   is part of the modeled machine. The raw evolution relation remains useful
   for counterexamples outside this verified-family boundary. -/
namespace SGDAdmittedDevelopment
open SGDMethod SGDDevelopmentRefinement

structure VerifiedFamily {S E D I : Nat → Type}
    (tables : (n : Nat) → SGDWholeProgram.AuthorityTable (S n) (E n) (I n))
    (previous : (n : Nat) → S (n + 1) → S n)
    (initial rootSafe : S 0 → Prop)
    (required : (n : Nat) → WholeStates S E D I n → Prop) : Prop where
  functional : ∀ n, Functional (tables n)
  initialSafe : ∀ state, initial state → rootSafe state
  rootEdgesSafe : ∀ before actor event after, rootSafe before →
    ((before, (actor, event)), after) ∈ tables 0 → rootSafe after
  faithfulMeaning : ∀ n world,
    required n world ↔ rootSafe (rootView previous n world.owned)

/- Constructing this relation requires a verified family. Its steps retain
   the local edge-refinement and live-migration obligations of WholeEvolution.
   The family also supplies functionality for exact acceptance completeness;
   the state-safety proof itself does not need determinism. -/
def AdmittedEvolution {S E D I : Nat → Type}
    [∀ n, DecidableEq (S n)] [∀ n, DecidableEq (E n)] [∀ n, DecidableEq (I n)]
    {tables : (n : Nat) → SGDWholeProgram.AuthorityTable (S n) (E n) (I n)}
    {previous : (n : Nat) → S (n + 1) → S n}
    {initial rootSafe : S 0 → Prop}
    {required : (n : Nat) → WholeStates S E D I n → Prop}
    (_verified : VerifiedFamily tables previous initial rootSafe required)
    (approved : Nat → Prop) :
    Versioned (WholeStates S E D I) → Versioned (WholeStates S E D I) → Prop :=
  WholeEvolution tables previous approved

theorem admitted_development_preserves_whole_requirement
    {S E D I : Nat → Type}
    [∀ n, DecidableEq (S n)] [∀ n, DecidableEq (E n)] [∀ n, DecidableEq (I n)]
    {tables : (n : Nat) → SGDWholeProgram.AuthorityTable (S n) (E n) (I n)}
    {previous : (n : Nat) → S (n + 1) → S n}
    {initial rootSafe : S 0 → Prop}
    {required : (n : Nat) → WholeStates S E D I n → Prop}
    (verified : VerifiedFamily tables previous initial rootSafe required)
    (approved : Nat → Prop)
    {world : Versioned (WholeStates S E D I)}
    (history : Reach (RootInitial wholeProject initial)
      (AdmittedEvolution verified approved) world) : required world.1 world.2 := by
  exact (verified.faithfulMeaning world.1 world.2).mpr
    (whole_program_evolution_preserves_fixed_root_safety tables previous approved
      initial rootSafe verified.initialSafe verified.rootEdgesSafe history)

theorem admitted_epoch_request_is_exact
    {S E D I : Nat → Type}
    [∀ n, DecidableEq (S n)] [∀ n, DecidableEq (E n)] [∀ n, DecidableEq (I n)]
    {tables : (n : Nat) → SGDWholeProgram.AuthorityTable (S n) (E n) (I n)}
    {previous : (n : Nat) → S (n + 1) → S n}
    {initial rootSafe : S 0 → Prop}
    {required : (n : Nat) → WholeStates S E D I n → Prop}
    (verified : VerifiedFamily tables previous initial rootSafe required)
    (n : Nat) (actor : SGDWholeProgram.Actor (I n))
    (choose : S n → D n → E n) (state : S n) (data : D n) (next : S n)
    (allowed : ((state, (actor, choose state data)), next) ∈ tables n) :
    SGDWholeProgram.evalCommand (tables n) actor (.request choose) (state, data) =
      ((next, data), .accepted actor (choose state data)) := by
  exact SGDWholeProgram.enabled_request_executes_exact (tables n) (verified.functional n)
    actor choose state data next allowed

theorem hidden_violation_prevents_family_admission
    {S E D I : Nat → Type}
    (tables : (n : Nat) → SGDWholeProgram.AuthorityTable (S n) (E n) (I n))
    (previous : (n : Nat) → S (n + 1) → S n)
    (initial rootSafe : S 0 → Prop)
    (required : (n : Nat) → WholeStates S E D I n → Prop)
    (hidden : ∃ n world, rootSafe (rootView previous n world.owned) ∧ ¬ required n world) :
    ¬ VerifiedFamily tables previous initial rootSafe required := by
  intro verified
  obtain ⟨n, world, projectedSafe, actualViolation⟩ := hidden
  exact actualViolation ((verified.faithfulMeaning n world).mpr projectedSafe)

theorem representationVerified : VerifiedFamily representationTables representationPrevious
    (fun state => state = 0) (fun state => state ≤ 1) representationWorldRequirement where
  functional := by
    intro n key left right hl hr
    cases n <;>
      simp only [representationTables, List.mem_cons, List.not_mem_nil, or_false] at hl hr <;>
      rcases hl with h | h <;> rcases hr with j | j <;>
      exact (congrArg Prod.snd h).trans (congrArg Prod.snd j).symm
  initialSafe := by
    intro state starts
    subst state
    decide
  rootEdgesSafe := representation_root_edges_preserve
  faithfulMeaning := fun n world => representation_meaning_is_faithful n world.owned

theorem verified_family_allows_migration_and_useful_execution :
    Reach (RootInitial wholeProject (fun state : Representation 0 => state = 0))
      (AdmittedEvolution representationVerified (fun _ => True))
      ⟨1, representationEnvironmentDone⟩ ∧
    representationEnvironmentDone.owned = (1, 7) := by
  exact ⟨revised_representation_executes_components_and_environment.1,
    revised_representation_executes_components_and_environment.2.1⟩

theorem misleading_family_cannot_be_admitted :
    ¬ VerifiedFamily (D := fun _ => Unit) misleadingTables misleadingPrevious
      (fun state => state = false) (fun state => state = false)
      (fun _ world => world.owned = false) := by
  apply hidden_violation_prevents_family_admission
  exact ⟨1, misleadingAfter, rfl, constant_view_hides_a_requirement_violation.2.2⟩

end SGDAdmittedDevelopment

#print axioms SGDAdmittedDevelopment.admitted_development_preserves_whole_requirement
#print axioms SGDAdmittedDevelopment.admitted_epoch_request_is_exact
#print axioms SGDAdmittedDevelopment.hidden_violation_prevents_family_admission
#print axioms SGDAdmittedDevelopment.representationVerified
#print axioms SGDAdmittedDevelopment.verified_family_allows_migration_and_useful_execution
#print axioms SGDAdmittedDevelopment.misleading_family_cannot_be_admitted
