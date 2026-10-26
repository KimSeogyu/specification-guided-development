import LanguageProfiles
import DevelopmentRefinement
import FiniteConfigurations

/- Reference whole-program composition for the finite CFG profiles. A control
   location can cycle without synthetic edits or finite-queue unrolling. All
   declared component identities and the environment share one actual owner.
   Source code bodies cannot supply their actor or replace the generated policy.
   Raw bodies still include forbidden operations; static certificates concern
   the independently defined complete body contract, not prior global safety.
   No native module parser, heap model, or concurrent OS proof is claimed.
-/
namespace SGDProfileComposition
open SGDMethod SGDCompilerPipeline SGDCompilerLintBridge SGDLanguageProfiles
open SGDDevelopmentRefinement

abbrev Actor (components : Nat) := SGDWholeProgram.Actor (Fin components)
abbrev GlobalTable (states events components : Nat) :=
  List ((Fin (states + 1) × (Actor components × Fin events)) × Fin (states + 1))

def specialize {S E I : Type} [DecidableEq I]
    (table : List ((S × (I × E)) × S)) (actor : I) : List ((S × E) × S) :=
  table.filterMap (fun entry =>
    if entry.1.2.1 = actor then some ((entry.1.1, entry.1.2.2), entry.2) else none)

theorem specialized_membership_exact {S E I : Type} [DecidableEq I]
    (table : List ((S × (I × E)) × S)) (actor : I) (before after : S) (event : E) :
    ((before, event), after) ∈ specialize table actor ↔ ((before, (actor, event)), after) ∈ table := by
  simp only [specialize, List.mem_filterMap]
  constructor
  · rintro ⟨⟨⟨state, ⟨origin, request⟩⟩, target⟩, member, generated⟩
    by_cases same : origin = actor
    · simp [same] at generated
      rcases generated with ⟨⟨rfl, rfl⟩, rfl⟩
      simpa [same] using member
    · simp [same] at generated
  · intro member
    exact ⟨((before, (actor, event)), after), member, by simp⟩

theorem specialization_is_functional {S E I : Type} [DecidableEq I]
    (table : List ((S × (I × E)) × S)) (functional : Functional table) (actor : I) :
    Functional (specialize table actor) := by
  rintro ⟨before, event⟩ first second left right
  exact functional (before, (actor, event)) first second
    ((specialized_membership_exact table actor before first event).mp left)
    ((specialized_membership_exact table actor before second event).mp right)

structure TSBody (states pcs events : Nat) where
  aliases : List (Nat × TSRef)
  code : Fin (pcs + 1) → TSInstruction states pcs events

inductive Controller (states pcs events : Nat)
  | ts : TSBody states pcs events → Controller states pcs events

def bindTS {states pcs events components : Nat} (table : GlobalTable states events components)
    (actor : Actor components) (body : TSBody states pcs events)
    (live : Configuration states pcs) : TSProgram states pcs events :=
  ⟨live.owner, live.pc, body.aliases, emitTSAuthority (specialize table actor), body.code⟩

/- This static judgment inspects aliases and code only. Its placeholder initial
   fields are unused; execution binds the actual live owner and control location. -/
def BodyAdmitted {states pcs events : Nat} : Controller states pcs events → Prop
  | .ts body => TSStaticContract ⟨0, 0, body.aliases, .reject, body.code⟩

def checkBody {states pcs events : Nat} : Controller states pcs events → Bool
  | .ts body => tsStaticCheck ⟨0, 0, body.aliases, .reject, body.code⟩

theorem body_check_exact {states pcs events : Nat} (body : Controller states pcs events) :
    checkBody body = true ↔ BodyAdmitted body := by
  cases body with
  | ts body => exact ts_static_check_exact _

def runController {states pcs events components : Nat} (table : GlobalTable states events components)
    (actor : Actor components) : Controller states pcs events → Configuration states pcs →
      Observation (Fin events) × Configuration states pcs
  | .ts body, live => tsRun (bindTS table actor body live) live

def liftObservation {components events : Nat} (actor : Actor components) :
    Observation (Fin events) → Observation (Actor components × Fin events)
  | .accepted event => .accepted (actor, event)
  | .rejected event => .rejected (actor, event)
  | .internal => .internal
  | .forbidden => .forbidden

def PolicyObservation {S E : Type} (table : List ((S × E) × S)) :
    Observation E → S → S → Prop
  | .accepted event, before, after => ((before, event), after) ∈ table
  | .rejected event, before, after => before = after ∧ ¬ ∃ next, ((before, event), next) ∈ table
  | .internal, before, after => before = after
  | .forbidden, _, _ => False

theorem ts_body_refines_global_policy {states pcs events components : Nat}
    (table : GlobalTable states events components) (actor : Actor components)
    (body : TSBody states pcs events) (live : Configuration states pcs)
    (admitted : BodyAdmitted (.ts body)) :
    PolicyObservation table
      (liftObservation actor (tsRun (bindTS table actor body live) live).1)
      live.owner (tsRun (bindTS table actor body live) live).2.owner := by
  have instruction := admitted.2.2 live.pc
  cases form : body.code live.pc with
  | jump next => simp [tsRun, bindTS, form, liftObservation, PolicyObservation]
  | ifOwner expected yes no => simp [tsRun, bindTS, form, liftObservation, PolicyObservation]
  | send receiver event yes no =>
    have bound : tsResolve (tsAliases body.aliases) receiver = true := by
      simpa [TSInstructionDisciplined, form] using instruction
    cases found : tsAuthorityEval (emitTSAuthority (specialize table actor)) (live.owner, event) with
    | none =>
      have missing : ¬ ∃ next, ((live.owner, event), next) ∈ specialize table actor :=
        (generated_rejection_exact (specialize table actor) (live.owner, event)).mp (by
          simpa [ts_authority_lookup_exact, compilation_preserves_lookup] using found)
      have globallyMissing : ¬ ∃ next, ((live.owner, (actor, event)), next) ∈ table := by
        rintro ⟨next, member⟩
        exact missing ⟨next, (specialized_membership_exact table actor live.owner next event).mpr member⟩
      simpa [tsRun, bindTS, form, bound, found, liftObservation, PolicyObservation] using And.intro (Eq.refl live.owner) globallyMissing
    | some next =>
      have member := lookup_sound (specialize table actor) (live.owner, event) next (by
        simpa [ts_authority_lookup_exact] using found)
      have globalMember := (specialized_membership_exact table actor live.owner next event).mp member
      simpa [tsRun, bindTS, form, bound, found, liftObservation, PolicyObservation] using globalMember
  | writeProtected next pc => simp [TSInstructionDisciplined, form] at instruction
  | replaceOwner next pc => simp [TSInstructionDisciplined, form] at instruction
  | unknown tag => simp [TSInstructionDisciplined, form] at instruction

theorem controller_refines_global_policy {states pcs events components : Nat}
    (table : GlobalTable states events components) (actor : Actor components)
    (body : Controller states pcs events) (live : Configuration states pcs)
    (admitted : BodyAdmitted body) :
    PolicyObservation table (liftObservation actor (runController table actor body live).1)
      live.owner (runController table actor body live).2.owner := by
  cases body with
  | ts body => exact ts_body_refines_global_policy table actor body live admitted

structure World (states pcs events components : Nat) where
  owner : Fin (states + 1)
  code : Actor components → Controller states pcs events
  pc : Actor components → Fin (pcs + 1)

def WorldAdmitted {states pcs events components : Nat}
    (world : World states pcs events components) : Prop :=
  ∀ actor, BodyAdmitted (world.code actor)

def checkWorld {states pcs events components : Nat}
    (world : World states pcs events components) : Bool :=
  SGDSemanticConstraints.everyFin components (fun identity => checkBody (world.code (.component identity))) &&
    checkBody (world.code .environment)

theorem world_check_exact {states pcs events components : Nat}
    (world : World states pcs events components) :
    checkWorld world = true ↔ WorldAdmitted world := by
  simp only [checkWorld, Bool.and_eq_true, SGDSemanticConstraints.everyFin_exact, body_check_exact]
  constructor
  · rintro ⟨components, environment⟩ actor
    cases actor with
    | component identity => exact components identity
    | environment => exact environment
  · intro admitted
    exact ⟨fun identity => admitted (.component identity), admitted .environment⟩

def runWorld {states pcs events components : Nat} (table : GlobalTable states events components)
    (world : World states pcs events components) (actor : Actor components) : World states pcs events components :=
  let result := runController table actor (world.code actor) ⟨world.owner, world.pc actor⟩
  { world with owner := result.2.owner,
               pc := fun other => if other = actor then result.2.pc else world.pc other }

def editWorld {states pcs events components : Nat} (world : World states pcs events components)
    (actor : Actor components) (replacement : Controller states pcs events) : World states pcs events components :=
  { world with code := fun other => if other = actor then replacement else world.code other }

inductive GlobalObservation (components events : Nat)
  | operation : Actor components → Observation (Fin events) → GlobalObservation components events
  | edit : Actor components → GlobalObservation components events

/- Raw runtime transitions do not consult the checker or intended invariant.
   In particular, an unchecked body's protected-write instruction really writes.
   Raw edits may install unsafe bodies; checked edit admission is separate. -/
inductive RawWorldStep {states pcs events components : Nat} (table : GlobalTable states events components) :
    GlobalObservation components events → World states pcs events components → World states pcs events components → Prop
  | run (world : World states pcs events components) (actor : Actor components) :
      RawWorldStep table
        (.operation actor (runController table actor (world.code actor) ⟨world.owner, world.pc actor⟩).1)
        world (runWorld table world actor)
  | edit (world : World states pcs events components) (actor : Actor components)
      (replacement : Controller states pcs events) :
      RawWorldStep table (.edit actor) world (editWorld world actor replacement)

theorem run_preserves_body_admission {states pcs events components : Nat}
    (table : GlobalTable states events components) (world : World states pcs events components)
    (actor : Actor components) (admitted : WorldAdmitted world) :
    WorldAdmitted (runWorld table world actor) := admitted

theorem edit_admission_exact {states pcs events components : Nat}
    (world : World states pcs events components) (actor : Actor components)
    (replacement : Controller states pcs events) (admitted : WorldAdmitted world) :
    WorldAdmitted (editWorld world actor replacement) ↔ BodyAdmitted replacement := by
  constructor
  · intro checked
    simpa [editWorld] using checked actor
  · intro checked other
    by_cases same : other = actor
    · simpa [editWorld, same] using checked
    · simpa [editWorld, same] using admitted other

theorem checked_edit_iff_body_contract {states pcs events components : Nat}
    (world : World states pcs events components) (actor : Actor components)
    (replacement : Controller states pcs events) (admitted : WorldAdmitted world) :
    checkWorld (editWorld world actor replacement) = true ↔ BodyAdmitted replacement :=
  (world_check_exact _).trans (edit_admission_exact world actor replacement admitted)

theorem edited_world_keeps_live_owner {states pcs events components : Nat}
    (world : World states pcs events components) (actor : Actor components)
    (replacement : Controller states pcs events) :
    (editWorld world actor replacement).owner = world.owner := rfl

abbrev CheckedWorld (states pcs events components : Nat) :=
  { world : World states pcs events components // WorldAdmitted world }

def CheckedStep {states pcs events components : Nat} (table : GlobalTable states events components)
    (before after : CheckedWorld states pcs events components) : Prop :=
  ∃ label, RawWorldStep table label before.val after.val

def checkedRun {states pcs events components : Nat} (table : GlobalTable states events components)
    (world : CheckedWorld states pcs events components) (actor : Actor components) :
    CheckedWorld states pcs events components :=
  ⟨runWorld table world.val actor, run_preserves_body_admission table world.val actor world.property⟩

def checkedEdit {states pcs events components : Nat} (world : CheckedWorld states pcs events components)
    (actor : Actor components) (replacement : Controller states pcs events)
    (checked : checkBody replacement = true) : CheckedWorld states pcs events components :=
  ⟨editWorld world.val actor replacement,
    (edit_admission_exact world.val actor replacement world.property).mpr ((body_check_exact replacement).mp checked)⟩

theorem checked_run_is_actual_raw_step {states pcs events components : Nat}
    (table : GlobalTable states events components) (world : CheckedWorld states pcs events components)
    (actor : Actor components) : CheckedStep table world (checkedRun table world actor) :=
  ⟨_, .run world.val actor⟩

theorem checked_edit_is_actual_raw_step {states pcs events components : Nat}
    (table : GlobalTable states events components) (world : CheckedWorld states pcs events components)
    (actor : Actor components) (replacement : Controller states pcs events)
    (checked : checkBody replacement = true) :
    CheckedStep table world (checkedEdit world actor replacement checked) :=
  ⟨_, .edit world.val actor replacement⟩

theorem observation_projects {states events components : Nat}
    (table : GlobalTable states events components) (actor : Actor components)
    (observation : Observation (Fin events)) (before after : Fin (states + 1))
    (refines : PolicyObservation table (liftObservation actor observation) before after) :
    before = after ∨ SGDWholeProgram.ModelStep table before after := by
  cases observation with
  | internal => exact Or.inl refines
  | accepted event => exact Or.inr ⟨actor, event, refines⟩
  | rejected event => exact Or.inl refines.1
  | forbidden => exact False.elim refines

theorem raw_step_projects_under_body_contract {states pcs events components : Nat}
    {table : GlobalTable states events components} {before after : World states pcs events components}
    {label : GlobalObservation components events}
    (admitted : WorldAdmitted before) (step : RawWorldStep table label before after) :
    before.owner = after.owner ∨ SGDWholeProgram.ModelStep table before.owner after.owner := by
  cases step with
  | @run world actor =>
    exact observation_projects table actor _ _ _
      (controller_refines_global_policy table actor (before.code actor)
        ⟨before.owner, before.pc actor⟩ (admitted actor))
  | @edit world actor replacement => exact Or.inl rfl

theorem checked_step_projection {states pcs events components : Nat}
    (table : GlobalTable states events components) :
    StepRefines (CheckedStep (pcs := pcs) table) (SGDWholeProgram.ModelStep table)
      (fun world => world.val.owner) := by
  intro before after step
  obtain ⟨label, raw⟩ := step
  exact raw_step_projects_under_body_contract before.property raw

/- This is the SAME generic development argument, instantiated with real CFG
   profile worlds and scheduler steps. No queue conversion, fake code-edit step,
   or assumed whole-program simulation is introduced to handle a control cycle. -/
abbrev ProfileStates (states pcs events components : Nat → Nat) (n : Nat) :=
  CheckedWorld (states n) (pcs n) (events n) (components n)

def profileProject {states pcs events components : Nat → Nat}
    (n : Nat) (world : ProfileStates states pcs events components n) : Fin (states n + 1) :=
  world.val.owner

abbrev ProfileEvolution {states pcs events components : Nat → Nat}
    (tables : (n : Nat) → GlobalTable (states n) (events n) (components n))
    (previous : (n : Nat) → Fin (states (n + 1) + 1) → Fin (states n + 1)) (approved : Nat → Prop) :=
  EvolutionStep (C := ProfileStates states pcs events components)
    (fun n => CheckedStep (pcs := pcs n) (tables n))
    (fun n => SGDWholeProgram.ModelStep (tables n)) profileProject previous approved

theorem profile_evolution_has_root_reachability {states pcs events components : Nat → Nat}
    (tables : (n : Nat) → GlobalTable (states n) (events n) (components n))
    (previous : (n : Nat) → Fin (states (n + 1) + 1) → Fin (states n + 1))
    (approved : Nat → Prop) (initial : Fin (states 0 + 1) → Prop)
    {world : Versioned (ProfileStates states pcs events components)}
    (history : Reach (RootInitial profileProject initial)
      (ProfileEvolution tables previous approved) world) :
    ApprovedChain (fun n => SGDWholeProgram.ModelStep (tables n)) previous approved world.1 ∧
      Reach initial (SGDWholeProgram.ModelStep (tables 0))
        (projectedRoot profileProject previous world) := by
  apply arbitrary_development_composes_refinements _ _ _ _ _ _ _ history
  intro n
  exact checked_step_projection (pcs := pcs n) (tables n)

theorem profile_evolution_preserves_root_safety {states pcs events components : Nat → Nat}
    (tables : (n : Nat) → GlobalTable (states n) (events n) (components n))
    (previous : (n : Nat) → Fin (states (n + 1) + 1) → Fin (states n + 1))
    (approved : Nat → Prop) (initial safe : Fin (states 0 + 1) → Prop)
    (base : ∀ state, initial state → safe state)
    (closed : ∀ before actor event after, safe before →
      ((before, (actor, event)), after) ∈ tables 0 → safe after)
    {world : Versioned (ProfileStates states pcs events components)}
    (history : Reach (RootInitial profileProject initial)
      (ProfileEvolution tables previous approved) world) :
    safe (projectedRoot profileProject previous world) := by
  apply reachable_invariant initial safe (SGDWholeProgram.ModelStep (tables 0)) base
  · intro before after safeBefore edge
    obtain ⟨actor, event, allowed⟩ := edge
    exact closed before actor event after safeBefore allowed
  · exact (profile_evolution_has_root_reachability tables previous approved initial history).2

theorem profile_evolution_preserves_world_requirement {states pcs events components : Nat → Nat}
    (tables : (n : Nat) → GlobalTable (states n) (events n) (components n))
    (previous : (n : Nat) → Fin (states (n + 1) + 1) → Fin (states n + 1))
    (approved : Nat → Prop) (initial safe : Fin (states 0 + 1) → Prop)
    (required : (n : Nat) → World (states n) (pcs n) (events n) (components n) → Prop)
    (faithful : ∀ n (world : World (states n) (pcs n) (events n) (components n)),
      required n world ↔ safe (rootView (S := fun k => Fin (states k + 1)) previous n world.owner))
    (base : ∀ state, initial state → safe state)
    (closed : ∀ before actor event after, safe before →
      ((before, (actor, event)), after) ∈ tables 0 → safe after)
    {world : Versioned (ProfileStates states pcs events components)}
    (history : Reach (RootInitial profileProject initial)
      (ProfileEvolution tables previous approved) world) :
    required world.1 world.2.val := by
  exact (faithful world.1 world.2.val).mpr
    (profile_evolution_preserves_root_safety tables previous approved initial safe base closed history)

/- Importing an arbitrary standalone language program needs an EXTRA explicit
   full-query policy binding. Standalone semantic conformance from one entry
   does not justify replacing a wrong but currently unreachable authority.
   This check concerns source/authority semantics, not runtime evidence logs. -/
def TSInstalledContract {states pcs events components : Nat}
    (table : GlobalTable states events components) (actor : Actor components)
    (initialOwner : Fin (states + 1)) (program : TSProgram states pcs events) : Prop :=
  program.initialOwner = initialOwner ∧
  ∀ state event, tsAuthorityEval program.authority (state, event) =
    tsAuthorityEval (emitTSAuthority (specialize table actor)) (state, event)

def checkTSInstalled {states pcs events components : Nat}
    (table : GlobalTable states events components) (actor : Actor components)
    (initialOwner : Fin (states + 1)) (program : TSProgram states pcs events) : Bool :=
  decide (program.initialOwner = initialOwner) &&
  SGDSemanticConstraints.everyFin (states + 1) (fun state =>
    SGDSemanticConstraints.everyFin events (fun event =>
      decide (tsAuthorityEval program.authority (state, event) =
        tsAuthorityEval (emitTSAuthority (specialize table actor)) (state, event))))

theorem installed_ts_check_exact {states pcs events components : Nat}
    (table : GlobalTable states events components) (actor : Actor components)
    (initialOwner : Fin (states + 1)) (program : TSProgram states pcs events) :
    checkTSInstalled table actor initialOwner program = true ↔ TSInstalledContract table actor initialOwner program := by
  simp [checkTSInstalled, TSInstalledContract, SGDSemanticConstraints.everyFin_exact]

theorem imported_ts_execution_preserved {states pcs events components : Nat}
    (table : GlobalTable states events components) (actor : Actor components)
    (initialOwner : Fin (states + 1)) (program : TSProgram states pcs events)
    (bound : TSInstalledContract table actor initialOwner program) (live : Configuration states pcs) :
    runController table actor (.ts ⟨program.aliases, program.code⟩) live = tsRun program live := by
  cases form : program.code live.pc <;>
    simp [runController, bindTS, tsRun, form, bound.2] <;> rfl

theorem generated_policy_binding_is_structural {states pcs events components : Nat}
    (table : GlobalTable states events components) (actor : Actor components)
    (body : TSBody states pcs events) (live : Configuration states pcs) :
    (bindTS table actor body live).authority = emitTSAuthority (specialize table actor) ∧
    (bindTS table actor body live).initialOwner = live.owner ∧
    (bindTS table actor body live).entry = live.pc := ⟨rfl, rfl, rfl⟩

/- A fixed-body global runtime configuration contains ALL changing fields.
   Code/aliases are immutable parameters during this semantic decision problem;
   checked edits and migrations are handled by ProfileEvolution separately. -/
structure RuntimeConfiguration (states pcs components : Nat) where
  owner : Fin (states + 1)
  componentPC : Fin components → Fin (pcs + 1)
  environmentPC : Fin (pcs + 1)

def runtimeEqual {states pcs components : Nat}
    (before after : RuntimeConfiguration states pcs components) : Bool :=
  decide (before.owner = after.owner) &&
    (SGDSemanticConstraints.everyFin components (fun i => decide (before.componentPC i = after.componentPC i)) &&
     decide (before.environmentPC = after.environmentPC))

theorem runtime_equal_exact {states pcs components : Nat}
    (before after : RuntimeConfiguration states pcs components) :
    runtimeEqual before after = true ↔ before = after := by
  simp only [runtimeEqual, Bool.and_eq_true, SGDSemanticConstraints.everyFin_exact, decide_eq_true_eq]
  constructor
  · rintro ⟨owner, entries, environment⟩
    have samePC := funext entries
    cases before
    cases after
    simp only at owner samePC environment
    cases owner
    cases samePC
    cases environment
    rfl
  · intro same
    cases same
    exact ⟨rfl, fun _ => rfl, rfl⟩

def runtimeWorld {states pcs events components : Nat}
    (bodies : Actor components → Controller states pcs events)
    (configuration : RuntimeConfiguration states pcs components) : World states pcs events components :=
  ⟨configuration.owner, bodies, fun actor => match actor with
    | .component identity => configuration.componentPC identity
    | .environment => configuration.environmentPC⟩

def takeConfiguration {states pcs events components : Nat}
    (world : World states pcs events components) : RuntimeConfiguration states pcs components :=
  ⟨world.owner, fun identity => world.pc (.component identity), world.pc .environment⟩

theorem runtime_world_roundtrip {states pcs events components : Nat}
    (bodies : Actor components → Controller states pcs events)
    (configuration : RuntimeConfiguration states pcs components) :
    takeConfiguration (runtimeWorld bodies configuration) = configuration := rfl

theorem full_world_reconstructed_when_code_fixed {states pcs events components : Nat}
    (world : World states pcs events components) :
    runtimeWorld world.code (takeConfiguration world) = world := by
  cases world with
  | mk owner code pc =>
    simp only [runtimeWorld, takeConfiguration]
    congr 1
    funext actor
    cases actor <;> rfl

def runtimeRun {states pcs events components : Nat}
    (table : GlobalTable states events components)
    (bodies : Actor components → Controller states pcs events)
    (configuration : RuntimeConfiguration states pcs components) (actor : Actor components) :
    Observation (Fin events) × RuntimeConfiguration states pcs components :=
  let world := runtimeWorld bodies configuration
  ((runController table actor (bodies actor) ⟨world.owner, world.pc actor⟩).1,
   takeConfiguration (runWorld table world actor))

theorem runtime_run_retains_all_world_fields {states pcs events components : Nat}
    (table : GlobalTable states events components)
    (bodies : Actor components → Controller states pcs events)
    (configuration : RuntimeConfiguration states pcs components) (actor : Actor components) :
    runtimeWorld bodies (runtimeRun table bodies configuration actor).2 =
      runWorld table (runtimeWorld bodies configuration) actor :=
  full_world_reconstructed_when_code_fixed (runWorld table (runtimeWorld bodies configuration) actor)

def encodeActor {components : Nat} : Actor components → Fin (components + 1)
  | .component identity => ⟨identity.val, by omega⟩
  | .environment => ⟨components, by omega⟩

def decodeActor {components : Nat} (index : Fin (components + 1)) : Actor components :=
  if component : index.val < components then .component ⟨index.val, component⟩ else .environment

theorem decode_encode_actor {components : Nat} (actor : Actor components) :
    decodeActor (encodeActor actor) = actor := by
  cases actor with
  | component identity => simp [encodeActor, decodeActor, identity.isLt]
  | environment => simp [encodeActor, decodeActor]

theorem encode_decode_actor {components : Nat} (index : Fin (components + 1)) :
    encodeActor (decodeActor index) = index := by
  unfold decodeActor
  split
  · rfl
  · apply Fin.ext
    simp only [encodeActor]
    omega

abbrev RuntimeLabel (components events : Nat) := Actor components × Observation (Fin events)
abbrev EncodedRuntimeLabel (components events : Nat) := Fin ((components + 1) * (2 * events + 2))

def encodeRuntimeLabel {components events : Nat} (label : RuntimeLabel components events) :
    EncodedRuntimeLabel components events :=
  encodeConfig (states := components) (pcs := 2 * events + 1)
    ⟨encodeActor label.1, encodeObservation label.2⟩

def decodeRuntimeLabel {components events : Nat} (index : EncodedRuntimeLabel components events) :
    RuntimeLabel components events :=
  let decoded := decodeConfig (states := components) (pcs := 2 * events + 1) index
  (decodeActor decoded.owner, decodeObservation decoded.pc)

theorem decode_encode_runtime_label {components events : Nat} (label : RuntimeLabel components events) :
    decodeRuntimeLabel (encodeRuntimeLabel label) = label := by
  cases label
  simp [decodeRuntimeLabel, encodeRuntimeLabel, decode_encode_config, decode_encode_actor, decode_encode_observation]

theorem encode_decode_runtime_label {components events : Nat} (index : EncodedRuntimeLabel components events) :
    encodeRuntimeLabel (decodeRuntimeLabel index) = index := by
  simp only [decodeRuntimeLabel, encodeRuntimeLabel, encode_decode_actor, encode_decode_observation]
  exact encode_decode_config index

def RuntimeStep {states pcs events components : Nat} (table : GlobalTable states events components)
    (bodies : Actor components → Controller states pcs events)
    (before after : RuntimeConfiguration states pcs components) : Prop :=
  ∃ actor observation, runtimeRun table bodies before actor = (observation, after)

def RuntimeConforms {states pcs events components : Nat}
    (source : Source (states + 1) (Actor components × Fin events))
    (table : GlobalTable states events components)
    (bodies : Actor components → Controller states pcs events)
    (initial : RuntimeConfiguration states pcs components)
    (invariant : Fin (states + 1) → Bool) : Prop :=
  initial.owner = source.initial ∧
  ∀ before, Reach (fun configuration => configuration = initial) (RuntimeStep table bodies) before →
    invariant before.owner = true ∧
    ∀ actor observation after, runtimeRun table bodies before actor = (observation, after) →
      SourceObservation source (liftObservation actor observation) before.owner after.owner

def runtimeEnumeration (states pcs components : Nat) :
    SGDFiniteConfigurations.Enumeration (RuntimeConfiguration states pcs components) :=
  SGDFiniteConfigurations.mapEnumeration
    (SGDFiniteConfigurations.ownerPCEnumeration states components pcs)
    (fun fields => ⟨fields.1, fields.2.1, fields.2.2⟩)
    (fun configuration => ⟨(configuration.owner, configuration.componentPC, configuration.environmentPC), rfl⟩)

def runtimeMachine {states pcs events components : Nat}
    (table : GlobalTable states events components)
    (bodies : Actor components → Controller states pcs events)
    (initial : RuntimeConfiguration states pcs components) :
    SGDFiniteConfigurations.NativeMachine (RuntimeConfiguration states pcs components)
      ((components + 1) * (2 * events + 2)) where
  initial configuration := runtimeEqual configuration initial
  step before index after :=
    let label := decodeRuntimeLabel index
    let result := runtimeRun table bodies before label.1
    decide (result.1 = label.2) && runtimeEqual result.2 after

theorem runtime_initial_exact {states pcs events components : Nat}
    (table : GlobalTable states events components)
    (bodies : Actor components → Controller states pcs events)
    (initial configuration : RuntimeConfiguration states pcs components) :
    (runtimeMachine table bodies initial).initial configuration = true ↔ configuration = initial :=
  runtime_equal_exact configuration initial

theorem runtime_machine_step_decodes {states pcs events components : Nat}
    (table : GlobalTable states events components)
    (bodies : Actor components → Controller states pcs events)
    (initial before after : RuntimeConfiguration states pcs components)
    (index : EncodedRuntimeLabel components events) :
    (runtimeMachine table bodies initial).step before index after = true ↔
      runtimeRun table bodies before (decodeRuntimeLabel index).1 = ((decodeRuntimeLabel index).2, after) := by
  cases result : runtimeRun table bodies before (decodeRuntimeLabel index).1
  simp [runtimeMachine, result, runtime_equal_exact]

theorem runtime_machine_step_exact {states pcs events components : Nat}
    (table : GlobalTable states events components)
    (bodies : Actor components → Controller states pcs events)
    (initial before after : RuntimeConfiguration states pcs components)
    (actor : Actor components) (observation : Observation (Fin events)) :
    (runtimeMachine table bodies initial).step before (encodeRuntimeLabel (actor, observation)) after = true ↔
      runtimeRun table bodies before actor = (observation, after) := by
  simpa [decode_encode_runtime_label] using
    runtime_machine_step_decodes table bodies initial before after (encodeRuntimeLabel (actor, observation))

theorem runtime_reachable_decodes {states pcs events components : Nat}
    (table : GlobalTable states events components)
    (bodies : Actor components → Controller states pcs events)
    (initial : RuntimeConfiguration states pcs components) {configuration : RuntimeConfiguration states pcs components}
    (reachable : SGDFiniteConfigurations.NativeReachable (runtimeMachine table bodies initial) configuration) :
    Reach (fun state => state = initial) (RuntimeStep table bodies) configuration := by
  induction reachable with
  | start initialState => exact .start ((runtime_initial_exact table bodies initial _).mp initialState)
  | advance previous edge ih =>
    obtain ⟨index, actual⟩ := edge
    exact .advance ih ⟨(decodeRuntimeLabel index).1, (decodeRuntimeLabel index).2,
      (runtime_machine_step_decodes table bodies initial _ _ index).mp actual⟩

theorem runtime_reachable_encodes {states pcs events components : Nat}
    (table : GlobalTable states events components)
    (bodies : Actor components → Controller states pcs events)
    (initial : RuntimeConfiguration states pcs components) {configuration : RuntimeConfiguration states pcs components}
    (reachable : Reach (fun state => state = initial) (RuntimeStep table bodies) configuration) :
    SGDFiniteConfigurations.NativeReachable (runtimeMachine table bodies initial) configuration := by
  induction reachable with
  | start initialState => exact .start ((runtime_initial_exact table bodies initial _).mpr initialState)
  | advance previous edge ih =>
    obtain ⟨actor, observation, actual⟩ := edge
    exact .advance ih ⟨encodeRuntimeLabel (actor, observation),
      (runtime_machine_step_exact table bodies initial _ _ actor observation).mpr actual⟩

theorem complete_global_runtime_reachability_iff {states pcs events components : Nat}
    (table : GlobalTable states events components)
    (bodies : Actor components → Controller states pcs events)
    (initial configuration : RuntimeConfiguration states pcs components) :
    SGDFiniteConfigurations.NativeReachable (runtimeMachine table bodies initial) configuration ↔
      Reach (fun state => state = initial) (RuntimeStep table bodies) configuration :=
  ⟨runtime_reachable_decodes table bodies initial, runtime_reachable_encodes table bodies initial⟩

def compiledRuntimeContract {states pcs events components : Nat}
    (automaton : TypedAutomaton (Fin (states + 1)) (Actor components × Fin events))
    (invariant : Fin (states + 1) → Bool) :
    SGDFiniteConfigurations.NativeContract (RuntimeConfiguration states pcs components)
      ((components + 1) * (2 * events + 2)) where
  initialOK configuration := decide (configuration.owner = automaton.initial)
  stateOK configuration := invariant configuration.owner
  edgeOK before index after :=
    let label := decodeRuntimeLabel index
    compiledEdge automaton (liftObservation label.1 label.2) before.owner after.owner

theorem compiled_global_contract_iff_actual_source_compliance {states pcs events components : Nat}
    (source : Source (states + 1) (Actor components × Fin events))
    (automaton : TypedAutomaton (Fin (states + 1)) (Actor components × Fin events))
    (compiled : compileSource source = .ok automaton)
    (actualTable : GlobalTable states events components)
    (bodies : Actor components → Controller states pcs events)
    (initial : RuntimeConfiguration states pcs components) (invariant : Fin (states + 1) → Bool) :
    SGDFiniteConfigurations.NativeConforms (runtimeMachine actualTable bodies initial)
      (compiledRuntimeContract automaton invariant) ↔
      RuntimeConforms source actualTable bodies initial invariant := by
  have initialSame := (compile_success_shape source automaton compiled).2.1
  constructor
  · rintro ⟨initials, states⟩
    refine ⟨?_, ?_⟩
    · have valid := initials initial ((runtime_initial_exact actualTable bodies initial initial).mpr rfl)
      simpa [compiledRuntimeContract, initialSame] using valid
    · intro before reachable
      have checked := states before (runtime_reachable_encodes actualTable bodies initial reachable)
      refine ⟨checked.1, ?_⟩
      intro actor observation after actual
      have edge := checked.2 (encodeRuntimeLabel (actor, observation)) after
        ((runtime_machine_step_exact actualTable bodies initial before after actor observation).mpr actual)
      have observed : compiledEdge automaton (liftObservation actor observation) before.owner after.owner = true := by
        simpa [compiledRuntimeContract, decode_encode_runtime_label] using edge
      exact (compiled_edge_iff_source_observation source automaton compiled _ _ _).mp observed
  · rintro ⟨initialValid, states⟩
    refine ⟨?_, ?_⟩
    · intro configuration begins
      have same := (runtime_initial_exact actualTable bodies initial configuration).mp begins
      simpa [compiledRuntimeContract, initialSame, same] using initialValid
    · intro before reachable
      have checked := states before (runtime_reachable_decodes actualTable bodies initial reachable)
      refine ⟨checked.1, ?_⟩
      intro index after encoded
      have actual := (runtime_machine_step_decodes actualTable bodies initial before after index).mp encoded
      exact (compiled_edge_iff_source_observation source automaton compiled _ _ _).mpr
        (checked.2 (decodeRuntimeLabel index).1 (decodeRuntimeLabel index).2 after actual)

/- Central equivalence is over every reachable global configuration and actual
   scheduler label. The installed policy is an independent input here, so a
   wrong policy is not silently replaced with the intended specification. -/
def globalSemanticLint {states pcs events components : Nat}
    (source : Source (states + 1) (Actor components × Fin events))
    (actualTable : GlobalTable states events components)
    (bodies : Actor components → Controller states pcs events)
    (initial : RuntimeConfiguration states pcs components) (invariant : Fin (states + 1) → Bool) : Bool :=
  match compileSource source with
  | .error _ => false
  | .ok automaton => SGDFiniteConfigurations.checkFiniteConfigurations
      (runtimeEnumeration states pcs components) (runtimeMachine actualTable bodies initial)
      (compiledRuntimeContract automaton invariant)

theorem compiled_global_lint_iff_actual_source_compliance {states pcs events components : Nat}
    (source : Source (states + 1) (Actor components × Fin events))
    (automaton : TypedAutomaton (Fin (states + 1)) (Actor components × Fin events))
    (compiled : compileSource source = .ok automaton)
    (actualTable : GlobalTable states events components)
    (bodies : Actor components → Controller states pcs events)
    (initial : RuntimeConfiguration states pcs components) (invariant : Fin (states + 1) → Bool) :
    globalSemanticLint source actualTable bodies initial invariant = true ↔
      RuntimeConforms source actualTable bodies initial invariant := by
  simp only [globalSemanticLint, compiled]
  exact (SGDFiniteConfigurations.finite_configuration_checker_iff_native_conformance _ _ _).trans
    (compiled_global_contract_iff_actual_source_compliance source automaton compiled actualTable bodies initial invariant)

theorem global_generated_constraints_iff_actual_source_compliance {states pcs events components : Nat}
    (source : Source (states + 1) (Actor components × Fin events))
    (actualTable : GlobalTable states events components)
    (bodies : Actor components → Controller states pcs events)
    (initial : RuntimeConfiguration states pcs components) (invariant : Fin (states + 1) → Bool) :
    globalSemanticLint source actualTable bodies initial invariant = true ↔
      SourceAdmitted source ∧ SourceDeterministic source ∧
        RuntimeConforms source actualTable bodies initial invariant := by
  constructor
  · intro passed
    cases compiled : compileSource source with
    | error reason => simp [globalSemanticLint, compiled] at passed
    | ok automaton =>
      have sourceOK := (compile_success_iff_admitted_deterministic source).mp ⟨automaton, compiled⟩
      exact ⟨sourceOK.1, sourceOK.2,
        (compiled_global_lint_iff_actual_source_compliance source automaton compiled actualTable bodies initial invariant).mp passed⟩
  · rintro ⟨supported, deterministic, conforms⟩
    obtain ⟨automaton, compiled⟩ := (compile_success_iff_admitted_deterministic source).mpr ⟨supported, deterministic⟩
    exact (compiled_global_lint_iff_actual_source_compliance source automaton compiled actualTable bodies initial invariant).mpr conforms

/- The independently requested static no-bypass contract is an explicit extra
   conjunct, not a hidden strengthening of reachable semantic compliance. -/
def globalCombinedLint {states pcs events components : Nat}
    (source : Source (states + 1) (Actor components × Fin events))
    (actualTable : GlobalTable states events components)
    (bodies : Actor components → Controller states pcs events)
    (initial : RuntimeConfiguration states pcs components) (invariant : Fin (states + 1) → Bool) : Bool :=
  checkWorld (runtimeWorld bodies initial) && globalSemanticLint source actualTable bodies initial invariant

theorem global_combined_lint_iff_explicit_contract {states pcs events components : Nat}
    (source : Source (states + 1) (Actor components × Fin events))
    (actualTable : GlobalTable states events components)
    (bodies : Actor components → Controller states pcs events)
    (initial : RuntimeConfiguration states pcs components) (invariant : Fin (states + 1) → Bool) :
    globalCombinedLint source actualTable bodies initial invariant = true ↔
      (∀ actor, BodyAdmitted (bodies actor)) ∧ SourceAdmitted source ∧ SourceDeterministic source ∧
        RuntimeConforms source actualTable bodies initial invariant := by
  simp only [globalCombinedLint, Bool.and_eq_true, world_check_exact,
    global_generated_constraints_iff_actual_source_compliance, WorldAdmitted, runtimeWorld]

/- A complete TypeScript runtime with two components and one environment.
   Each actor receives a generated specialization, so one component cannot use
   another component's permission for the same local event. -/
def sharedSource : Source 2 (Actor 2 × Fin 1) :=
  ⟨0, [⟨(.component 0, 0), .stateIs 0, .set 1⟩,
       ⟨(.component 1, 0), .stateIs 1, .keep⟩,
       ⟨(.environment, 0), .stateIs 1, .keep⟩]⟩

def sharedTable : GlobalTable 1 1 2 :=
  [((0, (.component 0, 0)), 1), ((1, (.component 1, 0)), 1), ((1, (.environment, 0)), 1)]

def firstTS : Controller 1 0 1 :=
  .ts ⟨[(1, .authority), (2, .variable 1)], fun _ => .send (.variable 2) 0 0 0⟩
def secondTS : Controller 1 0 1 :=
  .ts ⟨[(10, .authority), (20, .variable 10)], fun _ => .send (.variable 20) 0 0 0⟩
def sharedEnvironment : Controller 1 0 1 :=
  .ts ⟨[], fun _ => .send .authority 0 0 0⟩
def sharedBodies : Actor 2 → Controller 1 0 1
  | .component identity => if identity = 0 then firstTS else secondTS
  | .environment => sharedEnvironment

def sharedInitial : RuntimeConfiguration 1 0 2 := ⟨0, fun _ => 0, 0⟩
def sharedAfterFirst := (runtimeRun sharedTable sharedBodies sharedInitial (.component 0)).2
def sharedAfterSecond := (runtimeRun sharedTable sharedBodies sharedAfterFirst (.component 1)).2
def sharedAfterEnvironment := (runtimeRun sharedTable sharedBodies sharedAfterSecond .environment).2

theorem shared_runtime_observations_are_actor_bound :
    (runtimeRun sharedTable sharedBodies sharedInitial (.component 1)).1 = .rejected 0 ∧
    (runtimeRun sharedTable sharedBodies sharedInitial (.component 0)).1 = .accepted 0 ∧
    sharedAfterFirst.owner = 1 ∧
    (runtimeRun sharedTable sharedBodies sharedAfterFirst (.component 1)).1 = .accepted 0 ∧
    (runtimeRun sharedTable sharedBodies sharedAfterSecond .environment).1 = .accepted 0 ∧
    sharedAfterEnvironment.owner = 1 := by decide

theorem shared_profile_execution_is_reachable :
    Reach (fun configuration => configuration = sharedInitial)
      (RuntimeStep sharedTable sharedBodies) sharedAfterEnvironment := by
  have initial : Reach (fun configuration => configuration = sharedInitial)
      (RuntimeStep sharedTable sharedBodies) sharedInitial := .start rfl
  have ts := Reach.advance initial ⟨.component 0, _, rfl⟩
  have second := Reach.advance ts ⟨.component 1, _, rfl⟩
  exact Reach.advance second ⟨.environment, _, rfl⟩

theorem shared_global_generated_constraints_accept :
    globalCombinedLint sharedSource sharedTable sharedBodies sharedInitial (fun _ => true) = true := by decide

def sharedChecked : CheckedWorld 1 0 1 2 :=
  ⟨runtimeWorld sharedBodies sharedInitial, (world_check_exact _).mp (by decide)⟩
def alternativeTS : Controller 1 0 1 :=
  .ts ⟨[(9, .authority)], fun _ => .send (.variable 9) 0 0 0⟩
def checkedAfterSecondRefusal := checkedRun sharedTable sharedChecked (.component 1)
def checkedAfterSourceEdit := checkedEdit checkedAfterSecondRefusal (.component 0) alternativeTS (by decide)
def checkedAfterTSExecution := checkedRun sharedTable checkedAfterSourceEdit (.component 0)
def checkedAfterEnvironment := checkedRun sharedTable checkedAfterTSExecution .environment

theorem checked_edits_and_cyclic_runtime_are_one_actual_history :
    Reach (fun world : CheckedWorld 1 0 1 2 => world = sharedChecked)
      (CheckedStep sharedTable) checkedAfterEnvironment ∧
    checkedAfterSourceEdit.val.owner = 0 ∧ checkedAfterEnvironment.val.owner = 1 := by
  have initial : Reach (fun world : CheckedWorld 1 0 1 2 => world = sharedChecked)
      (CheckedStep sharedTable) sharedChecked := .start rfl
  have refused := Reach.advance initial (checked_run_is_actual_raw_step sharedTable sharedChecked (.component 1))
  have edited := Reach.advance refused
    (checked_edit_is_actual_raw_step sharedTable checkedAfterSecondRefusal (.component 0) alternativeTS (by decide))
  have ran := Reach.advance edited (checked_run_is_actual_raw_step sharedTable checkedAfterSourceEdit (.component 0))
  exact ⟨Reach.advance ran (checked_run_is_actual_raw_step sharedTable checkedAfterTSExecution .environment), rfl, rfl⟩

def bypassBody : Controller 1 0 1 := .ts ⟨[], fun _ => .writeProtected 1 0⟩

theorem actual_raw_write_is_present_but_static_admission_rejects_it :
    (runController sharedTable (.component 0) bypassBody ⟨0, 0⟩).1 = .forbidden ∧
    (runController sharedTable (.component 0) bypassBody ⟨0, 0⟩).2.owner = 1 ∧
    checkWorld (editWorld sharedChecked.val (.component 0) bypassBody) = false := by decide

/- A currently unused wrong authority can satisfy the standalone reachable
   semantic contract. Full installed-policy binding is an explicit extra gate. -/
def neverCallsAuthority : TSProgram 1 0 1 :=
  ⟨0, 0, [], .reject, fun _ => .jump 0⟩

theorem entry_semantics_does_not_silently_supply_future_binding :
    tsCombinedLint progressSource neverCallsAuthority (fun _ => true) = true ∧
    checkTSInstalled sharedTable (.component 0) 0 neverCallsAuthority = false := by decide

theorem imported_ts_entry_is_preserved {states pcs events components : Nat}
    (table : GlobalTable states events components) (actor : Actor components)
    (initialOwner : Fin (states + 1)) (program : TSProgram states pcs events)
    (bound : TSInstalledContract table actor initialOwner program) :
    runController table actor (.ts ⟨program.aliases, program.code⟩) ⟨initialOwner, program.entry⟩ =
      tsRun program ⟨program.initialOwner, program.entry⟩ := by
  rw [← bound.1]
  exact imported_ts_execution_preserved table actor initialOwner program bound _

end SGDProfileComposition





#print axioms SGDProfileComposition.specialized_membership_exact
#print axioms SGDProfileComposition.specialization_is_functional
#print axioms SGDProfileComposition.ts_body_refines_global_policy
#print axioms SGDProfileComposition.controller_refines_global_policy
#print axioms SGDProfileComposition.world_check_exact
#print axioms SGDProfileComposition.checked_edit_iff_body_contract
#print axioms SGDProfileComposition.checked_run_is_actual_raw_step
#print axioms SGDProfileComposition.checked_step_projection
#print axioms SGDProfileComposition.profile_evolution_has_root_reachability
#print axioms SGDProfileComposition.profile_evolution_preserves_root_safety
#print axioms SGDProfileComposition.profile_evolution_preserves_world_requirement

#print axioms SGDProfileComposition.installed_ts_check_exact
#print axioms SGDProfileComposition.imported_ts_execution_preserved
#print axioms SGDProfileComposition.generated_policy_binding_is_structural

#print axioms SGDProfileComposition.runtime_equal_exact
#print axioms SGDProfileComposition.full_world_reconstructed_when_code_fixed
#print axioms SGDProfileComposition.runtime_run_retains_all_world_fields
#print axioms SGDProfileComposition.decode_encode_actor
#print axioms SGDProfileComposition.encode_decode_actor
#print axioms SGDProfileComposition.decode_encode_runtime_label
#print axioms SGDProfileComposition.encode_decode_runtime_label

#print axioms SGDProfileComposition.runtime_initial_exact
#print axioms SGDProfileComposition.runtime_machine_step_exact
#print axioms SGDProfileComposition.complete_global_runtime_reachability_iff
#print axioms SGDProfileComposition.compiled_global_contract_iff_actual_source_compliance
#print axioms SGDProfileComposition.global_generated_constraints_iff_actual_source_compliance
#print axioms SGDProfileComposition.global_combined_lint_iff_explicit_contract

#print axioms SGDProfileComposition.shared_runtime_observations_are_actor_bound
#print axioms SGDProfileComposition.shared_profile_execution_is_reachable
#print axioms SGDProfileComposition.shared_global_generated_constraints_accept
#print axioms SGDProfileComposition.checked_edits_and_cyclic_runtime_are_one_actual_history
#print axioms SGDProfileComposition.actual_raw_write_is_present_but_static_admission_rejects_it
#print axioms SGDProfileComposition.entry_semantics_does_not_silently_supply_future_binding
#print axioms SGDProfileComposition.imported_ts_entry_is_preserved
