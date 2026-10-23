----------------------------- MODULE Order -----------------------------
EXTENDS TLC
VARIABLE state

States == {"New", "Pending", "Acked", "Filled", "Canceled"}
Init == state = "New"
Submit == /\ state = "New" /\ state' = "Pending"
Ack == /\ state = "Pending" /\ state' = "Acked"
Fill == /\ state = "Acked" /\ state' = "Filled"
Cancel == /\ state \in {"New", "Pending", "Acked"} /\ state' = "Canceled"
Done == /\ state \in {"Filled", "Canceled"} /\ UNCHANGED state
Next == Submit \/ Ack \/ Fill \/ Cancel \/ Done
Spec == Init /\ [][Next]_state
TypeOK == state \in States
=============================================================================
