---- MODULE Architecture ----
VARIABLES module, previous
vars == <<module, previous>>

Init == /\ module = "Composition"
        /\ previous = "Composition"

DeclareHandler == /\ module = "Composition"
                  /\ module' = "Handler"
                  /\ previous' = module

DeclarePipeline == /\ module = "Composition"
                   /\ module' = "Pipeline"
                   /\ previous' = module

DeclareStorage == /\ module = "Composition"
                  /\ module' = "Storage"
                  /\ previous' = module

DependsOnPipeline == /\ module = "Handler"
                     /\ module' = "Pipeline"
                     /\ previous' = module

DependsOnStorage == /\ module = "Pipeline"
                    /\ module' = "Storage"
                    /\ previous' = module

Wait == /\ module = "Storage"
        /\ UNCHANGED vars

Next == DeclareHandler \/ DeclarePipeline \/ DeclareStorage \/ DependsOnPipeline \/ DependsOnStorage \/ Wait
Spec == Init /\ [][Next]_vars

TypeOK == /\ module \in {"Composition", "Handler", "Pipeline", "Storage"}
          /\ previous \in {"Composition", "Handler", "Pipeline", "Storage"}
NoHandlerStorageDependency == ~(previous = "Handler" /\ module = "Storage")
====
