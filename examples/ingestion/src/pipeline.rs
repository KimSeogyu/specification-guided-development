use crate::storage::Storage;

use policy_declarations::transition;

pub enum State {
    Received,
    Validated,
    Stored,
    Rejected,
}

pub struct Document {
    pub id: String,
    state: State,
}

impl Document {
    pub fn new(id: &str) -> Self {
        Self {
            id: id.to_string(),
            state: State::Received,
        }
    }
    pub fn state(&self) -> &'static str {
        match self.state {
            State::Received => "Received",
            State::Validated => "Validated",
            State::Stored => "Stored",
            State::Rejected => "Rejected",
        }
    }

    pub fn validate(&mut self) -> Result<(), &'static str> {
        if self.state() != "Received" {
            return Err("Validate requires Received");
        }
        transition("Received", "Validate", "Validated");
        self.state = State::Validated;
        Ok(())
    }

    pub fn persist(&mut self, storage: &mut Storage) -> Result<(), &'static str> {
        if self.state() != "Validated" {
            return Err("Persist requires Validated");
        }
        transition("Validated", "Persist", "Stored");
        storage.save(&self.id);
        self.state = State::Stored;
        Ok(())
    }

    pub fn reject(&mut self) -> Result<(), &'static str> {
        if self.state() != "Received" {
            return Err("Reject requires Received");
        }
        transition("Received", "Reject", "Rejected");
        self.state = State::Rejected;
        Ok(())
    }
}

pub fn ingest(id: &str) -> Result<Document, &'static str> {
    let mut document = Document::new(id);
    let mut storage = Storage::default();
    document.validate()?;
    document.persist(&mut storage)?;
    Ok(document)
}
