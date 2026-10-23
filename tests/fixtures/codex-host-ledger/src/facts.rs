#[derive(Clone, Debug)]
pub struct LedgerFact {
    pub symbol: String,
    pub key: i64,
    pub time: i64,
    pub value: i64,
    pub received: i64,
}
impl PartialEq for LedgerFact {
    fn eq(&self, other: &Self) -> bool {
        self.symbol == other.symbol
            && self.key == other.key
            && self.time == other.time
            && self.value == other.value
    }
}
impl Eq for LedgerFact {}
