import type { BackendInput, GeneratedFile } from '../types.js';
import path from 'node:path';

function rustRawString(value: string): string {
  let delimiter = '#';
  while (value.includes(`"${delimiter}`)) delimiter += '#';
  return `r${delimiter}"${value}"${delimiter}`;
}

/** Generate a syntax checker. This does not expand macros or prove Rust behavior. */
export function generateRust(input: BackendInput): GeneratedFile[] {
  let binding = input.binding;
  if (input.binding.kind === 'dependency') {
    for (const [state, prefixes] of Object.entries(input.binding.modules)) {
      if (!input.automaton.states.includes(state)) throw new Error(`Unknown model state in Rust binding: ${state}`);
      for (const prefix of prefixes) {
        if (prefix.startsWith('/') || /^[A-Za-z]:/.test(prefix) || prefix.includes('\\') || prefix.split('/').includes('..') || path.posix.normalize(prefix) === '.') {
          throw new Error(`Rust module prefix must be a nonempty project-relative path: ${prefix}`);
        }
      }
    }
    for (const state of input.automaton.states) {
      if (!input.binding.modules[state]) throw new Error(`Model state ${state} has no dependency module mapping`);
    }
    binding = { kind: 'dependency', modules: Object.fromEntries(Object.entries(input.binding.modules).map(([state, prefixes]) => [state, prefixes.map(prefix => path.posix.normalize(prefix).replace(/\/+$/, ''))])) };
  }
  const policy = rustRawString(JSON.stringify({ automaton: input.automaton, binding }));
  return [
    { path: 'Cargo.toml', content: `[package]
name = "tlc-generated-checker"
version = "0.1.0"
edition = "2021"
publish = false

[workspace]

[dependencies]
syn = { version = "2", features = ["full", "visit"] }
proc-macro2 = { version = "1", features = ["span-locations"] }
serde_json = "1"
` },
    { path: 'src/main.rs', content: RUST_SOURCE.replace('POLICY_PLACEHOLDER', policy) },
  ];
}

const RUST_SOURCE = String.raw`//! Generated checker: finite-model edge declarations or direct use/mod dependencies.
//! Only explicitly supplied files are checked. No macro expansion or Rust name resolution.
//! Opaque macros and procedural attributes in checked files fail closed.
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use proc_macro2::Span;
use serde_json::{json, Value};
use syn::{ext::IdentExt, spanned::Spanned, visit::{self, Visit}, Expr, Token, UseTree};
use syn::parse::Parser;

const POLICY: &str = POLICY_PLACEHOLDER;

enum Rule {
    Transition(String),
    Dependency(Vec<(String, Vec<String>)>),
}
struct Policy {
    rule: Rule,
    edges: HashSet<(String, String, String)>,
}
impl Policy {
    fn load() -> Self {
        let data: Value = serde_json::from_str(POLICY).expect("generated policy JSON");
        let binding = &data["binding"];
        let rule = if binding["kind"] == "transition" {
            Rule::Transition(binding["function"].as_str().expect("function").into())
        } else {
            Rule::Dependency(binding["modules"].as_object().expect("modules").iter().map(|(state, prefixes)| {
                (state.clone(), prefixes.as_array().expect("prefixes").iter().map(|p| p.as_str().expect("prefix").into()).collect())
            }).collect())
        };
        let edges = data["automaton"]["transitions"].as_array().expect("transitions").iter().map(|edge| {
            (edge["from"].as_str().expect("from").into(), edge["event"].as_str().expect("event").into(), edge["to"].as_str().expect("to").into())
        }).collect();
        Self { rule, edges }
    }
    fn state_for(&self, file: &str) -> Result<Option<String>, String> {
        let Rule::Dependency(modules) = &self.rule else { return Ok(None); };
        let states: HashSet<&String> = modules.iter().filter(|(_, prefixes)| prefixes.iter().any(|prefix| {
            file == prefix || file.starts_with(&format!("{prefix}/"))
        })).map(|(state, _)| state).collect();
        if states.len() > 1 { return Err(format!("ambiguous module binding for {file}")); }
        Ok(states.into_iter().next().cloned())
    }
}

#[derive(Clone)]
enum Alias { Pending(Vec<String>, bool), Local(Vec<String>), External }

fn ident_name(ident: &syn::Ident) -> String { ident.unraw().to_string() }

struct Checker<'a> {
    policy: &'a Policy,
    root: &'a Path,
    file: String,
    source_state: Option<String>,
    crate_dir: PathBuf,
    module: Vec<String>,
    aliases: Vec<HashMap<String, Alias>>,
    diagnostics: Vec<Value>,
}
impl Checker<'_> {
    fn diagnostic(&mut self, id: &str, span: Span, message: impl Into<String>) {
        let start = span.start();
        self.diagnostics.push(json!({"ruleId": id, "file": self.file, "line": start.line, "column": start.column + 1, "message": message.into()}));
    }
    fn unsupported(&mut self, span: Span, message: impl Into<String>) {
        self.diagnostic("TLC002", span, message);
    }
    fn local_base(&self, path: &[String], absolute: bool) -> Result<Option<Vec<String>>, String> {
        let Some(first) = path.first() else { return Err("empty dependency path".into()); };
        if absolute {
            if matches!(first.as_str(), "crate" | "self" | "super") { return Err("invalid absolute local dependency qualifier".into()); }
            return Ok(None); // Rust 2018 ::name is an external-crate path.
        }
        let mut rest = path.to_vec();
        let mut base = match first.as_str() {
            "crate" => { rest.remove(0); Vec::new() },
            "self" => { rest.remove(0); self.module.clone() },
            "super" => self.module.clone(),
            _ => {
                if let Some(alias) = self.aliases.iter().rev().find_map(|aliases| aliases.get(first)) {
                    return match alias {
                        Alias::Pending(_, _) => Err(format!("cannot resolve import alias {first}; cyclic or unsupported alias chain")),
                        Alias::External => Ok(None),
                        Alias::Local(target) => { let mut target = target.clone(); target.extend(path.iter().skip(1).cloned()); Ok(Some(target)) },
                    };
                }
                // Bare paths can name extern crates or local names. Do not guess when a
                // root/current module exists: require crate/self/super qualification.
                let mut current = self.module.clone(); current.push(first.clone());
                if !self.module_candidates(&[first.clone()]).is_empty() || !self.module_candidates(&current).is_empty() {
                    return Err(format!("qualify local dependency {first} with crate, self, or super"));
                }
                return Ok(None); // Explicit boundary: unresolved bare paths are external.
            }
        };
        while rest.first().is_some_and(|part| part == "super") {
            rest.remove(0);
            if base.pop().is_none() { return Err("super dependency escapes the crate root".into()); }
        }
        if rest.iter().any(|part| part == "crate" || part == "super" || part == "self") {
            return Err("unsupported dependency path qualifier".into());
        }
        base.extend(rest);
        Ok(Some(base))
    }
    fn module_candidates(&self, parts: &[String]) -> Vec<PathBuf> {
        let mut base = self.crate_dir.clone();
        for part in parts { base.push(part); }
        let candidates = if parts.is_empty() {
            let source = self.root.join(&self.file);
            if source.file_name().is_some_and(|name| name == "lib.rs" || name == "main.rs") {
                vec![source]
            } else { vec![base.join("lib.rs"), base.join("main.rs")] }
        } else {
            vec![base.with_extension("rs"), base.join("mod.rs")]
        };
        candidates.into_iter().filter(|candidate| candidate.is_file()).collect()
    }
    fn dependency(&mut self, parts: &[String], absolute: bool, span: Span, exact_module: bool) {
        let resolved = match self.local_base(parts, absolute) {
            Ok(Some(parts)) => parts,
            Ok(None) => return,
            Err(message) => { self.unsupported(span, message); return; }
        };
        // A trailing item/type name is not a module. Find the deepest real module.
        for length in (0..=resolved.len()).rev() {
            // A crate root is a target only for an explicit root alias. An unknown
            // single name must not silently become a permitted root dependency.
            if (exact_module && length != resolved.len()) || (length == 0 && !resolved.is_empty()) { continue; }
            let candidates = self.module_candidates(&resolved[..length]);
            if candidates.len() > 1 { self.unsupported(span, "ambiguous Rust module source; separate crate roots or module files"); return; }
            if let Some(target) = candidates.into_iter().next() {
                let target = match target.canonicalize() {
                    Ok(path) if path.starts_with(self.root) => path,
                    _ => { self.unsupported(span, "dependency resolves outside the project root"); return; }
                };
                let relative = target.strip_prefix(self.root).expect("checked root").to_string_lossy().replace('\\', "/");
                let to = match self.policy.state_for(&relative) {
                    Ok(Some(state)) => state,
                    Ok(None) => { self.unsupported(span, format!("local dependency is outside the module binding: {relative}")); return; }
                    Err(message) => { self.unsupported(span, message); return; }
                };
                let Some(from) = &self.source_state else { return; };
                if from != &to && !self.policy.edges.iter().any(|(a, _, b)| a == from && b == &to) {
                    self.diagnostic("TLC003", span, format!("model forbids dependency {from} -> {to}"));
                }
                return;
            }
        }
        self.unsupported(span, format!("cannot resolve local dependency {}", parts.join("::")));
    }
    fn imports(&mut self, tree: &UseTree, prefix: &[String], absolute: bool, collect: bool) {
        match tree {
            UseTree::Path(path) => {
                let mut prefix = prefix.to_vec(); prefix.push(ident_name(&path.ident));
                self.imports(&path.tree, &prefix, absolute, collect);
            }
            UseTree::Group(group) => for tree in &group.items { self.imports(tree, prefix, absolute, collect); },
            UseTree::Name(name) => {
                let mut path = prefix.to_vec();
                let name = ident_name(&name.ident);
                if name != "self" { path.push(name.clone()); }
                self.import_leaf(path, name, absolute, tree.span(), collect);
            }
            UseTree::Rename(rename) => {
                let mut path = prefix.to_vec();
                let name = ident_name(&rename.ident);
                if name != "self" { path.push(name); }
                self.import_leaf(path, ident_name(&rename.rename), absolute, rename.span(), collect);
            }
            UseTree::Glob(glob) => {
                if collect { return; }
                self.unsupported(glob.span(), "glob imports are unsupported in checked modules");
            }
        }
    }
    fn import_leaf(&mut self, path: Vec<String>, alias: String, absolute: bool, span: Span, collect: bool) {
        if collect {
            let alias = if alias == "self" { path.last().cloned().unwrap_or(alias) } else { alias };
            self.aliases.last_mut().expect("scope").insert(alias, Alias::Pending(path, absolute));
        } else { self.dependency(&path, absolute, span, false); }
    }
    fn resolve_imports(&mut self) {
        // Rust imports are visible throughout their scope. Register all names
        // before resolving any value so a later local alias cannot look external.
        loop {
            let pending: Vec<_> = self.aliases.last().expect("scope").iter().filter_map(|(name, alias)| {
                if let Alias::Pending(path, absolute) = alias { Some((name.clone(), path.clone(), *absolute)) } else { None }
            }).collect();
            let mut progress = false;
            for (name, path, absolute) in pending {
                let value = match self.local_base(&path, absolute) {
                    Ok(Some(target)) => Alias::Local(target),
                    Ok(None) => Alias::External,
                    Err(_) => continue,
                };
                self.aliases.last_mut().expect("scope").insert(name, value);
                progress = true;
            }
            if !progress { break; }
        }
    }
    fn collect_imports(&mut self, items: &[syn::Item]) {
        for item in items {
            if let syn::Item::Use(item) = item { self.imports(&item.tree, &[], item.leading_colon.is_some(), true); }
        }
        self.resolve_imports();
    }
}
impl<'ast> Visit<'ast> for Checker<'_> {
    fn visit_macro(&mut self, node: &'ast syn::Macro) {
        match &self.policy.rule {
            Rule::Transition(name) if node.path.segments.last().is_some_and(|segment| ident_name(&segment.ident) == name.as_str()) => {
                let parser = syn::punctuated::Punctuated::<syn::LitStr, Token![,]>::parse_terminated;
                let args = match parser.parse2(node.tokens.clone()) {
                    Ok(args) if args.len() == 3 => args,
                    _ => { self.unsupported(node.span(), "checked transition macro requires exactly three string literals"); return; }
                };
                let values: Vec<String> = args.iter().map(syn::LitStr::value).collect();
                let edge = (values[0].clone(), values[1].clone(), values[2].clone());
                if !self.policy.edges.contains(&edge) {
                    self.diagnostic("TLC001", node.span(), format!("model forbids transition {} --{}--> {}", edge.0, edge.1, edge.2));
                }
            }
            _ => self.unsupported(node.span(), "opaque macro expansion is unsupported in checked files"),
        }
    }
    fn visit_expr_path(&mut self, node: &'ast syn::ExprPath) {
        if let Rule::Transition(name) = &self.policy.rule {
            if node.path.segments.last().is_some_and(|segment| ident_name(&segment.ident) == name.as_str()) {
                self.unsupported(node.span(), "checked transition function references are unsupported; use a direct literal call");
            }
        }
        visit::visit_expr_path(self, node);
    }
    fn visit_expr_call(&mut self, node: &'ast syn::ExprCall) {
        if let (Rule::Transition(name), Expr::Path(callee)) = (&self.policy.rule, node.func.as_ref()) {
            if callee.path.segments.last().is_some_and(|segment| ident_name(&segment.ident) == name.as_str()) {
                let values: Option<Vec<String>> = node.args.iter().map(|arg| match arg {
                    Expr::Lit(syn::ExprLit { lit: syn::Lit::Str(value), .. }) => Some(value.value()),
                    _ => None,
                }).collect();
                if callee.qself.is_some() || callee.path.segments.iter().any(|segment| !matches!(segment.arguments, syn::PathArguments::None)) {
                    self.unsupported(node.span(), "checked transition call requires a simple function path without generic arguments");
                } else if let Some(values) = values.filter(|values| values.len() == 3) {
                    let edge = (values[0].clone(), values[1].clone(), values[2].clone());
                    if !self.policy.edges.contains(&edge) {
                        self.diagnostic("TLC001", node.span(), format!("model forbids transition {} --{}--> {}", edge.0, edge.1, edge.2));
                    }
                } else {
                    self.unsupported(node.span(), "checked transition call requires exactly three string literals");
                }
                // Only this exact direct callee is permitted as a function path.
                // Inspect argument expressions and attributes without treating the
                // checked callee itself as an escaping function reference.
                for attr in node.attrs.iter().chain(&callee.attrs) { self.visit_attribute(attr); }
                for arg in &node.args { self.visit_expr(arg); }
                return;
            }
        }
        visit::visit_expr_call(self, node);
    }
    fn visit_expr_method_call(&mut self, node: &'ast syn::ExprMethodCall) {
        if let Rule::Transition(name) = &self.policy.rule {
            if ident_name(&node.method) == name.as_str() { self.unsupported(node.span(), "checked transition method calls are unsupported; use a direct literal call"); }
        }
        visit::visit_expr_method_call(self, node);
    }
    fn visit_attribute(&mut self, node: &'ast syn::Attribute) {
        let name = node.path().get_ident().map(ident_name).unwrap_or_default();
        if !matches!(name.as_str(), "cfg" | "test" | "allow" | "warn" | "deny" | "forbid" | "doc" | "inline" | "cold" | "must_use" | "deprecated" | "repr" | "non_exhaustive") {
            self.unsupported(node.span(), "procedural or unsupported attribute in checked file");
        }
    }
    fn visit_item_use(&mut self, node: &'ast syn::ItemUse) {
        if matches!(self.policy.rule, Rule::Dependency(_)) { self.imports(&node.tree, &[], node.leading_colon.is_some(), false); }
        visit::visit_item_use(self, node);
    }
    fn visit_use_rename(&mut self, node: &'ast syn::UseRename) {
        if let Rule::Transition(name) = &self.policy.rule {
            if ident_name(&node.ident) == name.as_str() && ident_name(&node.rename) != ident_name(&node.ident) {
                self.unsupported(node.span(), "renaming the checked transition macro or function is unsupported");
            }
        }
        visit::visit_use_rename(self, node);
    }
    fn visit_item_extern_crate(&mut self, node: &'ast syn::ItemExternCrate) {
        if matches!(self.policy.rule, Rule::Dependency(_)) && ident_name(&node.ident) == "self" {
            self.unsupported(node.span(), "extern crate self aliases are unsupported; use crate-qualified dependencies");
        }
        visit::visit_item_extern_crate(self, node);
    }
    fn visit_block(&mut self, node: &'ast syn::Block) {
        self.aliases.push(HashMap::new());
        for statement in &node.stmts {
            if let syn::Stmt::Item(syn::Item::Use(item)) = statement {
                self.imports(&item.tree, &[], item.leading_colon.is_some(), true);
            }
        }
        self.resolve_imports();
        visit::visit_block(self, node);
        self.aliases.pop();
    }
    fn visit_item_mod(&mut self, node: &'ast syn::ItemMod) {
        if let Some((_, items)) = &node.content {
            for attr in &node.attrs { self.visit_attribute(attr); }
            self.module.push(ident_name(&node.ident));
            self.aliases.push(HashMap::new());
            self.collect_imports(items);
            for item in items { self.visit_item(item); }
            self.aliases.pop(); self.module.pop();
        } else {
            if matches!(self.policy.rule, Rule::Dependency(_)) {
                let mut path = vec!["self".into()]; path.push(ident_name(&node.ident));
                self.dependency(&path, false, node.span(), true);
            }
            visit::visit_item_mod(self, node);
        }
    }
    fn visit_item(&mut self, node: &'ast syn::Item) {
        if matches!(node, syn::Item::Verbatim(_)) { self.unsupported(node.span(), "unsupported Rust item"); }
        visit::visit_item(self, node);
    }
    fn visit_expr(&mut self, node: &'ast Expr) {
        if matches!(node, Expr::Verbatim(_)) { self.unsupported(node.span(), "unsupported Rust expression"); }
        visit::visit_expr(self, node);
    }
}

fn module_location(relative: &Path) -> Result<(PathBuf, Vec<String>), String> {
    let components: Vec<_> = relative.components().filter_map(|part| match part { Component::Normal(part) => Some(part.to_string_lossy().to_string()), _ => None }).collect();
    let Some(src) = components.iter().rposition(|part| part == "src") else { return Err("dependency profile requires files under a crate src directory".into()); };
    let mut crate_dir = PathBuf::new();
    for part in &components[..=src] { crate_dir.push(part); }
    let mut module = components[src + 1..].to_vec();
    let Some(file) = module.pop() else { return Err("expected Rust source file".into()); };
    if !matches!(file.as_str(), "lib.rs" | "main.rs" | "mod.rs") {
        let Some(stem) = file.strip_suffix(".rs") else { return Err("expected .rs source file".into()); };
        module.push(stem.into());
    }
    Ok((crate_dir, module))
}
fn input_error(file: &str, message: impl Into<String>) -> Value {
    json!({"ruleId": "TLC002", "file": file, "line": 1, "column": 1, "message": message.into()})
}
fn run() -> (i32, Vec<Value>) {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() < 3 || args[0] != "--root" { return (2, vec![input_error("", "usage: tlc-generated-checker --root PROJECT_ROOT FILE...")]); }
    let root = match Path::new(&args[1]).canonicalize() { Ok(root) if root.is_dir() => root, _ => return (2, vec![input_error("", "project root is not a readable directory")]) };
    let policy = Policy::load();
    let mut diagnostics = Vec::new(); let mut input_failed = false;
    let mut seen = HashSet::new();
    for file in &args[2..] {
        let requested = Path::new(file);
        let path = if requested.is_absolute() { requested.to_owned() } else { root.join(requested) };
        let path = match path.canonicalize() {
            Ok(path) if path.is_file() && path.starts_with(&root) && path.extension().is_some_and(|extension| extension == "rs") => path,
            _ => { input_failed = true; diagnostics.push(input_error(file, "input must be a readable .rs file inside the project root")); continue; }
        };
        if !seen.insert(path.clone()) { continue; }
        let relative = path.strip_prefix(&root).expect("checked root");
        let file = relative.to_string_lossy().replace('\\', "/");
        let state = match policy.state_for(&file) {
            Ok(state) => state,
            Err(message) => { diagnostics.push(input_error(&file, message)); continue; }
        };
        let source = match std::fs::read_to_string(&path) { Ok(source) => source, Err(error) => { input_failed = true; diagnostics.push(input_error(&file, error.to_string())); continue; } };
        let tree = match syn::parse_file(&source) {
            Ok(tree) => tree,
            Err(error) => { input_failed = true; let start = error.span().start(); diagnostics.push(json!({"ruleId":"TLC002", "file":file, "line":start.line, "column":start.column + 1, "message":format!("Rust syntax error: {error}")})); continue; }
        };
        if matches!(policy.rule, Rule::Dependency(_)) && state.is_none() {
            diagnostics.push(input_error(&file, "no module ownership for checked source")); continue;
        }
        let (crate_dir, module) = if matches!(policy.rule, Rule::Dependency(_)) {
            match module_location(relative) { Ok((dir, module)) => (root.join(dir), module), Err(message) => { diagnostics.push(input_error(&file, message)); continue; } }
        } else { (root.clone(), Vec::new()) };
        let mut checker = Checker { policy: &policy, root: &root, file, source_state: state, crate_dir, module, aliases: vec![HashMap::new()], diagnostics: Vec::new() };
        checker.collect_imports(&tree.items);
        checker.visit_file(&tree);
        diagnostics.extend(checker.diagnostics);
    }
    let code = if input_failed { 2 } else if diagnostics.is_empty() { 0 } else { 1 };
    (code, diagnostics)
}
fn main() {
    let (code, diagnostics) = run();
    println!("{}", serde_json::to_string(&diagnostics).expect("diagnostics JSON"));
    std::process::exit(code);
}
`;
