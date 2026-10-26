import Method

/- Executable finite semantic constraints and independent reachability semantics.
   This is a proof model, not a product linter. Raw transitions are not filtered
   by the specification. Every complete configuration and label is represented.
   Runtime traces need not be retained: regions are static compiler constraints.
   Exhaustive region enumeration is deliberately a reference decision procedure,
   not an efficiency claim about a future native implementation. -/
namespace SGDSemanticConstraints
open SGDMethod

def regions : (n : Nat) → List (Fin n → Bool)
  | 0 => [fun i => Fin.elim0 i]
  | n + 1 => (regions n).flatMap (fun tail =>
      [Fin.cases false tail, Fin.cases true tail])

theorem every_region_is_enumerated (n : Nat) (region : Fin n → Bool) :
    region ∈ regions n := by
  induction n with
  | zero =>
    have same : region = (fun i => Fin.elim0 i) := by
      funext i
      exact Fin.elim0 i
    simp [regions, same]
  | succ n ih =>
    apply List.mem_flatMap.mpr
    refine ⟨(fun i => region i.succ), ih _, ?_⟩
    have same : region = Fin.cases (region 0) (fun i => region i.succ) := by
      funext i
      refine Fin.cases ?_ (fun _ => ?_) i <;> rfl
    cases head : region 0
    · exact List.mem_cons.mpr (Or.inl (by simpa [head] using same))
    · exact List.mem_cons.mpr (Or.inr (List.mem_cons.mpr
        (Or.inl (by simpa [head] using same))))

def everyFin (n : Nat) (predicate : Fin n → Bool) : Bool :=
  (List.finRange n).all predicate

theorem everyFin_exact (n : Nat) (predicate : Fin n → Bool) :
    everyFin n predicate = true ↔ ∀ i, predicate i = true := by
  simp [everyFin, List.all_eq_true]

structure RawMachine (n labels : Nat) where
  initial : Fin n → Bool
  step : Fin n → Fin labels → Fin n → Bool

structure Contract (n labels : Nat) where
  stateOK : Fin n → Bool
  edgeOK : Fin n → Fin labels → Fin n → Bool
  initialOK : Fin n → Bool := fun _ => true

def RawStep {n labels : Nat} (machine : RawMachine n labels) (s t : Fin n) : Prop :=
  ∃ label, machine.step s label t = true

def RawReachable {n labels : Nat} (machine : RawMachine n labels) (s : Fin n) : Prop :=
  Reach (fun state => machine.initial state = true) (RawStep machine) s

/- This semantic contract is defined without a checker or invariant region. -/
def Conforms {n labels : Nat} (machine : RawMachine n labels)
    (contract : Contract n labels) : Prop :=
  (∀ s, machine.initial s = true → contract.initialOK s = true) ∧
  ∀ s, RawReachable machine s →
    contract.stateOK s = true ∧
      ∀ label t, machine.step s label t = true → contract.edgeOK s label t = true

def RegionValid {n labels : Nat} (machine : RawMachine n labels)
    (contract : Contract n labels) (region : Fin n → Bool) : Prop :=
  (∀ s, machine.initial s = true → region s = true ∧ contract.initialOK s = true) ∧
  (∀ s, region s = true → contract.stateOK s = true) ∧
  (∀ s label t, region s = true → machine.step s label t = true →
    region t = true ∧ contract.edgeOK s label t = true)

def checkRegion {n labels : Nat} (machine : RawMachine n labels)
    (contract : Contract n labels) (region : Fin n → Bool) : Bool :=
  everyFin n (fun s =>
    (!machine.initial s || (region s && contract.initialOK s)) &&
    (!region s || (contract.stateOK s &&
      everyFin labels (fun label => everyFin n (fun t =>
        !machine.step s label t || (region t && contract.edgeOK s label t))))))

theorem checkRegion_exact {n labels : Nat} (machine : RawMachine n labels)
    (contract : Contract n labels) (region : Fin n → Bool) :
    checkRegion machine contract region = true ↔ RegionValid machine contract region := by
  simp only [checkRegion, everyFin_exact, Bool.and_eq_true, Bool.or_eq_true,
    RegionValid]
  constructor
  · intro checked
    refine ⟨?_, ?_, ?_⟩
    · intro s initial
      rcases (checked s).1 with noInitial | included
      · simp [initial] at noInitial
      · exact included
    · intro s included
      rcases (checked s).2 with excluded | valid
      · simp [included] at excluded
      · exact valid.1
    · intro s label t included step
      rcases (checked s).2 with excluded | valid
      · simp [included] at excluded
      · rcases valid.2 label t with absent | compliant
        · simp [step] at absent
        · exact compliant
  · rintro ⟨initials, states, edges⟩ s
    constructor
    · cases h : machine.initial s
      · exact Or.inl rfl
      · exact Or.inr (initials s h)
    · cases h : region s
      · exact Or.inl rfl
      · right
        refine ⟨states s h, ?_⟩
        intro label t
        cases step : machine.step s label t
        · exact Or.inl rfl
        · exact Or.inr (edges s label t h step)

theorem valid_region_contains_every_execution {n labels : Nat}
    (machine : RawMachine n labels) (contract : Contract n labels)
    (region : Fin n → Bool) (valid : RegionValid machine contract region)
    {s : Fin n} (reachable : RawReachable machine s) : region s = true := by
  induction reachable with
  | start initial => exact (valid.1 _ initial).1
  | advance previous edge ih =>
    obtain ⟨label, step⟩ := edge
    exact (valid.2.2 _ label _ ih step).1

theorem valid_region_implies_conformance {n labels : Nat}
    (machine : RawMachine n labels) (contract : Contract n labels)
    (region : Fin n → Bool) (valid : RegionValid machine contract region) :
    Conforms machine contract := by
  refine ⟨fun s initial => (valid.1 s initial).2, ?_⟩
  intro s reachable
  have included := valid_region_contains_every_execution machine contract region valid reachable
  exact ⟨valid.2.1 s included, fun label t step => (valid.2.2 s label t included step).2⟩

theorem conformance_has_valid_region {n labels : Nat}
    (machine : RawMachine n labels) (contract : Contract n labels)
    (conforms : Conforms machine contract) :
    ∃ region, RegionValid machine contract region := by
  classical
  let region : Fin n → Bool := fun s => decide (RawReachable machine s)
  have included (s : Fin n) : region s = true ↔ RawReachable machine s := by
    simp [region]
  refine ⟨region, ?_, ?_, ?_⟩
  · intro s initial
    exact ⟨(included s).mpr (.start initial), conforms.1 s initial⟩
  · intro s inside
    exact (conforms.2 s ((included s).mp inside)).1
  · intro s label t inside step
    have reachable := (included s).mp inside
    exact ⟨(included t).mpr (.advance reachable ⟨label, step⟩),
      (conforms.2 s reachable).2 label t step⟩

def checkGeneratedConstraints {n labels : Nat} (machine : RawMachine n labels)
    (contract : Contract n labels) : Bool :=
  (regions n).any (checkRegion machine contract)

theorem generated_constraints_iff_semantic_conformance {n labels : Nat}
    (machine : RawMachine n labels) (contract : Contract n labels) :
    checkGeneratedConstraints machine contract = true ↔ Conforms machine contract := by
  constructor
  · intro checked
    obtain ⟨region, _, valid⟩ := List.any_eq_true.mp checked
    exact valid_region_implies_conformance machine contract region
      ((checkRegion_exact machine contract region).mp valid)
  · intro conforms
    obtain ⟨region, valid⟩ := conformance_has_valid_region machine contract conforms
    exact List.any_eq_true.mpr ⟨region, every_region_is_enumerated n region,
      (checkRegion_exact machine contract region).mpr valid⟩

/- Unreachable bad states must not cause semantic false negatives. -/
def unreachableBad : RawMachine 2 1 where
  initial s := s == 0
  step s _ t := s == 0 && t == 0

def onlyZeroState : Contract 2 1 where
  stateOK s := s == 0
  edgeOK _ _ _ := true

theorem unreachable_bad_state_is_accepted :
    checkGeneratedConstraints unreachableBad onlyZeroState = true ∧
    onlyZeroState.stateOK 1 = false := by decide

/- The same state can satisfy state safety while violating an observed label. -/
def sameStateTwoLabels : RawMachine 1 2 where
  initial _ := true
  step _ _ _ := true

def onlyFirstLabel : Contract 1 2 where
  stateOK _ := true
  edgeOK _ label _ := label == 0

theorem state_safety_does_not_replace_label_compliance :
    (∀ s, onlyFirstLabel.stateOK s = true) ∧
    checkGeneratedConstraints sameStateTwoLabels onlyFirstLabel = false := by
  constructor
  · intro s; rfl
  · decide

/- A cycle can be traversed arbitrarily often before taking its bad exit.
   The checker rejects the whole machine without selecting an execution bound. -/
def cycleWithBadExit : RawMachine 3 1 where
  initial s := s == 0
  step s _ t := (s == 0 && t == 0) || (s == 0 && t == 1) || (s == 1 && t == 2)

def beforeBadExit : Contract 3 1 where
  stateOK s := s != 2
  edgeOK _ _ _ := true

theorem cycle_with_bad_exit_is_rejected :
    checkGeneratedConstraints cycleWithBadExit beforeBadExit = false := by decide

theorem bad_exit_is_actually_reachable : RawReachable cycleWithBadExit 2 := by
  have start : RawReachable cycleWithBadExit 0 := .start rfl
  have middle : RawReachable cycleWithBadExit 1 := .advance start ⟨0, rfl⟩
  exact .advance middle ⟨0, rfl⟩

theorem empty_initial_set_is_explicitly_vacuous :
    checkGeneratedConstraints (⟨fun _ => false, fun _ _ _ => true⟩ : RawMachine 1 1)
      { stateOK := fun _ => false, edgeOK := fun _ _ _ => false } = true := by decide

theorem safe_states_do_not_justify_an_invalid_initial_state :
    checkGeneratedConstraints (⟨fun _ => true, fun _ _ _ => false⟩ : RawMachine 1 1)
      { stateOK := fun _ => true, edgeOK := fun _ _ _ => true,
        initialOK := fun _ => false } = false := by decide

end SGDSemanticConstraints

#print axioms SGDSemanticConstraints.every_region_is_enumerated
#print axioms SGDSemanticConstraints.checkRegion_exact
#print axioms SGDSemanticConstraints.valid_region_implies_conformance
#print axioms SGDSemanticConstraints.conformance_has_valid_region
#print axioms SGDSemanticConstraints.generated_constraints_iff_semantic_conformance
#print axioms SGDSemanticConstraints.unreachable_bad_state_is_accepted
#print axioms SGDSemanticConstraints.state_safety_does_not_replace_label_compliance
#print axioms SGDSemanticConstraints.cycle_with_bad_exit_is_rejected
#print axioms SGDSemanticConstraints.bad_exit_is_actually_reachable
#print axioms SGDSemanticConstraints.empty_initial_set_is_explicitly_vacuous
#print axioms SGDSemanticConstraints.safe_states_do_not_justify_an_invalid_initial_state
#print axioms SGDSemanticConstraints.regions
#print axioms SGDSemanticConstraints.everyFin
#print axioms SGDSemanticConstraints.checkRegion
#print axioms SGDSemanticConstraints.checkGeneratedConstraints
