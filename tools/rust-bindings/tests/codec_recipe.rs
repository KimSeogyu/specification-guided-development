use serde::Deserialize;
use serde_json::Value;
use sgd_rust_bindings::{analyze, analyze_codec_recipe, CheckedCodecRecipe, Error};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

const MARKER: &str = ".sgd-codec-mutation-must-not-exist";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Corpus {
    version: u8,
    profile: String,
    execution: String,
    cases: Vec<MutationCase>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MutationCase {
    id: String,
    phase: Phase,
    expected: Expected,
    requirement: String,
    edits: Vec<Edit>,
    #[serde(default)]
    v5_contrast: Option<String>,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum Phase {
    BeforeAnalysis,
    AfterCapture,
}

#[derive(Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum Expected {
    AnalysisRefusal,
    RecheckRefusal,
}

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "kebab-case", deny_unknown_fields)]
enum Edit {
    ReplaceOnce {
        path: String,
        from: String,
        to: String,
    },
    CreateAbsentFile {
        path: String,
        contents: String,
    },
}

struct Fixture {
    directory: tempfile::TempDir,
    root: PathBuf,
    binding: PathBuf,
}

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/rust-codec-recipe")
}

fn copy_tree(source: &Path, destination: &Path) {
    fs::create_dir_all(destination).unwrap();
    for entry in fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let kind = entry.file_type().unwrap();
        assert!(!kind.is_symlink(), "fixture input must be an ordinary file");
        if kind.is_dir() {
            copy_tree(&entry.path(), &destination.join(entry.file_name()));
        } else {
            assert!(kind.is_file(), "fixture input must be an ordinary file");
            fs::copy(entry.path(), destination.join(entry.file_name())).unwrap();
        }
    }
}

fn fixture() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("application");
    let binding = directory.path().join("codec-binding.json");
    copy_tree(&fixtures().join("parangsae"), &root);
    fs::copy(fixtures().join("codec-binding.json"), &binding).unwrap();
    Fixture {
        directory,
        root,
        binding,
    }
}

impl Fixture {
    fn analyze(&self) -> CheckedCodecRecipe {
        analyze_codec_recipe(&self.root, &self.binding)
            .unwrap_or_else(|error| panic!("real native Funding fixture must be admitted: {error}"))
    }

    fn assert_no_effect(&self) {
        for directory in [self.root.as_path(), self.directory.path()] {
            assert!(!directory.join(MARKER).exists(), "constructor IO ran");
            assert!(
                !directory.join("not-executed").exists(),
                "discovered target code ran"
            );
        }
    }
}

fn corpus() -> Corpus {
    let corpus: Corpus =
        serde_json::from_str(&fs::read_to_string(fixtures().join("mutations.json")).unwrap())
            .unwrap();
    assert_eq!(corpus.version, 1);
    assert_eq!(corpus.profile, "rust-codec-recipe-v1");
    assert!(corpus.execution.contains("Never compile or execute"));
    assert!(!corpus.cases.is_empty());
    let mut names = BTreeSet::new();
    for case in &corpus.cases {
        assert!(!case.id.is_empty() && names.insert(&case.id));
        assert!(!case.requirement.is_empty() && !case.edits.is_empty());
        assert!(matches!(
            (&case.phase, &case.expected),
            (Phase::BeforeAnalysis, Expected::AnalysisRefusal)
                | (Phase::AfterCapture, Expected::RecheckRefusal)
        ));
        if let Some(contrast) = &case.v5_contrast {
            assert!(!contrast.is_empty());
        }
    }
    corpus
}

fn fixture_path(root: &Path, relative: &str) -> PathBuf {
    let path = Path::new(relative);
    assert!(
        !relative.is_empty()
            && !relative.contains('\\')
            && path
                .components()
                .all(|part| matches!(part, Component::Normal(_))),
        "mutation path must remain inside its fresh fixture: {relative}"
    );
    root.join(path)
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

fn replace_once(path: &Path, from: &str, to: &str, case: &str) {
    assert!(
        !from.is_empty(),
        "{case}: mutation must name a source target"
    );
    let original = fs::read_to_string(path).unwrap();
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
    let (offset, needle, newline) = matched.unwrap_or_else(|| {
        panic!(
            "{case}: mutation source target must exist in {}",
            path.display()
        )
    });
    assert_eq!(
        original.matches(needle).count(),
        1,
        "{case}: mutation source target must occur exactly once in {}",
        path.display()
    );
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

fn apply(fixture: &Fixture, case: &MutationCase) {
    for edit in &case.edits {
        match edit {
            Edit::ReplaceOnce { path, from, to } => {
                replace_once(&fixture_path(&fixture.root, path), from, to, &case.id);
            }
            Edit::CreateAbsentFile { path, contents } => {
                let path = fixture_path(&fixture.root, path);
                let error = fs::symlink_metadata(&path)
                    .expect_err("create-absent-file must not replace an existing source input");
                assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(path, contents).unwrap();
            }
        }
    }
}

fn refusal(result: Result<CheckedCodecRecipe, Error>, context: &str) -> Error {
    let error = match result {
        Ok(_) => panic!("{context}: unsupported codec source was accepted"),
        Err(error) => error,
    };
    assert_eq!(error.rule_id, "TLC309", "{context}: {error}");
    assert!(
        !error.message.trim().is_empty(),
        "{context}: empty diagnostic"
    );
    error
}

fn assert_identity(value: &Value, module: &str, item: &str, file: &str) {
    assert_eq!(value["crateId"], module.split("::").next().unwrap());
    assert_eq!(value["module"], module);
    assert_eq!(value["item"], item);
    assert_eq!(value["file"], file);
    assert!(value["line"].as_u64().is_some_and(|line| line > 0));
    assert!(value["column"].as_u64().is_some_and(|column| column > 0));
}

fn assert_tuple(value: &Value, module: &str, item: &str, file: &str) {
    assert_eq!(value["kind"], "tuple-wrap");
    assert_identity(&value["constructor"], module, item, file);
}

fn has_key(value: &Value, name: &str) -> bool {
    match value {
        Value::Object(object) => {
            object.contains_key(name) || object.values().any(|value| has_key(value, name))
        }
        Value::Array(array) => array.iter().any(|value| has_key(value, name)),
        _ => false,
    }
}

fn assert_scope(report: &Value) {
    assert_eq!(report["version"], 1);
    assert_eq!(report["profile"], "rust-codec-recipe-v1");
    assert_eq!(
        report["scope"],
        "selected-codec-and-native-constructor-closure"
    );
    assert_eq!(report["storageAuthority"], false);
    assert_eq!(report["discovery"]["scope"], "discovered-targets-only");
    assert!(!has_key(report, "allTargetsChecked"));
}

fn assert_source_bytes(fixture: &Fixture, report: &Value, newline: Option<&str>) {
    let sources = report["sources"].as_array().unwrap();
    let mut paths = BTreeSet::new();
    for source in sources {
        let path = source["path"].as_str().unwrap();
        assert!(paths.insert(path), "captured source paths must be unique");
        let bytes = fs::read(fixture_path(&fixture.root, path)).unwrap();
        let digest: String = Sha256::digest(&bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        assert_eq!(source["sha256"], digest, "actual source bytes: {path}");
        if let Some(newline) = newline {
            let text = String::from_utf8(bytes).unwrap();
            if text.contains('\n') {
                assert!(text.contains(newline), "actual source newline: {path}");
                if newline == "\r\n" {
                    assert!(
                        !text.replace("\r\n", "").contains(['\r', '\n']),
                        "source bytes must remain CRLF: {path}"
                    );
                }
            }
        }
    }
    for path in [
        "Cargo.toml",
        "Cargo.lock",
        "crates/collector/src/funding_codec.rs",
        "crates/collector/src/sgd_wire.rs",
        "crates/collector/src/vision/rows.rs",
        "crates/core/src/fixed.rs",
        "crates/core/src/symbol.rs",
        "crates/core/src/time.rs",
        "crates/core/src/timestamps.rs",
    ] {
        assert!(paths.contains(path), "source closure omitted {path}");
    }
}

#[test]
fn funding_recipe_preserves_every_physical_column_and_actual_constructor_identity() {
    let fixture = fixture();
    let checked = fixture.analyze();
    assert!(!checked.report().storage_authority());
    let report = serde_json::to_value(checked.report()).unwrap();
    assert_scope(&report);
    let library = &report["library"];
    assert_eq!(library["target"], "parangsae_collector");
    assert_eq!(library["crateName"], "parangsae_collector");
    assert_eq!(library["source"], "crates/collector/src/lib.rs");
    let discovered_library = report["discovery"]["localTargets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|target| target["source"] == library["source"] && target["kind"] == "lib")
        .expect("selected library must be tied to one discovered Cargo target");
    assert_eq!(library["packageId"], discovered_library["packageId"]);
    assert_eq!(library["target"], discovered_library["name"]);
    assert_eq!(library["crateName"], discovered_library["crateName"]);
    assert_eq!(report["row"]["name"], "FundingFact");
    assert_eq!(report["row"]["rustPath"], "crate::vision::FundingFact");
    let expected = [
        ("symbol", "symbol", "string"),
        ("raw_calc_time_us", "raw_calc_time", "i64"),
        ("funding_time_us", "funding_time", "i64"),
        ("interval_hours", "interval_hours", "i64"),
        ("rate_ticks", "rate", "i64"),
        ("event_ts_us", "event_ts", "i64"),
        ("available_ts_us", "available_ts", "i64"),
        ("received_ts_us", "received_ts", "i64"),
        ("schema_version", "schema_version", "u32"),
    ];
    let columns = report["columns"].as_array().unwrap();
    assert_eq!(columns.len(), expected.len());
    for (column, (physical, native, scalar)) in columns.iter().zip(expected) {
        assert_eq!(column["column"], physical);
        assert_eq!(column["field"], native);
        assert_eq!(column["scalar"], scalar);
        assert_eq!(column["nullable"], false);
    }
    let native_fields = report["row"]["fields"].as_array().unwrap();
    assert_eq!(native_fields.len(), expected.len());
    assert_eq!(
        native_fields
            .iter()
            .map(|field| field["name"].as_str().unwrap())
            .collect::<BTreeSet<_>>(),
        expected.iter().map(|(_, field, _)| *field).collect()
    );
    let receipt = native_fields
        .iter()
        .find(|field| field["name"] == "received_ts")
        .unwrap();
    assert_eq!(receipt["payload"], false);
    assert_eq!(receipt["provenance"], true);

    for (name, item) in [
        ("encode", "encode_funding_row"),
        ("decode", "decode_funding_row"),
    ] {
        assert_identity(
            &report["entrypoints"][name],
            "parangsae_collector::funding_codec",
            item,
            "crates/collector/src/funding_codec.rs",
        );
    }
    assert_identity(
        &report["wire"],
        "parangsae_collector::sgd_wire",
        "FundingWire",
        "crates/collector/src/sgd_wire.rs",
    );
    let recipe = |column: &str| {
        &columns
            .iter()
            .find(|value| value["column"] == column)
            .unwrap()["decode"]
    };
    let symbol = recipe("symbol");
    assert_eq!(symbol["kind"], "ascii-symbol");
    assert_identity(
        &symbol["constructor"],
        "parangsae_core::symbol",
        "Symbol::new",
        "crates/core/src/symbol.rs",
    );
    assert_identity(
        &symbol["errorType"],
        "parangsae_core::symbol",
        "SymbolError",
        "crates/core/src/symbol.rs",
    );
    for column in ["raw_calc_time_us", "funding_time_us"] {
        let value = recipe(column);
        assert_tuple(
            value,
            "parangsae_core::time",
            "UtcMicros::from_micros",
            "crates/core/src/time.rs",
        );
        assert_eq!(
            value["inner"],
            serde_json::json!({"kind":"identity","scalar":"i64"})
        );
    }
    let rate = recipe("rate_ticks");
    assert_tuple(
        rate,
        "parangsae_core::fixed",
        "Ratio::from_ticks",
        "crates/core/src/fixed.rs",
    );
    assert_eq!(
        rate["inner"],
        serde_json::json!({"kind":"identity","scalar":"i64"})
    );
    for (column, constructor) in [
        ("event_ts_us", "EventTs::from_micros"),
        ("available_ts_us", "AvailableTs::from_micros"),
        ("received_ts_us", "ReceivedTs::from_micros"),
    ] {
        let value = recipe(column);
        assert_tuple(
            value,
            "parangsae_core::timestamps",
            constructor,
            "crates/core/src/timestamps.rs",
        );
        assert_tuple(
            &value["inner"],
            "parangsae_core::time",
            "UtcMicros::from_micros",
            "crates/core/src/time.rs",
        );
        assert_eq!(
            value["inner"]["inner"],
            serde_json::json!({"kind":"identity","scalar":"i64"})
        );
    }
    assert_eq!(
        recipe("interval_hours"),
        &serde_json::json!({"kind":"identity","scalar":"i64"})
    );
    assert_eq!(
        recipe("schema_version"),
        &serde_json::json!({"kind":"identity","scalar":"u32"})
    );
    assert_source_bytes(&fixture, &report, None);
    checked.recheck().unwrap();
    assert_eq!(
        report,
        serde_json::to_value(fixture.analyze().report()).unwrap(),
        "unchanged source must produce the same semantic report"
    );
    fixture.assert_no_effect();
}

fn check_source_mutations(newline: &str) {
    let corpus = corpus();
    let cases: Vec<_> = corpus
        .cases
        .iter()
        .filter(|case| case.phase == Phase::BeforeAnalysis)
        .collect();
    assert!(!cases.is_empty());
    for case in cases {
        let fixture = fixture();
        if newline == "\r\n" {
            rewrite_line_endings(&fixture.root, newline);
        }
        apply(&fixture, case);
        let error = refusal(
            analyze_codec_recipe(&fixture.root, &fixture.binding),
            &format!("{}: {}", case.id, case.requirement),
        );
        if case.id == "symbol-constructor-safe-write" {
            assert!(error.message.contains("new"), "{error}");
        }
        if case.id == "utc-constructor-safe-write" {
            assert!(error.message.contains("from_micros"), "{error}");
        }
        let selected_item = match case.id.as_str() {
            "encode-clock-swap"
            | "paired-clock-swap"
            | "receipt-omitted-by-equality"
            | "schema-normalized-for-storage"
            | "encode-effect-before-projection" => Some("encode_funding_row"),
            "decode-clock-swap"
            | "decode-receipt-replaced"
            | "interval-csv-tightening"
            | "symbol-input-bypass"
            | "function-value-call"
            | "display-error-conversion" => Some("decode_funding_row"),
            "descriptor-field-duplication" | "descriptor-column-duplication" => {
                Some("FUNDING_COLUMNS")
            }
            _ => None,
        };
        if let Some(item) = selected_item {
            assert_eq!(
                error.file.as_deref(),
                Some("crates/collector/src/funding_codec.rs"),
                "{}: selected recipe diagnostic must name its actual source file",
                case.id
            );
            assert!(
                error.message.contains(item),
                "{}: selected recipe diagnostic must name {item}: {error}",
                case.id
            );
            assert!(error.line.is_some_and(|line| line > 0));
            assert!(error.column.is_some_and(|column| column > 0));
        }
        if newline == "\r\n" {
            for edit in &case.edits {
                if let Edit::ReplaceOnce { path, .. } = edit {
                    let text = fs::read_to_string(fixture.root.join(path)).unwrap();
                    assert!(text.contains("\r\n"), "{}", case.id);
                    assert!(
                        !text.replace("\r\n", "").contains(['\r', '\n']),
                        "{}: source mutation changed unrelated line endings",
                        case.id
                    );
                }
            }
        }
        fixture.assert_no_effect();
    }
}

#[test]
fn every_before_analysis_corpus_case_refuses_through_the_real_profile() {
    check_source_mutations("\n");
}

fn rewrite_line_endings(directory: &Path, newline: &str) {
    for entry in fs::read_dir(directory).unwrap() {
        let entry = entry.unwrap();
        if entry.file_type().unwrap().is_dir() {
            rewrite_line_endings(&entry.path(), newline);
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
fn crlf_source_bytes_are_preserved_and_real_semantic_mutations_still_refuse() {
    let fixture = fixture();
    rewrite_line_endings(&fixture.root, "\r\n");
    let checked = fixture.analyze();
    let report = serde_json::to_value(checked.report()).unwrap();
    assert_scope(&report);
    assert_source_bytes(&fixture, &report, Some("\r\n"));
    checked.recheck().unwrap();
    check_source_mutations("\r\n");
}

#[test]
fn every_after_capture_case_refuses_the_original_checked_capture() {
    let corpus = corpus();
    let cases: Vec<_> = corpus
        .cases
        .iter()
        .filter(|case| case.phase == Phase::AfterCapture)
        .collect();
    assert!(!cases.is_empty());
    for case in cases {
        let fixture = fixture();
        let checked = fixture.analyze();
        apply(&fixture, case);
        let error = checked
            .recheck()
            .expect_err("changed inventory must refuse the original capture");
        assert_eq!(error.rule_id, "TLC309", "{}: {error}", case.id);
        assert!(!error.message.trim().is_empty(), "{}", case.id);
        assert!(!checked.report().storage_authority());
        fixture.assert_no_effect();
    }
}

#[test]
fn constructor_io_accepted_by_v5_is_refused_by_the_new_recipe_profile() {
    let corpus = corpus();
    let v5_binding = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/rust-facts/binding.json");
    for id in [
        "symbol-constructor-safe-write",
        "utc-constructor-safe-write",
    ] {
        let case = corpus.cases.iter().find(|case| case.id == id).unwrap();
        let fixture = fixture();
        apply(&fixture, case);
        let v5 = analyze(&fixture.root, &v5_binding).unwrap_or_else(|error| {
            panic!("{id}: constructor mutation leaves v5 representation valid: {error}")
        });
        assert!(v5.facts.iter().any(|fact| fact.name == "FundingFact"));
        refusal(
            analyze_codec_recipe(&fixture.root, &fixture.binding),
            &case.id,
        );
        fixture.assert_no_effect();
    }
}

#[test]
fn qualified_standard_variants_remain_resolved_with_colliding_value_parameters() {
    for name in ["Ok", "Err", "Result"] {
        let fixture = fixture();
        let path = fixture.root.join("crates/core/src/symbol.rs");
        let source = fs::read_to_string(&path).unwrap();
        let start = source.find("    pub fn new(").unwrap();
        let end = source[start..].find("\n    pub fn as_str").unwrap() + start;
        let constructor = source[start..end]
            .replace("raw", name)
            .replace("return Err(", "return std::result::Result::Err(")
            .replace("Ok(Self(", "std::result::Result::Ok(Self(");
        fs::write(
            &path,
            format!("{}{}{}", &source[..start], constructor, &source[end..]),
        )
        .unwrap();
        let checked = analyze_codec_recipe(&fixture.root, &fixture.binding).unwrap();
        assert!(!checked.report().storage_authority());
        checked.recheck().unwrap();
        fixture.assert_no_effect();
    }
}

#[test]
fn captured_free_function_reexport_aliases_do_not_become_trait_permissions() {
    let fixture = fixture();
    let path = fixture.root.join("crates/core/src/lib.rs");
    let source = fs::read_to_string(&path).unwrap();
    assert_eq!(source.matches("pub use time::expected_close;").count(), 1);
    fs::write(
        &path,
        source.replace(
            "pub use time::expected_close;",
            "pub use time::expected_close as close_at;",
        ),
    )
    .unwrap();
    let checked = analyze_codec_recipe(&fixture.root, &fixture.binding).unwrap();
    assert!(!checked.report().storage_authority());
    checked.recheck().unwrap();
    fixture.assert_no_effect();
}

#[test]
fn changed_binding_bytes_refuse_the_original_capture_without_restoring_authority() {
    let fixture = fixture();
    let checked = fixture.analyze();
    let mut content = fs::read_to_string(&fixture.binding).unwrap();
    content.push('\n');
    fs::write(&fixture.binding, content).unwrap();
    let error = checked.recheck().expect_err("binding bytes changed");
    assert_eq!(error.rule_id, "TLC309");
    assert!(!checked.report().storage_authority());
    fixture.assert_no_effect();
}

#[test]
fn selected_codec_and_wire_files_cannot_hide_extra_test_or_disabled_bodies() {
    for path in [
        "crates/collector/src/funding_codec.rs",
        "crates/collector/src/sgd_wire.rs",
    ] {
        for condition in ["test", "any()"] {
            let fixture = fixture();
            let source = fixture.root.join(path);
            let mut text = fs::read_to_string(&source).unwrap();
            text.push_str(&format!(
                "\n#[cfg({condition})]\nfn hidden_writer() {{\n    let _ = std::fs::write(\"{MARKER}\", b\"effect\");\n}}\n"
            ));
            fs::write(source, text).unwrap();
            let error = refusal(
                analyze_codec_recipe(&fixture.root, &fixture.binding),
                &format!("{path}: cfg({condition}) body"),
            );
            assert_eq!(error.file.as_deref(), Some(path));
            fixture.assert_no_effect();
        }
    }
}

#[test]
fn an_existing_extra_target_is_discovered_without_claiming_its_body_was_checked() {
    let fixture = fixture();
    let bin = fixture.root.join("crates/collector/src/bin/unbound.rs");
    fs::create_dir_all(bin.parent().unwrap()).unwrap();
    fs::write(
        &bin,
        "fn main() { let _ = std::fs::write(\"not-executed\", b\"effect\"); }\n",
    )
    .unwrap();
    let checked = fixture.analyze();
    let report = serde_json::to_value(checked.report()).unwrap();
    assert_scope(&report);
    assert!(report["discovery"]["localTargets"]
        .as_array()
        .unwrap()
        .iter()
        .any(
            |target| target["source"] == "crates/collector/src/bin/unbound.rs"
                && target["kind"] == "bin"
        ));
    checked.recheck().unwrap();
    fixture.assert_no_effect();
}
