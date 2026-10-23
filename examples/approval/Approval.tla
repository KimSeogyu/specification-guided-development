---------------------------- MODULE Approval ----------------------------
VARIABLES phase, approved
vars == <<phase, approved>>

Init == /\ phase = "New"
        /\ approved = FALSE

Approve == /\ phase = "New"
           /\ ~approved
           /\ approved' = TRUE
           /\ UNCHANGED phase

Submit == /\ phase = "New"
          /\ approved
          /\ phase' = "Submitted"
          /\ UNCHANGED approved

Wait == /\ phase = "Submitted"
        /\ UNCHANGED vars

Next == Approve \/ Submit \/ Wait
Spec == Init /\ [][Next]_vars

TypeOK == /\ phase \in {"New", "Submitted"}
          /\ approved \in BOOLEAN
ApprovedBeforeSubmission == phase = "Submitted" => approved
=============================================================================
