import StructuralLint
import AdmittedDevelopment

/- Formal reference integration only. The source relation is StructuralLint's
   independently executable raw syntax, including rejected writes and resets.
   Lint checks admit source worlds and edits; they do not define raw execution.
   The single evolution relation below includes execution, edits and actual
   live migration. It never reinitializes a later revision from a fresh Init.

   Finite-PC language profiles need their own derived operational lowering.
   This queue-profile theorem does not invent an encoding of cyclic CFGs into
   finite queues. Such profiles can instantiate DevelopmentRefinement's generic
   EvolutionStep with their actual local semantics and proved local projection.
-/
namespace SGDLintedDevelopment
open SGDMethod SGDWholeProgram SGDStructuralLint SGDDevelopmentRefinement SGDAdmittedDevelopment

abbrev RawWorlds (S E D : Nat → Type) (components : Nat → Nat) (n : Nat) :=
  RawGlobal (S n) (E n) (D n) (components n)
abbrev TargetWorlds (S E D : Nat → Type) (components : Nat → Nat) (n : Nat) :=
  Global (S n) (E n) (D n) (Fin (components n))

instance componentIdentityDecidable (components : Nat → Nat) :
    ∀ n, DecidableEq (Fin (components n)) := fun _ => inferInstance

def eraseVersion {S E D : Nat → Type} {components : Nat → Nat} :
    Versioned (RawWorlds S E D components) → Versioned (TargetWorlds S E D components)
  | ⟨n, world⟩ => ⟨n, eraseGlobal world⟩

def RawInitial {S E D : Nat → Type} {components : Nat → Nat}
    [∀ n, DecidableEq (S n)] [∀ n, DecidableEq (E n)]
    (tables : (n : Nat) → AuthorityTable (S n) (E n) (Fin (components n)))
    (initial : S 0 → Prop) : Versioned (RawWorlds S E D components) → Prop
  | ⟨0, world⟩ => initial world.owned ∧ checkGlobal (tables 0) world = true
  | ⟨_ + 1, _⟩ => False

inductive RawAdmittedEvolution {S E D : Nat → Type} {components : Nat → Nat}
    [∀ n, DecidableEq (S n)] [∀ n, DecidableEq (E n)]
    (tables : (n : Nat) → AuthorityTable (S n) (E n) (Fin (components n)))
    (previous : (n : Nat) → S (n + 1) → S n) (approved : Nat → Prop) :
    Versioned (RawWorlds S E D components) → Versioned (RawWorlds S E D components) → Prop
  | execute (n : Nat) (before after : RawWorlds S E D components n)
      (label : Observation (Fin (components n)) (E n))
      (checked : CheckedStep (tables n) label before after) :
      RawAdmittedEvolution tables previous approved ⟨n, before⟩ ⟨n, after⟩
  | revise (n : Nat) (before : RawWorlds S E D components n)
      (after : RawWorlds S E D components (n + 1))
      (beforeChecked : checkGlobal (tables n) before = true)
      (afterChecked : checkGlobal (tables (n + 1)) after = true)
      (permission : approved n)
      (edges : AdjacentRefines (fun k => ModelStep (tables k)) previous n)
      (liveMigration : previous n after.owned = before.owned) :
      RawAdmittedEvolution tables previous approved ⟨n, before⟩ ⟨n + 1, after⟩

theorem every_reachable_raw_world_was_checked
    {S E D : Nat → Type} {components : Nat → Nat}
    [∀ n, DecidableEq (S n)] [∀ n, DecidableEq (E n)]
    (tables : (n : Nat) → AuthorityTable (S n) (E n) (Fin (components n)))
    (previous : (n : Nat) → S (n + 1) → S n) (approved : Nat → Prop)
    (initial : S 0 → Prop) {state : Versioned (RawWorlds S E D components)}
    (history : Reach (RawInitial tables initial)
      (RawAdmittedEvolution tables previous approved) state) :
    checkGlobal (tables state.1) state.2 = true := by
  induction history with
  | @start state begins =>
      rcases state with ⟨n, world⟩
      cases n with
      | zero => exact begins.2
      | succ _ => exact False.elim begins
  | advance previousHistory step ih =>
      cases step with
      | execute n before after label checked => exact checked.2.2
      | revise n before after beforeChecked afterChecked permission edges migration => exact afterChecked

theorem raw_step_erases_to_admitted_evolution
    {S E D : Nat → Type} {components : Nat → Nat}
    [∀ n, DecidableEq (S n)] [∀ n, DecidableEq (E n)]
    {tables : (n : Nat) → AuthorityTable (S n) (E n) (Fin (components n))}
    {previous : (n : Nat) → S (n + 1) → S n}
    {initial rootSafe : S 0 → Prop}
    {required : (n : Nat) → TargetWorlds S E D components n → Prop}
    (verified : VerifiedFamily tables previous initial rootSafe required)
    (approved : Nat → Prop)
    {before after : Versioned (RawWorlds S E D components)}
    (step : RawAdmittedEvolution tables previous approved before after) :
    AdmittedEvolution verified approved (eraseVersion before) (eraseVersion after) := by
  cases step with
  | execute n before after label checked =>
      change WholeEvolution (D := D) tables previous approved
        ⟨n, eraseGlobal before⟩ ⟨n, eraseGlobal after⟩
      apply EvolutionStep.execute
      exact ⟨label, checked_raw_step_maps_to_whole_program checked⟩
  | revise n before after beforeChecked afterChecked permission edges migration =>
      change WholeEvolution (D := D) tables previous approved
        ⟨n, eraseGlobal before⟩ ⟨n + 1, eraseGlobal after⟩
      apply EvolutionStep.revise
      · exact permission
      · exact edges
      · exact migration

theorem one_raw_history_maps_to_verified_development
    {S E D : Nat → Type} {components : Nat → Nat}
    [∀ n, DecidableEq (S n)] [∀ n, DecidableEq (E n)]
    {tables : (n : Nat) → AuthorityTable (S n) (E n) (Fin (components n))}
    {previous : (n : Nat) → S (n + 1) → S n}
    {initial rootSafe : S 0 → Prop}
    {required : (n : Nat) → TargetWorlds S E D components n → Prop}
    (verified : VerifiedFamily tables previous initial rootSafe required)
    (approved : Nat → Prop) {state : Versioned (RawWorlds S E D components)}
    (history : Reach (RawInitial tables initial)
      (RawAdmittedEvolution tables previous approved) state) :
    Reach (RootInitial wholeProject initial)
      (AdmittedEvolution verified approved) (eraseVersion state) := by
  induction history with
  | @start state begins =>
      rcases state with ⟨n, world⟩
      cases n with
      | zero => exact .start begins.1
      | succ _ => exact False.elim begins
  | advance previousHistory step ih =>
      exact .advance ih (raw_step_erases_to_admitted_evolution verified approved step)

theorem linted_raw_development_preserves_required_world
    {S E D : Nat → Type} {components : Nat → Nat}
    [∀ n, DecidableEq (S n)] [∀ n, DecidableEq (E n)]
    {tables : (n : Nat) → AuthorityTable (S n) (E n) (Fin (components n))}
    {previous : (n : Nat) → S (n + 1) → S n}
    {initial rootSafe : S 0 → Prop}
    {required : (n : Nat) → TargetWorlds S E D components n → Prop}
    (verified : VerifiedFamily tables previous initial rootSafe required)
    (approved : Nat → Prop) {state : Versioned (RawWorlds S E D components)}
    (history : Reach (RawInitial tables initial)
      (RawAdmittedEvolution tables previous approved) state) :
    required state.1 (eraseGlobal state.2) := by
  exact admitted_development_preserves_whole_requirement verified approved
    (one_raw_history_maps_to_verified_development verified approved history)

/- A source requirement is independently fixed. Its interpretation is needed
   only on admitted source, because rejected direct writes have no translation.
   This is not a supplied execution-simulation or final-safety premise. -/
theorem linted_raw_development_preserves_source_requirement
    {S E D : Nat → Type} {components : Nat → Nat}
    [∀ n, DecidableEq (S n)] [∀ n, DecidableEq (E n)]
    {tables : (n : Nat) → AuthorityTable (S n) (E n) (Fin (components n))}
    {previous : (n : Nat) → S (n + 1) → S n}
    {initial rootSafe : S 0 → Prop}
    {required : (n : Nat) → TargetWorlds S E D components n → Prop}
    (verified : VerifiedFamily tables previous initial rootSafe required)
    (approved : Nat → Prop)
    (sourceRequirement : (n : Nat) → RawWorlds S E D components n → Prop)
    (meaning : ∀ n world, checkGlobal (tables n) world = true →
      (sourceRequirement n world ↔ required n (eraseGlobal world)))
    {state : Versioned (RawWorlds S E D components)}
    (history : Reach (RawInitial tables initial)
      (RawAdmittedEvolution tables previous approved) state) :
    sourceRequirement state.1 state.2 := by
  have checked := every_reachable_raw_world_was_checked tables previous approved initial history
  exact (meaning state.1 state.2 checked).mpr
    (linted_raw_development_preserves_required_world verified approved history)

theorem each_admitted_raw_step_checks_both_worlds
    {S E D : Nat → Type} {components : Nat → Nat}
    [∀ n, DecidableEq (S n)] [∀ n, DecidableEq (E n)]
    {tables : (n : Nat) → AuthorityTable (S n) (E n) (Fin (components n))}
    {previous : (n : Nat) → S (n + 1) → S n} {approved : Nat → Prop}
    {before after : Versioned (RawWorlds S E D components)}
    (step : RawAdmittedEvolution tables previous approved before after) :
    checkGlobal (tables before.1) before.2 = true ∧
      checkGlobal (tables after.1) after.2 = true := by
  cases step with
  | execute _ _ _ _ checked => exact ⟨checked.1, checked.2.2⟩
  | revise _ _ _ beforeChecked afterChecked _ _ _ => exact ⟨beforeChecked, afterChecked⟩

/- A nontrivial raw-source example. The protected state is (published,
   approved), and unprotected data is a telemetry counter. The policy stays
   identical across this revision; the revised raw source adds environment
   work and must preserve the ACTUAL already-approved live state. -/
def demoTables (_ : Nat) : AuthorityTable (Bool × Bool) Bool (Fin 1) :=
  [(((false, false), (.component 0, false)), (false, true)),
   (((false, true), (.component 0, true)), (true, true))]
def demoPrevious (_ : Nat) (state : Bool × Bool) : Bool × Bool := state
def demoInitial (state : Bool × Bool) : Prop := state = (false, false)
def demoRequired (_ : Nat) (world : Global (Bool × Bool) Bool Nat (Fin 1)) : Prop :=
  ApprovalSafe world.owned

theorem demo_root_view (n : Nat) (state : Bool × Bool) :
    rootView (S := fun _ => Bool × Bool) demoPrevious n state = state := by
  induction n with
  | zero => rfl
  | succ n ih => exact ih

theorem demoVerified : VerifiedFamily demoTables demoPrevious demoInitial ApprovalSafe demoRequired where
  functional := by
    intro n key left right hl hr
    simp [demoTables] at hl hr
    rcases hl with h | h <;> rcases hr with k | k <;> simp_all
  initialSafe := by
    intro state starts
    cases starts
    exact approval_initial_safe
  rootEdgesSafe := by
    intro before actor event after safe edge
    simp [demoTables] at edge
    rcases edge with edge | edge <;> simp_all [ApprovalSafe]
  faithfulMeaning := by
    intro n world
    simp [demoRequired, demo_root_view]

abbrev DemoRaw := RawWorlds (fun _ => Bool × Bool) (fun _ => Bool) (fun _ => Nat) (fun _ => 1)
def demoRequest (event : Bool) : RawCommand (Bool × Bool) Bool Nat (Fin 1) :=
  .request (fun _ _ => event)
def demoWork : RawCommand (Bool × Bool) Bool Nat (Fin 1) :=
  .internal (fun _ count => count + 1)
def demoStart : DemoRaw 0 := ⟨demoTables 0, (false, false), 0, fun _ => [], []⟩
def demoEdited := editRawComponent demoStart 0 [demoRequest false, demoRequest true]
def demoApproved := advanceRawComponent demoEdited 0 (demoRequest false) [demoRequest true]
def demoRevised : DemoRaw 1 := { demoApproved with environment := [demoWork] }
def demoEnvironmentDone := advanceRawEnvironment demoRevised demoWork []
def demoPublished := advanceRawComponent demoEnvironmentDone 0 (demoRequest true) []

abbrev DemoEvolution :=
  RawAdmittedEvolution (D := fun _ => Nat) demoTables demoPrevious (fun _ => True)

theorem raw_edit_execute_revise_execute_witness :
    Reach (RawInitial (D := fun _ => Nat) demoTables demoInitial) DemoEvolution
      ⟨1, demoPublished⟩ ∧
    demoRevised.owned = demoApproved.owned ∧
    demoPublished.owned = (true, true) ∧ demoPublished.data = 1 := by
  have start : Reach (RawInitial (D := fun _ => Nat) demoTables demoInitial) DemoEvolution
      ⟨0, demoStart⟩ := .start ⟨rfl, rfl⟩
  have editStep : DemoEvolution ⟨0, demoStart⟩ ⟨0, demoEdited⟩ := by
    apply RawAdmittedEvolution.execute
    exact ⟨rfl, RawStep.editComponent demoStart 0 [demoRequest false, demoRequest true], rfl⟩
  have approveStep : DemoEvolution ⟨0, demoEdited⟩ ⟨0, demoApproved⟩ := by
    apply RawAdmittedEvolution.execute
    exact ⟨rfl, RawStep.component demoEdited 0 (demoRequest false) [demoRequest true] rfl, rfl⟩
  have reviseStep : DemoEvolution ⟨0, demoApproved⟩ ⟨1, demoRevised⟩ := by
    apply RawAdmittedEvolution.revise
    · rfl
    · rfl
    · trivial
    · intro before after edge
      exact Or.inr edge
    · rfl
  have environmentStep : DemoEvolution ⟨1, demoRevised⟩ ⟨1, demoEnvironmentDone⟩ := by
    apply RawAdmittedEvolution.execute
    exact ⟨rfl, RawStep.environment demoRevised demoWork [] rfl, rfl⟩
  have publishStep : DemoEvolution ⟨1, demoEnvironmentDone⟩ ⟨1, demoPublished⟩ := by
    apply RawAdmittedEvolution.execute
    exact ⟨rfl, RawStep.component demoEnvironmentDone 0 (demoRequest true) [] rfl, rfl⟩
  exact ⟨.advance (.advance (.advance (.advance (.advance start editStep) approveStep)
    reviseStep) environmentStep) publishStep, rfl, rfl, rfl⟩

theorem every_demo_raw_development_preserves_approval
    {state : Versioned DemoRaw}
    (history : Reach (RawInitial (D := fun _ => Nat) demoTables demoInitial) DemoEvolution state) :
    ApprovalSafe state.2.owned :=
  linted_raw_development_preserves_required_world demoVerified (fun _ => True) history

def demoUnsafeEdit : DemoRaw 0 :=
  editRawComponent demoApproved 0 [.directStore (fun owner _ => owner)]

theorem unchecked_raw_replacement_exists_but_is_refused :
    RawStep (.edited (.component 0)) demoApproved demoUnsafeEdit ∧
    ¬ DemoEvolution ⟨0, demoApproved⟩ ⟨0, demoUnsafeEdit⟩ := by
  refine ⟨RawStep.editComponent _ _ _, ?_⟩
  intro step
  have checked := (each_admitted_raw_step_checks_both_worlds step).2
  have refused := (unsafe_edit_is_raw_but_not_admitted (demoTables 0) demoApproved 0).2
  change checkGlobal (demoTables 0)
    (editRawComponent demoApproved 0 [.directStore (fun owner (_ : Nat) => owner)]) = true at checked
  rw [refused] at checked
  cases checked

def demoFreshInitial : DemoRaw 1 := { demoRevised with owned := (false, false) }

theorem fresh_initial_is_checked_but_cannot_replace_live_state :
    checkGlobal (demoTables 1) demoFreshInitial = true ∧
    ¬ DemoEvolution ⟨0, demoApproved⟩ ⟨1, demoFreshInitial⟩ := by
  constructor
  · rfl
  · intro step
    cases step with
    | revise n before after beforeChecked afterChecked permission edges migration =>
        have impossible : (false, false) = (false, true) := migration
        cases impossible

end SGDLintedDevelopment

#print axioms SGDLintedDevelopment.every_reachable_raw_world_was_checked
#print axioms SGDLintedDevelopment.raw_step_erases_to_admitted_evolution
#print axioms SGDLintedDevelopment.one_raw_history_maps_to_verified_development
#print axioms SGDLintedDevelopment.linted_raw_development_preserves_required_world
#print axioms SGDLintedDevelopment.linted_raw_development_preserves_source_requirement
#print axioms SGDLintedDevelopment.each_admitted_raw_step_checks_both_worlds
#print axioms SGDLintedDevelopment.demoVerified
#print axioms SGDLintedDevelopment.raw_edit_execute_revise_execute_witness
#print axioms SGDLintedDevelopment.every_demo_raw_development_preserves_approval
#print axioms SGDLintedDevelopment.unchecked_raw_replacement_exists_but_is_refused
#print axioms SGDLintedDevelopment.fresh_initial_is_checked_but_cannot_replace_live_state
