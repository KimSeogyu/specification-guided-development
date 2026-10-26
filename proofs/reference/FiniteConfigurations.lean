import SemanticConstraints

/- Exact finite lowering of COMPLETE native-reference configurations.
   A configuration may include shared owner state, every component PC, and the
   environment PC. No transition is filtered by the contract before checking.

   Enumeration completeness is proved for the vector/product constructions
   below. An arbitrary caller-supplied partial list cannot use these theorems.
   Duplicate entries are harmless because initial conditions, steps and every
   contract observation are pulled back along the SAME exact decode function.

   These are mathematical native-reference semantics, not a proof about an
   arbitrary TS/Rust parser, actual external I/O, or omitted configuration fields.
-/
namespace SGDFiniteConfigurations
open SGDMethod SGDSemanticConstraints

structure Enumeration (C : Type) where
  values : List C
  complete : ∀ state, state ∈ values

def decode {C : Type} (enumeration : Enumeration C) : Fin enumeration.values.length → C :=
  enumeration.values.get

theorem decode_is_surjective {C : Type} (enumeration : Enumeration C) (state : C) :
    ∃ index, decode enumeration index = state :=
  List.mem_iff_get.mp (enumeration.complete state)

def finEnumeration (n : Nat) : Enumeration (Fin n) :=
  ⟨List.finRange n, List.mem_finRange⟩

def productEnumeration {A B : Type} (left : Enumeration A) (right : Enumeration B) :
    Enumeration (A × B) where
  values := left.values.flatMap (fun a => right.values.map (fun b => (a, b)))
  complete := by
    rintro ⟨a, b⟩
    apply List.mem_flatMap.mpr
    refine ⟨a, left.complete a, ?_⟩
    exact List.mem_map.mpr ⟨b, right.complete b, rfl⟩

/- Useful for an actual profile's configuration structure. The map must cover
   every value of that structure; an erasing or partial projection is not enough.
-/
def mapEnumeration {A B : Type} (enumeration : Enumeration A) (construct : A → B)
    (onto : ∀ target, ∃ source, construct source = target) : Enumeration B where
  values := enumeration.values.map construct
  complete target := by
    obtain ⟨source, same⟩ := onto target
    exact List.mem_map.mpr ⟨source, enumeration.complete source, same⟩

def vectors {A : Type} (choices : List A) : (n : Nat) → List (Fin n → A)
  | 0 => [fun i => Fin.elim0 i]
  | n + 1 => (vectors choices n).flatMap (fun tail =>
      choices.map (fun head => Fin.cases head tail))

theorem every_vector_is_enumerated {A : Type} (choices : List A)
    (complete : ∀ value, value ∈ choices) (n : Nat) (vector : Fin n → A) :
    vector ∈ vectors choices n := by
  induction n with
  | zero =>
    have same : vector = (fun i => Fin.elim0 i) := by
      funext i
      exact Fin.elim0 i
    simp [vectors, same]
  | succ n ih =>
    apply List.mem_flatMap.mpr
    refine ⟨(fun i => vector i.succ), ih _, ?_⟩
    apply List.mem_map.mpr
    refine ⟨vector 0, complete _, ?_⟩
    funext i
    refine Fin.cases ?_ (fun _ => ?_) i <;> rfl

def vectorEnumeration {A : Type} (enumeration : Enumeration A) (n : Nat) :
    Enumeration (Fin n → A) :=
  ⟨vectors enumeration.values n, every_vector_is_enumerated enumeration.values enumeration.complete n⟩

/- A constructive equality decision for finite PC vectors. It does not use
   classical equality of arbitrary infinite functions. -/
def finiteFunctionDecidableEq {A : Type} [DecidableEq A] (n : Nat) :
    DecidableEq (Fin n → A) := fun left right =>
  if agrees : (List.finRange n).all (fun i => decide (left i = right i)) = true then
    .isTrue (by
      funext i
      exact of_decide_eq_true ((List.all_eq_true.mp agrees) i (List.mem_finRange i)))
  else .isFalse (by
    intro same
    apply agrees
    subst right
    simp)

abbrev OwnerPCs (states components pcs : Nat) :=
  Fin (states + 1) × ((Fin components → Fin (pcs + 1)) × Fin (pcs + 1))

/- No hidden data: owner, every component PC, and the environment PC are all
   present. A fixed controller/body is an external parameter of its transition
   semantics. A profile must prove that runtime steps preserve that fixed code
   or explicitly include changing code in its complete configuration domain.
-/
def ownerPCEnumeration (states components pcs : Nat) :
    Enumeration (OwnerPCs states components pcs) :=
  productEnumeration (finEnumeration (states + 1))
    (productEnumeration (vectorEnumeration (finEnumeration (pcs + 1)) components)
      (finEnumeration (pcs + 1)))

theorem every_owner_and_pc_configuration_is_represented
    (states components pcs : Nat) (configuration : OwnerPCs states components pcs) :
    ∃ index, decode (ownerPCEnumeration states components pcs) index = configuration :=
  decode_is_surjective _ configuration

structure NativeMachine (C : Type) (labels : Nat) where
  initial : C → Bool
  step : C → Fin labels → C → Bool

structure NativeContract (C : Type) (labels : Nat) where
  initialOK : C → Bool
  stateOK : C → Bool
  edgeOK : C → Fin labels → C → Bool

def NativeStep {C : Type} {labels : Nat} (machine : NativeMachine C labels)
    (before after : C) : Prop :=
  ∃ label, machine.step before label after = true

def NativeReachable {C : Type} {labels : Nat} (machine : NativeMachine C labels) (state : C) : Prop :=
  Reach (fun state => machine.initial state = true) (NativeStep machine) state

/- Independent native-reference contract: no enumeration or checker is used in
   its meaning. Both state and every labelled edge of actual reachability count.
-/
def NativeConforms {C : Type} {labels : Nat}
    (machine : NativeMachine C labels) (contract : NativeContract C labels) : Prop :=
  (∀ state, machine.initial state = true → contract.initialOK state = true) ∧
  ∀ state, NativeReachable machine state →
    contract.stateOK state = true ∧
      ∀ label next, machine.step state label next = true → contract.edgeOK state label next = true

def lowerMachine {C : Type} {labels : Nat} (enumeration : Enumeration C)
    (machine : NativeMachine C labels) : RawMachine enumeration.values.length labels where
  initial index := machine.initial (decode enumeration index)
  step before label after := machine.step (decode enumeration before) label (decode enumeration after)

def lowerContract {C : Type} {labels : Nat} (enumeration : Enumeration C)
    (contract : NativeContract C labels) : Contract enumeration.values.length labels where
  initialOK index := contract.initialOK (decode enumeration index)
  stateOK index := contract.stateOK (decode enumeration index)
  edgeOK before label after := contract.edgeOK (decode enumeration before) label (decode enumeration after)

theorem indexed_reachability_is_native_reachability
    {C : Type} {labels : Nat} (enumeration : Enumeration C) (machine : NativeMachine C labels)
    {index : Fin enumeration.values.length}
    (reachable : RawReachable (lowerMachine enumeration machine) index) :
    NativeReachable machine (decode enumeration index) := by
  induction reachable with
  | start initial => exact .start initial
  | advance previous step ih =>
    obtain ⟨label, actual⟩ := step
    exact .advance ih ⟨label, actual⟩

theorem native_reachability_lifts_to_every_encoding
    {C : Type} {labels : Nat} (enumeration : Enumeration C) (machine : NativeMachine C labels)
    {state : C} (reachable : NativeReachable machine state) :
    ∀ index, decode enumeration index = state →
      RawReachable (lowerMachine enumeration machine) index := by
  induction reachable with
  | start initial =>
    intro index same
    exact .start (by simpa [lowerMachine, same] using initial)
  | @advance before after previous step ih =>
    intro target sameTarget
    obtain ⟨origin, sameOrigin⟩ := decode_is_surjective enumeration before
    obtain ⟨label, actual⟩ := step
    apply Reach.advance (ih origin sameOrigin)
    exact ⟨label, by simpa [lowerMachine, sameOrigin, sameTarget] using actual⟩

theorem complete_configuration_reachability_exact
    {C : Type} {labels : Nat} (enumeration : Enumeration C) (machine : NativeMachine C labels)
    (index : Fin enumeration.values.length) :
    RawReachable (lowerMachine enumeration machine) index ↔
      NativeReachable machine (decode enumeration index) :=
  ⟨indexed_reachability_is_native_reachability enumeration machine,
    fun reached => native_reachability_lifts_to_every_encoding enumeration machine reached index rfl⟩

theorem native_state_reachability_has_an_index
    {C : Type} {labels : Nat} (enumeration : Enumeration C) (machine : NativeMachine C labels)
    (state : C) :
    NativeReachable machine state ↔
      ∃ index, decode enumeration index = state ∧ RawReachable (lowerMachine enumeration machine) index := by
  constructor
  · intro reached
    obtain ⟨index, same⟩ := decode_is_surjective enumeration state
    exact ⟨index, same, native_reachability_lifts_to_every_encoding enumeration machine reached index same⟩
  · rintro ⟨index, same, reached⟩
    simpa [same] using indexed_reachability_is_native_reachability enumeration machine reached

theorem indexed_conformance_exact
    {C : Type} {labels : Nat} (enumeration : Enumeration C)
    (machine : NativeMachine C labels) (contract : NativeContract C labels) :
    Conforms (lowerMachine enumeration machine) (lowerContract enumeration contract) ↔
      NativeConforms machine contract := by
  constructor
  · intro checked
    constructor
    · intro state initial
      obtain ⟨index, same⟩ := decode_is_surjective enumeration state
      have indexedInitial : (lowerMachine enumeration machine).initial index = true := by
        simpa [lowerMachine, same] using initial
      simpa [lowerContract, same] using checked.1 index indexedInitial
    · intro state reached
      obtain ⟨index, same⟩ := decode_is_surjective enumeration state
      have indexedReach := native_reachability_lifts_to_every_encoding enumeration machine reached index same
      have valid := checked.2 index indexedReach
      refine ⟨by simpa [lowerContract, same] using valid.1, ?_⟩
      intro label next actual
      obtain ⟨nextIndex, sameNext⟩ := decode_is_surjective enumeration next
      have indexedStep : (lowerMachine enumeration machine).step index label nextIndex = true := by
        simpa [lowerMachine, same, sameNext] using actual
      simpa [lowerContract, same, sameNext] using valid.2 label nextIndex indexedStep
  · intro conforms
    constructor
    · intro index initial
      exact conforms.1 (decode enumeration index) initial
    · intro index reached
      have nativeReach := indexed_reachability_is_native_reachability enumeration machine reached
      have valid := conforms.2 (decode enumeration index) nativeReach
      exact ⟨valid.1, fun label next actual => valid.2 label (decode enumeration next) actual⟩

def checkFiniteConfigurations {C : Type} {labels : Nat} (enumeration : Enumeration C)
    (machine : NativeMachine C labels) (contract : NativeContract C labels) : Bool :=
  checkGeneratedConstraints (lowerMachine enumeration machine) (lowerContract enumeration contract)

theorem finite_configuration_checker_iff_native_conformance
    {C : Type} {labels : Nat} (enumeration : Enumeration C)
    (machine : NativeMachine C labels) (contract : NativeContract C labels) :
    checkFiniteConfigurations enumeration machine contract = true ↔ NativeConforms machine contract :=
  (generated_constraints_iff_semantic_conformance _ _).trans
    (indexed_conformance_exact enumeration machine contract)

/- Duplicate encodings preserve exact semantics. Distinct decoded native states
   are never merged: this is a surjective enumeration, not a lossy abstraction.
-/
abbrev duplicateBooleans : Enumeration Bool :=
  ⟨[false, false, true], by intro value; cases value <;> simp⟩

theorem duplicate_decodings_are_real_aliases :
    decode duplicateBooleans 0 = decode duplicateBooleans 1 ∧
    (0 : Fin duplicateBooleans.values.length) ≠ 1 := by decide

def toggleMachine : NativeMachine Bool 1 where
  initial state := !state
  step before _ after := after == !before

def permissiveContract : NativeContract Bool 1 where
  initialOK _ := true
  stateOK _ := true
  edgeOK _ _ _ := true

theorem noninjective_enumeration_can_validate_an_actual_machine :
    checkFiniteConfigurations duplicateBooleans toggleMachine permissiveContract = true ∧
    RawReachable (lowerMachine duplicateBooleans toggleMachine) 2 := by
  refine ⟨by decide, ?_⟩
  have initial : RawReachable (lowerMachine duplicateBooleans toggleMachine) 0 := .start rfl
  exact .advance initial ⟨0, rfl⟩

/- A nonempty complete owner/PC domain exists even with no component actors:
   the environment PC and shared owner still remain part of configuration. -/
theorem owner_environment_configuration_is_nonempty (states components pcs : Nat) :
    ∃ index, decode (ownerPCEnumeration states components pcs) index = (0, ((fun _ => 0), 0)) :=
  decode_is_surjective _ _

end SGDFiniteConfigurations

#print axioms SGDFiniteConfigurations.decode_is_surjective
#print axioms SGDFiniteConfigurations.productEnumeration
#print axioms SGDFiniteConfigurations.mapEnumeration
#print axioms SGDFiniteConfigurations.every_vector_is_enumerated
#print axioms SGDFiniteConfigurations.vectorEnumeration
#print axioms SGDFiniteConfigurations.finiteFunctionDecidableEq
#print axioms SGDFiniteConfigurations.every_owner_and_pc_configuration_is_represented
#print axioms SGDFiniteConfigurations.indexed_reachability_is_native_reachability
#print axioms SGDFiniteConfigurations.native_reachability_lifts_to_every_encoding
#print axioms SGDFiniteConfigurations.complete_configuration_reachability_exact
#print axioms SGDFiniteConfigurations.native_state_reachability_has_an_index
#print axioms SGDFiniteConfigurations.indexed_conformance_exact
#print axioms SGDFiniteConfigurations.finite_configuration_checker_iff_native_conformance
#print axioms SGDFiniteConfigurations.duplicate_decodings_are_real_aliases
#print axioms SGDFiniteConfigurations.noninjective_enumeration_can_validate_an_actual_machine
#print axioms SGDFiniteConfigurations.owner_environment_configuration_is_nonempty
#print axioms SGDFiniteConfigurations.checkFiniteConfigurations
