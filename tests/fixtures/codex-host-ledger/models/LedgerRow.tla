------------------------------ MODULE LedgerRow ------------------------------
CONSTANTS Values, Receipts
VARIABLES phase, stored, rejected, storedProvenance, rejectedProvenance
vars == <<phase, stored, rejected, storedProvenance, rejectedProvenance>>
Init ==
  /\ phase = "absent"
  /\ stored = "none"
  /\ rejected = "none"
  /\ storedProvenance = "none"
  /\ rejectedProvenance = "none"
Insert(v, provenance) ==
  /\ phase = "absent"
  /\ v \in Values
  /\ provenance \in Receipts
  /\ phase' = "present"
  /\ stored' = v
  /\ storedProvenance' = provenance
  /\ rejected' = "none"
  /\ rejectedProvenance' = "none"
Same(v, provenance) ==
  /\ phase \in {"present", "conflict"}
  /\ v = stored
  /\ provenance \in Receipts
  /\ UNCHANGED vars
Clash(v, provenance) ==
  /\ phase \in {"present", "conflict"}
  /\ v \in Values
  /\ v # stored
  /\ provenance \in Receipts
  /\ phase' = "conflict"
  /\ rejected' = v
  /\ rejectedProvenance' = provenance
  /\ UNCHANGED <<stored, storedProvenance>>
Next ==
  \E v \in Values, provenance \in Receipts:
    \/ Insert(v, provenance)
    \/ Same(v, provenance)
    \/ Clash(v, provenance)
Spec == Init /\ [][Next]_vars
TypeOK ==
  /\ phase \in {"absent", "present", "conflict"}
  /\ (phase = "absent") <=> (stored = "none")
  /\ phase = "conflict" => (rejected \in Values /\ rejected # stored /\ rejectedProvenance \in Receipts)
  /\ phase = "present" => (rejected = "none" /\ rejectedProvenance = "none")
  /\ phase = "absent" => (rejected = "none" /\ rejectedProvenance = "none" /\ storedProvenance = "none")
  /\ stored = "none" \/ (stored \in Values /\ storedProvenance \in Receipts)
StoredStable == [][stored # "none" => stored' = stored]_vars
ProvenanceStable == [][stored # "none" => storedProvenance' = storedProvenance]_vars
=============================================================================
