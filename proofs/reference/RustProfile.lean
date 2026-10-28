import LanguageProfiles

/- Closed finite Rust-oriented reference language. A scoped mutable loan invokes
   a generated match expression and immediately matches its Result. Loans cannot
   escape or overlap: this is syntax of this subset, not a proof of rustc's
   borrow checker. Places retain their root binding identity through reborrows.
   Raw assignment, replacement and unknown syntax remain in raw execution and
   are rejected by the structural checker, including unreachable instructions.

   This defines no Rust parser, product backend, heap, unsafe code, unwinding,
   threads, FFI, or native-language correspondence. Configuration encoding and
   exhaustive finite checking are shared with the language-neutral run lemmas.
-/
namespace SGDRustProfile
open SGDMethod SGDCompilerPipeline SGDSemanticConstraints SGDCompilerLintBridge
open SGDLanguageProfiles

inductive MatchBody (S E : Type)
  | err
  | arm : S × E → S → MatchBody S E → MatchBody S E

def evalMatch {S E : Type} [DecidableEq S] [DecidableEq E] :
    MatchBody S E → S × E → Except Unit S
  | .err, _ => .error ()
  | .arm pattern next rest, query =>
      if query = pattern then .ok next else evalMatch rest query

def emitMatch {S E : Type} : List ((S × E) × S) → MatchBody S E
  | [] => .err
  | (pattern, next) :: rest => .arm pattern next (emitMatch rest)

def resultOption {S : Type} : Except Unit S → Option S
  | .ok next => some next
  | .error _ => none

theorem match_generation_preserves_lookup {S E : Type} [DecidableEq S] [DecidableEq E]
    (table : List ((S × E) × S)) (query : S × E) :
    resultOption (evalMatch (emitMatch table) query) = tableLookup table query := by
  induction table with
  | nil => rfl
  | cons entry rest ih =>
      rcases entry with ⟨pattern, next⟩
      simp only [emitMatch, evalMatch, tableLookup]
      split <;> simp_all [resultOption]

theorem generated_match_accepts_exact_source {states events : Nat}
    (source : Source (states + 1) (Fin events))
    (automaton : TypedAutomaton (Fin (states + 1)) (Fin events))
    (compiled : compileSource source = .ok automaton)
    (before after : Fin (states + 1)) (event : Fin events) :
    resultOption (evalMatch (emitMatch automaton.table) (before, event)) = some after ↔
      SourceStep source before event after := by
  rw [match_generation_preserves_lookup, ← compilation_preserves_lookup]
  exact compile_success_accepts_iff_source_step source automaton compiled before event after

theorem generated_match_rejects_exact_source {states events : Nat}
    (source : Source (states + 1) (Fin events))
    (automaton : TypedAutomaton (Fin (states + 1)) (Fin events))
    (compiled : compileSource source = .ok automaton)
    (before : Fin (states + 1)) (event : Fin events) :
    resultOption (evalMatch (emitMatch automaton.table) (before, event)) = none ↔
      ¬ ∃ after, SourceStep source before event after := by
  rw [match_generation_preserves_lookup, ← compilation_preserves_lookup]
  exact compile_success_rejects_iff_no_source_step source automaton compiled before event

inductive Place
  | root : Nat → Place
  | reborrow : Place → Place
  deriving DecidableEq

def rootBinding : Place → Nat
  | .root binding => binding
  | .reborrow parent => rootBinding parent

inductive Instruction (states pcs events : Nat)
  | goto : Fin (pcs + 1) → Instruction states pcs events
  | matchOwner : Fin (states + 1) → Fin (pcs + 1) → Fin (pcs + 1) → Instruction states pcs events
  | withOwnerMut : Place → Fin events → Fin (pcs + 1) → Fin (pcs + 1) → Instruction states pcs events
  | assign : Fin (states + 1) → Fin (pcs + 1) → Instruction states pcs events
  | replace : Fin (states + 1) → Fin (pcs + 1) → Instruction states pcs events
  | unknown : Nat → Instruction states pcs events

structure Program (states pcs events : Nat) where
  initialOwner : Fin (states + 1)
  entry : Fin (pcs + 1)
  ownerBinding : Nat
  authority : MatchBody (Fin (states + 1)) (Fin events)
  code : Fin (pcs + 1) → Instruction states pcs events

def run {states pcs events : Nat} (program : Program states pcs events)
    (state : Configuration states pcs) : Observation (Fin events) × Configuration states pcs :=
  match program.code state.pc with
  | .goto next => (.internal, { state with pc := next })
  | .matchOwner expected yes no => (.internal, { state with pc := if state.owner = expected then yes else no })
  | .withOwnerMut place event yes no =>
      if rootBinding place = program.ownerBinding then
        match evalMatch program.authority (state.owner, event) with
        | .ok next => (.accepted event, ⟨next, yes⟩)
        | .error _ => (.rejected event, { state with pc := no })
      else (.forbidden, { state with pc := no })
  | .assign next pc => (.forbidden, ⟨next, pc⟩)
  | .replace next pc => (.forbidden, ⟨next, pc⟩)
  | .unknown _ => (.forbidden, state)

def InstructionAdmitted {states pcs events : Nat} (owner : Nat) : Instruction states pcs events → Prop
  | .goto _ | .matchOwner _ _ _ => True
  | .withOwnerMut place _ _ _ => rootBinding place = owner
  | .assign _ _ | .replace _ _ | .unknown _ => False

def checkInstruction {states pcs events : Nat} (owner : Nat) : Instruction states pcs events → Bool
  | .goto _ | .matchOwner _ _ _ => true
  | .withOwnerMut place _ _ _ => decide (rootBinding place = owner)
  | .assign _ _ | .replace _ _ | .unknown _ => false

def StructuralContract {states pcs events : Nat} (program : Program states pcs events) : Prop :=
  ∀ pc, InstructionAdmitted program.ownerBinding (program.code pc)

def checkStructure {states pcs events : Nat} (program : Program states pcs events) : Bool :=
  everyFin (pcs + 1) (fun pc => checkInstruction program.ownerBinding (program.code pc))

theorem structural_check_exact {states pcs events : Nat} (program : Program states pcs events) :
    checkStructure program = true ↔ StructuralContract program := by
  have localCheck (instruction : Instruction states pcs events) :
      checkInstruction program.ownerBinding instruction = true ↔
        InstructionAdmitted program.ownerBinding instruction := by
    cases instruction <;> simp [checkInstruction, InstructionAdmitted]
  simp [checkStructure, StructuralContract, everyFin_exact, localCheck]

def lint {states pcs events : Nat} (source : Source (states + 1) (Fin events))
    (program : Program states pcs events) (invariant : Fin (states + 1) → Bool) : Bool :=
  checkStructure program && pipelineLint source
    (lowerRun ⟨program.initialOwner, program.entry⟩ (run program)) actualOwner decodeObservation invariant

theorem generated_constraints_iff_source_contract {states pcs events : Nat}
    (source : Source (states + 1) (Fin events)) (program : Program states pcs events)
    (invariant : Fin (states + 1) → Bool) :
    lint source program invariant = true ↔
      StructuralContract program ∧ SourceAdmitted source ∧ SourceDeterministic source ∧
        RunConforms source ⟨program.initialOwner, program.entry⟩ (run program) invariant := by
  simp only [lint, Bool.and_eq_true, structural_check_exact,
    compiler_generated_lint_iff_supported_deterministic_source_compliance,
    source_conformance_lowering_iff]

theorem typescript_and_rust_generated_authorities_agree {S E : Type}
    [DecidableEq S] [DecidableEq E] (table : List ((S × E) × S)) (query : S × E) :
    resultOption (evalMatch (emitMatch table) query) =
      tsAuthorityEval (emitTSAuthority table) query := by
  rw [match_generation_preserves_lookup, ts_authority_lookup_exact]

theorem lint_acceptance_preserves_specification {states pcs events : Nat}
    (source : Source (states + 1) (Fin events)) (program : Program states pcs events)
    (invariant : Fin (states + 1) → Bool)
    (accepted : lint source program invariant = true)
    (state : Configuration states pcs)
    (reachable : Reach (fun state => state = ⟨program.initialOwner, program.entry⟩)
      (RunStep (run program)) state) : invariant state.owner = true := by
  have conforms := (generated_constraints_iff_source_contract source program invariant).mp accepted
  exact (conforms.2.2.2.2 state reachable).1

/- Non-vacuity: a reborrow progresses, then Result::Err preserves the owner. -/
def witness : Program 1 0 1 where
  initialOwner := 0
  entry := 0
  ownerBinding := 7
  authority := emitMatch [((0, 0), 1)]
  code := fun _ => .withOwnerMut (.reborrow (.root 7)) 0 0 0

theorem accepted_program_progresses_and_refuses :
    lint progressSource witness (fun _ => true) = true ∧
    run witness ⟨0, 0⟩ = (.accepted 0, ⟨1, 0⟩) ∧
    run witness ⟨1, 0⟩ = (.rejected 0, ⟨1, 0⟩) := by decide

def wrongBinding : Program 1 0 1 :=
  { witness with code := fun _ => .withOwnerMut (.reborrow (.root 8)) 0 0 0 }

theorem foreign_root_remains_foreign_through_reborrow :
    checkStructure wrongBinding = false ∧
    run wrongBinding ⟨0, 0⟩ = (.forbidden, ⟨0, 0⟩) := by decide

theorem unsupported_instruction_is_rejected (tag owner : Nat) :
    checkInstruction (states := 0) (pcs := 0) (events := 0) owner (.unknown tag) = false := rfl

end SGDRustProfile

#print axioms SGDRustProfile.generated_match_accepts_exact_source
#print axioms SGDRustProfile.generated_match_rejects_exact_source
#print axioms SGDRustProfile.generated_constraints_iff_source_contract
#print axioms SGDRustProfile.accepted_program_progresses_and_refuses
#print axioms SGDRustProfile.foreign_root_remains_foreign_through_reborrow

#print axioms SGDRustProfile.typescript_and_rust_generated_authorities_agree
#print axioms SGDRustProfile.lint_acceptance_preserves_specification

#print axioms SGDRustProfile.match_generation_preserves_lookup
#print axioms SGDRustProfile.structural_check_exact
#print axioms SGDRustProfile.unsupported_instruction_is_rejected
