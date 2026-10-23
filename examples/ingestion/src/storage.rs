use std::collections::BTreeSet;

pub struct Storage {
    pub ids: BTreeSet<String>,
}

impl Storage {
    pub fn save(&mut self, id: &str) {
        self.ids.insert(id.to_string());
    }
}

impl Default for Storage {
    fn default() -> Self {
        Self {
            ids: BTreeSet::new(),
        }
    }
}
