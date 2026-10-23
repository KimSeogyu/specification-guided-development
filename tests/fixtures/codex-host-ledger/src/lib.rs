pub mod facts;
pub use facts::LedgerFact;
#[path = "../generated/rust/adapter.rs"]
mod adapter;
#[cfg(test)]
mod tests;
