import WholeProgram
import SemanticConstraints

/- Formal source-profile semantics, not a native parser or product linter.
   The raw grammar contains executable unsafe primitives. Its semantics does
   not call the checker. The exact checker target is the stronger declared
   authority discipline, not arbitrary state safety or reachable compliance.
   Native alias/module resolution and complete source discovery remain separate
   lowering obligations. Fin n names the complete declared component vector. -/
namespace SGDStructuralLint
open SGDMethod SGDWholeProgram

inductive RawCommand (S E D I : Type)
  | internal : (S → D → D) → RawCommand S E D I
  | request : (S → D → E) → RawCommand S E D I
  | directStore : (S → D → S) → RawCommand S E D I
  | reset : S → RawCommand S E D I
  | foreignCall : Actor I → AuthorityTable S E I → (S → D → E) → RawCommand S E D I
  | opaqueEffect : (S × D → S × D) → RawCommand S E D I

/- These are primitive access events, not checker-produced verdicts. A direct
   store remains a direct store even if the supplied value equals the old one. -/
inductive Access (I : Type)
  | local : Actor I → Access I
  | canonicalCall : Actor I → Access I
  | directStore : Actor I → Access I
  | reinitialize : Actor I → Access I
  | foreignCall : Actor I → Actor I → Access I
  | unclassified : Actor I → Access I

structure RawResult (S E D I : Type) where
  execution : (S × D) × Observation I E
  access : Access I

def evalRaw {S E D I : Type}
    [DecidableEq S] [DecidableEq E] [DecidableEq I]
    (table : AuthorityTable S E I) (actor : Actor I)
    (command : RawCommand S E D I) (state : S × D) : RawResult S E D I :=
  match command with
  | .internal body => ⟨((state.1, body state.1 state.2), .internal actor), .local actor⟩
  | .request choose => ⟨evalCommand table actor (.request choose) state, .canonicalCall actor⟩
  | .directStore body => ⟨((body state.1 state.2, state.2), .internal actor), .directStore actor⟩
  | .reset replacement => ⟨((replacement, state.2), .internal actor), .reinitialize actor⟩
  | .foreignCall claimed foreign choose =>
      ⟨evalCommand foreign claimed (.request choose) state, .foreignCall actor claimed⟩
  | .opaqueEffect body => ⟨(body state, .internal actor), .unclassified actor⟩

/- Independent operational policy: local pure work and invocation of the one
   context-bound authority are admitted. Stores, reset, foreign authority and
   unclassified effects do not satisfy this provenance policy, regardless of
   whether a particular state invariant happens to survive. -/
def AuthorizedAccess {I : Type} (actor : Actor I) : Access I → Prop
  | .local actual => actual = actor
  | .canonicalCall actual => actual = actor
  | _ => False

def AuthorityConforms {S E D I : Type}
    [DecidableEq S] [DecidableEq E] [DecidableEq I]
    (table : AuthorityTable S E I) (actor : Actor I)
    (command : RawCommand S E D I) : Prop :=
  ∀ state, AuthorizedAccess actor (evalRaw table actor command state).access

def translateCommand {S E D I : Type} :
    RawCommand S E D I → Option (Command S E D)
  | .internal body => some (.internal body)
  | .request choose => some (.request choose)
  | .directStore _ | .reset _ | .foreignCall _ _ _ | .opaqueEffect _ => none

def checkCommand {S E D I : Type} (command : RawCommand S E D I) : Bool :=
  (translateCommand command).isSome

/- Total erasure has a harmless default only to state the translation lemmas.
   The default is never credited as a translation of rejected raw source. -/
def eraseCommand {S E D I : Type} (command : RawCommand S E D I) : Command S E D :=
  (translateCommand command).getD (.internal (fun _ data => data))

theorem command_check_iff_authority_contract {S E D I : Type}
    [DecidableEq S] [DecidableEq E] [DecidableEq I]
    (inhabitedInput : S × D) (table : AuthorityTable S E I) (actor : Actor I)
    (command : RawCommand S E D I) :
    checkCommand command = true ↔ AuthorityConforms table actor command := by
  cases command <;>
    simp only [checkCommand, translateCommand, Option.isSome_some, Option.isSome_none]
  · simp [AuthorityConforms, evalRaw, AuthorizedAccess]
  · simp [AuthorityConforms, evalRaw, AuthorizedAccess]
  · constructor
    · intro impossible; cases impossible
    · intro conforms
      exact False.elim (conforms inhabitedInput)
  · constructor
    · intro impossible; cases impossible
    · intro conforms
      exact False.elim (conforms inhabitedInput)
  · constructor
    · intro impossible; cases impossible
    · intro conforms
      exact False.elim (conforms inhabitedInput)
  · constructor
    · intro impossible; cases impossible
    · intro conforms
      exact False.elim (conforms inhabitedInput)

theorem accepted_command_execution_exact {S E D I : Type}
    [DecidableEq S] [DecidableEq E] [DecidableEq I]
    (table : AuthorityTable S E I) (actor : Actor I)
    (command : RawCommand S E D I) (state : S × D)
    (accepted : checkCommand command = true) :
    (evalRaw table actor command state).execution =
      evalCommand table actor (eraseCommand command) state := by
  cases command <;> simp_all [checkCommand, translateCommand, eraseCommand, evalRaw, evalCommand]

def checkCode {S E D I : Type} (code : List (RawCommand S E D I)) : Bool :=
  code.all checkCommand
def eraseCode {S E D I : Type} (code : List (RawCommand S E D I)) : List (Command S E D) :=
  code.map eraseCommand
def CodeAuthorityConforms {S E D I : Type}
    [DecidableEq S] [DecidableEq E] [DecidableEq I]
    (table : AuthorityTable S E I) (actor : Actor I)
    (code : List (RawCommand S E D I)) : Prop :=
  ∀ command, command ∈ code → AuthorityConforms table actor command

theorem code_check_iff_authority_contract {S E D I : Type}
    [DecidableEq S] [DecidableEq E] [DecidableEq I]
    (input : S × D) (table : AuthorityTable S E I) (actor : Actor I)
    (code : List (RawCommand S E D I)) :
    checkCode code = true ↔ CodeAuthorityConforms table actor code := by
  simp only [checkCode, List.all_eq_true, CodeAuthorityConforms]
  constructor
  · intro checked command member
    exact (command_check_iff_authority_contract input table actor command).mp (checked command member)
  · intro conforms command member
    exact (command_check_iff_authority_contract input table actor command).mpr (conforms command member)

def allComponents : (n : Nat) → (Fin n → Bool) → Bool
  | 0, _ => true
  | n + 1, predicate => predicate 0 && allComponents n (fun index => predicate index.succ)

theorem all_components_exact (n : Nat) (predicate : Fin n → Bool) :
    allComponents n predicate = true ↔ ∀ index, predicate index = true := by
  induction n with
  | zero => simp [allComponents]
  | succ n ih => simp [allComponents, Fin.forall_fin_succ, ih]

structure RawGlobal (S E D : Type) (n : Nat) where
  authority : AuthorityTable S E (Fin n)
  owned : S
  data : D
  components : Fin n → List (RawCommand S E D (Fin n))
  environment : List (RawCommand S E D (Fin n))

def eraseGlobal {S E D : Type} {n : Nat}
    (world : RawGlobal S E D n) : Global S E D (Fin n) :=
  ⟨world.owned, world.data, fun index => eraseCode (world.components index),
    eraseCode world.environment⟩

/- Exact table identity is a declared binding obligation. Raw requests really
   use world.authority; this is not decorative metadata. All vector positions
   and the environment are checked, including declarations never scheduled. -/
def checkGlobal {S E D : Type} {n : Nat} [DecidableEq S] [DecidableEq E]
    (expected : AuthorityTable S E (Fin n)) (world : RawGlobal S E D n) : Bool :=
  decide (world.authority = expected) &&
    allComponents n (fun index => checkCode (world.components index)) &&
    checkCode world.environment

def DeclaredAuthorityContract {S E D : Type} {n : Nat}
    [DecidableEq S] [DecidableEq E]
    (expected : AuthorityTable S E (Fin n)) (world : RawGlobal S E D n) : Prop :=
  world.authority = expected ∧
    (∀ index, CodeAuthorityConforms world.authority (.component index) (world.components index)) ∧
    CodeAuthorityConforms world.authority .environment world.environment

theorem global_check_iff_declared_authority {S E D : Type} {n : Nat}
    [DecidableEq S] [DecidableEq E]
    (expected : AuthorityTable S E (Fin n)) (world : RawGlobal S E D n) :
    checkGlobal expected world = true ↔ DeclaredAuthorityContract expected world := by
  simp only [checkGlobal, Bool.and_eq_true, decide_eq_true_eq, all_components_exact]
  constructor
  · rintro ⟨⟨same, components⟩, environment⟩
    refine ⟨same, ?_, ?_⟩
    · intro index
      exact (code_check_iff_authority_contract (world.owned, world.data)
        world.authority (.component index) _).mp (components index)
    · exact (code_check_iff_authority_contract (world.owned, world.data)
        world.authority .environment _).mp environment
  · rintro ⟨same, components, environment⟩
    refine ⟨⟨same, ?_⟩, ?_⟩
    · intro index
      exact (code_check_iff_authority_contract (world.owned, world.data)
        world.authority (.component index) _).mpr (components index)
    · exact (code_check_iff_authority_contract (world.owned, world.data)
        world.authority .environment _).mpr environment

def translateGlobal {S E D : Type} {n : Nat} [DecidableEq S] [DecidableEq E]
    (expected : AuthorityTable S E (Fin n)) (world : RawGlobal S E D n) :
    Option (Global S E D (Fin n)) :=
  if checkGlobal expected world then some (eraseGlobal world) else none

theorem translation_exists_iff_declared_authority {S E D : Type} {n : Nat}
    [DecidableEq S] [DecidableEq E]
    (expected : AuthorityTable S E (Fin n)) (world : RawGlobal S E D n) :
    (translateGlobal expected world).isSome = true ↔ DeclaredAuthorityContract expected world := by
  simp only [translateGlobal]
  split <;> simp_all [global_check_iff_declared_authority]

def advanceRawComponent {S E D : Type} {n : Nat} [DecidableEq S] [DecidableEq E]
    (world : RawGlobal S E D n) (index : Fin n)
    (command : RawCommand S E D (Fin n)) (rest : List (RawCommand S E D (Fin n))) :
    RawGlobal S E D n :=
  let result := (evalRaw world.authority (.component index) command (world.owned, world.data)).execution
  { world with
    owned := result.1.1
    data := result.1.2
    components := fun other => if other = index then rest else world.components other }

def advanceRawEnvironment {S E D : Type} {n : Nat} [DecidableEq S] [DecidableEq E]
    (world : RawGlobal S E D n) (command : RawCommand S E D (Fin n))
    (rest : List (RawCommand S E D (Fin n))) : RawGlobal S E D n :=
  let result := (evalRaw world.authority .environment command (world.owned, world.data)).execution
  { world with owned := result.1.1, data := result.1.2, environment := rest }

def editRawComponent {S E D : Type} {n : Nat} (world : RawGlobal S E D n)
    (index : Fin n) (replacement : List (RawCommand S E D (Fin n))) : RawGlobal S E D n :=
  { world with components := fun other => if other = index then replacement else world.components other }
def editRawEnvironment {S E D : Type} {n : Nat} (world : RawGlobal S E D n)
    (replacement : List (RawCommand S E D (Fin n))) : RawGlobal S E D n :=
  { world with environment := replacement }

/- The unchecked relation permits unsafe command execution and unsafe edits.
   It is defined without checkCommand, checkGlobal, translation, or a proof of
   acceptance. Rejected source still has its own actual reference behavior. -/
inductive RawStep {S E D : Type} {n : Nat} [DecidableEq S] [DecidableEq E] :
    Observation (Fin n) E → RawGlobal S E D n → RawGlobal S E D n → Prop
  | component (world : RawGlobal S E D n) (index : Fin n)
      (command : RawCommand S E D (Fin n)) (rest : List (RawCommand S E D (Fin n)))
      (head : world.components index = command :: rest) :
      RawStep (evalRaw world.authority (.component index) command (world.owned, world.data)).execution.2
        world (advanceRawComponent world index command rest)
  | environment (world : RawGlobal S E D n) (command : RawCommand S E D (Fin n))
      (rest : List (RawCommand S E D (Fin n))) (head : world.environment = command :: rest) :
      RawStep (evalRaw world.authority .environment command (world.owned, world.data)).execution.2
        world (advanceRawEnvironment world command rest)
  | editComponent (world : RawGlobal S E D n) (index : Fin n)
      (replacement : List (RawCommand S E D (Fin n))) :
      RawStep (.edited (.component index)) world (editRawComponent world index replacement)
  | editEnvironment (world : RawGlobal S E D n)
      (replacement : List (RawCommand S E D (Fin n))) :
      RawStep (.edited .environment) world (editRawEnvironment world replacement)

private theorem global_ext {S E D I : Type} (left right : Global S E D I)
    (owned : left.owned = right.owned) (data : left.data = right.data)
    (components : left.components = right.components) (environment : left.environment = right.environment) :
    left = right := by
  cases left
  cases right
  simp_all

theorem erase_component_execution {S E D : Type} {n : Nat}
    [DecidableEq S] [DecidableEq E] (world : RawGlobal S E D n) (index : Fin n)
    (command : RawCommand S E D (Fin n)) (rest : List (RawCommand S E D (Fin n)))
    (accepted : checkCommand command = true) :
    eraseGlobal (advanceRawComponent world index command rest) =
      advanceComponent world.authority (eraseGlobal world) index (eraseCommand command) (eraseCode rest) := by
  have evaluated := accepted_command_execution_exact world.authority (.component index) command
    (world.owned, world.data) accepted
  apply global_ext
  · exact congrArg (fun result => result.1.1) evaluated
  · exact congrArg (fun result => result.1.2) evaluated
  · funext other
    by_cases same : other = index <;>
      simp [eraseGlobal, advanceRawComponent, advanceComponent, same]
  · rfl

theorem erase_environment_execution {S E D : Type} {n : Nat}
    [DecidableEq S] [DecidableEq E] (world : RawGlobal S E D n)
    (command : RawCommand S E D (Fin n)) (rest : List (RawCommand S E D (Fin n)))
    (accepted : checkCommand command = true) :
    eraseGlobal (advanceRawEnvironment world command rest) =
      advanceEnvironment world.authority (eraseGlobal world) (eraseCommand command) (eraseCode rest) := by
  have evaluated := accepted_command_execution_exact world.authority .environment command
    (world.owned, world.data) accepted
  exact global_ext _ _ (congrArg (fun result => result.1.1) evaluated)
    (congrArg (fun result => result.1.2) evaluated) rfl rfl

theorem erase_component_edit {S E D : Type} {n : Nat} (world : RawGlobal S E D n)
    (index : Fin n) (replacement : List (RawCommand S E D (Fin n))) :
    eraseGlobal (editRawComponent world index replacement) =
      editComponent (eraseGlobal world) index (eraseCode replacement) := by
  apply global_ext
  · rfl
  · rfl
  · funext other
    by_cases same : other = index <;> simp [eraseGlobal, editRawComponent, editComponent, same]
  · rfl

theorem erase_environment_edit {S E D : Type} {n : Nat} (world : RawGlobal S E D n)
    (replacement : List (RawCommand S E D (Fin n))) :
    eraseGlobal (editRawEnvironment world replacement) =
      editEnvironment (eraseGlobal world) (eraseCode replacement) := rfl

/- This is a static admission boundary on the independently defined raw
   relation. Rechecking the whole edited declaration vector is essential;
   a previously accepted program does not authorize arbitrary replacement. -/
def CheckedStep {S E D : Type} {n : Nat} [DecidableEq S] [DecidableEq E]
    (expected : AuthorityTable S E (Fin n)) (label : Observation (Fin n) E)
    (before after : RawGlobal S E D n) : Prop :=
  checkGlobal expected before = true ∧ RawStep label before after ∧
    checkGlobal expected after = true

theorem checked_raw_step_maps_to_whole_program {S E D : Type} {n : Nat}
    [DecidableEq S] [DecidableEq E]
    {expected : AuthorityTable S E (Fin n)} {label : Observation (Fin n) E}
    {before after : RawGlobal S E D n}
    (step : CheckedStep expected label before after) :
    ProgramStep expected label (eraseGlobal before) (eraseGlobal after) := by
  obtain ⟨checked, raw, _checkedAfter⟩ := step
  have contract := (global_check_iff_declared_authority expected before).mp checked
  obtain ⟨same, components, environment⟩ := contract
  cases raw with
  | component before index command rest head =>
      have allowed : checkCommand command = true :=
        (command_check_iff_authority_contract (before.owned, before.data) before.authority
          (.component index) command).mpr
          (components index command (by simp [head]))
      subst expected
      rw [erase_component_execution before index command rest allowed,
        accepted_command_execution_exact before.authority (.component index) command
          (before.owned, before.data) allowed]
      exact ProgramStep.component (eraseGlobal before) index (eraseCommand command) (eraseCode rest)
        (by change eraseCode (before.components index) = _; rw [head]; rfl)
  | environment before command rest head =>
      have allowed : checkCommand command = true :=
        (command_check_iff_authority_contract (before.owned, before.data) before.authority
          .environment command).mpr (environment command (by simp [head]))
      subst expected
      rw [erase_environment_execution before command rest allowed,
        accepted_command_execution_exact before.authority .environment command
          (before.owned, before.data) allowed]
      exact ProgramStep.environment (eraseGlobal before) (eraseCommand command) (eraseCode rest)
        (by change eraseCode before.environment = _; rw [head]; rfl)
  | editComponent before index replacement =>
      subst expected
      rw [erase_component_edit]
      exact ProgramStep.editComponent _ _ _
  | editEnvironment before replacement =>
      subst expected
      rw [erase_environment_edit]
      exact ProgramStep.editEnvironment _ _

theorem checked_raw_trace_maps_to_whole_program {S E D : Type} {n : Nat}
    [DecidableEq S] [DecidableEq E]
    {expected : AuthorityTable S E (Fin n)} {before after : RawGlobal S E D n}
    {labels : List (Observation (Fin n) E)}
    (trace : Trace (CheckedStep expected) before labels after) :
    Trace (ProgramStep expected) (eraseGlobal before) labels (eraseGlobal after) := by
  induction trace with
  | nil world => exact .nil _
  | cons step later ih => exact .cons (checked_raw_step_maps_to_whole_program step) ih

theorem checked_raw_trace_obeys_specification {S E D : Type} {n : Nat}
    [DecidableEq S] [DecidableEq E]
    {expected : AuthorityTable S E (Fin n)} {before after : RawGlobal S E D n}
    {labels : List (Observation (Fin n) E)}
    (trace : Trace (CheckedStep expected) before labels after) :
    Trace (SpecMove expected) before.owned labels after.owned :=
  whole_trace_refines (checked_raw_trace_maps_to_whole_program trace)

/- This conjunction names BOTH obligations. It is not an equivalence with
   semantic safety alone. A frontend must separately prove that the supplied
   finite machine describes this raw program; this packaging lemma does not
   establish that correspondence for unrelated inputs. -/
def qualifiedCheck {S E D : Type} {n states labels : Nat}
    [DecidableEq S] [DecidableEq E]
    (expected : AuthorityTable S E (Fin n)) (world : RawGlobal S E D n)
    (machine : SGDSemanticConstraints.RawMachine states labels)
    (contract : SGDSemanticConstraints.Contract states labels) : Bool :=
  checkGlobal expected world && SGDSemanticConstraints.checkGeneratedConstraints machine contract

theorem qualified_check_iff_static_and_semantic {S E D : Type} {n states labels : Nat}
    [DecidableEq S] [DecidableEq E]
    (expected : AuthorityTable S E (Fin n)) (world : RawGlobal S E D n)
    (machine : SGDSemanticConstraints.RawMachine states labels)
    (contract : SGDSemanticConstraints.Contract states labels) :
    qualifiedCheck expected world machine contract = true ↔
      DeclaredAuthorityContract expected world ∧ SGDSemanticConstraints.Conforms machine contract := by
  simp only [qualifiedCheck, Bool.and_eq_true, global_check_iff_declared_authority,
    SGDSemanticConstraints.generated_constraints_iff_semantic_conformance]

def exampleAuthority : AuthorityTable Bool Unit (Fin 1) :=
  [((false, (.component 0, ())), true)]
def exampleRequest : RawCommand Bool Unit Unit (Fin 1) := .request (fun _ _ => ())
def exampleWorld : RawGlobal Bool Unit Unit 1 :=
  ⟨exampleAuthority, false, (), fun _ => [exampleRequest], []⟩
def exampleAfter := advanceRawComponent exampleWorld 0 exampleRequest []

theorem accepted_raw_program_makes_progress :
    CheckedStep exampleAuthority (.accepted (.component 0) ()) exampleWorld exampleAfter ∧
    exampleAfter.owned = true := by
  refine ⟨⟨?_, ?_, ?_⟩, rfl⟩
  · rfl
  · exact RawStep.component exampleWorld 0 exampleRequest [] rfl
  · rfl

theorem unsafe_edit_is_raw_but_not_admitted {S E D : Type} {n : Nat}
    [DecidableEq S] [DecidableEq E]
    (expected : AuthorityTable S E (Fin n)) (world : RawGlobal S E D n) (index : Fin n) :
    let bad : RawCommand S E D (Fin n) := .directStore (fun owner _ => owner)
    RawStep (.edited (.component index)) world (editRawComponent world index [bad]) ∧
      checkGlobal expected (editRawComponent world index [bad]) = false := by
  intro bad
  refine ⟨RawStep.editComponent world index [bad], ?_⟩
  cases checked : checkGlobal expected (editRawComponent world index [bad]) with
  | false => rfl
  | true =>
      have contract := (global_check_iff_declared_authority expected _).mp checked
      have forbidden := contract.2.1 index bad (by simp [editRawComponent])
      exact False.elim (forbidden (world.owned, world.data))

/- Counterexample to the DIFFERENT claim "lint accepts iff state-safe".
   A direct identity store preserves every state predicate, but violates the
   independently declared protected-write provenance policy and is rejected. -/
theorem safe_direct_store_is_rejected {S E D I : Type}
    [DecidableEq S] [DecidableEq E] [DecidableEq I]
    (table : AuthorityTable S E I) (actor : Actor I) (state : S × D)
    (safe : S → Prop) (wasSafe : safe state.1) :
    checkCommand (RawCommand.directStore (I := I) (E := E) (fun (owner : S) (_ : D) => owner)) = false ∧
    (evalRaw table actor (.directStore (fun owner _ => owner)) state).execution.1 = state ∧
    safe (evalRaw table actor (.directStore (fun owner _ => owner)) state).execution.1.1 ∧
    ¬ AuthorityConforms table actor (.directStore (fun owner (_ : D) => owner)) := by
  refine ⟨rfl, rfl, wasSafe, ?_⟩
  intro conforms
  exact conforms state

end SGDStructuralLint

#print axioms SGDStructuralLint.command_check_iff_authority_contract
#print axioms SGDStructuralLint.accepted_command_execution_exact
#print axioms SGDStructuralLint.code_check_iff_authority_contract
#print axioms SGDStructuralLint.all_components_exact
#print axioms SGDStructuralLint.global_check_iff_declared_authority
#print axioms SGDStructuralLint.translation_exists_iff_declared_authority
#print axioms SGDStructuralLint.erase_component_execution
#print axioms SGDStructuralLint.erase_environment_execution
#print axioms SGDStructuralLint.checked_raw_step_maps_to_whole_program
#print axioms SGDStructuralLint.checked_raw_trace_maps_to_whole_program
#print axioms SGDStructuralLint.checked_raw_trace_obeys_specification
#print axioms SGDStructuralLint.qualified_check_iff_static_and_semantic
#print axioms SGDStructuralLint.accepted_raw_program_makes_progress
#print axioms SGDStructuralLint.unsafe_edit_is_raw_but_not_admitted
#print axioms SGDStructuralLint.safe_direct_store_is_rejected
