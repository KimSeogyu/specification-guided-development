#![forbid(unsafe_code)]
mod codec;
mod equality;
mod error;
mod macros;
mod model;
mod source;

pub use error::{Error, Result};
pub use model::{Binding, Codec, FactPlan, FieldPlan, Plan, SourceIdentity};
use quote::ToTokens;
use std::collections::BTreeSet;
use std::fs;
use std::path::Path;
use syn::spanned::Spanned;
use syn::{Fields, Item};

pub fn analyze(root: &Path, binding_path: &Path) -> Result<Plan> {
    analyze_with_generated(root, binding_path, None)
}
pub fn analyze_with_generated(
    root: &Path,
    binding_path: &Path,
    generated: Option<&Path>,
) -> Result<Plan> {
    let info = fs::symlink_metadata(binding_path)
        .map_err(|e| Error::new(format!("cannot read binding JSON: {e}")))?;
    if !info.is_file() || info.len() > 1024 * 1024 {
        return Err(Error::new(
            "binding JSON must be a regular non-symlink file no larger than 1 MiB",
        ));
    }
    let binding: Binding =
        serde_json::from_slice(&fs::read(binding_path).map_err(|e| Error::new(e.to_string()))?)
            .map_err(|e| Error::new(format!("invalid whole-row binding JSON: {e}")))?;
    validate_binding(&binding)?;
    let mut db = source::Database::new(root)?;
    if let Some(generated) = generated {
        db.set_generated_root(generated)?;
    }
    let workspace = db.root.join("Cargo.toml");
    let workspace_text = db.read(&workspace)?;
    let workspace_doc = workspace_text
        .parse::<toml_edit::DocumentMut>()
        .map_err(|e| Error::new(format!("invalid workspace Cargo manifest: {e}")))?;
    if workspace_doc.get("patch").is_some() || workspace_doc.get("replace").is_some() {
        return Err(Error::new(
            "Cargo patch/replace overrides are outside the trusted registry source profile",
        ));
    }
    let manifest = db.resolve_relative(&db.root, &binding.source.manifest)?;
    let crate_id = db.load_crate(&manifest)?;
    macros::audit(&db)?;
    let module_parts = source::rust_path(&binding.source.module)?;
    let module = format!(
        "{}{}",
        crate_id,
        module_parts[1..]
            .iter()
            .map(|part| format!("::{part}"))
            .collect::<String>()
    );
    if !db.modules.contains_key(&module) {
        return Err(Error::new(format!("bound source module {} is absent or excluded; conditional/test-only/generated types cannot supply Fact bindings", binding.source.module)));
    }
    let mut facts = Vec::new();
    for fact in &binding.source.facts {
        let definition = db.resolve(&module, std::slice::from_ref(&fact.name))?;
        if definition.module != module {
            return Err(Error::new(format!(
                "{} must be defined directly in the bound source module",
                fact.name
            )));
        }
        let public = db.resolve(&crate_id, &source::rust_path(&fact.rust_path)?)?;
        if public.module != definition.module
            || source::item_name(&public.item) != Some(fact.name.clone())
            || db.public_path(&definition, &crate_id)? != fact.rust_path
        {
            return Err(Error::new(format!(
                "{}: rustPath must name its resolved accessible crate:: re-export",
                fact.name
            )));
        }
        codec::check_fact_ownership(&db, &definition)?;
        let equality = equality::fields(&db, &definition)?;
        let Item::Struct(item) = &definition.item else {
            return Err(Error::new("bound Fact is not a struct"));
        };
        let Fields::Named(fields) = &item.fields else {
            return Err(Error::new("bound Fact requires named fields"));
        };
        let declared: BTreeSet<_> = fields
            .named
            .iter()
            .filter_map(|field| field.ident.as_ref().map(ToString::to_string))
            .collect();
        if equality.keys().any(|name| !declared.contains(name)) {
            return Err(Error::new(format!(
                "{}: equality references an undeclared field",
                fact.name
            )));
        }
        for metadata in &fact.metadata {
            if !declared.contains(metadata) || equality.contains_key(metadata) {
                return Err(Error::new(format!(
                    "{}.{metadata}: metadata must name an existing field omitted by native Eq",
                    fact.name
                )));
            }
        }
        let mut plans = Vec::new();
        for field in &fields.named {
            let name = field.ident.as_ref().unwrap().to_string();
            let payload = equality.contains_key(&name);
            let classes = equality.get(&name).cloned().flatten();
            let provenance = fact.metadata.contains(&name) || classes.is_some();
            if !payload && !provenance {
                return Err(Error::at(&definition.file, field.span(), format!("{}.{} is omitted by native Eq but is not classified as metadata; add an explicit metadata field or update native equality", fact.name, name)));
            }
            let codec =
                codec::codec(&db, &definition.module, &field.ty, &crate_id).map_err(|e| {
                    Error::at(
                        &definition.file,
                        field.span(),
                        format!("{}.{}: {}", fact.name, name, e.message),
                    )
                })?;
            if classes.is_some() && !matches!(codec, Codec::U32 { .. }) {
                return Err(Error::new(format!(
                    "{}.{}: finite equivalence requires an exact u32 codec",
                    fact.name, name
                )));
            }
            plans.push(FieldPlan {
                name,
                rust_type: field.ty.to_token_stream().to_string(),
                codec,
                payload,
                provenance,
                classes,
            });
        }
        facts.push(FactPlan {
            name: fact.name.clone(),
            rust_path: fact.rust_path.clone(),
            fields: plans,
        });
    }
    Ok(Plan {
        version: 1,
        profile: "rust-whole-row-v1",
        crate_name: db.crates[&crate_id].name.clone(),
        sources: db.sources(),
        facts,
    })
}
fn validate_binding(binding: &Binding) -> Result<()> {
    if binding.version != 1 || binding.profile != "rust-whole-row-v1" {
        return Err(Error::new("expected version 1 rust-whole-row-v1 binding"));
    }
    source::rust_path(&binding.source.module)?;
    if binding.source.manifest.is_empty()
        || binding.source.manifest.starts_with('/')
        || binding
            .source
            .manifest
            .split('/')
            .any(|part| matches!(part, "" | "." | ".."))
        || binding.source.manifest.contains('\\')
    {
        return Err(Error::new(
            "binding manifest must be an ordinary root-relative path",
        ));
    }
    if binding.source.facts.is_empty() || binding.source.facts.len() > 32 {
        return Err(Error::new("bind one to 32 concrete Fact types"));
    }
    let mut names = BTreeSet::new();
    let mut paths = BTreeSet::new();
    for fact in &binding.source.facts {
        source::rust_path(&fact.rust_path)?;
        if !source::identifier(&fact.name)
            || !names.insert(&fact.name)
            || !paths.insert(&fact.rust_path)
            || fact.metadata.is_empty()
            || fact.metadata.iter().any(|name| !source::identifier(name))
            || fact.metadata.iter().collect::<BTreeSet<_>>().len() != fact.metadata.len()
        {
            return Err(Error::new("Fact names, paths, and explicit metadata fields must be distinct supported identifiers"));
        }
    }
    let model = &binding.model;
    if !source::identifier(&model.payload_input)
        || !source::identifier(&model.provenance_input)
        || model.payload_input == model.provenance_input
        || model.pairs.len() != 2
    {
        return Err(Error::new(
            "invalid whole-row model input or pair declarations",
        ));
    }
    let mut pair_names = BTreeSet::new();
    let mut variables = BTreeSet::new();
    for pair in &model.pairs {
        if !source::identifier(&pair.name)
            || !source::identifier(&pair.payload)
            || !source::identifier(&pair.provenance)
            || !pair_names.insert(&pair.name)
            || !variables.insert(&pair.payload)
            || !variables.insert(&pair.provenance)
        {
            return Err(Error::new(
                "row pairs require distinct names and state variables",
            ));
        }
    }
    Ok(())
}
