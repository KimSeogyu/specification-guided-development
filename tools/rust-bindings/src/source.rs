use crate::error::{Error, Result};
use crate::model::SourceIdentity;
use proc_macro2::{Group, Span, TokenStream, TokenTree};
use quote::ToTokens;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use syn::parse::{Parse, ParseStream};
use syn::punctuated::Punctuated;
use syn::spanned::Spanned;
use syn::{
    braced, parenthesized, Attribute, Expr, Item, ItemImpl, ItemMacro, Token, UseTree, Visibility,
};
use toml_edit::DocumentMut;

#[derive(Clone)]
pub struct Definition {
    pub module: String,
    pub file: String,
    pub item: Item,
    pub conditional: bool,
}
#[derive(Clone)]
pub struct Import {
    pub path: Vec<String>,
    pub public: bool,
}
#[derive(Clone)]
pub struct Module {
    pub crate_id: String,
    pub file: String,
    pub definitions: BTreeMap<String, Definition>,
    pub imports: BTreeMap<String, Import>,
    pub children: BTreeSet<String>,
    pub child_public: BTreeSet<String>,
    pub opaque_macros: Vec<Span>,
    pub macro_use: bool,
    pub conditional: bool,
}
#[derive(Clone)]
pub struct CrateInfo {
    pub name: String,
    pub dependencies: BTreeMap<String, Option<String>>,
    pub dependency_packages: BTreeMap<String, String>,
    pub registry_dependencies: BTreeSet<String>,
}
#[derive(Clone)]
pub struct Implementation {
    pub module: String,
    pub file: String,
    pub item: ItemImpl,
    pub conditional: bool,
}
pub struct Database {
    pub root: PathBuf,
    pub modules: BTreeMap<String, Module>,
    pub crates: BTreeMap<String, CrateInfo>,
    pub implementations: Vec<Implementation>,
    reads: BTreeMap<String, (String, String)>,
    manifests: BTreeMap<String, String>,
    loading: BTreeSet<String>,
    generated: Option<PathBuf>,
    pub production_items: Vec<(String, String, Item)>,
    pub validated_macros: BTreeSet<String>,
    pub file_attributes: Vec<(String, String, Vec<Attribute>)>,
}

pub fn identifier(name: &str) -> bool {
    let mut chars = name.chars();
    name != "__proto__"
        && chars
            .next()
            .is_some_and(|c| c == '_' || c.is_ascii_alphabetic())
        && chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
}
pub fn rust_path(path: &str) -> Result<Vec<String>> {
    let parts: Vec<_> = path.split("::").map(str::to_owned).collect();
    if parts.first().map(String::as_str) != Some("crate")
        || parts.iter().any(|part| !identifier(part))
    {
        return Err(Error::new(format!(
            "expected an explicit crate:: Rust path, got {path}"
        )));
    }
    Ok(parts)
}
pub fn conditional(attrs: &[Attribute]) -> bool {
    attrs
        .iter()
        .any(|attr| attr.path().is_ident("cfg") || attr.path().is_ident("cfg_attr"))
}
fn excluded_test(attrs: &[Attribute]) -> bool {
    fn configured(meta: &syn::Meta) -> Option<bool> {
        match meta {
            syn::Meta::Path(path) if path.is_ident("test") || path.is_ident("kani") => Some(false),
            syn::Meta::List(list) => {
                use syn::parse::Parser;
                let entries = Punctuated::<syn::Meta, Token![,]>::parse_terminated
                    .parse2(list.tokens.clone())
                    .ok()?;
                let values: Vec<_> = entries.iter().map(configured).collect();
                if list.path.is_ident("any") {
                    if values.contains(&Some(true)) {
                        Some(true)
                    } else if values.iter().all(|v| *v == Some(false)) {
                        Some(false)
                    } else {
                        None
                    }
                } else if list.path.is_ident("all") {
                    if values.contains(&Some(false)) {
                        Some(false)
                    } else if values.iter().all(|v| *v == Some(true)) {
                        Some(true)
                    } else {
                        None
                    }
                } else if list.path.is_ident("not") && values.len() == 1 {
                    values[0].map(|v| !v)
                } else {
                    None
                }
            }
            _ => None,
        }
    }
    attrs.iter().any(|attr| {
        attr.path().is_ident("cfg")
            && attr
                .parse_args::<syn::Meta>()
                .ok()
                .and_then(|meta| configured(&meta))
                == Some(false)
    })
}
pub fn item_attrs(item: &Item) -> &[Attribute] {
    match item {
        Item::Struct(x) => &x.attrs,
        Item::Enum(x) => &x.attrs,
        Item::Const(x) => &x.attrs,
        Item::Type(x) => &x.attrs,
        Item::Trait(x) => &x.attrs,
        Item::Macro(x) => &x.attrs,
        _ => &[],
    }
}

impl Database {
    pub fn new(root: &Path) -> Result<Self> {
        let root = root
            .canonicalize()
            .map_err(|e| Error::new(format!("cannot read application root: {e}")))?;
        if !root.is_dir() {
            return Err(Error::new("application root must be a directory"));
        }
        Ok(Self {
            root,
            modules: BTreeMap::new(),
            crates: BTreeMap::new(),
            implementations: Vec::new(),
            reads: BTreeMap::new(),
            manifests: BTreeMap::new(),
            loading: BTreeSet::new(),
            generated: None,
            production_items: Vec::new(),
            validated_macros: BTreeSet::new(),
            file_attributes: Vec::new(),
        })
    }
    pub fn set_generated_root(&mut self, path: &Path) -> Result<()> {
        let path = if path.is_absolute() {
            path.to_path_buf()
        } else {
            self.root.join(path)
        };
        let mut ancestor = path.clone();
        let mut remaining = Vec::new();
        while !ancestor.exists() {
            remaining.push(
                ancestor
                    .file_name()
                    .ok_or_else(|| Error::new("generated output has no existing ancestor"))?
                    .to_os_string(),
            );
            if !ancestor.pop() {
                return Err(Error::new("generated output has no existing ancestor"));
            }
        }
        let mut resolved = ancestor
            .canonicalize()
            .map_err(|e| Error::new(format!("cannot resolve generated output root: {e}")))?;
        for component in remaining.into_iter().rev() {
            resolved.push(component);
        }
        self.relative(&resolved)?;
        self.generated = Some(resolved);
        Ok(())
    }
    fn generated_file(&self, path: &Path) -> Result<bool> {
        let Some(root) = &self.generated else {
            return Ok(false);
        };
        if !path.starts_with(root) {
            return Ok(false);
        }
        let relative = path.strip_prefix(root).unwrap();
        if ["rust/adapter.rs", "rust/src/lib.rs", "rust/Cargo.toml"]
            .iter()
            .any(|name| relative == Path::new(name))
        {
            return Ok(true);
        }
        Err(Error::new("source inside the generated output root is not one of the three controlled generated adapter/crate paths"))
    }
    pub fn relative(&self, path: &Path) -> Result<String> {
        let relative = path
            .strip_prefix(&self.root)
            .map_err(|_| Error::new("source path escapes application root"))?;
        if relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err(Error::new(
                "source paths must contain ordinary relative components",
            ));
        }
        relative
            .to_str()
            .map(|s| s.replace('\\', "/"))
            .ok_or_else(|| Error::new("source path must be UTF-8"))
    }
    pub fn resolve_relative(&self, base: &Path, path: &str) -> Result<PathBuf> {
        if Path::new(path).is_absolute() || path.contains('\\') {
            return Err(Error::new("source paths must be relative"));
        }
        let mut result = base.to_path_buf();
        for part in Path::new(path).components() {
            match part {
                Component::Normal(name) => result.push(name),
                Component::CurDir => {}
                Component::ParentDir => {
                    if result == self.root || !result.pop() {
                        return Err(Error::new("source path escapes application root"));
                    }
                }
                _ => return Err(Error::new("unsupported source path")),
            }
        }
        self.relative(&result)?;
        Ok(result)
    }
    pub fn read(&mut self, path: &Path) -> Result<String> {
        if self.generated_file(path)? {
            return Err(Error::new(
                "generated output cannot supply a bound source type, getter, macro, or manifest",
            ));
        }
        let relative = self.relative(path)?;
        if let Some((text, _)) = self.reads.get(&relative) {
            return Ok(text.clone());
        }
        let mut current = self.root.clone();
        for part in Path::new(&relative).components() {
            current.push(part);
            let info = fs::symlink_metadata(&current)
                .map_err(|e| Error::new(format!("cannot read {relative}: {e}")))?;
            if info.file_type().is_symlink() {
                return Err(Error::new(format!(
                    "{relative}: source and manifest symlinks are unsupported"
                )));
            }
        }
        let info = fs::metadata(path)
            .map_err(|e| Error::new(format!("cannot inspect {relative}: {e}")))?;
        if !info.is_file() || info.len() > 4 * 1024 * 1024 {
            return Err(Error::new(format!(
                "{relative}: source must be a regular file no larger than 4 MiB"
            )));
        }
        if self.reads.len() >= 512 {
            return Err(Error::new(
                "source closure exceeds 512 files; no partial analysis is permitted",
            ));
        }
        let bytes =
            fs::read(path).map_err(|e| Error::new(format!("cannot read {relative}: {e}")))?;
        let digest = Sha256::digest(&bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let text = String::from_utf8(bytes)
            .map_err(|_| Error::new(format!("{relative}: source must be UTF-8")))?;
        self.reads.insert(relative, (text.clone(), digest));
        Ok(text)
    }
    pub fn sources(&self) -> Vec<SourceIdentity> {
        self.reads
            .iter()
            .map(|(path, (_, sha256))| SourceIdentity {
                path: path.clone(),
                sha256: sha256.clone(),
            })
            .collect()
    }
    pub fn load_crate(&mut self, manifest: &Path) -> Result<String> {
        let relative = self.relative(manifest)?;
        if let Some(id) = self.manifests.get(&relative) {
            return Ok(id.clone());
        }
        if !self.loading.insert(relative.clone()) {
            return Err(Error::new(format!(
                "cyclic local crate resolution at {relative}"
            )));
        }
        let text = self.read(manifest)?;
        let doc = text
            .parse::<DocumentMut>()
            .map_err(|e| Error::new(format!("{relative}: unsupported Cargo manifest: {e}")))?;
        if doc.get("patch").is_some() || doc.get("replace").is_some() {
            return Err(Error::new(format!(
                "{relative}: Cargo patch/replace overrides are outside the source profile"
            )));
        }
        let name = doc
            .get("package")
            .and_then(|p| p.get("name"))
            .and_then(|n| n.as_str())
            .ok_or_else(|| {
                Error::new(format!("{relative}: package.name must be a literal string"))
            })?
            .to_owned();
        let id = name.replace('-', "_");
        if !identifier(&id) || self.crates.contains_key(&id) {
            return Err(Error::new(format!(
                "{relative}: ambiguous or unsupported crate identity {name}"
            )));
        }
        if doc
            .get("lib")
            .and_then(|l| l.get("proc-macro"))
            .and_then(|v| v.as_bool())
            == Some(true)
        {
            return Err(Error::new(
                "a bound library cannot be a procedural macro crate",
            ));
        }
        let parent = manifest
            .parent()
            .ok_or_else(|| Error::new("manifest has no parent"))?;
        self.cargo_configs(parent)?;
        let mut dependencies = BTreeMap::new();
        let mut dependency_packages = BTreeMap::new();
        let mut registry_dependencies = BTreeSet::new();
        if let Some(table) = doc
            .get("dependencies")
            .and_then(|item| item.as_table_like())
        {
            for (alias, value) in table.iter() {
                if value.get("git").is_some()
                    || value.get("registry").is_some()
                    || value.get("registry-index").is_some()
                {
                    return Err(Error::new(format!(
                        "{relative}: git and custom registry dependencies are outside the default registry/path source profile"
                    )));
                }
                let package = value
                    .get("package")
                    .and_then(|item| item.as_str())
                    .unwrap_or(alias)
                    .to_owned();
                let alias = alias.replace('-', "_");
                dependency_packages.insert(alias.clone(), package);
                let path = value.get("path").and_then(|item| item.as_str());
                let inherited =
                    value.get("workspace").and_then(|item| item.as_bool()) == Some(true);
                if path.is_none() && !inherited {
                    registry_dependencies.insert(alias.clone());
                }
                let target = if let Some(path) = path {
                    let path = self.resolve_relative(parent, path)?.join("Cargo.toml");
                    if self.generated_file(&path)? {
                        None
                    } else {
                        Some(self.load_crate(&path)?)
                    }
                } else if inherited {
                    return Err(Error::new(format!("{relative}: inherited dependency {alias} requires an explicit supported path declaration")));
                } else {
                    None
                };
                if dependencies.insert(alias.clone(), target).is_some()
                    || matches!(alias.as_str(), "std" | "core" | "alloc")
                {
                    return Err(Error::new(format!(
                        "{relative}: ambiguous or reserved dependency alias {alias}"
                    )));
                }
            }
        }
        if let Some(targets) = doc.get("target").and_then(|item| item.as_table_like()) {
            for (_, target) in targets.iter() {
                if let Some(table) = target
                    .get("dependencies")
                    .and_then(|item| item.as_table_like())
                {
                    for (alias, _) in table.iter() {
                        if dependencies.contains_key(&alias.replace('-', "_")) {
                            return Err(Error::new(format!("{relative}: target-dependent dependency alias {alias} is unsupported")));
                        }
                    }
                }
            }
        }
        self.crates.insert(
            id.clone(),
            CrateInfo {
                name,
                dependencies,
                dependency_packages,
                registry_dependencies,
            },
        );
        self.manifests.insert(relative.clone(), id.clone());
        let lib = doc
            .get("lib")
            .and_then(|l| l.get("path"))
            .and_then(|p| p.as_str())
            .unwrap_or("src/lib.rs");
        let source = self.resolve_relative(parent, lib)?;
        let dir = source
            .parent()
            .ok_or_else(|| Error::new("lib path has no parent"))?
            .to_path_buf();
        self.load_module(&id, &id, &source, &dir, None, false)?;
        self.loading.remove(&relative);
        Ok(id)
    }
    fn cargo_configs(&mut self, start: &Path) -> Result<()> {
        let mut directory = start.to_path_buf();
        loop {
            let legacy = directory.join(".cargo/config");
            let modern = directory.join(".cargo/config.toml");
            if legacy.exists() && modern.exists() {
                return Err(Error::new(
                    "both .cargo/config and config.toml exist; source configuration is ambiguous",
                ));
            }
            for path in [legacy, modern] {
                if !path.exists() {
                    continue;
                }
                let text = self.read(&path)?;
                let config = text.parse::<DocumentMut>().map_err(|e| {
                    Error::new(format!("unsupported local Cargo configuration: {e}"))
                })?;
                if config.iter().any(|(key, _)| key != "alias") {
                    return Err(Error::new(format!("{}: only Cargo [alias] is supported; local registry, source, environment, and build overrides are outside the profile", self.relative(&path)?)));
                }
            }
            if directory == self.root {
                break;
            }
            if !directory.pop() || !directory.starts_with(&self.root) {
                return Err(Error::new(
                    "Cargo configuration ancestry escapes application root",
                ));
            }
        }
        Ok(())
    }
    fn load_module(
        &mut self,
        crate_id: &str,
        module: &str,
        path: &Path,
        dir: &Path,
        inline: Option<Vec<Item>>,
        inherited_conditional: bool,
    ) -> Result<()> {
        if self.modules.contains_key(module) {
            return Err(Error::new(format!("ambiguous Rust module {module}")));
        }
        if module.split("::").count() > 32 {
            return Err(Error::new("Rust module depth exceeds 32"));
        }
        let file = self.relative(path)?;
        if self.generated_file(path)? {
            return Err(Error::new(
                "generated output cannot be loaded as a source module",
            ));
        }
        let attribute_dir = if inline.is_some() {
            dir.to_path_buf()
        } else {
            path.parent()
                .ok_or_else(|| Error::new("source file has no parent"))?
                .to_path_buf()
        };
        let items = if let Some(items) = inline {
            items
        } else {
            let text = self.read(path)?;
            let ast = syn::parse_file(&text)
                .map_err(|e| Error::at(&file, e.span(), format!("unsupported Rust syntax: {e}")))?;
            self.file_attributes
                .push((module.into(), file.clone(), ast.attrs.clone()));
            if ast.attrs.iter().any(|a| a.path().is_ident("macro_use")) {
                return Err(Error::new(format!(
                    "{file}: macro_use is outside the source-binding profile"
                )));
            }
            ast.items
        };
        self.modules.insert(
            module.into(),
            Module {
                crate_id: crate_id.into(),
                file: file.clone(),
                definitions: BTreeMap::new(),
                imports: BTreeMap::new(),
                children: BTreeSet::new(),
                child_public: BTreeSet::new(),
                opaque_macros: Vec::new(),
                macro_use: false,
                conditional: inherited_conditional,
            },
        );
        for item in items {
            if excluded_test(item_attributes(&item)) {
                continue;
            }
            self.add_item(module, &file, item, inherited_conditional)?;
        }
        let current_items: Vec<_> = self.modules[module]
            .definitions
            .values()
            .map(|def| def.item.clone())
            .collect();
        for item in current_items {
            let Item::Mod(item) = item else {
                continue;
            };
            let name = item.ident.to_string();
            let child_module = format!("{module}::{name}");
            let next_conditional = inherited_conditional || conditional(&item.attrs);
            if let Some((_, items)) = item.content {
                self.load_module(
                    crate_id,
                    &child_module,
                    path,
                    &dir.join(&name),
                    Some(items),
                    next_conditional,
                )?;
            } else {
                let path_attr = item.attrs.iter().find(|a| a.path().is_ident("path"));
                let child = if let Some(attr) = path_attr {
                    let syn::Meta::NameValue(value) = &attr.meta else {
                        return Err(Error::at(
                            &file,
                            attr.span(),
                            "unsupported module path attribute",
                        ));
                    };
                    let Expr::Lit(lit) = &value.value else {
                        return Err(Error::at(
                            &file,
                            value.span(),
                            "module path must be a literal",
                        ));
                    };
                    let syn::Lit::Str(lit) = &lit.lit else {
                        return Err(Error::at(&file, lit.span(), "module path must be a string"));
                    };
                    self.resolve_relative(&attribute_dir, &lit.value())?
                } else {
                    let flat = dir.join(format!("{name}.rs"));
                    let nested = dir.join(&name).join("mod.rs");
                    match (flat.exists(), nested.exists()) {
                        (true, false) => flat,
                        (false, true) => nested,
                        (true, true) => {
                            return Err(Error::at(
                                &file,
                                item.ident.span(),
                                format!("ambiguous module {name}: both file layouts exist"),
                            ))
                        }
                        _ => {
                            return Err(Error::at(
                                &file,
                                item.ident.span(),
                                format!("missing module {name}"),
                            ))
                        }
                    }
                };
                let child_dir = if child.file_name().and_then(|n| n.to_str()) == Some("mod.rs") {
                    child.parent().unwrap().to_path_buf()
                } else {
                    child.with_extension("")
                };
                if self.generated_file(&child)? {
                    if !matches!(item.vis, Visibility::Inherited)
                        || next_conditional
                        || item
                            .attrs
                            .iter()
                            .any(|attr| attr.path().is_ident("macro_use"))
                    {
                        return Err(Error::at(&file, item.ident.span(), "a generated adapter hook must be private, unconditional, and without macro_use"));
                    }
                    continue;
                }
                self.load_module(
                    crate_id,
                    &child_module,
                    &child,
                    &child_dir,
                    None,
                    next_conditional,
                )?;
            }
        }
        Ok(())
    }
    fn add_item(
        &mut self,
        module: &str,
        file: &str,
        item: Item,
        inherited_conditional: bool,
    ) -> Result<()> {
        if excluded_test(item_attributes(&item)) {
            return Ok(());
        }
        self.production_items
            .push((module.into(), file.into(), item.clone()));
        struct NestedImpl {
            top: bool,
            found: Option<Span>,
        }
        impl<'ast> syn::visit::Visit<'ast> for NestedImpl {
            fn visit_item_mod(&mut self, _: &'ast syn::ItemMod) {}
            fn visit_item_impl(&mut self, implementation: &'ast ItemImpl) {
                if self.top {
                    self.top = false;
                    syn::visit::visit_item_impl(self, implementation);
                } else {
                    self.found = Some(implementation.span());
                }
            }
        }
        let mut nested = NestedImpl {
            top: matches!(item, Item::Impl(_)),
            found: None,
        };
        syn::visit::Visit::visit_item(&mut nested, &item);
        if let Some(span) = nested.found {
            return Err(Error::at(
                file,
                span,
                "nested trait or inherent implementations are outside the source-binding profile",
            ));
        }
        if let Item::Use(item) = &item {
            if conditional(&item.attrs) {
                return Err(Error::at(
                    file,
                    item.span(),
                    "conditional imports are unsupported in source bindings",
                ));
            }
            let mut imports = Vec::new();
            flatten_use(&item.tree, Vec::new(), &mut imports)?;
            for (alias, path) in imports {
                let scope = self.modules.get_mut(module).unwrap();
                if scope
                    .imports
                    .insert(
                        alias.clone(),
                        Import {
                            path,
                            public: matches!(item.vis, Visibility::Public(_)),
                        },
                    )
                    .is_some()
                {
                    return Err(Error::at(
                        file,
                        item.span(),
                        format!("ambiguous imported name {alias}"),
                    ));
                }
            }
            return Ok(());
        }
        if let Item::Impl(item) = &item {
            self.implementations.push(Implementation {
                module: module.into(),
                file: file.into(),
                item: item.clone(),
                conditional: inherited_conditional || conditional(&item.attrs),
            });
            return Ok(());
        }
        if let Item::Macro(item) = &item {
            if item.ident.is_none() {
                let path: Vec<_> = item
                    .mac
                    .path
                    .segments
                    .iter()
                    .map(|p| p.ident.to_string())
                    .collect();
                if path.len() == 1 {
                    if let Ok(definition) = self.resolve(module, &path) {
                        let macro_key = format!("{}::{}", definition.module, path[0]);
                        if let Item::Macro(definition) = definition.item {
                            let expanded = expand_owned_macro(&definition, item)
                                .map_err(|e| Error::at(file, item.span(), e.message))?;
                            self.validated_macros.insert(macro_key);
                            for item in expanded {
                                self.add_item(module, file, item, inherited_conditional)?;
                            }
                            return Ok(());
                        }
                    }
                }
                self.modules
                    .get_mut(module)
                    .unwrap()
                    .opaque_macros
                    .push(item.span());
                return Ok(());
            }
        }
        if let Item::ExternCrate(item) = &item {
            if item
                .attrs
                .iter()
                .any(|attr| attr.path().is_ident("macro_use"))
            {
                self.modules.get_mut(module).unwrap().macro_use = true;
            }
            return Err(Error::at(file, item.span(), "extern crate declarations are outside the source-binding profile; use explicit dependencies and imports"));
        }
        let name = match &item {
            Item::Struct(x) => Some(x.ident.to_string()),
            Item::Enum(x) => Some(x.ident.to_string()),
            Item::Const(x) => Some(x.ident.to_string()),
            Item::Type(x) => Some(x.ident.to_string()),
            Item::Trait(x) => Some(x.ident.to_string()),
            Item::Mod(x) => Some(x.ident.to_string()),
            Item::Macro(x) => x.ident.as_ref().map(ToString::to_string),
            _ => None,
        };
        if let Some(name) = name {
            let scope = self.modules.get_mut(module).unwrap();
            if let Item::Mod(child) = &item {
                scope.children.insert(name.clone());
                if matches!(child.vis, Visibility::Public(_)) {
                    scope.child_public.insert(name.clone());
                }
                if child
                    .attrs
                    .iter()
                    .any(|attr| attr.path().is_ident("macro_use"))
                {
                    scope.macro_use = true;
                }
            }
            let def = Definition {
                module: module.into(),
                file: file.into(),
                conditional: inherited_conditional || conditional(item_attributes(&item)),
                item,
            };
            if scope.definitions.insert(name.clone(), def).is_some() {
                return Err(Error::new(format!("{file}: ambiguous definition {name}")));
            }
        }
        Ok(())
    }
    pub fn resolve(&self, module: &str, path: &[String]) -> Result<Definition> {
        self.resolve_inner(module, path, &mut BTreeSet::new())
    }
    fn resolve_inner(
        &self,
        module: &str,
        path: &[String],
        seen: &mut BTreeSet<String>,
    ) -> Result<Definition> {
        let key = format!("{module}:{}", path.join("::"));
        if !seen.insert(key) || seen.len() > 64 {
            return Err(Error::new(
                "cyclic or excessively deep Rust name resolution",
            ));
        }
        if path.is_empty() {
            return Err(Error::new("empty Rust path"));
        }
        let scope = self
            .modules
            .get(module)
            .ok_or_else(|| Error::new(format!("unknown module {module}")))?;
        let mut context = module.to_owned();
        let mut rest = path;
        if path[0] == "crate" {
            context = scope.crate_id.clone();
            rest = &path[1..];
        } else if path[0] == "self" {
            rest = &path[1..];
        } else if path[0] == "super" {
            while rest.first().map(String::as_str) == Some("super") {
                context = context
                    .rsplit_once("::")
                    .ok_or_else(|| Error::new("super path leaves its crate"))?
                    .0
                    .into();
                rest = &rest[1..];
            }
        } else if let Some(target) = self.crates[&scope.crate_id].dependencies.get(&path[0]) {
            context = target.clone().ok_or_else(|| {
                Error::new(format!(
                    "external type source {} is outside the owned profile",
                    path[0]
                ))
            })?;
            rest = &path[1..];
        } else if let Some(import) = scope.imports.get(&path[0]) {
            let mut expanded = import.path.clone();
            expanded.extend_from_slice(&path[1..]);
            return self.resolve_inner(module, &expanded, seen);
        }
        if rest.is_empty() {
            return Err(Error::new("a crate or module is not an owned value type"));
        }
        for (index, part) in rest[..rest.len() - 1].iter().enumerate() {
            let scope = self
                .modules
                .get(&context)
                .ok_or_else(|| Error::new(format!("unknown module {context}")))?;
            if scope.children.contains(part) {
                context = format!("{context}::{part}");
            } else if let Some(import) = scope.imports.get(part) {
                let mut expanded = import.path.clone();
                expanded.extend_from_slice(&rest[index + 1..]);
                return self.resolve_inner(&context, &expanded, seen);
            } else {
                return Err(Error::new(format!(
                    "unresolved module path {}",
                    path.join("::")
                )));
            }
        }
        let scope = self
            .modules
            .get(&context)
            .ok_or_else(|| Error::new(format!("unknown module {context}")))?;
        let name = rest.last().unwrap();
        if let Some(def) = scope.definitions.get(name) {
            return Ok(def.clone());
        }
        if let Some(import) = scope.imports.get(name) {
            return self.resolve_inner(&context, &import.path, seen);
        }
        Err(Error::new(format!(
            "unresolved Rust item {module}::{}",
            path.join("::")
        )))
    }
    pub fn check_scope(&self, definition: &Definition) -> Result<()> {
        if definition.conditional {
            return Err(Error::at(
                &definition.file,
                definition.item.span(),
                "conditional bound definitions are unsupported",
            ));
        }
        let crate_id = &self.modules[&definition.module].crate_id;
        for scope in self
            .modules
            .values()
            .filter(|scope| &scope.crate_id == crate_id)
        {
            for (name, candidate) in &scope.definitions {
                if let Item::Macro(item) = &candidate.item {
                    if item
                        .attrs
                        .iter()
                        .any(|attr| attr.path().is_ident("macro_export"))
                        && matches!(
                            name.as_str(),
                            "matches"
                                | "Clone"
                                | "Copy"
                                | "PartialEq"
                                | "Eq"
                                | "Debug"
                                | "Hash"
                                | "Ord"
                                | "PartialOrd"
                        )
                    {
                        return Err(Error::new(format!(
                            "standard macro/derive name {name} is shadowed by macro_export"
                        )));
                    }
                }
            }
        }
        let mut path = Some(definition.module.as_str());
        while let Some(module) = path {
            let scope = &self.modules[module];
            if scope.conditional || scope.macro_use || !scope.opaque_macros.is_empty() {
                return Err(Error::new(format!("{}: conditional modules, macro_use, and opaque item macros are unsupported in the bound source ancestry", scope.file)));
            }
            path = module.rsplit_once("::").map(|(parent, _)| parent);
        }
        Ok(())
    }
    pub fn public_path(&self, definition: &Definition, root_crate: &str) -> Result<String> {
        let name = item_name(&definition.item).ok_or_else(|| Error::new("item has no name"))?;
        let mut candidates = Vec::new();
        for (module, scope) in &self.modules {
            if scope.crate_id != root_crate {
                continue;
            }
            let accessible = module
                .split("::")
                .scan(String::new(), |prefix, part| {
                    if prefix.is_empty() {
                        *prefix = part.into();
                        return Some(true);
                    }
                    let allowed = self
                        .modules
                        .get(prefix)
                        .is_some_and(|parent| parent.child_public.contains(part));
                    prefix.push_str("::");
                    prefix.push_str(part);
                    Some(allowed)
                })
                .all(|item| item);
            if !accessible {
                continue;
            }
            for (alias, import) in &scope.imports {
                if !import.public {
                    continue;
                }
                if self
                    .resolve(module, std::slice::from_ref(alias))
                    .is_ok_and(|found| {
                        found.module == definition.module
                            && item_name(&found.item) == Some(name.clone())
                    })
                {
                    candidates.push(format!(
                        "crate{}::{alias}",
                        module.strip_prefix(root_crate).unwrap()
                    ));
                }
            }
            if module == &definition.module
                && (matches!(&definition.item, Item::Enum(item) if matches!(item.vis, Visibility::Public(_)))
                    || matches!(&definition.item, Item::Struct(item) if matches!(item.vis, Visibility::Public(_))))
            {
                candidates.push(format!(
                    "crate{}::{name}",
                    module.strip_prefix(root_crate).unwrap()
                ));
            }
        }
        candidates.sort_by_key(|candidate| (candidate.split("::").count(), candidate.clone()));
        candidates
            .into_iter()
            .next()
            .ok_or_else(|| Error::new(format!("{name}: enum requires an accessible crate:: path")))
    }
}
fn item_attributes(item: &Item) -> &[Attribute] {
    match item {
        Item::Mod(x) => &x.attrs,
        Item::Use(x) => &x.attrs,
        Item::Impl(x) => &x.attrs,
        Item::Fn(x) => &x.attrs,
        _ => item_attrs(item),
    }
}
pub fn item_name(item: &Item) -> Option<String> {
    match item {
        Item::Struct(x) => Some(x.ident.to_string()),
        Item::Enum(x) => Some(x.ident.to_string()),
        Item::Const(x) => Some(x.ident.to_string()),
        _ => None,
    }
}
fn flatten_use(
    tree: &UseTree,
    mut prefix: Vec<String>,
    out: &mut Vec<(String, Vec<String>)>,
) -> Result<()> {
    match tree {
        UseTree::Path(path) => {
            prefix.push(path.ident.to_string());
            flatten_use(&path.tree, prefix, out)?;
        }
        UseTree::Name(name) => {
            if name.ident == "self" {
                out.push((
                    prefix
                        .last()
                        .ok_or_else(|| Error::new("unsupported self import"))?
                        .clone(),
                    prefix,
                ));
            } else {
                prefix.push(name.ident.to_string());
                out.push((name.ident.to_string(), prefix));
            }
        }
        UseTree::Rename(rename) => {
            prefix.push(rename.ident.to_string());
            out.push((rename.rename.to_string(), prefix));
        }
        UseTree::Group(group) => {
            for tree in &group.items {
                flatten_use(tree, prefix.clone(), out)?;
            }
        }
        UseTree::Glob(glob) => {
            return Err(Error::at(
                "Rust import",
                glob.span(),
                "glob imports are outside the source-binding profile",
            ))
        }
    }
    Ok(())
}

struct MacroRule {
    pattern: TokenStream,
    body: TokenStream,
}
impl Parse for MacroRule {
    fn parse(input: ParseStream<'_>) -> syn::Result<Self> {
        let pattern;
        parenthesized!(pattern in input);
        let pattern = pattern.parse()?;
        input.parse::<Token![=>]>()?;
        let body;
        braced!(body in input);
        let body = body.parse()?;
        if input.peek(Token![;]) {
            input.parse::<Token![;]>()?;
        }
        if !input.is_empty() {
            return Err(input.error("only one owned-type macro rule is supported"));
        }
        Ok(Self { pattern, body })
    }
}
fn expand_owned_macro(definition: &ItemMacro, invocation: &ItemMacro) -> Result<Vec<Item>> {
    if !definition.mac.path.is_ident("macro_rules")
        || conditional(&definition.attrs)
        || !definition.attrs.iter().all(|a| a.path().is_ident("doc"))
    {
        return Err(Error::new(
            "owned type macros require an unconditional local macro_rules definition",
        ));
    }
    let rule = syn::parse2::<MacroRule>(definition.mac.tokens.clone())
        .map_err(|e| Error::new(format!("unsupported owned-type macro rule: {e}")))?;
    let pattern: Vec<_> = rule.pattern.into_iter().collect();
    let shape = |position: usize, text: &str| {
        pattern
            .get(position)
            .is_some_and(|token| token.to_string() == text)
    };
    if pattern.len() != 9
        || !shape(0, "$")
        || !shape(2, ":")
        || !shape(3, "ident")
        || !shape(4, ",")
        || !shape(5, "$")
        || !shape(7, ":")
        || !shape(8, "literal")
    {
        return Err(Error::new(
            "owned type macro must bind exactly one identifier and one literal",
        ));
    }
    let first = pattern[1].to_string();
    let second = pattern[6].to_string();
    if !identifier(&first) || !identifier(&second) || first == second {
        return Err(Error::new("invalid owned-type macro parameters"));
    }
    let parser = Punctuated::<Expr, Token![,]>::parse_terminated;
    use syn::parse::Parser;
    let arguments = parser
        .parse2(invocation.mac.tokens.clone())
        .map_err(|e| Error::new(format!("unsupported owned-type macro arguments: {e}")))?;
    if arguments.len() != 2
        || !matches!(&arguments[0], Expr::Path(p) if p.path.get_ident().is_some())
        || !matches!(&arguments[1], Expr::Lit(_))
    {
        return Err(Error::new(
            "owned type macro requires an identifier and a literal argument",
        ));
    }
    let replacements = BTreeMap::from([
        (first, arguments[0].to_token_stream()),
        (second, arguments[1].to_token_stream()),
    ]);
    fn replace(
        tokens: TokenStream,
        replacements: &BTreeMap<String, TokenStream>,
    ) -> Result<TokenStream> {
        let mut output = TokenStream::new();
        let mut iter = tokens.into_iter();
        while let Some(token) = iter.next() {
            match token {
                TokenTree::Punct(p) if p.as_char() == '$' => {
                    let Some(TokenTree::Ident(ident)) = iter.next() else {
                        return Err(Error::new("unsupported owned-type macro repetition"));
                    };
                    output.extend(
                        replacements
                            .get(&ident.to_string())
                            .ok_or_else(|| Error::new("unbound owned-type macro parameter"))?
                            .clone(),
                    );
                }
                TokenTree::Group(group) => {
                    let mut replaced =
                        Group::new(group.delimiter(), replace(group.stream(), replacements)?);
                    replaced.set_span(group.span());
                    output.extend([TokenTree::Group(replaced)]);
                }
                other => output.extend([other]),
            }
        }
        Ok(output)
    }
    let expanded = syn::parse2::<syn::File>(replace(rule.body, &replacements)?).map_err(|e| {
        Error::new(format!(
            "owned-type macro does not produce supported Rust items: {e}"
        ))
    })?;
    let structs = expanded
        .items
        .iter()
        .filter(|item| matches!(item, Item::Struct(_)))
        .count();
    if structs != 1
        || expanded
            .items
            .iter()
            .any(|item| !matches!(item, Item::Struct(_) | Item::Impl(_)))
    {
        return Err(Error::new("owned-type macro must expand to one tuple struct and its inherent/Display implementations"));
    }
    for item in &expanded.items {
        if let Item::Impl(item) = item {
            if item.trait_.as_ref().is_some_and(|(_, path, _)| {
                path.segments
                    .last()
                    .is_none_or(|segment| segment.ident != "Display")
            }) {
                return Err(Error::new("owned-type macro cannot provide custom equality, cloning, or drop implementations"));
            }
        }
    }
    Ok(expanded.items)
}
