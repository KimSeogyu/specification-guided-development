use crate::{Error, Result, SourceIdentity};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

const MAX_FILES: usize = 512;
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 32 * 1024 * 1024;

pub(crate) trait SourceInputs {
    fn root(&self) -> &Path;
    fn relative(&self, path: &Path) -> Result<String>;
    fn read(&mut self, path: &Path) -> Result<String>;
    fn probe(&mut self, path: &Path) -> Result<bool>;
    fn identities(&self) -> Vec<SourceIdentity>;
    fn captured_text(&self, path: &Path) -> Option<&str>;
}

#[derive(Default)]
pub(crate) struct Snapshot {
    reads: BTreeMap<PathBuf, (String, String)>,
    probes: BTreeMap<PathBuf, bool>,
    bytes: usize,
}

pub(crate) struct CapturedBinding {
    root: PathBuf,
    requested_parent: PathBuf,
    path: PathBuf,
    text: String,
    snapshot: Snapshot,
}

impl CapturedBinding {
    pub(crate) fn capture(path: &Path) -> Result<Self> {
        let requested = if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::env::current_dir()
                .map_err(|e| Error::new(format!("cannot read binding working directory: {e}")))?
                .join(path)
        };
        let requested_parent = requested
            .parent()
            .ok_or_else(|| Error::new("binding JSON must have a parent directory"))?
            .to_path_buf();
        let root = requested_parent
            .canonicalize()
            .map_err(|e| Error::new(format!("cannot resolve binding parent: {e}")))?;
        let name = requested
            .file_name()
            .ok_or_else(|| Error::new("binding JSON must name an ordinary file"))?;
        let path = root.join(name);
        let info = file_info(&root, &path)?.ok_or_else(|| Error::new("binding JSON is absent"))?;
        if info.len() > 1024 * 1024 {
            return Err(Error::new("binding JSON must be no larger than 1 MiB"));
        }
        let mut snapshot = Snapshot::default();
        let text = snapshot.read(&root, &path)?;
        if text.len() > 1024 * 1024 {
            return Err(Error::new("binding JSON must be no larger than 1 MiB"));
        }
        ensure_root(&root, &requested_parent)?;
        snapshot.verify(&root)?;
        Ok(Self {
            root,
            requested_parent,
            path,
            text,
            snapshot,
        })
    }

    pub(crate) fn text(&self) -> &str {
        &self.text
    }

    pub(crate) fn identity(&self) -> SourceIdentity {
        let name = relative(&self.root, &self.path).expect("captured binding has a checked name");
        self.snapshot
            .identities(&self.root)
            .into_iter()
            .find(|identity| identity.path == name)
            .expect("captured binding has an input identity")
    }

    pub(crate) fn recheck(&self) -> Result<()> {
        ensure_root(&self.root, &self.requested_parent)?;
        self.snapshot.verify(&self.root)
    }
}

pub(crate) fn relative(root: &Path, path: &Path) -> Result<String> {
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

pub(crate) fn joined(root: &Path, base: &Path, value: &str) -> Result<PathBuf> {
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

pub(crate) fn ensure_root(root: &Path, requested: &Path) -> Result<()> {
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

pub(crate) fn file_info(root: &Path, path: &Path) -> Result<Option<fs::Metadata>> {
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
    pub(crate) fn probe(&mut self, root: &Path, path: &Path) -> Result<bool> {
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

    pub(crate) fn read(&mut self, root: &Path, path: &Path) -> Result<String> {
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

    pub(crate) fn verify(&self, root: &Path) -> Result<()> {
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

impl Snapshot {
    pub(crate) fn text(&self, path: &Path) -> Option<&str> {
        self.reads.get(path).map(|(text, _)| text.as_str())
    }

    pub(crate) fn identities(&self, root: &Path) -> Vec<SourceIdentity> {
        self.reads
            .iter()
            .map(|(path, (_, sha256))| SourceIdentity {
                path: relative(root, path).expect("captured paths stay inside root"),
                sha256: sha256.clone(),
            })
            .collect()
    }

    pub(crate) fn absences(&self, root: &Path) -> Vec<String> {
        self.probes
            .iter()
            .filter(|(_, present)| !**present)
            .map(|(path, _)| relative(root, path).expect("captured paths stay inside root"))
            .collect()
    }
}

pub(crate) fn capture_metadata_file(root: &Path, reported: &Path, field: &str) -> Result<PathBuf> {
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

pub(crate) fn dependency_directory_matches(reported: &Path, expected: &Path) -> bool {
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
pub(crate) fn windows_rebase_metadata_path(root: &Path, reported: &Path) -> Option<PathBuf> {
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
    fn external_binding_is_a_bounded_rechecked_file_not_a_source_permission_root() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("binding.json");
        fs::write(&path, "{\"version\":1}\n").unwrap();
        let binding = CapturedBinding::capture(&path).unwrap();
        assert_eq!(binding.text(), "{\"version\":1}\n");
        assert_eq!(binding.identity().path, "binding.json");
        binding.recheck().unwrap();
        fs::write(&path, "{\"version\":2}\n").unwrap();
        assert!(binding.recheck().is_err());
        fs::write(&path, vec![b' '; 1024 * 1024 + 1]).unwrap();
        assert!(CapturedBinding::capture(&path).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn external_binding_symlink_and_nonregular_files_refuse() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("actual.json"), "{}").unwrap();
        symlink("actual.json", directory.path().join("binding.json")).unwrap();
        assert!(CapturedBinding::capture(&directory.path().join("binding.json")).is_err());
        fs::create_dir(directory.path().join("directory.json")).unwrap();
        assert!(CapturedBinding::capture(&directory.path().join("directory.json")).is_err());
    }

    #[test]
    fn probe_errors_are_not_absence() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("not-a-directory"), "x").unwrap();
        let mut snapshot = Snapshot::default();
        assert!(snapshot
            .probe(
                directory.path(),
                &directory.path().join("not-a-directory/child.rs")
            )
            .is_err());
        assert!(!snapshot
            .probe(directory.path(), &directory.path().join("absent/child.rs"))
            .unwrap());
    }
}
