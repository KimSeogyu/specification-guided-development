use sgd_rust_bindings::analyze_source_scope;
use std::fs;
use std::path::Path;

const MANIFEST: &str = r#"[package]
name = "source-scope-probe"
version = "0.0.0"
edition = "2021"

[workspace]
"#;
const LOCK: &str = r#"# This fixture is read by Cargo metadata and is never built.
version = 3

[[package]]
name = "source-scope-probe"
version = "0.0.0"
"#;
const LIBRARY: &str = r#"pub fn identity(value: i64) -> i64 { value }
pub fn marker() -> bool { true }
"#;
const MAIN: &str = r#"fn marker() -> i64 { 1 }
fn main() {
    let local: i64 = crate::marker();
    let library: bool = source_scope_probe::marker();
    let _ = local;
    let _ = library;
}
"#;
const PURE_BINARY: &str = r#"mod exports {
    pub use source_scope_probe::identity as copy;
}
fn main() {
    let copy: fn(i64) -> i64 = exports::copy;
    let value = copy(3);
    let _ = value;
}
"#;

fn write(root: &Path, relative: &str, content: &str) {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

fn fixture() -> tempfile::TempDir {
    let temp = tempfile::tempdir().unwrap();
    write(temp.path(), "Cargo.toml", MANIFEST);
    write(temp.path(), "Cargo.lock", LOCK);
    write(temp.path(), "src/lib.rs", LIBRARY);
    write(temp.path(), "src/main.rs", MAIN);
    write(temp.path(), "src/bin/pure.rs", PURE_BINARY);
    temp
}

fn rejects(root: &Path) -> String {
    match analyze_source_scope(root) {
        Ok(_) => panic!("unsupported source scope must be refused"),
        Err(error) => {
            assert_eq!(error.rule_id, "TLC308", "{error}");
            error.message
        }
    }
}

#[test]
fn pure_library_and_two_binaries_resolve_separate_roots_and_function_aliases() {
    let temp = fixture();
    let report = analyze_source_scope(temp.path()).unwrap();
    assert!(!report.storage_authority());
    let serialized = serde_json::to_value(&report).unwrap();
    assert_eq!(serialized["storageAuthority"], false);
    let text = serialized.to_string();
    assert!(
        text.contains("src/lib.rs"),
        "library source must be recorded"
    );
    assert!(text.contains("src/main.rs"), "main source must be recorded");
    assert!(
        text.contains("src/bin/pure.rs"),
        "automatic second binary source must be recorded"
    );
}

#[test]
fn a_local_function_named_write_is_not_a_filesystem_effect() {
    let temp = fixture();
    write(
        temp.path(),
        "src/bin/pure.rs",
        "fn write(value: i64) -> i64 { value + 1 }\nfn main() { let persist = write; let _ = persist(2); }\n",
    );
    assert!(!analyze_source_scope(temp.path())
        .unwrap()
        .storage_authority());
}

#[test]
fn local_module_imports_and_reexports_keep_the_defining_scope() {
    let temp = fixture();
    write(
        temp.path(),
        "src/bin/pure.rs",
        r#"mod outer {
    pub mod implementation {
        pub fn identity(value: i64) -> i64 { value }
    }
    pub use self::implementation::identity as copy;
}
use outer::copy as forwarded;
fn main() { let alias = forwarded; let _ = alias(3); }
"#,
    );
    assert!(!analyze_source_scope(temp.path())
        .unwrap()
        .storage_authority());
}

#[test]
fn an_explicit_renamed_local_dependency_is_checked_with_its_library_namespace() {
    let temp = fixture();
    write(
        temp.path(),
        "Cargo.toml",
        r#"[package]
name = "source-scope-probe"
version = "0.0.0"
edition = "2021"

[workspace]
members = ["crates/helper"]

[dependencies]
helper = { package = "scope-helper", path = "crates/helper" }
"#,
    );
    write(
        temp.path(),
        "Cargo.lock",
        r#"version = 3

[[package]]
name = "scope-helper"
version = "0.0.0"

[[package]]
name = "source-scope-probe"
version = "0.0.0"
dependencies = ["scope-helper"]
"#,
    );
    write(
        temp.path(),
        "crates/helper/Cargo.toml",
        "[package]\nname = \"scope-helper\"\nversion = \"0.0.0\"\nedition = \"2021\"\n",
    );
    write(
        temp.path(),
        "crates/helper/src/lib.rs",
        "pub fn identity(value: i64) -> i64 { value }\n",
    );
    write(
        temp.path(),
        "src/bin/pure.rs",
        "use helper::identity as copy;\nfn main() { let alias = copy; let _ = alias(3); }\n",
    );
    let report = analyze_source_scope(temp.path()).unwrap();
    assert!(!report.storage_authority());
    assert!(serde_json::to_string(&report)
        .unwrap()
        .contains("crates/helper/src/lib.rs"));
}

#[test]
fn a_new_automatic_binary_cannot_hide_a_reexported_filesystem_function_value() {
    let temp = fixture();
    assert!(!analyze_source_scope(temp.path())
        .unwrap()
        .storage_authority());
    write(
        temp.path(),
        "src/bin/aliased-writer.rs",
        r#"mod export { pub use std::fs::write as persist; }
fn main() {
    let writer: fn(&str, &[u8]) -> std::io::Result<()> = export::persist;
    let _ = writer("never-executed", b"probe");
}
"#,
    );
    let message = rejects(temp.path());
    assert!(message.contains("std::fs::write"), "{message}");
    assert!(
        !temp.path().join("never-executed").exists(),
        "source analysis must not execute the fixture"
    );
}

#[test]
fn direct_and_imported_filesystem_references_keep_canonical_identity() {
    for body in [
        "fn main() { let writer = std::fs::write; }",
        "use std::fs::write as persist; fn main() { let writer = persist; }",
        "fn main() { let _ = std::fs::write(\"never-executed\", b\"probe\"); }",
    ] {
        let temp = fixture();
        write(temp.path(), "src/bin/pure.rs", body);
        let message = rejects(temp.path());
        assert!(message.contains("std::fs::write"), "{message}");
        assert!(!temp.path().join("never-executed").exists());
    }
}

#[test]
fn unsupported_value_dispatch_and_lifecycle_cannot_be_declared_pure() {
    for source in [
        // Receiver dispatch can resolve to user traits or other effectful code.
        "fn main() { let value = 1i64; let _ = value.abs(); }",
        "fn main() { println!(\"unknown expansion\"); }",
        "trait Callback { fn run(&self); } fn main() {}",
        "struct Opaque; fn main() {}",
        "fn invoke(callback: fn(i64) -> i64) -> i64 { callback(1) } fn main() {}",
        "fn identity(value: i64) -> i64 { value } fn main() { let mut alias = identity; let _ = alias(1); }",
        "fn main() { let foreign = std::mem::drop; }",
        "fn main() { let action = || 1; let _ = action(); }",
        "fn main() { unsafe { let _ = 1; } }",
    ] {
        let temp = fixture();
        write(temp.path(), "src/bin/pure.rs", source);
        rejects(temp.path());
    }
}

#[test]
fn reserved_roots_and_primitive_names_cannot_spoof_admitted_identities() {
    for source in [
        "mod std { pub mod fs { pub fn write(value: i64) -> i64 { value } } } fn main() {}",
        "mod core {} fn main() {}",
        "mod r#std {} fn main() {}",
        "fn identity(r#i64: i64) -> i64 { r#i64 } fn main() {}",
        "mod alloc {} fn main() {}",
        "type i64 = bool; fn main() {}",
    ] {
        let temp = fixture();
        write(temp.path(), "src/bin/pure.rs", source);
        rejects(temp.path());
    }
}

#[test]
fn conditional_and_macro_source_views_are_explicit_refusals() {
    for source in [
        "#[cfg(any())] fn hidden() {} fn main() {}",
        "fn hidden(_: [i64; #[cfg(any())] 1]) {} fn main() {}",
        "fn main() { let _ = [1; #[unknown_attribute] 2]; }",
        "#[cfg(test)] fn hidden() {} fn main() {}",
        "#[cfg_attr(any(), inline)] fn hidden() {} fn main() {}",
        "macro_rules! hidden { () => { fn extra() {} } } fn main() {}",
        "#[unknown_attribute] fn hidden() {} fn main() {}",
    ] {
        let temp = fixture();
        write(temp.path(), "src/bin/pure.rs", source);
        rejects(temp.path());
    }
}

#[test]
fn unsupported_cargo_views_are_refused_before_analysis() {
    for addition in [
        "\n[features]\noptional = []\n",
        "\n[dependencies]\nunknown = \"1\"\n",
        "\n[patch.crates-io]\nunknown = { path = \"untrusted\" }\n",
    ] {
        let temp = fixture();
        write(temp.path(), "Cargo.toml", &format!("{MANIFEST}{addition}"));
        rejects(temp.path());
    }

    let build = fixture();
    write(build.path(), "build.rs", "fn main() {}\n");
    rejects(build.path());

    let proc_macro = fixture();
    write(
        proc_macro.path(),
        "Cargo.toml",
        &format!("{MANIFEST}\n[lib]\nproc-macro = true\n"),
    );
    rejects(proc_macro.path());
}

#[test]
fn cargo_overrides_and_ambiguous_configuration_are_refused() {
    for content in [
        "[env]\nRUSTC_WRAPPER = \"never-executed\"\n",
        "[build]\nrustc-wrapper = \"never-executed\"\n",
        "[source.crates-io]\nreplace-with = \"untrusted\"\n",
    ] {
        let temp = fixture();
        write(temp.path(), ".cargo/config.toml", content);
        rejects(temp.path());
    }
    let temp = fixture();
    write(temp.path(), ".cargo/config", "[alias]\nprobe = \"check\"\n");
    write(
        temp.path(),
        ".cargo/config.toml",
        "[alias]\nprobe = \"check\"\n",
    );
    rejects(temp.path());
}

#[test]
fn uniquely_resolved_file_modules_are_checked_and_ambiguous_layouts_refuse() {
    let temp = fixture();
    write(
        temp.path(),
        "src/lib.rs",
        "mod scalar; pub use scalar::identity; pub fn marker() -> bool { true }\n",
    );
    write(
        temp.path(),
        "src/scalar.rs",
        "pub fn identity(value: i64) -> i64 { value }\n",
    );
    assert!(!analyze_source_scope(temp.path())
        .unwrap()
        .storage_authority());
    write(
        temp.path(),
        "src/scalar/mod.rs",
        "pub fn identity(value: i64) -> i64 { value }\n",
    );
    rejects(temp.path());
}

#[test]
fn private_and_unreachable_items_are_still_part_of_the_source_scope() {
    let temp = fixture();
    write(
        temp.path(),
        "src/lib.rs",
        &format!("{LIBRARY}\nfn unused() {{ let writer = std::fs::write; }}\n"),
    );
    let message = rejects(temp.path());
    assert!(message.contains("std::fs::write"), "{message}");
}

#[test]
fn cli_keeps_source_evidence_and_legacy_diagnostics_separate() {
    let temp = fixture();
    let binary = env!("CARGO_BIN_EXE_sgd-rust-bindings");
    let result = std::process::Command::new(binary)
        .args(["source-scope", "--root"])
        .arg(temp.path())
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(report["storageAuthority"], false);
    assert_eq!(
        report["scope"],
        "all-discovered-targets-unconditional-closed-source"
    );
    write(
        temp.path(),
        "src/bin/pure.rs",
        "fn main() { let writer = std::fs::write; }\n",
    );
    let refused = std::process::Command::new(binary)
        .args(["source-scope", "--root"])
        .arg(temp.path())
        .output()
        .unwrap();
    assert_eq!(refused.status.code(), Some(2));
    assert!(refused.stdout.is_empty());
    let diagnostic: serde_json::Value = serde_json::from_slice(&refused.stderr).unwrap();
    assert_eq!(diagnostic["ruleId"], "TLC308");
    assert_eq!(diagnostic["storageAuthority"], false);
    assert!(diagnostic["message"]
        .as_str()
        .unwrap()
        .contains("std::fs::write"));
    let legacy = std::process::Command::new(binary)
        .args(["--unknown", "value"])
        .output()
        .unwrap();
    assert_eq!(legacy.status.code(), Some(2));
    let diagnostic: serde_json::Value = serde_json::from_slice(&legacy.stderr).unwrap();
    assert_eq!(diagnostic["ruleId"], "TLC305");
    assert!(diagnostic.get("storageAuthority").is_none());
}

#[cfg(unix)]
#[test]
fn unsafe_local_cargo_configuration_is_refused_before_cargo_starts() {
    use std::os::unix::fs::PermissionsExt;
    let temp = fixture();
    let runner = tempfile::tempdir().unwrap();
    let cargo = runner.path().join("cargo");
    fs::write(
        &cargo,
        "#!/bin/sh\nprintf invoked > \"$SGD_SOURCE_SCOPE_MARKER\"\nexit 91\n",
    )
    .unwrap();
    fs::set_permissions(&cargo, fs::Permissions::from_mode(0o700)).unwrap();
    let marker = runner.path().join("cargo-started");
    write(
        temp.path(),
        ".cargo/config.toml",
        "[build]\nrustc-wrapper='must-not-run'\n",
    );
    let invoke = || {
        std::process::Command::new(env!("CARGO_BIN_EXE_sgd-rust-bindings"))
            .args(["source-scope", "--root"])
            .arg(temp.path())
            .env("PATH", runner.path())
            .env("SGD_SOURCE_SCOPE_MARKER", &marker)
            .output()
            .unwrap()
    };
    let result = invoke();
    assert_eq!(result.status.code(), Some(2));
    assert!(
        !marker.exists(),
        "local configuration must be admitted before any Cargo process starts"
    );
    let error: serde_json::Value = serde_json::from_slice(&result.stderr).unwrap();
    assert_eq!(error["ruleId"], "TLC308");
    fs::remove_file(temp.path().join(".cargo/config.toml")).unwrap();
    let result = invoke();
    assert_eq!(result.status.code(), Some(2));
    assert!(
        marker.exists(),
        "the valid preflight must reach the injected test-only Cargo runner"
    );
}

#[test]
fn rustdoc_executables_cannot_hide_in_documentation_attributes() {
    for source in [
        "/// ```rust\n/// std::fs::write(\"never-executed\", b\"probe\").unwrap();\n/// ```\npub fn hidden() {}\nfn main() {}\n",
        "///     std::fs::write(\"never-executed\", b\"probe\").unwrap();\npub fn hidden() {}\nfn main() {}\n",
        "#![doc = \"```rust\\nstd::fs::write(\\\"never-executed\\\", b\\\"probe\\\").unwrap();\\n```\"]\nfn main() {}\n",
        "/// Plain documentation is refused until a complete rustdoc view is admitted.\npub fn hidden() {}\nfn main() {}\n",
    ] {
        let temp = fixture();
        write(temp.path(), "src/bin/pure.rs", source);
        let message = rejects(temp.path());
        assert!(message.contains("attribute/source view"), "{message}");
        assert!(!temp.path().join("never-executed").exists());
    }
}
