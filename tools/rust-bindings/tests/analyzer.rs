use sgd_rust_bindings::{analyze, analyze_with_generated};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/rust-facts")
}
fn copy_tree(source: &Path, destination: &Path) {
    fs::create_dir_all(destination).unwrap();
    for entry in fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &destination.join(entry.file_name()));
        } else {
            fs::copy(entry.path(), destination.join(entry.file_name())).unwrap();
        }
    }
}
fn fixture() -> tempfile::TempDir {
    let temp = tempfile::tempdir().unwrap();
    copy_tree(&fixtures().join("parangsae"), temp.path());
    temp
}
fn binding() -> PathBuf {
    fixtures().join("binding.json")
}
fn mutate(root: &Path, file: &str, from: &str, to: &str) {
    let path = root.join(file);
    let original = fs::read_to_string(&path).unwrap();
    assert!(!from.is_empty(), "fixture mutation must name a target");
    let from_lf = from.replace("\r\n", "\n");
    let from_crlf = from_lf.replace('\n', "\r\n");
    let matched = [(from_lf.as_str(), "\n"), (from_crlf.as_str(), "\r\n")]
        .into_iter()
        .filter_map(|(needle, newline)| {
            original
                .find(needle)
                .map(|offset| (offset, needle, newline))
        })
        .min_by_key(|(offset, _, _)| *offset);
    let (_, needle, newline) = matched.unwrap_or((0, from_lf.as_str(), "\n"));
    assert!(
        original.contains(needle),
        "mutation target must exist: {file}: {from}"
    );
    let offset = original
        .find(needle)
        .expect("the target was asserted above");
    let newline = if needle.contains('\n') {
        newline
    } else {
        line_ending_near(&original, offset + needle.len())
    };
    let replacement = to.replace("\r\n", "\n").replace('\n', newline);
    let mut mutated = original;
    mutated.replace_range(offset..offset + needle.len(), &replacement);
    fs::write(path, mutated).unwrap();
}
fn line_ending_near(text: &str, offset: usize) -> &'static str {
    let next = text[offset..].find('\n').map(|index| offset + index);
    let previous = text[..offset].rfind('\n');
    if next
        .or(previous)
        .is_some_and(|index| index > 0 && text.as_bytes()[index - 1] == b'\r')
    {
        "\r\n"
    } else {
        "\n"
    }
}
fn rejects(root: &Path, expected: &str) {
    let error = analyze(root, &binding()).expect_err("source mutation must fail closed");
    assert_eq!(error.rule_id, "TLC305");
    assert!(
        error.message.contains(expected),
        "unexpected diagnostic: {error}"
    );
}

fn rewrite_fixture_line_endings(directory: &Path, newline: &str) {
    for entry in fs::read_dir(directory).unwrap() {
        let entry = entry.unwrap();
        if entry.file_type().unwrap().is_dir() {
            rewrite_fixture_line_endings(&entry.path(), newline);
        } else {
            let text = fs::read_to_string(entry.path()).unwrap();
            fs::write(
                entry.path(),
                text.replace("\r\n", "\n").replace('\n', newline),
            )
            .unwrap();
        }
    }
}

#[test]
fn crlf_fixture_analysis_preserves_bytes_and_refuses_actual_semantic_mutations() {
    let temp = fixture();
    rewrite_fixture_line_endings(temp.path(), "\r\n");
    let plan = analyze(temp.path(), &binding()).unwrap();
    assert_eq!(
        plan.facts
            .iter()
            .map(|fact| fact.fields.len())
            .collect::<Vec<_>>(),
        [18, 9, 13, 10]
    );
    for source in &plan.sources {
        let bytes = fs::read(temp.path().join(&source.path)).unwrap();
        let text = String::from_utf8(bytes.clone()).unwrap();
        assert!(
            text.contains("\r\n"),
            "fixture source must contain CRLF: {}",
            source.path
        );
        assert!(!text.replace("\r\n", "").contains(['\r', '\n']));
        let digest: String = Sha256::digest(&bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        assert_eq!(
            source.sha256, digest,
            "source identity must hash actual CRLF bytes: {}",
            source.path
        );
    }
    for (file, from, to, diagnostic) in [
        (
            "crates/collector/src/vision/rows.rs",
            "#[derive(Clone, Debug)]\npub struct KlineFact",
            "#[derive(Debug)]\npub struct KlineFact",
            "requires standard derived Clone",
        ),
        (
            "crates/collector/src/vision/rows.rs",
            "            && self.count == other.count\n",
            "",
            "count is omitted",
        ),
        (
            "crates/core/src/timestamps.rs",
            "pub const fn micros(self) -> UtcMicros {\n                self.0",
            "pub const fn micros(self) -> UtcMicros {\n                UtcMicros::from_micros(0)",
            "exact private representation",
        ),
        (
            "crates/collector/src/vision/rows.rs",
            "pub interval_us: i64,",
            "pub interval_us: i64,\n    pub extra_payload: i64,",
            "extra_payload is omitted",
        ),
        (
            "crates/collector/src/vision/rows.rs",
            "\n                        | (SCHEMA_KLINE_HEADER, SCHEMA_KLINE_HEADERLESS)",
            "",
            "not symmetric",
        ),
    ] {
        let temp = fixture();
        rewrite_fixture_line_endings(temp.path(), "\r\n");
        mutate(temp.path(), file, from, to);
        let mutated = fs::read_to_string(temp.path().join(file)).unwrap();
        assert!(mutated.contains("\r\n"));
        assert!(
            !mutated.replace("\r\n", "").contains(['\r', '\n']),
            "mutation must preserve CRLF: {file}"
        );
        rejects(temp.path(), diagnostic);
    }
}

#[test]
fn crlf_multiline_mutation_preserves_an_unrelated_lf_only_hook() {
    let temp = fixture();
    rewrite_fixture_line_endings(temp.path(), "\r\n");
    let file = "crates/collector/src/vision/rows.rs";
    let path = temp.path().join(file);
    let hook = "\n// LF-only generated fixture hook\n";
    let original = format!("{}{hook}", fs::read_to_string(&path).unwrap());
    fs::write(&path, original).unwrap();
    mutate(
        temp.path(),
        file,
        "#[derive(Clone, Debug)]\npub struct KlineFact",
        "#[derive(Debug)]\npub struct KlineFact",
    );
    let mutated = fs::read_to_string(path).unwrap();
    assert!(mutated.contains("#[derive(Debug)]\r\npub struct KlineFact"));
    assert!(
        mutated.ends_with(hook),
        "unrelated LF-only bytes must remain unchanged"
    );
    rejects(temp.path(), "requires standard derived Clone");
}

#[test]
fn public_fact_and_wrapper_sources_derive_complete_plan() {
    let plan = analyze(&fixtures().join("parangsae"), &binding()).unwrap();
    assert_eq!(plan.crate_name, "parangsae-collector");
    assert_eq!(
        plan.facts
            .iter()
            .map(|f| f.fields.len())
            .collect::<Vec<_>>(),
        [18, 9, 13, 10]
    );
    let kline = &plan.facts[0];
    let schema = kline
        .fields
        .iter()
        .find(|f| f.name == "schema_version")
        .unwrap();
    assert_eq!(schema.classes, Some(vec![vec![1, 2]]));
    assert!(schema.payload && schema.provenance);
    for fact in &plan.facts {
        let received = fact
            .fields
            .iter()
            .find(|f| f.name == "received_ts")
            .unwrap();
        assert!(!received.payload && received.provenance);
        assert_eq!(
            serde_json::to_value(&received.codec).unwrap(),
            serde_json::json!({"kind":"i64","getters":["micros","micros"]})
        );
    }
    assert!(plan
        .sources
        .iter()
        .any(|s| s.path == "crates/core/src/timestamps.rs"));
    assert!(plan.sources.iter().all(|s| s.sha256.len() == 64));
    let temp = fixture();
    fs::copy(
        fixtures().join("rows-main.rs"),
        temp.path().join("crates/collector/src/vision/rows.rs"),
    )
    .unwrap();
    let main = analyze(temp.path(), &binding()).unwrap();
    assert!(main.facts[0]
        .fields
        .iter()
        .find(|f| f.name == "schema_version")
        .unwrap()
        .classes
        .is_none());
}

#[test]
fn added_and_omitted_fields_cannot_disappear_from_equality_binding() {
    let temp = fixture();
    mutate(
        temp.path(),
        "crates/collector/src/vision/rows.rs",
        "pub interval_us: i64,",
        "pub interval_us: i64,\n    pub extra_payload: i64,",
    );
    rejects(temp.path(), "extra_payload is omitted");
    let temp = fixture();
    mutate(
        temp.path(),
        "crates/collector/src/vision/rows.rs",
        "            && self.count == other.count\n",
        "",
    );
    rejects(temp.path(), "count is omitted");
    let temp = fixture();
    mutate(
        temp.path(),
        "crates/collector/src/vision/rows.rs",
        "self.count == other.count",
        "self.count != other.count",
    );
    rejects(temp.path(), "unsupported boolean operator");
}

#[test]
fn exact_getters_and_known_macro_representations_are_required() {
    let temp = fixture();
    mutate(
        temp.path(),
        "crates/core/src/fixed.rs",
        "pub struct Qty(i64);",
        "pub struct Qty(std::rc::Rc<std::cell::Cell<i64>>);",
    );
    rejects(temp.path(), "generic and qualified source paths");
    let temp = fixture();
    mutate(
        temp.path(),
        "crates/core/src/timestamps.rs",
        "pub const fn micros(self) -> UtcMicros {\n                self.0",
        "pub const fn micros(self) -> UtcMicros {\n                UtcMicros::from_micros(0)",
    );
    rejects(temp.path(), "exact private representation");
    let temp = fixture();
    mutate(
        temp.path(),
        "crates/core/src/symbol.rs",
        "pub fn as_str(&self) -> &str {\n        &self.0",
        "pub fn as_str(&self) -> &str {\n        \"constant\"",
    );
    rejects(temp.path(), "exact private representation");
}

#[test]
fn custom_clone_drop_and_conditional_fact_definitions_fail() {
    let temp = fixture();
    let rows = temp.path().join("crates/collector/src/vision/rows.rs");
    let mut text = fs::read_to_string(&rows).unwrap();
    text.push_str(
        "\nimpl Drop for KlineFact { fn drop(&mut self) { panic!(\"drop callback\"); } }\n",
    );
    fs::write(rows, text).unwrap();
    rejects(temp.path(), "Drop implementations");
    let temp = fixture();
    mutate(
        temp.path(),
        "crates/collector/src/vision/rows.rs",
        "#[derive(Clone, Debug)]\npub struct KlineFact",
        "#[derive(Debug)]\npub struct KlineFact",
    );
    rejects(temp.path(), "requires standard derived Clone");
    let temp = fixture();
    mutate(
        temp.path(),
        "crates/collector/src/vision/rows.rs",
        "pub struct KlineFact",
        "#[cfg(test)]\npub struct KlineFact",
    );
    rejects(temp.path(), "cannot be resolved");
}

#[test]
fn finite_quotients_are_verified_not_completed_by_the_analyzer() {
    let temp = fixture();
    mutate(
        temp.path(),
        "crates/collector/src/vision/rows.rs",
        "\n                        | (SCHEMA_KLINE_HEADER, SCHEMA_KLINE_HEADERLESS)",
        "",
    );
    rejects(temp.path(), "not symmetric");
    let temp = fixture();
    mutate(
        temp.path(),
        "crates/collector/src/vision/rows.rs",
        "| (SCHEMA_KLINE_HEADER, SCHEMA_KLINE_HEADERLESS)",
        "| (SCHEMA_KLINE_HEADER, SCHEMA_KLINE_HEADERLESS) | (2, 3) | (3, 2)",
    );
    rejects(temp.path(), "not transitive");
}

fn tiny_source(source: &str) -> (tempfile::TempDir, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    fs::write(
        temp.path().join("Cargo.toml"),
        "[package]\nname=\"counterexample\"\nversion=\"0.0.0\"\nedition=\"2021\"\n[workspace]\n",
    )
    .unwrap();
    fs::create_dir(temp.path().join("src")).unwrap();
    fs::write(temp.path().join("src/lib.rs"), source).unwrap();
    let mut json: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(binding()).unwrap()).unwrap();
    json["source"] = serde_json::json!({"manifest":"Cargo.toml","module":"crate","facts":[{"name":"Fact","rustPath":"crate::Fact","metadata":["received"]}]});
    let path = temp.path().join("binding.json");
    fs::write(&path, json.to_string()).unwrap();
    (temp, path)
}

#[test]
fn locally_shadowed_qualified_matches_cannot_define_a_quotient() {
    let (temp, binding) = tiny_source(
        r#"
#[macro_export]
macro_rules! fake_matches { ($($tt:tt)*) => {true}; }
mod std { pub use crate::fake_matches as matches; }
#[derive(Clone,Debug)] pub struct Fact {pub schema:u32,pub received:i64}
impl PartialEq for Fact {fn eq(&self,other:&Self)->bool {self.schema==other.schema || std::matches!((self.schema,other.schema),(1,2)|(2,1))}}
impl Eq for Fact {}
"#,
    );
    let error = analyze(temp.path(), &binding)
        .expect_err("a textual std prefix is not standard macro resolution");
    assert!(error.message.contains("matches"), "{error}");
}

#[test]
fn sibling_item_macro_cannot_hide_a_drop_callback_for_a_bound_fact() {
    let (temp, binding) = tiny_source(
        r#"
#[derive(Clone,Debug)] pub struct Fact {pub value:i64,pub received:i64}
impl PartialEq for Fact {fn eq(&self,other:&Self)->bool {self.value==other.value}}
impl Eq for Fact {}
mod hidden {
    macro_rules! emit_drop {()=>{impl Drop for crate::Fact {fn drop(&mut self){panic!("after semantic commit")}}};}
    pub(crate) use emit_drop as exported;
    self::exported!();
}
"#,
    );
    analyze(temp.path(), &binding)
        .expect_err("sibling macro implementations must not bypass whole-row ownership");
}

#[test]
fn standard_macro_input_tokens_cannot_hide_nonlocal_implementations() {
    let (temp, binding) = tiny_source(
        r#"
#[derive(Clone,Debug)] pub struct Fact {pub value:i64,pub received:i64}
impl PartialEq for Fact {fn eq(&self,other:&Self)->bool {self.value==other.value}}
impl Eq for Fact {}
fn hidden() { let _ = format!("{}", {impl Drop for crate::Fact {fn drop(&mut self){panic!("drop")}} 0}); }
"#,
    );
    analyze(temp.path(), &binding)
        .expect_err("standard macro expressions must not hide nonlocal implementations");
}

#[test]
fn reexported_drop_traits_and_nonlocal_implementations_fail() {
    let (temp, binding) = tiny_source(
        r#"
#[derive(Clone,Debug)] pub struct Fact {pub value:i64,pub received:i64}
impl PartialEq for Fact {fn eq(&self,other:&Self)->bool {self.value==other.value}}
impl Eq for Fact {}
mod aliases {pub use std::ops::Drop as Cleanup;}
impl aliases::Cleanup for Fact {fn drop(&mut self){panic!("drop")}}
"#,
    );
    analyze(temp.path(), &binding)
        .expect_err("a re-exported Drop trait cannot become an ignored custom trait");
    let (temp, binding) = tiny_source(
        r#"
#[derive(Clone,Debug)] pub struct Fact {pub value:i64,pub received:i64}
impl PartialEq for Fact {fn eq(&self,other:&Self)->bool {self.value==other.value}}
impl Eq for Fact {}
fn hidden() {impl Drop for crate::Fact {fn drop(&mut self){panic!("drop")}}}
"#,
    );
    let error = analyze(temp.path(), &binding).unwrap_err();
    assert!(error.message.contains("nested"), "{error}");
}

#[test]
fn primitive_aliases_and_consuming_noncopy_getters_are_not_codecs() {
    let (temp, binding) = tiny_source(
        r#"
type i64 = std::cell::Cell<std::primitive::i64>;
#[derive(Clone,Debug)] pub struct Fact {pub value:i64,pub received:u32}
impl PartialEq for Fact {fn eq(&self,other:&Self)->bool {self.value==other.value}}
impl Eq for Fact {}
"#,
    );
    let error = analyze(temp.path(), &binding).unwrap_err();
    assert!(error.message.contains("shadowed"), "{error}");
    let (temp, binding) = tiny_source(
        r#"
#[derive(Clone,Debug,PartialEq,Eq)] pub struct Counter(i64);
impl Counter {pub fn into_inner(self)->i64 {self.0}}
#[derive(Clone,Debug)] pub struct Fact {pub value:Counter,pub received:i64}
impl PartialEq for Fact {fn eq(&self,other:&Self)->bool {self.value==other.value}}
impl Eq for Fact {}
"#,
    );
    let error = analyze(temp.path(), &binding).unwrap_err();
    assert!(
        error.message.contains("exact private representation"),
        "{error}"
    );
}

#[test]
fn shadowed_qualified_traits_and_ancestor_proc_attributes_fail() {
    let (temp, binding) = tiny_source(
        r#"
mod std {pub mod cmp {pub trait PartialEq {fn eq(&self,other:&Self)->bool;} pub trait Eq {}}}
#[derive(Clone,Debug,PartialEq,Eq)] pub struct Fact {pub value:i64,pub received:i64}
impl std::cmp::PartialEq for Fact {fn eq(&self,other:&Self)->bool {self.value==other.value}}
impl std::cmp::Eq for Fact {}
"#,
    );
    let error = analyze(temp.path(), &binding).unwrap_err();
    assert!(error.message.contains("shadowed"), "{error}");
    let (temp, binding) = tiny_source(
        r#"
#[derive(Clone,Debug)] pub struct Fact {pub value:i64,pub received:i64}
impl PartialEq for Fact {fn eq(&self,other:&Self)->bool {self.value==other.value}}
impl Eq for Fact {}
#[cfg_attr(not(test), injected::rewrite)] mod hidden {}
"#,
    );
    let error = analyze(temp.path(), &binding).unwrap_err();
    assert!(error.message.contains("cfg_attr"), "{error}");
}

#[test]
fn inherent_clone_and_attributed_aliases_cannot_hide_callbacks() {
    let (temp, binding) = tiny_source(
        r#"
#[derive(Clone,Debug)] pub struct Fact {pub value:i64,pub received:i64}
impl PartialEq for Fact {fn eq(&self,other:&Self)->bool {self.value==other.value}}
impl Eq for Fact {}
impl Fact {pub fn clone(&self)->Self {panic!("inherent clone callback")}}
"#,
    );
    let error = analyze(temp.path(), &binding).unwrap_err();
    assert!(error.message.contains("inherent clone"), "{error}");
    let (temp, binding) = tiny_source(
        r#"
#[derive(Clone,Debug)] pub struct Fact {pub value:i64,pub received:i64}
impl PartialEq for Fact {fn eq(&self,other:&Self)->bool {self.value==other.value}}
impl Eq for Fact {}
#[cfg(feature="x")] type Alias=Fact;
impl Alias {pub fn clone(&self)->Self {panic!("hidden clone")}}
"#,
    );
    let error = analyze(temp.path(), &binding).unwrap_err();
    assert!(error.message.contains("aliases"), "{error}");
}

#[test]
fn generated_sources_are_outputs_not_recursive_binding_inputs() {
    let temp = fixture();
    let generated = temp.path().join("generated");
    fs::create_dir_all(generated.join("rust/src")).unwrap();
    fs::write(
        generated.join("rust/adapter.rs"),
        "compile_error!(\"stale generated adapter\");",
    )
    .unwrap();
    fs::write(
        generated.join("rust/src/lib.rs"),
        "compile_error!(\"stale primitive owner\");",
    )
    .unwrap();
    fs::write(
        generated.join("rust/Cargo.toml"),
        "not a valid old manifest",
    )
    .unwrap();
    let lib = temp.path().join("crates/collector/src/lib.rs");
    fs::write(
        &lib,
        format!(
            "{}\n#[path=\"../../../generated/rust/adapter.rs\"] mod generated_adapter;\n",
            fs::read_to_string(&lib).unwrap()
        ),
    )
    .unwrap();
    let manifest = temp.path().join("crates/collector/Cargo.toml");
    fs::write(
        &manifest,
        format!(
            "{}\nprimitive={{path=\"../../generated/rust\"}}\n",
            fs::read_to_string(&manifest).unwrap()
        ),
    )
    .unwrap();
    let plan = analyze_with_generated(temp.path(), &binding(), Some(&generated)).unwrap();
    assert!(plan
        .sources
        .iter()
        .all(|source| !source.path.starts_with("generated/")));
    mutate(
        temp.path(),
        "crates/collector/src/lib.rs",
        "mod generated_adapter;",
        "pub mod generated_adapter;",
    );
    let error = analyze_with_generated(temp.path(), &binding(), Some(&generated)).unwrap_err();
    assert!(error.message.contains("private, unconditional"), "{error}");
}

#[test]
fn missing_generated_outputs_bootstrap_without_becoming_source_inputs() {
    let temp = fixture();
    let generated = temp.path().join("not-yet-created/nested/generated");
    let lib = temp.path().join("crates/collector/src/lib.rs");
    fs::write(&lib, format!("{}\n#[path=\"../../../not-yet-created/nested/generated/rust/adapter.rs\"] mod generated_adapter;\n", fs::read_to_string(&lib).unwrap())).unwrap();
    let manifest = temp.path().join("crates/collector/Cargo.toml");
    fs::write(
        &manifest,
        format!(
            "{}\nprimitive={{path=\"../../not-yet-created/nested/generated/rust\"}}\n",
            fs::read_to_string(&manifest).unwrap()
        ),
    )
    .unwrap();
    let plan = analyze_with_generated(temp.path(), &binding(), Some(&generated)).unwrap();
    assert!(plan
        .sources
        .iter()
        .all(|source| !source.path.starts_with("not-yet-created/")));
    assert!(!generated.exists());
}

#[test]
fn local_cargo_source_overrides_cannot_spoof_trusted_macro_dependencies() {
    let temp = fixture();
    fs::create_dir(temp.path().join(".cargo")).unwrap();
    fs::write(
        temp.path().join(".cargo/config.toml"),
        "[source.crates-io]\nreplace-with=\"other\"\n[source.other]\ndirectory=\"vendor\"\n",
    )
    .unwrap();
    rejects(temp.path(), "only Cargo [alias]");
    let temp = fixture();
    let manifest = temp.path().join("Cargo.toml");
    fs::write(
        &manifest,
        format!(
            "{}\n[patch.crates-io]\nserde={{path=\"fake-serde\"}}\n",
            fs::read_to_string(&manifest).unwrap()
        ),
    )
    .unwrap();
    rejects(temp.path(), "patch/replace");
    let temp = fixture();
    let manifest = temp.path().join("crates/collector/Cargo.toml");
    fs::write(
        &manifest,
        format!(
            "{}\nserde={{version=\"1\",registry=\"other\"}}\n",
            fs::read_to_string(&manifest).unwrap()
        ),
    )
    .unwrap();
    rejects(temp.path(), "custom registry");
}

#[test]
fn ordinary_cargo_alias_configuration_is_included_in_source_identity() {
    let temp = fixture();
    fs::create_dir(temp.path().join(".cargo")).unwrap();
    fs::write(
        temp.path().join(".cargo/config.toml"),
        "[alias]\nxtask=\"run --package xtask --\"\n",
    )
    .unwrap();
    let plan = analyze(temp.path(), &binding()).unwrap();
    assert!(plan
        .sources
        .iter()
        .any(|source| source.path == ".cargo/config.toml"));
}

#[test]
fn legacy_action_outcome_permutations_fail_at_the_binding_boundary() {
    let temp = fixture();
    let mut json: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(binding()).unwrap()).unwrap();
    json["model"]["outcomes"] =
        serde_json::json!({"Insert":"Clash","Same":"Insert","Clash":"Same"});
    let path = temp.path().join("legacy-binding.json");
    fs::write(&path, json.to_string()).unwrap();
    let error = analyze(temp.path(), &path).unwrap_err();
    assert!(
        error.message.contains("unknown field `outcomes`"),
        "{error}"
    );
}

#[cfg(unix)]
#[test]
fn source_symlinks_fail_even_when_the_target_remains_inside_the_root() {
    let temp = fixture();
    let rows = temp.path().join("crates/collector/src/vision/rows.rs");
    let target = rows.with_file_name("real_rows.rs");
    fs::rename(&rows, &target).unwrap();
    std::os::unix::fs::symlink(&target, &rows).unwrap();
    rejects(temp.path(), "symlinks are unsupported");
}
