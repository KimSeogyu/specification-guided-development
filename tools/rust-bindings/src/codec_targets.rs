use crate::source_inputs::{
    capture_metadata_file, dependency_directory_matches, ensure_root, joined, relative, Snapshot,
    SourceInputs,
};
use crate::targets::{cargo_metadata, check_configs, check_target_declarations};
use crate::{Error, Result, SourceIdentity};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use toml_edit::{DocumentMut, Item};

type LockPackages = BTreeMap<(String, String, Option<String>), Option<String>>;

const REGISTRY: &str = "registry+https://github.com/rust-lang/crates.io-index";

/// Cargo inventory for selected codec analysis. This is not effect admission.
pub(crate) struct CodecCargoScope {
    root: PathBuf,
    requested_root: PathBuf,
    snapshot: Snapshot,
    raw_discovery: serde_json::Value,
    discovery: CodecDiscoveryEvidence,
    libraries: BTreeMap<PathBuf, LocalLibraryIdentity>,
}

#[derive(Clone, Debug)]
pub(crate) struct LocalLibraryIdentity {
    pub package_id: String,
    pub target: String,
    pub crate_name: String,
    pub source: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodecDiscoveryEvidence {
    scope: &'static str,
    view: &'static str,
    local_targets: Vec<LocalTargetEvidence>,
    packages: Vec<PackageEvidence>,
    dependencies: Vec<ResolvedDependencyEvidence>,
    trusted_boundary: Vec<&'static str>,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalTargetEvidence {
    package_id: String,
    name: String,
    kind: String,
    crate_name: String,
    source: String,
    edition: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct PackageEvidence {
    package_id: String,
    name: String,
    version: String,
    origin: &'static str,
    source: Option<String>,
    checksum: Option<String>,
    enabled_features: Vec<String>,
    declared_features: BTreeMap<String, Vec<String>>,
    target_kinds: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResolvedDependencyEvidence {
    package_id: String,
    alias: String,
    dependency_package_id: String,
    kind: Option<String>,
    target_expression: Option<String>,
}

#[derive(Clone)]
enum Location {
    Local(PathBuf),
    Registry,
}

#[derive(Clone)]
struct DeclaredDependency {
    package: String,
    location: Location,
    features: Vec<String>,
    default_features: bool,
}

struct LocalPackage {
    name: String,
    dependencies: BTreeMap<(String, Option<String>), DeclaredDependency>,
}

struct Preflight {
    packages: BTreeMap<PathBuf, LocalPackage>,
    members: BTreeSet<PathBuf>,
    manifests: BTreeSet<PathBuf>,
    lock: LockPackages,
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
    version: String,
    manifest_path: PathBuf,
    source: Option<String>,
    features: BTreeMap<String, Vec<String>>,
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
    uses_default_features: bool,
    target: Option<String>,
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
    target: Option<String>,
}

impl CodecCargoScope {
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
            .map_err(|e| Error::scope(format!("cannot resolve codec application root: {e}")))?;
        if !root.is_dir() {
            return Err(Error::scope("codec application root must be a directory"));
        }
        let mut snapshot = Snapshot::default();
        let preflight = Preflight::capture(&root, &mut snapshot)?;
        ensure_root(&root, &requested_root)?;
        snapshot.verify(&root)?;
        let raw_discovery = cargo_metadata(&root)?;
        ensure_root(&root, &requested_root)?;
        snapshot.verify(&root)?;
        let metadata: Metadata = serde_json::from_value(raw_discovery.clone())
            .map_err(|e| Error::scope(format!("unsupported codec Cargo metadata schema: {e}")))?;
        let (discovery, libraries) = validate_metadata(&root, &preflight, metadata, &mut snapshot)?;
        Ok(Self {
            root,
            requested_root,
            snapshot,
            raw_discovery,
            discovery,
            libraries,
        })
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn read_source(&mut self, path: &Path) -> Result<(String, String)> {
        let name = relative(&self.root, path)?;
        Ok((name, self.snapshot.read(&self.root, path)?))
    }

    pub(crate) fn probe(&mut self, path: &Path) -> Result<bool> {
        self.snapshot.probe(&self.root, path)
    }

    pub(crate) fn identities(&self) -> Vec<SourceIdentity> {
        self.snapshot.identities(&self.root)
    }

    pub(crate) fn absences(&self) -> Vec<String> {
        self.snapshot.absences(&self.root)
    }

    pub(crate) fn discovery(&self) -> &CodecDiscoveryEvidence {
        &self.discovery
    }

    pub(crate) fn local_library(&self, manifest: &Path) -> Result<LocalLibraryIdentity> {
        relative(&self.root, manifest)?;
        self.libraries.get(manifest).cloned().ok_or_else(|| {
            Error::scope("codec source manifest must name one discovered local library target")
        })
    }

    pub(crate) fn recheck(&self) -> Result<()> {
        ensure_root(&self.root, &self.requested_root)?;
        self.snapshot.verify(&self.root)?;
        // Capture checks configs/toolchains/build hooks again before Cargo.
        let fresh = Self::capture(&self.requested_root)?;
        if fresh.root != self.root
            || fresh.raw_discovery != self.raw_discovery
            || fresh.discovery != self.discovery
        {
            return Err(Error::scope(
                "Cargo codec target, feature, or dependency inventory changed during analysis",
            ));
        }
        self.snapshot.verify(&self.root)
    }
}

impl SourceInputs for CodecCargoScope {
    fn root(&self) -> &Path {
        self.root()
    }

    fn relative(&self, path: &Path) -> Result<String> {
        relative(&self.root, path)
    }

    fn read(&mut self, path: &Path) -> Result<String> {
        self.read_source(path).map(|(_, text)| text)
    }

    fn probe(&mut self, path: &Path) -> Result<bool> {
        self.probe(path)
    }

    fn identities(&self) -> Vec<SourceIdentity> {
        self.identities()
    }

    fn captured_text(&self, path: &Path) -> Option<&str> {
        self.snapshot.text(path)
    }
}

impl Preflight {
    fn capture(root: &Path, snapshot: &mut Snapshot) -> Result<Self> {
        let mut scope = Self {
            packages: BTreeMap::new(),
            members: BTreeSet::new(),
            manifests: BTreeSet::new(),
            lock: BTreeMap::new(),
        };
        scope.manifest(root, &root.join("Cargo.toml"), true, snapshot)?;
        let lock_path = root.join("Cargo.lock");
        if !snapshot.probe(root, &lock_path)? {
            return Err(Error::scope(
                "codec discovery requires an existing Cargo.lock",
            ));
        }
        scope.lock = parse_lock(&snapshot.read(root, &lock_path)?)?;
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
            return Err(Error::scope("codec manifest closure exceeds 128 files"));
        }
        let directory = path
            .parent()
            .ok_or_else(|| Error::scope("codec manifest has no parent"))?;
        check_configs(root, directory, snapshot)?;
        let name = relative(root, path)?;
        let document = snapshot
            .read(root, path)?
            .parse::<DocumentMut>()
            .map_err(|e| Error::scope(format!("{name}: unsupported codec manifest: {e}")))?;
        if document.get("patch").is_some() || document.get("replace").is_some() {
            return Err(Error::scope(format!(
                "{name}: Cargo patch/replace overrides are unsupported for codec discovery"
            )));
        }
        for key in ["target", "features", "build-dependencies"] {
            if document.get(key).is_some_and(nonempty) {
                return Err(Error::scope(format!(
                    "{name}: local {key} are outside the codec discovery profile"
                )));
            }
        }
        if let Some(workspace) = document.get("workspace") {
            if !workspace_root {
                return Err(Error::scope("nested codec workspaces are unsupported"));
            }
            for field in ["exclude", "default-members", "dependencies"] {
                if workspace.get(field).is_some_and(nonempty) {
                    return Err(Error::scope(format!(
                        "{name}: workspace.{field} is outside the codec discovery profile"
                    )));
                }
            }
            if let Some(members) = workspace.get("members") {
                let members = members.as_array().ok_or_else(|| {
                    Error::scope("codec workspace.members must contain exact paths")
                })?;
                for member in members {
                    let member = member.as_str().ok_or_else(|| {
                        Error::scope("codec workspace.members must contain literal paths")
                    })?;
                    if member.contains(['*', '?', '[', ']', '{', '}']) {
                        return Err(Error::scope("codec workspace member globs are unsupported"));
                    }
                    let manifest = joined(root, directory, member)?.join("Cargo.toml");
                    self.members.insert(manifest.clone());
                    self.manifest(root, &manifest, false, snapshot)?;
                }
            }
        }
        let Some(package) = document.get("package") else {
            if workspace_root && document.get("workspace").is_some() {
                return Ok(());
            }
            return Err(Error::scope(format!("{name}: expected a local package")));
        };
        let package_name = package
            .get("name")
            .and_then(Item::as_str)
            .ok_or_else(|| Error::scope(format!("{name}: package.name must be literal")))?
            .to_owned();
        if !crate_identifier(&package_name.replace('-', "_")) {
            return Err(Error::scope(format!("{name}: unsupported package name")));
        }
        if ["workspace", "links", "metabuild"]
            .iter()
            .any(|key| package.get(key).is_some())
        {
            return Err(Error::scope(format!(
                "{name}: local workspace redirection and build integration are unsupported"
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
                "{name}: local build scripts and procedural targets are unsupported"
            )));
        }
        check_target_declarations(root, directory, &document, snapshot)?;
        if workspace_root {
            self.members.insert(path.to_path_buf());
        }
        let mut dependencies = BTreeMap::new();
        for (section, kind) in [("dependencies", None), ("dev-dependencies", Some("dev"))] {
            let Some(table) = document.get(section) else {
                continue;
            };
            let table = table.as_table_like().ok_or_else(|| {
                Error::scope(format!("{name}: dependency declarations must be tables"))
            })?;
            for (alias, value) in table.iter() {
                let normalized = alias.replace('-', "_");
                if !crate_identifier(&normalized)
                    || matches!(normalized.as_str(), "std" | "core" | "alloc")
                {
                    return Err(Error::scope(format!(
                        "{name}: ambiguous or reserved dependency alias {alias}"
                    )));
                }
                let declaration = parse_dependency(root, directory, alias, value, &name)?;
                if dependencies
                    .insert((normalized, kind.map(str::to_owned)), declaration)
                    .is_some()
                {
                    return Err(Error::scope(format!("{name}: duplicate dependency alias")));
                }
            }
        }
        let local_manifests: Vec<_> = dependencies
            .values()
            .filter_map(|dependency| match &dependency.location {
                Location::Local(manifest) => Some(manifest.clone()),
                Location::Registry => None,
            })
            .collect();
        self.packages.insert(
            path.to_path_buf(),
            LocalPackage {
                name: package_name,
                dependencies,
            },
        );
        for manifest in local_manifests {
            self.manifest(root, &manifest, false, snapshot)?;
        }
        Ok(())
    }
}

fn parse_dependency(
    root: &Path,
    directory: &Path,
    alias: &str,
    value: &Item,
    manifest: &str,
) -> Result<DeclaredDependency> {
    if let Some(version) = value.as_str() {
        if version.is_empty() {
            return Err(Error::scope(
                "registry version requirement must be nonempty",
            ));
        }
        return Ok(DeclaredDependency {
            package: alias.to_owned(),
            location: Location::Registry,
            features: Vec::new(),
            default_features: true,
        });
    }
    let table = value.as_table_like().ok_or_else(|| {
        Error::scope(format!(
            "{manifest}: dependency {alias} must be a version or table"
        ))
    })?;
    if table.iter().any(|(key, _)| {
        !matches!(
            key,
            "path" | "package" | "version" | "features" | "default-features" | "optional"
        )
    }) || value
        .get("optional")
        .is_some_and(|item| item.as_bool() != Some(false))
    {
        return Err(Error::scope(format!(
            "{manifest}: dependency {alias} uses an unsupported source, inheritance, or optional view"
        )));
    }
    let package = optional_string(value, "package")?.unwrap_or_else(|| alias.to_owned());
    let features = match value.get("features") {
        None => Vec::new(),
        Some(item) => literal_strings(item, "dependency features")?,
    };
    let default_features = match value.get("default-features") {
        None => true,
        Some(item) => item
            .as_bool()
            .ok_or_else(|| Error::scope("dependency default-features must be a literal Boolean"))?,
    };
    let version = optional_string(value, "version")?;
    let location = if let Some(path) = optional_string(value, "path")? {
        if !features.is_empty() {
            return Err(Error::scope(
                "local dependency feature selection is unsupported",
            ));
        }
        Location::Local(joined(root, directory, &path)?.join("Cargo.toml"))
    } else {
        if version.as_ref().is_none_or(String::is_empty) {
            return Err(Error::scope(format!(
                "{manifest}: registry dependency {alias} requires a literal version"
            )));
        }
        Location::Registry
    };
    Ok(DeclaredDependency {
        package,
        location,
        features,
        default_features,
    })
}

fn parse_lock(text: &str) -> Result<LockPackages> {
    let document = text
        .parse::<DocumentMut>()
        .map_err(|e| Error::scope(format!("unsupported codec Cargo.lock: {e}")))?;
    if document.get("version").and_then(Item::as_integer) != Some(4) {
        return Err(Error::scope(
            "codec discovery requires Cargo.lock version 4",
        ));
    }
    let packages = document
        .get("package")
        .and_then(Item::as_array_of_tables)
        .ok_or_else(|| Error::scope("codec Cargo.lock must contain package entries"))?;
    if packages.len() > 2048 {
        return Err(Error::scope("codec Cargo.lock exceeds 2048 packages"));
    }
    let mut lock = BTreeMap::new();
    for package in packages {
        let name = package
            .get("name")
            .and_then(Item::as_str)
            .ok_or_else(|| Error::scope("lock package name must be literal"))?
            .to_owned();
        let version = package
            .get("version")
            .and_then(Item::as_str)
            .ok_or_else(|| Error::scope("lock package version must be literal"))?
            .to_owned();
        let source = match package.get("source") {
            None => None,
            Some(item) if item.as_str() == Some(REGISTRY) => Some(REGISTRY.to_owned()),
            Some(_) => {
                return Err(Error::scope(
                    "codec lock contains an unsupported foreign source",
                ))
            }
        };
        let checksum = match package.get("checksum") {
            None if source.is_none() => None,
            Some(item) if source.is_some() => {
                let checksum = item
                    .as_str()
                    .filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
                    .ok_or_else(|| {
                        Error::scope("registry lock checksum must be 64 hexadecimal digits")
                    })?;
                Some(checksum.to_owned())
            }
            _ => {
                return Err(Error::scope(
                    "registry lock entry requires a checksum; local entries must not claim one",
                ))
            }
        };
        if lock.insert((name, version, source), checksum).is_some() {
            return Err(Error::scope("duplicate codec lock package identity"));
        }
    }
    Ok(lock)
}

fn validate_metadata(
    root: &Path,
    preflight: &Preflight,
    mut metadata: Metadata,
    snapshot: &mut Snapshot,
) -> Result<(
    CodecDiscoveryEvidence,
    BTreeMap<PathBuf, LocalLibraryIdentity>,
)> {
    if metadata.version != 1 || !dependency_directory_matches(&metadata.workspace_root, root) {
        return Err(Error::scope(
            "codec Cargo workspace identity differs from captured root",
        ));
    }
    if metadata.packages.is_empty() || metadata.packages.len() > 2048 {
        return Err(Error::scope(
            "codec Cargo package inventory is empty or exceeds 2048 packages",
        ));
    }
    let mut local_manifests = BTreeSet::new();
    let mut local_targets = Vec::new();
    let mut libraries = BTreeMap::new();
    for package in &mut metadata.packages {
        if package.source.is_none() {
            package.manifest_path = capture_metadata_file(
                root,
                &package.manifest_path,
                "local packages[].manifest_path",
            )?;
            let declared = preflight
                .packages
                .get(&package.manifest_path)
                .ok_or_else(|| {
                    Error::scope("Cargo discovered a local codec package outside preflight")
                })?;
            if declared.name != package.name
                || !package.features.is_empty()
                || !local_manifests.insert(package.manifest_path.clone())
            {
                return Err(Error::scope(
                    "local codec package identity or feature graph differs from preflight",
                ));
            }
            validate_local_dependencies(root, declared, package)?;
            for target in &mut package.targets {
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
                    return Err(Error::scope(
                        "local codec target kind, edition, or required features are unsupported",
                    ));
                }
                target.src_path = capture_metadata_file(
                    root,
                    &target.src_path,
                    "local packages[].targets[].src_path",
                )?;
                let crate_name = target.name.replace('-', "_");
                if !crate_identifier(&crate_name)
                    || matches!(crate_name.as_str(), "std" | "core" | "alloc")
                {
                    return Err(Error::scope(
                        "local codec target has an unsupported crate name",
                    ));
                }
                let source = relative(root, &target.src_path)?;
                snapshot.read(root, &target.src_path)?;
                local_targets.push(LocalTargetEvidence {
                    package_id: package.id.clone(),
                    name: target.name.clone(),
                    kind: target.kind[0].clone(),
                    crate_name: crate_name.clone(),
                    source: source.clone(),
                    edition: target.edition.clone(),
                });
                if target.kind[0] == "lib"
                    && libraries
                        .insert(
                            package.manifest_path.clone(),
                            LocalLibraryIdentity {
                                package_id: package.id.clone(),
                                target: target.name.clone(),
                                crate_name,
                                source,
                            },
                        )
                        .is_some()
                {
                    return Err(Error::scope(
                        "local codec package has multiple library namespaces",
                    ));
                }
            }
        } else if package.source.as_deref() != Some(REGISTRY) {
            return Err(Error::scope(
                "Cargo discovered an unsupported codec foreign source",
            ));
        }
    }
    if local_manifests != preflight.packages.keys().cloned().collect() {
        return Err(Error::scope(
            "Cargo omitted a preflight local codec package",
        ));
    }
    local_targets.sort();
    if local_targets.is_empty()
        || local_targets.len() > 512
        || local_targets.windows(2).any(|pair| pair[0] == pair[1])
    {
        return Err(Error::scope(
            "local codec target inventory is empty, ambiguous, or exceeds 512 targets",
        ));
    }
    let mut by_id = BTreeMap::new();
    for package in &metadata.packages {
        if package.id.is_empty() || by_id.insert(package.id.clone(), package).is_some() {
            return Err(Error::scope("codec Cargo package identities are ambiguous"));
        }
        if !preflight.lock.contains_key(&(
            package.name.clone(),
            package.version.clone(),
            package.source.clone(),
        )) {
            return Err(Error::scope(format!(
                "Cargo package {} {} differs from captured lock identity",
                package.name, package.version
            )));
        }
    }
    let members = metadata
        .workspace_members
        .iter()
        .map(|id| {
            by_id
                .get(id)
                .filter(|p| p.source.is_none())
                .map(|p| p.manifest_path.clone())
                .ok_or_else(|| {
                    Error::scope("codec workspace member identity is unresolved or foreign")
                })
        })
        .collect::<Result<BTreeSet<_>>>()?;
    if members != preflight.members || members.len() != metadata.workspace_members.len() {
        return Err(Error::scope(
            "codec Cargo workspace membership differs from exact preflight members",
        ));
    }
    let resolve = metadata
        .resolve
        .ok_or_else(|| Error::scope("Cargo omitted codec resolved inventory"))?;
    let mut enabled = BTreeMap::new();
    let mut dependencies = Vec::new();
    for node in resolve.nodes {
        let package = by_id
            .get(&node.id)
            .ok_or_else(|| Error::scope("codec resolve node package is unknown"))?;
        let mut features = node.features;
        features.sort();
        if features.windows(2).any(|pair| pair[0] == pair[1])
            || (package.source.is_none() && !features.is_empty())
            || enabled.insert(node.id.clone(), features).is_some()
        {
            return Err(Error::scope(
                "codec feature inventory is ambiguous or changes local admission",
            ));
        }
        let mut flat = BTreeSet::new();
        let mut local_actual = BTreeSet::new();
        for dependency in node.deps {
            let resolved = by_id
                .get(&dependency.pkg)
                .ok_or_else(|| Error::scope("codec dependency resolves to unknown package"))?;
            if dependency.dep_kinds.is_empty() {
                return Err(Error::scope("codec dependency has no resolved kind view"));
            }
            flat.insert(dependency.pkg.clone());
            for kind in dependency.dep_kinds {
                if kind
                    .kind
                    .as_deref()
                    .is_some_and(|kind| !matches!(kind, "dev" | "build"))
                {
                    return Err(Error::scope("codec dependency kind is unsupported"));
                }
                let matches_declaration = package.dependencies.iter().any(|declared| {
                    declared
                        .rename
                        .as_ref()
                        .unwrap_or(&declared.name)
                        .replace('-', "_")
                        == dependency.name
                        && declared.name == resolved.name
                        && declared.kind == kind.kind
                        && declared.target == kind.target
                        && declared.source == resolved.source
                });
                if !matches_declaration {
                    return Err(Error::scope(
                        "resolved codec dependency differs from metadata declaration",
                    ));
                }
                if package.source.is_none() {
                    if kind.target.is_some()
                        || kind.kind.as_deref() == Some("build")
                        || !local_actual.insert((dependency.name.clone(), kind.kind.clone()))
                    {
                        return Err(Error::scope(
                            "resolved local codec dependency view is unsupported or duplicated",
                        ));
                    }
                    let declared = &preflight.packages[&package.manifest_path].dependencies
                        [&(dependency.name.clone(), kind.kind.clone())];
                    if let Location::Local(path) = &declared.location {
                        if resolved.manifest_path != *path || resolved.source.is_some() {
                            return Err(Error::scope("resolved local codec dependency package differs from captured manifest"));
                        }
                    }
                }
                dependencies.push(ResolvedDependencyEvidence {
                    package_id: node.id.clone(),
                    alias: dependency.name.clone(),
                    dependency_package_id: dependency.pkg.clone(),
                    kind: kind.kind,
                    target_expression: kind.target,
                });
            }
        }
        let expected_flat: BTreeSet<_> = node.dependencies.iter().cloned().collect();
        if flat != expected_flat || expected_flat.len() != node.dependencies.len() {
            return Err(Error::scope(
                "codec flattened dependency inventory is inconsistent",
            ));
        }
        if package.source.is_none()
            && local_actual
                != preflight.packages[&package.manifest_path]
                    .dependencies
                    .keys()
                    .cloned()
                    .collect()
        {
            return Err(Error::scope(
                "Cargo omitted a declared local codec dependency view",
            ));
        }
    }
    if enabled.len() != by_id.len() {
        return Err(Error::scope("codec resolved inventory omitted packages"));
    }
    dependencies.sort();
    if dependencies.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(Error::scope(
            "codec resolved inventory has duplicate dependency views",
        ));
    }
    let packages = by_id
        .values()
        .map(|package| {
            let checksum = preflight.lock[&(
                package.name.clone(),
                package.version.clone(),
                package.source.clone(),
            )]
                .clone();
            let target_kinds: BTreeSet<_> = package
                .targets
                .iter()
                .flat_map(|t| t.kind.iter().cloned())
                .collect();
            PackageEvidence {
                package_id: package.id.clone(),
                name: package.name.clone(),
                version: package.version.clone(),
                origin: if package.source.is_none() {
                    "local"
                } else {
                    "registry"
                },
                source: package.source.clone(),
                checksum,
                enabled_features: enabled[&package.id].clone(),
                declared_features: package.features.clone(),
                target_kinds: target_kinds.into_iter().collect(),
            }
        })
        .collect();
    Ok((CodecDiscoveryEvidence {
        scope: "discovered-targets-only",
        view: "cargo-metadata-unfiltered-default-features",
        local_targets, packages, dependencies,
        trusted_boundary: vec![
            "trusted Cargo and Rust toolchain; standard library and platform",
            "environment and above-root/global Cargo configuration",
            "default-registry index and cache integrity; checksums are lock identities only",
            "foreign build scripts and procedural macros are inventoried, not executed or analyzed",
            "foreign runtime libraries; discovery does not admit their calls or values to codec recipes",
            "metadata features are an unfiltered inventory union, not resolver-v2 compiled host/target unit features",
        ],
    }, libraries))
}

fn validate_local_dependencies(
    root: &Path,
    declared: &LocalPackage,
    package: &MetadataPackage,
) -> Result<()> {
    if package.dependencies.len() != declared.dependencies.len() {
        return Err(Error::scope(
            "local codec dependency inventory differs from preflight",
        ));
    }
    let mut seen = BTreeSet::new();
    for dependency in &package.dependencies {
        let alias = dependency
            .rename
            .as_ref()
            .unwrap_or(&dependency.name)
            .replace('-', "_");
        let key = (alias, dependency.kind.clone());
        let expected = declared
            .dependencies
            .get(&key)
            .ok_or_else(|| Error::scope("Cargo discovered an undeclared local codec dependency"))?;
        let mut features = dependency.features.clone();
        features.sort();
        if !seen.insert(key)
            || dependency.name != expected.package
            || dependency.optional
            || dependency.target.is_some()
            || features != expected.features
            || dependency.uses_default_features != expected.default_features
        {
            return Err(Error::scope(
                "local codec dependency identity or feature view differs from preflight",
            ));
        }
        match &expected.location {
            Location::Local(manifest) => {
                let directory = manifest
                    .parent()
                    .ok_or_else(|| Error::scope("local manifest has no parent"))?;
                if dependency.source.is_some()
                    || dependency
                        .path
                        .as_ref()
                        .is_none_or(|path| !dependency_directory_matches(path, directory))
                {
                    return Err(Error::scope(
                        "local codec dependency path differs from preflight",
                    ));
                }
                relative(root, manifest)?;
            }
            Location::Registry => {
                if dependency.source.as_deref() != Some(REGISTRY) || dependency.path.is_some() {
                    return Err(Error::scope(
                        "registry codec dependency resolves outside the default registry",
                    ));
                }
            }
        }
    }
    Ok(())
}

fn optional_string(item: &Item, key: &str) -> Result<Option<String>> {
    item.get(key)
        .map(|item| {
            item.as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| {
                    Error::scope(format!(
                        "dependency {key} must be a nonempty literal string"
                    ))
                })
        })
        .transpose()
}

fn literal_strings(item: &Item, label: &str) -> Result<Vec<String>> {
    let array = item
        .as_array()
        .ok_or_else(|| Error::scope(format!("{label} must be an array")))?;
    let mut result = array
        .iter()
        .map(|item| {
            item.as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| {
                    Error::scope(format!("{label} must contain nonempty literal strings"))
                })
        })
        .collect::<Result<Vec<_>>>()?;
    result.sort();
    if result.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(Error::scope(format!("{label} must not repeat entries")));
    }
    Ok(result)
}

fn nonempty(item: &Item) -> bool {
    if let Some(array) = item.as_array() {
        return !array.is_empty();
    }
    item.as_table_like().is_none_or(|table| !table.is_empty())
}

fn crate_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c == '_' || c.is_ascii_alphabetic())
        && chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::Database;
    use std::fs;
    use std::process::Command;

    fn fixture(registry: bool) -> tempfile::TempDir {
        let fixture = tempfile::tempdir().unwrap();
        fs::create_dir(fixture.path().join("src")).unwrap();
        let dependencies = if registry {
            "[dependencies]\nserde = { version = \"=1.0.229\", features = [\"derive\"] }\n"
        } else {
            ""
        };
        fs::write(fixture.path().join("Cargo.toml"), format!(
            "[package]\nname = \"codec-capture-fixture\"\nversion = \"0.1.0\"\nedition = \"2021\"\n{dependencies}"
        )).unwrap();
        fs::write(
            fixture.path().join("src/lib.rs"),
            "pub fn value() -> i64 { 1 }\n",
        )
        .unwrap();
        // Resolves the copied fixture only. It neither compiles nor runs code.
        let output = Command::new("cargo")
            .args(["generate-lockfile", "--offline", "--manifest-path"])
            .arg(fixture.path().join("Cargo.toml"))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        fixture
    }

    fn refused(result: Result<CodecCargoScope>) -> Error {
        match result {
            Ok(_) => panic!("unsupported codec discovery must refuse"),
            Err(error) => error,
        }
    }

    #[test]
    fn registry_inventory_is_locked_and_does_not_admit_foreign_source() {
        let fixture = fixture(true);
        let scope = CodecCargoScope::capture(fixture.path()).unwrap();
        let discovery = serde_json::to_value(scope.discovery()).unwrap();
        assert_eq!(discovery["scope"], "discovered-targets-only");
        assert_eq!(
            discovery["view"],
            "cargo-metadata-unfiltered-default-features"
        );
        let packages = discovery["packages"].as_array().unwrap();
        let serde = packages.iter().find(|p| p["name"] == "serde").unwrap();
        assert_eq!(serde["origin"], "registry");
        assert_eq!(serde["source"], REGISTRY);
        assert_eq!(serde["checksum"].as_str().unwrap().len(), 64);
        assert!(serde["enabledFeatures"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("derive")));
        assert!(packages.iter().any(|p| p["name"] == "serde_derive"
            && p["targetKinds"]
                .as_array()
                .unwrap()
                .contains(&serde_json::json!("proc-macro"))));
        assert!(scope
            .identities()
            .iter()
            .all(|s| !s.path.contains(".cargo/registry")));
        assert!(scope
            .local_library(&scope.root().join("Cargo.toml"))
            .is_ok());
        scope.recheck().unwrap();
    }

    #[test]
    fn newly_discovered_bin_refuses_recheck() {
        let fixture = fixture(false);
        let scope = CodecCargoScope::capture(fixture.path()).unwrap();
        fs::create_dir(fixture.path().join("src/bin")).unwrap();
        fs::write(fixture.path().join("src/bin/bypass.rs"), "fn main() {}\n").unwrap();
        assert!(scope
            .recheck()
            .unwrap_err()
            .message
            .contains("inventory changed"));
    }

    #[test]
    fn new_config_build_and_toolchain_candidates_refuse_recheck() {
        for path in [".cargo/config.toml", "build.rs", "rust-toolchain.toml"] {
            let fixture = fixture(false);
            let scope = CodecCargoScope::capture(fixture.path()).unwrap();
            let path = fixture.path().join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "untrusted newly present input\n").unwrap();
            assert!(scope.recheck().is_err());
        }
    }

    #[test]
    fn database_reads_and_negative_module_probes_use_the_capture() {
        let fixture = fixture(false);
        fs::write(fixture.path().join("src/lib.rs"), "mod inner;\n").unwrap();
        fs::write(
            fixture.path().join("src/inner.rs"),
            "pub struct Row { pub count: i64 }\n",
        )
        .unwrap();
        let mut scope = CodecCargoScope::capture(fixture.path()).unwrap();
        let root = scope.root().to_path_buf();
        {
            let mut db = Database::from_inputs(&mut scope);
            db.load_crate(&root.join("Cargo.toml")).unwrap();
            assert!(db.set_generated_root(Path::new("generated")).is_err());
        }
        assert!(scope.absences().contains(&"src/inner/mod.rs".to_owned()));
        fs::create_dir(fixture.path().join("src/inner")).unwrap();
        fs::write(
            fixture.path().join("src/inner/mod.rs"),
            "pub fn bypass() {}\n",
        )
        .unwrap();
        assert!(scope.recheck().is_err());
    }

    #[test]
    fn captured_database_never_reopens_a_changed_source_as_fresh_input() {
        let fixture = fixture(false);
        let mut scope = CodecCargoScope::capture(fixture.path()).unwrap();
        let source = scope.root().join("src/lib.rs");
        fs::write(&source, "pub fn value() -> i64 { 2 }\n").unwrap();
        {
            let mut db = Database::from_inputs(&mut scope);
            assert_eq!(db.read(&source).unwrap(), "pub fn value() -> i64 { 1 }\n");
        }
        assert!(scope.recheck().is_err());
    }

    #[test]
    fn foreign_source_classes_and_missing_checksums_refuse_before_metadata() {
        for mutation in [
            "[[package]]\nname=\"foreign\"\nversion=\"1.0.0\"\nsource=\"git+https://example.invalid/source\"\n",
            "[[package]]\nname=\"foreign\"\nversion=\"1.0.0\"\nsource=\"registry+https://github.com/rust-lang/crates.io-index\"\n",
        ] {
            let fixture = fixture(false);
            let lock = fixture.path().join("Cargo.lock");
            let mut text = fs::read_to_string(&lock).unwrap();
            text.push_str(mutation);
            fs::write(lock, text).unwrap();
            let error = refused(CodecCargoScope::capture(fixture.path()));
            assert!(error.message.contains("unsupported foreign source")
                || error.message.contains("requires a checksum"), "{error}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn symlink_local_sources_refuse_in_the_shared_reader() {
        use std::os::unix::fs::symlink;
        let fixture = fixture(false);
        fs::rename(
            fixture.path().join("src/lib.rs"),
            fixture.path().join("src/actual.rs"),
        )
        .unwrap();
        symlink("actual.rs", fixture.path().join("src/lib.rs")).unwrap();
        let error = refused(CodecCargoScope::capture(fixture.path()));
        assert!(
            error.message.contains("symlinks are unsupported"),
            "{error}"
        );
    }

    #[test]
    #[ignore = "requires explicit SGD_CODEC_CAPTURE_APPLICATION pointing to the read-only pilot"]
    fn actual_application_offline_inventory() {
        let root = std::env::var_os("SGD_CODEC_CAPTURE_APPLICATION")
            .expect("set SGD_CODEC_CAPTURE_APPLICATION for this explicit integration check");
        let scope = CodecCargoScope::capture(Path::new(&root)).unwrap();
        let discovery = serde_json::to_value(scope.discovery()).unwrap();
        let packages = discovery["packages"].as_array().unwrap();
        for name in ["arrow-array", "arrow-schema", "parquet"] {
            assert!(packages.iter().any(|package| package["name"] == name
                && package["version"] == "60.0.0"
                && package["origin"] == "registry"));
        }
        let local_targets = discovery["localTargets"].as_array().unwrap();
        assert!(local_targets
            .iter()
            .any(|target| target["name"] == "parangsae_collector"));
        assert!(local_targets
            .iter()
            .any(|target| target["name"] == "parangsae-collect"));
        assert!(local_targets
            .iter()
            .any(|target| target["name"] == "fact_authority"));
        scope.recheck().unwrap();
    }
}
