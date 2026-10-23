-------------------------- MODULE Architecture --------------------------
VARIABLE layer

Layers == {"Handler", "Service", "Gateway"}
Init == layer \in Layers
HandlerToService == /\ layer = "Handler" /\ layer' = "Service"
ServiceToGateway == /\ layer = "Service" /\ layer' = "Gateway"
Idle == UNCHANGED layer
Next == HandlerToService \/ ServiceToGateway \/ Idle
Spec == Init /\ [][Next]_layer
TypeOK == layer \in Layers
=============================================================================
