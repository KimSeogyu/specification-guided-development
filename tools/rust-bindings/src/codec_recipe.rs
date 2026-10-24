use crate::constructors::{self, ConstructorItem, ConstructorRecipe, ConstructorScalar};
use crate::error::{Error, Result};
use crate::model::{FactBinding, FactPlan, SourceBinding, SourceIdentity};
use crate::source::{self, Database, Definition};
use crate::{analyze_facts, codec, macros, validate_source_binding};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use syn::spanned::Spanned;
use syn::{
    Expr, Fields, FnArg, GenericArgument, Item, ItemFn, Member, Pat, PathArguments, ReturnType,
    Stmt, Type,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CodecRecipeBinding {
    version: u8,
    profile: String,
    source: RecipeSource,
    codec: RecipeEntrypoints,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RecipeSource {
    manifest: String,
    module: String,
    fact: FactBinding,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RecipeEntrypoints {
    module: String,
    encode: String,
    decode: String,
    wire: String,
    descriptor: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodecRecipeReport {
    version: u8,
    profile: &'static str,
    scope: &'static str,
    storage_authority: bool,
    crate_name: String,
    library: LibraryIdentity,
    row: FactPlan,
    wire: ConstructorItem,
    entrypoints: Entrypoints,
    columns: Vec<ColumnRecipe>,
    sources: Vec<SourceIdentity>,
    binding: SourceIdentity,
    absent_inputs: Vec<String>,
    discovery: crate::codec_targets::CodecDiscoveryEvidence,
}

impl CodecRecipeReport {
    pub fn storage_authority(&self) -> bool {
        self.storage_authority
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryIdentity {
    package_id: String,
    target: String,
    crate_name: String,
    source: String,
}

#[derive(Serialize)]
struct Entrypoints {
    encode: ConstructorItem,
    decode: ConstructorItem,
}

#[derive(Serialize)]
struct ColumnRecipe {
    column: String,
    field: String,
    scalar: ConstructorScalar,
    nullable: bool,
    decode: ConstructorRecipe,
}

pub struct CheckedCodecRecipe {
    report: CodecRecipeReport,
    inputs: crate::codec_targets::CodecCargoScope,
    binding: crate::source_inputs::CapturedBinding,
}

impl CheckedCodecRecipe {
    pub fn report(&self) -> &CodecRecipeReport {
        &self.report
    }
    pub fn recheck(&self) -> Result<()> {
        (|| {
            self.binding.recheck()?;
            self.inputs.recheck()
        })()
        .map_err(|mut error: Error| {
            error.rule_id = "TLC309";
            error
        })
    }
}

pub fn analyze_codec_recipe(root: &Path, binding_path: &Path) -> Result<CheckedCodecRecipe> {
    analyze_inner(root, binding_path).map_err(|mut error| {
        error.rule_id = "TLC309";
        error
    })
}

fn analyze_inner(root: &Path, binding_path: &Path) -> Result<CheckedCodecRecipe> {
    let captured_binding = crate::source_inputs::CapturedBinding::capture(binding_path)?;
    let binding: CodecRecipeBinding = serde_json::from_str(captured_binding.text())
        .map_err(|e| Error::new(format!("invalid codec recipe binding: {e}")))?;
    if binding.version != 1 || binding.profile != "rust-codec-recipe-v1" {
        return Err(Error::new(
            "expected version 1 rust-codec-recipe-v1 binding",
        ));
    }
    let row_source = SourceBinding {
        manifest: binding.source.manifest,
        module: binding.source.module,
        facts: vec![binding.source.fact],
    };
    validate_source_binding(&row_source)?;
    source::rust_path(&binding.codec.module)?;
    source::rust_path(&binding.codec.wire)?;
    let names = [
        &binding.codec.encode,
        &binding.codec.decode,
        &binding.codec.descriptor,
    ];
    if names.iter().any(|name| !source::identifier(name))
        || names.iter().collect::<BTreeSet<_>>().len() != names.len()
    {
        return Err(Error::new(
            "codec entrypoints and descriptor must be distinct identifiers",
        ));
    }
    let mut inputs = crate::codec_targets::CodecCargoScope::capture(root)?;
    let library = inputs.local_library(&inputs.root().join(&row_source.manifest))?;
    let (crate_id, row, wire, entrypoints, columns) = {
        let mut db = Database::from_inputs(&mut inputs);
        let workspace = db.root.join("Cargo.toml");
        let text = db.read(&workspace)?;
        let manifest = text
            .parse::<toml_edit::DocumentMut>()
            .map_err(|e| Error::new(format!("invalid workspace manifest: {e}")))?;
        if manifest.get("patch").is_some() || manifest.get("replace").is_some() {
            return Err(Error::new(
                "Cargo patch/replace is outside the codec source profile",
            ));
        }
        let manifest_path = db.resolve_relative(&db.root, &row_source.manifest)?;
        let crate_id = db.load_crate(&manifest_path)?;
        if crate_id != library.crate_name || db.modules[&crate_id].file != library.source {
            return Err(Error::new(
                "selected library differs from checked Cargo target identity",
            ));
        }
        macros::audit(&db)?;
        let mut facts = analyze_facts(&db, &row_source, &crate_id)?;
        let row = facts
            .pop()
            .ok_or_else(|| Error::new("codec recipe requires one complete native Fact"))?;
        let row_module = absolute_module(&crate_id, &row_source.module)?;
        let fact = db.resolve(&row_module, std::slice::from_ref(&row.name))?;
        let wire = db.resolve(&crate_id, &source::rust_path(&binding.codec.wire)?)?;
        db.check_scope(&wire)?;
        let wire_fields = wire_fields(&db, &wire)
            .map_err(|error| located(error, &wire.file, wire.item.span(), "wire"))?;
        let module = absolute_module(&crate_id, &binding.codec.module)?;
        let selected = db
            .modules
            .get(&module)
            .ok_or_else(|| Error::new("codec source module is absent or excluded"))?;
        if selected.conditional {
            return Err(Error::new(
                "conditional codec source modules are unsupported",
            ));
        }
        let columns = descriptor(&db, &module, &binding.codec.descriptor).map_err(|error| {
            located(
                error,
                &selected.file,
                selected
                    .definitions
                    .get(&binding.codec.descriptor)
                    .map_or(proc_macro2::Span::call_site(), |definition| {
                        definition.item.span()
                    }),
                &binding.codec.descriptor,
            )
        })?;
        if columns.len() != row.fields.len() || columns.len() != wire_fields.len() {
            return Err(Error::new(
                "codec columns must bijectively preserve every native and wire field",
            ));
        }
        let Item::Struct(native) = &fact.item else {
            return Err(Error::new("native Fact must be a struct"));
        };
        let Fields::Named(native_fields) = &native.fields else {
            return Err(Error::new("native Fact requires named fields"));
        };
        let mut recipes = Vec::new();
        for (column, field) in columns {
            let native_field = native_fields
                .named
                .iter()
                .find(|item| item.ident.as_ref().is_some_and(|name| name == &field))
                .ok_or_else(|| {
                    Error::new(format!(
                        "column {column} references unknown native field {field}"
                    ))
                })?;
            let recipe = constructors::analyze(&db, &fact.module, &native_field.ty, &crate_id)
                .map_err(|error| {
                    located(
                        error,
                        &fact.file,
                        native_field.span(),
                        &format!("{}.{}", row.name, field),
                    )
                })?;
            let scalar = *wire_fields
                .get(&column)
                .ok_or_else(|| Error::new(format!("column {column} has no wire field")))?;
            if recipe.scalar() != scalar {
                return Err(Error::new(format!(
                    "column {column} differs from its exact native scalar"
                )));
            }
            recipes.push(ColumnRecipe {
                column,
                field,
                scalar,
                nullable: false,
                decode: recipe,
            });
        }
        let encode = leaf(&db, &module, &binding.codec.encode)?;
        let decode = leaf(&db, &module, &binding.codec.decode)?;
        check_selected_module(&db, &module, &binding.codec, &fact, &wire, &recipes)?;
        check_encode(&db, &module, &encode, &fact, &wire, &row, &recipes).map_err(|error| {
            located(
                error,
                &selected.file,
                encode.sig.span(),
                &binding.codec.encode,
            )
        })?;
        check_decode(&db, &module, &decode, &fact, &wire, &recipes).map_err(|error| {
            located(
                error,
                &selected.file,
                decode.sig.span(),
                &binding.codec.decode,
            )
        })?;
        (
            crate_id,
            row,
            definition_identity(&wire),
            Entrypoints {
                encode: function_identity(&db, &module, &encode),
                decode: function_identity(&db, &module, &decode),
            },
            recipes,
        )
    };
    let report = CodecRecipeReport {
        version: 1,
        profile: "rust-codec-recipe-v1",
        scope: "selected-codec-and-native-constructor-closure",
        storage_authority: false,
        crate_name: crate_id,
        library: LibraryIdentity {
            package_id: library.package_id,
            target: library.target,
            crate_name: library.crate_name,
            source: library.source,
        },
        row,
        wire,
        entrypoints,
        columns,
        sources: inputs.identities(),
        binding: captured_binding.identity(),
        absent_inputs: inputs.absences(),
        discovery: inputs.discovery().clone(),
    };
    let checked = CheckedCodecRecipe {
        report,
        inputs,
        binding: captured_binding,
    };
    checked.recheck()?;
    Ok(checked)
}

fn absolute_module(crate_id: &str, path: &str) -> Result<String> {
    let parts = source::rust_path(path)?;
    Ok(std::iter::once(crate_id.to_owned())
        .chain(parts.into_iter().skip(1))
        .collect::<Vec<_>>()
        .join("::"))
}

fn definition_identity(definition: &Definition) -> ConstructorItem {
    let span = definition.item.span().start();
    ConstructorItem {
        crate_id: definition
            .module
            .split("::")
            .next()
            .unwrap_or_default()
            .into(),
        module: definition.module.clone(),
        item: source::item_name(&definition.item).unwrap_or_default(),
        file: definition.file.clone(),
        line: span.line.max(1),
        column: span.column + 1,
    }
}

fn function_identity(db: &Database, module: &str, function: &ItemFn) -> ConstructorItem {
    let span = function.sig.ident.span().start();
    ConstructorItem {
        crate_id: db.modules[module].crate_id.clone(),
        module: module.into(),
        item: function.sig.ident.to_string(),
        file: db.modules[module].file.clone(),
        line: span.line.max(1),
        column: span.column + 1,
    }
}

fn same_type(db: &Database, module: &str, ty: &Type, expected: &Definition) -> bool {
    codec::type_definition(db, module, ty).is_ok_and(|found| {
        found.module == expected.module
            && source::item_name(&found.item) == source::item_name(&expected.item)
    })
}

fn wire_fields(db: &Database, wire: &Definition) -> Result<BTreeMap<String, ConstructorScalar>> {
    let Item::Struct(item) = &wire.item else {
        return Err(Error::new("codec wire must be a plain named struct"));
    };
    if !item.generics.params.is_empty() || item.generics.where_clause.is_some() {
        return Err(Error::new("generic codec wire types are unsupported"));
    }
    codec::derives(db, wire, &["Clone", "PartialEq", "Eq"])?;
    let Fields::Named(fields) = &item.fields else {
        return Err(Error::new("codec wire requires named fields"));
    };
    if fields.named.is_empty() || fields.named.len() > 64 {
        return Err(Error::new("codec wire requires one to 64 fields"));
    }
    let syntax = standalone_module(db, &wire.module)?;
    for member in &syntax.items {
        if !matches!(member, Item::Struct(found) if found.ident == item.ident) {
            return Err(Error::at(
                &wire.file,
                member.span(),
                "wire module admits only its one plain wire struct",
            ));
        }
    }
    let mut result = BTreeMap::new();
    for field in &fields.named {
        if !field.attrs.is_empty() || !matches!(field.vis, syn::Visibility::Public(_)) {
            return Err(Error::new(
                "wire fields must be public with no conditional or custom attributes",
            ));
        }
        let scalar = match codec::codec(
            db,
            &wire.module,
            &field.ty,
            &db.modules[&wire.module].crate_id,
        )? {
            crate::Codec::I64 { getters } if getters.is_empty() => ConstructorScalar::I64,
            crate::Codec::U32 { getters } if getters.is_empty() => ConstructorScalar::U32,
            crate::Codec::String { getters } if getters.is_empty() => ConstructorScalar::String,
            _ => {
                return Err(Error::new(
                    "codec wire fields must be exact owned String, i64, or u32 primitives",
                ))
            }
        };
        let name = field
            .ident
            .as_ref()
            .ok_or_else(|| Error::new("wire field must be named"))?
            .to_string();
        if result.insert(name, scalar).is_some() {
            return Err(Error::new("wire fields must be distinct"));
        }
    }
    Ok(result)
}

fn descriptor(db: &Database, module: &str, name: &str) -> Result<Vec<(String, String)>> {
    let definition = db.resolve(module, &[name.into()])?;
    if definition.module != module {
        return Err(Error::new(
            "column descriptor must be defined in the selected codec module",
        ));
    }
    db.check_scope(&definition)?;
    let Item::Const(item) = &definition.item else {
        return Err(Error::new(
            "column descriptor must be a literal const array",
        ));
    };
    if !item.attrs.is_empty() {
        return Err(Error::new("column descriptor cannot have attributes"));
    }
    let Expr::Array(array) = item.expr.as_ref() else {
        return Err(Error::new(
            "column descriptor must contain literal column/field tuples",
        ));
    };
    let Type::Array(declared) = item.ty.as_ref() else {
        return Err(Error::new(
            "column descriptor must declare a fixed array type",
        ));
    };
    let Type::Tuple(pair) = declared.elem.as_ref() else {
        return Err(Error::new(
            "column descriptor type must be [(&str, &str); N]",
        ));
    };
    if pair.elems.len() != 2 || pair.elems.iter().any(|ty| !matches!(ty, Type::Reference(r) if r.mutability.is_none() && r.lifetime.is_none() && matches!(r.elem.as_ref(), Type::Path(p) if p.qself.is_none() && p.path.is_ident("str")))) {
        return Err(Error::new("column descriptor type must be [(&str, &str); N]"));
    }
    let Expr::Lit(length) = &declared.len else {
        return Err(Error::new("column descriptor length must be literal"));
    };
    let syn::Lit::Int(length) = &length.lit else {
        return Err(Error::new("column descriptor length must be an integer"));
    };
    if length.base10_parse::<usize>().ok() != Some(array.elems.len())
        || array.elems.is_empty()
        || array.elems.len() > 64
    {
        return Err(Error::new(
            "column descriptor length must match one to 64 actual columns",
        ));
    }
    let mut columns = BTreeSet::new();
    let mut fields = BTreeSet::new();
    let mut result = Vec::new();
    for element in &array.elems {
        let Expr::Tuple(pair) = element else {
            return Err(Error::new("column descriptor requires pairs"));
        };
        if pair.elems.len() != 2 {
            return Err(Error::new("column descriptor requires pairs"));
        }
        let values = pair
            .elems
            .iter()
            .map(|expression| match expression {
                Expr::Lit(literal) => match &literal.lit {
                    syn::Lit::Str(value) if source::identifier(&value.value()) => Ok(value.value()),
                    _ => Err(Error::new("column/field names must be literal identifiers")),
                },
                _ => Err(Error::new("column/field names must be literal identifiers")),
            })
            .collect::<Result<Vec<_>>>()?;
        if !columns.insert(values[0].clone()) || !fields.insert(values[1].clone()) {
            return Err(Error::new(
                "column and native field mappings must be unique",
            ));
        }
        result.push((values[0].clone(), values[1].clone()));
    }
    Ok(result)
}

fn leaf(db: &Database, module: &str, name: &str) -> Result<ItemFn> {
    let functions: Vec<_> = db
        .production_items
        .iter()
        .filter_map(|(owner, _, item)| match item {
            Item::Fn(function) if owner == module && function.sig.ident == name => Some(function),
            _ => None,
        })
        .collect();
    let [function] = functions.as_slice() else {
        return Err(Error::new(format!(
            "codec leaf {name} must have one direct definition"
        )));
    };
    let signature = &function.sig;
    if !function.attrs.is_empty()
        || signature.constness.is_some()
        || signature.asyncness.is_some()
        || signature.unsafety.is_some()
        || signature.abi.is_some()
        || signature.variadic.is_some()
        || !signature.generics.params.is_empty()
        || signature.generics.where_clause.is_some()
        || signature.inputs.len() != 1
    {
        return Err(Error::at(&db.modules[module].file, signature.span(), "codec leaf must be one unconditional safe nongeneric function with one typed parameter"));
    }
    Ok((*function).clone())
}

fn parameter(function: &ItemFn) -> Result<(String, &Type)> {
    let Some(FnArg::Typed(argument)) = function.sig.inputs.first() else {
        return Err(Error::new("codec leaf requires a typed value parameter"));
    };
    let Pat::Ident(name) = argument.pat.as_ref() else {
        return Err(Error::new("codec parameter must be a plain identifier"));
    };
    if name.by_ref.is_some()
        || name.mutability.is_some()
        || name.subpat.is_some()
        || !argument.attrs.is_empty()
    {
        return Err(Error::new(
            "mutable or destructured codec parameters are unsupported",
        ));
    }
    Ok((name.ident.to_string(), &argument.ty))
}

fn body(function: &ItemFn) -> Result<&Expr> {
    match function.block.stmts.as_slice() {
        [Stmt::Expr(expression, None)] => Ok(expression),
        _ => Err(Error::new(
            "codec leaf must contain exactly one complete expression",
        )),
    }
}

fn construction<'a>(
    db: &Database,
    module: &str,
    expression: &'a Expr,
    expected: &Definition,
) -> Result<BTreeMap<String, &'a Expr>> {
    let Expr::Struct(value) = expression else {
        return Err(Error::new(
            "codec leaf must construct its complete result struct",
        ));
    };
    if value.qself.is_some()
        || value.rest.is_some()
        || !value.attrs.is_empty()
        || !same_type(
            db,
            module,
            &Type::Path(syn::TypePath {
                qself: None,
                path: value.path.clone(),
            }),
            expected,
        )
    {
        return Err(Error::new(
            "codec construction has wrong type or unclassified update/rest",
        ));
    }
    let mut result = BTreeMap::new();
    for field in &value.fields {
        let Member::Named(name) = &field.member else {
            return Err(Error::new("codec construction requires named fields"));
        };
        if !field.attrs.is_empty() || result.insert(name.to_string(), &field.expr).is_some() {
            return Err(Error::new(
                "codec construction fields must be distinct and unconditional",
            ));
        }
    }
    Ok(result)
}

fn row_field(expression: &Expr, parameter: &str, expected: &str) -> bool {
    matches!(expression, Expr::Field(field) if field.attrs.is_empty() && matches!(&field.member, Member::Named(name) if name == expected)
        && matches!(field.base.as_ref(), Expr::Path(path) if path.qself.is_none() && path.attrs.is_empty() && path.path.is_ident(parameter)))
}

fn check_encode(
    db: &Database,
    module: &str,
    function: &ItemFn,
    fact: &Definition,
    wire: &Definition,
    row: &FactPlan,
    columns: &[ColumnRecipe],
) -> Result<()> {
    let (parameter, input) = parameter(function)?;
    if !matches!(input, Type::Reference(reference) if reference.mutability.is_none() && reference.lifetime.is_none() && same_type(db,module,&reference.elem,fact))
    {
        return Err(Error::new(
            "encoder must borrow the exact native Fact immutably",
        ));
    }
    if !matches!(&function.sig.output, ReturnType::Type(_, ty) if same_type(db,module,ty,wire)) {
        return Err(Error::new("encoder must return the exact plain wire type"));
    }
    let fields = construction(db, module, body(function)?, wire)?;
    if fields.len() != columns.len() {
        return Err(Error::new(
            "encoder must preserve every wire field exactly once",
        ));
    }
    for column in columns {
        let mut expression = *fields
            .get(&column.column)
            .ok_or_else(|| Error::new(format!("encoder omits column {}", column.column)))?;
        if column.scalar == ConstructorScalar::String {
            let Expr::MethodCall(call) = expression else {
                return Err(Error::new(
                    "string encoding requires standard owned copying",
                ));
            };
            if call.method != "to_owned"
                || !call.args.is_empty()
                || call.turbofish.is_some()
                || !call.attrs.is_empty()
            {
                return Err(Error::new(
                    "string encoding requires standard to_owned without callbacks",
                ));
            }
            expression = &call.receiver;
        }
        let field = row
            .fields
            .iter()
            .find(|field| field.name == column.field)
            .ok_or_else(|| Error::new("column has no native field plan"))?;
        let getters = match &field.codec {
            crate::Codec::I64 { getters }
            | crate::Codec::U32 { getters }
            | crate::Codec::Bool { getters }
            | crate::Codec::String { getters }
            | crate::Codec::Enum { getters, .. } => getters,
        };
        for getter in getters.iter().rev() {
            let Expr::MethodCall(call) = expression else {
                return Err(Error::new(format!(
                    "encoder {} omits its checked getter",
                    column.column
                )));
            };
            if call.method != getter
                || !call.args.is_empty()
                || call.turbofish.is_some()
                || !call.attrs.is_empty()
            {
                return Err(Error::new(format!(
                    "encoder {} uses an unclassified getter or argument",
                    column.column
                )));
            }
            expression = &call.receiver;
        }
        if !row_field(expression, &parameter, &column.field) {
            return Err(Error::new(format!(
                "encoder {} does not preserve native field {}",
                column.column, column.field
            )));
        }
    }
    Ok(())
}

fn standard(db: &Database, module: &str, path: &syn::Path, name: &str) -> bool {
    let Ok(parts) = codec::path_parts(path) else {
        return false;
    };
    let bare = parts == [name];
    let qualified = if name == "Result" {
        parts == ["std", "result", "Result"] || parts == ["core", "result", "Result"]
    } else {
        parts == ["std", "result", "Result", name] || parts == ["core", "result", "Result", name]
    };
    if !bare && !qualified {
        return false;
    }
    let first = &parts[0];
    !db.modules[module].imports.contains_key(first)
        && !db.modules[module].definitions.contains_key(first)
        && !db.crates[&db.modules[module].crate_id]
            .dependencies
            .contains_key(first)
        && !db.production_items.iter().any(|(owner, _, item)| {
            owner == module
                && match item {
                    Item::Fn(item) => item.sig.ident == first,
                    Item::Static(item) => item.ident == first,
                    Item::ForeignMod(_) => true,
                    _ => false,
                }
        })
}

fn check_decode(
    db: &Database,
    module: &str,
    function: &ItemFn,
    fact: &Definition,
    wire: &Definition,
    columns: &[ColumnRecipe],
) -> Result<()> {
    let (parameter, input) = parameter(function)?;
    if !same_type(db, module, input, wire) {
        return Err(Error::new(
            "decoder must consume the exact plain wire value",
        ));
    }
    let ReturnType::Type(_, result) = &function.sig.output else {
        return Err(Error::new("decoder must return standard Result"));
    };
    let Type::Path(result) = result.as_ref() else {
        return Err(Error::new("decoder must return standard Result"));
    };
    let mut result_path = result.path.clone();
    let arguments = result_path
        .segments
        .last_mut()
        .ok_or_else(|| Error::new("missing decoder return type"))?;
    let PathArguments::AngleBracketed(types) =
        std::mem::replace(&mut arguments.arguments, PathArguments::None)
    else {
        return Err(Error::new(
            "decoder Result needs exact native and error types",
        ));
    };
    if result.qself.is_some()
        || !standard(db, module, &result_path, "Result")
        || types.args.len() != 2
    {
        return Err(Error::new(
            "decoder must return standard Result<Fact, native error>",
        ));
    }
    let mut types = types.args.iter();
    let (Some(GenericArgument::Type(value)), Some(GenericArgument::Type(error))) =
        (types.next(), types.next())
    else {
        return Err(Error::new("decoder Result needs type arguments"));
    };
    if !same_type(db, module, value, fact) {
        return Err(Error::new("decoder result does not name its exact Fact"));
    }
    let error = codec::type_definition(db, module, error)?;
    let expected = definition_identity(&error);
    let errors: Vec<_> = columns
        .iter()
        .filter_map(|column| column.decode.fallible_error())
        .collect();
    if errors.is_empty()
        || errors
            .iter()
            .any(|error| error.module != expected.module || error.item != expected.item)
    {
        return Err(Error::new(
            "decoder error must be the exact common constructor error",
        ));
    }
    let Expr::Call(ok) = body(function)? else {
        return Err(Error::new(
            "decoder must construct standard Ok with one complete Fact",
        ));
    };
    let Expr::Path(path) = ok.func.as_ref() else {
        return Err(Error::new(
            "decoder cannot invoke an arbitrary result callback",
        ));
    };
    if path.path.is_ident(&parameter) {
        return Err(Error::new(
            "decoder parameter shadows the bare standard result constructor",
        ));
    }
    if !ok.attrs.is_empty()
        || path.qself.is_some()
        || !standard(db, module, &path.path, "Ok")
        || ok.args.len() != 1
    {
        return Err(Error::new(
            "decoder must use standard Ok with one complete Fact",
        ));
    }
    let fields = construction(db, module, ok.args.first().unwrap(), fact)?;
    if fields.len() != columns.len() {
        return Err(Error::new(
            "decoder must reconstruct every original field exactly once",
        ));
    }
    for column in columns {
        let expression = fields
            .get(&column.field)
            .ok_or_else(|| Error::new(format!("decoder omits field {}", column.field)))?;
        check_constructor_expression(
            db,
            module,
            expression,
            &parameter,
            &column.column,
            &column.decode,
        )?;
    }
    Ok(())
}

fn check_constructor_expression(
    db: &Database,
    module: &str,
    expression: &Expr,
    parameter: &str,
    column: &str,
    recipe: &ConstructorRecipe,
) -> Result<()> {
    match recipe {
        ConstructorRecipe::Identity { .. } => {
            if row_field(expression, parameter, column) {
                Ok(())
            } else {
                Err(Error::new(format!(
                    "decoder column {column} does not preserve its exact scalar"
                )))
            }
        }
        ConstructorRecipe::TupleWrap { constructor, inner } => {
            let argument = constructor_argument(db, module, expression, constructor)?;
            check_constructor_expression(db, module, argument, parameter, column, inner)
        }
        ConstructorRecipe::AsciiSymbol { constructor, .. } => {
            let Expr::Try(value) = expression else {
                return Err(Error::new(
                    "Symbol decoding must propagate its validated constructor error",
                ));
            };
            if !value.attrs.is_empty() {
                return Err(Error::new(
                    "custom attributes on constructor expressions are unsupported",
                ));
            }
            let argument = constructor_argument(db, module, &value.expr, constructor)?;
            if matches!(argument,Expr::Reference(reference) if reference.mutability.is_none() && reference.attrs.is_empty() && row_field(&reference.expr,parameter,column))
            {
                Ok(())
            } else {
                Err(Error::new(format!(
                    "Symbol decoder column {column} must borrow its exact wire string"
                )))
            }
        }
    }
}

fn constructor_argument<'a>(
    db: &Database,
    module: &str,
    expression: &'a Expr,
    expected: &ConstructorItem,
) -> Result<&'a Expr> {
    let Expr::Call(call) = expression else {
        return Err(Error::new(
            "decoder requires the checked direct inherent constructor",
        ));
    };
    let Expr::Path(function) = call.func.as_ref() else {
        return Err(Error::new(
            "constructor callbacks and function values are unsupported",
        ));
    };
    if !call.attrs.is_empty()
        || !function.attrs.is_empty()
        || function.qself.is_some()
        || call.args.len() != 1
    {
        return Err(Error::new(
            "constructor call must have one classified argument",
        ));
    }
    let mut parts = codec::path_parts(&function.path)?;
    let method = parts
        .pop()
        .ok_or_else(|| Error::new("constructor call requires a method"))?;
    let owner = db.resolve(module, &parts)?;
    let name = source::item_name(&owner.item)
        .ok_or_else(|| Error::new("constructor owner must be a resolved native type"))?;
    if owner.module != expected.module || format!("{name}::{method}") != expected.item {
        return Err(Error::new(
            "decoder invokes a different native constructor identity",
        ));
    }
    Ok(call.args.first().unwrap())
}

fn check_selected_module(
    db: &Database,
    module: &str,
    entrypoints: &RecipeEntrypoints,
    fact: &Definition,
    wire: &Definition,
    columns: &[ColumnRecipe],
) -> Result<()> {
    let syntax = standalone_module(db, module)?;
    let file = &db.modules[module].file;
    for item in &syntax.items {
        refuse_attributes(file, item)?;
        match item {
            Item::Use(item) if item.attrs.is_empty() => {}
            Item::Const(item) if item.ident == entrypoints.descriptor => {}
            Item::Fn(item)
                if item.sig.ident == entrypoints.encode || item.sig.ident == entrypoints.decode => {
            }
            _ => {
                return Err(Error::at(
                    file,
                    item.span(),
                    "codec module contains an unclassified item or unused body",
                ))
            }
        }
    }
    let mut allowed = BTreeSet::from([
        (fact.module.clone(), source::item_name(&fact.item).unwrap()),
        (wire.module.clone(), source::item_name(&wire.item).unwrap()),
    ]);
    fn types(recipe: &ConstructorRecipe, allowed: &mut BTreeSet<(String, String)>) {
        match recipe {
            ConstructorRecipe::Identity { .. } => {}
            ConstructorRecipe::TupleWrap { constructor, inner } => {
                allowed.insert((
                    constructor.module.clone(),
                    constructor
                        .item
                        .split("::")
                        .next()
                        .unwrap_or_default()
                        .into(),
                ));
                types(inner, allowed);
            }
            ConstructorRecipe::AsciiSymbol {
                constructor,
                error_type,
            } => {
                allowed.insert((
                    constructor.module.clone(),
                    constructor
                        .item
                        .split("::")
                        .next()
                        .unwrap_or_default()
                        .into(),
                ));
                allowed.insert((error_type.module.clone(), error_type.item.clone()));
            }
        }
    }
    for column in columns {
        types(&column.decode, &mut allowed);
    }
    for (name, import) in &db.modules[module].imports {
        let definition = db.resolve(module, &import.path).map_err(|_| {
            Error::new(format!(
                "codec import {name} does not resolve to an admitted value type"
            ))
        })?;
        if !allowed.contains(&(
            definition.module.clone(),
            source::item_name(&definition.item).unwrap_or_default(),
        )) {
            return Err(Error::new(format!(
                "codec import {name} is outside its native/wire type closure"
            )));
        }
    }
    Ok(())
}

fn standalone_module(db: &Database, module: &str) -> Result<syn::File> {
    let selected = db
        .modules
        .get(module)
        .ok_or_else(|| Error::new("selected source module is absent"))?;
    if db
        .modules
        .values()
        .filter(|candidate| candidate.file == selected.file)
        .count()
        != 1
    {
        return Err(Error::new(
            "codec and wire modules require separate out-of-line source files",
        ));
    }
    let text = db.source_text(&selected.file).ok_or_else(|| {
        Error::new("selected module bytes are absent from the checked input capture")
    })?;
    let syntax = syn::parse_file(text)
        .map_err(|error| Error::new(format!("invalid selected source module: {error}")))?;
    if !syntax.attrs.is_empty() || syntax.shebang.is_some() {
        return Err(Error::new(
            "selected codec and wire files cannot have file attributes or a shebang",
        ));
    }
    Ok(syntax)
}

fn refuse_attributes(file: &str, item: &Item) -> Result<()> {
    struct Attributes {
        first: Option<proc_macro2::Span>,
    }
    impl<'ast> syn::visit::Visit<'ast> for Attributes {
        fn visit_attribute(&mut self, attribute: &'ast syn::Attribute) {
            self.first.get_or_insert(attribute.span());
        }
    }
    let mut attributes = Attributes { first: None };
    syn::visit::Visit::visit_item(&mut attributes, item);
    if let Some(span) = attributes.first {
        return Err(Error::at(file,span,"codec leaves, descriptors, imports, and their nested expressions cannot have attributes"));
    }
    Ok(())
}

fn located(mut error: Error, file: &str, span: proc_macro2::Span, item: &str) -> Error {
    error.message = format!("{item}: {}", error.message);
    if error.file.is_some() {
        error
    } else {
        Error::at(file, span, error.message)
    }
}
