import Method
import WholeProgram

/- Formal boundary witnesses only. These do not describe the current native
   emitters or add an instruction to an SGD product implementation. -/
namespace SGDBoundary

open SGDMethod

/- The protected Bool is approval; the payload Bool is publication. -/
def PublicationNeedsApproval (state : Bool × Bool) : Prop :=
  state.2 = true → state.1 = true

def publishPayload : Command Bool Unit Bool :=
  .internal (fun _ _ => true)

def payloadInitial : Bool × Bool := (false, false)

theorem admitted_payload_change_violates_requirement :
    PublicationNeedsApproval payloadInitial ∧
    (commandStep once publishPayload payloadInitial).1 = payloadInitial.1 ∧
    ¬ PublicationNeedsApproval (commandStep once publishPayload payloadInitial) := by
  simp [PublicationNeedsApproval, payloadInitial, publishPayload, commandStep]

/- This is an execution of the existing admitted development grammar, not an
   added bad instruction. Editing does not touch the machine; the subsequent
   internal command changes the requirement-relevant payload. -/
theorem payload_violation_is_reachable_during_admitted_development :
    ∃ current : DevelopmentState Bool Unit Bool,
      Reach (fun state : DevelopmentState Bool Unit Bool =>
        state.machine = payloadInitial) (DevelopmentStep once) current ∧
      current.machine.1 = false ∧
      ¬ PublicationNeedsApproval current.machine := by
  let initial : DevelopmentState Bool Unit Bool := ⟨[], payloadInitial⟩
  have start : Reach
      (fun state : DevelopmentState Bool Unit Bool => state.machine = payloadInitial)
      (DevelopmentStep once) initial := .start rfl
  have edited := Reach.advance start
    (DevelopmentStep.edit (table := once) [] [publishPayload] payloadInitial)
  have executed := Reach.advance edited
    (DevelopmentStep.execute (table := once) publishPayload [] payloadInitial)
  refine ⟨_, executed, rfl, ?_⟩
  simp [PublicationNeedsApproval, payloadInitial, publishPayload, commandStep]

/- A requirement can be expressed on an abstraction exactly when it is
   constant on states that the abstraction identifies. This is an adequacy
   condition on the requirement, not a whole-program simulation assumption. -/
def RespectsProjection {N Q : Type} (project : N → Q) (requirement : N → Prop) : Prop :=
  ∀ left right, project left = project right →
    (requirement left ↔ requirement right)

theorem requirement_factors_iff_respects_projection {N Q : Type}
    (project : N → Q) (requirement : N → Prop) :
    (∃ abstractRequirement : Q → Prop,
      ∀ state, requirement state ↔ abstractRequirement (project state)) ↔
    RespectsProjection project requirement := by
  constructor
  · rintro ⟨abstractRequirement, correspondence⟩ left right same
    rw [correspondence left, correspondence right, same]
  · intro respects
    refine ⟨(fun abstractState => ∀ concrete,
      project concrete = abstractState → requirement concrete), ?_⟩
    intro state
    constructor
    · intro required other same
      exact (respects state other same.symm).mp required
    · intro all
      exact all state rfl

/- Positive use of the adequacy condition: the proved development invariant
   establishes the whole machine requirement when that requirement factors
   through the protected observation. Correspondence concerns the requirement,
   not the correctness of an assumed runtime execution. -/
theorem admitted_development_preserves_factored_requirement
    {S E D : Type} [DecidableEq S] [DecidableEq E]
    (table : List ((S × E) × S)) (initial safe : S → Prop)
    (requirement : S × D → Prop)
    (adequate : ∀ machine, requirement machine ↔ safe machine.1)
    (base : ∀ state, initial state → safe state)
    (closed : ∀ state event next, safe state →
      ((state, event), next) ∈ table → safe next)
    {current : DevelopmentState S E D}
    (history : Reach (fun state : DevelopmentState S E D => initial state.machine.1)
      (DevelopmentStep table) current) : requirement current.machine := by
  exact (adequate current.machine).mpr
    (arbitrary_development_preserves_specification_safety table initial safe base closed history)

/- This corollary uses the actual closed WholeProgram semantics and its proved
   global invariant, rather than a supplied whole-program simulation premise. -/
theorem whole_program_preserves_factored_requirement
    {S E D I : Type} [DecidableEq S] [DecidableEq E] [DecidableEq I]
    (table : SGDWholeProgram.AuthorityTable S E I)
    (initial safe : S → Prop)
    (requirement : SGDWholeProgram.Global S E D I → Prop)
    (adequate : ∀ world, requirement world ↔ safe world.owned)
    (base : ∀ state, initial state → safe state)
    (closed : ∀ state actor event next, safe state →
      ((state, (actor, event)), next) ∈ table → safe next)
    {world : SGDWholeProgram.Global S E D I}
    (reachable : Reach
      (fun current : SGDWholeProgram.Global S E D I => initial current.owned)
      (SGDWholeProgram.UnlabeledStep table) world) : requirement world := by
  exact (adequate world).mpr
    (SGDWholeProgram.global_reachable_invariant table initial safe base closed reachable)

def payloadAuthority : SGDWholeProgram.AuthorityTable Bool Unit Unit :=
  [((false, (SGDWholeProgram.Actor.component (), ())), true)]

def payloadGlobal : SGDWholeProgram.Global Bool Unit Bool Unit :=
  ⟨false, false, fun _ => [publishPayload], []⟩

def afterGlobalPayloadPublication : SGDWholeProgram.Global Bool Unit Bool Unit :=
  SGDWholeProgram.advanceComponent payloadAuthority payloadGlobal () publishPayload []

theorem actual_global_step_exposes_unmodeled_payload :
    PublicationNeedsApproval (payloadGlobal.owned, payloadGlobal.data) ∧
    Reach (fun world : SGDWholeProgram.Global Bool Unit Bool Unit => world = payloadGlobal)
      (SGDWholeProgram.UnlabeledStep payloadAuthority) afterGlobalPayloadPublication ∧
    afterGlobalPayloadPublication.owned = payloadGlobal.owned ∧
    ¬ PublicationNeedsApproval
      (afterGlobalPayloadPublication.owned, afterGlobalPayloadPublication.data) := by
  have reached : Reach
      (fun world : SGDWholeProgram.Global Bool Unit Bool Unit => world = payloadGlobal)
      (SGDWholeProgram.UnlabeledStep payloadAuthority) afterGlobalPayloadPublication :=
    .advance (.start rfl)
      ⟨_, SGDWholeProgram.ProgramStep.component payloadGlobal () publishPayload [] rfl⟩
  refine ⟨?_, reached, rfl, ?_⟩
  · simp [PublicationNeedsApproval, payloadGlobal]
  · simp [PublicationNeedsApproval, afterGlobalPayloadPublication,
      SGDWholeProgram.advanceComponent, SGDWholeProgram.evalCommand,
      publishPayload, payloadGlobal]

theorem publication_requirement_cannot_use_owner_only :
    ¬ ∃ abstractRequirement : Bool → Prop,
      ∀ state : Bool × Bool,
        PublicationNeedsApproval state ↔ abstractRequirement state.1 := by
  rintro ⟨abstractRequirement, correspondence⟩
  have initialSafe : PublicationNeedsApproval (false, false) := by
    simp [PublicationNeedsApproval]
  have abstractSafe : abstractRequirement false :=
    (correspondence (false, false)).mp initialSafe
  have badSafe : PublicationNeedsApproval (false, true) :=
    (correspondence (false, true)).mpr abstractSafe
  have impossible := badSafe rfl
  cases impossible

/- The second witness changes protected state through a step omitted from
   generated-command-only classification. State is now (published, approved),
   using Method's concrete approval model. -/
def GeneratedOnlyBody (_ : Unit) (before after : Bool × Bool) : Prop :=
  before = after ∨ SpecificationEdge approval before after

inductive ExtendedProgramStep : (Bool × Bool) → (Bool × Bool) → Prop
  | generated {before after} :
      GeneratedOnlyBody () before after → ExtendedProgramStep before after
  | externalWrite (before : Bool × Bool) :
      ExtendedProgramStep before (true, false)

theorem generated_local_body_preserves_approval
    (before after : Bool × Bool) (safe : ApprovalSafe before)
    (body : GeneratedOnlyBody () before after) : ApprovalSafe after := by
  rcases body with unchanged | ⟨event, edge⟩
  · simpa [unchanged] using safe
  · exact approval_closed before event after safe edge

theorem external_write_is_not_a_generated_body :
    ¬ ∃ kind : Unit, GeneratedOnlyBody kind (false, false) (true, false) := by
  rintro ⟨kind, body⟩
  rcases body with same | ⟨event, edge⟩
  · cases same
  · simp [approval] at edge

theorem external_write_defeats_generated_only_coverage :
    (∀ before after, ApprovalSafe before →
      GeneratedOnlyBody () before after → ApprovalSafe after) ∧
    ¬ (∀ before after, ExtendedProgramStep before after →
      ∃ kind : Unit, GeneratedOnlyBody kind before after) := by
  constructor
  · exact generated_local_body_preserves_approval
  · intro coverage
    exact external_write_is_not_a_generated_body
      (coverage (false, false) (true, false) (.externalWrite (false, false)))

theorem external_write_reaches_whole_program_violation :
    Reach (fun state : Bool × Bool => state = (false, false))
      ExtendedProgramStep (true, false) ∧
    ¬ ApprovalSafe (true, false) := by
  constructor
  · exact .advance (.start rfl) (.externalWrite (false, false))
  · simp [ApprovalSafe]

end SGDBoundary

#print axioms SGDBoundary.admitted_payload_change_violates_requirement
#print axioms SGDBoundary.payload_violation_is_reachable_during_admitted_development
#print axioms SGDBoundary.requirement_factors_iff_respects_projection
#print axioms SGDBoundary.admitted_development_preserves_factored_requirement
#print axioms SGDBoundary.whole_program_preserves_factored_requirement
#print axioms SGDBoundary.actual_global_step_exposes_unmodeled_payload
#print axioms SGDBoundary.publication_requirement_cannot_use_owner_only
#print axioms SGDBoundary.generated_local_body_preserves_approval
#print axioms SGDBoundary.external_write_is_not_a_generated_body
#print axioms SGDBoundary.external_write_defeats_generated_only_coverage
#print axioms SGDBoundary.external_write_reaches_whole_program_violation
