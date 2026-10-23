use crate::error::{Error, Result};
use crate::source::{Database, Definition};
use proc_macro2::{TokenStream, TokenTree};
use syn::parse::Parser;
use syn::punctuated::Punctuated;
use syn::spanned::Spanned;
use syn::visit::Visit;
use syn::{Attribute, Item, Token};

fn standard_macro(name: &str) -> bool {
    matches!(
        name,
        "assert"
            | "assert_eq"
            | "assert_ne"
            | "debug_assert"
            | "debug_assert_eq"
            | "debug_assert_ne"
            | "format"
            | "format_args"
            | "write"
            | "writeln"
            | "print"
            | "println"
            | "eprint"
            | "eprintln"
            | "panic"
            | "unreachable"
            | "todo"
            | "unimplemented"
            | "matches"
            | "vec"
            | "concat"
            | "stringify"
            | "include_str"
            | "include_bytes"
            | "env"
            | "option_env"
            | "file"
            | "line"
            | "column"
            | "module_path"
    )
}
fn standard_derive(name: &str) -> bool {
    matches!(
        name,
        "Clone" | "Copy" | "Debug" | "Default" | "PartialEq" | "Eq" | "PartialOrd" | "Ord" | "Hash"
    )
}
fn has_impl(tokens: TokenStream) -> bool {
    tokens.into_iter().any(|token| match token {
        TokenTree::Ident(ident) => ident == "impl",
        TokenTree::Group(group) => has_impl(group.stream()),
        _ => false,
    })
}
pub fn audit(db: &Database) -> Result<()> {
    for scope in db.modules.values() {
        for alias in db.crates[&scope.crate_id].dependencies.keys() {
            if scope.definitions.contains_key(alias) || scope.imports.contains_key(alias) {
                return Err(Error::new(format!(
                    "{}: dependency alias {alias} is shadowed by a local module or import",
                    scope.file
                )));
            }
        }
        if let Some(span) = scope.opaque_macros.first() {
            return Err(Error::at(&scope.file, *span, "opaque item macros anywhere in the production library closure can add nonlocal implementations; use supported source items"));
        }
        if scope.macro_use {
            return Err(Error::new(format!(
                "{}: macro_use can alter global macro/derive resolution and is unsupported",
                scope.file
            )));
        }
    }
    for implementation in &db.implementations {
        let syn::Type::Path(target) = implementation.item.self_ty.as_ref() else {
            return Err(Error::at(&implementation.file, implementation.item.span(), "implementation targets must be resolved type paths in the production source profile"));
        };
        let target_parts: Vec<_> = target
            .path
            .segments
            .iter()
            .map(|segment| segment.ident.to_string())
            .collect();
        let definition = db.resolve(&implementation.module, &target_parts).map_err(|_| Error::at(&implementation.file, target.span(), "implementation target cannot be resolved; source aliases must not hide a bound value"))?;
        if let Item::Type(alias) = &definition.item {
            if definition.conditional
                || !alias.generics.params.is_empty()
                || alias.attrs.iter().any(|attr| !attr.path().is_ident("doc"))
            {
                return Err(Error::at(&definition.file, alias.span(), "conditional, generic, or custom attributed implementation aliases are unsupported"));
            }
        }
        if let Some((_, path, _)) = &implementation.item.trait_ {
            let trait_name = crate::codec::trait_name(db, &implementation.module, path)?;
            if trait_name.starts_with("unsupported:") {
                return Err(Error::at(&implementation.file, path.span(), "unresolved explicit traits may alias Drop and are outside the production source profile"));
            }
            if trait_name == "Drop" {
                return Err(Error::at(&implementation.file, implementation.item.span(), "explicit Drop implementations anywhere in the production library closure are outside the whole-row owned profile"));
            }
        }
    }
    for (module, file, attributes) in &db.file_attributes {
        let mut visitor = MacroAudit {
            db,
            module,
            file,
            error: None,
        };
        for attribute in attributes {
            visitor.visit_attribute(attribute);
        }
        if let Some(error) = visitor.error {
            return Err(error);
        }
    }
    for (module, file, item) in &db.production_items {
        let mut visitor = MacroAudit {
            db,
            module,
            file,
            error: None,
        };
        visitor.visit_item(item);
        if let Some(error) = visitor.error {
            return Err(error);
        }
    }
    Ok(())
}
struct MacroAudit<'a> {
    db: &'a Database,
    module: &'a str,
    file: &'a str,
    error: Option<Error>,
}
impl MacroAudit<'_> {
    fn reject(&mut self, span: proc_macro2::Span, message: impl Into<String>) {
        if self.error.is_none() {
            self.error = Some(Error::at(self.file, span, message));
        }
    }
    fn unshadowed(&self, name: &str) -> bool {
        let mut ancestor = Some(self.module);
        while let Some(module) = ancestor {
            let scope = &self.db.modules[module];
            if scope.definitions.contains_key(name)
                || scope.imports.contains_key(name)
                || scope.macro_use
            {
                return false;
            }
            ancestor = module.rsplit_once("::").map(|(parent, _)| parent);
        }
        let crate_id = &self.db.modules[self.module].crate_id;
        !self.db.modules.values().filter(|scope| &scope.crate_id == crate_id).any(|scope| scope.definitions.get(name).is_some_and(|definition| {
            matches!(&definition.item, Item::Macro(item) if item.attrs.iter().any(|a| a.path().is_ident("macro_export")))
        }))
    }
    fn tokens(&mut self, tokens: TokenStream) {
        let tokens: Vec<_> = tokens.into_iter().collect();
        for (index, token) in tokens.iter().enumerate() {
            if let TokenTree::Ident(ident) = token {
                if ident == "impl" {
                    self.reject(
                        ident.span(),
                        "macro input tokens cannot contain nonlocal impl items",
                    );
                    return;
                }
                if tokens
                    .get(index + 1)
                    .is_some_and(|t| matches!(t, TokenTree::Punct(p) if p.as_char() == '!'))
                    && tokens
                        .get(index + 2)
                        .is_some_and(|t| matches!(t, TokenTree::Group(_)))
                {
                    let qualified = index > 0
                        && matches!(&tokens[index - 1], TokenTree::Punct(p) if p.as_char() == ':');
                    if qualified
                        || !standard_macro(&ident.to_string())
                        || !self.unshadowed(&ident.to_string())
                    {
                        self.reject(ident.span(), "unknown, qualified, or shadowed nested macros are outside the production source profile");
                        return;
                    }
                }
            }
            if let TokenTree::Group(group) = token {
                self.tokens(group.stream());
            }
        }
    }
    fn trusted_derive(&self, path: &syn::Path) -> bool {
        let mut parts: Vec<_> = path.segments.iter().map(|p| p.ident.to_string()).collect();
        if parts.len() == 1 {
            if standard_derive(&parts[0]) {
                return self.unshadowed(&parts[0]);
            }
            if let Some(import) = self.db.modules[self.module].imports.get(&parts[0]) {
                parts = import.path.clone();
            }
        }
        let scope = &self.db.modules[self.module];
        if parts.len() != 2
            || self.db.modules[self.module]
                .definitions
                .contains_key(&parts[0])
        {
            return false;
        }
        let package = self.db.crates[&scope.crate_id]
            .dependency_packages
            .get(&parts[0])
            .map(String::as_str);
        if !self.db.crates[&scope.crate_id]
            .registry_dependencies
            .contains(&parts[0])
        {
            return false;
        }
        matches!(
            (package, parts[1].as_str()),
            (Some("serde"), "Serialize" | "Deserialize")
                | (Some("clap"), "Parser" | "ValueEnum" | "Args" | "Subcommand")
        )
    }
}
impl<'ast> Visit<'ast> for MacroAudit<'_> {
    fn visit_item_mod(&mut self, item: &'ast syn::ItemMod) {
        for attribute in &item.attrs {
            self.visit_attribute(attribute);
        }
    }
    fn visit_item_macro(&mut self, item: &'ast syn::ItemMacro) {
        if let Some(name) = &item.ident {
            let key = format!("{}::{name}", self.module);
            if self.db.validated_macros.contains(&key) {
                return;
            }
            if standard_macro(&name.to_string())
                || standard_derive(&name.to_string())
                || has_impl(item.mac.tokens.clone())
            {
                self.reject(item.span(), "unvalidated macro definitions cannot shadow standard names or contain impl-producing tokens");
            }
            return;
        }
        let parts: Vec<_> = item
            .mac
            .path
            .segments
            .iter()
            .map(|p| p.ident.to_string())
            .collect();
        if parts.len() == 1 {
            if let Ok(Definition {
                module,
                item: Item::Macro(definition),
                ..
            }) = self.db.resolve(self.module, &parts)
            {
                if let Some(name) = definition.ident {
                    if self
                        .db
                        .validated_macros
                        .contains(&format!("{module}::{name}"))
                    {
                        return;
                    }
                }
            }
        }
        self.reject(
            item.span(),
            "unclassified item-producing macro in production library closure",
        );
    }
    fn visit_macro(&mut self, invocation: &'ast syn::Macro) {
        let parts: Vec<_> = invocation
            .path
            .segments
            .iter()
            .map(|p| p.ident.to_string())
            .collect();
        if parts.len() != 1 || !standard_macro(&parts[0]) || !self.unshadowed(&parts[0]) {
            self.reject(invocation.span(), format!("only unshadowed standard expression macros are supported in production source; found {}", invocation.path.segments.iter().map(|part| part.ident.to_string()).collect::<Vec<_>>().join("::")));
            return;
        }
        self.tokens(invocation.tokens.clone());
    }
    fn visit_item_use(&mut self, item: &'ast syn::ItemUse) {
        fn dangerous(tree: &syn::UseTree) -> bool {
            match tree {
                syn::UseTree::Path(path) => dangerous(&path.tree),
                syn::UseTree::Name(name) => {
                    standard_macro(&name.ident.to_string())
                        || standard_derive(&name.ident.to_string())
                }
                syn::UseTree::Rename(rename) => {
                    standard_macro(&rename.rename.to_string())
                        || standard_derive(&rename.rename.to_string())
                }
                syn::UseTree::Group(group) => group.items.iter().any(dangerous),
                syn::UseTree::Glob(_) => true,
            }
        }
        // Module imports are already resolved. Local imports can shadow a macro
        // without appearing in that namespace, so the conservative profile
        // rejects standard macro/derive names and globs in every use item.
        if dangerous(&item.tree) {
            self.reject(item.span(), "imports cannot introduce standard macro/derive names or globs in the production profile");
        }
    }
    fn visit_attribute(&mut self, attr: &'ast Attribute) {
        if attr.path().is_ident("cfg_attr") {
            let Ok(list) = attr.meta.require_list() else {
                self.reject(attr.span(), "invalid cfg_attr");
                return;
            };
            let Ok(arguments) =
                Punctuated::<syn::Meta, Token![,]>::parse_terminated.parse2(list.tokens.clone())
            else {
                self.reject(attr.span(), "unsupported cfg_attr");
                return;
            };
            if !matches!(arguments.first(), Some(syn::Meta::Path(path)) if path.is_ident("kani") || path.is_ident("test"))
            {
                self.reject(
                    attr.span(),
                    "cfg_attr supports only production-disabled literal test/kani conditions",
                );
            }
            return;
        }
        if attr.path().is_ident("derive") {
            let Ok(list) = attr.meta.require_list() else {
                self.reject(attr.span(), "invalid derive attribute");
                return;
            };
            let Ok(paths) =
                Punctuated::<syn::Path, Token![,]>::parse_terminated.parse2(list.tokens.clone())
            else {
                self.reject(attr.span(), "invalid derive paths");
                return;
            };
            if paths.iter().any(|path| !self.trusted_derive(path)) {
                self.reject(attr.span(), "unknown or shadowed derives may emit nonlocal implementations and are unsupported");
            }
            return;
        }
        let Some(name) = attr.path().get_ident() else {
            self.reject(
                attr.span(),
                "procedural attribute paths are outside the production source profile",
            );
            return;
        };
        if !matches!(
            name.to_string().as_str(),
            "doc"
                | "cfg"
                | "cfg_attr"
                | "allow"
                | "deny"
                | "warn"
                | "forbid"
                | "inline"
                | "must_use"
                | "repr"
                | "non_exhaustive"
                | "deprecated"
                | "cold"
                | "track_caller"
                | "path"
                | "macro_export"
                | "test"
                | "ignore"
                | "should_panic"
                | "serde"
                | "command"
                | "arg"
                | "value"
        ) {
            self.reject(
                attr.span(),
                "unknown procedural attributes are outside the production source profile",
            );
        }
    }
}
