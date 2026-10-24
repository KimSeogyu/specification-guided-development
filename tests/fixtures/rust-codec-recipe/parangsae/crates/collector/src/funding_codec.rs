use crate::sgd_wire::FundingWire;
use crate::vision::FundingFact;
use parangsae_core::symbol::SymbolError;
use parangsae_core::{AvailableTs, EventTs, Ratio, ReceivedTs, Symbol, UtcMicros};

pub(crate) const FUNDING_COLUMNS: [(&str, &str); 9] = [
    ("symbol", "symbol"),
    ("raw_calc_time_us", "raw_calc_time"),
    ("funding_time_us", "funding_time"),
    ("interval_hours", "interval_hours"),
    ("rate_ticks", "rate"),
    ("event_ts_us", "event_ts"),
    ("available_ts_us", "available_ts"),
    ("received_ts_us", "received_ts"),
    ("schema_version", "schema_version"),
];

pub(crate) fn encode_funding_row(row: &FundingFact) -> FundingWire {
    FundingWire {
        symbol: row.symbol.as_str().to_owned(),
        raw_calc_time_us: row.raw_calc_time.micros(),
        funding_time_us: row.funding_time.micros(),
        interval_hours: row.interval_hours,
        rate_ticks: row.rate.ticks(),
        event_ts_us: row.event_ts.micros().micros(),
        available_ts_us: row.available_ts.micros().micros(),
        received_ts_us: row.received_ts.micros().micros(),
        schema_version: row.schema_version,
    }
}

pub(crate) fn decode_funding_row(row: FundingWire) -> Result<FundingFact, SymbolError> {
    Ok(FundingFact {
        symbol: Symbol::new(&row.symbol)?,
        raw_calc_time: UtcMicros::from_micros(row.raw_calc_time_us),
        funding_time: UtcMicros::from_micros(row.funding_time_us),
        interval_hours: row.interval_hours,
        rate: Ratio::from_ticks(row.rate_ticks),
        event_ts: EventTs::from_micros(UtcMicros::from_micros(row.event_ts_us)),
        available_ts: AvailableTs::from_micros(UtcMicros::from_micros(row.available_ts_us)),
        received_ts: ReceivedTs::from_micros(UtcMicros::from_micros(row.received_ts_us)),
        schema_version: row.schema_version,
    })
}
