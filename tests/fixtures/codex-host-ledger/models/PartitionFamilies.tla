---- MODULE PartitionFamilies ----
PartitionFamilies ==
 [version |-> 1, calendar |-> "utc-micros-nonnegative-day-v1",
  families |->
   [LedgerFact |->
    [key |-> <<"key">>, symbol |-> "symbol",
     time |-> "time", datasets |-> {"ledger"}]]]
====
