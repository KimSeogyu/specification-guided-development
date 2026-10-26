import WholeProgram

/- Formal methodology semantics only; no product implementation or native API.

   Each revision may have different protected-state, event, payload and actor
   types. An approved revision supplies a local new-edge refinement proof and
   a separate obligation for the ACTUAL live state migration. New initialization
   alone cannot discharge migration. The root requirement is fixed throughout.

   This file proves state reachability and safety across revisions. Its maps may
   stutter and do not preserve enabledness, event labels, actor identities,
   observable outputs, fairness or liveness across revisions. WholeProgram's
   exact labeled theorem remains available within a fixed revision. The native
   compiler, source coverage, scheduler and real approval identity are unproved.
-/
namespace SGDDevelopmentRefinement
open SGDMethod

/- A local semantic obligation, not a whole-program safety premise. -/
def StepRefines {New Old : Type}
    (newStep : New → New → Prop) (oldStep : Old → Old → Prop)
    (view : New → Old) : Prop :=
  ∀ before after, newStep before after →
    view before = view after ∨ oldStep (view before) (view after)

theorem refinement_maps_compose {A B C : Type}
    (aStep : A → A → Prop) (bStep : B → B → Prop) (cStep : C → C → Prop)
    (toA : B → A) (toB : C → B)
    (ba : StepRefines bStep aStep toA) (cb : StepRefines cStep bStep toB) :
    StepRefines cStep aStep (fun state => toA (toB state)) := by
  intro before after edge
  rcases cb before after edge with same | moved
  · exact Or.inl (congrArg toA same)
  · exact ba _ _ moved

def rootView {S : Nat → Type}
    (previous : (n : Nat) → S (n + 1) → S n) : (n : Nat) → S n → S 0
  | 0, state => state
  | n + 1, state => rootView previous n (previous n state)

abbrev AdjacentRefines {S : Nat → Type}
    (specStep : (n : Nat) → S n → S n → Prop)
    (previous : (n : Nat) → S (n + 1) → S n) (n : Nat) : Prop :=
  StepRefines (specStep (n + 1)) (specStep n) (previous n)

/- Approval is fixed outside candidate execution. This is logical authorization,
   not a theorem about a human reviewer or a GitHub workflow. Certificates are
   collected only as each revision is admitted, not assumed for all future edits.
   ApprovedChain and Reach are mathematical derivations in Prop, not retained
   runtime logs, receipts, or mutable approval flags. Safety comes from the
   semantic edge and live-migration obligations, not the permission predicate.
-/
inductive ApprovedChain {S : Nat → Type}
    (specStep : (n : Nat) → S n → S n → Prop)
    (previous : (n : Nat) → S (n + 1) → S n) (approved : Nat → Prop) : Nat → Prop
  | root : ApprovedChain specStep previous approved 0
  | extend {n : Nat} (earlier : ApprovedChain specStep previous approved n)
      (permission : approved n) (localEdges : AdjacentRefines specStep previous n) :
      ApprovedChain specStep previous approved (n + 1)

theorem approved_chain_composes_to_root {S : Nat → Type}
    {specStep : (n : Nat) → S n → S n → Prop}
    {previous : (n : Nat) → S (n + 1) → S n} {approved : Nat → Prop}
    {n : Nat} (chain : ApprovedChain specStep previous approved n) :
    StepRefines (specStep n) (specStep 0) (rootView previous n) := by
  induction chain with
  | root =>
      intro before after edge
      exact Or.inr edge
  | @extend n earlier permission localEdges ih =>
      exact refinement_maps_compose (specStep 0) (specStep n) (specStep (n + 1))
        (rootView previous n) (previous n) ih localEdges

theorem every_admitted_revision_was_approved {S : Nat → Type}
    {specStep : (n : Nat) → S n → S n → Prop}
    {previous : (n : Nat) → S (n + 1) → S n} {approved : Nat → Prop}
    {n : Nat} (chain : ApprovedChain specStep previous approved n) :
    ∀ k, k < n → approved k := by
  induction chain with
  | root => intro k impossible; exact False.elim (Nat.not_lt_zero k impossible)
  | @extend n earlier permission localEdges ih =>
      intro k less
      rcases Nat.lt_or_eq_of_le (Nat.le_of_lt_succ less) with earlier | same
      · exact ih k earlier
      · cases same
        exact permission

abbrev Versioned (C : Nat → Type) := (n : Nat) × C n

def RootInitial {C S : Nat → Type}
    (project : (n : Nat) → C n → S n) (initial : S 0 → Prop) : Versioned C → Prop
  | ⟨0, state⟩ => initial (project 0 state)
  | ⟨_ + 1, _⟩ => False

def projectedRoot {C S : Nat → Type}
    (project : (n : Nat) → C n → S n)
    (previous : (n : Nat) → S (n + 1) → S n) (state : Versioned C) : S 0 :=
  rootView previous state.1 (project state.1 state.2)

/- Execution includes every step of the selected per-revision semantics.
   Revision may replace all code and payload, but cannot reset protected root
   meaning: migration must commute on the current live state. This is a strict
   representation-preserving migration profile; state-changing migrations need
   a separate admitted root transition, not a silent relaxation of this law.
-/
inductive EvolutionStep {C S : Nat → Type}
    (localStep : (n : Nat) → C n → C n → Prop)
    (specStep : (n : Nat) → S n → S n → Prop)
    (project : (n : Nat) → C n → S n)
    (previous : (n : Nat) → S (n + 1) → S n)
    (approved : Nat → Prop) : Versioned C → Versioned C → Prop
  | execute (n : Nat) (before after : C n) (step : localStep n before after) :
      EvolutionStep localStep specStep project previous approved ⟨n, before⟩ ⟨n, after⟩
  | revise (n : Nat) (before : C n) (after : C (n + 1))
      (permission : approved n) (localEdges : AdjacentRefines specStep previous n)
      (migration : previous n (project (n + 1) after) = project n before) :
      EvolutionStep localStep specStep project previous approved ⟨n, before⟩ ⟨n + 1, after⟩

theorem live_migration_preserves_root_view {C S : Nat → Type}
    (project : (n : Nat) → C n → S n)
    (previous : (n : Nat) → S (n + 1) → S n)
    (n : Nat) (before : C n) (after : C (n + 1))
    (migration : previous n (project (n + 1) after) = project n before) :
    projectedRoot project previous ⟨n + 1, after⟩ =
      projectedRoot project previous ⟨n, before⟩ := by
  simp only [projectedRoot, rootView, migration]

/- This is induction over ONE history containing runtime steps and revisions.
   The final refinement chain and root reachability are conclusions.
-/
theorem arbitrary_development_composes_refinements {C S : Nat → Type}
    (localStep : (n : Nat) → C n → C n → Prop)
    (specStep : (n : Nat) → S n → S n → Prop)
    (project : (n : Nat) → C n → S n)
    (previous : (n : Nat) → S (n + 1) → S n)
    (approved : Nat → Prop) (initial : S 0 → Prop)
    (localProjection : ∀ n, StepRefines (localStep n) (specStep n) (project n))
    {state : Versioned C}
    (history : Reach (RootInitial project initial)
      (EvolutionStep localStep specStep project previous approved) state) :
    ApprovedChain specStep previous approved state.1 ∧
      Reach initial (specStep 0) (projectedRoot project previous state) := by
  induction history with
  | @start state begin =>
      rcases state with ⟨n, state⟩
      cases n with
      | zero => exact ⟨.root, .start begin⟩
      | succ n => exact False.elim begin
  | @advance before after history move ih =>
      cases move with
      | execute n before after step =>
          refine ⟨ih.1, ?_⟩
          rcases localProjection n before after step with same | moved
          · have rootSame := congrArg (rootView previous n) same
            simpa only [projectedRoot] using (rootSame ▸ ih.2)
          · rcases approved_chain_composes_to_root ih.1 _ _ moved with same | rootStep
            · simpa only [projectedRoot] using (same ▸ ih.2)
            · exact .advance ih.2 rootStep
      | revise n before after permission localEdges migration =>
          refine ⟨.extend ih.1 permission localEdges, ?_⟩
          rw [live_migration_preserves_root_view project previous n before after migration]
          exact ih.2

theorem arbitrary_development_preserves_fixed_root_safety {C S : Nat → Type}
    (localStep : (n : Nat) → C n → C n → Prop)
    (specStep : (n : Nat) → S n → S n → Prop)
    (project : (n : Nat) → C n → S n)
    (previous : (n : Nat) → S (n + 1) → S n)
    (approved : Nat → Prop) (initial safe : S 0 → Prop)
    (localProjection : ∀ n, StepRefines (localStep n) (specStep n) (project n))
    (base : ∀ state, initial state → safe state)
    (edgePreserves : ∀ before after, safe before → specStep 0 before after → safe after)
    {state : Versioned C}
    (history : Reach (RootInitial project initial)
      (EvolutionStep localStep specStep project previous approved) state) :
    safe (projectedRoot project previous state) := by
  exact reachable_invariant initial safe (specStep 0) base edgePreserves
    (arbitrary_development_composes_refinements localStep specStep project previous
      approved initial localProjection history).2

/- Concrete instantiation with ALL declared components, their environment and
   arbitrary code-edit constructors in WholeProgram. No external whole-program
   simulation or final-safety hypothesis is used here.
-/
abbrev WholeStates (S E D I : Nat → Type) (n : Nat) :=
  SGDWholeProgram.Global (S n) (E n) (D n) (I n)

def wholeProject {S E D I : Nat → Type} (n : Nat) (state : WholeStates S E D I n) : S n :=
  state.owned

abbrev WholeEvolution {S E D I : Nat → Type}
    [∀ n, DecidableEq (S n)] [∀ n, DecidableEq (E n)] [∀ n, DecidableEq (I n)]
    (tables : (n : Nat) → SGDWholeProgram.AuthorityTable (S n) (E n) (I n))
    (previous : (n : Nat) → S (n + 1) → S n) (approved : Nat → Prop) :=
  EvolutionStep (C := WholeStates S E D I)
    (fun n => SGDWholeProgram.UnlabeledStep (tables n))
    (fun n => SGDWholeProgram.ModelStep (tables n)) wholeProject previous approved

theorem whole_program_evolution_has_root_reachability
    {S E D I : Nat → Type}
    [∀ n, DecidableEq (S n)] [∀ n, DecidableEq (E n)] [∀ n, DecidableEq (I n)]
    (tables : (n : Nat) → SGDWholeProgram.AuthorityTable (S n) (E n) (I n))
    (previous : (n : Nat) → S (n + 1) → S n) (approved : Nat → Prop)
    (initial : S 0 → Prop) {state : Versioned (WholeStates S E D I)}
    (history : Reach (RootInitial wholeProject initial)
      (WholeEvolution tables previous approved) state) :
    ApprovedChain (fun n => SGDWholeProgram.ModelStep (tables n)) previous approved state.1 ∧
      Reach initial (SGDWholeProgram.ModelStep (tables 0))
        (projectedRoot wholeProject previous state) := by
  apply arbitrary_development_composes_refinements _ _ _ _ _ _ _ history
  intro n before after step
  exact SGDWholeProgram.unlabeled_projection step

theorem whole_program_evolution_preserves_fixed_root_safety
    {S E D I : Nat → Type}
    [∀ n, DecidableEq (S n)] [∀ n, DecidableEq (E n)] [∀ n, DecidableEq (I n)]
    (tables : (n : Nat) → SGDWholeProgram.AuthorityTable (S n) (E n) (I n))
    (previous : (n : Nat) → S (n + 1) → S n) (approved : Nat → Prop)
    (initial safe : S 0 → Prop)
    (base : ∀ state, initial state → safe state)
    (edgePreserves : ∀ before actor event after, safe before →
      ((before, (actor, event)), after) ∈ tables 0 → safe after)
    {state : Versioned (WholeStates S E D I)}
    (history : Reach (RootInitial wholeProject initial)
      (WholeEvolution tables previous approved) state) :
    safe (projectedRoot wholeProject previous state) := by
  apply reachable_invariant initial safe (SGDWholeProgram.ModelStep (tables 0)) base
  · intro before after safeBefore edge
    obtain ⟨actor, event, allowed⟩ := edge
    exact edgePreserves before actor event after safeBefore allowed
  · exact (whole_program_evolution_has_root_reachability tables previous approved initial history).2


/- Independently fixed requirement interpretation is a state-local semantic
   obligation. The candidate cannot weaken `required` together with its map.
   This is not an assumption that all reachable programs are already safe.
   If a physical requirement is not faithfully represented, the root-view
   theorem above must not be presented as that physical requirement's proof.
-/
def FaithfulRootMeaning {S : Nat → Type}
    (previous : (n : Nat) → S (n + 1) → S n)
    (rootSafe : S 0 → Prop) (required : (n : Nat) → S n → Prop) : Prop :=
  ∀ n state, required n state ↔ rootSafe (rootView previous n state)

theorem whole_program_evolution_preserves_interpreted_requirement
    {S E D I : Nat → Type}
    [∀ n, DecidableEq (S n)] [∀ n, DecidableEq (E n)] [∀ n, DecidableEq (I n)]
    (tables : (n : Nat) → SGDWholeProgram.AuthorityTable (S n) (E n) (I n))
    (previous : (n : Nat) → S (n + 1) → S n) (approved : Nat → Prop)
    (initial rootSafe : S 0 → Prop) (required : (n : Nat) → S n → Prop)
    (faithful : FaithfulRootMeaning previous rootSafe required)
    (base : ∀ state, initial state → rootSafe state)
    (edgePreserves : ∀ before actor event after, rootSafe before →
      ((before, (actor, event)), after) ∈ tables 0 → rootSafe after)
    {state : Versioned (WholeStates S E D I)}
    (history : Reach (RootInitial wholeProject initial)
      (WholeEvolution tables previous approved) state) :
    required state.1 state.2.owned := by
  exact (faithful state.1 state.2.owned).mpr
    (whole_program_evolution_preserves_fixed_root_safety tables previous approved
      initial rootSafe base edgePreserves history)

/- The intended whole-world requirement is independently fixed as well.
   Its adequacy law must include every safety-relevant component, environment,
   payload and identity fact in the protected interpretation. A requirement
   that depends on arbitrary unprotected data cannot acquire this proof merely
   by choosing an erasing projection. This is semantic factorization, not an
   assumption that every reachable execution already satisfies the requirement.
-/
theorem whole_program_evolution_preserves_world_requirement
    {S E D I : Nat → Type}
    [∀ n, DecidableEq (S n)] [∀ n, DecidableEq (E n)] [∀ n, DecidableEq (I n)]
    (tables : (n : Nat) → SGDWholeProgram.AuthorityTable (S n) (E n) (I n))
    (previous : (n : Nat) → S (n + 1) → S n) (approved : Nat → Prop)
    (initial rootSafe : S 0 → Prop) (required : (n : Nat) → S n → Prop)
    (worldRequirement : (n : Nat) → WholeStates S E D I n → Prop)
    (worldMeaning : ∀ n world, worldRequirement n world ↔ required n world.owned)
    (faithful : FaithfulRootMeaning previous rootSafe required)
    (base : ∀ state, initial state → rootSafe state)
    (edgePreserves : ∀ before actor event after, rootSafe before →
      ((before, (actor, event)), after) ∈ tables 0 → rootSafe after)
    {state : Versioned (WholeStates S E D I)}
    (history : Reach (RootInitial wholeProject initial)
      (WholeEvolution tables previous approved) state) :
    worldRequirement state.1 state.2 := by
  exact (worldMeaning state.1 state.2).mpr
    (whole_program_evolution_preserves_interpreted_requirement tables previous approved
      initial rootSafe required faithful base edgePreserves history)

/- Positive witness: the protected representation changes from Nat to Nat×Nat.
   The new field is metadata; the fixed requirement remains that the first
   semantic value is at most one. A real component step and environment step
   then execute the generated new table. There are no runtime evidence logs.
-/
abbrev Representation : Nat → Type
  | 0 => Nat
  | _ + 1 => Nat × Nat

instance representationDecidable : ∀ n, DecidableEq (Representation n)
  | 0 => inferInstance
  | _ + 1 => inferInstance

def representationPrevious : (n : Nat) → Representation (n + 1) → Representation n
  | 0, state => state.1
  | _ + 1, state => state

def representationTables : (n : Nat) → SGDWholeProgram.AuthorityTable (Representation n) Unit Unit
  | 0 => [((0, (.component (), ())), 1), ((1, (.environment, ())), 1)]
  | _ + 1 => [(((0, 7), (.component (), ())), (1, 7)),
               (((1, 7), (.environment, ())), (1, 7))]

def representationRequired : (n : Nat) → Representation n → Prop
  | 0, state => state ≤ 1
  | _ + 1, state => state.1 ≤ 1

theorem representation_root_view_succ (n : Nat) (state : Nat × Nat) :
    rootView representationPrevious (n + 1) state = state.1 := by
  induction n with
  | zero => rfl
  | succ n ih => exact ih

theorem representation_meaning_is_faithful :
    FaithfulRootMeaning representationPrevious (fun state => state ≤ 1) representationRequired := by
  intro n state
  cases n with
  | zero => rfl
  | succ n => simp only [representationRequired, representation_root_view_succ]

theorem representation_edges_refine (n : Nat) :
    AdjacentRefines (fun n => SGDWholeProgram.ModelStep (representationTables n))
      representationPrevious n := by
  cases n with
  | zero =>
      intro before after edge
      obtain ⟨actor, event, allowed⟩ := edge
      simp only [representationTables, List.mem_cons, List.not_mem_nil, or_false] at allowed
      rcases allowed with first | second
      · have hb := congrArg (fun entry => entry.1.1) first
        have ha := congrArg Prod.snd first
        simp only at hb ha
        subst before
        subst after
        exact Or.inr ⟨.component (), (), by simp [representationTables, representationPrevious]⟩
      · have hb := congrArg (fun entry => entry.1.1) second
        have ha := congrArg Prod.snd second
        simp only at hb ha
        subst before
        subst after
        exact Or.inl rfl
  | succ n =>
      intro before after edge
      exact Or.inr edge

def representationBefore : SGDWholeProgram.Global Nat Unit Unit Unit :=
  ⟨0, (), fun _ => [], []⟩
def representationEdited : SGDWholeProgram.Global Nat Unit Unit Unit :=
  SGDWholeProgram.editComponent representationBefore () [.internal (fun _ _ => ())]
def representationRequest : Command (Nat × Nat) Unit Unit := .request (fun _ _ => ())
def representationMigrated : SGDWholeProgram.Global (Nat × Nat) Unit Unit Unit :=
  ⟨(0, 7), (), fun _ => [representationRequest], [representationRequest]⟩
def representationComponentDone : SGDWholeProgram.Global (Nat × Nat) Unit Unit Unit :=
  SGDWholeProgram.advanceComponent (representationTables 1) representationMigrated () representationRequest []
def representationEnvironmentDone : SGDWholeProgram.Global (Nat × Nat) Unit Unit Unit :=
  SGDWholeProgram.advanceEnvironment (representationTables 1) representationComponentDone representationRequest []

theorem revised_representation_executes_components_and_environment :
    Reach (RootInitial (wholeProject (E := fun _ => Unit) (D := fun _ => Unit) (I := fun _ => Unit))
      (fun state : Representation 0 => state = 0))
      (WholeEvolution (D := fun _ => Unit) representationTables representationPrevious (fun _ => True))
      ⟨1, representationEnvironmentDone⟩ ∧
      representationEnvironmentDone.owned = (1, 7) ∧
      representationRequired 1 representationEnvironmentDone.owned := by
  let begin : Versioned (WholeStates Representation (fun _ => Unit) (fun _ => Unit) (fun _ => Unit)) :=
    ⟨0, representationBefore⟩
  have h0 : Reach (RootInitial wholeProject (fun state : Representation 0 => state = 0))
      (WholeEvolution (D := fun _ => Unit) representationTables representationPrevious (fun _ => True)) begin := .start rfl
  have editStep : WholeEvolution (D := fun _ => Unit) representationTables representationPrevious (fun _ => True)
      ⟨0, representationBefore⟩ ⟨0, representationEdited⟩ := by
    apply EvolutionStep.execute
    exact ⟨.edited (.component ()), SGDWholeProgram.ProgramStep.editComponent _ () _⟩
  have migrationStep : WholeEvolution (D := fun _ => Unit) representationTables representationPrevious (fun _ => True)
      ⟨0, representationEdited⟩ ⟨1, representationMigrated⟩ := by
    apply EvolutionStep.revise
    · exact True.intro
    · exact representation_edges_refine 0
    · rfl
  have componentStep : WholeEvolution (D := fun _ => Unit) representationTables representationPrevious (fun _ => True)
      ⟨1, representationMigrated⟩ ⟨1, representationComponentDone⟩ := by
    apply EvolutionStep.execute
    exact ⟨_, SGDWholeProgram.ProgramStep.component _ () representationRequest [] rfl⟩
  have environmentStep : WholeEvolution (D := fun _ => Unit) representationTables representationPrevious (fun _ => True)
      ⟨1, representationComponentDone⟩ ⟨1, representationEnvironmentDone⟩ := by
    apply EvolutionStep.execute
    exact ⟨_, SGDWholeProgram.ProgramStep.environment _ representationRequest [] rfl⟩
  have edited := Reach.advance h0 editStep
  have revised := Reach.advance edited migrationStep
  have component := Reach.advance revised componentStep
  have environment := Reach.advance component environmentStep
  refine ⟨environment, ?_, ?_⟩
  · decide
  · change representationEnvironmentDone.owned.1 ≤ 1
    decide

/- This instance applies the combined arbitrary-history theorem, rather than
   inferring safety merely by evaluating the one final witness state. -/
theorem representation_root_edges_preserve
    (before : Nat) (actor : SGDWholeProgram.Actor Unit) (event : Unit) (after : Nat)
    (_safeBefore : before ≤ 1)
    (allowed : ((before, (actor, event)), after) ∈ representationTables 0) : after ≤ 1 := by
  simp only [representationTables, List.mem_cons, List.not_mem_nil, or_false] at allowed
  have nextOne : after = 1 := by
    rcases allowed with first | second
    · exact congrArg Prod.snd first
    · exact congrArg Prod.snd second
  rw [nextOne]
  exact Nat.le_refl 1

def representationWorldRequirement (n : Nat)
    (world : WholeStates Representation (fun _ => Unit) (fun _ => Unit) (fun _ => Unit) n) : Prop :=
  representationRequired n world.owned

theorem every_representation_development_meets_world_requirement
    {state : Versioned (WholeStates Representation (fun _ => Unit) (fun _ => Unit) (fun _ => Unit))}
    (history : Reach (RootInitial wholeProject (fun state : Representation 0 => state = 0))
      (WholeEvolution (D := fun _ => Unit) representationTables representationPrevious (fun _ => True)) state) :
    representationWorldRequirement state.1 state.2 := by
  apply whole_program_evolution_preserves_world_requirement representationTables representationPrevious
    (fun _ => True) (fun state => state = 0) (fun state => state ≤ 1)
    representationRequired representationWorldRequirement
    (fun _ _ => Iff.rfl) representation_meaning_is_faithful ?_
    representation_root_edges_preserve history
  intro state starts
  subst state
  decide

/- Negative witness: old and new specifications can both be perfectly safe,
   yet a migration that ignores the current state can destroy the requirement.
   This deliberately enlarged relation has no migration obligation.
-/
def constantNatProject : (n : Nat) → SGDWholeProgram.Global Nat Unit Unit Unit → Nat :=
  wholeProject (S := fun _ => Nat) (E := fun _ => Unit) (D := fun _ => Unit) (I := fun _ => Unit)
def constantBoolProject : (n : Nat) → SGDWholeProgram.Global Bool Unit Unit Unit → Bool :=
  wholeProject (S := fun _ => Bool) (E := fun _ => Unit) (D := fun _ => Unit) (I := fun _ => Unit)

def resetTable : SGDWholeProgram.AuthorityTable Nat Unit Unit :=
  [((1, (.environment, ())), 1)]
def resetWorld (value : Nat) : SGDWholeProgram.Global Nat Unit Unit Unit :=
  ⟨value, (), fun _ => [], []⟩

def UncheckedReset : Versioned (fun _ => SGDWholeProgram.Global Nat Unit Unit Unit) →
    Versioned (fun _ => SGDWholeProgram.Global Nat Unit Unit Unit) → Prop :=
  fun before after => before = ⟨0, resetWorld 1⟩ ∧ after = ⟨1, resetWorld 0⟩

theorem identical_specs_do_not_make_reset_safe :
    StepRefines (SGDWholeProgram.ModelStep resetTable) (SGDWholeProgram.ModelStep resetTable) id ∧
    Reach (RootInitial constantNatProject (fun state : Nat => state = 1)) UncheckedReset ⟨1, resetWorld 0⟩ ∧
    ¬ ((resetWorld 0).owned = 1) := by
  refine ⟨?_, ?_, by decide⟩
  · intro before after step
    exact Or.inr step
  · have begin : Reach (RootInitial constantNatProject (fun state : Nat => state = 1))
        UncheckedReset ⟨0, resetWorld 1⟩ := .start rfl
    exact .advance begin ⟨rfl, rfl⟩

theorem reset_fails_live_migration_obligation :
    ¬ ((id : Nat → Nat) (resetWorld 0).owned = (resetWorld 1).owned) := by decide

theorem unsafe_reset_cannot_be_an_approved_update :
    ¬ WholeEvolution (D := fun _ => Unit) (fun _ => resetTable)
        (fun _ state => state) (fun _ => True) ⟨0, resetWorld 1⟩ ⟨1, resetWorld 0⟩ := by
  intro step
  cases step with
  | revise n before after permission localEdges migration =>
      simp [wholeProject, resetWorld] at migration

/- A constant view can erase an independently required meaning even when every
   local step and migration satisfies state simulation. The faithful-meaning
   obligation, not the permission predicate, rules out this interpretation.
-/
def misleadingTables : Nat → SGDWholeProgram.AuthorityTable Bool Unit Unit
  | 0 => []
  | _ + 1 => [((false, (.component (), ())), true)]
def misleadingPrevious (_ : Nat) (_ : Bool) : Bool := false

def misleadingBefore : SGDWholeProgram.Global Bool Unit Unit Unit :=
  ⟨false, (), fun _ => [], []⟩
def misleadingRequest : Command Bool Unit Unit := .request (fun _ _ => ())
def misleadingMigrated : SGDWholeProgram.Global Bool Unit Unit Unit :=
  ⟨false, (), fun _ => [misleadingRequest], []⟩
def misleadingAfter : SGDWholeProgram.Global Bool Unit Unit Unit :=
  SGDWholeProgram.advanceComponent (misleadingTables 1) misleadingMigrated () misleadingRequest []

theorem constant_view_hides_a_requirement_violation :
    Reach (RootInitial constantBoolProject (fun state : Bool => state = false))
      (WholeEvolution (D := fun _ => Unit) misleadingTables misleadingPrevious (fun _ => True)) ⟨1, misleadingAfter⟩ ∧
    projectedRoot constantBoolProject misleadingPrevious ⟨1, misleadingAfter⟩ = false ∧
    ¬ (misleadingAfter.owned = false) := by
  have begin : Reach (RootInitial constantBoolProject (fun state : Bool => state = false))
      (WholeEvolution (D := fun _ => Unit) misleadingTables misleadingPrevious (fun _ => True)) ⟨0, misleadingBefore⟩ := .start rfl
  have migrationStep : WholeEvolution (D := fun _ => Unit) misleadingTables misleadingPrevious (fun _ => True)
      ⟨0, misleadingBefore⟩ ⟨1, misleadingMigrated⟩ := by
    apply EvolutionStep.revise
    · exact True.intro
    · intro before after edge
      exact Or.inl rfl
    · rfl
  have executionStep : WholeEvolution (D := fun _ => Unit) misleadingTables misleadingPrevious (fun _ => True)
      ⟨1, misleadingMigrated⟩ ⟨1, misleadingAfter⟩ := by
    apply EvolutionStep.execute
    exact ⟨_, SGDWholeProgram.ProgramStep.component _ () misleadingRequest [] rfl⟩
  have revised := Reach.advance begin migrationStep
  have ran := Reach.advance revised executionStep
  exact ⟨ran, rfl, by decide⟩

theorem misleading_view_is_not_faithful :
    ¬ FaithfulRootMeaning misleadingPrevious (fun state : Bool => state = false)
      (fun _ state => state = false) := by
  intro faithful
  have wrong := (faithful 1 true).mpr rfl
  cases wrong

theorem weakening_specification_fails_identity_refinement :
    ¬ StepRefines (SGDWholeProgram.ModelStep (misleadingTables 1))
      (SGDWholeProgram.ModelStep (misleadingTables 0)) id := by
  intro claimed
  have edge : SGDWholeProgram.ModelStep (misleadingTables 1) false true :=
    ⟨.component (), (), by simp [misleadingTables]⟩
  rcases claimed false true edge with equal | oldEdge
  · cases equal
  · obtain ⟨actor, event, member⟩ := oldEdge
    simp [misleadingTables] at member

end SGDDevelopmentRefinement

#print axioms SGDDevelopmentRefinement.refinement_maps_compose
#print axioms SGDDevelopmentRefinement.approved_chain_composes_to_root
#print axioms SGDDevelopmentRefinement.every_admitted_revision_was_approved
#print axioms SGDDevelopmentRefinement.live_migration_preserves_root_view
#print axioms SGDDevelopmentRefinement.arbitrary_development_composes_refinements
#print axioms SGDDevelopmentRefinement.arbitrary_development_preserves_fixed_root_safety
#print axioms SGDDevelopmentRefinement.whole_program_evolution_has_root_reachability
#print axioms SGDDevelopmentRefinement.whole_program_evolution_preserves_fixed_root_safety

#print axioms SGDDevelopmentRefinement.whole_program_evolution_preserves_interpreted_requirement
#print axioms SGDDevelopmentRefinement.representation_meaning_is_faithful
#print axioms SGDDevelopmentRefinement.representation_edges_refine
#print axioms SGDDevelopmentRefinement.revised_representation_executes_components_and_environment
#print axioms SGDDevelopmentRefinement.identical_specs_do_not_make_reset_safe
#print axioms SGDDevelopmentRefinement.reset_fails_live_migration_obligation
#print axioms SGDDevelopmentRefinement.constant_view_hides_a_requirement_violation
#print axioms SGDDevelopmentRefinement.misleading_view_is_not_faithful
#print axioms SGDDevelopmentRefinement.weakening_specification_fails_identity_refinement

#print axioms SGDDevelopmentRefinement.whole_program_evolution_preserves_world_requirement

#print axioms SGDDevelopmentRefinement.representation_root_edges_preserve
#print axioms SGDDevelopmentRefinement.every_representation_development_meets_world_requirement

#print axioms SGDDevelopmentRefinement.unsafe_reset_cannot_be_an_approved_update
