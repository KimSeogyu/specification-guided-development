// Compiler-owned wire bootstrap for the codec fixture. This plain value grants no IO permission.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct FundingWire {
    pub symbol: String,
    pub raw_calc_time_us: i64,
    pub funding_time_us: i64,
    pub interval_hours: i64,
    pub rate_ticks: i64,
    pub event_ts_us: i64,
    pub available_ts_us: i64,
    pub received_ts_us: i64,
    pub schema_version: u32,
}
