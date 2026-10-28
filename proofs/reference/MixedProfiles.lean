import RustProfile
import CertifiedPipeline

/- Mixed finite-language reference programs. Rust's scoped loan/Result syntax
   has its own execution. Its explicit lowering preserves raw execution,
   including forbidden writes, and preserves structural admission exactly.
   All components and the environment share the complete runtime configuration.
   This does not establish native-language or FFI correspondence. -/
namespace SGDMixedProfiles
open SGDMethod SGDCompilerPipeline SGDCompilerLintBridge SGDLanguageProfiles
open SGDProfileComposition SGDDevelopmentRefinement

structure RustBody (states pcs events : Nat) where
  ownerBinding : Nat
  code : Fin (pcs + 1) → SGDRustProfile.Instruction states pcs events

inductive Body (states pcs events : Nat)
  | ts : TSBody states pcs events → Body states pcs events
  | rust : RustBody states pcs events → Body states pcs events

def lowerPlace (owner : Nat) (place : SGDRustProfile.Place) : TSRef :=
  if SGDRustProfile.rootBinding place = owner then .authority else .foreign

def lowerInstruction {states pcs events : Nat} (owner : Nat) :
    SGDRustProfile.Instruction states pcs events → TSInstruction states pcs events
  | .goto next => .jump next
  | .matchOwner expected yes no => .ifOwner expected yes no
  | .withOwnerMut place event yes no => .send (lowerPlace owner place) event yes no
  | .assign next pc => .writeProtected next pc
  | .replace next pc => .replaceOwner next pc
  | .unknown tag => .unknown tag

def lowerAuthority {S E : Type} : SGDRustProfile.MatchBody S E → TSAuthority S E
  | .err => .reject
  | .arm pattern next rest => .ifKey pattern next (lowerAuthority rest)

theorem lower_authority_exact {S E : Type} [DecidableEq S] [DecidableEq E]
    (body : SGDRustProfile.MatchBody S E) (query : S × E) :
    tsAuthorityEval (lowerAuthority body) query =
      SGDRustProfile.resultOption (SGDRustProfile.evalMatch body query) := by
  induction body with
  | err => rfl
  | arm pattern next rest ih =>
      simp only [lowerAuthority, tsAuthorityEval, SGDRustProfile.evalMatch]
      split <;> simp_all [SGDRustProfile.resultOption]

theorem lower_generated_authority {S E : Type} (table : List ((S × E) × S)) :
    lowerAuthority (SGDRustProfile.emitMatch table) = emitTSAuthority table := by
  induction table with
  | nil => rfl
  | cons entry rest ih =>
      rcases entry with ⟨pattern, next⟩
      simp [SGDRustProfile.emitMatch, lowerAuthority, emitTSAuthority, ih]

def lowerProgram {states pcs events : Nat} (program : SGDRustProfile.Program states pcs events) :
    TSProgram states pcs events :=
  ⟨program.initialOwner, program.entry, [], lowerAuthority program.authority,
    fun pc => lowerInstruction program.ownerBinding (program.code pc)⟩

theorem lower_program_execution_exact {states pcs events : Nat}
    (program : SGDRustProfile.Program states pcs events) (live : Configuration states pcs) :
    tsRun (lowerProgram program) live = SGDRustProfile.run program live := by
  cases form : program.code live.pc with
  | goto next => simp [tsRun, lowerProgram, lowerInstruction, SGDRustProfile.run, form]
  | matchOwner expected yes no => simp [tsRun, lowerProgram, lowerInstruction, SGDRustProfile.run, form]
  | assign next pc => simp [tsRun, lowerProgram, lowerInstruction, SGDRustProfile.run, form]
  | replace next pc => simp [tsRun, lowerProgram, lowerInstruction, SGDRustProfile.run, form]
  | unknown tag => simp [tsRun, lowerProgram, lowerInstruction, SGDRustProfile.run, form]
  | withOwnerMut place event yes no =>
      by_cases bound : SGDRustProfile.rootBinding place = program.ownerBinding
      · simp only [tsRun, lowerProgram, lowerInstruction, form, lowerPlace, bound, ↓reduceIte,
          tsResolve, SGDRustProfile.run, lower_authority_exact]
        cases found : SGDRustProfile.evalMatch program.authority (live.owner, event) <;>
          simp [SGDRustProfile.resultOption]
      · simp [tsRun, lowerProgram, lowerInstruction, form, lowerPlace, bound,
          tsResolve, SGDRustProfile.run]

theorem lower_instruction_admission_exact {states pcs events : Nat} (owner : Nat)
    (instruction : SGDRustProfile.Instruction states pcs events) :
    TSInstructionDisciplined (tsAliases []) (lowerInstruction owner instruction) ↔
      SGDRustProfile.InstructionAdmitted owner instruction := by
  cases instruction with
  | withOwnerMut place event yes no =>
      by_cases bound : SGDRustProfile.rootBinding place = owner <;>
        simp [lowerInstruction, TSInstructionDisciplined, SGDRustProfile.InstructionAdmitted,
          lowerPlace, tsResolve, bound]
  | goto next => trivial
  | matchOwner expected yes no => trivial
  | assign next pc => rfl
  | replace next pc => rfl
  | unknown tag => rfl

def lowerBody {states pcs events : Nat} : Body states pcs events → Controller states pcs events
  | .ts body => .ts body
  | .rust body => .ts ⟨[], fun pc => lowerInstruction body.ownerBinding (body.code pc)⟩

def Admitted {states pcs events : Nat} : Body states pcs events → Prop
  | .ts body => BodyAdmitted (.ts body)
  | .rust body => ∀ pc, SGDRustProfile.InstructionAdmitted body.ownerBinding (body.code pc)

theorem lower_body_admission_exact {states pcs events : Nat} (body : Body states pcs events) :
    BodyAdmitted (lowerBody body) ↔ Admitted body := by
  cases body with
  | ts body => rfl
  | rust body =>
      simp [lowerBody, BodyAdmitted, TSStaticContract, TSAliasesBound, Admitted,
        lower_instruction_admission_exact]

def runBody {states pcs events components : Nat} (table : GlobalTable states events components)
    (actor : Actor components) : Body states pcs events → Configuration states pcs →
      Observation (Fin events) × Configuration states pcs
  | .ts body, live => tsRun (bindTS table actor body live) live
  | .rust body, live => SGDRustProfile.run
      ⟨live.owner, live.pc, body.ownerBinding, SGDRustProfile.emitMatch (specialize table actor), body.code⟩ live

theorem lower_body_execution_exact {states pcs events components : Nat}
    (table : GlobalTable states events components) (actor : Actor components)
    (body : Body states pcs events) (live : Configuration states pcs) :
    runController table actor (lowerBody body) live = runBody table actor body live := by
  cases body with
  | ts body => rfl
  | rust body =>
      have exactRun := lower_program_execution_exact
        (SGDRustProfile.Program.mk live.owner live.pc body.ownerBinding
          (SGDRustProfile.emitMatch (specialize table actor)) body.code) live
      simpa [runController, lowerBody, runBody, bindTS, lowerProgram, lower_generated_authority] using exactRun

structure World (states pcs events components : Nat) where
  owner : Fin (states + 1)
  code : Actor components → Body states pcs events
  pc : Actor components → Fin (pcs + 1)

def lowerWorld {states pcs events components : Nat} (world : World states pcs events components) :
    SGDProfileComposition.World states pcs events components :=
  ⟨world.owner, fun actor => lowerBody (world.code actor), world.pc⟩

def runWorld {states pcs events components : Nat} (table : GlobalTable states events components)
    (world : World states pcs events components) (actor : Actor components) : World states pcs events components :=
  let result := runBody table actor (world.code actor) ⟨world.owner, world.pc actor⟩
  { world with owner := result.2.owner,
               pc := fun other => if other = actor then result.2.pc else world.pc other }

def editWorld {states pcs events components : Nat} (world : World states pcs events components)
    (actor : Actor components) (replacement : Body states pcs events) : World states pcs events components :=
  { world with code := fun other => if other = actor then replacement else world.code other }

theorem lower_world_run_exact {states pcs events components : Nat}
    (table : GlobalTable states events components) (world : World states pcs events components)
    (actor : Actor components) :
    lowerWorld (runWorld table world actor) =
      SGDProfileComposition.runWorld table (lowerWorld world) actor := by
  simp [lowerWorld, runWorld, SGDProfileComposition.runWorld, lower_body_execution_exact]

theorem lower_world_edit_exact {states pcs events components : Nat}
    (world : World states pcs events components) (actor : Actor components)
    (replacement : Body states pcs events) :
    lowerWorld (editWorld world actor replacement) =
      SGDProfileComposition.editWorld (lowerWorld world) actor (lowerBody replacement) := by
  simp only [lowerWorld, editWorld, SGDProfileComposition.editWorld]
  congr 1
  funext other
  split <;> rfl

def WorldAdmitted {states pcs events components : Nat} (world : World states pcs events components) : Prop :=
  ∀ actor, Admitted (world.code actor)

theorem lower_world_admission_exact {states pcs events components : Nat}
    (world : World states pcs events components) :
    SGDProfileComposition.WorldAdmitted (lowerWorld world) ↔ WorldAdmitted world := by
  simp [SGDProfileComposition.WorldAdmitted, WorldAdmitted, lowerWorld, lower_body_admission_exact]

inductive RawStep {states pcs events components : Nat} (table : GlobalTable states events components) :
    World states pcs events components → World states pcs events components → Prop
  | run (world : World states pcs events components) (actor : Actor components) :
      RawStep table world (runWorld table world actor)
  | edit (world : World states pcs events components) (actor : Actor components)
      (replacement : Body states pcs events) : RawStep table world (editWorld world actor replacement)

theorem lower_raw_step {states pcs events components : Nat}
    {table : GlobalTable states events components} {before after : World states pcs events components}
    (step : RawStep table before after) :
    ∃ label, RawWorldStep table label (lowerWorld before) (lowerWorld after) := by
  cases step with
  | run actor =>
      rw [lower_world_run_exact]
      exact ⟨_, .run _ actor⟩
  | edit actor replacement =>
      rw [lower_world_edit_exact]
      exact ⟨_, .edit _ actor _⟩

abbrev CheckedWorld (states pcs events components : Nat) :=
  { world : World states pcs events components // WorldAdmitted world }

def CheckedStep {states pcs events components : Nat} (table : GlobalTable states events components)
    (before after : CheckedWorld states pcs events components) : Prop := RawStep table before.val after.val

theorem mixed_checked_step_projection {states pcs events components : Nat}
    (table : GlobalTable states events components) :
    StepRefines (CheckedStep (pcs := pcs) table) (SGDWholeProgram.ModelStep table)
      (fun world => world.val.owner) := by
  intro before after step
  obtain ⟨label, raw⟩ := lower_raw_step step
  exact raw_step_projects_under_body_contract
    ((lower_world_admission_exact before.val).mpr before.property) raw

abbrev MixedStates (states pcs events components : Nat → Nat) (n : Nat) :=
  CheckedWorld (states n) (pcs n) (events n) (components n)

def project {states pcs events components : Nat → Nat}
    (n : Nat) (world : MixedStates states pcs events components n) : Fin (states n + 1) := world.val.owner

abbrev Evolution {states pcs events components : Nat → Nat}
    (tables : (n : Nat) → GlobalTable (states n) (events n) (components n))
    (previous : (n : Nat) → Fin (states (n + 1) + 1) → Fin (states n + 1)) (approved : Nat → Prop) :=
  EvolutionStep (C := MixedStates states pcs events components)
    (fun n => CheckedStep (pcs := pcs n) (tables n))
    (fun n => SGDWholeProgram.ModelStep (tables n)) project previous approved

theorem mixed_development_has_root_reachability {states pcs events components : Nat → Nat}
    (tables : (n : Nat) → GlobalTable (states n) (events n) (components n))
    (previous : (n : Nat) → Fin (states (n + 1) + 1) → Fin (states n + 1))
    (approved : Nat → Prop) (initial : Fin (states 0 + 1) → Prop)
    {world : Versioned (MixedStates states pcs events components)}
    (history : Reach (RootInitial project initial) (Evolution tables previous approved) world) :
    ApprovedChain (fun n => SGDWholeProgram.ModelStep (tables n)) previous approved world.1 ∧
      Reach initial (SGDWholeProgram.ModelStep (tables 0)) (projectedRoot project previous world) := by
  apply arbitrary_development_composes_refinements _ _ _ _ _ _ _ history
  intro n
  exact mixed_checked_step_projection (pcs := pcs n) (tables n)

/- Fixed installed runtime: each body receives a generated authority for its
   actor. This is construction of the reference runtime, not validation of an
   arbitrary imported native program. The semantic checker below can accept a
   table differing only at unexecuted entries; it does not prove table identity. -/
def runtimeRun {states pcs events components : Nat}
    (table : GlobalTable states events components) (bodies : Actor components → Body states pcs events)
    (configuration : RuntimeConfiguration states pcs components) (actor : Actor components) :
    Observation (Fin events) × RuntimeConfiguration states pcs components :=
  let pc := fun actor => match actor with
    | .component identity => configuration.componentPC identity
    | .environment => configuration.environmentPC
  let result := runBody table actor (bodies actor) ⟨configuration.owner, pc actor⟩
  let nextPC := fun other => if other = actor then result.2.pc else pc other
  (result.1, ⟨result.2.owner, fun i => nextPC (.component i), nextPC .environment⟩)

theorem lower_runtime_execution_exact {states pcs events components : Nat}
    (table : GlobalTable states events components) (bodies : Actor components → Body states pcs events)
    (configuration : RuntimeConfiguration states pcs components) (actor : Actor components) :
    SGDProfileComposition.runtimeRun table (fun actor => lowerBody (bodies actor)) configuration actor =
      runtimeRun table bodies configuration actor := by
  simp only [SGDProfileComposition.runtimeRun, runtimeRun, runtimeWorld,
    SGDProfileComposition.runWorld, takeConfiguration, lower_body_execution_exact]
  rfl

def RuntimeStep {states pcs events components : Nat}
    (table : GlobalTable states events components) (bodies : Actor components → Body states pcs events)
    (before after : RuntimeConfiguration states pcs components) : Prop :=
  ∃ actor observation, runtimeRun table bodies before actor = (observation, after)

def RuntimeConforms {states pcs events components : Nat}
    (source : Source (states + 1) (Actor components × Fin events))
    (table : GlobalTable states events components) (bodies : Actor components → Body states pcs events)
    (initial : RuntimeConfiguration states pcs components) (invariant : Fin (states + 1) → Bool) : Prop :=
  initial.owner = source.initial ∧
  ∀ before, Reach (fun state => state = initial) (RuntimeStep table bodies) before →
    invariant before.owner = true ∧
    ∀ actor observation after, runtimeRun table bodies before actor = (observation, after) →
      SourceObservation source (liftObservation actor observation) before.owner after.owner

theorem lower_runtime_conformance_exact {states pcs events components : Nat}
    (source : Source (states + 1) (Actor components × Fin events))
    (table : GlobalTable states events components) (bodies : Actor components → Body states pcs events)
    (initial : RuntimeConfiguration states pcs components) (invariant : Fin (states + 1) → Bool) :
    SGDProfileComposition.RuntimeConforms source table (fun actor => lowerBody (bodies actor)) initial invariant ↔
      RuntimeConforms source table bodies initial invariant := by
  have same : SGDProfileComposition.RuntimeStep table (fun actor => lowerBody (bodies actor)) =
      RuntimeStep table bodies := by
    funext before after
    simp only [SGDProfileComposition.RuntimeStep, RuntimeStep, lower_runtime_execution_exact]
  simp only [SGDProfileComposition.RuntimeConforms, RuntimeConforms, same,
    lower_runtime_execution_exact]

def lint {states pcs events components : Nat}
    (source : Source (states + 1) (Actor components × Fin events))
    (table : GlobalTable states events components) (bodies : Actor components → Body states pcs events)
    (initial : RuntimeConfiguration states pcs components) (invariant : Fin (states + 1) → Bool) : Bool :=
  globalCombinedLint source table (fun actor => lowerBody (bodies actor)) initial invariant

theorem mixed_checker_exact {states pcs events components : Nat}
    (source : Source (states + 1) (Actor components × Fin events))
    (table : GlobalTable states events components) (bodies : Actor components → Body states pcs events)
    (initial : RuntimeConfiguration states pcs components) (invariant : Fin (states + 1) → Bool) :
    lint source table bodies initial invariant = true ↔
      (∀ actor, Admitted (bodies actor)) ∧ SourceAdmitted source ∧ SourceDeterministic source ∧
        RuntimeConforms source table bodies initial invariant := by
  simp only [lint, global_combined_lint_iff_explicit_contract,
    lower_body_admission_exact, lower_runtime_conformance_exact]

theorem source_bound_mixed_development_preserves_root_invariant
    {states pcs events components : Nat → Nat}
    {sources : (n : Nat) → Source (states n + 1) (Actor (components n) × Fin (events n))}
    {rootInvariant : Fin (states 0 + 1) → Bool}
    (family : SGDCertifiedPipeline.CertifiedSourceFamily sources rootInvariant)
    (previous : (n : Nat) → Fin (states (n + 1) + 1) → Fin (states n + 1))
    (approved : Nat → Prop)
    {world : Versioned (MixedStates states pcs events components)}
    (history : Reach (RootInitial project (fun state => state = (sources 0).initial))
      (Evolution (SGDCertifiedPipeline.familyTables family) previous approved) world) :
    rootInvariant (projectedRoot project previous world) = true := by
  have reachable := (mixed_development_has_root_reachability
    (SGDCertifiedPipeline.familyTables family) previous approved _ history).2
  have preserved : SGDCertifiedPipeline.RootPredicate family (projectedRoot project previous world) := by
    apply reachable_invariant _ (SGDCertifiedPipeline.RootPredicate family)
      (SGDWholeProgram.ModelStep (SGDCertifiedPipeline.familyTables family 0)) ?_ ?_ reachable
    · intro state initial
      subst state
      exact SGDCertifiedPipeline.certified_root_initial family
    · intro before after valid edge
      obtain ⟨actor, event, member⟩ := edge
      exact SGDCertifiedPipeline.certified_root_edge_preserves_strengthening family before actor event after valid member
  exact preserved.2

def mixedBodies : Actor 2 → Body 1 0 1
  | .component identity => if identity = 0 then
      .ts ⟨[(1, .authority)], fun _ => .send (.variable 1) 0 0 0⟩
    else .rust ⟨7, fun _ => .withOwnerMut (.reborrow (.root 7)) 0 0 0⟩
  | .environment => .ts ⟨[], fun _ => .send .authority 0 0 0⟩

def mixedAfterFirst := (runtimeRun sharedTable mixedBodies sharedInitial (.component 0)).2

theorem mixed_program_is_nonvacuous :
    lint sharedSource sharedTable mixedBodies sharedInitial (fun _ => true) = true ∧
    (runtimeRun sharedTable mixedBodies sharedInitial (.component 1)).1 = .rejected 0 ∧
    (runtimeRun sharedTable mixedBodies sharedInitial (.component 0)).1 = .accepted 0 ∧
    mixedAfterFirst.owner = 1 ∧
    (runtimeRun sharedTable mixedBodies mixedAfterFirst (.component 1)).1 = .accepted 0 := by decide

def mixedInitialWorld : World 1 0 1 2 := ⟨0, mixedBodies, fun _ => 0⟩
def mixedFirstWorld := runWorld sharedTable mixedInitialWorld (.component 0)
def replacementRust : Body 1 0 1 :=
  .rust ⟨9, fun _ => .withOwnerMut (.reborrow (.reborrow (.root 9))) 0 0 0⟩
def mixedEditedWorld := editWorld mixedFirstWorld (.component 1) replacementRust
def mixedFinalWorld := runWorld sharedTable mixedEditedWorld (.component 1)

def mixedInitialChecked : CheckedWorld 1 0 1 2 :=
  ⟨mixedInitialWorld, (lower_world_admission_exact _).mp ((world_check_exact _).mp (by decide))⟩
def mixedFirstChecked : CheckedWorld 1 0 1 2 :=
  ⟨mixedFirstWorld, (lower_world_admission_exact _).mp ((world_check_exact _).mp (by decide))⟩
def mixedEditedChecked : CheckedWorld 1 0 1 2 :=
  ⟨mixedEditedWorld, (lower_world_admission_exact _).mp ((world_check_exact _).mp (by decide))⟩
def mixedFinalChecked : CheckedWorld 1 0 1 2 :=
  ⟨mixedFinalWorld, (lower_world_admission_exact _).mp ((world_check_exact _).mp (by decide))⟩

theorem mixed_execution_and_edits_are_nonvacuous :
    Reach (fun world => world = mixedInitialChecked) (CheckedStep sharedTable) mixedFinalChecked ∧
      mixedFirstWorld.owner = mixedEditedWorld.owner ∧ mixedFinalWorld.owner = 1 := by
  have first : CheckedStep sharedTable mixedInitialChecked mixedFirstChecked := .run _ (.component 0)
  have edit : CheckedStep sharedTable mixedFirstChecked mixedEditedChecked :=
    .edit _ (.component 1) replacementRust
  have last : CheckedStep sharedTable mixedEditedChecked mixedFinalChecked := .run _ (.component 1)
  exact ⟨.advance (.advance (.advance (.start rfl) first) edit) last, rfl, rfl⟩

/- Import gate for standalone reference programs. Code, entry, live owner and
   root binding must match the intended installed body. The authority comparison
   covers every finite query, including states unreachable from this entry.
   This validates reference syntax only; no native parser/FFI is involved. -/
deriving instance DecidableEq for SGDRustProfile.Instruction
deriving instance DecidableEq for Except

def RustInstalledContract {states pcs events components : Nat}
    (table : GlobalTable states events components) (actor : Actor components)
    (initial : Configuration states pcs) (body : RustBody states pcs events)
    (program : SGDRustProfile.Program states pcs events) : Prop :=
  program.initialOwner = initial.owner ∧ program.entry = initial.pc ∧
  program.ownerBinding = body.ownerBinding ∧
  (∀ pc, program.code pc = body.code pc) ∧
  ∀ state event, SGDRustProfile.evalMatch program.authority (state, event) =
    SGDRustProfile.evalMatch (SGDRustProfile.emitMatch (specialize table actor)) (state, event)

def checkRustInstalled {states pcs events components : Nat}
    (table : GlobalTable states events components) (actor : Actor components)
    (initial : Configuration states pcs) (body : RustBody states pcs events)
    (program : SGDRustProfile.Program states pcs events) : Bool :=
  decide (program.initialOwner = initial.owner) &&
  (decide (program.entry = initial.pc) &&
  (decide (program.ownerBinding = body.ownerBinding) &&
  (SGDSemanticConstraints.everyFin (pcs + 1) (fun pc => decide (program.code pc = body.code pc)) &&
    SGDSemanticConstraints.everyFin (states + 1) (fun state =>
      SGDSemanticConstraints.everyFin events (fun event =>
        decide (SGDRustProfile.evalMatch program.authority (state, event) =
          SGDRustProfile.evalMatch (SGDRustProfile.emitMatch (specialize table actor)) (state, event)))))))

theorem installed_rust_check_exact {states pcs events components : Nat}
    (table : GlobalTable states events components) (actor : Actor components)
    (initial : Configuration states pcs) (body : RustBody states pcs events)
    (program : SGDRustProfile.Program states pcs events) :
    checkRustInstalled table actor initial body program = true ↔
      RustInstalledContract table actor initial body program := by
  simp [checkRustInstalled, RustInstalledContract, SGDSemanticConstraints.everyFin_exact]

theorem imported_rust_execution_preserved {states pcs events components : Nat}
    (table : GlobalTable states events components) (actor : Actor components)
    (initial : Configuration states pcs) (body : RustBody states pcs events)
    (program : SGDRustProfile.Program states pcs events)
    (bound : RustInstalledContract table actor initial body program) (live : Configuration states pcs) :
    runBody table actor (.rust body) live = SGDRustProfile.run program live := by
  simp [runBody, SGDRustProfile.run, bound.2.2.1, bound.2.2.2.1, bound.2.2.2.2]

def parkedRustBody : RustBody 1 0 1 := ⟨7, fun _ => .goto 0⟩
def parkedWrongAuthority : SGDRustProfile.Program 1 0 1 :=
  ⟨0, 0, 7, .err, parkedRustBody.code⟩

theorem reachable_lint_cannot_replace_full_query_binding :
    SGDRustProfile.lint progressSource parkedWrongAuthority (fun _ => true) = true ∧
    checkRustInstalled sharedTable (.component 0) ⟨0, 0⟩ parkedRustBody parkedWrongAuthority = false := by decide

def correctlyInstalledParked : SGDRustProfile.Program 1 0 1 :=
  { parkedWrongAuthority with authority := SGDRustProfile.emitMatch (specialize sharedTable (.component 0)) }

theorem installed_rust_gate_is_nonvacuous :
    checkRustInstalled sharedTable (.component 0) ⟨0, 0⟩ parkedRustBody correctlyInstalledParked = true ∧
    checkRustInstalled sharedTable (.component 0) ⟨0, 0⟩ parkedRustBody
      { correctlyInstalledParked with ownerBinding := 8 } = false ∧
    checkRustInstalled sharedTable (.component 0) ⟨0, 0⟩ parkedRustBody
      { correctlyInstalledParked with code := fun _ => .unknown 0 } = false := by decide

end SGDMixedProfiles

#print axioms SGDMixedProfiles.lower_program_execution_exact
#print axioms SGDMixedProfiles.lower_body_admission_exact
#print axioms SGDMixedProfiles.lower_raw_step
#print axioms SGDMixedProfiles.mixed_development_has_root_reachability

#print axioms SGDMixedProfiles.lower_runtime_execution_exact
#print axioms SGDMixedProfiles.mixed_checker_exact
#print axioms SGDMixedProfiles.source_bound_mixed_development_preserves_root_invariant
#print axioms SGDMixedProfiles.mixed_program_is_nonvacuous

#print axioms SGDMixedProfiles.lower_authority_exact
#print axioms SGDMixedProfiles.lower_generated_authority
#print axioms SGDMixedProfiles.lower_instruction_admission_exact
#print axioms SGDMixedProfiles.lower_body_execution_exact
#print axioms SGDMixedProfiles.lower_world_run_exact
#print axioms SGDMixedProfiles.lower_world_edit_exact
#print axioms SGDMixedProfiles.lower_world_admission_exact
#print axioms SGDMixedProfiles.mixed_checked_step_projection
#print axioms SGDMixedProfiles.lower_runtime_conformance_exact
#print axioms SGDMixedProfiles.mixed_execution_and_edits_are_nonvacuous

#print axioms SGDMixedProfiles.installed_rust_check_exact
#print axioms SGDMixedProfiles.imported_rust_execution_preserved
#print axioms SGDMixedProfiles.reachable_lint_cannot_replace_full_query_binding
#print axioms SGDMixedProfiles.installed_rust_gate_is_nonvacuous
