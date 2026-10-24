use crate::funding_codec::{decode_funding_row, encode_funding_row, FUNDING_COLUMNS};
use crate::sgd_wire::FundingWire;
use crate::vision::FundingFact;
use parangsae_core::symbol::SymbolError;
use parangsae_core::{AvailableTs, EventTs, Ratio, ReceivedTs, Symbol, UtcMicros};

fn distinct_wire() -> FundingWire {
    FundingWire {
        symbol: "BTCUSDT9".to_owned(),
        raw_calc_time_us: -101,
        funding_time_us: 202,
        interval_hours: -7,
        rate_ticks: -123_456_789,
        event_ts_us: i64::MIN,
        available_ts_us: i64::MAX,
        received_ts_us: 9_007_199_254_740_993,
        schema_version: u32::MAX,
    }
}

#[test]
fn every_physical_column_keeps_its_exact_native_projection() {
    let row = FundingFact {
        symbol: Symbol::new("BTCUSDT9").unwrap(),
        raw_calc_time: UtcMicros::from_micros(-101),
        funding_time: UtcMicros::from_micros(202),
        interval_hours: -7,
        rate: Ratio::from_ticks(-123_456_789),
        event_ts: EventTs::from_micros(UtcMicros::from_micros(i64::MIN)),
        available_ts: AvailableTs::from_micros(UtcMicros::from_micros(i64::MAX)),
        received_ts: ReceivedTs::from_micros(UtcMicros::from_micros(9_007_199_254_740_993)),
        schema_version: u32::MAX,
    };
    assert_eq!(encode_funding_row(&row), distinct_wire());
    assert_eq!(
        FUNDING_COLUMNS,
        [
            ("symbol", "symbol"),
            ("raw_calc_time_us", "raw_calc_time"),
            ("funding_time_us", "funding_time"),
            ("interval_hours", "interval_hours"),
            ("rate_ticks", "rate"),
            ("event_ts_us", "event_ts"),
            ("available_ts_us", "available_ts"),
            ("received_ts_us", "received_ts"),
            ("schema_version", "schema_version"),
        ]
    );
}

#[test]
fn every_native_field_uses_its_matching_physical_column() {
    let row = decode_funding_row(distinct_wire()).unwrap();
    assert_eq!(row.symbol.as_str(), "BTCUSDT9");
    assert_eq!(row.raw_calc_time.micros(), -101);
    assert_eq!(row.funding_time.micros(), 202);
    assert_eq!(row.interval_hours, -7);
    assert_eq!(row.rate.ticks(), -123_456_789);
    assert_eq!(row.event_ts.micros().micros(), i64::MIN);
    assert_eq!(row.available_ts.micros().micros(), i64::MAX);
    assert_eq!(row.received_ts.micros().micros(), 9_007_199_254_740_993);
    assert_eq!(row.schema_version, u32::MAX);
}

#[test]
fn storage_keeps_native_integer_ranges_without_csv_admission_rules() {
    for value in [
        i64::MIN,
        -9_007_199_254_740_993,
        -1,
        0,
        1,
        9_007_199_254_740_993,
        i64::MAX,
    ] {
        for schema_version in [0, 1, 3, u32::MAX] {
            let wire = FundingWire {
                symbol: "ETHUSDT".to_owned(),
                raw_calc_time_us: value,
                funding_time_us: value,
                interval_hours: value,
                rate_ticks: value,
                event_ts_us: value,
                available_ts_us: value,
                received_ts_us: value,
                schema_version,
            };
            let expected = wire.clone();
            let row = decode_funding_row(wire).unwrap();
            assert_eq!(encode_funding_row(&row), expected);
        }
    }
}

#[test]
fn payload_equality_does_not_replace_original_receipt_preservation() {
    let first_wire = distinct_wire();
    let mut second_wire = first_wire.clone();
    second_wire.received_ts_us = -9_007_199_254_740_993;
    let first = decode_funding_row(first_wire.clone()).unwrap();
    let second = decode_funding_row(second_wire.clone()).unwrap();
    assert_eq!(first, second);
    assert_ne!(first.received_ts, second.received_ts);
    assert_eq!(encode_funding_row(&first), first_wire);
    assert_eq!(encode_funding_row(&second), second_wire);
}

#[test]
fn symbol_decode_preserves_the_native_constructor_boundary() {
    for text in ["A", "0", "BTCUSDT9", "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"] {
        let mut wire = distinct_wire();
        wire.symbol = text.to_owned();
        let row = decode_funding_row(wire).unwrap();
        assert_eq!(row.symbol.as_str(), text);
    }
    for (text, expected) in [
        ("", SymbolError::Length),
        ("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456", SymbolError::Length),
        ("btcusdt", SymbolError::Charset),
        ("BTC_USDT", SymbolError::Charset),
        ("BTC USDT", SymbolError::Charset),
        ("BTC/USDT", SymbolError::Charset),
        ("ÉTH", SymbolError::Charset),
        ("ＢＴＣ", SymbolError::Charset),
        ("BTC\0USDT", SymbolError::Charset),
    ] {
        let mut wire = distinct_wire();
        wire.symbol = text.to_owned();
        assert_eq!(decode_funding_row(wire).unwrap_err(), expected);
    }
}
