import { createHash } from 'node:crypto';
import { symbolicInputDefinitions, symbolicInputs, validateSymbolicModel, type SymbolicBackendInput, type SymbolicExpression, type SymbolicGuard, type SymbolicValue } from '../symbolic-types.js';
import { inspectSymbolicOrbits } from '../symbolic-semantics.js';
import type { GeneratedFile } from '../types.js';

function textDirectionControl(code: number): boolean {
  return code === 0x61c || code === 0x200e || code === 0x200f || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

function rustString(value: string): string {
  let escaped = '';
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code === undefined || (code >= 0xd800 && code <= 0xdfff)) throw new Error('TLC301: Rust strings require Unicode scalar values');
    if (character === '"') escaped += '\\"';
    else if (character === '\\') escaped += '\\\\';
    else if (code < 0x20 || code === 0x7f || textDirectionControl(code)) escaped += `\\u{${code.toString(16)}}`;
    else escaped += character;
  }
  return `"${escaped}"`;
}

function documentedValue(value: SymbolicValue): string {
  return [...JSON.stringify(value)].map(character => {
    const code = character.codePointAt(0);
    return code !== undefined && textDirectionControl(code) ? `\\u${code.toString(16).padStart(4, '0')}` : character;
  }).join('');
}

function renderValue(value: SymbolicValue): string {
  switch (value.kind) {
    case 'string': return `SymbolicValue::String { value: ${rustString(value.value)}.to_owned() }`;
    case 'boolean': return `SymbolicValue::Boolean { value: ${value.value} }`;
    case 'integer': return `SymbolicValue::Integer { value: ${rustString(value.value)}.to_owned() }`;
    case 'data': return `SymbolicValue::Data { domain: ${rustString(value.domain)}.to_owned(), value: ${rustString(value.value)}.to_owned() }`;
    default: { const exhaustive: never = value; return exhaustive; }
  }
}

function renderExpression(expression: SymbolicExpression, inputs: ReadonlyMap<string, string>, legacyInput: string | undefined): string {
  switch (expression.kind) {
    case 'literal': return renderValue(expression.value);
    case 'input': {
      const name = 'parameter' in expression ? inputs.get(expression.parameter) : legacyInput;
      if (name === undefined) throw new Error('TLC301: unknown symbolic input parameter');
      return `${name}.clone()`;
    }
    case 'state': return `self.values.get(${rustString(expression.variable)}).expect("private generated state invariant").clone()`;
    case 'next-state': throw new Error('TLC301: primed expressions cannot execute in a symbolic guard or assignment');
    default: { const exhaustive: never = expression; return exhaustive; }
  }
}

function renderOrigin(expression: SymbolicExpression): string {
  switch (expression.kind) {
    case 'literal': return `ValueExpression::Literal { value: ${renderValue(expression.value)} }`;
    case 'input': return 'parameter' in expression ? `ValueExpression::Input { parameter: ${rustString(expression.parameter)}.to_owned() }` : 'ValueExpression::Input';
    case 'state': return `ValueExpression::State { variable: ${rustString(expression.variable)}.to_owned() }`;
    case 'next-state': return `ValueExpression::NextState { variable: ${rustString(expression.variable)}.to_owned() }`;
    default: { const exhaustive: never = expression; return exhaustive; }
  }
}

function renderGuard(guard: SymbolicGuard, inputs: ReadonlyMap<string, string>, legacyInput: string | undefined): string {
  const render = (expression: SymbolicExpression): string => renderExpression(expression, inputs, legacyInput);
  const nested = (value: SymbolicGuard): string => renderGuard(value, inputs, legacyInput);
  switch (guard.kind) {
    case 'boolean': return String(guard.value);
    case 'equal': return `(${render(guard.left)} == ${render(guard.right)})`;
    case 'not-equal': return `(${render(guard.left)} != ${render(guard.right)})`;
    case 'member': return `[${guard.elements.map(renderValue).join(', ')}].contains(&(${render(guard.value)}))`;
    case 'in-domain': return `matches!(${render(guard.value)}, SymbolicValue::Data { ref domain, .. } if domain == ${rustString(guard.domain)})`;
    case 'and': return `(${guard.terms.map(nested).join(' && ') || 'true'})`;
    case 'or': return `(${guard.terms.map(nested).join(' || ') || 'false'})`;
    case 'not': return `!(${nested(guard.term)})`;
    case 'implies': return `(!(${nested(guard.left)}) || (${nested(guard.right)}))`;
    case 'equivalent': return `((${nested(guard.left)}) == (${nested(guard.right)}))`;
    default: { const exhaustive: never = guard; return exhaustive; }
  }
}

/** Generate an immutable-data equality/copy authority after complete orbit validation. */
export function generateSymbolicRust(input: SymbolicBackendInput & {
  /** Internal composition option: omit only a top-level and/or condition wrapper. */
  minimalGuardConditions?: true;
}): GeneratedFile[] {
  const model = validateSymbolicModel(input.model);
  inspectSymbolicOrbits(model);
  const parameters = symbolicInputs(model);
  const definitions = symbolicInputDefinitions(model);
  const className = input.className;
  const enumName = (index: number): string => `${className}Input${index}`;
  const inputNames = new Map(parameters.map((parameter, index) => [parameter.parameter, model.version === 1 ? 'input_value' : `input_value_${index}`]));
  const legacyInput = model.version === 1 ? 'input_value' : undefined;
  const render = (expression: SymbolicExpression): string => renderExpression(expression, inputNames, legacyInput);
  const argumentNames = parameters.map((_parameter, index) => model.version === 1 ? 'input' : `input_${index}`);
  const signature = definitions.map((definition, index) => `${argumentNames[index]}: ${definition.kind === 'finite' ? enumName(index) : '&str'}`).join(', ');
  const inputValues = definitions.map((parameter, index) => parameter.kind === 'opaque'
    ? `        let ${inputNames.get(parameter.parameter)} = SymbolicValue::Data { domain: ${rustString(parameter.domain)}.to_owned(), value: ${argumentNames[index]}.to_owned() };`
    : `        let ${inputNames.get(parameter.parameter)} = match ${argumentNames[index]} {\n${parameter.values.map((value, choice) => `            ${enumName(index)}::Choice${choice} => ${renderValue(value)},`).join('\n')}\n        };`).join('\n');
  const inputEnums = definitions.flatMap((parameter, index) => parameter.kind === 'opaque' ? [] : [`/// Exact finite input \`${parameter.parameter}\` from \`${parameter.domain}\`; variants are scalar choices, not actions.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ${enumName(index)} {
${parameter.values.map((value, choice) => `    /// ${documentedValue(value)}\n    Choice${choice},`).join('\n')}
}

`]).join('');
  const overflowArguments = definitions.map((parameter, index) => parameter.kind === 'finite' ? `${enumName(index)}::Choice0` : rustString(model.version === 1 ? 'fresh-overflow-input' : `fresh-overflow-input-${index}`)).join(', ');
  const apiTypes = definitions.map((parameter, index) => parameter.kind === 'finite' ? enumName(index) : '&str').join(', ');
  const reserved = ['Self', 'SymbolicValue', 'ValueExpression', 'Snapshot', 'Receipt', 'PreparedTransition', 'TransitionError', 'TransitionErrorReason',
    'String', 'BTreeMap', 'Serialize', 'Result', 'Option', 'Some', 'None', 'Ok', 'Err', 'MODEL'];
  if (!/^[A-Z][A-Za-z0-9]*$/.test(className) || reserved.includes(className)) throw new Error('TLC301: Rust authority requires a distinct UpperCamelCase className');
  const variables = [...model.variables].sort();
  const initial = variables.map(variable => {
    const value = model.initial[variable];
    if (value === undefined) throw new Error('TLC301: incomplete symbolic Init');
    return `            (${rustString(variable)}.to_owned(), ${renderValue(value)}),`;
  }).join('\n');
  const condition = (guard: SymbolicGuard): string => {
    if ((input.minimalGuardConditions || model.version === 3) && (guard.kind === 'and' || guard.kind === 'or')) {
      return guard.terms.map(term => renderGuard(term, inputNames, legacyInput)).join(guard.kind === 'and' ? ' && ' : ' || ') || (guard.kind === 'and' ? 'true' : 'false');
    }
    return renderGuard(guard, inputNames, legacyInput);
  };
  const guards = model.branches.map((branch, index) => `        if ${condition(branch.guard)} {
            if selected.is_some() { return Err(self.reject(TransitionErrorReason::Ambiguous)); }
            selected = Some(${index});
        }`).join('\n');
  const actions = model.branches.map((branch, index) => {
    const values = variables.map(variable => {
      const expression = branch.updates[variable];
      if (expression === undefined) throw new Error('TLC301: incomplete symbolic update');
      return `                (${rustString(variable)}.to_owned(), ${render(expression)}),`;
    }).join('\n');
    const origins = variables.map(variable => {
      const expression = branch.updates[variable];
      if (expression === undefined) throw new Error('TLC301: incomplete symbolic update');
      return `                (${rustString(variable)}.to_owned(), ${renderOrigin(expression)}),`;
    }).join('\n');
    return `            ${index} => (${rustString(branch.action)}, BTreeMap::from([\n${values}\n            ]), BTreeMap::from([\n${origins}\n            ])),`;
  }).join('\n');
  const slug = model.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'model';
  const hash = createHash('sha256').update(model.name).digest('hex').slice(0, 12);
  const packageName = `sgd-symbolic-${slug}-${hash}`;
  return [
    { path: 'Cargo.toml', content: `[package]
name = ${JSON.stringify(packageName)}
version = "0.1.0"
edition = "2021"
publish = false

[workspace]

[dependencies]
serde = { version = "=1.0.229", features = ["derive"] }
` },
    { path: 'src/lib.rs', content: `// Generated symbolic-owned authority. Regenerate from the verified model.
//! Equality/copy contract for actual immutable UTF-8 data in one live object.
//! Keep this crate separate and use safe Rust callers. Persistent identity,
//! reset prevention, restart, restore, external effects, and application-wide
//! coverage require separate contracts. No application callback runs in send.
#![forbid(unsafe_code)]

use serde::Serialize;
use std::collections::BTreeMap;

pub const MODEL: &str = ${rustString(model.name)};
pub const MODEL_REVISION: &str = ${rustString(model.source.semanticSha256)};

/// Data atoms stay distinct from scalar strings, including an identical sentinel.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SymbolicValue {
    String { value: String },
    Boolean { value: bool },
    Integer { value: String },
    Data { domain: String, value: String },
}

${inputEnums}/// The source of each simultaneous assignment, copied from the symbolic IR.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ValueExpression {
    Literal { value: SymbolicValue },
    State { variable: String },
    NextState { variable: String },
    ${model.version === 1 ? 'Input,' : 'Input { parameter: String },'}
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub model: &'static str,
    pub model_revision: &'static str,
    pub revision: String,
    pub values: BTreeMap<String, SymbolicValue>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct Receipt {
    pub action: String,
    pub before: Snapshot,
    pub after: Snapshot,
    pub updates: BTreeMap<String, ValueExpression>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TransitionErrorReason {
    Disabled,
    Ambiguous,
    RevisionExhausted,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct TransitionError {
    pub reason: TransitionErrorReason,
    pub state: Snapshot,
}

impl std::fmt::Display for TransitionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.reason {
            TransitionErrorReason::Disabled => formatter.write_str("symbolic input is disabled in the current state"),
            TransitionErrorReason::Ambiguous => formatter.write_str("more than one symbolic action is enabled"),
            TransitionErrorReason::RevisionExhausted => formatter.write_str("authority revision is exhausted"),
        }
    }
}

impl std::error::Error for TransitionError {}

/// Private complete state. No Clone, Deserialize, setter, or restore API.
pub struct ${className} {
    values: BTreeMap<String, SymbolicValue>,
    revision: u64,
}

/// An uncommitted transition that exclusively borrows its originating owner.
/// Dropping this token leaves the owner unchanged. It cannot be copied or restored.
pub struct PreparedTransition<'owner> {
    owner: &'owner mut ${className},
    values: BTreeMap<String, SymbolicValue>,
    revision: u64,
    receipt: Receipt,
}

impl PreparedTransition<'_> {
    pub fn receipt(&self) -> &Receipt {
        &self.receipt
    }

    /// All validation and allocation finished in prepare; commit only moves fields.
    pub fn commit(self) -> Receipt {
        let Self { owner, values, revision, receipt } = self;
        owner.values = values;
        owner.revision = revision;
        receipt
    }
}

impl ${className} {
    pub fn new() -> Self {
        Self { revision: 0, values: BTreeMap::from([
${initial}
        ]) }
    }

    pub fn read(&self) -> Snapshot {
        Snapshot { model: MODEL, model_revision: MODEL_REVISION, revision: self.revision.to_string(), values: self.values.clone() }
    }

    fn reject(&self, reason: TransitionErrorReason) -> TransitionError {
        TransitionError { reason, state: self.read() }
    }

    /// The input is actual immutable data, never a caller-selected action.
    /// All guards and simultaneous assignment values read the old state.
    pub fn send(&mut self, ${signature}) -> Result<Receipt, TransitionError> {
        self.prepare(${argumentNames.join(', ')}).map(PreparedTransition::commit)
    }

    /// Inspect the complete proposed receipt before the owner changes.
    /// The exclusive token must be committed or dropped before using this owner again.
    pub fn prepare(&mut self, ${signature}) -> Result<PreparedTransition<'_>, TransitionError> {
${inputValues}
        let mut selected: Option<usize> = None;
${guards}
        let Some(selected) = selected else { return Err(self.reject(TransitionErrorReason::Disabled)); };
        let Some(revision) = self.revision.checked_add(1) else { return Err(self.reject(TransitionErrorReason::RevisionExhausted)); };
        let before = self.read();
        let (action, values, updates) = match selected {
${actions}
            _ => unreachable!("private generated action invariant"),
        };
        let after = Snapshot { model: MODEL, model_revision: MODEL_REVISION, revision: revision.to_string(), values: values.clone() };
        let receipt = Receipt { action: action.to_owned(), before, after, updates };
        Ok(PreparedTransition { owner: self, values, revision, receipt })
    }
}

impl ::std::default::Default for ${className} {
    fn default() -> Self { Self::new() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exhaustion_preserves_complete_state_and_revision() {
        let mut owner = ${className}::new();
        owner.revision = u64::MAX;
        let before = owner.read();
        match owner.prepare(${overflowArguments}) {
            Err(error) => assert_eq!(error.state, before),
            Ok(_) => panic!("no preparation follows u64::MAX"),
        }
        assert_eq!(owner.read(), before);
        let error = owner.send(${overflowArguments}).expect_err("no revision follows u64::MAX");
        assert_eq!(error.state, before);
        assert_eq!(owner.read(), before);
    }
}
` },
    { path: 'README.md', content: model.version === 3 ? `# Generated mixed-input Rust authority

This standalone crate is \`${packageName}\`. Keep it as a separate dependency:

\`\`\`toml
[dependencies]
authority = { package = "${packageName}", path = "../generated/rust" }
\`\`\`

Import \`authority::${className}\` and each finite input enum. Create an owner with \`new()\` and call \`send(${apiTypes})\` or \`prepare(${apiTypes})\` in model input order:

${definitions.map((parameter, index) => `- \`${argumentNames[index]}\` maps to \`${parameter.parameter}\` in \`${parameter.domain}\`: ${parameter.kind === 'opaque' ? 'an immutable UTF-8 string identity (`&str`) in its distinct opaque namespace' : `\`${enumName(index)}\`, with exact mapping ${parameter.values.map((value, choice) => `\`Choice${choice}\` = \`${documentedValue(value)}\``).join('; ')}`}.`).join('\n')}

Finite enum variants map to tagged scalar values and never select an action directly. Their deterministic ChoiceN order follows the canonical IR scalar order. Opaque data and finite scalar strings remain distinct when text matches; other opaque domains also stay distinct. Large integers remain exact decimal strings in snapshots. No runtime string parser or unchecked enum constructor is provided. Safe Rust rejects another input's enum, invalid variants, raw integers, and strings at a finite input boundary.

Generated guards select the model action. The receipt contains the complete \`before\` and \`after\` snapshots, the checked revision, and named simultaneous assignment origins in \`updates\`. Guards and updates read the old state. Snapshots own their values; editing them cannot alter private state. The owner has no Clone, Deserialize, raw constructor, setter, or restore API.

A successful \`PreparedTransition<'_>\` exclusively borrows its original owner. Inspect the proposed receipt with \`receipt()\`, then consume the token with \`commit(self)\`. Commit only moves fully prepared fields. Dropping the token leaves state and revision unchanged. The token has no Clone, Deserialize, raw constructor, owner selector, or mutation API. The borrow checker prevents reads, sends, another preparation, and token replay while the original token remains live. \`send\` uses the same prepare/commit path.

Generation validates supplied mixed-input IR and its equality/copy orbit space. Controlled SANY/TLC and original-action oracle checks must complete separately to establish source provenance and the configured finite check. A finite enum value does not attest any real file operation. This is one abstract live-object owner with unchanged generated code and safe Rust callers. It does not establish file or resource authority, persistence, external-effect atomicity, application-wide source coverage, or arbitrary TLA+ semantics. Trust the generated crate and dependencies.
` : `# Generated symbolic-owned Rust authority

This standalone crate is \`${packageName}\`. Keep it as a separate dependency:

\`\`\`toml
[dependencies]
authority = { package = "${packageName}", path = "../generated/rust" }
\`\`\`

Import \`authority::${className}\`. Create a live owner with \`new()\`, copy its complete state with \`read()\`, and ${model.version === 1 ? 'submit actual UTF-8 input data through `send(&str)`.' : `submit actual UTF-8 input data through \`send(${parameters.map(() => '&str').join(', ')})\` in model input order (${parameters.map(parameter => `${parameter.parameter}: ${parameter.domain}`).join(', ')}).`} The generated guards choose the action. There is no caller action enum, equality callback, generic data identity, or mutable input alias. ${model.version === 1 ? 'Data are tagged with their domain and stay distinct from literal scalar strings, even when their text matches a sentinel.' : 'Data are tagged with their domain and stay distinct from literal scalar strings and other domains, even when their text matches.'} Equality is exact Rust string equality; input bytes are not normalized.

The receipt contains \`action\`, \`before\`, \`after\`, and copied IR assignment origins in \`updates\`${model.version === 2 ? ', including the source parameter on each input assignment' : ''}. All guards and assignments read the old state. A rejected input preserves state and the checked u64 revision. Snapshots own their values; editing them cannot alter the authority. JSON integers and revision remain decimal strings. \`modelRevision\` identifies the canonical symbolic program.

Use \`prepare(${parameters.map(() => '&str').join(', ')})\` when an adapter must validate and copy application values before committing. A successful \`PreparedTransition<'_>\` exclusively borrows its originating owner. \`receipt()\` borrows the complete proposed receipt. \`commit(self)\` consumes the token and returns that receipt after infallible field moves; dropping the token leaves state and revision unchanged. The token has no Clone, Deserialize, raw constructor, owner selector, or mutation API. The borrow checker prevents reads, sends, and another preparation on that owner while the token remains live. \`send\` uses this same prepare/commit path.

Generation validates the complete equality/copy orbit space, invariants, and action properties. This profile supports equality, finite scalar membership, domain tests, Boolean logic, and simultaneous literal/input/state copying. It does not establish application-wide coverage or external-effect atomicity. The authority has no Clone, Deserialize, raw constructor, setter, or restore API. This crate forbids unsafe code and requires safe Rust callers. Trust the generated crate and dependencies. Each \`new()\` creates a distinct live object; persistent identity, reset prevention, restart, recovery, and database effects require separate contracts.
` },
  ];
}
