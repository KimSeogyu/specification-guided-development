use crate::error::{Error, Result};
use crate::model::Codec;
use crate::source::{conditional, item_attrs, item_name, Database, Definition, Implementation};
use std::collections::BTreeSet;
use syn::parse::Parser;
use syn::punctuated::Punctuated;
use syn::spanned::Spanned;
use syn::{
    Attribute, Expr, Fields, FnArg, ImplItem, Item, Member, ReturnType, Stmt, Token, Type,
    Visibility,
};

pub fn path_parts(path: &syn::Path) -> Result<Vec<String>> {
    if path.leading_colon.is_some()
        || path
            .segments
            .iter()
            .any(|s| !matches!(s.arguments, syn::PathArguments::None))
    {
        return Err(Error::new(
            "generic and qualified source paths are unsupported in owned fields",
        ));
    }
    Ok(path.segments.iter().map(|s| s.ident.to_string()).collect())
}
pub fn type_definition(db: &Database, module: &str, ty: &Type) -> Result<Definition> {
    let Type::Path(path) = ty else {
        return Err(Error::new(
            "owned fields require a primitive or resolved owned value type",
        ));
    };
    if path.qself.is_some() {
        return Err(Error::new("associated source types are unsupported"));
    }
    let mut def = db.resolve(module, &path_parts(&path.path)?)?;
    let mut seen = BTreeSet::new();
    while let Item::Type(alias) = &def.item {
        db.check_scope(&def)?;
        if alias.attrs.iter().any(|attr| !attr.path().is_ident("doc")) {
            return Err(Error::at(
                &def.file,
                alias.span(),
                "conditional or custom attributes on bound aliases are unsupported",
            ));
        }
        let identity = format!("{}::{}", def.module, alias.ident);
        if !seen.insert(identity) || !alias.generics.params.is_empty() {
            return Err(Error::new(
                "cyclic or generic source type aliases are unsupported",
            ));
        }
        let Type::Path(path) = alias.ty.as_ref() else {
            return Err(Error::new(
                "owned source aliases must resolve to a concrete type path",
            ));
        };
        def = db.resolve(&def.module, &path_parts(&path.path)?)?;
    }
    Ok(def)
}
pub fn implementations<'a>(db: &'a Database, definition: &Definition) -> Vec<&'a Implementation> {
    let name = item_name(&definition.item);
    db.implementations
        .iter()
        .filter(|implementation| {
            type_definition(db, &implementation.module, &implementation.item.self_ty).is_ok_and(
                |found| found.module == definition.module && item_name(&found.item) == name,
            )
        })
        .collect()
}
pub fn trait_name(db: &Database, module: &str, path: &syn::Path) -> Result<String> {
    let mut parts: Vec<_> = path
        .segments
        .iter()
        .map(|segment| segment.ident.to_string())
        .collect();
    let mut seen = BTreeSet::new();
    for _ in 0..32 {
        let first = parts
            .first()
            .ok_or_else(|| Error::new("empty trait path"))?
            .clone();
        if !seen.insert(first.clone()) {
            return Err(Error::new("cyclic trait import"));
        }
        if let Some(import) = db.modules[module].imports.get(&first) {
            let mut expanded = import.path.clone();
            expanded.extend_from_slice(&parts[1..]);
            parts = expanded;
        } else {
            break;
        }
    }
    if parts.len() == 1
        && matches!(
            parts[0].as_str(),
            "Clone"
                | "Copy"
                | "PartialEq"
                | "Eq"
                | "Drop"
                | "PartialOrd"
                | "Ord"
                | "Debug"
                | "Hash"
                | "From"
                | "Into"
                | "TryFrom"
                | "TryInto"
                | "Default"
                | "Iterator"
                | "IntoIterator"
        )
    {
        if db.modules[module].definitions.contains_key(&parts[0]) {
            return Err(Error::new("a bound standard trait name is shadowed"));
        }
        return Ok(parts[0].clone());
    }
    if parts.first().is_some_and(|p| p == "std" || p == "core") {
        let root = &db.modules[module].crate_id;
        if db
            .modules
            .values()
            .filter(|scope| &scope.crate_id == root)
            .any(|scope| {
                scope.definitions.contains_key(&parts[0]) || scope.imports.contains_key(&parts[0])
            })
        {
            return Err(Error::new(
                "standard trait prefix is shadowed by a local definition or import",
            ));
        }
        let expected = match parts.last().map(String::as_str) {
            Some("Clone") => "clone",
            Some("Copy") => "marker",
            Some("PartialEq" | "Eq" | "PartialOrd" | "Ord") => "cmp",
            Some("Debug" | "Display") => "fmt",
            Some("Hash") => "hash",
            Some("Drop") => "ops",
            _ => return Ok(format!("standard:{}", parts.join("::"))),
        };
        if parts.len() == 3 && parts[1] == expected {
            return Ok(parts.last().unwrap().clone());
        }
        return Ok(format!("standard:{}", parts.join("::")));
    }
    if let Ok(definition) = db.resolve(module, &parts) {
        db.check_scope(&definition)?;
        if let Item::Trait(item) = definition.item {
            return Ok(format!("local:{}::{}", definition.module, item.ident));
        }
    }
    Ok(format!("unsupported:{}", parts.join("::")))
}
pub fn derives(
    db: &Database,
    definition: &Definition,
    required: &[&str],
) -> Result<BTreeSet<String>> {
    db.check_scope(definition)?;
    let mut names = BTreeSet::new();
    for attr in item_attrs(&definition.item) {
        if attr.path().is_ident("doc") {
            continue;
        }
        if !attr.path().is_ident("derive") {
            return Err(Error::at(
                &definition.file,
                attr.span(),
                "bound owned types support only doc and standard derive attributes",
            ));
        }
        let paths = Punctuated::<syn::Path, Token![,]>::parse_terminated
            .parse2(
                attr.meta
                    .require_list()
                    .map_err(|e| Error::new(e.to_string()))?
                    .tokens
                    .clone(),
            )
            .map_err(|e| Error::new(e.to_string()))?;
        for path in paths {
            let name = trait_name(db, &definition.module, &path)?;
            if !matches!(
                name.as_str(),
                "Clone" | "Copy" | "Debug" | "PartialEq" | "Eq" | "PartialOrd" | "Ord" | "Hash"
            ) {
                return Err(Error::at(
                    &definition.file,
                    path.span(),
                    "custom derives are unsupported for bound owned types",
                ));
            }
            if !names.insert(name) {
                return Err(Error::new("duplicate standard derive on bound source type"));
            }
        }
    }
    if required.iter().any(|name| !names.contains(*name)) {
        return Err(Error::at(
            &definition.file,
            definition.item.span(),
            format!(
                "owned type requires standard derived {}",
                required.join(", ")
            ),
        ));
    }
    for implementation in implementations(db, definition) {
        if implementation.conditional || conditional(&implementation.item.attrs) {
            return Err(Error::at(
                &implementation.file,
                implementation.item.span(),
                "conditional implementations of a bound type are unsupported",
            ));
        }
        if let Some((_, path, _)) = &implementation.item.trait_ {
            let name = trait_name(db, &implementation.module, path)?;
            if name.starts_with("unsupported:") {
                return Err(Error::at(&implementation.file, path.span(), "unresolved trait implementations on bound values are unsupported; resolve the actual trait source"));
            }
            if matches!(name.as_str(), "Drop" | "Clone")
                || (required.contains(&"PartialEq") && matches!(name.as_str(), "PartialEq" | "Eq"))
            {
                return Err(Error::at(
                    &implementation.file,
                    implementation.item.span(),
                    "custom Clone, Drop, or equality invalidates the owned value codec",
                ));
            }
        } else if implementation
            .item
            .items
            .iter()
            .any(|item| matches!(item, ImplItem::Fn(method) if method.sig.ident == "clone"))
        {
            return Err(Error::at(&implementation.file, implementation.item.span(), "inherent clone methods can shadow standard Clone and are unsupported for bound values"));
        }
    }
    Ok(names)
}

fn primitive(db: &Database, module: &str, ty: &Type) -> Result<Option<Codec>> {
    let Type::Path(path) = ty else {
        return Ok(None);
    };
    if path.qself.is_some() {
        return Ok(None);
    }
    let parts = path_parts(&path.path)?;
    if parts.len() != 1 {
        return Ok(None);
    }
    let name = &parts[0];
    if !matches!(name.as_str(), "i64" | "u32" | "bool" | "String") {
        return Ok(None);
    }
    if db.modules[module].definitions.contains_key(name)
        || db.modules[module].imports.contains_key(name)
    {
        return Err(Error::new(format!(
            "bound primitive/prelude name {name} is shadowed"
        )));
    }
    Ok(Some(match name.as_str() {
        "i64" => Codec::I64 { getters: vec![] },
        "u32" => Codec::U32 { getters: vec![] },
        "bool" => Codec::Bool { getters: vec![] },
        "String" => Codec::String { getters: vec![] },
        _ => unreachable!(),
    }))
}
fn plain_attrs(file: &str, attrs: &[Attribute]) -> Result<()> {
    if let Some(attr) = attrs.iter().find(|attr| !attr.path().is_ident("doc")) {
        return Err(Error::at(
            file,
            attr.span(),
            "conditional or custom attributes are unsupported on bound fields and getters",
        ));
    }
    Ok(())
}
fn inner_access(expr: &Expr, string: bool) -> bool {
    let expr = match expr {
        Expr::Paren(x) => x.expr.as_ref(),
        Expr::Group(x) => x.expr.as_ref(),
        _ => expr,
    };
    let expr = if string {
        match expr {
            Expr::Reference(x) if x.mutability.is_none() => x.expr.as_ref(),
            _ => return false,
        }
    } else {
        expr
    };
    matches!(expr, Expr::Field(field) if matches!(&field.member, Member::Unnamed(index) if index.index == 0)
        && matches!(field.base.as_ref(), Expr::Path(path) if path.path.is_ident("self")))
}
pub fn codec(db: &Database, module: &str, ty: &Type, root_crate: &str) -> Result<Codec> {
    codec_inner(db, module, ty, root_crate, &mut BTreeSet::new())
}
fn codec_inner(
    db: &Database,
    module: &str,
    ty: &Type,
    root_crate: &str,
    active: &mut BTreeSet<String>,
) -> Result<Codec> {
    if let Some(codec) = primitive(db, module, ty)? {
        return Ok(codec);
    }
    let definition = type_definition(db, module, ty)?;
    let name = item_name(&definition.item).ok_or_else(|| Error::new("unsupported bound type"))?;
    let key = format!("{}::{name}", definition.module);
    if !active.insert(key.clone()) || active.len() > 4 {
        return Err(Error::new(
            "recursive or excessively deep owned type representation",
        ));
    }
    let derived = derives(db, &definition, &["Clone", "PartialEq", "Eq"])?;
    let result = match &definition.item {
        Item::Enum(item) => {
            if !item.generics.params.is_empty() || item.variants.is_empty() || item.variants.iter().any(|variant| !matches!(variant.fields, Fields::Unit) || variant.discriminant.is_some()) {
                return Err(Error::at(&definition.file, item.span(), "owned enum codec requires nonempty ordinary unit variants"));
            }
            for variant in &item.variants { plain_attrs(&definition.file, &variant.attrs)?; }
            Codec::Enum { getters: vec![], rust_path: db.public_path(&definition, root_crate)?, variants: item.variants.iter().map(|variant| variant.ident.to_string()).collect() }
        }
        Item::Struct(item) => {
            if !item.generics.params.is_empty() || item.generics.where_clause.is_some() { return Err(Error::new("generic owned wrappers are unsupported")); }
            let Fields::Unnamed(fields) = &item.fields else { return Err(Error::at(&definition.file, item.span(), "owned wrapper must have one immutable tuple field")); };
            if fields.unnamed.len() != 1 { return Err(Error::new("owned wrapper must have exactly one representation field")); }
            let field = &fields.unnamed[0]; plain_attrs(&definition.file, &field.attrs)?;
            let mut representation = codec_inner(db, &definition.module, &field.ty, root_crate, active)?;
            let is_string = matches!(&representation, Codec::String { getters } if getters.is_empty());
            let mut getters = Vec::new();
            for implementation in implementations(db, &definition) {
                if implementation.item.trait_.is_some() { continue; }
                for member in &implementation.item.items {
                    let ImplItem::Fn(method) = member else { continue; };
                    if !matches!(method.vis, Visibility::Public(_)) || method.sig.inputs.len() != 1 || !method.sig.generics.params.is_empty() || method.sig.asyncness.is_some() || method.sig.unsafety.is_some() { continue; }
                    let Some(FnArg::Receiver(receiver)) = method.sig.inputs.first() else { continue; };
                    if receiver.mutability.is_some() { continue; }
                    if receiver.reference.is_none() && !derived.contains("Copy") { continue; }
                    let [Stmt::Expr(expr, None)] = method.block.stmts.as_slice() else { continue; };
                    if !inner_access(expr, is_string) { continue; }
                    let ReturnType::Type(_, result) = &method.sig.output else { continue; };
                    let valid_result = if is_string {
                        matches!(result.as_ref(), Type::Reference(reference) if reference.mutability.is_none() && matches!(reference.elem.as_ref(), Type::Path(path) if path.path.is_ident("str")))
                    } else {
                        let lhs = codec_inner(db, &implementation.module, result, root_crate, &mut BTreeSet::new())?;
                        serde_json::to_value(&lhs).ok() == serde_json::to_value(&representation).ok()
                    };
                    if valid_result { plain_attrs(&implementation.file, &method.attrs)?; getters.push(method.sig.ident.to_string()); }
                }
            }
            getters.sort(); getters.dedup();
            let getter = getters.into_iter().next().ok_or_else(|| Error::at(&definition.file, item.span(), "owned wrapper requires a public no-argument getter that returns its exact private representation"))?;
            representation.prepend(getter);
            representation
        }
        _ => return Err(Error::new("owned codec does not accept aliases, references, collections, or shared mutable objects")),
    };
    active.remove(&key);
    Ok(result)
}

pub fn check_fact_ownership(db: &Database, definition: &Definition) -> Result<()> {
    derives(db, definition, &["Clone"])?;
    let Item::Struct(item) = &definition.item else {
        return Err(Error::new(
            "a bound Fact must be a concrete named-field struct",
        ));
    };
    if !item.generics.params.is_empty()
        || item.generics.where_clause.is_some()
        || !matches!(item.vis, Visibility::Public(_))
    {
        return Err(Error::new(
            "a bound Fact must be a public non-generic concrete struct",
        ));
    }
    let Fields::Named(fields) = &item.fields else {
        return Err(Error::new("a bound Fact must have named fields"));
    };
    if fields.named.is_empty() {
        return Err(Error::new("a bound Fact cannot be empty"));
    }
    for field in &fields.named {
        plain_attrs(&definition.file, &field.attrs)?;
        if !matches!(field.vis, Visibility::Public(_)) {
            return Err(Error::at(
                &definition.file,
                field.span(),
                "whole-row adapter requires public immutable-value fields",
            ));
        }
    }
    Ok(())
}
