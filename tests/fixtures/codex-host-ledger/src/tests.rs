use super::{
    adapter::{fold_partition, PartitionError, UnboundPartitionReport},
    LedgerFact,
};
fn row(key: i64, value: i64, received: i64) -> LedgerFact {
    LedgerFact {
        symbol: "LEDGER".to_owned(),
        key,
        time: 1,
        value,
        received,
    }
}
fn snapshot(row: &LedgerFact) -> [String; 5] {
    [
        row.symbol.clone(),
        row.key.to_string(),
        row.time.to_string(),
        row.value.to_string(),
        row.received.to_string(),
    ]
}
fn report(base: Vec<LedgerFact>, incoming: Vec<LedgerFact>) -> UnboundPartitionReport<LedgerFact> {
    fold_partition(base, incoming)
        .unwrap()
        .into_report()
        .unwrap()
}
#[test]
fn signed_order_and_first_complete_row_win() {
    let r = report(
        vec![],
        vec![
            row(10, 100, 1),
            row(-2, 20, 2),
            row(10, 100, 99),
            row(i64::MIN, 30, 3),
            row(i64::MAX, 40, 4),
        ],
    );
    assert_eq!(r.counts().inserted(), 4);
    assert_eq!(r.counts().unchanged(), 1);
    assert_eq!(r.group().unwrap().day_index(), 0);
    match r {
        UnboundPartitionReport::Write { rows, .. } => {
            assert_eq!(
                rows.iter().map(|r| r.key).collect::<Vec<_>>(),
                vec![i64::MIN, -2, 10, i64::MAX]
            );
            assert_eq!(
                rows.iter().map(snapshot).collect::<Vec<_>>(),
                vec![
                    snapshot(&row(i64::MIN, 30, 3)),
                    snapshot(&row(-2, 20, 2)),
                    snapshot(&row(10, 100, 1)),
                    snapshot(&row(i64::MAX, 40, 4))
                ]
            );
            println!(
                "SGD_HOST_LEDGER_RUST {{\"scenario\":\"write\",\"rows\":{:?}}}",
                rows.iter().map(snapshot).collect::<Vec<_>>()
            );
        }
        _ => panic!("expected Write"),
    }
}
#[test]
fn new_key_then_other_key_conflict_rolls_back_and_keeps_every_pair() {
    let baseline = vec![row(4, 40, 4), row(-2, 20, 2)];
    let r = report(
        baseline,
        vec![
            row(9, 90, 9),
            row(4, 41, 10),
            row(4, 41, 11),
            row(-2, 21, 12),
            row(4, 40, 13),
        ],
    );
    assert_eq!(r.counts().inserted(), 0);
    assert_eq!(r.counts().unchanged(), 1);
    match r {
        UnboundPartitionReport::Refused {
            original,
            conflicts,
            ..
        } => {
            assert_eq!(
                original.iter().map(|r| r.key).collect::<Vec<_>>(),
                vec![4, -2]
            );
            assert_eq!(
                original.iter().map(|r| r.received).collect::<Vec<_>>(),
                vec![4, 2]
            );
            assert_eq!(conflicts.len(), 3);
            assert_eq!(
                conflicts
                    .iter()
                    .map(|c| c.stored().received)
                    .collect::<Vec<_>>(),
                vec![4, 4, 2]
            );
            assert_eq!(
                conflicts
                    .iter()
                    .map(|c| c.rejected().received)
                    .collect::<Vec<_>>(),
                vec![10, 11, 12]
            );
            assert_eq!(
                conflicts
                    .iter()
                    .map(|c| c.rejected().value)
                    .collect::<Vec<_>>(),
                vec![41, 41, 21]
            );
            assert_eq!(
                original.iter().map(snapshot).collect::<Vec<_>>(),
                vec![snapshot(&row(4, 40, 4)), snapshot(&row(-2, 20, 2))]
            );
            let pairs = conflicts
                .iter()
                .map(|c| [snapshot(c.stored()), snapshot(c.rejected())])
                .collect::<Vec<_>>();
            assert_eq!(
                pairs,
                vec![
                    [snapshot(&row(4, 40, 4)), snapshot(&row(4, 41, 10))],
                    [snapshot(&row(4, 40, 4)), snapshot(&row(4, 41, 11))],
                    [snapshot(&row(-2, 20, 2)), snapshot(&row(-2, 21, 12))]
                ]
            );
            println!("SGD_HOST_LEDGER_RUST {{\"scenario\":\"rollback\",\"original\":{:?},\"conflicts\":{:?}}}",original.iter().map(snapshot).collect::<Vec<_>>(),pairs);
        }
        _ => panic!("expected Refused"),
    }
}
#[test]
fn noop_and_empty_preserve_original_baseline_duplicates() {
    let r = report(vec![row(4, 40, 1), row(4, 42, 2)], vec![row(4, 42, 99)]);
    assert_eq!(r.counts().unchanged(), 1);
    match r {
        UnboundPartitionReport::Noop { rows, .. } => {
            assert_eq!(
                rows.iter().map(snapshot).collect::<Vec<_>>(),
                vec![snapshot(&row(4, 40, 1)), snapshot(&row(4, 42, 2))]
            );
            println!(
                "SGD_HOST_LEDGER_RUST {{\"scenario\":\"noop\",\"rows\":{:?}}}",
                rows.iter().map(snapshot).collect::<Vec<_>>()
            );
        }
        _ => panic!("expected Noop"),
    }
    let r = report(vec![], vec![]);
    assert!(r.group().is_none());
    match r {
        UnboundPartitionReport::Noop { rows, .. } => assert!(rows.is_empty()),
        _ => panic!("expected Noop"),
    }
    println!("SGD_HOST_LEDGER_RUST {{\"scenario\":\"empty\",\"rows\":[]}}");
}
#[test]
fn duplicate_baseline_write_materializes_last_and_sorts() {
    let r = report(vec![row(4, 40, 1), row(4, 42, 2)], vec![row(-3, 30, 3)]);
    match r {
        UnboundPartitionReport::Write { rows, .. } => {
            assert_eq!(
                rows.iter().map(snapshot).collect::<Vec<_>>(),
                vec![snapshot(&row(-3, 30, 3)), snapshot(&row(4, 42, 2))]
            );
            println!(
                "SGD_HOST_LEDGER_RUST {{\"scenario\":\"duplicate-write\",\"rows\":{:?}}}",
                rows.iter().map(snapshot).collect::<Vec<_>>()
            );
        }
        _ => panic!("expected Write"),
    }
}
#[test]
fn invalid_group_and_calendar_refuse_before_fold() {
    let mut symbol = row(2, 20, 2);
    symbol.symbol = "OTHER".to_owned();
    assert!(matches!(
        fold_partition(vec![row(1, 10, 1)], vec![symbol]),
        Err(PartitionError::MixedGroup)
    ));
    let mut day = row(2, 20, 2);
    day.time = 86_400_000_000;
    assert!(matches!(
        fold_partition(vec![row(1, 10, 1)], vec![day]),
        Err(PartitionError::MixedGroup)
    ));
    let mut negative = row(2, 20, 2);
    negative.time = -1;
    assert!(matches!(
        fold_partition(vec![], vec![negative]),
        Err(PartitionError::NegativeTime)
    ));
    println!("SGD_HOST_LEDGER_RUST {{\"scenario\":\"boundaries\",\"passed\":true}}");
}
