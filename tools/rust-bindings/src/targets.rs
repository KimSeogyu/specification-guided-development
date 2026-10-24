use crate::{Error, Result, SourceIdentity};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use toml_edit::{DocumentMut, Item};

const MAX_FILES: usize = 512;
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 32 * 1024 * 1024;
const MAX_METADATA_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Target {
    pub package_id: String,
    pub name: String,
    pub kind: String,
    pub crate_name: String,
    pub source: PathBuf,
    pub externs: BTreeMap<String, usize>,
}

pub(crate) struct CargoScope {
    pub targets: Vec<Target>,
    root: PathBuf,
    requested_root: PathBuf,
    snapshot: Snapshot,
    discovery: serde_json::Value,
}

#[derive(Default)]
struct Snapshot {
    reads: BTreeMap<PathBuf, (String, String)>,
    probes: BTreeMap<PathBuf, bool>,
    bytes: usize,
}

#[derive(Clone)]
struct Dependency {
    manifest: PathBuf,
    package: String,
    kind: Option<String>,
}

struct Package {
    name: String,
    dependencies: BTreeMap<String, Dependency>,
}

struct Preflight {
    packages: BTreeMap<PathBuf, Package>,
    members: BTreeSet<PathBuf>,
    manifests: BTreeSet<PathBuf>,
}

#[derive(Deserialize)]
struct Metadata {
    version: u32,
    workspace_root: PathBuf,
    workspace_members: Vec<String>,
    packages: Vec<MetadataPackage>,
    resolve: Option<Resolve>,
}

#[derive(Deserialize)]
struct MetadataPackage {
    id: String,
    name: String,
    manifest_path: PathBuf,
    source: Option<String>,
    features: BTreeMap<String, serde_json::Value>,
    dependencies: Vec<MetadataDependency>,
    targets: Vec<MetadataTarget>,
}

#[derive(Deserialize)]
struct MetadataDependency {
    name: String,
    rename: Option<String>,
    kind: Option<String>,
    source: Option<String>,
    path: Option<PathBuf>,
    optional: bool,
    features: Vec<String>,
    target: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct MetadataTarget {
    name: String,
    kind: Vec<String>,
    crate_types: Vec<String>,
    src_path: PathBuf,
    edition: String,
    #[serde(rename = "required-features", default)]
    required_features: Vec<String>,
}

#[derive(Deserialize)]
struct Resolve {
    nodes: Vec<Node>,
}

#[derive(Deserialize)]
struct Node {
    id: String,
    dependencies: Vec<String>,
    deps: Vec<NodeDependency>,
    features: Vec<String>,
}

#[derive(Deserialize)]
struct NodeDependency {
    name: String,
    pkg: String,
    dep_kinds: Vec<DependencyKind>,
}

#[derive(Deserialize)]
struct DependencyKind {
    kind: Option<String>,
    target: Option<serde_json::Value>,
}

impl CargoScope {
    pub(crate) fn capture(root: &Path) -> Result<Self> {
        let requested_root = if root.is_absolute() {
            root.to_path_buf()
        } else {
            std::env::current_dir()
                .map_err(|e| Error::scope(format!("cannot read working directory: {e}")))?
                .join(root)
        };
        let root = requested_root
            .canonicalize()
            .map_err(|e| Error::scope(format!("cannot resolve source-scope root: {e}")))?;
        if !root.is_dir() {
            return Err(Error::scope("source-scope root must be a directory"));
        }
        let mut snapshot = Snapshot::default();
        let preflight = Preflight::capture(&root, &mut snapshot)?;
        ensure_root(&root, &requested_root)?;
        snapshot.verify(&root)?;
        let discovery = cargo_metadata(&root)?;
        ensure_root(&root, &requested_root)?;
        snapshot.verify(&root)?;
        let mut metadata: Metadata = serde_json::from_value(discovery.clone())
            .map_err(|e| Error::scope(format!("unsupported Cargo metadata schema: {e}")))?;
        capture_metadata_paths(&root, &mut metadata)?;
        let targets = validate_metadata(&root, &preflight, metadata)?;
        for target in &targets {
            snapshot.read(&root, &target.source)?;
        }
        Ok(Self {
            targets,
            root,
            requested_root,
            snapshot,
            discovery,
        })
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn read_source(&mut self, path: &Path) -> Result<(String, String)> {
        let relative = relative(&self.root, path)?;
        let text = self.snapshot.read(&self.root, path)?;
        Ok((relative, text))
    }

    pub(crate) fn probe(&mut self, path: &Path) -> Result<bool> {
        self.snapshot.probe(&self.root, path)
    }

    pub(crate) fn identities(&self) -> Vec<SourceIdentity> {
        self.snapshot
            .reads
            .iter()
            .map(|(path, (_, sha256))| SourceIdentity {
                path: relative(&self.root, path).expect("captured paths stay inside root"),
                sha256: sha256.clone(),
            })
            .collect()
    }

    pub(crate) fn recheck(&self) -> Result<()> {
        ensure_root(&self.root, &self.requested_root)?;
        self.snapshot.verify(&self.root)?;
        // Capture repeats preflight before invoking Cargo, including absent config
        // and toolchain probes. It never reuses an unchecked discovery command.
        let fresh = Self::capture(&self.requested_root)?;
        if fresh.root != self.root
            || fresh.targets != self.targets
            || fresh.discovery != self.discovery
        {
            return Err(Error::scope(
                "Cargo target or dependency discovery changed during source-scope analysis",
            ));
        }
        self.snapshot.verify(&self.root)
    }
}

fn relative(root: &Path, path: &Path) -> Result<String> {
    let relative = path.strip_prefix(root).map_err(|_| {
        Error::scope(format!(
            "source-scope path escapes the application root: path={path:?}, captured root={root:?}"
        ))
    })?;
    if relative.as_os_str().is_empty() {
        return Err(Error::scope(
            "source-scope paths require ordinary relative components",
        ));
    }
    let mut parts = Vec::new();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err(Error::scope(
                "source-scope paths require ordinary relative components",
            ));
        };
        let name = name
            .to_str()
            .ok_or_else(|| Error::scope("source-scope paths must be UTF-8"))?;
        if name.contains('\\') {
            return Err(Error::scope(
                "literal backslashes in source-scope file names are unsupported",
            ));
        }
        parts.push(name);
    }
    Ok(parts.join("/"))
}

fn joined(root: &Path, base: &Path, value: &str) -> Result<PathBuf> {
    if value.is_empty() || Path::new(value).is_absolute() || value.contains('\\') {
        return Err(Error::scope(
            "Cargo source paths must be nonempty relative paths",
        ));
    }
    let mut path = base.to_path_buf();
    for component in Path::new(value).components() {
        match component {
            Component::Normal(name) => path.push(name),
            Component::CurDir => {}
            Component::ParentDir if path != root && path.pop() => {}
            _ => {
                return Err(Error::scope(
                    "Cargo source path escapes the application root",
                ))
            }
        }
    }
    if path != root {
        relative(root, &path)?;
    }
    Ok(path)
}

fn ensure_root(root: &Path, requested: &Path) -> Result<()> {
    let current = requested
        .canonicalize()
        .map_err(|e| Error::scope(format!("source-scope root changed: {e}")))?;
    let info = fs::symlink_metadata(root)
        .map_err(|e| Error::scope(format!("source-scope root changed: {e}")))?;
    if current != root || !info.is_dir() || info.file_type().is_symlink() {
        return Err(Error::scope(
            "source-scope root alias changed during analysis",
        ));
    }
    Ok(())
}

fn file_info(root: &Path, path: &Path) -> Result<Option<fs::Metadata>> {
    let name = relative(root, path)?;
    let mut current = root.to_path_buf();
    let components: Vec<_> = path.strip_prefix(root).unwrap().components().collect();
    for (index, component) in components.iter().enumerate() {
        current.push(component);
        let info = match fs::symlink_metadata(&current) {
            Ok(info) => info,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(Error::scope(format!("cannot inspect {name}: {error}"))),
        };
        if info.file_type().is_symlink() {
            return Err(Error::scope(format!(
                "{name}: source-scope symlinks are unsupported"
            )));
        }
        if index + 1 == components.len() {
            if !info.is_file() || info.len() > MAX_FILE_BYTES {
                return Err(Error::scope(format!(
                    "{name}: source-scope input must be a regular file no larger than 4 MiB"
                )));
            }
            return Ok(Some(info));
        }
        if !info.is_dir() {
            return Err(Error::scope(format!(
                "{name}: source-scope parent is not a directory"
            )));
        }
    }
    unreachable!("relative paths contain a file component")
}

fn read_current(root: &Path, path: &Path) -> Result<Option<String>> {
    if file_info(root, path)?.is_none() {
        return Ok(None);
    }
    let name = relative(root, path)?;
    let file =
        fs::File::open(path).map_err(|e| Error::scope(format!("cannot read {name}: {e}")))?;
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| Error::scope(format!("cannot read {name}: {e}")))?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(Error::scope(format!(
            "{name}: source-scope input exceeds 4 MiB"
        )));
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| Error::scope(format!("{name}: source-scope input must be UTF-8")))
}

impl Snapshot {
    fn probe(&mut self, root: &Path, path: &Path) -> Result<bool> {
        if let Some(present) = self.probes.get(path) {
            return Ok(*present);
        }
        let text = read_current(root, path)?;
        let present = text.is_some();
        self.probes.insert(path.to_path_buf(), present);
        if let Some(text) = text {
            self.insert(path, text)?;
        }
        if self.probes.len() > MAX_FILES * 4 {
            return Err(Error::scope(
                "source-scope existence probes exceed the supported limit",
            ));
        }
        Ok(present)
    }

    fn read(&mut self, root: &Path, path: &Path) -> Result<String> {
        if let Some((text, _)) = self.reads.get(path) {
            return Ok(text.clone());
        }
        if self.probes.get(path) == Some(&false) {
            return Err(Error::scope(format!(
                "{} appeared after an absent-source probe",
                relative(root, path)?
            )));
        }
        let text = read_current(root, path)?.ok_or_else(|| {
            Error::scope(format!("{}: source-scope input is absent", path.display()))
        })?;
        self.probes.insert(path.to_path_buf(), true);
        self.insert(path, text.clone())?;
        Ok(text)
    }

    fn insert(&mut self, path: &Path, text: String) -> Result<()> {
        if self.reads.contains_key(path) {
            return Ok(());
        }
        if self.reads.len() >= MAX_FILES || self.bytes + text.len() > MAX_TOTAL_BYTES {
            return Err(Error::scope(
                "source-scope input closure exceeds the supported file or byte limit",
            ));
        }
        self.bytes += text.len();
        let digest = Sha256::digest(text.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        self.reads.insert(path.to_path_buf(), (text, digest));
        Ok(())
    }

    fn verify(&self, root: &Path) -> Result<()> {
        for (path, present) in &self.probes {
            let current = read_current(root, path)?;
            if current.is_some() != *present
                || self
                    .reads
                    .get(path)
                    .is_some_and(|(before, _)| current.as_ref() != Some(before))
            {
                return Err(Error::scope(format!(
                    "{} changed during source-scope analysis",
                    relative(root, path)?
                )));
            }
        }
        Ok(())
    }
}

impl Preflight {
    fn capture(root: &Path, snapshot: &mut Snapshot) -> Result<Self> {
        let mut scope = Self {
            packages: BTreeMap::new(),
            members: BTreeSet::new(),
            manifests: BTreeSet::new(),
        };
        scope.manifest(root, &root.join("Cargo.toml"), true, snapshot)?;
        let lock = root.join("Cargo.lock");
        if !snapshot.probe(root, &lock)? {
            return Err(Error::scope(
                "source-scope discovery requires an existing Cargo.lock",
            ));
        }
        snapshot
            .read(root, &lock)?
            .parse::<DocumentMut>()
            .map_err(|e| Error::scope(format!("unsupported Cargo.lock: {e}")))?;
        Ok(scope)
    }

    fn manifest(
        &mut self,
        root: &Path,
        path: &Path,
        workspace_root: bool,
        snapshot: &mut Snapshot,
    ) -> Result<()> {
        if !self.manifests.insert(path.to_path_buf()) {
            return Ok(());
        }
        if self.manifests.len() > 128 {
            return Err(Error::scope(
                "source-scope manifest closure exceeds 128 files",
            ));
        }
        let directory = path
            .parent()
            .ok_or_else(|| Error::scope("Cargo manifest has no parent"))?;
        check_configs(root, directory, snapshot)?;
        let text = snapshot.read(root, path)?;
        let name = relative(root, path)?;
        let document = text
            .parse::<DocumentMut>()
            .map_err(|e| Error::scope(format!("{name}: unsupported Cargo manifest: {e}")))?;
        if document.get("patch").is_some() || document.get("replace").is_some() {
            return Err(Error::scope(format!(
                "{name}: Cargo patch/replace overrides are unsupported"
            )));
        }
        if document.get("target").is_some_and(nonempty)
            || document.get("features").is_some_and(nonempty)
            || document.get("build-dependencies").is_some_and(nonempty)
        {
            return Err(Error::scope(format!("{name}: conditional dependencies, features, and build dependencies are unsupported")));
        }
        if let Some(workspace) = document.get("workspace") {
            if !workspace_root {
                return Err(Error::scope(format!(
                    "{name}: nested workspaces are unsupported"
                )));
            }
            for field in ["exclude", "default-members", "dependencies"] {
                if workspace.get(field).is_some_and(nonempty) {
                    return Err(Error::scope(format!(
                        "{name}: workspace.{field} is unsupported"
                    )));
                }
            }
            if let Some(members) = workspace.get("members") {
                let members = members.as_array().ok_or_else(|| {
                    Error::scope("workspace.members must be an array of exact paths")
                })?;
                for member in members {
                    let member = member.as_str().ok_or_else(|| {
                        Error::scope("workspace.members must contain literal paths")
                    })?;
                    if member.contains(['*', '?', '[', ']', '{', '}']) {
                        return Err(Error::scope("workspace member globs are unsupported"));
                    }
                    let manifest = joined(root, directory, member)?.join("Cargo.toml");
                    self.members.insert(manifest.clone());
                    self.manifest(root, &manifest, false, snapshot)?;
                }
            }
        }
        let Some(package) = document.get("package") else {
            if !workspace_root || document.get("workspace").is_none() {
                return Err(Error::scope(format!(
                    "{name}: expected a package or root workspace"
                )));
            }
            return Ok(());
        };
        let package_name = package
            .get("name")
            .and_then(Item::as_str)
            .ok_or_else(|| Error::scope(format!("{name}: package.name must be literal")))?
            .to_owned();
        if !identifier(&package_name.replace('-', "_")) {
            return Err(Error::scope(format!("{name}: unsupported package name")));
        }
        if package.get("workspace").is_some()
            || package.get("links").is_some()
            || package.get("metabuild").is_some()
        {
            return Err(Error::scope(format!(
                "{name}: workspace redirection and build integration are unsupported"
            )));
        }
        if package
            .get("build")
            .is_some_and(|item| item.as_bool() != Some(false))
            || snapshot.probe(root, &directory.join("build.rs"))?
            || document
                .get("lib")
                .and_then(|lib| lib.get("proc-macro"))
                .is_some_and(|item| item.as_bool() != Some(false))
        {
            return Err(Error::scope(format!(
                "{name}: build scripts and procedural macro targets are unsupported"
            )));
        }
        if workspace_root {
            self.members.insert(path.to_path_buf());
        }
        check_target_declarations(root, directory, &document, snapshot)?;
        let mut dependencies = BTreeMap::new();
        for (section, kind) in [("dependencies", None), ("dev-dependencies", Some("dev"))] {
            if let Some(table) = document.get(section) {
                let table = table.as_table_like().ok_or_else(|| {
                    Error::scope(format!("{name}: dependency declarations must be tables"))
                })?;
                for (alias, item) in table.iter() {
                    let declaration = item.as_table_like().ok_or_else(|| {
                        Error::scope(format!(
                            "{name}: only explicit local path dependencies are supported"
                        ))
                    })?;
                    if declaration.iter().any(|(key, _)| {
                        !matches!(
                            key,
                            "path"
                                | "package"
                                | "version"
                                | "features"
                                | "default-features"
                                | "optional"
                        )
                    }) || item.get("features").is_some_and(nonempty)
                        || item
                            .get("optional")
                            .is_some_and(|value| value.as_bool() != Some(false))
                    {
                        return Err(Error::scope(format!("{name}: inherited, foreign, optional, and feature dependencies are unsupported")));
                    }
                    let dependency_path =
                        item.get("path").and_then(Item::as_str).ok_or_else(|| {
                            Error::scope(format!(
                                "{name}: only explicit local path dependencies are supported"
                            ))
                        })?;
                    let manifest = joined(root, directory, dependency_path)?.join("Cargo.toml");
                    let original_alias = alias;
                    let alias = original_alias.replace('-', "_");
                    if !identifier(&alias)
                        || matches!(alias.as_str(), "std" | "core" | "alloc")
                        || dependencies.contains_key(&alias)
                    {
                        return Err(Error::scope(format!(
                            "{name}: ambiguous or reserved dependency alias {alias}"
                        )));
                    }
                    let package = item
                        .get("package")
                        .and_then(Item::as_str)
                        .map(str::to_owned)
                        .unwrap_or_else(|| original_alias.to_owned());
                    dependencies.insert(
                        alias,
                        Dependency {
                            manifest,
                            package,
                            kind: kind.map(str::to_owned),
                        },
                    );
                }
            }
        }
        self.packages.insert(
            path.to_path_buf(),
            Package {
                name: package_name,
                dependencies: dependencies.clone(),
            },
        );
        for dependency in dependencies.values() {
            self.manifest(root, &dependency.manifest, false, snapshot)?;
        }
        Ok(())
    }
}

fn nonempty(item: &Item) -> bool {
    if let Some(array) = item.as_array() {
        return !array.is_empty();
    }
    item.as_table_like().is_none_or(|table| !table.is_empty())
}

fn identifier(text: &str) -> bool {
    let mut chars = text.chars();
    chars
        .next()
        .is_some_and(|c| c == '_' || c.is_ascii_alphabetic())
        && chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
}

fn check_configs(root: &Path, directory: &Path, snapshot: &mut Snapshot) -> Result<()> {
    let mut directory = directory.to_path_buf();
    loop {
        let legacy = directory.join(".cargo/config");
        let modern = directory.join(".cargo/config.toml");
        let legacy_exists = snapshot.probe(root, &legacy)?;
        let modern_exists = snapshot.probe(root, &modern)?;
        if legacy_exists && modern_exists {
            return Err(Error::scope("both local Cargo config names exist"));
        }
        for (path, present) in [(legacy, legacy_exists), (modern, modern_exists)] {
            if present {
                let document = snapshot
                    .read(root, &path)?
                    .parse::<DocumentMut>()
                    .map_err(|e| {
                        Error::scope(format!("unsupported local Cargo configuration: {e}"))
                    })?;
                if document.iter().any(|(key, _)| key != "alias") {
                    return Err(Error::scope(
                        "only alias-only local Cargo configuration is supported",
                    ));
                }
            }
        }
        for file in ["rust-toolchain", "rust-toolchain.toml"] {
            if snapshot.probe(root, &directory.join(file))? {
                return Err(Error::scope(
                    "local Rust toolchain overrides are unsupported",
                ));
            }
        }
        if directory == root {
            return Ok(());
        }
        if !directory.pop() || !directory.starts_with(root) {
            return Err(Error::scope(
                "Cargo configuration ancestry escaped the root",
            ));
        }
    }
}

fn check_target_declarations(
    root: &Path,
    directory: &Path,
    document: &DocumentMut,
    snapshot: &mut Snapshot,
) -> Result<()> {
    let mut declarations = Vec::new();
    if let Some(lib) = document.get("lib") {
        declarations.push(lib);
    }
    for kind in ["bin", "test", "example", "bench"] {
        if let Some(item) = document.get(kind) {
            let targets = item.as_array_of_tables().ok_or_else(|| {
                Error::scope(format!(
                    "Cargo {kind} targets must use array-of-table declarations"
                ))
            })?;
            for target in targets {
                if target.get("required-features").is_some_and(nonempty) {
                    return Err(Error::scope(
                        "targets with required features are unsupported",
                    ));
                }
                if let Some(path) = target.get("path") {
                    let path = path
                        .as_str()
                        .ok_or_else(|| Error::scope("target paths must be literal"))?;
                    snapshot.probe(root, &joined(root, directory, path)?)?;
                }
            }
        }
    }
    for declaration in declarations {
        if declaration.get("required-features").is_some_and(nonempty) {
            return Err(Error::scope(
                "targets with required features are unsupported",
            ));
        }
        if let Some(path) = declaration.get("path") {
            let path = path
                .as_str()
                .ok_or_else(|| Error::scope("target paths must be literal"))?;
            snapshot.probe(root, &joined(root, directory, path)?)?;
        }
    }
    Ok(())
}

fn cargo_metadata(root: &Path) -> Result<serde_json::Value> {
    let mut child = Command::new("cargo")
        .args([
            "metadata",
            "--offline",
            "--locked",
            "--format-version",
            "1",
            "--manifest-path",
        ])
        .arg(root.join("Cargo.toml"))
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| Error::scope(format!("cannot run trusted Cargo metadata: {e}")))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| Error::scope("Cargo stdout is unavailable"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| Error::scope("Cargo stderr is unavailable"))?;
    let output_thread = std::thread::spawn(move || read_pipe(stdout, MAX_METADATA_BYTES));
    let error_thread = std::thread::spawn(move || read_pipe(stderr, 1024 * 1024));
    let status = child
        .wait()
        .map_err(|e| Error::scope(format!("cannot wait for Cargo metadata: {e}")))?;
    let stdout = output_thread
        .join()
        .map_err(|_| Error::scope("Cargo metadata output reader failed"))??;
    let stderr = error_thread
        .join()
        .map_err(|_| Error::scope("Cargo metadata error reader failed"))??;
    if !status.success() {
        let message = String::from_utf8_lossy(&stderr);
        return Err(Error::scope(format!(
            "offline locked Cargo metadata refused the source scope: {}",
            message.trim()
        )));
    }
    serde_json::from_slice(&stdout)
        .map_err(|e| Error::scope(format!("Cargo metadata returned invalid JSON: {e}")))
}

fn read_pipe(pipe: impl Read, limit: u64) -> Result<Vec<u8>> {
    let mut output = Vec::new();
    pipe.take(limit + 1)
        .read_to_end(&mut output)
        .map_err(|e| Error::scope(format!("cannot read Cargo metadata output: {e}")))?;
    if output.len() as u64 > limit {
        return Err(Error::scope(
            "Cargo metadata output exceeded the supported byte limit",
        ));
    }
    Ok(output)
}

fn capture_metadata_paths(root: &Path, metadata: &mut Metadata) -> Result<()> {
    if !dependency_directory_matches(&metadata.workspace_root, root) {
        return Err(Error::scope(format!(
            "Cargo workspace_root identity differs from captured root: reported path={:?}, captured root={root:?}",
            metadata.workspace_root,
        )));
    }
    metadata.workspace_root = root.to_path_buf();
    for package in &mut metadata.packages {
        package.manifest_path =
            capture_metadata_file(root, &package.manifest_path, "packages[].manifest_path")?;
        for target in &mut package.targets {
            target.src_path =
                capture_metadata_file(root, &target.src_path, "packages[].targets[].src_path")?;
        }
        // dependencies[].path is an identity comparison against an already
        // checked preflight directory. Retain its raw spelling for diagnostics;
        // it is never used for filesystem reads.
    }
    Ok(())
}

fn capture_metadata_file(root: &Path, reported: &Path, field: &str) -> Result<PathBuf> {
    if relative(root, reported).is_ok() {
        return Ok(reported.to_path_buf());
    }
    #[cfg(windows)]
    if let Some(rebased) = windows_rebase_metadata_path(root, reported) {
        relative(root, &rebased)?;
        return Ok(rebased);
    }
    Err(Error::scope(format!(
        "Cargo {field} cannot be represented inside the captured source root: reported path={reported:?}, captured root={root:?}; only checked ordinary components and equivalent Windows disk/UNC prefix transport are supported"
    )))
}

fn validate_metadata(
    root: &Path,
    preflight: &Preflight,
    metadata: Metadata,
) -> Result<Vec<Target>> {
    if metadata.version != 1 || metadata.workspace_root != root {
        return Err(Error::scope(
            "Cargo metadata workspace identity is outside the captured root",
        ));
    }
    let mut packages = BTreeMap::new();
    let mut ids = BTreeMap::new();
    for package in &metadata.packages {
        relative(root, &package.manifest_path)?;
        let declared = preflight
            .packages
            .get(&package.manifest_path)
            .ok_or_else(|| {
                Error::scope("Cargo discovered a package outside the preflight closure")
            })?;
        if package.source.is_some()
            || !package.features.is_empty()
            || package.name != declared.name
            || packages
                .insert(package.manifest_path.clone(), package)
                .is_some()
            || ids.insert(package.id.clone(), package).is_some()
        {
            return Err(Error::scope(
                "Cargo discovered a foreign, ambiguous, or feature-dependent package",
            ));
        }
        validate_dependencies(root, declared, package)?;
    }
    if packages.len() != preflight.packages.len() {
        return Err(Error::scope(
            "Cargo omitted a package from the preflight closure",
        ));
    }
    let members: BTreeSet<_> = metadata
        .workspace_members
        .iter()
        .map(|id| {
            ids.get(id)
                .map(|package| package.manifest_path.clone())
                .ok_or_else(|| Error::scope("Cargo workspace member identity is unresolved"))
        })
        .collect::<Result<_>>()?;
    if !preflight.members.is_subset(&members) {
        return Err(Error::scope(
            "Cargo workspace membership differs from the declared members",
        ));
    }
    let resolve = metadata
        .resolve
        .ok_or_else(|| Error::scope("Cargo omitted the resolved dependency graph"))?;
    let mut resolved = BTreeSet::new();
    for node in resolve.nodes {
        let package = ids
            .get(&node.id)
            .ok_or_else(|| Error::scope("Cargo resolve graph contains an unknown package"))?;
        if !resolved.insert(node.id) || !node.features.is_empty() {
            return Err(Error::scope(
                "Cargo resolve graph is ambiguous or feature-dependent",
            ));
        }
        let declared = &preflight.packages[&package.manifest_path];
        let mut actual = BTreeMap::new();
        for dependency in node.deps {
            if dependency.dep_kinds.is_empty()
                || dependency
                    .dep_kinds
                    .iter()
                    .any(|kind| kind.target.is_some())
            {
                return Err(Error::scope(
                    "Cargo resolve graph has an unsupported dependency view",
                ));
            }
            let kinds: BTreeSet<_> = dependency
                .dep_kinds
                .into_iter()
                .map(|kind| kind.kind)
                .collect();
            if actual
                .insert(dependency.name, (dependency.pkg, kinds))
                .is_some()
            {
                return Err(Error::scope(
                    "Cargo resolve dependency aliases are ambiguous",
                ));
            }
        }
        let mut expected = BTreeMap::new();
        for (alias, dependency) in &declared.dependencies {
            let id = packages
                .get(&dependency.manifest)
                .ok_or_else(|| Error::scope("local dependency package was not resolved"))?
                .id
                .clone();
            expected.insert(
                alias.clone(),
                (id, BTreeSet::from([dependency.kind.clone()])),
            );
        }
        let flat: BTreeSet<_> = node.dependencies.into_iter().collect();
        let expected_flat: BTreeSet<_> = expected.values().map(|(id, _)| id.clone()).collect();
        if actual != expected || flat != expected_flat {
            return Err(Error::scope(
                "Cargo resolved dependency identities differ from local declarations",
            ));
        }
    }
    if resolved.len() != ids.len() {
        return Err(Error::scope("Cargo resolve graph omitted local packages"));
    }
    let mut targets = Vec::new();
    for package in &metadata.packages {
        for target in &package.targets {
            if target.kind.len() != 1
                || !matches!(
                    target.kind[0].as_str(),
                    "lib" | "bin" | "test" | "example" | "bench"
                )
                || target
                    .crate_types
                    .iter()
                    .any(|kind| !matches!(kind.as_str(), "lib" | "rlib" | "bin"))
                || !matches!(target.edition.as_str(), "2021" | "2024")
                || !target.required_features.is_empty()
            {
                return Err(Error::scope("Cargo target kind, edition, crate type, or required features are outside the source profile"));
            }
            relative(root, &target.src_path)?;
            let crate_name = target.name.replace('-', "_");
            if !identifier(&crate_name) || matches!(crate_name.as_str(), "std" | "core" | "alloc") {
                return Err(Error::scope(
                    "Cargo target has an unsupported or reserved crate name",
                ));
            }
            targets.push(Target {
                package_id: package.id.clone(),
                name: target.name.clone(),
                kind: target.kind[0].clone(),
                crate_name,
                source: target.src_path.clone(),
                externs: BTreeMap::new(),
            });
        }
    }
    targets.sort_by(|a, b| {
        (&a.package_id, &a.kind, &a.name, &a.source).cmp(&(
            &b.package_id,
            &b.kind,
            &b.name,
            &b.source,
        ))
    });
    if targets.is_empty()
        || targets.len() > 512
        || targets.windows(2).any(|pair| pair[0] == pair[1])
    {
        return Err(Error::scope(
            "Cargo target closure is empty, ambiguous, or too large",
        ));
    }
    let mut libraries = BTreeMap::new();
    for (index, target) in targets
        .iter()
        .enumerate()
        .filter(|(_, target)| target.kind == "lib")
    {
        if libraries
            .insert(
                target.package_id.clone(),
                (index, target.crate_name.clone()),
            )
            .is_some()
        {
            return Err(Error::scope(
                "a local package has multiple library namespaces",
            ));
        }
    }
    let package_manifest_by_id: BTreeMap<_, _> = packages
        .values()
        .map(|package| (package.id.clone(), package.manifest_path.clone()))
        .collect();
    let package_id_by_manifest: BTreeMap<_, _> = packages
        .values()
        .map(|package| (package.manifest_path.clone(), package.id.clone()))
        .collect();
    for (index, target) in targets.iter_mut().enumerate() {
        if let Some((library, name)) = libraries.get(&target.package_id) {
            if *library != index {
                target.externs.insert(name.clone(), *library);
            }
        }
        let manifest = &package_manifest_by_id[&target.package_id];
        for (alias, dependency) in &preflight.packages[manifest].dependencies {
            let id = &package_id_by_manifest[&dependency.manifest];
            let (library, _) = libraries
                .get(id)
                .ok_or_else(|| Error::scope("local dependency has no supported library target"))?;
            if target.externs.insert(alias.clone(), *library).is_some() {
                return Err(Error::scope(
                    "own-library and dependency extern aliases collide",
                ));
            }
        }
    }
    Ok(targets)
}

fn validate_dependencies(root: &Path, declared: &Package, package: &MetadataPackage) -> Result<()> {
    if package.dependencies.len() != declared.dependencies.len() {
        return Err(Error::scope(
            "Cargo dependency declarations differ from preflight",
        ));
    }
    let mut aliases = BTreeSet::new();
    for dependency in &package.dependencies {
        let alias = dependency
            .rename
            .as_ref()
            .unwrap_or(&dependency.name)
            .replace('-', "_");
        let expected = declared
            .dependencies
            .get(&alias)
            .ok_or_else(|| Error::scope("Cargo discovered an undeclared dependency alias"))?;
        let path = dependency
            .path
            .as_ref()
            .ok_or_else(|| Error::scope("Cargo discovered a nonpath dependency"))?;
        let expected_directory = expected
            .manifest
            .parent()
            .ok_or_else(|| Error::scope("preflight dependency manifest has no parent directory"))?;
        // Cargo serializes this one path through a file URL. On Windows that
        // transport can remove a verbatim prefix. Compare that representation
        // only; never open or canonicalize an unchecked metadata path.
        if !dependency_directory_matches(path, expected_directory) {
            return Err(Error::scope(format!(
                "Cargo packages[].dependencies[].path identity differs from preflight: package={:?}, alias={alias:?}, reported path={path:?}, expected manifest={:?}, captured root={root:?}",
                package.name, expected.manifest,
            )));
        }
        relative(root, &expected.manifest)?;
        if !aliases.insert(alias)
            || dependency.source.is_some()
            || dependency.optional
            || !dependency.features.is_empty()
            || dependency.target.is_some()
            || dependency.kind != expected.kind
            || dependency.name != expected.package
        {
            return Err(Error::scope(
                "Cargo dependency identity or view differs from preflight",
            ));
        }
    }
    Ok(())
}

fn dependency_directory_matches(reported: &Path, expected: &Path) -> bool {
    if reported == expected {
        return true;
    }
    #[cfg(windows)]
    {
        windows_dependency_transport_matches(reported, expected)
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[cfg(windows)]
fn windows_dependency_transport_matches(reported: &Path, expected: &Path) -> bool {
    windows_rebase_metadata_path(expected, reported).is_some_and(|path| path == expected)
}

#[cfg(windows)]
fn windows_rebase_metadata_path(root: &Path, reported: &Path) -> Option<PathBuf> {
    use std::path::Prefix;
    let mut reported = reported.components();
    let mut expected = root.components();
    let (Some(Component::Prefix(a)), Some(Component::Prefix(b))) =
        (reported.next(), expected.next())
    else {
        return None;
    };
    let same_root = match (a.kind(), b.kind()) {
        (Prefix::Disk(a), Prefix::VerbatimDisk(b)) | (Prefix::VerbatimDisk(a), Prefix::Disk(b)) => {
            a == b
        }
        (Prefix::UNC(a_server, a_share), Prefix::VerbatimUNC(b_server, b_share))
        | (Prefix::VerbatimUNC(a_server, a_share), Prefix::UNC(b_server, b_share)) => {
            a_server == b_server
                && a_share == b_share
                && portable_windows_component(a_server)
                && portable_windows_component(a_share)
        }
        _ => false,
    };
    if !same_root
        || reported.next() != Some(Component::RootDir)
        || expected.next() != Some(Component::RootDir)
    {
        return None;
    }
    for component in expected {
        match (reported.next(), component) {
            (Some(Component::Normal(a)), Component::Normal(b))
                if a == b && portable_windows_component(a) => {}
            _ => return None,
        }
    }
    let mut rebased = root.to_path_buf();
    for component in reported {
        let Component::Normal(name) = component else {
            return None;
        };
        if !portable_windows_component(name) {
            return None;
        }
        rebased.push(name);
    }
    Some(rebased)
}

#[cfg(windows)]
fn portable_windows_component(name: &std::ffi::OsStr) -> bool {
    let Some(name) = name.to_str() else {
        return false;
    };
    if name.is_empty()
        || name.ends_with(['.', ' '])
        || name.contains(['\\', '/', ':', '"', '<', '>', '|', '?', '*'])
        || name.chars().any(char::is_control)
    {
        return false;
    }
    // Ordinary Win32 paths can reinterpret these names as devices, whereas a
    // verbatim path can name a literal directory. This transport equivalence
    // intentionally refuses the whole ambiguous spelling class.
    let base = name
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches(' ');
    if ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"]
        .iter()
        .any(|reserved| base.eq_ignore_ascii_case(reserved))
    {
        return false;
    }
    let mut chars = base.chars();
    let prefix: String = chars.by_ref().take(3).collect();
    let port_name = prefix.eq_ignore_ascii_case("COM") || prefix.eq_ignore_ascii_case("LPT");
    !(port_name && chars.next().is_some() && chars.next().is_none())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_identities_serialize_native_components_with_portable_separators() {
        let root = Path::new("application");
        let source = root.join("src").join("자료").join("lib.rs");
        assert_eq!(relative(root, &source).unwrap(), "src/자료/lib.rs");
        assert!(relative(root, root).is_err());
        assert!(relative(root, &root.join("..").join("outside.rs")).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn windows_native_separators_are_not_literal_file_name_backslashes() {
        let root = Path::new(r"C:\workspace");
        assert_eq!(
            relative(root, Path::new(r"C:\workspace\src\lib.rs")).unwrap(),
            "src/lib.rs"
        );
    }

    #[cfg(unix)]
    #[test]
    fn posix_literal_backslashes_and_non_utf8_names_remain_refused() {
        use std::os::unix::ffi::OsStringExt;
        let root = Path::new("application");
        assert!(relative(root, &root.join(r"src\lib.rs")).is_err());
        assert!(relative(root, &root.join(std::ffi::OsString::from_vec(vec![0xff]))).is_err());
    }

    fn fixture() -> tempfile::TempDir {
        let fixture = tempfile::tempdir().unwrap();
        fs::create_dir(fixture.path().join("src")).unwrap();
        fs::write(
            fixture.path().join("Cargo.toml"),
            "[package]\nname='scope-probe'\nversion='0.1.0'\nedition='2021'\n[workspace]\n",
        )
        .unwrap();
        fs::write(
            fixture.path().join("Cargo.lock"),
            "version = 4\n[[package]]\nname = 'scope-probe'\nversion = '0.1.0'\n",
        )
        .unwrap();
        fs::write(
            fixture.path().join("src/lib.rs"),
            "pub fn value() -> i64 { 1 }\n",
        )
        .unwrap();
        fixture
    }

    #[test]
    fn new_auto_binary_changes_discovery_without_old_file_edits() {
        let fixture = fixture();
        let scope = CargoScope::capture(fixture.path()).unwrap();
        fs::create_dir(fixture.path().join("src/bin")).unwrap();
        fs::write(fixture.path().join("src/bin/new.rs"), "fn main() {}\n").unwrap();
        let error = scope.recheck().unwrap_err();
        assert!(error.message.contains("discovery changed"), "{error}");
    }

    #[test]
    fn new_config_is_refused_before_rediscovery() {
        let fixture = fixture();
        let scope = CargoScope::capture(fixture.path()).unwrap();
        fs::create_dir(fixture.path().join(".cargo")).unwrap();
        fs::write(
            fixture.path().join(".cargo/config.toml"),
            "[build]\nrustc-wrapper='must-not-run'\n",
        )
        .unwrap();
        let error = scope.recheck().unwrap_err();
        assert!(
            error.message.contains("changed during source-scope"),
            "{error}"
        );
    }

    #[test]
    fn absent_module_alternative_cannot_appear_after_probe() {
        let fixture = fixture();
        let mut scope = CargoScope::capture(fixture.path()).unwrap();
        let candidate = scope.root().join("src/feature/mod.rs");
        assert!(!scope.probe(&candidate).unwrap());
        fs::create_dir(fixture.path().join("src/feature")).unwrap();
        fs::write(&candidate, "pub fn surprise() {}\n").unwrap();
        let error = scope.recheck().unwrap_err();
        assert!(
            error.message.contains("changed during source-scope"),
            "{error}"
        );
    }

    #[test]
    fn source_bytes_are_rechecked_before_rediscovery() {
        let fixture = fixture();
        let mut scope = CargoScope::capture(fixture.path()).unwrap();
        let source = scope.root().join("src/lib.rs");
        scope.read_source(&source).unwrap();
        fs::write(source, "pub fn value() -> i64 { 2 }\n").unwrap();
        assert!(scope
            .recheck()
            .unwrap_err()
            .message
            .contains("changed during source-scope"));
    }

    fn dependency_fixture() -> tempfile::TempDir {
        let fixture = fixture();
        fs::create_dir_all(fixture.path().join("helper/src")).unwrap();
        fs::create_dir(fixture.path().join("src/bin")).unwrap();
        fs::write(
            fixture.path().join("Cargo.toml"),
            "[package]\nname='scope-probe'\nversion='0.1.0'\nedition='2021'\n[workspace]\n[dependencies]\nrenamed={path='helper',package='helper_pkg'}\n",
        ).unwrap();
        fs::write(
            fixture.path().join("helper/Cargo.toml"),
            "[package]\nname='helper_pkg'\nversion='0.1.0'\nedition='2021'\n[lib]\nname='special_helper'\n",
        ).unwrap();
        fs::write(
            fixture.path().join("Cargo.lock"),
            "version=4\n[[package]]\nname='helper_pkg'\nversion='0.1.0'\n[[package]]\nname='scope-probe'\nversion='0.1.0'\ndependencies=['helper_pkg']\n",
        ).unwrap();
        fs::write(
            fixture.path().join("helper/src/lib.rs"),
            "pub fn helper() -> i64 { 1 }\n",
        )
        .unwrap();
        fs::write(fixture.path().join("src/main.rs"), "fn main() {}\n").unwrap();
        fs::write(fixture.path().join("src/bin/second.rs"), "fn main() {}\n").unwrap();
        fixture
    }

    #[test]
    fn discovered_targets_keep_own_library_and_renamed_dependency_namespaces() {
        let fixture = dependency_fixture();
        let scope = CargoScope::capture(fixture.path()).unwrap();
        assert_eq!(scope.targets.len(), 4);
        let library = scope
            .targets
            .iter()
            .position(|target| target.name == "scope_probe")
            .unwrap();
        let helper = scope
            .targets
            .iter()
            .position(|target| target.name == "special_helper")
            .unwrap();
        for target in scope.targets.iter().filter(|target| target.kind == "bin") {
            assert_eq!(target.externs.get("scope_probe"), Some(&library));
            assert_eq!(target.externs.get("renamed"), Some(&helper));
        }
        assert_eq!(scope.targets[library].externs.get("renamed"), Some(&helper));
        assert!(!scope.targets[library].externs.contains_key("scope_probe"));
        scope.recheck().unwrap();
    }

    #[test]
    fn dependency_metadata_path_is_checked_against_the_preflight_fixture() {
        let fixture = dependency_fixture();
        let root = fixture.path().canonicalize().unwrap();
        let mut snapshot = Snapshot::default();
        let preflight = Preflight::capture(&root, &mut snapshot).unwrap();
        let metadata: Metadata = serde_json::from_value(cargo_metadata(&root).unwrap()).unwrap();
        let mut package = metadata
            .packages
            .into_iter()
            .find(|package| package.name == "scope-probe")
            .unwrap();
        let declared = &preflight.packages[&root.join("Cargo.toml")];
        let reported = package.dependencies[0].path.as_ref().unwrap();
        let expected = &declared.dependencies["renamed"].manifest;
        assert!(
            dependency_directory_matches(reported, expected.parent().unwrap()),
            "metadata path transport: reported={reported:?}, preflight={expected:?}, root={root:?}"
        );
        validate_dependencies(&root, declared, &package).unwrap();
        package.dependencies[0].path = Some(root.join("unexpected-helper"));
        let error = validate_dependencies(&root, declared, &package).unwrap_err();
        for context in [
            "packages[].dependencies[].path",
            "renamed",
            "reported path=",
            "expected manifest=",
            "captured root=",
        ] {
            assert!(error.message.contains(context), "{error}");
        }
        snapshot.verify(&root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn dependency_metadata_accepts_only_unambiguous_windows_prefix_transport() {
        for (reported, expected) in [
            (r"C:\workspace\helper", r"\\?\C:\workspace\helper"),
            (
                r"\\server\share\workspace\helper",
                r"\\?\UNC\server\share\workspace\helper",
            ),
        ] {
            assert!(dependency_directory_matches(
                Path::new(reported),
                Path::new(expected)
            ));
            assert!(dependency_directory_matches(
                Path::new(expected),
                Path::new(reported)
            ));
        }
        for (reported, expected) in [
            (r"D:\workspace\helper", r"\\?\C:\workspace\helper"),
            (r"C:\workspace\other", r"\\?\C:\workspace\helper"),
            (r"C:\workspace\Helper", r"\\?\C:\workspace\helper"),
            (r"C:workspace\helper", r"\\?\C:\workspace\helper"),
            (r"C:\workspace\..\helper", r"\\?\C:\workspace\..\helper"),
            (r"C:\workspace\helper.", r"\\?\C:\workspace\helper."),
            (r"C:\workspace\helper ", r"\\?\C:\workspace\helper "),
            (r"C:\workspace\NUL", r"\\?\C:\workspace\NUL"),
            (r"C:\workspace\NUL .txt", r"\\?\C:\workspace\NUL .txt"),
            (r"C:\workspace\COM1.txt", r"\\?\C:\workspace\COM1.txt"),
            (r"C:\workspace\file:stream", r"\\?\C:\workspace\file:stream"),
            (
                r"\\server\other\workspace\helper",
                r"\\?\UNC\server\share\workspace\helper",
            ),
            (r"\\.\C:\workspace\helper", r"\\?\C:\workspace\helper"),
            (r"\\?\GLOBALROOT\workspace\helper", r"C:\workspace\helper"),
        ] {
            assert!(
                !dependency_directory_matches(Path::new(reported), Path::new(expected)),
                "unsupported metadata transport must fail: {reported:?} vs {expected:?}"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn decoded_child_manifest_and_target_paths_keep_the_captured_root_spelling() {
        let root = Path::new(r"\\?\C:\workspace");
        for (reported, expected, field) in [
            (
                r"C:\workspace\helper\Cargo.toml",
                root.join("helper").join("Cargo.toml"),
                "packages[].manifest_path",
            ),
            (
                r"C:\workspace\helper\src\lib.rs",
                root.join("helper").join("src").join("lib.rs"),
                "packages[].targets[].src_path",
            ),
        ] {
            assert_eq!(
                capture_metadata_file(root, Path::new(reported), field).unwrap(),
                expected
            );
        }
        for reported in [
            r"C:\outside\helper\src\lib.rs",
            r"C:\workspace\helper\..\outside.rs",
            r"C:\workspace\helper.\src\lib.rs",
            r"C:\workspace\NUL\lib.rs",
            r"\\.\C:\workspace\helper\src\lib.rs",
        ] {
            let error =
                capture_metadata_file(root, Path::new(reported), "packages[].targets[].src_path")
                    .unwrap_err();
            for label in [
                "packages[].targets[].src_path",
                "reported path=",
                "captured root=",
            ] {
                assert!(error.message.contains(label), "{error}");
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn dependency_manifest_symlinks_remain_refused_before_metadata() {
        use std::os::unix::fs::symlink;
        let fixture = dependency_fixture();
        fs::rename(
            fixture.path().join("helper"),
            fixture.path().join("real-helper"),
        )
        .unwrap();
        symlink("real-helper", fixture.path().join("helper")).unwrap();
        let error = match CargoScope::capture(fixture.path()) {
            Ok(_) => panic!("a dependency directory symlink must not be canonicalized away"),
            Err(error) => error,
        };
        assert!(
            error.message.contains("symlinks are unsupported"),
            "{error}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn dependency_junctions_remain_refused_before_metadata() {
        let fixture = dependency_fixture();
        let link = fixture.path().join("helper");
        let target = fixture.path().join("real-helper");
        fs::rename(&link, &target).unwrap();
        let output = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "$ErrorActionPreference = 'Stop'; New-Item -ItemType Junction -Path $env:SGD_JUNCTION_LINK -Target $env:SGD_JUNCTION_TARGET | Out-Null",
            ])
            .env("SGD_JUNCTION_LINK", &link)
            .env("SGD_JUNCTION_TARGET", &target)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "junction fixture must be created: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let result = CargoScope::capture(fixture.path());
        fs::remove_dir(&link).unwrap();
        let error = match result {
            Ok(_) => panic!("a junction must not be normalized into an admitted source directory"),
            Err(error) => error,
        };
        assert!(
            error.message.contains("symlinks are unsupported"),
            "{error}"
        );
        assert!(target.join("Cargo.toml").is_file());
    }
}
