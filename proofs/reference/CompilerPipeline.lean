import Method

/- Formal supported-source pipeline only. `Fin n` is the ENTIRE source state
   domain, not a bounded sample of an unbounded system and not an existential
   projection. Every state is enumerated. Events may be actor/event pairs.

   These definitions are not a parser or a product compiler implementation.
   Actual TLA+/SANY/TLC/DOT and native text parsers require separate faithful
   correspondence. Successful compilation proves transition fidelity, not an
   arbitrary invariant of an unsafe source policy. Unsupported syntax is refused
   even in an unreachable branch. Nondeterminism is outside the deterministic
   authority profile, not evidence that the source itself is unsafe.
-/
namespace SGDCompilerPipeline
open SGDMethod

inductive Guard (n : Nat)
  | literal : Bool → Guard n
  | stateIs : Fin n → Guard n
  | negate : Guard n → Guard n
  | both : Guard n → Guard n → Guard n
  | either : Guard n → Guard n → Guard n
  | unsupported : Nat → Guard n

inductive Update (n : Nat)
  | keep : Update n
  | set : Fin n → Update n
  | branch : Guard n → Update n → Update n → Update n
  | unsupported : Nat → Update n

/- Independent denotational meaning of raw syntax; None denotes undefined
   semantics for an unsupported construct, never an allowed transition.
-/
def guardMeaning {n : Nat} : Guard n → Fin n → Option Bool
  | .literal value, _ => some value
  | .stateIs expected, state => some (decide (state = expected))
  | .negate body, state => (guardMeaning body state).map Bool.not
  | .both left right, state => do
      let a ← guardMeaning left state
      let b ← guardMeaning right state
      return a && b
  | .either left right, state => do
      let a ← guardMeaning left state
      let b ← guardMeaning right state
      return a || b
  | .unsupported _, _ => none

def updateMeaning {n : Nat} : Update n → Fin n → Option (Fin n)
  | .keep, state => some state
  | .set next, _ => some next
  | .branch condition yes no, state => do
      let selected ← guardMeaning condition state
      if selected then updateMeaning yes state else updateMeaning no state
  | .unsupported _, _ => none

/- Source-profile membership is independent of the executable checker. -/
def GuardAdmitted {n : Nat} : Guard n → Prop
  | .literal _ => True
  | .stateIs _ => True
  | .negate body => GuardAdmitted body
  | .both left right => GuardAdmitted left ∧ GuardAdmitted right
  | .either left right => GuardAdmitted left ∧ GuardAdmitted right
  | .unsupported _ => False

def UpdateAdmitted {n : Nat} : Update n → Prop
  | .keep => True
  | .set _ => True
  | .branch condition yes no => GuardAdmitted condition ∧ UpdateAdmitted yes ∧ UpdateAdmitted no
  | .unsupported _ => False

def checkGuard {n : Nat} : Guard n → Bool
  | .literal _ => true
  | .stateIs _ => true
  | .negate body => checkGuard body
  | .both left right => checkGuard left && checkGuard right
  | .either left right => checkGuard left && checkGuard right
  | .unsupported _ => false

def checkUpdate {n : Nat} : Update n → Bool
  | .keep => true
  | .set _ => true
  | .branch condition yes no => checkGuard condition && (checkUpdate yes && checkUpdate no)
  | .unsupported _ => false

theorem guard_check_exact {n : Nat} (guard : Guard n) :
    checkGuard guard = true ↔ GuardAdmitted guard := by
  induction guard <;> simp_all [checkGuard, GuardAdmitted]

theorem update_check_exact {n : Nat} (update : Update n) :
    checkUpdate update = true ↔ UpdateAdmitted update := by
  induction update <;> simp_all [checkUpdate, UpdateAdmitted, guard_check_exact]

theorem admitted_guard_has_meaning {n : Nat} (guard : Guard n) (state : Fin n)
    (admitted : GuardAdmitted guard) : ∃ value, guardMeaning guard state = some value := by
  induction guard with
  | literal value => exact ⟨value, rfl⟩
  | stateIs expected => exact ⟨decide (state = expected), rfl⟩
  | unsupported tag => exact False.elim admitted
  | negate body ih =>
      obtain ⟨value, means⟩ := ih admitted
      exact ⟨!value, by simp [guardMeaning, means]⟩
  | both left right leftIH rightIH =>
      obtain ⟨a, leftMeans⟩ := leftIH admitted.1
      obtain ⟨b, rightMeans⟩ := rightIH admitted.2
      exact ⟨a && b, by simp [guardMeaning, leftMeans, rightMeans]⟩
  | either left right leftIH rightIH =>
      obtain ⟨a, leftMeans⟩ := leftIH admitted.1
      obtain ⟨b, rightMeans⟩ := rightIH admitted.2
      exact ⟨a || b, by simp [guardMeaning, leftMeans, rightMeans]⟩

theorem admitted_update_has_meaning {n : Nat} (update : Update n) (state : Fin n)
    (admitted : UpdateAdmitted update) : ∃ next, updateMeaning update state = some next := by
  induction update with
  | keep => exact ⟨state, rfl⟩
  | set next => exact ⟨next, rfl⟩
  | unsupported tag => exact False.elim admitted
  | branch condition yes no yesIH noIH =>
      obtain ⟨selected, conditionMeans⟩ := admitted_guard_has_meaning condition state admitted.1
      cases selected with
      | false =>
          obtain ⟨next, means⟩ := noIH admitted.2.2
          exact ⟨next, by simp [updateMeaning, conditionMeans, means]⟩
      | true =>
          obtain ⟨next, means⟩ := yesIH admitted.2.1
          exact ⟨next, by simp [updateMeaning, conditionMeans, means]⟩

structure Rule (n : Nat) (E : Type) where
  event : E
  guard : Guard n
  update : Update n

structure Source (n : Nat) (E : Type) where
  initial : Fin n
  rules : List (Rule n E)

def SourceAdmitted {n : Nat} {E : Type} (source : Source n E) : Prop :=
  ∀ rule ∈ source.rules, GuardAdmitted rule.guard ∧ UpdateAdmitted rule.update

def checkSource {n : Nat} {E : Type} (source : Source n E) : Bool :=
  source.rules.all (fun rule => checkGuard rule.guard && checkUpdate rule.update)

theorem source_check_exact {n : Nat} {E : Type} (source : Source n E) :
    checkSource source = true ↔ SourceAdmitted source := by
  simp [checkSource, SourceAdmitted, List.all_eq_true, guard_check_exact, update_check_exact]

def SourceStep {n : Nat} {E : Type} (source : Source n E)
    (state : Fin n) (event : E) (next : Fin n) : Prop :=
  ∃ rule ∈ source.rules,
    rule.event = event ∧ guardMeaning rule.guard state = some true ∧
      updateMeaning rule.update state = some next

def SourceDeterministic {n : Nat} {E : Type} (source : Source n E) : Prop :=
  ∀ state event first second,
    SourceStep source state event first → SourceStep source state event second → first = second

/- Constructive exhaustive extraction. This function does not invoke or trust
   an external state graph or a supplied success receipt.
-/
def extractAt {n : Nat} {E : Type} (state : Fin n) (rule : Rule n E) :
    List (((Fin n) × E) × Fin n) :=
  match guardMeaning rule.guard state, updateMeaning rule.update state with
  | some true, some next => [((state, rule.event), next)]
  | _, _ => []

def extract {n : Nat} {E : Type} (source : Source n E) :
    List (((Fin n) × E) × Fin n) :=
  (List.finRange n).flatMap (fun state => source.rules.flatMap (extractAt state))

theorem extract_at_membership {n : Nat} {E : Type}
    (state : Fin n) (rule : Rule n E) (entry : ((Fin n × E) × Fin n)) :
    entry ∈ extractAt state rule ↔
      ∃ next, guardMeaning rule.guard state = some true ∧
        updateMeaning rule.update state = some next ∧ entry = ((state, rule.event), next) := by
  cases condition : guardMeaning rule.guard state with
  | none => simp [extractAt, condition]
  | some selected =>
      cases selected with
      | false => simp [extractAt, condition]
      | true =>
          cases update : updateMeaning rule.update state with
          | none => simp [extractAt, condition, update]
          | some next => simp [extractAt, condition, update]

theorem extracted_edges_exact {n : Nat} {E : Type} (source : Source n E)
    (state : Fin n) (event : E) (next : Fin n) :
    ((state, event), next) ∈ extract source ↔ SourceStep source state event next := by
  constructor
  · intro member
    obtain ⟨listed, _, atState⟩ := List.mem_flatMap.mp member
    obtain ⟨rule, inSource, atRule⟩ := List.mem_flatMap.mp atState
    obtain ⟨actualNext, enabled, updated, same⟩ := (extract_at_membership listed rule _).mp atRule
    have stateSame : state = listed := congrArg (fun edge => edge.1.1) same
    have eventSame : event = rule.event := congrArg (fun edge => edge.1.2) same
    have nextSame : next = actualNext := congrArg Prod.snd same
    subst listed
    subst actualNext
    exact ⟨rule, inSource, eventSame.symm, enabled, updated⟩
  · rintro ⟨rule, inSource, eventSame, enabled, updated⟩
    apply List.mem_flatMap.mpr
    refine ⟨state, List.mem_finRange state, ?_⟩
    apply List.mem_flatMap.mpr
    refine ⟨rule, inSource, ?_⟩
    apply (extract_at_membership state rule _).mpr
    exact ⟨next, enabled, updated, by simp [eventSame]⟩

def checkFunctional {K V : Type} [DecidableEq K] [DecidableEq V]
    (table : List (K × V)) : Bool :=
  table.all (fun left => table.all (fun right =>
    decide (left.1 = right.1 → left.2 = right.2)))

theorem functional_check_exact {K V : Type} [DecidableEq K] [DecidableEq V]
    (table : List (K × V)) : checkFunctional table = true ↔ Functional table := by
  simp only [checkFunctional, List.all_eq_true, decide_eq_true_eq]
  constructor
  · intro consistent key first second a b
    exact consistent (key, first) a (key, second) b rfl
  · intro functional left inLeft right inRight sameKey
    rcases left with ⟨key, first⟩
    rcases right with ⟨otherKey, second⟩
    simp only at sameKey
    subst otherKey
    exact functional key first second inLeft inRight

theorem extracted_functionality_exact {n : Nat} {E : Type} (source : Source n E) :
    Functional (extract source) ↔ SourceDeterministic source := by
  constructor
  · intro functional state event first second firstStep secondStep
    exact functional (state, event) first second
      ((extracted_edges_exact source state event first).mpr firstStep)
      ((extracted_edges_exact source state event second).mpr secondStep)
  · intro deterministic key first second firstMember secondMember
    rcases key with ⟨state, event⟩
    exact deterministic state event first second
      ((extracted_edges_exact source state event first).mp firstMember)
      ((extracted_edges_exact source state event second).mp secondMember)

structure TypedAutomaton (S E : Type) where
  initial : S
  table : List ((S × E) × S)
  functional : Functional table

inductive CompileError
  | unsupported
  | ambiguous
  deriving DecidableEq

def compileSource {n : Nat} {E : Type} [DecidableEq E] (source : Source n E) :
    Except CompileError (TypedAutomaton (Fin n) E) :=
  if _supported : checkSource source = true then
    if deterministic : checkFunctional (extract source) = true then
      .ok ⟨source.initial, extract source, (functional_check_exact _).mp deterministic⟩
    else .error .ambiguous
  else .error .unsupported

theorem compile_success_shape {n : Nat} {E : Type} [DecidableEq E]
    (source : Source n E) (automaton : TypedAutomaton (Fin n) E)
    (compiled : compileSource source = .ok automaton) :
    SourceAdmitted source ∧ automaton.initial = source.initial ∧ automaton.table = extract source := by
  unfold compileSource at compiled
  split at compiled
  · rename_i supported
    split at compiled
    · cases compiled
      exact ⟨(source_check_exact source).mp supported, rfl, rfl⟩
    · cases compiled
  · cases compiled

theorem compile_success_iff_admitted_deterministic {n : Nat} {E : Type} [DecidableEq E]
    (source : Source n E) :
    (∃ automaton, compileSource source = .ok automaton) ↔
      SourceAdmitted source ∧ SourceDeterministic source := by
  constructor
  · rintro ⟨automaton, compiled⟩
    obtain ⟨supported, _, table⟩ := compile_success_shape source automaton compiled
    refine ⟨supported, (extracted_functionality_exact source).mp ?_⟩
    rw [← table]
    exact automaton.functional
  · rintro ⟨supported, deterministic⟩
    have supports := (source_check_exact source).mpr supported
    have checks := (functional_check_exact (extract source)).mpr
      ((extracted_functionality_exact source).mpr deterministic)
    simp only [compileSource, supports, checks, ↓reduceDIte]
    exact ⟨_, rfl⟩

theorem unsupported_source_is_refused {n : Nat} {E : Type} [DecidableEq E]
    (source : Source n E) (unsupported : ¬ SourceAdmitted source) :
    compileSource source = .error .unsupported := by
  have notSupported : checkSource source ≠ true := fun h => unsupported ((source_check_exact source).mp h)
  simp [compileSource, notSupported]

theorem ambiguous_source_is_refused {n : Nat} {E : Type} [DecidableEq E]
    (source : Source n E) (supported : SourceAdmitted source)
    (ambiguous : ¬ SourceDeterministic source) :
    compileSource source = .error .ambiguous := by
  have supports := (source_check_exact source).mpr supported
  have notDeterministic : checkFunctional (extract source) ≠ true := by
    intro h
    exact ambiguous ((extracted_functionality_exact source).mp ((functional_check_exact _).mp h))
  simp [compileSource, supports, notDeterministic]

theorem compile_success_accepts_iff_source_step {n : Nat} {E : Type} [DecidableEq E]
    (source : Source n E) (automaton : TypedAutomaton (Fin n) E)
    (compiled : compileSource source = .ok automaton)
    (state : Fin n) (event : E) (next : Fin n) :
    evalDispatch (compileTable automaton.table) (state, event) = some next ↔
      SourceStep source state event next := by
  rw [generated_dispatch_exact automaton.table automaton.functional]
  rw [(compile_success_shape source automaton compiled).2.2]
  exact extracted_edges_exact source state event next

theorem compile_success_rejects_iff_no_source_step {n : Nat} {E : Type} [DecidableEq E]
    (source : Source n E) (automaton : TypedAutomaton (Fin n) E)
    (compiled : compileSource source = .ok automaton)
    (state : Fin n) (event : E) :
    evalDispatch (compileTable automaton.table) (state, event) = none ↔
      ¬ ∃ next, SourceStep source state event next := by
  rw [generated_rejection_exact]
  rw [(compile_success_shape source automaton compiled).2.2]
  simp only [extracted_edges_exact]

/- Safety is a consequence of separate source obligations, not a consequence of
   determinism or compilation alone. -/
theorem compiled_authority_preserves_source_invariant
    {n : Nat} {E : Type} [DecidableEq E]
    (source : Source n E) (automaton : TypedAutomaton (Fin n) E)
    (compiled : compileSource source = .ok automaton)
    (safe : Fin n → Prop) (initialSafe : safe source.initial)
    (edgeSafe : ∀ state event next, safe state → SourceStep source state event next → safe next)
    (requests : List E) : safe (run automaton.table automaton.initial requests) := by
  apply arbitrary_finite_execution_safe automaton.table safe
  · intro state event next safeBefore member
    rw [(compile_success_shape source automaton compiled).2.2] at member
    exact edgeSafe state event next safeBefore ((extracted_edges_exact source state event next).mp member)
  · simpa [(compile_success_shape source automaton compiled).2.1] using initialSafe

/- Reachable-only graph validation. An external graph is compilation input,
   never authority merely because a tool emitted it. Routes are finite static
   path certificates checked against the independently extracted source table;
   they are not retained runtime execution logs. All graph edges and all source
   successors of included nodes are checked, so reachable closure cannot omit a
   guard outcome. Raw text parsing/complete-label decoding is still external.
-/
structure ExactGraph (S E : Type) where
  initial : S
  nodes : List S
  table : List ((S × E) × S)
  routes : List (List (E × S))

def TableStep {S E : Type} (table : List ((S × E) × S)) (state next : S) : Prop :=
  ∃ event, ((state, event), next) ∈ table

def walk {S E : Type} [DecidableEq S] [DecidableEq E]
    (table : List ((S × E) × S)) : S → List (E × S) → Option S
  | state, [] => some state
  | state, (event, next) :: rest =>
      if ((state, event), next) ∈ table then walk table next rest else none

theorem walk_preserves_reachability {S E : Type} [DecidableEq S] [DecidableEq E]
    (table : List ((S × E) × S)) (initial : S → Prop)
    (route : List (E × S)) (state next : S)
    (atState : Reach initial (TableStep table) state)
    (checked : walk table state route = some next) :
    Reach initial (TableStep table) next := by
  induction route generalizing state with
  | nil =>
      simp only [walk, Option.some.injEq] at checked
      simpa [checked] using atState
  | cons entry rest ih =>
      rcases entry with ⟨event, middle⟩
      by_cases member : ((state, event), middle) ∈ table
      · have tail : walk table middle rest = some next := by simpa [walk, member] using checked
        exact ih middle (.advance atState ⟨event, member⟩) tail
      · simp [walk, member] at checked

/- Pointwise finite validation obligations; no graph-faithfulness premise is
   assumed. Correctness below derives source reachability in BOTH directions.
-/
def GraphChecks {S E : Type} [DecidableEq S] [DecidableEq E]
    (reference : TypedAutomaton S E) (graph : ExactGraph S E) : Prop :=
  graph.initial = reference.initial ∧ graph.initial ∈ graph.nodes ∧
  (∀ node ∈ graph.nodes, ∃ route ∈ graph.routes,
    walk reference.table reference.initial route = some node) ∧
  (∀ entry ∈ graph.table, entry ∈ reference.table ∧ entry.1.1 ∈ graph.nodes ∧ entry.2 ∈ graph.nodes) ∧
  (∀ entry ∈ reference.table, entry.1.1 ∈ graph.nodes → entry ∈ graph.table)

def checkGraph {S E : Type} [DecidableEq S] [DecidableEq E]
    (reference : TypedAutomaton S E) (graph : ExactGraph S E) : Bool :=
  decide (graph.initial = reference.initial) &&
  (decide (graph.initial ∈ graph.nodes) &&
  (graph.nodes.all (fun node => graph.routes.any (fun route =>
      decide (walk reference.table reference.initial route = some node))) &&
  (graph.table.all (fun entry => decide
      (entry ∈ reference.table ∧ entry.1.1 ∈ graph.nodes ∧ entry.2 ∈ graph.nodes)) &&
   reference.table.all (fun entry => decide
      (entry.1.1 ∈ graph.nodes → entry ∈ graph.table)))))

theorem graph_check_exact {S E : Type} [DecidableEq S] [DecidableEq E]
    (reference : TypedAutomaton S E) (graph : ExactGraph S E) :
    checkGraph reference graph = true ↔ GraphChecks reference graph := by
  simp only [checkGraph, Bool.and_eq_true, List.all_eq_true, List.any_eq_true,
    decide_eq_true_eq, GraphChecks]

theorem checked_graph_is_functional {S E : Type} [DecidableEq S] [DecidableEq E]
    (reference : TypedAutomaton S E) (graph : ExactGraph S E)
    (checked : checkGraph reference graph = true) : Functional graph.table := by
  have requirements := (graph_check_exact reference graph).mp checked
  intro key first second a b
  exact reference.functional key first second
    (requirements.2.2.2.1 _ a).1 (requirements.2.2.2.1 _ b).1

theorem checked_graph_source_reachability_included {S E : Type} [DecidableEq S] [DecidableEq E]
    (reference : TypedAutomaton S E) (graph : ExactGraph S E)
    (checked : checkGraph reference graph = true) {state : S}
    (sourceReach : Reach (fun s => s = reference.initial) (TableStep reference.table) state) :
    Reach (fun s => s = graph.initial) (TableStep graph.table) state ∧ state ∈ graph.nodes := by
  have requirements := (graph_check_exact reference graph).mp checked
  induction sourceReach with
  | @start reached initial =>
      refine ⟨.start (initial.trans requirements.1.symm), ?_⟩
      rw [initial]
      simpa [requirements.1] using requirements.2.1
  | @advance before after previous edge ih =>
      obtain ⟨event, sourceMember⟩ := edge
      have graphMember := requirements.2.2.2.2 _ sourceMember ih.2
      exact ⟨.advance ih.1 ⟨event, graphMember⟩, (requirements.2.2.2.1 _ graphMember).2.2⟩

theorem checked_graph_reachability_exact {S E : Type} [DecidableEq S] [DecidableEq E]
    (reference : TypedAutomaton S E) (graph : ExactGraph S E)
    (checked : checkGraph reference graph = true) (state : S) :
    Reach (fun s => s = graph.initial) (TableStep graph.table) state ↔
      Reach (fun s => s = reference.initial) (TableStep reference.table) state := by
  constructor
  · intro graphReach
    have requirements := (graph_check_exact reference graph).mp checked
    induction graphReach with
    | start initial => exact .start (initial.trans requirements.1)
    | advance previous edge ih =>
        obtain ⟨event, member⟩ := edge
        exact .advance ih ⟨event, (requirements.2.2.2.1 _ member).1⟩
  · intro sourceReach
    exact (checked_graph_source_reachability_included reference graph checked sourceReach).1

theorem checked_graph_nodes_exact {S E : Type} [DecidableEq S] [DecidableEq E]
    (reference : TypedAutomaton S E) (graph : ExactGraph S E)
    (checked : checkGraph reference graph = true) (state : S) :
    state ∈ graph.nodes ↔ Reach (fun s => s = reference.initial) (TableStep reference.table) state := by
  constructor
  · intro member
    have requirements := (graph_check_exact reference graph).mp checked
    obtain ⟨route, _, valid⟩ := requirements.2.2.1 state member
    exact walk_preserves_reachability reference.table _ route reference.initial state (.start rfl) valid
  · intro reachable
    exact (checked_graph_source_reachability_included reference graph checked reachable).2

theorem checked_graph_edges_exact_on_nodes {S E : Type} [DecidableEq S] [DecidableEq E]
    (reference : TypedAutomaton S E) (graph : ExactGraph S E)
    (checked : checkGraph reference graph = true) (state : S) (event : E) (next : S)
    (included : state ∈ graph.nodes) :
    ((state, event), next) ∈ graph.table ↔ ((state, event), next) ∈ reference.table := by
  have requirements := (graph_check_exact reference graph).mp checked
  exact ⟨fun h => (requirements.2.2.2.1 _ h).1,
    fun h => requirements.2.2.2.2 _ h included⟩

inductive GraphInput (S E : Type)
  | exact : ExactGraph S E → GraphInput S E
  | projected : GraphInput S E
  | unsupported : GraphInput S E

inductive GraphImportError
  | source : CompileError → GraphImportError
  | inexactLabels
  | invalidGraph
  deriving DecidableEq

/- The input tag describes a typed complete-state decoding, not a caller-supplied
   approval bit. A byte parser must establish that decoding relation. This file
   does not prove that labeling arbitrary DOT as `exact` is faithful parsing.
-/
def importGraph {n : Nat} {E : Type} [DecidableEq E]
    (source : Source n E) (input : GraphInput (Fin n) E) :
    Except GraphImportError (TypedAutomaton (Fin n) E) :=
  match input with
  | .projected => .error .inexactLabels
  | .unsupported => .error .inexactLabels
  | .exact graph =>
      match compileSource source with
      | .error error => .error (.source error)
      | .ok reference =>
          if valid : checkGraph reference graph = true then
            .ok ⟨graph.initial, graph.table, checked_graph_is_functional reference graph valid⟩
          else .error .invalidGraph

theorem projected_graph_is_refused {n : Nat} {E : Type} [DecidableEq E] (source : Source n E) :
    importGraph source .projected = .error .inexactLabels := rfl

theorem unknown_graph_is_refused {n : Nat} {E : Type} [DecidableEq E] (source : Source n E) :
    importGraph source .unsupported = .error .inexactLabels := rfl

theorem import_success_has_checked_source {n : Nat} {E : Type} [DecidableEq E]
    (source : Source n E) (graph : ExactGraph (Fin n) E) (automaton : TypedAutomaton (Fin n) E)
    (imported : importGraph source (.exact graph) = .ok automaton) :
    ∃ reference, compileSource source = .ok reference ∧ checkGraph reference graph = true ∧
      automaton.initial = graph.initial ∧ automaton.table = graph.table := by
  cases compiled : compileSource source with
  | error error => simp [importGraph, compiled] at imported
  | ok reference =>
      simp only [importGraph, compiled] at imported
      split at imported
      · rename_i valid
        cases imported
        exact ⟨reference, rfl, valid, rfl, rfl⟩
      · cases imported

theorem imported_graph_accepts_iff_reachable_source_step
    {n : Nat} {E : Type} [DecidableEq E]
    (source : Source n E) (graph : ExactGraph (Fin n) E) (automaton : TypedAutomaton (Fin n) E)
    (imported : importGraph source (.exact graph) = .ok automaton)
    (state : Fin n) (event : E) (next : Fin n)
    (reachable : Reach (fun s => s = source.initial)
      (fun s t => ∃ e, SourceStep source s e t) state) :
    evalDispatch (compileTable automaton.table) (state, event) = some next ↔
      SourceStep source state event next := by
  obtain ⟨reference, compiled, valid, _, importedTable⟩ := import_success_has_checked_source source graph automaton imported
  obtain ⟨_, initialSame, extractedTable⟩ := compile_success_shape source reference compiled
  have referenceReach : Reach (fun s => s = reference.initial) (TableStep reference.table) state := by
    induction reachable with
    | start initial => exact .start (initial.trans initialSame.symm)
    | advance previous edge ih =>
        obtain ⟨e, sourceEdge⟩ := edge
        apply Reach.advance ih
        refine ⟨e, ?_⟩
        rw [extractedTable]
        exact (extracted_edges_exact source _ _ _).mpr sourceEdge
  have node := (checked_graph_nodes_exact reference graph valid state).mpr referenceReach
  rw [generated_dispatch_exact automaton.table automaton.functional, importedTable]
  rw [checked_graph_edges_exact_on_nodes reference graph valid state event next node, extractedTable]
  exact extracted_edges_exact source state event next

theorem compiled_source_reachability_exact {n : Nat} {E : Type} [DecidableEq E]
    (source : Source n E) (automaton : TypedAutomaton (Fin n) E)
    (compiled : compileSource source = .ok automaton) (state : Fin n) :
    Reach (fun s => s = automaton.initial) (TableStep automaton.table) state ↔
      Reach (fun s => s = source.initial) (fun s t => ∃ e, SourceStep source s e t) state := by
  obtain ⟨_, initialSame, tableSame⟩ := compile_success_shape source automaton compiled
  have relation : TableStep automaton.table = (fun s t => ∃ e, SourceStep source s e t) := by
    funext before after
    apply propext
    simp only [TableStep, tableSame, extracted_edges_exact]
  rw [relation, initialSame]

theorem imported_graph_source_reachability_exact {n : Nat} {E : Type} [DecidableEq E]
    (source : Source n E) (graph : ExactGraph (Fin n) E) (automaton : TypedAutomaton (Fin n) E)
    (imported : importGraph source (.exact graph) = .ok automaton) (state : Fin n) :
    Reach (fun s => s = automaton.initial) (TableStep automaton.table) state ↔
      Reach (fun s => s = source.initial) (fun s t => ∃ e, SourceStep source s e t) state := by
  obtain ⟨reference, compiled, valid, initialSame, tableSame⟩ := import_success_has_checked_source source graph automaton imported
  rw [initialSame, tableSame, checked_graph_reachability_exact reference graph valid state]
  exact compiled_source_reachability_exact source reference compiled state

theorem imported_graph_rejects_iff_no_reachable_source_step
    {n : Nat} {E : Type} [DecidableEq E]
    (source : Source n E) (graph : ExactGraph (Fin n) E) (automaton : TypedAutomaton (Fin n) E)
    (imported : importGraph source (.exact graph) = .ok automaton)
    (state : Fin n) (event : E)
    (reachable : Reach (fun s => s = source.initial)
      (fun s t => ∃ e, SourceStep source s e t) state) :
    evalDispatch (compileTable automaton.table) (state, event) = none ↔
      ¬ ∃ next, SourceStep source state event next := by
  constructor
  · intro rejected existsStep
    obtain ⟨next, sourceStep⟩ := existsStep
    have accepted := (imported_graph_accepts_iff_reachable_source_step source graph automaton
      imported state event next reachable).mpr sourceStep
    rw [rejected] at accepted
    cases accepted
  · intro noStep
    cases response : evalDispatch (compileTable automaton.table) (state, event) with
    | none => rfl
    | some next =>
        exact False.elim (noStep ⟨next,
          (imported_graph_accepts_iff_reachable_source_step source graph automaton
            imported state event next reachable).mp response⟩)

/- Concrete nonvacuity and limits. These examples instantiate the general
   extraction/validation laws; they are not the source of those laws.
-/
def guardedSource : Source 3 Bool :=
  ⟨0, [⟨false, .stateIs 0, .set 1⟩, ⟨true, .stateIs 1, .set 2⟩]⟩

def guardedAuthority : TypedAutomaton (Fin 3) Bool :=
  ⟨guardedSource.initial, extract guardedSource,
    (functional_check_exact _).mp (by decide)⟩

theorem guarded_source_compiles : compileSource guardedSource = .ok guardedAuthority := rfl

theorem generated_guarded_progress_and_refusal :
    evalDispatch (compileTable guardedAuthority.table) ((0 : Fin 3), false) = some 1 ∧
    evalDispatch (compileTable guardedAuthority.table) ((1 : Fin 3), true) = some 2 ∧
    evalDispatch (compileTable guardedAuthority.table) ((0 : Fin 3), true) = none := by decide

def guardedGraph : ExactGraph (Fin 3) Bool :=
  ⟨0, [0, 1, 2], [((0, false), 1), ((1, true), 2)],
    [[], [(false, 1)], [(false, 1), (true, 2)]]⟩

theorem exact_graph_validation_is_nonempty : checkGraph guardedAuthority guardedGraph = true := by decide

def prematureSubmitGraph : ExactGraph (Fin 3) Bool :=
  { guardedGraph with table := ((0, true), 2) :: guardedGraph.table }

theorem existential_projection_does_not_pass_exact_validation :
    SourceStep guardedSource 1 true 2 ∧
    ¬ SourceStep guardedSource 0 true 2 ∧
    checkGraph guardedAuthority prematureSubmitGraph = false := by
  refine ⟨?_, ?_, by decide⟩
  · exact ⟨⟨true, .stateIs 1, .set 2⟩,
      List.mem_cons_of_mem _ (List.mem_cons_self), rfl, rfl, rfl⟩
  · rintro ⟨rule, member, sameEvent, enabled, _⟩
    rcases List.mem_cons.mp member with first | rest
    · subst rule
      cases sameEvent
    · rcases List.mem_cons.mp rest with second | impossible
      · subst rule
        cases enabled
      · cases impossible

def unsupportedDeadBranch : Source 1 Unit :=
  ⟨0, [⟨(), .literal true, .branch (.literal false) (.unsupported 7) .keep⟩]⟩

theorem unreachable_unsupported_syntax_is_refused :
    compileSource unsupportedDeadBranch = .error .unsupported := rfl

def ambiguousSource : Source 2 Unit :=
  ⟨0, [⟨(), .literal true, .set 0⟩, ⟨(), .literal true, .set 1⟩]⟩

theorem ambiguous_source_is_not_an_executable_authority :
    compileSource ambiguousSource = .error .ambiguous := rfl

/- A reachable-only import need not contain edges at source-unreachable states.
   The equality theorem must stay restricted to reachable source states.
-/
def unreachableRuleSource : Source 2 Unit :=
  ⟨0, [⟨(), .stateIs 1, .keep⟩]⟩
def unreachableRuleAuthority : TypedAutomaton (Fin 2) Unit :=
  ⟨0, extract unreachableRuleSource, (functional_check_exact _).mp (by decide)⟩
def reachableOnlyGraph : ExactGraph (Fin 2) Unit := ⟨0, [0], [], [[]]⟩

theorem reachable_only_is_not_all_states_equality :
    checkGraph unreachableRuleAuthority reachableOnlyGraph = true ∧
    evalDispatch (compileTable reachableOnlyGraph.table) ((1 : Fin 2), ()) = none ∧
    SourceStep unreachableRuleSource 1 () 1 := by
  refine ⟨by decide, rfl, ?_⟩
  exact ⟨⟨(), .stateIs 1, .keep⟩, List.mem_cons_self, rfl, rfl, rfl⟩

/- A certificate-bearing graph check is exact for GraphChecks, not for graph
   faithfulness alone when the supplied routes are missing. The existential
   theorem below proves that every semantically faithful graph has suitable
   finite certificates. No route is a runtime execution-log assumption.
-/
def SemanticGraphFaithful {S E : Type}
    (reference : TypedAutomaton S E) (graph : ExactGraph S E) : Prop :=
  graph.initial = reference.initial ∧ graph.initial ∈ graph.nodes ∧
  (∀ node ∈ graph.nodes,
    Reach (fun s => s = reference.initial) (TableStep reference.table) node) ∧
  (∀ entry ∈ graph.table, entry ∈ reference.table ∧ entry.1.1 ∈ graph.nodes ∧ entry.2 ∈ graph.nodes) ∧
  (∀ entry ∈ reference.table, entry.1.1 ∈ graph.nodes → entry ∈ graph.table)

theorem walk_append {S E : Type} [DecidableEq S] [DecidableEq E]
    (table : List ((S × E) × S)) (front suffix : List (E × S)) (state : S) :
    walk table state (front ++ suffix) =
      (walk table state front).bind (fun middle => walk table middle suffix) := by
  induction front generalizing state with
  | nil => rfl
  | cons entry rest ih =>
      rcases entry with ⟨event, next⟩
      by_cases member : ((state, event), next) ∈ table
      · simp [walk, member, ih]
      · simp [walk, member]

theorem reachable_state_has_finite_route {S E : Type} [DecidableEq S] [DecidableEq E]
    (table : List ((S × E) × S)) (initial : S) {state : S}
    (reachable : Reach (fun s => s = initial) (TableStep table) state) :
    ∃ route, walk table initial route = some state := by
  induction reachable with
  | start beginning => exact ⟨[], by simp [walk, beginning]⟩
  | @advance before after previous edge ih =>
      obtain ⟨route, valid⟩ := ih
      obtain ⟨event, member⟩ := edge
      exact ⟨route ++ [(event, after)], by simp [walk_append, valid, walk, member]⟩

theorem reachable_nodes_have_finite_routes {S E : Type} [DecidableEq S] [DecidableEq E]
    (table : List ((S × E) × S)) (initial : S) (nodes : List S)
    (reachable : ∀ node ∈ nodes, Reach (fun s => s = initial) (TableStep table) node) :
    ∃ routes : List (List (E × S)), ∀ node ∈ nodes,
      ∃ route ∈ routes, walk table initial route = some node := by
  induction nodes with
  | nil => exact ⟨[], by simp⟩
  | cons head rest ih =>
      obtain ⟨headRoute, headValid⟩ := reachable_state_has_finite_route table initial
        (reachable head (List.mem_cons_self))
      obtain ⟨tailRoutes, tailValid⟩ := ih (fun node member =>
        reachable node (List.mem_cons_of_mem _ member))
      refine ⟨headRoute :: tailRoutes, ?_⟩
      intro node member
      rcases List.mem_cons.mp member with same | later
      · subst node
        exact ⟨headRoute, List.mem_cons_self, headValid⟩
      · obtain ⟨route, listed, valid⟩ := tailValid node later
        exact ⟨route, List.mem_cons_of_mem _ listed, valid⟩

theorem graph_faithfulness_iff_valid_certificates {S E : Type} [DecidableEq S] [DecidableEq E]
    (reference : TypedAutomaton S E) (graph : ExactGraph S E) :
    SemanticGraphFaithful reference graph ↔
      ∃ routes, checkGraph reference { graph with routes := routes } = true := by
  constructor
  · intro faithful
    obtain ⟨routes, covered⟩ := reachable_nodes_have_finite_routes reference.table reference.initial
      graph.nodes faithful.2.2.1
    refine ⟨routes, (graph_check_exact reference _).mpr ?_⟩
    exact ⟨faithful.1, faithful.2.1, covered, faithful.2.2.2.1, faithful.2.2.2.2⟩
  · rintro ⟨routes, checked⟩
    have obligations := (graph_check_exact reference _).mp checked
    refine ⟨obligations.1, obligations.2.1, ?_, obligations.2.2.2.1, obligations.2.2.2.2⟩
    intro node member
    exact (checked_graph_nodes_exact reference _ checked node).mp member

theorem missing_certificates_can_refuse_a_faithful_graph :
    SemanticGraphFaithful guardedAuthority { guardedGraph with routes := [] } ∧
    checkGraph guardedAuthority { guardedGraph with routes := [] } = false := by
  constructor
  · apply (graph_faithfulness_iff_valid_certificates guardedAuthority _).mpr
    exact ⟨guardedGraph.routes, exact_graph_validation_is_nonempty⟩
  · decide

end SGDCompilerPipeline

#print axioms SGDCompilerPipeline.guard_check_exact
#print axioms SGDCompilerPipeline.update_check_exact
#print axioms SGDCompilerPipeline.source_check_exact
#print axioms SGDCompilerPipeline.extracted_edges_exact
#print axioms SGDCompilerPipeline.functional_check_exact
#print axioms SGDCompilerPipeline.extracted_functionality_exact
#print axioms SGDCompilerPipeline.compile_success_shape
#print axioms SGDCompilerPipeline.compile_success_iff_admitted_deterministic
#print axioms SGDCompilerPipeline.unsupported_source_is_refused
#print axioms SGDCompilerPipeline.ambiguous_source_is_refused
#print axioms SGDCompilerPipeline.compile_success_accepts_iff_source_step
#print axioms SGDCompilerPipeline.compile_success_rejects_iff_no_source_step

#print axioms SGDCompilerPipeline.admitted_guard_has_meaning
#print axioms SGDCompilerPipeline.admitted_update_has_meaning

#print axioms SGDCompilerPipeline.compiled_authority_preserves_source_invariant
#print axioms SGDCompilerPipeline.walk_preserves_reachability
#print axioms SGDCompilerPipeline.graph_check_exact
#print axioms SGDCompilerPipeline.checked_graph_is_functional
#print axioms SGDCompilerPipeline.checked_graph_source_reachability_included
#print axioms SGDCompilerPipeline.checked_graph_reachability_exact
#print axioms SGDCompilerPipeline.checked_graph_nodes_exact
#print axioms SGDCompilerPipeline.checked_graph_edges_exact_on_nodes
#print axioms SGDCompilerPipeline.projected_graph_is_refused
#print axioms SGDCompilerPipeline.unknown_graph_is_refused
#print axioms SGDCompilerPipeline.import_success_has_checked_source
#print axioms SGDCompilerPipeline.imported_graph_accepts_iff_reachable_source_step

#print axioms SGDCompilerPipeline.compiled_source_reachability_exact
#print axioms SGDCompilerPipeline.imported_graph_source_reachability_exact
#print axioms SGDCompilerPipeline.imported_graph_rejects_iff_no_reachable_source_step
#print axioms SGDCompilerPipeline.guarded_source_compiles
#print axioms SGDCompilerPipeline.generated_guarded_progress_and_refusal
#print axioms SGDCompilerPipeline.exact_graph_validation_is_nonempty
#print axioms SGDCompilerPipeline.existential_projection_does_not_pass_exact_validation
#print axioms SGDCompilerPipeline.unreachable_unsupported_syntax_is_refused
#print axioms SGDCompilerPipeline.ambiguous_source_is_not_an_executable_authority
#print axioms SGDCompilerPipeline.reachable_only_is_not_all_states_equality

#print axioms SGDCompilerPipeline.walk_append
#print axioms SGDCompilerPipeline.reachable_state_has_finite_route
#print axioms SGDCompilerPipeline.reachable_nodes_have_finite_routes
#print axioms SGDCompilerPipeline.graph_faithfulness_iff_valid_certificates
#print axioms SGDCompilerPipeline.missing_certificates_can_refuse_a_faithful_graph
