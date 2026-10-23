use crate::pipeline::ingest;

pub fn handle(id: &str) -> Result<&'static str, &'static str> {
    Ok(ingest(id)?.state())
}
