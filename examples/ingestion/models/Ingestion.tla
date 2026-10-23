---- MODULE Ingestion ----
VARIABLES state, validated
vars == <<state, validated>>

Init == /\ state = "Received"
        /\ validated = FALSE

Validate == /\ state = "Received"
            /\ state' = "Validated"
            /\ validated' = TRUE

Persist == /\ state = "Validated"
           /\ validated
           /\ state' = "Stored"
           /\ UNCHANGED validated

Reject == /\ state = "Received"
          /\ state' = "Rejected"
          /\ UNCHANGED validated

Wait == /\ state \in {"Stored", "Rejected"}
        /\ UNCHANGED vars

Next == Validate \/ Persist \/ Reject \/ Wait
Spec == Init /\ [][Next]_vars

TypeOK == /\ state \in {"Received", "Validated", "Stored", "Rejected"}
          /\ validated \in BOOLEAN
StoredRequiresValidation == state = "Stored" => validated
====
