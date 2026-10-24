use crate::error::{Error, Result};
use crate::model::SourceIdentity;
use crate::targets::{CargoScope, Target};
use proc_macro2::Span;
use quote::ToTokens;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use syn::spanned::Spanned;
use syn::{Attribute, Expr, Item, Pat, ReturnType, Stmt, Type, UseTree};

/// Evidence for the unconditional, closed Rust source language only.
/// It never grants storage authority and is not an application build result.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceScopeReport {
    version: u8,
    profile: &'static str,
    scope: &'static str,
    storage_authority: bool,
    trusted_boundary: Vec<&'static str>,
    targets: Vec<TargetEvidence>,
    sources: Vec<SourceIdentity>,
    references: Vec<ReferenceEvidence>,
}
impl SourceScopeReport {
    pub fn storage_authority(&self) -> bool {
        false
    }
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TargetEvidence {
    package_id: String,
    name: String,
    kind: String,
    crate_name: String,
    source: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReferenceEvidence {
    target: String,
    file: String,
    line: usize,
    column: usize,
    usage: &'static str,
    spelling: String,
    resolved: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
enum Data {
    Unit,
    Bool,
    Number,
    Char,
    Str,
    Tuple(Vec<Data>),
    Array(Box<Data>),
    Reference(Box<Data>),
}
#[derive(Clone, Debug, PartialEq, Eq)]
enum Value {
    Data(Data),
    Function(usize),
}
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct ModuleId {
    target: usize,
    path: Vec<String>,
}
#[derive(Clone)]
enum Name {
    Module(ModuleId),
    Function(usize),
    Constant(Data),
    Import(Vec<String>, bool),
}
#[derive(Clone)]
struct Module {
    file: String,
    names: BTreeMap<String, Name>,
    public: BTreeSet<String>,
}
#[derive(Clone)]
struct Function {
    module: ModuleId,
    file: String,
    item: syn::ItemFn,
}
#[derive(Clone)]
struct Signature {
    arguments: Vec<Data>,
    output: Data,
}
#[derive(Clone)]
enum Resolved {
    Module(ModuleId),
    Function(usize),
    Constant(Data),
    External(Vec<String>),
}
struct Checker {
    modules: BTreeMap<ModuleId, Module>,
    functions: Vec<Function>,
    signatures: Vec<Signature>,
    targets: Vec<Target>,
    references: Vec<ReferenceEvidence>,
}

pub fn analyze_source_scope(root: &Path) -> Result<SourceScopeReport> {
    let mut scope = CargoScope::capture(root)?;
    let mut checker = Checker {
        modules: BTreeMap::new(),
        functions: Vec::new(),
        signatures: Vec::new(),
        targets: scope.targets.clone(),
        references: Vec::new(),
    };
    for (index, target) in checker.targets.clone().iter().enumerate() {
        let directory = target
            .source
            .parent()
            .ok_or_else(|| Error::scope("target source has no parent"))?;
        checker.load_module(
            &mut scope,
            ModuleId {
                target: index,
                path: vec![],
            },
            &target.source,
            directory,
            None,
        )?;
    }
    for function in &checker.functions {
        checker
            .signatures
            .push(signature(&function.file, &function.item)?);
    }
    for index in 0..checker.functions.len() {
        checker.check_function(index)?;
    }
    // Unused imports are part of the closed source scope too. Body inspection first
    // retains the exact reexport/function-value chain for the writer probe.
    for (id, module) in checker.modules.clone() {
        for (name, binding) in &module.names {
            if let Name::Import(path, absolute) = binding {
                let resolved = checker.resolve(&id, path, *absolute, 0)?;
                checker.reference(&id, Span::call_site(), "import", name, resolved)?;
            }
        }
    }
    scope.recheck()?;
    Ok(SourceScopeReport {
        version: 1,
        profile: "rust-source-scope-v1",
        scope: "all-discovered-targets-unconditional-closed-source",
        storage_authority: false,
        trusted_boundary: vec![
            "inherited-global-cargo-config-environment-toolchain-cache-platform",
            "standard-prelude-builtin-operators-panic-runtime",
            "toolchain-generated-test-and-bench-harness-not-analyzed",
        ],
        targets: checker
            .targets
            .iter()
            .map(|t| TargetEvidence {
                package_id: t.package_id.clone(),
                name: t.name.clone(),
                kind: t.kind.clone(),
                crate_name: t.crate_name.clone(),
                source: t
                    .source
                    .strip_prefix(scope.root())
                    .unwrap_or(&t.source)
                    .to_string_lossy()
                    .replace('\\', "/"),
            })
            .collect(),
        sources: scope.identities(),
        references: checker.references,
    })
}

fn reserved(name: &str) -> bool {
    name.starts_with("r#")
        || matches!(
            name,
            "std"
                | "core"
                | "alloc"
                | "bool"
                | "char"
                | "str"
                | "i8"
                | "i16"
                | "i32"
                | "i64"
                | "i128"
                | "isize"
                | "u8"
                | "u16"
                | "u32"
                | "u64"
                | "u128"
                | "usize"
                | "f32"
                | "f64"
        )
}
fn attrs(file: &str, attributes: &[Attribute]) -> Result<()> {
    for attr in attributes {
        let valid = if attr.path().is_ident("doc") {
            // Rustdoc can turn both fenced and indented Markdown into executable
            // tests absent from Cargo metadata. No documentation input is admitted
            // until its execution scope is independently represented.
            false
        } else if ["allow", "warn", "deny", "forbid"]
            .iter()
            .any(|x| attr.path().is_ident(x))
        {
            use syn::parse::Parser;
            match &attr.meta {
                syn::Meta::List(list) => {
                    syn::punctuated::Punctuated::<syn::Path, syn::Token![,]>::parse_terminated
                        .parse2(list.tokens.clone())
                        .is_ok()
                }
                _ => false,
            }
        } else {
            false
        };
        if !valid {
            return Err(Error::scope_at(file, attr.span(), format!("unsupported attribute/source view {}; documentation/doctest, cfg, test, feature and macro views are not evaluated", attr.path().to_token_stream())));
        }
    }
    Ok(())
}
fn path_parts(file: &str, path: &syn::Path) -> Result<(Vec<String>, bool)> {
    if path
        .segments
        .iter()
        .any(|s| !matches!(s.arguments, syn::PathArguments::None))
    {
        return Err(Error::scope_at(
            file,
            path.span(),
            "generic/associated reference syntax is unsupported",
        ));
    }
    Ok((
        path.segments.iter().map(|s| s.ident.to_string()).collect(),
        path.leading_colon.is_some(),
    ))
}
fn data_type(file: &str, ty: &Type) -> Result<Data> {
    match ty {
        Type::Tuple(t) => {
            let values = t.elems.iter().map(|v| data_type(file,v)).collect::<Result<Vec<_>>>()?;
            Ok(if values.is_empty() { Data::Unit } else { Data::Tuple(values) })
        }
        Type::Paren(t) => data_type(file,&t.elem),
        Type::Group(t) => data_type(file,&t.elem),
        Type::Reference(t) if t.mutability.is_none() && t.lifetime.is_none() => Ok(Data::Reference(Box::new(data_type(file,&t.elem)?))),
        Type::Array(t) => { literal_length(file,&t.len)?; Ok(Data::Array(Box::new(data_type(file,&t.elem)?))) }
        Type::Slice(t) => Ok(Data::Array(Box::new(data_type(file,&t.elem)?))),
        Type::Path(p) if p.qself.is_none() && p.path.leading_colon.is_none() && p.path.segments.len() == 1 => {
            let (parts,_) = path_parts(file,&p.path)?;
            match parts[0].as_str() {
                "bool" => Ok(Data::Bool), "char" => Ok(Data::Char), "str" => Ok(Data::Str),
                "i8"|"i16"|"i32"|"i64"|"i128"|"isize"|"u8"|"u16"|"u32"|"u64"|"u128"|"usize"|"f32"|"f64" => Ok(Data::Number),
                _ => Err(Error::scope_at(file,ty.span(),"only primitive/unit/tuple/array/immutable-reference data is admitted; nominal/foreign types and lifecycle are unsupported")),
            }
        }
        _ => Err(Error::scope_at(file,ty.span(),"unsupported data type; callbacks, generic/trait/nominal/foreign types and mutable references are not admitted")),
    }
}
fn literal_length(file: &str, expr: &Expr) -> Result<()> {
    if let Expr::Lit(literal) = expr {
        attrs(file, &literal.attrs)?;
    }
    if matches!(expr, Expr::Lit(l) if matches!(&l.lit,syn::Lit::Int(n) if n.base10_parse::<usize>().is_ok()))
    {
        Ok(())
    } else {
        Err(Error::scope_at(
            file,
            expr.span(),
            "array length must be an integer literal",
        ))
    }
}
fn signature(file: &str, item: &syn::ItemFn) -> Result<Signature> {
    attrs(file, &item.attrs)?;
    let s = &item.sig;
    if s.asyncness.is_some()
        || s.unsafety.is_some()
        || s.abi.is_some()
        || s.variadic.is_some()
        || !s.generics.params.is_empty()
        || s.generics.where_clause.is_some()
    {
        return Err(Error::scope_at(
            file,
            s.span(),
            "only safe nongeneric free functions without ABI/async/variadic are admitted",
        ));
    }
    let mut arguments = vec![];
    for arg in &s.inputs {
        let syn::FnArg::Typed(arg) = arg else {
            return Err(Error::scope_at(
                file,
                arg.span(),
                "receiver dispatch is unsupported",
            ));
        };
        attrs(file, &arg.attrs)?;
        pattern(file, &arg.pat)?;
        arguments.push(data_type(file, &arg.ty)?);
    }
    let output = match &s.output {
        ReturnType::Default => Data::Unit,
        ReturnType::Type(_, t) => data_type(file, t)?,
    };
    Ok(Signature { arguments, output })
}
fn pattern(file: &str, pat: &Pat) -> Result<Option<String>> {
    match pat {
        Pat::Ident(p) if p.by_ref.is_none() && p.mutability.is_none() && p.subpat.is_none() => {
            attrs(file, &p.attrs)?;
            Ok(Some(p.ident.to_string()))
        }
        Pat::Wild(p) => {
            attrs(file, &p.attrs)?;
            Ok(None)
        }
        _ => Err(Error::scope_at(
            file,
            pat.span(),
            "only immutable identifier/wildcard patterns are admitted",
        )),
    }
}
fn imports(
    file: &str,
    tree: &UseTree,
    prefix: Vec<String>,
    output: &mut Vec<(String, Vec<String>)>,
) -> Result<()> {
    match tree {
        UseTree::Path(p) => {
            let mut path = prefix;
            path.push(p.ident.to_string());
            imports(file, &p.tree, path, output)
        }
        UseTree::Name(n) => {
            let mut path = prefix;
            let name = n.ident.to_string();
            if name == "self" {
                let alias = path
                    .last()
                    .cloned()
                    .ok_or_else(|| Error::scope("empty self import"))?;
                output.push((alias, path));
            } else {
                path.push(name.clone());
                output.push((name, path));
            }
            Ok(())
        }
        UseTree::Rename(n) => {
            let mut path = prefix;
            if n.ident != "self" {
                path.push(n.ident.to_string());
            }
            output.push((n.rename.to_string(), path));
            Ok(())
        }
        UseTree::Group(g) => {
            for x in &g.items {
                imports(file, x, prefix.clone(), output)?;
            }
            Ok(())
        }
        UseTree::Glob(g) => Err(Error::scope_at(
            file,
            g.span(),
            "glob imports are unsupported",
        )),
    }
}

impl Checker {
    fn load_module(
        &mut self,
        scope: &mut CargoScope,
        id: ModuleId,
        source: &Path,
        directory: &Path,
        inline: Option<(String, Vec<Item>)>,
    ) -> Result<()> {
        if id.path.len() > 32 || self.modules.len() > 512 {
            return Err(Error::scope("source module limit exceeded"));
        }
        if self.modules.contains_key(&id) {
            return Err(Error::scope("ambiguous target module identity"));
        }
        let (file, items) = if let Some(value) = inline {
            value
        } else {
            let (file, text) = scope.read_source(source)?;
            let parsed = syn::parse_file(&text).map_err(|e| {
                Error::scope_at(&file, e.span(), format!("cannot parse source: {e}"))
            })?;
            attrs(&file, &parsed.attrs)?;
            (file, parsed.items)
        };
        self.modules.insert(
            id.clone(),
            Module {
                file: file.clone(),
                names: BTreeMap::new(),
                public: BTreeSet::new(),
            },
        );
        for item in items {
            match item {
                Item::Fn(f)=>{
                    let name=f.sig.ident.to_string();
                    let index=self.functions.len();
                    self.insert(&id,&name,Name::Function(index),f.sig.ident.span(),&f.vis)?;
                    self.functions.push(Function { module:id.clone(),file:file.clone(),item:f });
                }
                Item::Mod(m)=>{
                    attrs(&file,&m.attrs)?;
                    if m.unsafety.is_some() { return Err(Error::scope_at(&file,m.span(),"unsafe module is unsupported")); }
                    let name=m.ident.to_string();
                    let mut child=id.clone(); child.path.push(name.clone());
                    self.insert(&id,&name,Name::Module(child.clone()),m.ident.span(),&m.vis)?;
                    let child_dir=directory.join(&name);
                    if let Some((_,items))=m.content {
                        self.load_module(scope,child,source,&child_dir,Some((file.clone(),items)))?;
                    } else {
                        let flat=directory.join(format!("{name}.rs"));
                        let nested=child_dir.join("mod.rs");
                        let flat_exists=scope.probe(&flat)?;
                        let nested_exists=scope.probe(&nested)?;
                        let path=match (flat_exists,nested_exists) {
                            (true,false)=>flat, (false,true)=>nested,
                            _=>return Err(Error::scope_at(&file,m.ident.span(),format!("module {name} is missing or has ambiguous file layouts"))),
                        };
                        self.load_module(scope,child,&path,&child_dir,None)?;
                    }
                }
                Item::Use(u)=>{
                    attrs(&file,&u.attrs)?;
                    let mut entries=vec![]; imports(&file,&u.tree,vec![],&mut entries)?;
                    for (alias,path) in entries { self.insert(&id,&alias,Name::Import(path,u.leading_colon.is_some()),u.span(),&u.vis)?; }
                }
                Item::Const(c)=>{
                    attrs(&file,&c.attrs)?;
                    if !c.generics.params.is_empty() || c.generics.where_clause.is_some() { return Err(Error::scope_at(&file,c.span(),"generic constant is unsupported")); }
                    let ty=data_type(&file,&c.ty)?;
                    let value=self.literal(&file,&c.expr)?;
                    require(&file,c.span(),&value,&ty)?;
                    self.insert(&id,&c.ident.to_string(),Name::Constant(ty),c.ident.span(),&c.vis)?;
                }
                other=>return Err(Error::scope_at(&file,other.span(),"unsupported item in closed source scope; nominal types, impls, traits, macros, statics and foreign items require separate admission")),
            }
        }
        Ok(())
    }
    fn insert(
        &mut self,
        id: &ModuleId,
        name: &str,
        binding: Name,
        span: Span,
        visibility: &syn::Visibility,
    ) -> Result<()> {
        let module = self
            .modules
            .get_mut(id)
            .expect("module inserted before names");
        if reserved(name) || name == "_" || module.names.insert(name.into(), binding).is_some() {
            return Err(Error::scope_at(
                &module.file,
                span,
                format!("reserved/shadowed or duplicate source binding {name}"),
            ));
        }
        if matches!(visibility, syn::Visibility::Public(_)) {
            module.public.insert(name.into());
        } else if !matches!(visibility, syn::Visibility::Inherited) {
            return Err(Error::scope_at(
                &module.file,
                span,
                "restricted visibility is unsupported in closed source scope",
            ));
        }
        Ok(())
    }
    fn resolve(
        &self,
        id: &ModuleId,
        parts: &[String],
        absolute: bool,
        depth: usize,
    ) -> Result<Resolved> {
        let file = &self
            .modules
            .get(id)
            .ok_or_else(|| Error::scope("unknown source module"))?
            .file;
        if depth > 64 || parts.is_empty() {
            return Err(Error::scope_at(
                file,
                Span::call_site(),
                "cyclic/empty or excessively deep source reference",
            ));
        }
        let first = parts[0].as_str();
        let (base, consumed) = if absolute {
            (self.external_root(id, first)?, 1)
        } else if first == "crate" {
            (
                Resolved::Module(ModuleId {
                    target: id.target,
                    path: vec![],
                }),
                1,
            )
        } else if first == "self" {
            (Resolved::Module(id.clone()), 1)
        } else if first == "super" {
            let mut parent = id.clone();
            parent.path.pop().ok_or_else(|| {
                Error::scope_at(file, Span::call_site(), "super escapes target crate root")
            })?;
            (Resolved::Module(parent), 1)
        } else {
            let module = &self.modules[id];
            if let Some(name) = module.names.get(first) {
                (self.name(id, name, depth + 1)?, 1)
            } else {
                (self.external_root(id, first)?, 1)
            }
        };
        self.follow(base, &parts[consumed..], depth + 1, id)
    }
    fn name(&self, id: &ModuleId, name: &Name, depth: usize) -> Result<Resolved> {
        Ok(match name {
            Name::Module(m) => Resolved::Module(m.clone()),
            Name::Function(f) => Resolved::Function(*f),
            Name::Constant(t) => Resolved::Constant(t.clone()),
            Name::Import(path, absolute) => return self.resolve(id, path, *absolute, depth + 1),
        })
    }
    fn external_root(&self, id: &ModuleId, name: &str) -> Result<Resolved> {
        if matches!(name, "std" | "core" | "alloc") {
            return Ok(Resolved::External(vec![name.into()]));
        }
        if let Some(target) = self.targets[id.target].externs.get(name) {
            return Ok(Resolved::Module(ModuleId {
                target: *target,
                path: vec![],
            }));
        }
        Err(Error::scope_at(&self.modules[id].file,Span::call_site(),format!("unresolved or foreign reference root {name}; no trusted-name purity summaries exist")))
    }
    fn follow(
        &self,
        base: Resolved,
        remaining: &[String],
        depth: usize,
        requester: &ModuleId,
    ) -> Result<Resolved> {
        if depth > 64 {
            return Err(Error::scope("reference/import depth exceeds 64"));
        }
        if remaining.is_empty() {
            return Ok(base);
        }
        match base {
            Resolved::External(mut path) => {
                path.extend_from_slice(remaining);
                Ok(Resolved::External(path))
            }
            Resolved::Module(id) => {
                let module = &self.modules[&id];
                if remaining[0] == "super" {
                    let mut parent = id.clone();
                    parent
                        .path
                        .pop()
                        .ok_or_else(|| Error::scope("super escapes target root"))?;
                    return self.follow(
                        Resolved::Module(parent),
                        &remaining[1..],
                        depth + 1,
                        requester,
                    );
                }
                let visible = module.public.contains(&remaining[0])
                    || requester.target == id.target && requester.path.starts_with(&id.path);
                if !visible {
                    return Err(Error::scope_at(
                        &module.file,
                        Span::call_site(),
                        format!("private/ambiguous cross-module reference {}", remaining[0]),
                    ));
                }
                let name = module.names.get(&remaining[0]).ok_or_else(|| {
                    Error::scope_at(
                        &module.file,
                        Span::call_site(),
                        format!("unresolved source member {}", remaining[0]),
                    )
                })?;
                self.follow(
                    self.name(&id, name, depth + 1)?,
                    &remaining[1..],
                    depth + 1,
                    requester,
                )
            }
            _ => Err(Error::scope(
                "associated/trait/value-member dispatch is unsupported",
            )),
        }
    }
    fn qualified(&self, index: usize) -> String {
        let f = &self.functions[index];
        let t = &self.targets[f.module.target];
        format!(
            "{} [{}:{}]::crate::{}{}",
            t.package_id,
            t.kind,
            t.name,
            if f.module.path.is_empty() {
                String::new()
            } else {
                format!("{}::", f.module.path.join("::"))
            },
            f.item.sig.ident
        )
    }
    fn reference(
        &mut self,
        id: &ModuleId,
        span: Span,
        usage: &'static str,
        spelling: &str,
        resolved: Resolved,
    ) -> Result<Value> {
        let file = self.modules[id].file.clone();
        let value = match resolved {
            Resolved::External(path) => {
                let full = path.join("::");
                let class = match path.get(1).map(String::as_str) {
                    Some("fs") => "raw filesystem effect/reference",
                    Some("io") => "raw IO effect/reference",
                    Some("process") => "raw process effect/reference",
                    Some("net") => "raw network effect/reference",
                    Some("os") => "raw platform effect/reference",
                    _ => "unsupported foreign reference",
                };
                return Err(Error::scope_at(
                    &file,
                    span,
                    format!(
                        "{class}: {spelling} -> {full} ({usage}); storage authority is not granted"
                    ),
                ));
            }
            Resolved::Function(index) => Value::Function(index),
            Resolved::Constant(ty) => Value::Data(ty),
            Resolved::Module(_) if usage == "import" => return Ok(Value::Data(Data::Unit)),
            Resolved::Module(_) => {
                return Err(Error::scope_at(
                    &file,
                    span,
                    "a module is not an admitted executable value",
                ))
            }
        };
        let resolved = match &value {
            Value::Function(f) => self.qualified(*f),
            Value::Data(_) => format!("constant:{spelling}"),
        };
        let start = span.start();
        self.references.push(ReferenceEvidence {
            target: self.targets[id.target].name.clone(),
            file,
            line: start.line.max(1),
            column: start.column + 1,
            usage,
            spelling: spelling.into(),
            resolved,
        });
        Ok(value)
    }
    fn check_function(&mut self, index: usize) -> Result<()> {
        let function = self.functions[index].clone();
        let sig = self.signatures[index].clone();
        let mut env = BTreeMap::new();
        for (arg, ty) in function.item.sig.inputs.iter().zip(&sig.arguments) {
            let syn::FnArg::Typed(arg) = arg else {
                unreachable!()
            };
            if let Some(name) = pattern(&function.file, &arg.pat)? {
                if reserved(&name) || env.insert(name.clone(), Value::Data(ty.clone())).is_some() {
                    return Err(Error::scope_at(
                        &function.file,
                        arg.span(),
                        format!("duplicate or reserved parameter {name}"),
                    ));
                }
            }
        }
        let value = self.block(
            &function.module,
            &function.item.block,
            &mut env,
            &sig.output,
        )?;
        require(
            &function.file,
            function.item.block.span(),
            &value,
            &sig.output,
        )
    }
    fn block(
        &mut self,
        id: &ModuleId,
        block: &syn::Block,
        outer: &mut BTreeMap<String, Value>,
        output: &Data,
    ) -> Result<Value> {
        let file = self.modules[id].file.clone();
        let mut env = outer.clone();
        let mut result = Value::Data(Data::Unit);
        for stmt in &block.stmts {
            result = match stmt {
                Stmt::Local(local) => {
                    attrs(&file, &local.attrs)?;
                    let init = local.init.as_ref().ok_or_else(|| {
                        Error::scope_at(&file, local.span(), "uninitialized locals are unsupported")
                    })?;
                    if init.diverge.is_some() {
                        return Err(Error::scope_at(
                            &file,
                            init.expr.span(),
                            "let-else is unsupported",
                        ));
                    }
                    // Resolve the initializer first. An annotation cannot hide the
                    // canonical identity of a function-value writer reference.
                    let value = self.expr(id, &init.expr, &mut env, output)?;
                    let (pat, annotation) = match &local.pat {
                        Pat::Type(p) => {
                            attrs(&file, &p.attrs)?;
                            (&*p.pat, Some(&*p.ty))
                        }
                        p => (p, None),
                    };
                    let name = pattern(&file, pat)?;
                    if let Some(ty) = annotation {
                        self.annotation(&file, ty, &value)?;
                    }
                    if let Some(name) = name {
                        if reserved(&name) {
                            return Err(Error::scope_at(
                                &file,
                                pat.span(),
                                "reserved primitive/standard namespace local shadow",
                            ));
                        }
                        env.insert(name, value);
                    }
                    Value::Data(Data::Unit)
                }
                Stmt::Expr(expr, semi) => {
                    let value = self.expr(id, expr, &mut env, output)?;
                    if semi.is_some() {
                        Value::Data(Data::Unit)
                    } else {
                        value
                    }
                }
                _ => {
                    return Err(Error::scope_at(
                        &file,
                        stmt.span(),
                        "nested items and statement macros are unsupported",
                    ))
                }
            };
        }
        Ok(result)
    }
    fn annotation(&self, file: &str, ty: &Type, value: &Value) -> Result<()> {
        if let (Type::BareFn(f), Value::Function(index)) = (ty, value) {
            if f.unsafety.is_some()
                || f.abi.is_some()
                || f.lifetimes.is_some()
                || f.variadic.is_some()
            {
                return Err(Error::scope_at(
                    file,
                    ty.span(),
                    "unsafe/ABI/generic callable annotation is unsupported",
                ));
            }
            let sig = &self.signatures[*index];
            let mut arguments = vec![];
            for a in &f.inputs {
                attrs(file, &a.attrs)?;
                arguments.push(data_type(file, &a.ty)?);
            }
            let output = match &f.output {
                ReturnType::Default => Data::Unit,
                ReturnType::Type(_, t) => data_type(file, t)?,
            };
            if arguments == sig.arguments && output == sig.output {
                return Ok(());
            }
            return Err(Error::scope_at(
                file,
                ty.span(),
                "immutable function alias annotation does not match its resolved function",
            ));
        }
        require(file, ty.span(), value, &data_type(file, ty)?)
    }
    fn literal(&self, file: &str, expr: &Expr) -> Result<Value> {
        let Expr::Lit(l) = expr else {
            return Err(Error::scope_at(
                file,
                expr.span(),
                "constant initializer must be a primitive literal",
            ));
        };
        attrs(file, &l.attrs)?;
        let ty = match &l.lit {
            syn::Lit::Bool(_) => Data::Bool,
            syn::Lit::Char(_) => Data::Char,
            syn::Lit::Str(_) => Data::Reference(Box::new(Data::Str)),
            syn::Lit::Byte(_) => Data::Number,
            syn::Lit::ByteStr(_) => Data::Reference(Box::new(Data::Array(Box::new(Data::Number)))),
            syn::Lit::Int(n)
                if n.suffix().is_empty()
                    || matches!(
                        n.suffix(),
                        "i8" | "i16"
                            | "i32"
                            | "i64"
                            | "i128"
                            | "isize"
                            | "u8"
                            | "u16"
                            | "u32"
                            | "u64"
                            | "u128"
                            | "usize"
                    ) =>
            {
                Data::Number
            }
            syn::Lit::Float(n) if n.suffix().is_empty() || matches!(n.suffix(), "f32" | "f64") => {
                Data::Number
            }
            _ => {
                return Err(Error::scope_at(
                    file,
                    l.span(),
                    "unsupported literal/suffix",
                ))
            }
        };
        Ok(Value::Data(ty))
    }
    fn expr(
        &mut self,
        id: &ModuleId,
        expr: &Expr,
        env: &mut BTreeMap<String, Value>,
        output: &Data,
    ) -> Result<Value> {
        let file = self.modules[id].file.clone();
        match expr {
            Expr::Lit(_)=>self.literal(&file,expr),
            Expr::Path(p) if p.qself.is_none()=>{
                attrs(&file,&p.attrs)?;
                let (path,absolute)=path_parts(&file,&p.path)?;
                let spelling=p.path.to_token_stream().to_string().replace(" ","");
                if !absolute {
                    if let Some(value)=env.get(&path[0]).cloned() {
                        if path.len()!=1 { return Err(Error::scope_at(&file,p.span(),"local value-member/associated dispatch is unsupported")); }
                        return match value {
                            Value::Function(f)=>self.reference(id,p.span(),"functionValue",&spelling,Resolved::Function(f)),
                            data=>Ok(data),
                        };
                    }
                }
                let resolved=self.resolve(id,&path,absolute,0)?;
                self.reference(id,p.span(),"functionValue",&spelling,resolved)
            }
            Expr::Paren(e)=>{attrs(&file,&e.attrs)?;self.expr(id,&e.expr,env,output)},
            Expr::Group(e)=>{attrs(&file,&e.attrs)?;self.expr(id,&e.expr,env,output)},
            Expr::Block(e) if e.label.is_none()=>{attrs(&file,&e.attrs)?;self.block(id,&e.block,env,output)},
            Expr::Call(e)=>{
                attrs(&file,&e.attrs)?;
                let value=self.expr(id,&e.func,env,output)?;
                let Value::Function(f)=value else { return Err(Error::scope_at(&file,e.func.span(),"callable identity is not a resolved immutable local function")); };
                let sig=self.signatures[f].clone();
                if e.args.len()!=sig.arguments.len() { return Err(Error::scope_at(&file,e.span(),"call arity differs from resolved local function")); }
                for (arg,ty) in e.args.iter().zip(&sig.arguments) {
                    let value=self.expr(id,arg,env,output)?;
                    require(&file,arg.span(),&value,ty)?;
                }
                Ok(Value::Data(sig.output))
            }
            Expr::Binary(e)=>{
                attrs(&file,&e.attrs)?;
                let left=self.expr(id,&e.left,env,output)?;
                let right=self.expr(id,&e.right,env,output)?;
                let (Value::Data(a),Value::Data(b))=(left,right) else { return Err(Error::scope_at(&file,e.span(),"function values cannot be operator operands")); };
                use syn::BinOp::*;
                let ty=match &e.op {
                    Add(_)|Sub(_)|Mul(_)|Div(_)|Rem(_)|Shl(_)|Shr(_) if a==Data::Number&&b==Data::Number=>Data::Number,
                    BitXor(_)|BitAnd(_)|BitOr(_) if a==b&&matches!(a,Data::Number|Data::Bool)=>a,
                    And(_)|Or(_) if a==Data::Bool&&b==Data::Bool=>Data::Bool,
                    Eq(_)|Ne(_) if a==b&&matches!(a,Data::Number|Data::Bool|Data::Char|Data::Unit)=>Data::Bool,
                    Lt(_)|Le(_)|Gt(_)|Ge(_) if a==b&&matches!(a,Data::Number|Data::Char)=>Data::Bool,
                    _=>return Err(Error::scope_at(&file,e.span(),"unsupported operator or nonprimitive operands; overloaded/assignment dispatch is not admitted")),
                };
                Ok(Value::Data(ty))
            }
            Expr::Unary(e)=>{
                attrs(&file,&e.attrs)?;
                let Value::Data(value)=self.expr(id,&e.expr,env,output)? else { return Err(Error::scope_at(&file,e.span(),"function value unary operation is unsupported")); };
                let ty=match (&e.op,value) {
                    (syn::UnOp::Neg(_),Data::Number)=>Data::Number,
                    (syn::UnOp::Not(_),v) if matches!(v,Data::Number|Data::Bool)=>v,
                    (syn::UnOp::Deref(_),Data::Reference(inner))=>*inner,
                    _=>return Err(Error::scope_at(&file,e.span(),"unsupported unary operand; unknown Deref/operator dispatch is not admitted")),
                };
                Ok(Value::Data(ty))
            }
            Expr::If(e)=>{
                attrs(&file,&e.attrs)?;
                let cond=self.expr(id,&e.cond,env,output)?; require(&file,e.cond.span(),&cond,&Data::Bool)?;
                let then=self.block(id,&e.then_branch,env,output)?;
                let otherwise=if let Some((_,branch))=&e.else_branch { self.expr(id,branch,env,output)? }else{Value::Data(Data::Unit)};
                if then!=otherwise || matches!(then,Value::Function(_)) { return Err(Error::scope_at(&file,e.span(),"branches require the same primitive data shape; conditional function identities are unsupported")); }
                Ok(then)
            }
            Expr::Return(e)=>{
                attrs(&file,&e.attrs)?;
                let value=if let Some(expr)=&e.expr { self.expr(id,expr,env,output)? } else { Value::Data(Data::Unit) };
                require(&file,e.span(),&value,output)?; Ok(value)
            }
            Expr::Tuple(e)=>{
                attrs(&file,&e.attrs)?;
                let mut values=vec![];
                for element in &e.elems { values.push(only_data(&file,element.span(),self.expr(id,element,env,output)?)?); }
                Ok(Value::Data(if values.is_empty(){Data::Unit}else{Data::Tuple(values)}))
            }
            Expr::Array(e)=>{
                attrs(&file,&e.attrs)?;
                let mut ty=None;
                for element in &e.elems {
                    let value=only_data(&file,element.span(),self.expr(id,element,env,output)?)?;
                    if ty.as_ref().is_some_and(|previous|previous!=&value) { return Err(Error::scope_at(&file,e.span(),"array primitive shapes must agree")); }
                    ty=Some(value);
                }
                let ty=ty.ok_or_else(||Error::scope_at(&file,e.span(),"empty array requires unsupported element inference"))?;
                Ok(Value::Data(Data::Array(Box::new(ty))))
            }
            Expr::Repeat(e)=>{
                attrs(&file,&e.attrs)?; literal_length(&file,&e.len)?;
                let value=only_data(&file,e.expr.span(),self.expr(id,&e.expr,env,output)?)?;
                Ok(Value::Data(Data::Array(Box::new(value))))
            }
            Expr::Reference(e) if e.mutability.is_none()=>{
                attrs(&file,&e.attrs)?;
                let value=only_data(&file,e.expr.span(),self.expr(id,&e.expr,env,output)?)?;
                Ok(Value::Data(Data::Reference(Box::new(value))))
            }
            Expr::Field(e)=>{
                attrs(&file,&e.attrs)?;
                let base=only_data(&file,e.base.span(),self.expr(id,&e.base,env,output)?)?;
                if let (Data::Tuple(values),syn::Member::Unnamed(index))=(base,&e.member) {
                    return values.get(index.index as usize).cloned().map(Value::Data).ok_or_else(||Error::scope_at(&file,e.span(),"tuple field out of range"));
                }
                Err(Error::scope_at(&file,e.span(),"nominal/receiver field access is unsupported"))
            }
            _=>Err(Error::scope_at(&file,expr.span(),"unsupported expression in closed source scope; receiver/trait/macro/foreign/unsafe/closure/loop/assignment dispatch is not admitted")),
        }
    }
}
fn only_data(file: &str, span: Span, value: Value) -> Result<Data> {
    match value {
        Value::Data(d) => Ok(d),
        Value::Function(_) => Err(Error::scope_at(
            file,
            span,
            "function-value escape into a data aggregate/reference is unsupported",
        )),
    }
}
fn require(file: &str, span: Span, value: &Value, expected: &Data) -> Result<()> {
    if value == &Value::Data(expected.clone()) {
        Ok(())
    } else {
        Err(Error::scope_at(
            file,
            span,
            "primitive data shape mismatch or unsupported function-value escape",
        ))
    }
}
