use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    pub version: u8,
    pub profile: String,
    pub source: SourceBinding,
    pub model: ModelBinding,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceBinding {
    pub manifest: String,
    pub module: String,
    pub facts: Vec<FactBinding>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FactBinding {
    pub name: String,
    pub rust_path: String,
    pub metadata: Vec<String>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelBinding {
    pub payload_input: String,
    pub provenance_input: String,
    pub pairs: Vec<PairBinding>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PairBinding {
    pub name: String,
    pub payload: String,
    pub provenance: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub version: u8,
    pub profile: &'static str,
    pub crate_name: String,
    pub sources: Vec<SourceIdentity>,
    pub facts: Vec<FactPlan>,
}
#[derive(Clone, Debug, Serialize)]
pub struct SourceIdentity {
    pub path: String,
    pub sha256: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FactPlan {
    pub name: String,
    pub rust_path: String,
    pub fields: Vec<FieldPlan>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldPlan {
    pub name: String,
    pub rust_type: String,
    pub codec: Codec,
    pub payload: bool,
    pub provenance: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub classes: Option<Vec<Vec<u32>>>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Codec {
    I64 {
        getters: Vec<String>,
    },
    U32 {
        getters: Vec<String>,
    },
    Bool {
        getters: Vec<String>,
    },
    String {
        getters: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    Enum {
        getters: Vec<String>,
        rust_path: String,
        variants: Vec<String>,
    },
}
impl Codec {
    pub fn prepend(&mut self, getter: String) {
        let getters = match self {
            Self::I64 { getters }
            | Self::U32 { getters }
            | Self::Bool { getters }
            | Self::String { getters }
            | Self::Enum { getters, .. } => getters,
        };
        getters.insert(0, getter);
    }
}
