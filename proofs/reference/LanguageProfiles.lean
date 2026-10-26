import CompilerLintBridge

/- Finite TypeScript reference source profile only. This is not a parser, full
   native TypeScript semantics, or a proof about the production emitter. Complete
   configurations contain the actual protected owner state and a finite control
   location; aliases are immutable program declarations. There is no
   hidden heap, dynamic allocation, async execution, unwinding, or FFI.

   Raw writes/resets remain executable and carry forbidden provenance. The
   semantic checker never removes a transition because it violates the model.
   Unknown constructs fail the separate static profile check even if unreachable.
   Runtime traces are not stored: the finite machine is a static extraction.
-/
namespace SGDLanguageProfiles
open SGDMethod SGDCompilerPipeline SGDSemanticConstraints SGDCompilerLintBridge

deriving instance DecidableEq for Observation

structure Configuration (states pcs : Nat) where
  owner : Fin (states + 1)
  pc : Fin (pcs + 1)
  deriving DecidableEq

/- Actual configuration fields have a fixed arithmetic encoding. Neither owner
   extraction nor observation interpretation is supplied by the checker caller. -/
def encodeConfig {states pcs : Nat} (c : Configuration states pcs) :
    Fin ((states + 1) * (pcs + 1)) :=
  ⟨c.owner.val * (pcs + 1) + c.pc.val, by
    have first := Nat.add_lt_add_left c.pc.isLt (c.owner.val * (pcs + 1))
    have last := Nat.mul_le_mul_right (pcs + 1) (Nat.succ_le_of_lt c.owner.isLt)
    rw [Nat.succ_mul] at last
    exact Nat.lt_of_lt_of_le first last⟩

def decodeConfig {states pcs : Nat} (i : Fin ((states + 1) * (pcs + 1))) :
    Configuration states pcs :=
  ⟨⟨i.val / (pcs + 1), (Nat.div_lt_iff_lt_mul (Nat.succ_pos pcs)).mpr i.isLt⟩,
   ⟨i.val % (pcs + 1), Nat.mod_lt _ (Nat.succ_pos pcs)⟩⟩

theorem decode_encode_config {states pcs : Nat} (c : Configuration states pcs) :
    decodeConfig (encodeConfig c) = c := by
  cases c with
  | mk owner pc =>
    simp only [decodeConfig, encodeConfig]
    congr 1
    · apply Fin.ext
      simp only
      rw [Nat.add_comm, Nat.add_mul_div_right _ _ (Nat.succ_pos pcs), Nat.div_eq_of_lt pc.isLt]
      simp
    · apply Fin.ext
      simp [Nat.add_mod, Nat.mod_eq_of_lt pc.isLt]

theorem encode_decode_config {states pcs : Nat} (i : Fin ((states + 1) * (pcs + 1))) :
    encodeConfig (decodeConfig i) = i := by
  apply Fin.ext
  simpa [encodeConfig, decodeConfig, Nat.mul_comm] using Nat.div_add_mod i.val (pcs + 1)

def encodeObservation {events : Nat} : Observation (Fin events) → Fin (2 * events + 2)
  | .accepted event => ⟨event.val, by omega⟩
  | .rejected event => ⟨events + event.val, by omega⟩
  | .internal => ⟨2 * events, by omega⟩
  | .forbidden => ⟨2 * events + 1, by omega⟩

def decodeObservation {events : Nat} (i : Fin (2 * events + 2)) : Observation (Fin events) :=
  if first : i.val < events then .accepted ⟨i.val, first⟩
  else if second : i.val < 2 * events then .rejected ⟨i.val - events, by omega⟩
  else if i.val = 2 * events then .internal else .forbidden

theorem decode_encode_observation {events : Nat} (o : Observation (Fin events)) :
    decodeObservation (encodeObservation o) = o := by
  cases o with
  | accepted event => simp [encodeObservation, decodeObservation, event.isLt]
  | rejected event =>
    have lower : ¬ events + event.val < events := by omega
    have upper : events + event.val < 2 * events := by omega
    simp [encodeObservation, decodeObservation, lower, upper]
  | internal =>
    have lower : ¬ 2 * events < events := by omega
    simp [encodeObservation, decodeObservation, lower]
  | forbidden =>
    have lower : ¬ 2 * events + 1 < events := by omega
    have upper : ¬ 2 * events + 1 < 2 * events := by omega
    simp [encodeObservation, decodeObservation, lower, upper]

theorem encode_decode_observation {events : Nat} (i : Fin (2 * events + 2)) :
    encodeObservation (decodeObservation i) = i := by
  unfold decodeObservation
  split
  · rfl
  · split
    · apply Fin.ext
      simp only [encodeObservation]
      omega
    · split
      · apply Fin.ext
        simp only [encodeObservation]
        omega
      · apply Fin.ext
        simp only [encodeObservation]
        omega

/- The generated TypeScript reference authority uses nested conditional returns. -/
inductive TSAuthority (S E : Type)
  | reject
  | ifKey : (S × E) → S → TSAuthority S E → TSAuthority S E

def tsAuthorityEval {S E : Type} [DecidableEq S] [DecidableEq E] :
    TSAuthority S E → S × E → Option S
  | .reject, _ => none
  | .ifKey key next rest, query => if query = key then some next else tsAuthorityEval rest query

def emitTSAuthority {S E : Type} : List ((S × E) × S) → TSAuthority S E
  | [] => .reject
  | (key, next) :: rest => .ifKey key next (emitTSAuthority rest)

theorem ts_authority_lookup_exact {S E : Type} [DecidableEq S] [DecidableEq E]
    (table : List ((S × E) × S)) (query : S × E) :
    tsAuthorityEval (emitTSAuthority table) query = tableLookup table query := by
  induction table with
  | nil => rfl
  | cons entry rest ih => cases entry; simp [emitTSAuthority, tsAuthorityEval, tableLookup, ih]

inductive TSRef
  | authority
  | variable : Nat → TSRef
  | foreign

abbrev TSEnvironment := Nat → Bool

def tsResolve (env : TSEnvironment) : TSRef → Bool
  | .authority => true
  | .variable name => env name
  | .foreign => false

def tsAliases (declarations : List (Nat × TSRef)) : TSEnvironment :=
  declarations.foldl (fun env binding =>
    let canonical := tsResolve env binding.2
    fun name => if name = binding.1 then canonical else env name) (fun _ => false)

inductive TSInstruction (states pcs events : Nat)
  | jump : Fin (pcs + 1) → TSInstruction states pcs events
  | ifOwner : Fin (states + 1) → Fin (pcs + 1) → Fin (pcs + 1) → TSInstruction states pcs events
  | send : TSRef → Fin events → Fin (pcs + 1) → Fin (pcs + 1) → TSInstruction states pcs events
  | writeProtected : Fin (states + 1) → Fin (pcs + 1) → TSInstruction states pcs events
  | replaceOwner : Fin (states + 1) → Fin (pcs + 1) → TSInstruction states pcs events
  | unknown : Nat → TSInstruction states pcs events

structure TSProgram (states pcs events : Nat) where
  initialOwner : Fin (states + 1)
  entry : Fin (pcs + 1)
  aliases : List (Nat × TSRef)
  authority : TSAuthority (Fin (states + 1)) (Fin events)
  code : Fin (pcs + 1) → TSInstruction states pcs events

def tsRun {states pcs events : Nat} (program : TSProgram states pcs events)
    (state : Configuration states pcs) : Observation (Fin events) × Configuration states pcs :=
  match program.code state.pc with
  | .jump next => (.internal, { state with pc := next })
  | .ifOwner expected yes no => (.internal, { state with pc := if state.owner = expected then yes else no })
  | .send receiver event yes no =>
      if tsResolve (tsAliases program.aliases) receiver then
        match tsAuthorityEval program.authority (state.owner, event) with
        | some next => (.accepted event, ⟨next, yes⟩)
        | none => (.rejected event, { state with pc := no })
      else (.forbidden, { state with pc := no })
  | .writeProtected next pc => (.forbidden, ⟨next, pc⟩)
  | .replaceOwner next pc => (.forbidden, ⟨next, pc⟩)
  | .unknown _ => (.forbidden, state)

def RunStep {states pcs events : Nat}
    (run : Configuration states pcs → Observation (Fin events) × Configuration states pcs)
    (before after : Configuration states pcs) : Prop := ∃ observation, run before = (observation, after)

def RunConforms {states pcs events : Nat}
    (source : Source (states + 1) (Fin events))
    (initial : Configuration states pcs)
    (run : Configuration states pcs → Observation (Fin events) × Configuration states pcs)
    (invariant : Fin (states + 1) → Bool) : Prop :=
  initial.owner = source.initial ∧
  ∀ before, Reach (fun state => state = initial) (RunStep run) before →
    invariant before.owner = true ∧
    ∀ observation after, run before = (observation, after) →
      SourceObservation source observation before.owner after.owner

def TSConforms {states pcs events : Nat} (source : Source (states + 1) (Fin events))
    (program : TSProgram states pcs events) (invariant : Fin (states + 1) → Bool) : Prop :=
  RunConforms source ⟨program.initialOwner, program.entry⟩ (tsRun program) invariant

def lowerRun {states pcs events : Nat} (initial : Configuration states pcs)
    (run : Configuration states pcs → Observation (Fin events) × Configuration states pcs) :
    RawMachine ((states + 1) * (pcs + 1)) (2 * events + 2) where
  initial index := decide (decodeConfig index = initial)
  step before observation after :=
    decide (run (decodeConfig before) = (decodeObservation observation, decodeConfig after))

def lowerTS {states pcs events : Nat} (program : TSProgram states pcs events) :=
  lowerRun ⟨program.initialOwner, program.entry⟩ (tsRun program)

theorem lower_step_exact {states pcs events : Nat} (initial : Configuration states pcs)
    (run : Configuration states pcs → Observation (Fin events) × Configuration states pcs)
    (before after : Configuration states pcs) (observation : Observation (Fin events)) :
    (lowerRun initial run).step (encodeConfig before) (encodeObservation observation) (encodeConfig after) = true ↔
      run before = (observation, after) := by
  simp [lowerRun, decode_encode_config, decode_encode_observation]

theorem lower_initial_nonempty {states pcs events : Nat} (initial : Configuration states pcs)
    (run : Configuration states pcs → Observation (Fin events) × Configuration states pcs) :
    (lowerRun initial run).initial (encodeConfig initial) = true := by
  simp [lowerRun, decode_encode_config]

theorem reachable_encodes {states pcs events : Nat} (initial : Configuration states pcs)
    (run : Configuration states pcs → Observation (Fin events) × Configuration states pcs)
    {state : Configuration states pcs}
    (reachable : Reach (fun state => state = initial) (RunStep run) state) :
    RawReachable (lowerRun initial run) (encodeConfig state) := by
  induction reachable with
  | start start =>
    cases start
    exact .start (lower_initial_nonempty initial run)
  | advance previous edge ih =>
    obtain ⟨observation, executed⟩ := edge
    exact .advance ih ⟨encodeObservation observation, (lower_step_exact initial run _ _ observation).mpr executed⟩

theorem reachable_decodes {states pcs events : Nat} (initial : Configuration states pcs)
    (run : Configuration states pcs → Observation (Fin events) × Configuration states pcs)
    {index : Fin ((states + 1) * (pcs + 1))}
    (reachable : RawReachable (lowerRun initial run) index) :
    Reach (fun state => state = initial) (RunStep run) (decodeConfig index) := by
  induction reachable with
  | start start =>
    exact .start (by simpa [lowerRun] using start)
  | advance previous edge ih =>
    obtain ⟨observation, executed⟩ := edge
    exact .advance ih ⟨decodeObservation observation, by simpa [lowerRun] using executed⟩

theorem reachable_lowering_iff {states pcs events : Nat} (initial : Configuration states pcs)
    (run : Configuration states pcs → Observation (Fin events) × Configuration states pcs)
    (state : Configuration states pcs) :
    RawReachable (lowerRun initial run) (encodeConfig state) ↔
      Reach (fun state => state = initial) (RunStep run) state := by
  constructor
  · intro reachable
    simpa [decode_encode_config] using reachable_decodes initial run reachable
  · exact reachable_encodes initial run

def actualOwner {states pcs : Nat} (index : Fin ((states + 1) * (pcs + 1))) : Fin (states + 1) :=
  (decodeConfig index).owner

theorem source_conformance_lowering_iff {states pcs events : Nat}
    (source : Source (states + 1) (Fin events)) (initial : Configuration states pcs)
    (run : Configuration states pcs → Observation (Fin events) × Configuration states pcs)
    (invariant : Fin (states + 1) → Bool) :
    SourceConforms source (lowerRun initial run) actualOwner decodeObservation invariant ↔
      RunConforms source initial run invariant := by
  constructor
  · rintro ⟨initials, steps⟩
    refine ⟨?_, ?_⟩
    · simpa [actualOwner, decode_encode_config] using initials (encodeConfig initial) (lower_initial_nonempty initial run)
    · intro before reachable
      have checked := steps (encodeConfig before) (reachable_encodes initial run reachable)
      refine ⟨by simpa [actualOwner, decode_encode_config] using checked.1, ?_⟩
      intro observation after executed
      have edge := checked.2 (encodeObservation observation) (encodeConfig after)
        ((lower_step_exact initial run before after observation).mpr executed)
      simpa [actualOwner, decode_encode_config, decode_encode_observation] using edge
  · rintro ⟨initialValid, steps⟩
    refine ⟨?_, ?_⟩
    · intro index initialIndex
      have same : decodeConfig index = initial := by simpa [lowerRun] using initialIndex
      simpa [actualOwner, same] using initialValid
    · intro index reachable
      have checked := steps (decodeConfig index) (reachable_decodes initial run reachable)
      refine ⟨checked.1, ?_⟩
      intro observation after executed
      exact checked.2 (decodeObservation observation) (decodeConfig after) (by simpa [lowerRun] using executed)

def tsSemanticLint {states pcs events : Nat} (source : Source (states + 1) (Fin events))
    (program : TSProgram states pcs events) (invariant : Fin (states + 1) → Bool) : Bool :=
  pipelineLint source (lowerTS program) actualOwner decodeObservation invariant

theorem ts_generated_semantic_constraints_iff {states pcs events : Nat}
    (source : Source (states + 1) (Fin events)) (program : TSProgram states pcs events)
    (invariant : Fin (states + 1) → Bool) :
    tsSemanticLint source program invariant = true ↔
      SourceAdmitted source ∧ SourceDeterministic source ∧ TSConforms source program invariant := by
  rw [tsSemanticLint, compiler_generated_lint_iff_supported_deterministic_source_compliance]
  exact and_congr_right (fun _ => and_congr_right (fun _ => source_conformance_lowering_iff source _ _ invariant))

def TSInstructionDisciplined {states pcs events : Nat} (env : TSEnvironment) :
    TSInstruction states pcs events → Prop
  | .jump _ => True
  | .ifOwner _ _ _ => True
  | .send receiver _ _ _ => tsResolve env receiver = true
  | .writeProtected _ _ => False
  | .replaceOwner _ _ => False
  | .unknown _ => False

def checkTSInstruction {states pcs events : Nat} (env : TSEnvironment) :
    TSInstruction states pcs events → Bool
  | .jump _ => true
  | .ifOwner _ _ _ => true
  | .send receiver _ _ _ => tsResolve env receiver
  | .writeProtected _ _ => false
  | .replaceOwner _ _ => false
  | .unknown _ => false

def TSAliasesBound (env : TSEnvironment) : List (Nat × TSRef) → Prop
  | [] => True
  | (name, reference) :: rest =>
    tsResolve env reference = true ∧
    TSAliasesBound (fun query => if query = name then tsResolve env reference else env query) rest

def checkTSAliases (env : TSEnvironment) : List (Nat × TSRef) → Bool
  | [] => true
  | (name, reference) :: rest =>
    tsResolve env reference &&
    checkTSAliases (fun query => if query = name then tsResolve env reference else env query) rest

def TSStaticContract {states pcs events : Nat} (program : TSProgram states pcs events) : Prop :=
  (program.aliases.map Prod.fst).Nodup ∧
  TSAliasesBound (fun _ => false) program.aliases ∧
  ∀ pc, TSInstructionDisciplined (tsAliases program.aliases) (program.code pc)

def tsStaticCheck {states pcs events : Nat} (program : TSProgram states pcs events) : Bool :=
  decide (program.aliases.map Prod.fst).Nodup &&
  (checkTSAliases (fun _ => false) program.aliases &&
   everyFin (pcs + 1) (fun pc => checkTSInstruction (tsAliases program.aliases) (program.code pc)))

theorem ts_instruction_check_exact {states pcs events : Nat} (env : TSEnvironment)
    (instruction : TSInstruction states pcs events) :
    checkTSInstruction env instruction = true ↔ TSInstructionDisciplined env instruction := by
  cases instruction <;> simp [checkTSInstruction, TSInstructionDisciplined]

theorem ts_alias_check_exact (env : TSEnvironment) (aliases : List (Nat × TSRef)) :
    checkTSAliases env aliases = true ↔ TSAliasesBound env aliases := by
  induction aliases generalizing env with
  | nil => simp [checkTSAliases, TSAliasesBound]
  | cons entry rest ih =>
    cases entry
    simp [checkTSAliases, TSAliasesBound, ih]

theorem ts_static_check_exact {states pcs events : Nat} (program : TSProgram states pcs events) :
    tsStaticCheck program = true ↔ TSStaticContract program := by
  simp [tsStaticCheck, TSStaticContract, everyFin_exact, ts_instruction_check_exact, ts_alias_check_exact]

def tsCombinedLint {states pcs events : Nat} (source : Source (states + 1) (Fin events))
    (program : TSProgram states pcs events) (invariant : Fin (states + 1) → Bool) : Bool :=
  tsStaticCheck program && tsSemanticLint source program invariant

theorem ts_combined_constraints_iff_explicit_contract {states pcs events : Nat}
    (source : Source (states + 1) (Fin events)) (program : TSProgram states pcs events)
    (invariant : Fin (states + 1) → Bool) :
    tsCombinedLint source program invariant = true ↔
      TSStaticContract program ∧ SourceAdmitted source ∧ SourceDeterministic source ∧
        TSConforms source program invariant := by
  simp only [tsCombinedLint, Bool.and_eq_true, ts_static_check_exact, ts_generated_semantic_constraints_iff]

theorem emitted_ts_acceptance_iff_source {states events : Nat}
    (source : Source (states + 1) (Fin events))
    (automaton : TypedAutomaton (Fin (states + 1)) (Fin events))
    (compiled : compileSource source = .ok automaton)
    (before after : Fin (states + 1)) (event : Fin events) :
    tsAuthorityEval (emitTSAuthority automaton.table) (before, event) = some after ↔
      SourceStep source before event after := by
  rw [ts_authority_lookup_exact, ← compilation_preserves_lookup]
  exact compile_success_accepts_iff_source_step source automaton compiled before event after

theorem emitted_ts_rejection_iff_no_source_step {states events : Nat}
    (source : Source (states + 1) (Fin events))
    (automaton : TypedAutomaton (Fin (states + 1)) (Fin events))
    (compiled : compileSource source = .ok automaton)
    (before : Fin (states + 1)) (event : Fin events) :
    tsAuthorityEval (emitTSAuthority automaton.table) (before, event) = none ↔
      ¬ ∃ after, SourceStep source before event after := by
  rw [ts_authority_lookup_exact, ← compilation_preserves_lookup]
  exact compile_success_rejects_iff_no_source_step source automaton compiled before event

/- The TypeScript example exercises actual alias resolution, progress, and
   rejection after the one permitted transition. -/
def progressSource : Source 2 (Fin 1) :=
  ⟨0, [⟨0, .stateIs 0, .set 1⟩]⟩

def progressTable : List ((Fin 2 × Fin 1) × Fin 2) := [((0, 0), 1)]

def tsProgress : TSProgram 1 2 1 where
  initialOwner := 0
  entry := 0
  aliases := [(1, .authority), (2, .variable 1)]
  authority := emitTSAuthority progressTable
  code pc := if pc = 0 then .ifOwner 0 1 2 else .send (.variable 2) 0 2 2

theorem ts_profile_executes_alias_bound_progress_and_rejection :
    tsRun tsProgress ⟨0, 0⟩ = (.internal, ⟨0, 1⟩) ∧
    tsRun tsProgress ⟨0, 1⟩ = (.accepted 0, ⟨1, 2⟩) ∧
    tsRun tsProgress ⟨1, 2⟩ = (.rejected 0, ⟨1, 2⟩) := by decide

theorem ts_profile_generated_constraints_accept :
    tsCombinedLint progressSource tsProgress (fun _ => true) = true := by decide

def tsWrongAuthority : TSProgram 1 2 1 :=
  { tsProgress with authority := emitTSAuthority [((0, 0), 0)] }

theorem wrong_installed_authority_is_not_prefiltered :
    tsRun tsWrongAuthority ⟨0, 1⟩ = (.accepted 0, ⟨0, 2⟩) ∧
    tsSemanticLint progressSource tsWrongAuthority (fun _ => true) = false := by decide

def noChangesSource : Source 2 (Fin 1) := ⟨0, []⟩
def tsUnreachableWrite : TSProgram 1 1 1 where
  initialOwner := 0
  entry := 0
  aliases := []
  authority := .reject
  code pc := if pc = 0 then .jump 0 else .writeProtected 1 1

def tsUnreachableUnknown : TSProgram 1 1 1 :=
  { tsUnreachableWrite with code := fun pc => if pc = 0 then .jump 0 else .unknown 9 }

theorem semantic_completeness_does_not_include_hidden_static_rules :
    tsSemanticLint noChangesSource tsUnreachableWrite (fun _ => true) = true ∧
    tsStaticCheck tsUnreachableWrite = false ∧
    tsCombinedLint noChangesSource tsUnreachableWrite (fun _ => true) = false := by decide

theorem unknown_coverage_is_fail_closed_even_when_unreachable :
    tsSemanticLint noChangesSource tsUnreachableUnknown (fun _ => true) = true ∧
    tsCombinedLint noChangesSource tsUnreachableUnknown (fun _ => true) = false := by decide

end SGDLanguageProfiles

#print axioms SGDLanguageProfiles.decode_encode_config
#print axioms SGDLanguageProfiles.encode_decode_config
#print axioms SGDLanguageProfiles.decode_encode_observation
#print axioms SGDLanguageProfiles.encode_decode_observation
#print axioms SGDLanguageProfiles.ts_authority_lookup_exact
#print axioms SGDLanguageProfiles.lower_step_exact
#print axioms SGDLanguageProfiles.reachable_lowering_iff
#print axioms SGDLanguageProfiles.source_conformance_lowering_iff
#print axioms SGDLanguageProfiles.ts_generated_semantic_constraints_iff
#print axioms SGDLanguageProfiles.ts_static_check_exact
#print axioms SGDLanguageProfiles.ts_combined_constraints_iff_explicit_contract
#print axioms SGDLanguageProfiles.emitted_ts_acceptance_iff_source
#print axioms SGDLanguageProfiles.emitted_ts_rejection_iff_no_source_step
#print axioms SGDLanguageProfiles.ts_profile_executes_alias_bound_progress_and_rejection
#print axioms SGDLanguageProfiles.ts_profile_generated_constraints_accept
#print axioms SGDLanguageProfiles.wrong_installed_authority_is_not_prefiltered
#print axioms SGDLanguageProfiles.semantic_completeness_does_not_include_hidden_static_rules
#print axioms SGDLanguageProfiles.unknown_coverage_is_fail_closed_even_when_unreachable
