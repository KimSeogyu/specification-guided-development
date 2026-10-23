use crate::codec::{implementations, path_parts, trait_name};
use crate::error::{Error, Result};
use crate::source::{conditional, Database, Definition};
use std::collections::{BTreeMap, BTreeSet};
use syn::parse::{Parse, ParseStream};
use syn::spanned::Spanned;
use syn::{Expr, FnArg, ImplItem, Item, Member, Pat, ReturnType, Stmt, Token, Type};

pub type EqualFields = BTreeMap<String, Option<Vec<Vec<u32>>>>;
fn unwrap(expr: &Expr) -> &Expr {
    match expr {
        Expr::Paren(x) => unwrap(&x.expr),
        Expr::Group(x) => unwrap(&x.expr),
        _ => expr,
    }
}
fn selected_field(expr: &Expr, receiver: &str) -> Option<String> {
    let Expr::Field(field) = unwrap(expr) else {
        return None;
    };
    let Member::Named(name) = &field.member else {
        return None;
    };
    matches!(unwrap(&field.base), Expr::Path(path) if path.path.is_ident(receiver))
        .then(|| name.to_string())
}
fn field_equality(expr: &Expr, other: &str) -> Option<String> {
    let Expr::Binary(binary) = unwrap(expr) else {
        return None;
    };
    if !matches!(binary.op, syn::BinOp::Eq(_)) {
        return None;
    }
    let pair = [("self", other), (other, "self")];
    pair.into_iter().find_map(|(left, right)| {
        let a = selected_field(&binary.left, left)?;
        let b = selected_field(&binary.right, right)?;
        (a == b).then_some(a)
    })
}
fn conjunction<'a>(expr: &'a Expr, output: &mut Vec<&'a Expr>) {
    match unwrap(expr) {
        Expr::Binary(binary) if matches!(binary.op, syn::BinOp::And(_)) => {
            conjunction(&binary.left, output);
            conjunction(&binary.right, output);
        }
        expr => output.push(expr),
    }
}
pub fn fields(db: &Database, definition: &Definition) -> Result<EqualFields> {
    let mut partial = Vec::new();
    let mut marker = 0;
    for implementation in implementations(db, definition) {
        let Some((_, path, _)) = &implementation.item.trait_ else {
            continue;
        };
        match trait_name(db, &implementation.module, path)?.as_str() {
            "PartialEq" => partial.push(implementation),
            "Eq" => {
                if implementation.conditional
                    || !implementation.item.items.is_empty()
                    || !implementation.item.generics.params.is_empty()
                {
                    return Err(Error::at(
                        &implementation.file,
                        implementation.item.span(),
                        "Eq must be one unconditional empty standard marker implementation",
                    ));
                }
                marker += 1;
            }
            _ => {}
        }
    }
    if partial.len() != 1 || marker != 1 {
        return Err(Error::at(
            &definition.file,
            definition.item.span(),
            "Fact binding requires one explicit PartialEq implementation and one empty Eq marker",
        ));
    }
    let implementation = partial[0];
    if implementation.conditional
        || conditional(&implementation.item.attrs)
        || !implementation.item.generics.params.is_empty()
        || implementation.item.generics.where_clause.is_some()
        || implementation.item.unsafety.is_some()
    {
        return Err(Error::at(
            &implementation.file,
            implementation.item.span(),
            "Fact equality must be unconditional, safe, and non-generic",
        ));
    }
    let [ImplItem::Fn(method)] = implementation.item.items.as_slice() else {
        return Err(Error::at(
            &implementation.file,
            implementation.item.span(),
            "PartialEq must contain only the checked eq method",
        ));
    };
    if method.sig.ident != "eq"
        || !method.attrs.is_empty()
        || method.sig.inputs.len() != 2
        || !method.sig.generics.params.is_empty()
        || method.sig.unsafety.is_some()
        || method.sig.asyncness.is_some()
    {
        return Err(Error::at(&implementation.file, method.span(), "supported equality is fn eq(&self, other: &Self) -> bool with no attributes or extra methods"));
    }
    let Some(FnArg::Receiver(receiver)) = method.sig.inputs.first() else {
        return Err(Error::new("eq requires &self"));
    };
    if receiver.reference.is_none() || receiver.mutability.is_some() {
        return Err(Error::new("eq receiver must be immutable &self"));
    }
    let Some(FnArg::Typed(argument)) = method.sig.inputs.iter().nth(1) else {
        return Err(Error::new("eq requires another value"));
    };
    let Pat::Ident(other) = argument.pat.as_ref() else {
        return Err(Error::new("eq other argument must be a plain identifier"));
    };
    if other.by_ref.is_some() || other.mutability.is_some() || other.subpat.is_some() {
        return Err(Error::new(
            "eq argument bindings must be plain immutable names",
        ));
    }
    if !matches!(argument.ty.as_ref(), Type::Reference(reference) if reference.mutability.is_none() && matches!(reference.elem.as_ref(), Type::Path(path) if path.path.is_ident("Self")))
    {
        return Err(Error::new("eq argument must be &Self"));
    }
    if !matches!(&method.sig.output, ReturnType::Type(_, ty) if matches!(ty.as_ref(), Type::Path(path) if path.path.is_ident("bool")))
    {
        return Err(Error::new("eq must return bool"));
    }
    let [Stmt::Expr(body, None)] = method.block.stmts.as_slice() else {
        return Err(Error::at(
            &implementation.file,
            method.span(),
            "eq must be a conjunction expression without statements or callbacks",
        ));
    };
    let mut terms = Vec::new();
    conjunction(body, &mut terms);
    let mut fields = BTreeMap::new();
    for term in terms {
        let (field, classes) = if let Some(field) = field_equality(term, &other.ident.to_string()) {
            (field, None)
        } else {
            finite_quotient(db, &implementation.module, term, &other.ident.to_string())
                .map_err(|error| Error::at(&implementation.file, term.span(), error.message))?
        };
        if fields.insert(field.clone(), classes).is_some() {
            return Err(Error::at(
                &implementation.file,
                term.span(),
                format!("eq compares {field} more than once; use one supported field predicate"),
            ));
        }
    }
    if fields.is_empty() {
        return Err(Error::new("Fact equality cannot be empty"));
    }
    Ok(fields)
}

struct Matches {
    value: Expr,
    pattern: Pat,
}
impl Parse for Matches {
    fn parse(input: ParseStream<'_>) -> syn::Result<Self> {
        let value = input.parse()?;
        input.parse::<Token![,]>()?;
        let pattern = Pat::parse_multi_with_leading_vert(input)?;
        if input.peek(Token![,]) {
            input.parse::<Token![,]>()?;
        }
        if !input.is_empty() {
            return Err(input.error("guarded matches patterns are unsupported"));
        }
        Ok(Self { value, pattern })
    }
}
fn finite_quotient(
    db: &Database,
    module: &str,
    expr: &Expr,
    other: &str,
) -> Result<(String, Option<Vec<Vec<u32>>>)> {
    let Expr::Binary(binary) = unwrap(expr) else {
        return Err(Error::new(
            "eq supports field equality conjunctions and explicit finite u32 equivalence clauses",
        ));
    };
    if !matches!(binary.op, syn::BinOp::Or(_)) {
        return Err(Error::new("unsupported boolean operator in Fact equality"));
    }
    let (field, alternative) = if let Some(field) = field_equality(&binary.left, other) {
        (field, unwrap(&binary.right))
    } else if let Some(field) = field_equality(&binary.right, other) {
        (field, unwrap(&binary.left))
    } else {
        return Err(Error::new(
            "finite equivalence requires ordinary self.field == other.field as its base",
        ));
    };
    let Expr::Macro(invocation) = alternative else {
        return Err(Error::new(
            "finite equivalence must use a standard matches! tuple clause",
        ));
    };
    let parts = path_parts(&invocation.mac.path)?;
    if parts != ["matches"] {
        return Err(Error::new("finite equivalence requires unqualified, unshadowed standard matches!; qualified macro paths are outside this profile"));
    }
    let mut ancestor = Some(module);
    while let Some(path) = ancestor {
        let scope = &db.modules[path];
        if scope.definitions.contains_key("matches")
            || scope.imports.contains_key("matches")
            || scope.macro_use
        {
            return Err(Error::new(
                "matches! is shadowed or has an ambiguous macro binding",
            ));
        }
        ancestor = path.rsplit_once("::").map(|(parent, _)| parent);
    }
    let parsed = syn::parse2::<Matches>(invocation.mac.tokens.clone())
        .map_err(|e| Error::new(format!("unsupported finite equivalence pattern: {e}")))?;
    let Expr::Tuple(tuple) = unwrap(&parsed.value) else {
        return Err(Error::new("matches! must inspect the compared field pair"));
    };
    if tuple.elems.len() != 2
        || selected_field(&tuple.elems[0], "self") != Some(field.clone())
        || selected_field(&tuple.elems[1], other) != Some(field.clone())
    {
        return Err(Error::new(
            "matches! must inspect (self.field, other.field) for the same compared field",
        ));
    }
    fn cases<'a>(pattern: &'a Pat, output: &mut Vec<&'a Pat>) {
        match pattern {
            Pat::Or(or) => {
                for case in &or.cases {
                    cases(case, output);
                }
            }
            Pat::Paren(paren) => cases(&paren.pat, output),
            other => output.push(other),
        }
    }
    let mut patterns = Vec::new();
    cases(&parsed.pattern, &mut patterns);
    let mut pairs = BTreeSet::new();
    for pattern in patterns {
        let Pat::Tuple(tuple) = pattern else {
            return Err(Error::new(
                "finite equivalence cases must be two resolved u32 constant patterns",
            ));
        };
        if tuple.elems.len() != 2 {
            return Err(Error::new("finite equivalence tuple arity must be two"));
        }
        let a = pattern_value(db, module, &tuple.elems[0])?;
        let b = pattern_value(db, module, &tuple.elems[1])?;
        if !pairs.insert((a, b)) {
            return Err(Error::new("duplicate finite equivalence pattern"));
        }
    }
    let values: BTreeSet<_> = pairs.iter().flat_map(|(a, b)| [*a, *b]).collect();
    if values.len() > 64 {
        return Err(Error::new("finite equivalence exceeds 64 u32 values"));
    }
    let equal = |a: u32, b: u32| a == b || pairs.contains(&(a, b));
    for a in &values {
        for b in &values {
            if equal(*a, *b) != equal(*b, *a) {
                return Err(Error::new(
                    "finite equivalence is not symmetric; the analyzer does not repair native Eq",
                ));
            }
            for c in &values {
                if equal(*a, *b) && equal(*b, *c) && !equal(*a, *c) {
                    return Err(Error::new("finite equivalence is not transitive; add the missing native Eq cases instead of closing them silently"));
                }
            }
        }
    }
    let mut remaining = values;
    let mut classes = Vec::new();
    while let Some(first) = remaining.first().copied() {
        let class: Vec<_> = remaining
            .iter()
            .copied()
            .filter(|value| equal(first, *value))
            .collect();
        for value in &class {
            remaining.remove(value);
        }
        if class.len() > 1 {
            classes.push(class);
        }
    }
    Ok((field, (!classes.is_empty()).then_some(classes)))
}
fn pattern_value(db: &Database, module: &str, pattern: &Pat) -> Result<u32> {
    match pattern {
        Pat::Lit(literal) => literal_value(&literal.lit),
        Pat::Ident(ident) if ident.by_ref.is_none() && ident.mutability.is_none() && ident.subpat.is_none() => constant(db, module, &[ident.ident.to_string()], &mut BTreeSet::new()),
        Pat::Path(path) if path.qself.is_none() => constant(db, module, &path_parts(&path.path)?, &mut BTreeSet::new()),
        _ => Err(Error::new("finite equivalence requires literal or resolved constant patterns, not bindings or wildcards")),
    }
}
fn literal_value(literal: &syn::Lit) -> Result<u32> {
    let syn::Lit::Int(value) = literal else {
        return Err(Error::new(
            "finite equivalence constants must be u32 integers",
        ));
    };
    if !value.suffix().is_empty() && value.suffix() != "u32" {
        return Err(Error::new(
            "finite equivalence constants must have u32 type",
        ));
    }
    value
        .base10_parse()
        .map_err(|_| Error::new("finite equivalence integer is outside u32"))
}
fn constant(
    db: &Database,
    module: &str,
    path: &[String],
    seen: &mut BTreeSet<String>,
) -> Result<u32> {
    let definition = db.resolve(module, path)?;
    db.check_scope(&definition)?;
    let Item::Const(item) = &definition.item else {
        return Err(Error::new(
            "pattern identifier must resolve to an actual u32 constant, not a Rust pattern binding",
        ));
    };
    if !seen.insert(format!("{}::{}", definition.module, item.ident)) || seen.len() > 32 {
        return Err(Error::new("cyclic or excessively deep constant resolution"));
    }
    if !matches!(item.ty.as_ref(), Type::Path(path) if path.path.is_ident("u32"))
        || item.attrs.iter().any(|attr| !attr.path().is_ident("doc"))
    {
        return Err(Error::new(
            "finite equivalence constants require unconditional literal u32 definitions",
        ));
    }
    match unwrap(&item.expr) {
        Expr::Lit(literal) => literal_value(&literal.lit),
        Expr::Path(path) if path.qself.is_none() => {
            constant(db, &definition.module, &path_parts(&path.path)?, seen)
        }
        _ => Err(Error::new(
            "finite equivalence does not execute arbitrary constant expressions",
        )),
    }
}
