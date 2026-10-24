------------------------- MODULE ArtifactLifecycle -------------------------
EXTENDS TLC

CONSTANT Mode
VARIABLES phase, rust, captured, expected, checked, source, rechecked,
          publishedRust, publishedCapture

vars == <<phase, rust, captured, expected, checked, source, rechecked,
          publishedRust, publishedCapture>>

Init == /\ phase = "Draft"
        /\ rust = "Raw"
        /\ captured = "OriginalEvidence"
        /\ expected = "Absent"
        /\ checked = FALSE
        /\ source = "OriginalInput"
        /\ rechecked = "Absent"
        /\ publishedRust = "Absent"
        /\ publishedCapture = "Absent"

NormalizeOwned == /\ phase = "Draft"
                  /\ phase' = "Canonical"
                  /\ rust' = "CanonicalRust"
                  /\ UNCHANGED <<captured, expected, checked, source, rechecked,
                                 publishedRust, publishedCapture>>

CheckOwned == /\ phase = "Canonical"
              /\ rust = "CanonicalRust"
              /\ phase' = "Checked"
              /\ checked' = TRUE
              /\ UNCHANGED <<rust, captured, expected, source, rechecked,
                             publishedRust, publishedCapture>>

Seal == /\ phase = "Checked"
        /\ phase' = "Sealed"
        /\ expected' = IF expected = "Absent" THEN rust ELSE expected
        /\ UNCHANGED <<rust, captured, checked, source, rechecked,
                       publishedRust, publishedCapture>>

RecheckInputs == /\ phase = "Sealed"
                 /\ source = "OriginalInput"
                 /\ phase' = "Ready"
                 /\ rechecked' = source
                 /\ UNCHANGED <<rust, captured, expected, checked, source,
                                publishedRust, publishedCapture>>

Publish == /\ phase = "Ready"
           /\ source = rechecked
           /\ phase' = "Published"
           /\ publishedRust' = rust
           /\ publishedCapture' = captured
           /\ UNCHANGED <<rust, captured, expected, checked, source, rechecked>>

ChangeInput == /\ phase \notin {"Published", "Refused"}
               /\ source = "OriginalInput"
               /\ source' = "ChangedInput"
               /\ UNCHANGED <<phase, rust, captured, expected, checked, rechecked,
                              publishedRust, publishedCapture>>

Refuse == /\ phase \notin {"Published", "Refused"}
          /\ source = "ChangedInput"
          /\ phase' = "Refused"
          /\ UNCHANGED <<rust, captured, expected, checked, source, rechecked,
                         publishedRust, publishedCapture>>

HashEarly == /\ Mode = "BadOrder"
             /\ phase = "Draft"
             /\ expected = "Absent"
             /\ expected' = rust
             /\ UNCHANGED <<phase, rust, captured, checked, source, rechecked,
                            publishedRust, publishedCapture>>

NormalizeCaptured == /\ Mode = "BadOwnership"
                     /\ phase = "Draft"
                     /\ captured' = "ReformattedEvidence"
                     /\ UNCHANGED <<phase, rust, expected, checked, source,
                                    rechecked, publishedRust, publishedCapture>>

Next == NormalizeOwned \/ CheckOwned \/ Seal \/ RecheckInputs \/ Publish
        \/ ChangeInput \/ Refuse \/ HashEarly \/ NormalizeCaptured

EvidencePreserved == captured = "OriginalEvidence"
CanonicalPublished == phase = "Published" =>
    /\ publishedRust = "CanonicalRust"
    /\ expected = publishedRust
    /\ publishedCapture = "OriginalEvidence"
ReadyRequiresCheck == phase \in {"Ready", "Published"} => checked
RefusalPublishesNothing == phase = "Refused" =>
    /\ publishedRust = "Absent"
    /\ publishedCapture = "Absent"
PublicationUsesRecheckedInput == phase = "Published" => source = rechecked

Spec == Init /\ [][Next]_vars
=============================================================================
