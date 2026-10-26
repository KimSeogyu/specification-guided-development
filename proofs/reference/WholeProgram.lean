import Method

/- Constructive reference semantics only. All declared components and the
   declared environment share one authority over `owned`. `data` is explicitly
   outside the requirement projection: an invariant of `owned` is not a theorem
   about arbitrary payloads, I/O, or all observations of a native application.

   A step below is abstract and atomic. This file does not prove a TS/Rust
   scheduler, native source coverage, an external effect adapter, fairness, or
   a real concurrency/linearizability property. The Trace relation and observation labels are mathematical ghost semantics,
   not a stored runtime evidence log or a required evidence-comparison gate.
   Safety comes from constructor-level write mediation. Command functions are
   pure total Lean functions, not arbitrary code with exceptions, divergence,
   blocking, or FFI. Labels observe actor/event/admission, not native return
   payloads or external effect results. Edits remain in this command
   grammar and keep the fixed model policy; approved policy-epoch changes are
   a separate construction that can use programStep_refines. -/
namespace SGDWholeProgram
open SGDMethod

inductive Actor (I : Type)
  | component : I → Actor I
  | environment : Actor I
  deriving DecidableEq

inductive Observation (I E : Type)
  | internal : Actor I → Observation I E
  | accepted : Actor I → E → Observation I E
  | rejected : Actor I → E → Observation I E
  | edited : Actor I → Observation I E
  deriving DecidableEq

abbrev AuthorityTable (S E I : Type) := List ((S × (Actor I × E)) × S)

structure Global (S E D I : Type) where
  owned : S
  data : D
  components : I → List (Command S E D)
  environment : List (Command S E D)

/- Actor identity is supplied by the selected component or environment step,
   not by the command's event-selection function. The model can therefore
   express distinct permissions for different components and the environment. -/
def evalCommand {S E D I : Type} [DecidableEq S] [DecidableEq E] [DecidableEq I]
    (table : AuthorityTable S E I) (actor : Actor I) (command : Command S E D)
    (state : S × D) : (S × D) × Observation I E :=
  match command with
  | .internal body => ((state.1, body state.1 state.2), .internal actor)
  | .request choose =>
      let event := choose state.1 state.2
      match evalDispatch (compileTable table) (state.1, (actor, event)) with
      | none => (state, .rejected actor event)
      | some next => ((next, state.2), .accepted actor event)

/- The specification preserves accepted self-loops as accepted observations.
   A rejected request is a different label even when both leave S unchanged. -/
inductive SpecMove {S E I : Type} (table : AuthorityTable S E I) :
    Observation I E → S → S → Prop
  | internal (actor : Actor I) (state : S) :
      SpecMove table (.internal actor) state state
  | accepted (actor : Actor I) (event : E) (state next : S)
      (allowed : ((state, (actor, event)), next) ∈ table) :
      SpecMove table (.accepted actor event) state next
  | rejected (actor : Actor I) (event : E) (state : S)
      (forbidden : ¬ ∃ next, ((state, (actor, event)), next) ∈ table) :
      SpecMove table (.rejected actor event) state state
  | edited (actor : Actor I) (state : S) :
      SpecMove table (.edited actor) state state

theorem evalCommand_refines {S E D I : Type}
    [DecidableEq S] [DecidableEq E] [DecidableEq I]
    (table : AuthorityTable S E I) (actor : Actor I) (command : Command S E D)
    (state : S × D) :
    SpecMove table (evalCommand table actor command state).2 state.1
      (evalCommand table actor command state).1.1 := by
  cases command with
  | internal body => exact .internal actor state.1
  | request choose =>
      cases found : evalDispatch (compileTable table) (state.1, (actor, choose state.1 state.2)) with
      | none =>
          simpa [evalCommand, found] using
            (SpecMove.rejected actor (choose state.1 state.2) state.1
              ((generated_rejection_exact table _).1 found))
      | some next =>
          have member : ((state.1, (actor, choose state.1 state.2)), next) ∈ table :=
            lookup_sound table _ next (by
              simpa [compilation_preserves_lookup] using found)
          simpa [evalCommand, found] using
            (SpecMove.accepted actor (choose state.1 state.2) state.1 next member)

/- Completeness is separately conditional on the source table being functional.
   Soundness above needs no assumption that a whole program already simulates it. -/
theorem enabled_request_executes_exact {S E D I : Type}
    [DecidableEq S] [DecidableEq E] [DecidableEq I]
    (table : AuthorityTable S E I) (functional : Functional table)
    (actor : Actor I) (choose : S → D → E) (state : S) (data : D) (next : S)
    (allowed : ((state, (actor, choose state data)), next) ∈ table) :
    evalCommand table actor (.request choose) (state, data) =
      ((next, data), .accepted actor (choose state data)) := by
  have found := (generated_dispatch_exact table functional (state, (actor, choose state data)) next).2 allowed
  simp [evalCommand, found]

theorem forbidden_request_rejects_exact {S E D I : Type}
    [DecidableEq S] [DecidableEq E] [DecidableEq I]
    (table : AuthorityTable S E I) (actor : Actor I) (choose : S → D → E)
    (state : S) (data : D)
    (forbidden : ¬ ∃ next, ((state, (actor, choose state data)), next) ∈ table) :
    evalCommand table actor (.request choose) (state, data) =
      ((state, data), .rejected actor (choose state data)) := by
  have missing := (generated_rejection_exact table (state, (actor, choose state data))).2 forbidden
  simp [evalCommand, missing]

def observationActor {I E : Type} : Observation I E → Actor I
  | .internal actor => actor
  | .accepted actor _ => actor
  | .rejected actor _ => actor
  | .edited actor => actor

theorem command_cannot_forge_actor {S E D I : Type}
    [DecidableEq S] [DecidableEq E] [DecidableEq I]
    (table : AuthorityTable S E I) (actor : Actor I) (command : Command S E D)
    (state : S × D) : observationActor (evalCommand table actor command state).2 = actor := by
  cases command with
  | internal => rfl
  | request choose =>
      cases found : evalDispatch (compileTable table) (state.1, (actor, choose state.1 state.2)) <;>
        simp [evalCommand, found, observationActor]

def advanceComponent {S E D I : Type}
    [DecidableEq S] [DecidableEq E] [DecidableEq I]
    (table : AuthorityTable S E I) (g : Global S E D I)
    (identity : I) (command : Command S E D) (rest : List (Command S E D)) : Global S E D I :=
  let evaluated := evalCommand table (.component identity) command (g.owned, g.data)
  { g with owned := evaluated.1.1, data := evaluated.1.2,
           components := fun other => if other = identity then rest else g.components other }

def advanceEnvironment {S E D I : Type}
    [DecidableEq S] [DecidableEq E] [DecidableEq I]
    (table : AuthorityTable S E I) (g : Global S E D I)
    (command : Command S E D) (rest : List (Command S E D)) : Global S E D I :=
  let evaluated := evalCommand table .environment command (g.owned, g.data)
  { g with owned := evaluated.1.1, data := evaluated.1.2, environment := rest }

def editComponent {S E D I : Type} [DecidableEq I]
    (g : Global S E D I) (identity : I) (replacement : List (Command S E D)) : Global S E D I :=
  { g with components := fun other => if other = identity then replacement else g.components other }

def editEnvironment {S E D I : Type}
    (g : Global S E D I) (replacement : List (Command S E D)) : Global S E D I :=
  { g with environment := replacement }

/- The constructors are the complete step relation of this reference language.
   No constructor writes `owned` except through evalCommand's generated table.
   No constructor replaces the authority or supplies a fresh initial owner. -/
inductive ProgramStep {S E D I : Type}
    [DecidableEq S] [DecidableEq E] [DecidableEq I]
    (table : AuthorityTable S E I) :
    Observation I E → Global S E D I → Global S E D I → Prop
  | component (g : Global S E D I) (identity : I) (command : Command S E D)
      (rest : List (Command S E D)) (head : g.components identity = command :: rest) :
      ProgramStep table (evalCommand table (.component identity) command (g.owned, g.data)).2
        g (advanceComponent table g identity command rest)
  | environment (g : Global S E D I) (command : Command S E D)
      (rest : List (Command S E D)) (head : g.environment = command :: rest) :
      ProgramStep table (evalCommand table .environment command (g.owned, g.data)).2
        g (advanceEnvironment table g command rest)
  | editComponent (g : Global S E D I) (identity : I) (replacement : List (Command S E D)) :
      ProgramStep table (.edited (.component identity)) g (editComponent g identity replacement)
  | editEnvironment (g : Global S E D I) (replacement : List (Command S E D)) :
      ProgramStep table (.edited .environment) g (editEnvironment g replacement)

theorem programStep_refines {S E D I : Type}
    [DecidableEq S] [DecidableEq E] [DecidableEq I]
    {table : AuthorityTable S E I} {g g' : Global S E D I} {label : Observation I E}
    (step : ProgramStep table label g g') : SpecMove table label g.owned g'.owned := by
  cases step with
  | component g identity command rest head =>
      exact evalCommand_refines table (.component identity) command (g.owned, g.data)
  | environment g command rest head =>
      exact evalCommand_refines table .environment command (g.owned, g.data)
  | editComponent g identity replacement => exact .edited (.component identity) g.owned
  | editEnvironment g replacement => exact .edited .environment g.owned

/- Enabled source requests have a corresponding accepted scheduled step.
   This is acceptance completeness, not fairness of choosing that component. -/
theorem enabled_component_request_step {S E D I : Type}
    [DecidableEq S] [DecidableEq E] [DecidableEq I]
    (table : AuthorityTable S E I) (functional : Functional table)
    (g : Global S E D I) (identity : I) (choose : S → D → E)
    (rest : List (Command S E D)) (next : S)
    (head : g.components identity = .request choose :: rest)
    (allowed : ((g.owned, (.component identity, choose g.owned g.data)), next) ∈ table) :
    ProgramStep table (.accepted (.component identity) (choose g.owned g.data))
      g (advanceComponent table g identity (.request choose) rest) ∧
    (advanceComponent table g identity (.request choose) rest).owned = next := by
  have executed := enabled_request_executes_exact table functional (.component identity)
    choose g.owned g.data next allowed
  constructor
  · have scheduled := ProgramStep.component g identity (.request choose) rest head (table := table)
    simpa [executed] using scheduled
  · simp [advanceComponent, executed]

theorem enabled_environment_request_step {S E D I : Type}
    [DecidableEq S] [DecidableEq E] [DecidableEq I]
    (table : AuthorityTable S E I) (functional : Functional table)
    (g : Global S E D I) (choose : S → D → E)
    (rest : List (Command S E D)) (next : S)
    (head : g.environment = .request choose :: rest)
    (allowed : ((g.owned, (.environment, choose g.owned g.data)), next) ∈ table) :
    ProgramStep table (.accepted .environment (choose g.owned g.data))
      g (advanceEnvironment table g (.request choose) rest) ∧
    (advanceEnvironment table g (.request choose) rest).owned = next := by
  have executed := enabled_request_executes_exact table functional .environment
    choose g.owned g.data next allowed
  constructor
  · have scheduled := ProgramStep.environment g (.request choose) rest head (table := table)
    simpa [executed] using scheduled
  · simp [advanceEnvironment, executed]

theorem accepted_move_has_original_edge {S E I : Type}
    {table : AuthorityTable S E I} {actor : Actor I} {event : E} {state next : S}
    (move : SpecMove table (.accepted actor event) state next) :
    ((state, (actor, event)), next) ∈ table := by
  cases move with
  | accepted actor event state next allowed => exact allowed

theorem accepted_program_step_has_original_edge {S E D I : Type}
    [DecidableEq S] [DecidableEq E] [DecidableEq I]
    {table : AuthorityTable S E I} {actor : Actor I} {event : E}
    {g g' : Global S E D I}
    (step : ProgramStep table (.accepted actor event) g g') :
    ((g.owned, (actor, event)), g'.owned) ∈ table :=
  accepted_move_has_original_edge (programStep_refines step)

theorem edits_preserve_owned_state {S E D I : Type} [DecidableEq I]
    (g : Global S E D I) (identity : I) (replacement : List (Command S E D)) :
    (editComponent g identity replacement).owned = g.owned ∧
    (editEnvironment g replacement).owned = g.owned := ⟨rfl, rfl⟩

def UnlabeledStep {S E D I : Type}
    [DecidableEq S] [DecidableEq E] [DecidableEq I]
    (table : AuthorityTable S E I) (g g' : Global S E D I) : Prop :=
  ∃ label, ProgramStep table label g g'

def ModelStep {S E I : Type} (table : AuthorityTable S E I) (state next : S) : Prop :=
  ∃ actor event, ((state, (actor, event)), next) ∈ table

theorem specMove_projection {S E I : Type}
    {table : AuthorityTable S E I} {state next : S} {label : Observation I E}
    (move : SpecMove table label state next) : state = next ∨ ModelStep table state next := by
  cases move with
  | internal => exact Or.inl rfl
  | accepted actor event state next allowed => exact Or.inr ⟨actor, event, allowed⟩
  | rejected => exact Or.inl rfl
  | edited => exact Or.inl rfl

theorem unlabeled_projection {S E D I : Type}
    [DecidableEq S] [DecidableEq E] [DecidableEq I]
    {table : AuthorityTable S E I} {g g' : Global S E D I}
    (step : UnlabeledStep table g g') : g.owned = g'.owned ∨ ModelStep table g.owned g'.owned := by
  obtain ⟨label, transition⟩ := step
  exact specMove_projection (programStep_refines transition)

/- Every observed finite prefix, including edits and rejections, maps to a
   specification trace with exactly the same labels and protected observations.
   No whole-program step-simulation premise is assumed by this theorem. -/
inductive Trace {N L : Type} (step : L → N → N → Prop) : N → List L → N → Prop
  | nil (state : N) : Trace step state [] state
  | cons {state middle final : N} {label : L} {rest : List L}
      (first : step label state middle) (later : Trace step middle rest final) :
      Trace step state (label :: rest) final

theorem whole_trace_refines {S E D I : Type}
    [DecidableEq S] [DecidableEq E] [DecidableEq I]
    {table : AuthorityTable S E I} {g g' : Global S E D I} {labels : List (Observation I E)}
    (trace : Trace (ProgramStep table) g labels g') :
    Trace (SpecMove table) g.owned labels g'.owned := by
  induction trace with
  | nil state => exact .nil state.owned
  | cons first later ih => exact .cons (programStep_refines first) ih

theorem global_reachable_refines {S E D I : Type}
    [DecidableEq S] [DecidableEq E] [DecidableEq I]
    (table : AuthorityTable S E I) (initial : S → Prop)
    {g : Global S E D I}
    (reachable : Reach (fun world : Global S E D I => initial world.owned) (UnlabeledStep table) g) :
    Reach initial (ModelStep table) g.owned := by
  induction reachable with
  | start h => exact .start h
  | advance previous edge ih =>
      rcases unlabeled_projection edge with same | moved
      · simpa [same] using ih
      · exact .advance ih moved

theorem global_reachable_invariant {S E D I : Type}
    [DecidableEq S] [DecidableEq E] [DecidableEq I]
    (table : AuthorityTable S E I) (initial safe : S → Prop)
    (base : ∀ state, initial state → safe state)
    (closed : ∀ state actor event next, safe state →
       ((state, (actor, event)), next) ∈ table → safe next)
    {g : Global S E D I}
    (reachable : Reach (fun world : Global S E D I => initial world.owned) (UnlabeledStep table) g) :
    safe g.owned := by
  apply reachable_invariant initial safe (ModelStep table) base
  · intro state next hs edge
    obtain ⟨actor, event, allowed⟩ := edge
    exact closed state actor event next hs allowed
  · exact global_reachable_refines table initial reachable

/- The policy can admit an explicit self-loop while rejecting another event.
   Equal successor states do not erase this observational distinction. -/
def loopTable : AuthorityTable Bool Bool Unit :=
  [((false, (.environment, false)), false)]

theorem accepted_self_loop_is_not_rejection :
    evalCommand loopTable .environment (.request (fun _ (_ : Unit) => false)) (false, ()) =
      ((false, ()), .accepted .environment false) ∧
    evalCommand loopTable .environment (.request (fun _ (_ : Unit) => true)) (false, ()) =
      ((false, ()), .rejected .environment true) := by decide

/- A nontrivial complete program: two components share approval state. One
   tries publication too early, is edited, then publishes after the other
   component approves. The environment changes unprotected data and performs
   an accepted modeled self-loop. Every transition below is a language step. -/
def approvalPolicy : AuthorityTable (Bool × Bool) Bool Bool :=
  [(((false, false), (.component false, false)), (false, true)),
   (((false, true), (.component true, true)), (true, true)),
   (((true, true), (.environment, false)), (true, true))]

def requestEvent (event : Bool) : Command (Bool × Bool) Bool Nat :=
  .request (fun _ _ => event)

def initialProgram : Global (Bool × Bool) Bool Nat Bool :=
  { owned := (false, false), data := 0,
    components := fun identity => if identity then [requestEvent true] else [requestEvent false],
    environment := [.internal (fun _ n => n + 1), requestEvent false] }

def afterEarlyRequest := advanceComponent approvalPolicy initialProgram true (requestEvent true) []
def afterProgramEdit := editComponent afterEarlyRequest true [requestEvent true]
def afterApproval := advanceComponent approvalPolicy afterProgramEdit false (requestEvent false) []
def afterEnvironmentWork := advanceEnvironment approvalPolicy afterApproval (.internal (fun _ n => n + 1)) [requestEvent false]
def afterPublication := advanceComponent approvalPolicy afterEnvironmentWork true (requestEvent true) []
def finalProgram := advanceEnvironment approvalPolicy afterPublication (requestEvent false) []

def exampleLabels : List (Observation Bool Bool) :=
  [.rejected (.component true) true, .edited (.component true),
   .accepted (.component false) false, .internal .environment,
   .accepted (.component true) true, .accepted .environment false]

theorem multi_component_environment_edit_witness :
    Trace (ProgramStep approvalPolicy) initialProgram exampleLabels finalProgram ∧
    finalProgram.owned = (true, true) ∧ finalProgram.data = 1 := by
  have first : ProgramStep approvalPolicy (.rejected (.component true) true) initialProgram afterEarlyRequest :=
    .component initialProgram true (requestEvent true) [] rfl
  have edit : ProgramStep approvalPolicy (.edited (.component true)) afterEarlyRequest afterProgramEdit :=
    .editComponent afterEarlyRequest true [requestEvent true]
  have approve : ProgramStep approvalPolicy (.accepted (.component false) false) afterProgramEdit afterApproval :=
    .component afterProgramEdit false (requestEvent false) [] rfl
  have environmentWork : ProgramStep approvalPolicy (.internal .environment) afterApproval afterEnvironmentWork :=
    .environment afterApproval (.internal (fun _ n => n + 1)) [requestEvent false] rfl
  have publish : ProgramStep approvalPolicy (.accepted (.component true) true) afterEnvironmentWork afterPublication :=
    .component afterEnvironmentWork true (requestEvent true) [] rfl
  have environmentRequest : ProgramStep approvalPolicy (.accepted .environment false) afterPublication finalProgram :=
    .environment afterPublication (requestEvent false) [] rfl
  exact ⟨.cons first (.cons edit (.cons approve (.cons environmentWork (.cons publish
    (.cons environmentRequest (.nil finalProgram)))))), rfl, rfl⟩

theorem example_trace_refines :
    Trace (SpecMove approvalPolicy) (false, false) exampleLabels (true, true) :=
  whole_trace_refines multi_component_environment_edit_witness.1

theorem approval_policy_closed (state : Bool × Bool) (actor : Actor Bool)
    (event : Bool) (next : Bool × Bool)
    (safe : ApprovalSafe state) (allowed : ((state, (actor, event)), next) ∈ approvalPolicy) :
    ApprovalSafe next := by
  simp only [approvalPolicy, List.mem_cons, List.not_mem_nil, or_false] at allowed
  rcases allowed with first | second | third
  · cases first
    simp [ApprovalSafe]
  · cases second
    simp [ApprovalSafe]
  · cases third
    simp [ApprovalSafe]

theorem all_edited_interleavings_preserve_approval
    {g : Global (Bool × Bool) Bool Nat Bool}
    (reachable : Reach (fun world : Global (Bool × Bool) Bool Nat Bool => world.owned = (false, false))
      (UnlabeledStep approvalPolicy) g) : ApprovalSafe g.owned := by
  apply global_reachable_invariant approvalPolicy (fun state => state = (false, false)) ApprovalSafe
  · intro state initial
    cases initial
    exact approval_initial_safe
  · exact approval_policy_closed
  · exact reachable

theorem another_component_cannot_impersonate_approval_owner :
    evalCommand approvalPolicy (.component true) (requestEvent false) ((false, false), 0) =
      (((false, false), 0), .rejected (.component true) false) := by decide

end SGDWholeProgram

#print axioms SGDWholeProgram.evalCommand_refines
#print axioms SGDWholeProgram.programStep_refines
#print axioms SGDWholeProgram.unlabeled_projection
#print axioms SGDWholeProgram.whole_trace_refines
#print axioms SGDWholeProgram.global_reachable_refines
#print axioms SGDWholeProgram.global_reachable_invariant
#print axioms SGDWholeProgram.accepted_self_loop_is_not_rejection

#print axioms SGDWholeProgram.enabled_request_executes_exact
#print axioms SGDWholeProgram.forbidden_request_rejects_exact
#print axioms SGDWholeProgram.command_cannot_forge_actor
#print axioms SGDWholeProgram.accepted_program_step_has_original_edge
#print axioms SGDWholeProgram.edits_preserve_owned_state
#print axioms SGDWholeProgram.multi_component_environment_edit_witness
#print axioms SGDWholeProgram.example_trace_refines
#print axioms SGDWholeProgram.all_edited_interleavings_preserve_approval
#print axioms SGDWholeProgram.another_component_cannot_impersonate_approval_owner

#print axioms SGDWholeProgram.enabled_component_request_step
#print axioms SGDWholeProgram.enabled_environment_request_step
