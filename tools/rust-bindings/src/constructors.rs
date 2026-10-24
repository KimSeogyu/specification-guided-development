use crate::codec;
use crate::error::{Error, Result};
use crate::model::Codec;
use crate::source::{item_name, Database, Definition, Implementation};
use serde::Serialize;
use std::collections::BTreeSet;
use syn::spanned::Spanned;
use syn::visit::Visit;
use syn::{
    Attribute, BinOp, Expr, Fields, FnArg, GenericArgument, ImplItem, ImplItemFn, Item, Member,
    Pat, PathArguments, ReturnType, Stmt, Type, UnOp, Visibility,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ConstructorScalar {
    String,
    I64,
    U32,
    Bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConstructorItem {
    pub(crate) crate_id: String,
    pub(crate) module: String,
    pub(crate) item: String,
    pub(crate) file: String,
    pub(crate) line: usize,
    pub(crate) column: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub(crate) enum ConstructorRecipe {
    Identity {
        scalar: ConstructorScalar,
    },
    TupleWrap {
        constructor: ConstructorItem,
        inner: Box<ConstructorRecipe>,
    },
    #[serde(rename_all = "camelCase")]
    AsciiSymbol {
        constructor: ConstructorItem,
        error_type: ConstructorItem,
    },
}

impl ConstructorRecipe {
    pub(crate) fn scalar(&self) -> ConstructorScalar {
        match self {
            Self::Identity { scalar } => *scalar,
            Self::TupleWrap { inner, .. } => inner.scalar(),
            Self::AsciiSymbol { .. } => ConstructorScalar::String,
        }
    }

    pub(crate) fn fallible_error(&self) -> Option<&ConstructorItem> {
        match self {
            Self::Identity { .. } => None,
            Self::TupleWrap { inner, .. } => inner.fallible_error(),
            Self::AsciiSymbol { error_type, .. } => Some(error_type),
        }
    }
}

pub(crate) fn analyze(
    db: &Database,
    module: &str,
    ty: &Type,
    root_crate: &str,
) -> Result<ConstructorRecipe> {
    crate::macros::audit(db)?;
    let representation = codec::codec(db, module, ty, root_crate)?;
    let mut active = BTreeSet::new();
    analyze_inner(db, module, ty, &representation, &mut active)
}

fn analyze_inner(
    db: &Database,
    module: &str,
    ty: &Type,
    representation: &Codec,
    active: &mut BTreeSet<String>,
) -> Result<ConstructorRecipe> {
    if let Some(scalar) = primitive(db, module, ty)? {
        if !getters(representation).is_empty() || codec_scalar(representation)? != scalar {
            return Err(Error::new(
                "constructor scalar differs from the checked getter representation",
            ));
        }
        return Ok(ConstructorRecipe::Identity { scalar });
    }
    let definition = codec::type_definition(db, module, ty)?;
    let name = item_name(&definition.item)
        .ok_or_else(|| Error::new("constructor target is not a named native type"))?;
    let identity = format!("{}::{name}", definition.module);
    if !active.insert(identity.clone()) || active.len() > 4 {
        return Err(Error::at(
            &definition.file,
            definition.item.span(),
            "recursive or excessively deep constructor recipes are unsupported",
        ));
    }
    let derived = codec::derives(db, &definition, &["Clone", "PartialEq", "Eq"])?;
    let Item::Struct(item) = &definition.item else {
        return Err(Error::at(
            &definition.file,
            definition.item.span(),
            "constructor recipes require a primitive or a concrete one-field tuple wrapper",
        ));
    };
    if !matches!(item.vis, Visibility::Public(_))
        || !item.generics.params.is_empty()
        || item.generics.where_clause.is_some()
    {
        return Err(Error::at(
            &definition.file,
            item.span(),
            "constructor wrapper must be public, unconditional, and non-generic",
        ));
    }
    let Fields::Unnamed(fields) = &item.fields else {
        return Err(Error::at(
            &definition.file,
            item.span(),
            "constructor wrapper requires exactly one tuple representation field",
        ));
    };
    if fields.unnamed.len() != 1 {
        return Err(Error::at(
            &definition.file,
            fields.span(),
            "constructor wrapper requires exactly one tuple representation field",
        ));
    }
    let field = &fields.unnamed[0];
    plain_attrs(&definition.file, &field.attrs)?;
    let selected_getter = getters(representation).first().ok_or_else(|| {
        Error::at(
            &definition.file,
            item.span(),
            "native wrapper has no checked getter to invert",
        )
    })?;
    let string = primitive(db, &definition.module, &field.ty)? == Some(ConstructorScalar::String);
    check_getter(
        db,
        &definition,
        &field.ty,
        selected_getter,
        string,
        derived.contains("Copy"),
    )?;

    let mut candidates = Vec::new();
    for implementation in codec::implementations(db, &definition) {
        if implementation.item.trait_.is_some() {
            continue;
        }
        for member in &implementation.item.items {
            let ImplItem::Fn(method) = member else {
                continue;
            };
            if method
                .sig
                .inputs
                .iter()
                .any(|input| matches!(input, FnArg::Receiver(_)))
                || !return_mentions_native(
                    db,
                    &implementation.module,
                    &method.sig.output,
                    &definition,
                )
            {
                continue;
            }
            check_method(implementation, method)?;
            candidates.push((implementation, method));
        }
    }
    let [(implementation, method)] = candidates.as_slice() else {
        return Err(Error::at(&definition.file, item.span(), format!("{name}: require exactly one resolved constructor; found {} static methods returning the native type", candidates.len())));
    };
    let parameter = parameter(implementation, method)?;
    let recipe = if string {
        let error = check_ascii_symbol(db, &definition, implementation, method, &parameter)?;
        ConstructorRecipe::AsciiSymbol {
            constructor: method_item(db, &definition, implementation, method),
            error_type: definition_item(db, &error),
        }
    } else {
        check_tuple_wrap(
            db,
            &definition,
            &field.ty,
            implementation,
            method,
            &parameter,
        )?;
        let mut inner_codec = representation.clone();
        remove_first_getter(&mut inner_codec);
        let inner = analyze_inner(db, &definition.module, &field.ty, &inner_codec, active)?;
        ConstructorRecipe::TupleWrap {
            constructor: method_item(db, &definition, implementation, method),
            inner: Box::new(inner),
        }
    };
    active.remove(&identity);
    Ok(recipe)
}

fn getters(codec: &Codec) -> &[String] {
    match codec {
        Codec::I64 { getters }
        | Codec::U32 { getters }
        | Codec::Bool { getters }
        | Codec::String { getters }
        | Codec::Enum { getters, .. } => getters,
    }
}

fn remove_first_getter(codec: &mut Codec) {
    match codec {
        Codec::I64 { getters }
        | Codec::U32 { getters }
        | Codec::Bool { getters }
        | Codec::String { getters }
        | Codec::Enum { getters, .. } => {
            getters.remove(0);
        }
    }
}

fn codec_scalar(codec: &Codec) -> Result<ConstructorScalar> {
    match codec {
        Codec::I64 { .. } => Ok(ConstructorScalar::I64),
        Codec::U32 { .. } => Ok(ConstructorScalar::U32),
        Codec::Bool { .. } => Ok(ConstructorScalar::Bool),
        Codec::String { .. } => Ok(ConstructorScalar::String),
        Codec::Enum { .. } => Err(Error::new(
            "unit enum construction is outside the constructor-recipe profile",
        )),
    }
}

fn plain_attrs(file: &str, attrs: &[Attribute]) -> Result<()> {
    if let Some(attr) = attrs.iter().find(|attr| !attr.path().is_ident("doc")) {
        return Err(Error::at(
            file,
            attr.span(),
            "constructor recipes refuse conditional and custom attributes",
        ));
    }
    Ok(())
}

fn check_method(implementation: &Implementation, method: &ImplItemFn) -> Result<()> {
    let signature = &method.sig;
    if implementation.conditional
        || implementation.item.unsafety.is_some()
        || implementation.item.defaultness.is_some()
        || !implementation.item.generics.params.is_empty()
        || implementation.item.generics.where_clause.is_some()
        || method.defaultness.is_some()
        || !matches!(method.vis, Visibility::Public(_))
        || signature.asyncness.is_some()
        || signature.unsafety.is_some()
        || signature.abi.is_some()
        || signature.variadic.is_some()
        || !signature.generics.params.is_empty()
        || signature.generics.where_clause.is_some()
    {
        return Err(Error::at(&implementation.file, method.span(), format!("{}: constructor/getter must be public, safe, unconditional, non-generic, and use the Rust ABI", signature.ident)));
    }
    plain_attrs(&implementation.file, &implementation.item.attrs)?;
    plain_attrs(&implementation.file, &method.attrs)?;
    struct BodyAttrs(Option<proc_macro2::Span>);
    impl<'ast> Visit<'ast> for BodyAttrs {
        fn visit_attribute(&mut self, attr: &'ast Attribute) {
            self.0.get_or_insert(attr.span());
        }
    }
    let mut attributes = BodyAttrs(None);
    attributes.visit_block(&method.block);
    if let Some(span) = attributes.0 {
        return Err(Error::at(
            &implementation.file,
            span,
            "attributes inside a constructor/getter recipe are unsupported",
        ));
    }
    Ok(())
}

fn parameter(implementation: &Implementation, method: &ImplItemFn) -> Result<String> {
    let Some(FnArg::Typed(input)) = method.sig.inputs.first() else {
        return Err(Error::at(
            &implementation.file,
            method.sig.span(),
            format!(
                "{}: constructor requires exactly one ordinary value parameter",
                method.sig.ident
            ),
        ));
    };
    if method.sig.inputs.len() != 1 {
        return Err(Error::at(
            &implementation.file,
            method.sig.span(),
            "constructor requires exactly one ordinary value parameter",
        ));
    }
    let Pat::Ident(pattern) = input.pat.as_ref() else {
        return Err(Error::at(
            &implementation.file,
            input.span(),
            "constructor parameter must be one immutable identifier",
        ));
    };
    if !input.attrs.is_empty()
        || !pattern.attrs.is_empty()
        || pattern.by_ref.is_some()
        || pattern.mutability.is_some()
        || pattern.subpat.is_some()
    {
        return Err(Error::at(
            &implementation.file,
            input.span(),
            "constructor parameter must be one immutable identifier without attributes",
        ));
    }
    Ok(pattern.ident.to_string())
}

fn primitive(db: &Database, module: &str, ty: &Type) -> Result<Option<ConstructorScalar>> {
    let Type::Path(path) = ty else {
        return Ok(None);
    };
    if path.qself.is_some() || path.path.leading_colon.is_some() {
        return Ok(None);
    }
    let Some(name) = path.path.get_ident().map(ToString::to_string) else {
        return Ok(None);
    };
    let scalar = match name.as_str() {
        "i64" => ConstructorScalar::I64,
        "u32" => ConstructorScalar::U32,
        "bool" => ConstructorScalar::Bool,
        "String" => ConstructorScalar::String,
        _ => return Ok(None),
    };
    unshadowed(db, module, &name)?;
    Ok(Some(scalar))
}

fn type_identity(db: &Database, module: &str, ty: &Type, native: &Definition) -> Result<String> {
    if matches!(ty, Type::Path(path) if path.qself.is_none() && path.path.is_ident("Self")) {
        return Ok(native_identity(native));
    }
    if let Some(scalar) = primitive(db, module, ty)? {
        return Ok(format!("primitive:{scalar:?}"));
    }
    let definition = codec::type_definition(db, module, ty)?;
    db.check_scope(&definition)?;
    Ok(native_identity(&definition))
}

fn native_identity(definition: &Definition) -> String {
    format!(
        "{}::{}",
        definition.module,
        item_name(&definition.item).unwrap_or_default()
    )
}

fn return_mentions_native(
    db: &Database,
    module: &str,
    output: &ReturnType,
    native: &Definition,
) -> bool {
    struct NativeType<'a, 'inputs> {
        db: &'a Database<'inputs>,
        module: &'a str,
        native: &'a Definition,
        found: bool,
    }
    impl<'ast> Visit<'ast> for NativeType<'_, '_> {
        fn visit_type(&mut self, ty: &'ast Type) {
            if type_identity(self.db, self.module, ty, self.native)
                .is_ok_and(|identity| identity == native_identity(self.native))
            {
                self.found = true;
            }
            syn::visit::visit_type(self, ty);
        }
    }
    let mut visitor = NativeType {
        db,
        module,
        native,
        found: false,
    };
    if let ReturnType::Type(_, ty) = output {
        visitor.visit_type(ty);
    }
    visitor.found
}

fn check_getter(
    db: &Database,
    native: &Definition,
    inner: &Type,
    selected: &str,
    string: bool,
    copy: bool,
) -> Result<()> {
    let mut found = Vec::new();
    for implementation in codec::implementations(db, native) {
        if implementation.item.trait_.is_some() {
            continue;
        }
        for item in &implementation.item.items {
            if let ImplItem::Fn(method) = item {
                if method.sig.ident == selected {
                    found.push((implementation, method));
                }
            }
        }
    }
    let [(implementation, method)] = found.as_slice() else {
        return Err(Error::at(
            &native.file,
            native.item.span(),
            format!("{selected}: getter must resolve to exactly one inherent method"),
        ));
    };
    check_method(implementation, method)?;
    let Some(FnArg::Receiver(receiver)) = method.sig.inputs.first() else {
        return Err(Error::at(
            &implementation.file,
            method.span(),
            format!("{selected}: getter requires only an ordinary self receiver"),
        ));
    };
    if method.sig.inputs.len() != 1 {
        return Err(Error::at(
            &implementation.file,
            method.sig.span(),
            format!("{selected}: getter requires only an ordinary self receiver"),
        ));
    }
    if receiver.mutability.is_some()
        || receiver.colon_token.is_some()
        || !receiver.attrs.is_empty()
        || (receiver.reference.is_none() && !copy)
        || receiver
            .reference
            .as_ref()
            .is_some_and(|(_, lifetime)| lifetime.is_some())
    {
        return Err(Error::at(&implementation.file, receiver.span(), format!("{selected}: getter receiver must be immutable; consuming getters require derived Copy")));
    }
    let ReturnType::Type(_, output) = &method.sig.output else {
        return Err(Error::at(
            &implementation.file,
            method.span(),
            format!("{selected}: getter requires an exact representation return type"),
        ));
    };
    let [Stmt::Expr(body, None)] = method.block.stmts.as_slice() else {
        return Err(Error::at(
            &implementation.file,
            method.block.span(),
            format!("{selected}: getter must contain only its exact representation projection"),
        ));
    };
    let body = strip(body);
    let projected = if string {
        if !is_str_reference(db, &implementation.module, output)? {
            return Err(Error::at(
                &implementation.file,
                output.span(),
                format!("{selected}: String getter must return the standard immutable &str"),
            ));
        }
        let Expr::Reference(reference) = body else {
            return Err(Error::at(
                &implementation.file,
                body.span(),
                format!("{selected}: String getter must return &self.0"),
            ));
        };
        if reference.mutability.is_some() {
            return Err(Error::at(
                &implementation.file,
                body.span(),
                format!("{selected}: mutable getter is unsupported"),
            ));
        }
        strip(&reference.expr)
    } else {
        if type_identity(db, &implementation.module, output, native)?
            != type_identity(db, &native.module, inner, native)?
        {
            return Err(Error::at(&implementation.file, output.span(), format!("{selected}: getter return type must be the actual native representation type, not merely an equal scalar codec")));
        }
        body
    };
    if !matches!(projected, Expr::Field(field) if matches!(&field.member, Member::Unnamed(index) if index.index == 0) && ident_expr(&field.base, "self"))
    {
        return Err(Error::at(
            &implementation.file,
            projected.span(),
            format!("{selected}: getter must return exactly its native tuple field"),
        ));
    }
    Ok(())
}

fn check_tuple_wrap(
    db: &Database,
    native: &Definition,
    inner: &Type,
    implementation: &Implementation,
    method: &ImplItemFn,
    parameter: &str,
) -> Result<()> {
    let FnArg::Typed(input) = &method.sig.inputs[0] else {
        unreachable!()
    };
    let ReturnType::Type(_, output) = &method.sig.output else {
        unreachable!()
    };
    let exact = type_identity(db, &implementation.module, output, native)?
        == native_identity(native)
        && type_identity(db, &implementation.module, &input.ty, native)?
            == type_identity(db, &native.module, inner, native)?;
    let [Stmt::Expr(body, None)] = method.block.stmts.as_slice() else {
        return Err(Error::at(&implementation.file, method.block.span(), format!("{}: tuple constructor must contain only Self(parameter); extra statements are unsupported", method.sig.ident)));
    };
    let body = strip(body);
    if !exact
        || !matches!(body, Expr::Call(call) if ident_expr(&call.func, "Self") && call.args.len() == 1 && ident_expr(&call.args[0], parameter))
    {
        return Err(Error::at(&implementation.file, method.span(), format!("{}: constructor must invert the exact native getter with an unchanged Self(parameter)", method.sig.ident)));
    }
    Ok(())
}

fn check_ascii_symbol(
    db: &Database,
    native: &Definition,
    implementation: &Implementation,
    method: &ImplItemFn,
    parameter: &str,
) -> Result<Definition> {
    let failure = || {
        Error::at(&implementation.file, method.span(), format!("{}: String constructor must exactly validate 1..=32 ASCII uppercase-or-digit bytes and copy the input into Self", method.sig.ident))
    };
    let FnArg::Typed(input) = &method.sig.inputs[0] else {
        unreachable!()
    };
    if !is_str_reference(db, &implementation.module, &input.ty)? {
        return Err(failure());
    }
    let ReturnType::Type(_, output) = &method.sig.output else {
        return Err(failure());
    };
    let Type::Path(result) = output.as_ref() else {
        return Err(failure());
    };
    if result.qself.is_some() || result.path.leading_colon.is_some() {
        return Err(failure());
    }
    let mut result_path = result.path.clone();
    let Some(last) = result_path.segments.last_mut() else {
        return Err(failure());
    };
    let PathArguments::AngleBracketed(arguments) = &last.arguments else {
        return Err(failure());
    };
    if arguments.colon2_token.is_some() || arguments.args.len() != 2 {
        return Err(failure());
    }
    let GenericArgument::Type(value) = &arguments.args[0] else {
        return Err(failure());
    };
    let GenericArgument::Type(error) = &arguments.args[1] else {
        return Err(failure());
    };
    let error_ty = error.clone();
    if type_identity(db, &implementation.module, value, native)? != native_identity(native) {
        return Err(failure());
    }
    last.arguments = PathArguments::None;
    if !standard_path(db, &implementation.module, &result_path, "Result")? {
        return Err(failure());
    }
    let error = codec::type_definition(db, &implementation.module, &error_ty)?;
    check_error(db, &error)?;
    check_trait_scope(db, &implementation.module)?;
    let [Stmt::Expr(length, None), Stmt::Expr(charset, None), Stmt::Expr(success, None)] =
        method.block.stmts.as_slice()
    else {
        return Err(failure());
    };
    let length = guard(length).ok_or_else(failure)?;
    let charset = guard(charset).ok_or_else(failure)?;
    let Expr::Binary(or) = strip(length.0) else {
        return Err(failure());
    };
    let Expr::Binary(limit) = strip(&or.right) else {
        return Err(failure());
    };
    if !matches!(or.op, BinOp::Or(_))
        || !method_on(&or.left, parameter, "is_empty")
        || !matches!(limit.op, BinOp::Gt(_))
        || !method_on(&limit.left, parameter, "len")
        || !integer(&limit.right, 32)
        || !returned_error(
            db,
            &implementation.module,
            length.1,
            &error,
            "Length",
            parameter,
        )?
    {
        return Err(failure());
    }
    let Expr::Unary(not) = strip(charset.0) else {
        return Err(failure());
    };
    let Expr::MethodCall(all) = strip(&not.expr) else {
        return Err(failure());
    };
    if !matches!(not.op, UnOp::Not(_))
        || all.method != "all"
        || all.turbofish.is_some()
        || all.args.len() != 1
        || !method_on(&all.receiver, parameter, "bytes")
        || !returned_error(
            db,
            &implementation.module,
            charset.1,
            &error,
            "Charset",
            parameter,
        )?
    {
        return Err(failure());
    }
    let Expr::Closure(predicate) = strip(&all.args[0]) else {
        return Err(failure());
    };
    if predicate.lifetimes.is_some()
        || predicate.constness.is_some()
        || predicate.movability.is_some()
        || predicate.asyncness.is_some()
        || predicate.capture.is_some()
        || !matches!(predicate.output, ReturnType::Default)
        || predicate.inputs.len() != 1
    {
        return Err(failure());
    }
    let Pat::Ident(byte) = &predicate.inputs[0] else {
        return Err(failure());
    };
    if !byte.attrs.is_empty()
        || byte.by_ref.is_some()
        || byte.mutability.is_some()
        || byte.subpat.is_some()
    {
        return Err(failure());
    }
    let Expr::Binary(or) = strip(&predicate.body) else {
        return Err(failure());
    };
    let byte = byte.ident.to_string();
    if !matches!(or.op, BinOp::Or(_))
        || !method_on(&or.left, &byte, "is_ascii_uppercase")
        || !method_on(&or.right, &byte, "is_ascii_digit")
    {
        return Err(failure());
    }
    let Expr::Call(ok) = strip(success) else {
        return Err(failure());
    };
    let Expr::Path(ok_path) = strip(&ok.func) else {
        return Err(failure());
    };
    if ok_path.qself.is_some()
        || !standard_value_path(db, &implementation.module, &ok_path.path, "Ok", parameter)?
        || ok.args.len() != 1
    {
        return Err(failure());
    }
    let Expr::Call(wrap) = strip(&ok.args[0]) else {
        return Err(failure());
    };
    if !ident_expr(&wrap.func, "Self")
        || wrap.args.len() != 1
        || !method_on(&wrap.args[0], parameter, "to_owned")
    {
        return Err(failure());
    }
    Ok(error)
}

fn check_error(db: &Database, definition: &Definition) -> Result<()> {
    codec::derives(db, definition, &["Clone", "Copy", "PartialEq", "Eq"])?;
    let Item::Enum(item) = &definition.item else {
        return Err(Error::at(
            &definition.file,
            definition.item.span(),
            "ASCII constructor error must be a concrete unit enum",
        ));
    };
    if !matches!(item.vis, Visibility::Public(_))
        || !item.generics.params.is_empty()
        || item.generics.where_clause.is_some()
        || item.variants.len() != 2
        || item.variants[0].ident != "Length"
        || item.variants[1].ident != "Charset"
        || item.variants.iter().any(|variant| {
            !matches!(variant.fields, Fields::Unit) || variant.discriminant.is_some()
        })
    {
        return Err(Error::at(
            &definition.file,
            item.span(),
            "ASCII constructor error must contain exactly the Length and Charset unit variants",
        ));
    }
    for variant in &item.variants {
        plain_attrs(&definition.file, &variant.attrs)?;
    }
    Ok(())
}

fn returned_error(
    db: &Database,
    module: &str,
    body: &syn::Block,
    error: &Definition,
    variant: &str,
    parameter: &str,
) -> Result<bool> {
    let [Stmt::Expr(Expr::Return(returned), Some(_))] = body.stmts.as_slice() else {
        return Ok(false);
    };
    let Some(value) = &returned.expr else {
        return Ok(false);
    };
    let Expr::Call(call) = strip(value) else {
        return Ok(false);
    };
    let Expr::Path(path) = strip(&call.func) else {
        return Ok(false);
    };
    if path.qself.is_some()
        || !standard_value_path(db, module, &path.path, "Err", parameter)?
        || call.args.len() != 1
    {
        return Ok(false);
    }
    let Expr::Path(variant_path) = strip(&call.args[0]) else {
        return Ok(false);
    };
    if variant_path.qself.is_some() {
        return Ok(false);
    }
    let mut parts = codec::path_parts(&variant_path.path)?;
    if parts.pop().as_deref() != Some(variant) || parts.is_empty() {
        return Ok(false);
    }
    let found = db.resolve(module, &parts)?;
    Ok(native_identity(&found) == native_identity(error))
}

fn guard(expr: &Expr) -> Option<(&Expr, &syn::Block)> {
    match strip(expr) {
        Expr::If(branch) if branch.else_branch.is_none() => {
            Some((&branch.cond, &branch.then_branch))
        }
        _ => None,
    }
}

fn strip(mut expr: &Expr) -> &Expr {
    loop {
        match expr {
            Expr::Paren(group) => expr = &group.expr,
            Expr::Group(group) => expr = &group.expr,
            _ => return expr,
        }
    }
}

fn ident_expr(expr: &Expr, name: &str) -> bool {
    matches!(strip(expr), Expr::Path(path) if path.qself.is_none() && path.path.is_ident(name))
}

fn method_on(expr: &Expr, receiver: &str, method: &str) -> bool {
    matches!(strip(expr), Expr::MethodCall(call) if call.method == method && call.turbofish.is_none() && call.args.is_empty() && ident_expr(&call.receiver, receiver))
}

fn integer(expr: &Expr, expected: u64) -> bool {
    matches!(strip(expr), Expr::Lit(value) if matches!(&value.lit, syn::Lit::Int(integer) if integer.suffix().is_empty() && integer.base10_parse::<u64>().ok() == Some(expected)))
}

fn is_str_reference(db: &Database, module: &str, ty: &Type) -> Result<bool> {
    let Type::Reference(reference) = ty else {
        return Ok(false);
    };
    if reference.mutability.is_some() || reference.lifetime.is_some() {
        return Ok(false);
    }
    let Type::Path(path) = reference.elem.as_ref() else {
        return Ok(false);
    };
    if path.qself.is_some() || !path.path.is_ident("str") {
        return Ok(false);
    }
    unshadowed(db, module, "str")?;
    Ok(true)
}

fn check_parameter_value(path: &syn::Path, name: &str, parameter: &str) -> Result<()> {
    if matches!(name, "Ok" | "Err") && parameter == name && path.is_ident(name) {
        return Err(Error::new(format!(
            "constructor parameter {parameter} shadows the bare standard {name} callee; rename the parameter or use the qualified standard Result variant"
        )));
    }
    Ok(())
}

fn standard_value_path(
    db: &Database,
    module: &str,
    path: &syn::Path,
    name: &str,
    parameter: &str,
) -> Result<bool> {
    check_parameter_value(path, name, parameter)?;
    standard_path(db, module, path, name)
}

fn standard_path(db: &Database, module: &str, path: &syn::Path, name: &str) -> Result<bool> {
    let parts = codec::path_parts(path)?;
    if parts.as_slice() == [name] {
        unshadowed(db, module, name)?;
        return Ok(true);
    }
    let Some(prefix) = parts.first() else {
        return Ok(false);
    };
    if prefix != "std" && prefix != "core" {
        return Ok(false);
    }
    unshadowed(db, module, prefix)?;
    Ok(match name {
        "Result" => parts.len() == 3 && parts[1] == "result" && parts[2] == "Result",
        "Ok" | "Err" => {
            parts.len() == 4 && parts[1] == "result" && parts[2] == "Result" && parts[3] == name
        }
        _ => false,
    })
}

fn unshadowed(db: &Database, module: &str, name: &str) -> Result<()> {
    let mut ancestor = Some(module);
    while let Some(module) = ancestor {
        let scope = &db.modules[module];
        if scope.definitions.contains_key(name)
            || scope.imports.contains_key(name)
            || db
                .production_items
                .iter()
                .any(|(owner, _, item)| owner == module && shadows(item, name))
        {
            return Err(Error::new(format!(
                "{module}: constructor standard/prelude identity {name} is shadowed"
            )));
        }
        ancestor = module.rsplit_once("::").map(|(parent, _)| parent);
    }
    Ok(())
}

fn shadows(item: &Item, name: &str) -> bool {
    match item {
        Item::Fn(item) => item.sig.ident == name,
        Item::Static(item) => item.ident == name,
        Item::Union(item) => item.ident == name,
        Item::ForeignMod(item) => item.items.iter().any(|item| match item {
            syn::ForeignItem::Fn(item) => item.sig.ident == name,
            syn::ForeignItem::Static(item) => item.ident == name,
            syn::ForeignItem::Type(item) => item.ident == name,
            _ => false,
        }),
        _ => false,
    }
}

fn check_trait_scope(db: &Database, module: &str) -> Result<()> {
    fn selected_method(item: &syn::TraitItem) -> bool {
        matches!(item, syn::TraitItem::Fn(method) if matches!(method.sig.ident.to_string().as_str(),
            "is_empty" | "len" | "bytes" | "all" | "is_ascii_uppercase" | "is_ascii_digit" | "to_owned"))
    }
    let mut ancestor = Some(module);
    while let Some(module) = ancestor {
        let scope = &db.modules[module];
        for definition in scope.definitions.values() {
            if let Item::Trait(item) = &definition.item {
                if item.items.iter().any(selected_method) {
                    return Err(Error::at(&definition.file, item.span(), "constructor trait scope can replace a selected standard byte, string, iterator, or owned-string operation"));
                }
            }
        }
        for (name, import) in &scope.imports {
            if let Ok(definition) = db.resolve(module, std::slice::from_ref(name)) {
                if let Item::Trait(item) = &definition.item {
                    if item.items.iter().any(selected_method) {
                        return Err(Error::at(&definition.file, item.span(), "imported trait can replace a selected constructor byte, string, iterator, or owned-string operation"));
                    }
                }
                continue;
            }
            let path = import.path.iter().map(String::as_str).collect::<Vec<_>>();
            if !matches!(
                path.as_slice(),
                ["std" | "core", "fmt"]
                    | ["std" | "core", "iter", "Iterator"]
                    | ["std" | "alloc", "borrow", "ToOwned"]
            ) {
                return Err(Error::new(format!("{module}: unresolved import {name} can alter constructor method resolution; foreign trait scope is outside the recipe profile")));
            }
            if let Some(prefix) = path.first() {
                unshadowed(db, module, prefix)?;
            }
        }
        ancestor = module.rsplit_once("::").map(|(parent, _)| parent);
    }
    Ok(())
}

fn method_item(
    db: &Database,
    native: &Definition,
    implementation: &Implementation,
    method: &ImplItemFn,
) -> ConstructorItem {
    let mut item = definition_item(db, native);
    let location = method.sig.ident.span().start();
    item.item = format!("{}::{}", item.item, method.sig.ident);
    item.file = implementation.file.clone();
    item.line = location.line.max(1);
    item.column = location.column + 1;
    item
}

fn definition_item(db: &Database, definition: &Definition) -> ConstructorItem {
    let location = definition.item.span().start();
    ConstructorItem {
        crate_id: db.modules[&definition.module].crate_id.clone(),
        module: definition.module.clone(),
        item: item_name(&definition.item).unwrap_or_default(),
        file: definition.file.clone(),
        line: location.line.max(1),
        column: location.column + 1,
    }
}

#[cfg(test)]
mod tests {
    use super::check_parameter_value;

    #[test]
    fn result_variant_lookup_respects_constructor_parameter_value_scope() {
        for variant in ["Ok", "Err"] {
            let bare = syn::parse_str::<syn::Path>(variant).unwrap();
            assert!(check_parameter_value(&bare, variant, variant).is_err());
            assert!(check_parameter_value(&bare, variant, "raw").is_ok());
            for root in ["std", "core"] {
                let qualified =
                    syn::parse_str::<syn::Path>(&format!("{root}::result::Result::{variant}"))
                        .unwrap();
                assert!(check_parameter_value(&qualified, variant, variant).is_ok());
            }
        }
        let result = syn::parse_str::<syn::Path>("Result").unwrap();
        assert!(check_parameter_value(&result, "Result", "Result").is_ok());
    }
}
