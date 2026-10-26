------------------------------ MODULE Approval ------------------------------
VARIABLES phase, approved

vars == <<phase, approved>>
Init == /\ phase = "Draft"
        /\ approved = FALSE

Approve == /\ phase = "Draft"
           /\ approved = FALSE
           /\ approved' = TRUE
           /\ UNCHANGED phase

StartPublish == /\ phase = "Draft"
                /\ approved = TRUE
                /\ phase' = "Publishing"
                /\ UNCHANGED approved

PublishSucceeded == /\ phase = "Publishing"
                    /\ phase' = "Published"
                    /\ UNCHANGED approved

PublishFailed == /\ phase = "Publishing"
                 /\ phase' = "Draft"
                 /\ UNCHANGED approved

Wait == /\ phase = "Published"
        /\ UNCHANGED vars

Next == Approve \/ StartPublish \/ PublishSucceeded \/ PublishFailed \/ Wait
Spec == Init /\ [][Next]_vars

TypeOK == /\ phase \in {"Draft", "Publishing", "Published"}
          /\ approved \in BOOLEAN
PublicationRequiresApproval == phase \in {"Publishing", "Published"} => approved
=============================================================================
