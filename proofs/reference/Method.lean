import Std

/- Formal specification only. This file is not an SGD runtime or backend. -/
namespace SGDMethod

/- Target syntax has no instruction for arbitrary state writes. -/
inductive Dispatch (K V : Type)
  | reject : Dispatch K V
  | branch : K → V → Dispatch K V → Dispatch K V

def compileTable {K V : Type} : List (K × V) → Dispatch K V
  | [] => .reject
  | (key, value) :: rest => .branch key value (compileTable rest)

def evalDispatch {K V : Type} [DecidableEq K] : Dispatch K V → K → Option V
  | .reject, _ => none
  | .branch key value rest, query =>
      if query = key then some value else evalDispatch rest query

def tableLookup {K V : Type} [DecidableEq K] : List (K × V) → K → Option V
  | [], _ => none
  | (key, value) :: rest, query =>
      if query = key then some value else tableLookup rest query

def Functional {K V : Type} (table : List (K × V)) : Prop :=
  ∀ key a b, (key, a) ∈ table → (key, b) ∈ table → a = b

theorem compilation_preserves_lookup {K V : Type} [DecidableEq K]
    (table : List (K × V)) (key : K) :
    evalDispatch (compileTable table) key = tableLookup table key := by
  induction table with
  | nil => rfl
  | cons entry rest ih =>
    rcases entry with ⟨k, v⟩
    simp [compileTable, evalDispatch, tableLookup, ih]

theorem lookup_sound {K V : Type} [DecidableEq K]
    (table : List (K × V)) (key : K) (value : V)
    (h : tableLookup table key = some value) : (key, value) ∈ table := by
  induction table with
  | nil => simp [tableLookup] at h
  | cons entry rest ih =>
    rcases entry with ⟨k, v⟩
    by_cases hk : key = k
    · simp [tableLookup, hk] at h
      subst key
      subst value
      exact List.mem_cons_self
    · simp [tableLookup, hk] at h
      exact List.mem_cons_of_mem _ (ih h)

theorem lookup_complete {K V : Type} [DecidableEq K]
    (table : List (K × V)) (key : K) (value : V)
    (functional : Functional table) (member : (key, value) ∈ table) :
    tableLookup table key = some value := by
  induction table with
  | nil => simp at member
  | cons entry rest ih =>
    rcases entry with ⟨k, v⟩
    by_cases hk : key = k
    · have hv : value = v := functional key value v member (by simp [hk])
      simp [tableLookup, hk, hv]
    · have tailMember : (key, value) ∈ rest := by
        simpa [List.mem_cons, Prod.mk.injEq, hk] using member
      have tailFunctional : Functional rest := by
        intro q a b ha hb
        exact functional q a b (List.mem_cons_of_mem _ ha) (List.mem_cons_of_mem _ hb)
      simp [tableLookup, hk, ih tailFunctional tailMember]

theorem lookup_exact {K V : Type} [DecidableEq K]
    (table : List (K × V)) (functional : Functional table) (key : K) (value : V) :
    tableLookup table key = some value ↔ (key, value) ∈ table :=
  ⟨lookup_sound table key value, lookup_complete table key value functional⟩

theorem generated_dispatch_exact {K V : Type} [DecidableEq K]
    (table : List (K × V)) (functional : Functional table) (key : K) (value : V) :
    evalDispatch (compileTable table) key = some value ↔ (key, value) ∈ table := by
  rw [compilation_preserves_lookup]
  exact lookup_exact table functional key value

theorem generated_rejection_exact {K V : Type} [DecidableEq K]
    (table : List (K × V)) (key : K) :
    evalDispatch (compileTable table) key = none ↔ ¬ ∃ value, (key, value) ∈ table := by
  rw [compilation_preserves_lookup]
  induction table with
  | nil => simp [tableLookup]
  | cons entry rest ih =>
    rcases entry with ⟨k, v⟩
    by_cases hk : key = k
    · simp [tableLookup, hk]
    · simp [tableLookup, hk, List.mem_cons, Prod.mk.injEq, ih]

def execute {S E : Type} [DecidableEq S] [DecidableEq E]
    (table : List ((S × E) × S)) (state : S) (event : E) : S :=
  (evalDispatch (compileTable table) (state, event)).getD state

def run {S E : Type} [DecidableEq S] [DecidableEq E]
    (table : List ((S × E) × S)) : S → List E → S
  | state, [] => state
  | state, event :: rest => run table (execute table state event) rest

theorem rejection_preserves_state {S E : Type} [DecidableEq S] [DecidableEq E]
    (table : List ((S × E) × S)) (state : S) (event : E)
    (rejected : tableLookup table (state, event) = none) :
    execute table state event = state := by
  simp [execute, compilation_preserves_lookup, rejected]

theorem execute_preserves {S E : Type} [DecidableEq S] [DecidableEq E]
    (table : List ((S × E) × S)) (safe : S → Prop)
    (closed : ∀ s e t, safe s → ((s, e), t) ∈ table → safe t)
    (state : S) (event : E) (initial : safe state) :
    safe (execute table state event) := by
  cases h : tableLookup table (state, event) with
  | none => simpa [execute, compilation_preserves_lookup, h] using initial
  | some next =>
    simpa [execute, compilation_preserves_lookup, h] using closed state event next initial (lookup_sound _ _ _ h)

theorem arbitrary_finite_execution_safe {S E : Type} [DecidableEq S] [DecidableEq E]
    (table : List ((S × E) × S)) (safe : S → Prop)
    (closed : ∀ s e t, safe s → ((s, e), t) ∈ table → safe t)
    (events : List E) (state : S) (initial : safe state) :
    safe (run table state events) := by
  induction events generalizing state with
  | nil => exact initial
  | cons event rest ih =>
    exact ih (execute table state event) (execute_preserves table safe closed state event initial)

/- This restricted program language enforces ownership by construction.
   Payload changes cannot write the owner. Request selection can read both.
   It is not a semantics of arbitrary TypeScript or Rust. -/
inductive Command (S E D : Type)
  | internal : (S → D → D) → Command S E D
  | request : (S → D → E) → Command S E D

def commandStep {S E D : Type} [DecidableEq S] [DecidableEq E]
    (table : List ((S × E) × S)) (command : Command S E D) (state : S × D) : S × D :=
  match command with
  | .internal body => (state.1, body state.1 state.2)
  | .request choose => (execute table state.1 (choose state.1 state.2), state.2)

def programRun {S E D : Type} [DecidableEq S] [DecidableEq E]
    (table : List ((S × E) × S)) : List (Command S E D) → S × D → S × D
  | [], state => state
  | command :: rest, state => programRun table rest (commandStep table command state)

theorem restricted_program_safe {S E D : Type} [DecidableEq S] [DecidableEq E]
    (table : List ((S × E) × S)) (safe : S → Prop)
    (closed : ∀ s e t, safe s → ((s, e), t) ∈ table → safe t)
    (program : List (Command S E D)) (state : S × D) (initial : safe state.1) :
    safe (programRun table program state).1 := by
  induction program generalizing state with
  | nil => exact initial
  | cons command rest ih =>
    apply ih
    cases command with
    | internal body => exact initial
    | request choose => exact execute_preserves table safe closed state.1 _ initial

inductive Reach {S : Type} (initial : S → Prop) (step : S → S → Prop) : S → Prop
  | start {s} : initial s → Reach initial step s
  | advance {s t} : Reach initial step s → step s t → Reach initial step t

theorem reachable_invariant {S : Type} (initial safe : S → Prop) (step : S → S → Prop)
    (base : ∀ s, initial s → safe s)
    (preserve : ∀ s t, safe s → step s t → safe t)
    {s : S} (reachable : Reach initial step s) : safe s := by
  induction reachable with
  | start h => exact base _ h
  | advance _ edge ih => exact preserve _ _ ih edge

/- Each native semantic step must be classified, including environment effects.
   Local simulation is an explicit proof obligation, not a fact about TS or Rust. -/
theorem local_obligations_lift {N S : Type}
    (nativeInitial : N → Prop) (nativeStep : N → N → Prop)
    (modelInitial : S → Prop) (modelStep : S → S → Prop) (project : N → S)
    (initialBinding : ∀ n, nativeInitial n → modelInitial (project n))
    (stepBinding : ∀ n m, nativeStep n m → project n = project m ∨ modelStep (project n) (project m))
    {n : N} (reachable : Reach nativeInitial nativeStep n) :
    Reach modelInitial modelStep (project n) := by
  induction reachable with
  | start h => exact Reach.start (initialBinding _ h)
  | advance _ edge ih =>
    rcases stepBinding _ _ edge with same | moved
    · simpa [same] using ih
    · exact Reach.advance ih moved

/- The decomposition exposes the obligations hidden in a single simulation premise.
   Body includes every instruction family and every environment step via coverage.
   Real source analysis must independently discharge each of these premises. -/
theorem local_contracts_lift {N S Kind : Type}
    (nativeInitial : N → Prop) (nativeStep : N → N → Prop)
    (body : Kind → N → N → Prop) (representation : N → Prop)
    (modelInitial : S → Prop) (modelStep : S → S → Prop) (project : N → S)
    (initialBinding : ∀ n, nativeInitial n → representation n ∧ modelInitial (project n))
    (coverage : ∀ n m, nativeStep n m → ∃ kind, body kind n m)
    (contracts : ∀ kind n m, representation n → body kind n m →
      representation m ∧ (project n = project m ∨ modelStep (project n) (project m)))
    {n : N} (reachable : Reach nativeInitial nativeStep n) :
    representation n ∧ Reach modelInitial modelStep (project n) := by
  induction reachable with
  | start h =>
    have initial := initialBinding _ h
    exact ⟨initial.1, .start initial.2⟩
  | advance _ edge ih =>
    obtain ⟨kind, matched⟩ := coverage _ _ edge
    obtain ⟨preserved, correspondence⟩ := contracts kind _ _ ih.1 matched
    refine ⟨preserved, ?_⟩
    rcases correspondence with same | moved
    · simpa [same] using ih.2
    · exact Reach.advance ih.2 moved

theorem method_safety_from_local_contracts {N S Kind : Type}
    (nativeInitial : N → Prop) (nativeStep : N → N → Prop)
    (body : Kind → N → N → Prop) (representation : N → Prop)
    (modelInitial : S → Prop) (modelStep : S → S → Prop) (project : N → S)
    (safe : S → Prop)
    (initialBinding : ∀ n, nativeInitial n → representation n ∧ modelInitial (project n))
    (coverage : ∀ n m, nativeStep n m → ∃ kind, body kind n m)
    (contracts : ∀ kind n m, representation n → body kind n m →
      representation m ∧ (project n = project m ∨ modelStep (project n) (project m)))
    (base : ∀ s, modelInitial s → safe s)
    (closed : ∀ s t, safe s → modelStep s t → safe t)
    {n : N} (reachable : Reach nativeInitial nativeStep n) : safe (project n) := by
  have mapped := local_contracts_lift nativeInitial nativeStep body representation
    modelInitial modelStep project initialBinding coverage contracts reachable
  exact reachable_invariant modelInitial safe modelStep base closed mapped.2

/- A joint invariant must survive each component's steps. -/
theorem composition {A B : Type}
    (left : A → A → Prop) (right : B → B → Prop) (joint : A × B → Prop)
    (leftPreserves : ∀ a a' b, joint (a, b) → left a a' → joint (a', b))
    (rightPreserves : ∀ a b b', joint (a, b) → right b b' → joint (a, b'))
    (s t : A × B) (hs : joint s)
    (move : (left s.1 t.1 ∧ s.2 = t.2) ∨ (s.1 = t.1 ∧ right s.2 t.2)) :
    joint t := by
  rcases s with ⟨a, b⟩
  rcases t with ⟨a', b'⟩
  rcases move with ⟨hl, hb⟩ | ⟨ha, hr⟩
  · cases hb
    exact leftPreserves a a' b hs hl
  · cases ha
    exact rightPreserves a b b' hs hr

/- A fixed baseline must be supplied independently of the changed model. -/
theorem change_preserves_baseline {New Old : Type}
    (newInitial : New → Prop) (newStep : New → New → Prop)
    (oldInitial : Old → Prop) (oldStep : Old → Old → Prop)
    (project : New → Old) (baseline : Old → Prop)
    (initialBinding : ∀ n, newInitial n → oldInitial (project n))
    (stepBinding : ∀ n m, newStep n m → project n = project m ∨ oldStep (project n) (project m))
    (base : ∀ s, oldInitial s → baseline s)
    (closed : ∀ s t, baseline s → oldStep s t → baseline t)
    {n : New} (reachable : Reach newInitial newStep n) : baseline (project n) := by
  exact reachable_invariant oldInitial baseline oldStep base closed
    (local_obligations_lift newInitial newStep oldInitial oldStep project initialBinding stepBinding reachable)

/- Concrete negative witnesses. True leaf invariants do not imply joint equality. -/
theorem leaf_safety_does_not_imply_joint :
    (True ∧ True) ∧ ((false, false) : Bool × Bool).1 = (false, false).2 ∧
    ¬ ((true, false) : Bool × Bool).1 = (true, false).2 := by decide

def approvedEdge (s t : Bool) : Prop := s = true ∧ t = false
def eraseApproval (_ : Bool) : Unit := ()

theorem existential_projection_is_not_authority :
    (∃ s t, approvedEdge s t ∧ eraseApproval s = eraseApproval false) ∧
    ¬ ∃ t, approvedEdge false t := by
  constructor
  · exact ⟨true, false, ⟨rfl, rfl⟩, rfl⟩
  · simp [approvedEdge]

theorem candidate_self_check_does_not_preserve_baseline :
    (∀ (_ : Bool), True) ∧ ¬ (∀ (s : Bool), s = false) := by
  constructor
  · intro _; trivial
  · intro h; have bad := h true; cases bad

theorem omitted_obligation_can_fail :
    (∀ x : Bool, x = false → x = false) ∧ ¬ (∀ x : Bool, x = false) := by
  constructor
  · intro _ h; exact h
  · intro h; have bad := h true; cases bad

/- An actual usable table has an accepted request and a rejected request. -/
def once : List ((Bool × Unit) × Bool) := [((false, ()), true)]

theorem once_is_functional : Functional once := by
  intro key a b ha hb
  simp [once] at ha hb
  exact ha.2.trans hb.2.symm

theorem allowed_then_forbidden :
    evalDispatch (compileTable once) (false, ()) = some true ∧
    evalDispatch (compileTable once) (true, ()) = none ∧
    run once false [(), ()] = true := by decide

theorem reset_bypasses_per_object_limit :
    let first := evalDispatch (compileTable once) (false, ())
    let sameOwner := evalDispatch (compileTable once) (true, ())
    let replacementOwner := evalDispatch (compileTable once) (false, ())
    first = some true ∧ sameOwner = none ∧ replacementOwner = some true := by decide

def weakeningStep (s t : Bool) : Prop := s = false ∧ t = true

theorem weakening_has_reachable_baseline_violation :
    Reach (fun s : Bool => s = false) weakeningStep true ∧
    ¬ (true = false) := by
  exact ⟨.advance (.start rfl) ⟨rfl, rfl⟩, Bool.noConfusion⟩

theorem generated_nontrivial_safety (events : List Unit) :
    run ([((0, ()), 1)] : List ((Nat × Unit) × Nat)) 0 events ≤ 1 := by
  apply arbitrary_finite_execution_safe _ (fun n : Nat => n ≤ 1)
  · intro s e t _ member
    simp at member
    omega
  · omega

/- State is (published, approved). Event false approves; event true publishes. -/
def approval : List (((Bool × Bool) × Bool) × (Bool × Bool)) :=
  [(((false, false), false), (false, true)),
   (((false, true), true), (true, true))]

def ApprovalSafe (s : Bool × Bool) : Prop := s.1 = true → s.2 = true

theorem approval_functional : Functional approval := by
  intro key a b ha hb
  simp [approval] at ha hb
  rcases ha with h | h <;> rcases hb with g | g <;> simp_all

theorem approval_closed :
    ∀ s e t, ApprovalSafe s → ((s, e), t) ∈ approval → ApprovalSafe t := by
  intro s e t _ member
  simp [approval] at member
  rcases member with h | h <;> simp_all [ApprovalSafe]

theorem approval_initial_safe : ApprovalSafe (false, false) := by
  unfold ApprovalSafe
  decide

theorem approval_positive_and_negative :
    run approval (false, false) [false, true] = (true, true) ∧
    evalDispatch (compileTable approval) ((false, false), true) = none ∧
    execute approval (false, false) true = (false, false) := by decide

theorem approval_all_finite_executions_safe (events : List Bool) :
    ApprovalSafe (run approval (false, false) events) :=
  arbitrary_finite_execution_safe approval ApprovalSafe approval_closed events
    (false, false) approval_initial_safe

def ApprovalWithBypass (s t : Bool × Bool) : Prop :=
  (∃ e, ((s, e), t) ∈ approval) ∨ t = (true, false)

theorem direct_write_breaks_approval :
    Reach (fun s => s = (false, false)) ApprovalWithBypass (true, false) ∧
    ¬ ApprovalSafe (true, false) := by
  constructor
  · exact .advance (.start rfl) (Or.inr rfl)
  · unfold ApprovalSafe
    decide

/- A modeled root defines its full transitive dependency closure.
   Evidence is indexed by the entire semantic snapshot revision, not file name. -/
inductive Required {O : Type} (root : O → Prop) (depends : O → O → Prop) : O → Prop
  | root {o} : root o → Required root depends o
  | dependency {o d} : Required root depends o → depends o d → Required root depends d

def Covered {O : Type} (revision : Nat) (root : O → Prop) (depends : O → O → Prop)
    (evidence : Nat → O → Prop) : Prop :=
  ∀ o, Required root depends o → evidence revision o

theorem coverage_from_local_dependencies {O : Type}
    (revision : Nat) (root : O → Prop) (depends : O → O → Prop) (evidence : Nat → O → Prop)
    (roots : ∀ o, root o → evidence revision o)
    (dependencies : ∀ o d, evidence revision o → depends o d → evidence revision d) :
    Covered revision root depends evidence := by
  intro o required
  induction required with
  | root h => exact roots _ h
  | dependency _ edge ih => exact dependencies _ _ ih edge

theorem missing_dependency_blocks_coverage {O : Type}
    (revision : Nat) (root : O → Prop) (depends : O → O → Prop) (evidence : Nat → O → Prop)
    (o d : O) (required : Required root depends o) (edge : depends o d)
    (missing : ¬ evidence revision d) : ¬ Covered revision root depends evidence := by
  intro covered
  exact missing (covered d (.dependency required edge))

theorem old_evidence_cannot_cover_new_revision :
    ¬ Covered 1 (fun (_ : Unit) => True) (fun _ _ => False)
      (fun revision _ => revision = 0) := by
  intro covered
  have impossible := covered () (.root True.intro)
  cases impossible

theorem omitted_transitive_requirement_blocks :
    ¬ Covered 0 (fun o : Bool => o = false)
      (fun o d => o = false ∧ d = true) (fun _ o => o = false) := by
  apply missing_dependency_blocks_coverage _ _ _ _ false true
  · exact .root rfl
  · exact ⟨rfl, rfl⟩
  · exact Bool.noConfusion

/- A reference development protocol, not a product API.
   required and valid are fixed outside the candidate's transitions.
   Recording requires semantic validity, not a Boolean success receipt. -/
structure ReviewState (O : Type) where
  revision : Nat
  evidence : O → Prop
  ready : Bool

def ReviewInitial {O : Type} (s : ReviewState O) : Prop :=
  s.revision = 0 ∧ (∀ o, ¬ s.evidence o) ∧ s.ready = false

inductive ReviewStep {O : Type} (required : O → Prop) (valid : Nat → O → Prop) :
    ReviewState O → ReviewState O → Prop
  | record (s : ReviewState O) (o : O) (proof : valid s.revision o) :
      ReviewStep required valid s
        ⟨s.revision, (fun q => s.evidence q ∨ q = o), false⟩
  | revise (s : ReviewState O) :
      ReviewStep required valid s ⟨s.revision + 1, (fun _ => False), false⟩
  | authorize (s : ReviewState O) (complete : ∀ o, required o → s.evidence o) :
      ReviewStep required valid s ⟨s.revision, s.evidence, true⟩

def ReviewInvariant {O : Type} (required : O → Prop) (valid : Nat → O → Prop)
    (s : ReviewState O) : Prop :=
  (∀ o, s.evidence o → valid s.revision o) ∧
  (s.ready = true → ∀ o, required o → valid s.revision o)

theorem review_step_preserves {O : Type} (required : O → Prop) (valid : Nat → O → Prop)
    {s t : ReviewState O} (safe : ReviewInvariant required valid s)
    (step : ReviewStep required valid s t) : ReviewInvariant required valid t := by
  cases step with
  | record o proof =>
    constructor
    · intro q evidence
      rcases evidence with prior | same
      · exact safe.1 q prior
      · subst q; exact proof
    · intro impossible; cases impossible
  | revise =>
    constructor
    · intro _ impossible; exact False.elim impossible
    · intro impossible; cases impossible
  | authorize complete =>
    exact ⟨safe.1, fun _ o needed => safe.1 o (complete o needed)⟩

theorem development_ready_requires_current_proofs {O : Type}
    (required : O → Prop) (valid : Nat → O → Prop)
    {s : ReviewState O} (reachable : Reach ReviewInitial (ReviewStep required valid) s)
    (ready : s.ready = true) : ∀ o, required o → valid s.revision o := by
  have invariant : ReviewInvariant required valid s := by
    apply reachable_invariant ReviewInitial (ReviewInvariant required valid)
      (ReviewStep required valid) ?_ ?_ reachable
    · intro initial h
      constructor
      · intro o evidence; exact False.elim (h.2.1 o evidence)
      · intro impossible; rw [h.2.2] at impossible; cases impossible
    · intro _ _ preserved step
      exact review_step_preserves required valid preserved step
  exact invariant.2 ready

theorem development_protocol_can_be_ready :
    ∃ s : ReviewState Unit,
      Reach ReviewInitial (ReviewStep (fun _ => True) (fun _ _ => True)) s ∧ s.ready = true := by
  let initial : ReviewState Unit := ⟨0, fun _ => False, false⟩
  have start : Reach ReviewInitial (ReviewStep (fun _ => True) (fun _ _ => True)) initial :=
    .start ⟨rfl, (fun _ h => h), rfl⟩
  have recorded := Reach.advance start (ReviewStep.record initial () True.intro)
  have sealed := Reach.advance recorded (ReviewStep.authorize _ (by intro o _; exact Or.inr (Subsingleton.elim o ())))
  exact ⟨_, sealed, rfl⟩

theorem invalid_revision_cannot_be_ready
    {s : ReviewState Unit}
    (reachable : Reach ReviewInitial
      (ReviewStep (fun _ => True) (fun revision _ => revision = 0)) s)
    (changed : s.revision = 1) : s.ready ≠ true := by
  intro ready
  have current := development_ready_requires_current_proofs
    (fun _ => True) (fun revision _ => revision = 0) reachable ready () True.intro
  rw [changed] at current
  cases current

theorem missing_required_dependency_cannot_be_ready
    {s : ReviewState Bool}
    (reachable : Reach ReviewInitial
      (ReviewStep
        (Required (fun o => o = false) (fun o d => o = false ∧ d = true))
        (fun _ o => o = false)) s) : s.ready ≠ true := by
  intro ready
  have dependency : Required (fun o : Bool => o = false)
      (fun o d => o = false ∧ d = true) true := .dependency (.root rfl) ⟨rfl, rfl⟩
  have impossible := development_ready_requires_current_proofs _ _ reachable ready true dependency
  cases impossible

/- Content-indexed evidence. Snapshot is a semantic value, not a revision label
   or a hash. Historical evidence remains available after an edit. -/
structure SnapshotReview (Snapshot O : Type) where
  current : Snapshot
  evidence : Snapshot → O → Prop
  ready : Bool

def SnapshotInitial {S O : Type} (s : SnapshotReview S O) : Prop :=
  (∀ snapshot o, ¬ s.evidence snapshot o) ∧ s.ready = false

inductive SnapshotStep {S O : Type} (needed valid : S → O → Prop) :
    SnapshotReview S O → SnapshotReview S O → Prop
  | record (s : SnapshotReview S O) (snapshot : S) (o : O)
      (proof : valid snapshot o) :
      SnapshotStep needed valid s
        ⟨s.current, (fun x q => s.evidence x q ∨ (x = snapshot ∧ q = o)), false⟩
  | edit (s : SnapshotReview S O) (snapshot : S) :
      SnapshotStep needed valid s ⟨snapshot, s.evidence, false⟩
  | authorize (s : SnapshotReview S O)
      (complete : ∀ o, needed s.current o → s.evidence s.current o) :
      SnapshotStep needed valid s ⟨s.current, s.evidence, true⟩

def SnapshotInvariant {S O : Type} (needed valid : S → O → Prop)
    (s : SnapshotReview S O) : Prop :=
  (∀ snapshot o, s.evidence snapshot o → valid snapshot o) ∧
  (s.ready = true → ∀ o, needed s.current o → valid s.current o)

theorem snapshot_step_preserves {S O : Type} (needed valid : S → O → Prop)
    {s t : SnapshotReview S O} (safe : SnapshotInvariant needed valid s)
    (step : SnapshotStep needed valid s t) : SnapshotInvariant needed valid t := by
  cases step with
  | record snapshot o proof =>
    constructor
    · intro x q evidence
      rcases evidence with prior | ⟨sameSnapshot, sameObligation⟩
      · exact safe.1 x q prior
      · subst x; subst q; exact proof
    · intro impossible; cases impossible
  | edit snapshot =>
    exact ⟨safe.1, by intro impossible; cases impossible⟩
  | authorize complete =>
    exact ⟨safe.1, fun _ o required => safe.1 _ o (complete o required)⟩

theorem snapshot_ready_requires_current_proofs {S O : Type}
    (needed valid : S → O → Prop) {s : SnapshotReview S O}
    (reachable : Reach SnapshotInitial (SnapshotStep needed valid) s)
    (ready : s.ready = true) : ∀ o, needed s.current o → valid s.current o := by
  have invariant : SnapshotInvariant needed valid s := by
    apply reachable_invariant SnapshotInitial (SnapshotInvariant needed valid)
      (SnapshotStep needed valid) ?_ ?_ reachable
    · intro initial h
      constructor
      · intro snapshot o evidence; exact False.elim (h.1 snapshot o evidence)
      · intro impossible; rw [h.2] at impossible; cases impossible
    · intro _ _ preserved step
      exact snapshot_step_preserves needed valid preserved step
  exact invariant.2 ready

theorem snapshot_steps_retain_historical_evidence {S O : Type}
    (needed valid : S → O → Prop) {s t : SnapshotReview S O}
    (step : SnapshotStep needed valid s t) :
    ∀ snapshot o, s.evidence snapshot o → t.evidence snapshot o := by
  intro snapshot o old
  cases step with
  | record _ _ _ => exact Or.inl old
  | edit _ => exact old
  | authorize _ => exact old

def Needed {S O : Type} (root : O → Prop) (baseline : O → O → Prop)
    (candidate : S → O → O → Prop) (snapshot : S) : O → Prop :=
  Required root (fun o d => baseline o d ∨ candidate snapshot o d)

theorem baseline_dependencies_persist {S O : Type}
    (root : O → Prop) (baseline : O → O → Prop) (candidate : S → O → O → Prop)
    (snapshot : S) {o : O} (required : Required root baseline o) :
    Needed root baseline candidate snapshot o := by
  induction required with
  | root h => exact .root h
  | dependency _ edge ih => exact .dependency ih (Or.inl edge)

theorem ready_preserves_fixed_baseline_obligations {S O : Type}
    (root : O → Prop) (baseline : O → O → Prop) (candidate : S → O → O → Prop)
    (valid : S → O → Prop) {s : SnapshotReview S O}
    (reachable : Reach SnapshotInitial (SnapshotStep (Needed root baseline candidate) valid) s)
    (ready : s.ready = true) {o : O} (required : Required root baseline o) :
    valid s.current o := by
  exact snapshot_ready_requires_current_proofs _ _ reachable ready o
    (baseline_dependencies_persist root baseline candidate s.current required)

theorem changed_content_cannot_reuse_old_proof
    {s : SnapshotReview Bool Unit}
    (reachable : Reach SnapshotInitial
      (SnapshotStep (fun _ _ => True) (fun content _ => content = false)) s)
    (changed : s.current = true) : s.ready ≠ true := by
  intro ready
  have current := snapshot_ready_requires_current_proofs _ _ reachable ready () True.intro
  rw [changed] at current
  cases current

/- Instantiate validity with concrete graph semantics. The baseline and safety
   predicate belong to a fixed requirements epoch, outside candidate edits. -/
inductive GraphObligation (S E : Type)
  | initialization
  | determinism
  | baselineBehavior
  | edge : S → E → S → GraphObligation S E

abbrev GraphSnapshot (S E : Type) := S × List ((S × E) × S)

def GraphNeeded {S E : Type} (snapshot : GraphSnapshot S E) : GraphObligation S E → Prop
  | .initialization => True
  | .determinism => True
  | .baselineBehavior => True
  | .edge s e t => ((s, e), t) ∈ snapshot.2

def GraphValid {S E : Type} [DecidableEq S] [DecidableEq E]
    (baseline : GraphSnapshot S E) (safe : S → Prop)
    (snapshot : GraphSnapshot S E) : GraphObligation S E → Prop
  | .initialization => safe snapshot.1 ∧ snapshot.1 = baseline.1
  | .determinism => Functional snapshot.2
  | .baselineBehavior => Functional baseline.2 ∧
      ∀ s e, tableLookup snapshot.2 (s, e) = tableLookup baseline.2 (s, e)
  | .edge s _ t => safe s → safe t

theorem ready_graph_execution_safe {S E : Type} [DecidableEq S] [DecidableEq E]
    (baseline : GraphSnapshot S E) (safe : S → Prop)
    {review : SnapshotReview (GraphSnapshot S E) (GraphObligation S E)}
    (reachable : Reach SnapshotInitial (SnapshotStep GraphNeeded (GraphValid baseline safe)) review)
    (ready : review.ready = true) (events : List E) :
    safe (run review.current.2 review.current.1 events) := by
  have proofs := snapshot_ready_requires_current_proofs _ _ reachable ready
  apply arbitrary_finite_execution_safe review.current.2 safe
  · intro s e t hs edge
    exact proofs (.edge s e t) edge hs
  · exact (proofs .initialization True.intro).1

theorem ready_graph_dispatch_exact {S E : Type} [DecidableEq S] [DecidableEq E]
    (baseline : GraphSnapshot S E) (safe : S → Prop)
    {review : SnapshotReview (GraphSnapshot S E) (GraphObligation S E)}
    (reachable : Reach SnapshotInitial (SnapshotStep GraphNeeded (GraphValid baseline safe)) review)
    (ready : review.ready = true) (s : S) (e : E) (t : S) :
    evalDispatch (compileTable review.current.2) (s, e) = some t ↔ ((s, e), t) ∈ review.current.2 := by
  have proofs := snapshot_ready_requires_current_proofs _ _ reachable ready
  exact generated_dispatch_exact review.current.2 (proofs .determinism True.intro) (s, e) t

theorem ready_graph_preserves_baseline_dispatch {S E : Type} [DecidableEq S] [DecidableEq E]
    (baseline : GraphSnapshot S E) (safe : S → Prop)
    {review : SnapshotReview (GraphSnapshot S E) (GraphObligation S E)}
    (reachable : Reach SnapshotInitial (SnapshotStep GraphNeeded (GraphValid baseline safe)) review)
    (ready : review.ready = true) (s : S) (e : E) :
    evalDispatch (compileTable review.current.2) (s, e) = evalDispatch (compileTable baseline.2) (s, e) := by
  have proofs := snapshot_ready_requires_current_proofs _ _ reachable ready
  simpa [compilation_preserves_lookup] using (proofs .baselineBehavior True.intro).2 s e

theorem ready_graph_preserves_baseline_relation {S E : Type} [DecidableEq S] [DecidableEq E]
    (baseline : GraphSnapshot S E) (safe : S → Prop)
    {review : SnapshotReview (GraphSnapshot S E) (GraphObligation S E)}
    (reachable : Reach SnapshotInitial (SnapshotStep GraphNeeded (GraphValid baseline safe)) review)
    (ready : review.ready = true) (s : S) (e : E) (t : S) :
    evalDispatch (compileTable review.current.2) (s, e) = some t ↔ ((s, e), t) ∈ baseline.2 := by
  have proofs := snapshot_ready_requires_current_proofs _ _ reachable ready
  rw [ready_graph_preserves_baseline_dispatch baseline safe reachable ready s e]
  exact generated_dispatch_exact baseline.2 (proofs .baselineBehavior True.intro).1 (s, e) t

def approvalSnapshot : GraphSnapshot (Bool × Bool) Bool := ((false, false), approval)

theorem concrete_graph_review_can_finish :
    ∃ review : SnapshotReview (GraphSnapshot (Bool × Bool) Bool) (GraphObligation (Bool × Bool) Bool),
      Reach SnapshotInitial (SnapshotStep GraphNeeded (GraphValid approvalSnapshot ApprovalSafe)) review ∧
      review.current = approvalSnapshot ∧ review.ready = true := by
  let initial : SnapshotReview (GraphSnapshot (Bool × Bool) Bool) (GraphObligation (Bool × Bool) Bool) :=
    ⟨approvalSnapshot, fun _ _ => False, false⟩
  have start : Reach SnapshotInitial (SnapshotStep GraphNeeded (GraphValid approvalSnapshot ApprovalSafe)) initial :=
    .start ⟨(fun _ _ h => h), rfl⟩
  have r1 := Reach.advance start
    (SnapshotStep.record initial approvalSnapshot .initialization ⟨approval_initial_safe, rfl⟩)
  have r2 := Reach.advance r1
    (SnapshotStep.record _ approvalSnapshot (GraphObligation.determinism : GraphObligation (Bool × Bool) Bool) (by exact approval_functional))
  have r3 := Reach.advance r2
    (SnapshotStep.record _ approvalSnapshot (GraphObligation.baselineBehavior : GraphObligation (Bool × Bool) Bool)
      ⟨approval_functional, fun _ _ => rfl⟩)
  have r4 := Reach.advance r3
    (SnapshotStep.record _ approvalSnapshot (.edge (false, false) false (false, true))
      (by intro _; unfold ApprovalSafe; decide))
  have r5 := Reach.advance r4
    (SnapshotStep.record _ approvalSnapshot (.edge (false, true) true (true, true))
      (by intro _; unfold ApprovalSafe; decide))
  have finished := Reach.advance r5 (SnapshotStep.authorize _ (by
    intro obligation needed
    cases obligation with
    | initialization => simp [initial]
    | determinism => simp [initial]
    | baselineBehavior => simp [initial]
    | edge s e t =>
      simp [GraphNeeded, initial, approvalSnapshot, approval] at needed
      rcases needed with h | h <;> simp_all [initial]))
  exact ⟨_, finished, rfl, rfl⟩

inductive VerificationClaim
  | diagnosticObservation
  | nativeConformance
  deriving DecidableEq

/- This evidence context contains only diagnostic justification. False means
   absent justification, not a claim that the native program is unsafe. -/
def DiagnosticJustification (_ : Unit) (claim : VerificationClaim) : Prop :=
  claim = .diagnosticObservation

theorem diagnostic_only_evidence_cannot_authorize_native_claim
    {review : SnapshotReview Unit VerificationClaim}
    (reachable : Reach SnapshotInitial
      (SnapshotStep (fun _ claim => claim = .nativeConformance) DiagnosticJustification) review) :
    review.ready ≠ true := by
  intro ready
  have unsupported := snapshot_ready_requires_current_proofs _ _ reachable ready
    VerificationClaim.nativeConformance rfl
  cases unsupported

theorem diagnostic_evidence_can_be_recorded_without_native_authority :
    ∃ review : SnapshotReview Unit VerificationClaim,
      Reach SnapshotInitial
        (SnapshotStep (fun _ claim => claim = .nativeConformance) DiagnosticJustification) review ∧
      review.evidence () .diagnosticObservation ∧ review.ready = false := by
  let initial : SnapshotReview Unit VerificationClaim := ⟨(), fun _ _ => False, false⟩
  have start : Reach SnapshotInitial
      (SnapshotStep (fun _ claim => claim = .nativeConformance) DiagnosticJustification) initial :=
    .start ⟨fun _ _ impossible => impossible, rfl⟩
  have recorded := Reach.advance start
    (SnapshotStep.record initial () VerificationClaim.diagnosticObservation rfl)
  exact ⟨_, recorded, Or.inr ⟨rfl, rfl⟩, rfl⟩

theorem changed_policy_changes_generated_decision {K V : Type} [DecidableEq K]
    (before after : List (K × V)) (functional : Functional before)
    (sameRequest : K) (oldSuccessor : V)
    (wasAllowed : (sameRequest, oldSuccessor) ∈ before)
    (nowForbidden : ¬ ∃ v, (sameRequest, v) ∈ after) :
    evalDispatch (compileTable before) sameRequest = some oldSuccessor ∧
    evalDispatch (compileTable after) sameRequest = none := by
  exact ⟨(generated_dispatch_exact before functional sameRequest oldSuccessor).2 wasAllowed,
    (generated_rejection_exact after sameRequest).2 nowForbidden⟩

/- Development changes programs, while the generated authority and its owned
   state remain outside those edits. This is a mathematical language boundary,
   not a claim that a native linter already enforces it. -/
structure DevelopmentState (S E D : Type) where
  program : List (Command S E D)
  machine : S × D

inductive DevelopmentStep {S E D : Type} [DecidableEq S] [DecidableEq E]
    (table : List ((S × E) × S)) :
    DevelopmentState S E D → DevelopmentState S E D → Prop
  | edit (program replacement : List (Command S E D)) (machine : S × D) :
      DevelopmentStep table ⟨program, machine⟩ ⟨replacement, machine⟩
  | execute (command : Command S E D) (rest : List (Command S E D)) (machine : S × D) :
      DevelopmentStep table ⟨command :: rest, machine⟩
        ⟨rest, commandStep table command machine⟩

def SpecificationEdge {S E : Type} (table : List ((S × E) × S)) (s t : S) : Prop :=
  ∃ e, ((s, e), t) ∈ table

theorem generated_execution_is_stutter_or_specification_edge
    {S E : Type} [DecidableEq S] [DecidableEq E]
    (table : List ((S × E) × S)) (s : S) (e : E) :
    s = execute table s e ∨ SpecificationEdge table s (execute table s e) := by
  cases h : tableLookup table (s, e) with
  | none => exact Or.inl (rejection_preserves_state table s e h).symm
  | some t =>
    right
    refine ⟨e, ?_⟩
    simpa [execute, compilation_preserves_lookup, h] using lookup_sound table (s, e) t h

theorem development_step_obeys_generated_constraint
    {S E D : Type} [DecidableEq S] [DecidableEq E]
    (table : List ((S × E) × S)) {a b : DevelopmentState S E D}
    (step : DevelopmentStep table a b) :
    a.machine.1 = b.machine.1 ∨ SpecificationEdge table a.machine.1 b.machine.1 := by
  cases step with
  | edit => exact Or.inl rfl
  | execute command rest machine =>
    cases command with
    | internal body => exact Or.inl rfl
    | request choose => exact generated_execution_is_stutter_or_specification_edge table _ _

theorem arbitrary_development_preserves_specification_reachability
    {S E D : Type} [DecidableEq S] [DecidableEq E]
    (table : List ((S × E) × S)) (initial : S → Prop)
    {current : DevelopmentState S E D}
    (history : Reach (fun s : DevelopmentState S E D => initial s.machine.1)
      (DevelopmentStep table) current) :
    Reach initial (SpecificationEdge table) current.machine.1 := by
  exact local_obligations_lift _ _ initial (SpecificationEdge table)
    (fun s : DevelopmentState S E D => s.machine.1)
    (fun _ h => h)
    (fun _ _ step => development_step_obeys_generated_constraint table step) history

theorem arbitrary_development_preserves_specification_safety
    {S E D : Type} [DecidableEq S] [DecidableEq E]
    (table : List ((S × E) × S)) (initial safe : S → Prop)
    (base : ∀ s, initial s → safe s)
    (closed : ∀ s e t, safe s → ((s, e), t) ∈ table → safe t)
    {current : DevelopmentState S E D}
    (history : Reach (fun s : DevelopmentState S E D => initial s.machine.1)
      (DevelopmentStep table) current) : safe current.machine.1 := by
  apply reachable_invariant initial safe (SpecificationEdge table) base
    (fun s t hs edge => ?_)
    (arbitrary_development_preserves_specification_reachability table initial history)
  obtain ⟨e, he⟩ := edge
  exact closed s e t hs he

theorem development_can_edit_then_make_progress :
    Reach (fun s : DevelopmentState Bool Unit Unit => s.machine.1 = false)
      (DevelopmentStep once) ⟨[], (true, ())⟩ := by
  have start : Reach (fun s : DevelopmentState Bool Unit Unit => s.machine.1 = false)
      (DevelopmentStep once) ⟨[], (false, ())⟩ := Reach.start rfl
  have edited := Reach.advance start
    (DevelopmentStep.edit (table := once) [] [Command.request (fun _ _ => ())] (false, ()))
  exact Reach.advance edited
    (DevelopmentStep.execute (table := once) (Command.request (fun _ _ => ())) [] (false, ()))

end SGDMethod

#print axioms SGDMethod.generated_execution_is_stutter_or_specification_edge
#print axioms SGDMethod.development_step_obeys_generated_constraint
#print axioms SGDMethod.arbitrary_development_preserves_specification_reachability
#print axioms SGDMethod.arbitrary_development_preserves_specification_safety
#print axioms SGDMethod.development_can_edit_then_make_progress

#print axioms SGDMethod.lookup_exact
#print axioms SGDMethod.generated_dispatch_exact
#print axioms SGDMethod.generated_rejection_exact
#print axioms SGDMethod.arbitrary_finite_execution_safe
#print axioms SGDMethod.local_obligations_lift
#print axioms SGDMethod.local_contracts_lift
#print axioms SGDMethod.method_safety_from_local_contracts
#print axioms SGDMethod.composition
#print axioms SGDMethod.change_preserves_baseline
#print axioms SGDMethod.existential_projection_is_not_authority
#print axioms SGDMethod.restricted_program_safe
#print axioms SGDMethod.once_is_functional
#print axioms SGDMethod.allowed_then_forbidden
#print axioms SGDMethod.reset_bypasses_per_object_limit
#print axioms SGDMethod.coverage_from_local_dependencies
#print axioms SGDMethod.missing_dependency_blocks_coverage
#print axioms SGDMethod.old_evidence_cannot_cover_new_revision
#print axioms SGDMethod.leaf_safety_does_not_imply_joint
#print axioms SGDMethod.candidate_self_check_does_not_preserve_baseline
#print axioms SGDMethod.omitted_obligation_can_fail
#print axioms SGDMethod.weakening_has_reachable_baseline_violation
#print axioms SGDMethod.generated_nontrivial_safety
#print axioms SGDMethod.omitted_transitive_requirement_blocks
#print axioms SGDMethod.development_ready_requires_current_proofs
#print axioms SGDMethod.development_protocol_can_be_ready
#print axioms SGDMethod.approval_functional
#print axioms SGDMethod.approval_closed
#print axioms SGDMethod.approval_initial_safe
#print axioms SGDMethod.approval_positive_and_negative
#print axioms SGDMethod.approval_all_finite_executions_safe
#print axioms SGDMethod.direct_write_breaks_approval
#print axioms SGDMethod.invalid_revision_cannot_be_ready
#print axioms SGDMethod.missing_required_dependency_cannot_be_ready
#print axioms SGDMethod.snapshot_ready_requires_current_proofs
#print axioms SGDMethod.snapshot_steps_retain_historical_evidence
#print axioms SGDMethod.baseline_dependencies_persist
#print axioms SGDMethod.ready_preserves_fixed_baseline_obligations
#print axioms SGDMethod.changed_content_cannot_reuse_old_proof
#print axioms SGDMethod.ready_graph_execution_safe
#print axioms SGDMethod.ready_graph_dispatch_exact
#print axioms SGDMethod.ready_graph_preserves_baseline_dispatch
#print axioms SGDMethod.concrete_graph_review_can_finish
#print axioms SGDMethod.ready_graph_preserves_baseline_relation
#print axioms SGDMethod.diagnostic_only_evidence_cannot_authorize_native_claim
#print axioms SGDMethod.diagnostic_evidence_can_be_recorded_without_native_authority
#print axioms SGDMethod.changed_policy_changes_generated_decision
