---------------- MODULE ResourceProtocol ----------------
EXTENDS Integers
CONSTANTS Resources, Events
VARIABLES phase, selected, loaded, prepared, attempted, loadOutcome, decision, coverage, attempts, replacements, effect
vars == <<phase, selected, loaded, prepared, attempted, loadOutcome, decision, coverage, attempts, replacements, effect>>

Init ==
  /\ phase = "New"
  /\ selected = "none"
  /\ loaded = "none"
  /\ prepared = "none"
  /\ attempted = "none"
  /\ loadOutcome = "none"
  /\ decision = "none"
  /\ coverage = FALSE
  /\ attempts = 0
  /\ replacements = 0
  /\ effect = "none"

Select(r, event) ==
  /\ phase = "New"
  /\ event = "select"
  /\ r \in Resources
  /\ phase' = "Selected"
  /\ selected' = r
  /\ UNCHANGED <<loaded, prepared, attempted, loadOutcome, decision, coverage, attempts, replacements, effect>>

ReadPresent(r, event) ==
  /\ phase = "Selected"
  /\ event = "present"
  /\ r \in Resources
  /\ r = selected
  /\ phase' = "Loaded"
  /\ loaded' = r
  /\ loadOutcome' = "Present"
  /\ UNCHANGED <<selected, prepared, attempted, decision, coverage, attempts, replacements, effect>>

ReadAbsent(r, event) ==
  /\ phase = "Selected"
  /\ event = "notfound"
  /\ r \in Resources
  /\ r = selected
  /\ phase' = "Loaded"
  /\ loaded' = r
  /\ loadOutcome' = "NotFound"
  /\ UNCHANGED <<selected, prepared, attempted, decision, coverage, attempts, replacements, effect>>

ReadError(r, event) ==
  /\ phase = "Selected"
  /\ event = "readerror"
  /\ r \in Resources
  /\ r = selected
  /\ phase' = "Failed"
  /\ loadOutcome' = "ReadError"
  /\ UNCHANGED <<selected, loaded, prepared, attempted, decision, coverage, attempts, replacements, effect>>

DecodeError(r, event) ==
  /\ phase = "Selected"
  /\ event = "decodeerror"
  /\ r \in Resources
  /\ r = selected
  /\ phase' = "Failed"
  /\ loadOutcome' = "DecodeError"
  /\ UNCHANGED <<selected, loaded, prepared, attempted, decision, coverage, attempts, replacements, effect>>

PrepareWrite(r, event) ==
  /\ phase = "Loaded"
  /\ event = "preparewrite"
  /\ r \in Resources
  /\ r = loaded
  /\ phase' = "Prepared"
  /\ prepared' = loaded
  /\ decision' = "Write"
  /\ UNCHANGED <<selected, loaded, attempted, loadOutcome, coverage, attempts, replacements, effect>>

PrepareNoop(r, event) ==
  /\ phase = "Loaded"
  /\ event = "preparenoop"
  /\ r \in Resources
  /\ r = loaded
  /\ phase' = "Prepared"
  /\ prepared' = loaded
  /\ decision' = "Noop"
  /\ UNCHANGED <<selected, loaded, attempted, loadOutcome, coverage, attempts, replacements, effect>>

PrepareRefused(r, event) ==
  /\ phase = "Loaded"
  /\ event = "preparerefused"
  /\ r \in Resources
  /\ r = loaded
  /\ phase' = "Prepared"
  /\ prepared' = loaded
  /\ decision' = "Refused"
  /\ UNCHANGED <<selected, loaded, attempted, loadOutcome, coverage, attempts, replacements, effect>>

CoverSuccess(r, event) ==
  /\ phase = "Prepared"
  /\ event = "coversuccess"
  /\ r \in Resources
  /\ r = prepared
  /\ coverage = FALSE
  /\ coverage' = TRUE
  /\ UNCHANGED <<phase, selected, loaded, prepared, attempted, loadOutcome, decision, attempts, replacements, effect>>

CoverFailure(r, event) ==
  /\ phase = "Prepared"
  /\ event = "coverfailure"
  /\ r \in Resources
  /\ r = prepared
  /\ coverage = FALSE
  /\ phase' = "Failed"
  /\ UNCHANGED <<selected, loaded, prepared, attempted, loadOutcome, decision, coverage, attempts, replacements, effect>>

AttemptWrite(r, event) ==
  /\ phase = "Prepared"
  /\ event = "attemptwrite"
  /\ r \in Resources
  /\ r = prepared
  /\ decision = "Write"
  /\ attempts = 0
  /\ phase' = "Attempted"
  /\ attempted' = r
  /\ attempts' = 1
  /\ effect' = "Write"
  /\ UNCHANGED <<selected, loaded, prepared, loadOutcome, decision, coverage, replacements>>

AttemptNoop(r, event) ==
  /\ phase = "Prepared"
  /\ event = "attemptnoop"
  /\ r \in Resources
  /\ r = prepared
  /\ decision = "Noop"
  /\ attempts = 0
  /\ phase' = "Done"
  /\ attempted' = r
  /\ attempts' = 1
  /\ effect' = "None"
  /\ UNCHANGED <<selected, loaded, prepared, loadOutcome, decision, coverage, replacements>>

AttemptRefused(r, event) ==
  /\ phase = "Prepared"
  /\ event = "attemptrefused"
  /\ r \in Resources
  /\ r = prepared
  /\ decision = "Refused"
  /\ attempts = 0
  /\ phase' = "Attempted"
  /\ attempted' = r
  /\ attempts' = 1
  /\ effect' = "Diagnostic"
  /\ UNCHANGED <<selected, loaded, prepared, loadOutcome, decision, coverage, replacements>>

FinishWrite(r, event) ==
  /\ phase = "Attempted"
  /\ event = "finishok"
  /\ r \in Resources
  /\ r = attempted
  /\ effect = "Write"
  /\ phase' = "Done"
  /\ replacements' = 1
  /\ UNCHANGED <<selected, loaded, prepared, attempted, loadOutcome, decision, coverage, attempts, effect>>

FinishRefused(r, event) ==
  /\ phase = "Attempted"
  /\ event = "finishok"
  /\ r \in Resources
  /\ r = attempted
  /\ effect = "Diagnostic"
  /\ phase' = "Done"
  /\ UNCHANGED <<selected, loaded, prepared, attempted, loadOutcome, decision, coverage, attempts, replacements, effect>>

EffectFailure(r, event) ==
  /\ phase = "Attempted"
  /\ event = "finisherror"
  /\ r \in Resources
  /\ r = attempted
  /\ phase' = "Failed"
  /\ UNCHANGED <<selected, loaded, prepared, attempted, loadOutcome, decision, coverage, attempts, replacements, effect>>

Idle(r, event) ==
  /\ phase \in {"Done", "Failed"}
  /\ event = "idle"
  /\ r \in Resources
  /\ UNCHANGED <<phase, selected, loaded, prepared, attempted, loadOutcome, decision, coverage, attempts, replacements, effect>>

AttemptWriteCovered(r, event) ==
  /\ coverage = TRUE
  /\ AttemptWrite(r, event)

Next ==
  \E r \in Resources, event \in Events:
    \/ Select(r, event)
    \/ ReadPresent(r, event)
    \/ ReadAbsent(r, event)
    \/ ReadError(r, event)
    \/ DecodeError(r, event)
    \/ PrepareWrite(r, event)
    \/ PrepareNoop(r, event)
    \/ PrepareRefused(r, event)
    \/ CoverSuccess(r, event)
    \/ CoverFailure(r, event)
    \/ AttemptWrite(r, event)
    \/ AttemptNoop(r, event)
    \/ AttemptRefused(r, event)
    \/ FinishWrite(r, event)
    \/ FinishRefused(r, event)
    \/ EffectFailure(r, event)
    \/ Idle(r, event)

ProductionNext ==
  \E r \in Resources, event \in Events:
    \/ Select(r, event)
    \/ ReadPresent(r, event)
    \/ ReadAbsent(r, event)
    \/ ReadError(r, event)
    \/ DecodeError(r, event)
    \/ PrepareWrite(r, event)
    \/ PrepareNoop(r, event)
    \/ PrepareRefused(r, event)
    \/ CoverSuccess(r, event)
    \/ CoverFailure(r, event)
    \/ AttemptWriteCovered(r, event)
    \/ AttemptNoop(r, event)
    \/ AttemptRefused(r, event)
    \/ FinishWrite(r, event)
    \/ FinishRefused(r, event)
    \/ EffectFailure(r, event)
    \/ Idle(r, event)

Spec == Init /\ [][Next]_vars
ProductionSpec == Init /\ [][ProductionNext]_vars

TypeOK ==
  /\ phase \in {"New", "Selected", "Loaded", "Prepared", "Attempted", "Done", "Failed"}
  /\ (selected = "none" \/ selected \in Resources)
  /\ (loaded = "none" \/ loaded \in Resources)
  /\ (prepared = "none" \/ prepared \in Resources)
  /\ (attempted = "none" \/ attempted \in Resources)
  /\ loadOutcome \in {"none", "Present", "NotFound", "ReadError", "DecodeError"}
  /\ decision \in {"none", "Write", "Noop", "Refused"}
  /\ coverage \in BOOLEAN
  /\ attempts \in {0, 1}
  /\ replacements \in {0, 1}
  /\ effect \in {"none", "Write", "None", "Diagnostic"}
Affinity ==
  /\ (loaded # "none" => loaded = selected)
  /\ (prepared # "none" => prepared = loaded)
  /\ (attempted # "none" => attempted = prepared)
ReadOrigin ==
  /\ (loaded # "none" => loadOutcome \in {"Present", "NotFound"})
  /\ (loadOutcome \in {"ReadError", "DecodeError"} => (loaded = "none" /\ phase = "Failed"))
WriteOnly ==
  /\ (replacements = 1 => (decision = "Write" /\ effect = "Write" /\ attempts = 1 /\ phase = "Done"))
  /\ (decision \in {"Noop", "Refused"} => replacements = 0)
  /\ (attempts = 0 => replacements = 0)
TerminalStep ==
  phase \in {"Done", "Failed"} =>
    (phase' = phase /\ selected' = selected /\ loaded' = loaded /\ prepared' = prepared /\ attempted' = attempted
     /\ loadOutcome' = loadOutcome /\ decision' = decision /\ coverage' = coverage
     /\ attempts' = attempts /\ replacements' = replacements /\ effect' = effect)
Terminal == [][TerminalStep]_vars
CoverageStep == (attempts = 0 /\ attempts' = 1 /\ effect' = "Write") => coverage = TRUE
CoverageBeforeFact == [][CoverageStep]_vars
==========================================================
