import { type RowBinding, type RowBindingPlan } from '../row-binding-types.js';
import { validateWholeRowBinding } from '../row-binding.js';
import { type SymbolicModelV2, type SymbolicValue } from '../symbolic-types.js';
import type { GeneratedFile } from '../types.js';
import { generateSymbolicRust } from './symbolic-rust.js';

export interface RowRustInput {
  model: SymbolicModelV2;
  className: string;
  plan: RowBindingPlan;
  binding: RowBinding;
  rustCrateMode: 'standalone' | 'workspace';
  /** Composite generators keep row transition entry points private to their adapter. */
  internalVisibility?: 'private';
}

function quoted(value: string): string {
  let result = '"';
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code === undefined || code >= 0xd800 && code <= 0xdfff) throw new Error('ROW301: row strings require Unicode scalar values');
    result += character === '"' ? '\\"' : character === '\\' ? '\\\\' : code < 0x20 || code === 0x7f ? `\\u{${code.toString(16)}}` : character;
  }
  return result + '"';
}
function valueExpression(value: SymbolicValue): string {
  switch (value.kind) {
    case 'string': return `authority::SymbolicValue::String { value: ${quoted(value.value)}.to_owned() }`;
    case 'integer': return `authority::SymbolicValue::Integer { value: ${quoted(value.value)}.to_owned() }`;
    case 'boolean': return `authority::SymbolicValue::Boolean { value: ${value.value} }`;
    case 'data': return `authority::SymbolicValue::Data { domain: ${quoted(value.domain)}.to_owned(), value: ${quoted(value.value)}.to_owned() }`;
  }
}

/** Keep the generated primitive authority in its own crate; include adapter.rs privately in the audited application. */
export function generateRowRust(input: RowRustInput): GeneratedFile[] {
  const { model, plan, binding } = validateWholeRowBinding(input);
  const ownerVisibility = input.internalVisibility === 'private' ? '' : 'pub(crate) ';
  const stored = binding.model.pairs.find(pair => pair.name === 'stored');
  const rejected = binding.model.pairs.find(pair => pair.name === 'rejected');
  const payload = model.inputs.find(parameter => parameter.parameter === binding.model.payloadInput);
  const provenance = model.inputs.find(parameter => parameter.parameter === binding.model.provenanceInput);
  if (!stored || !rejected || !payload || !provenance || model.inputs.length !== 2) throw new Error('ROW301: bind stored/rejected pairs and exactly two payload/provenance inputs');
  const pairs = [stored, rejected];
  const initialValue = (variable: string): SymbolicValue => {
    const value = model.initial[variable];
    if (!value) throw new Error(`ROW301: pair variable ${variable} is absent from Init`);
    return value;
  };
  const initPayload = pairs.map(pair => valueExpression(initialValue(pair.payload)));
  const initProvenance = pairs.map(pair => valueExpression(initialValue(pair.provenance)));
  const inputArguments = model.inputs.map(parameter => parameter.parameter === payload.parameter ? '&incoming_payload' : '&incoming_provenance').join(', ');
  const sourceActions = [...new Set(model.branches.map(branch => branch.action))].sort();
  const actions = sourceActions.map(action => `            ${quoted(action)} => WriteEffect::${action},`).join('\n');
  const implementations = plan.facts.map(fact => {
    const fieldEncoding = (flavor: 'payload' | 'provenance'): string => fact.fields.filter(field => field[flavor]).map(field => {
      const getter = `row_field_${fact.fields.indexOf(field)}` + field.codec.getters.map(name => `.${name}()`).join('');
      let bytes: string;
      switch (field.codec.kind) {
        case 'i64': case 'u32': {
          const scalar = field.codec.getters.length ? getter : `*${getter}`;
          const classes = flavor === 'payload' ? field.classes : undefined;
          const normalized = classes?.length ? `match ${scalar} { ${classes.map(values => `${[...values].sort((a, b) => a - b).join(' | ')} => ${Math.min(...values)},`).join(' ')} value => value }` : scalar;
          bytes = `&(${normalized}).to_be_bytes()`;
          break;
        }
        case 'bool': bytes = `&[u8::from(${field.codec.getters.length ? getter : `*${getter}`})]`; break;
        case 'string': bytes = `(${getter}).as_bytes()`; break;
        case 'enum': { const codec = field.codec; bytes = `(match ${getter} { ${codec.variants.map(variant => `${codec.rustPath}::${variant} => ${quoted(variant)},`).join(' ')} }).as_bytes()`; break; }
      }
      return `        field(&mut ${flavor}, ${quoted(field.name)}, ${quoted(field.codec.kind)}, ${bytes});`;
    }).join('\n');
    return `impl BoundFact for ${fact.rustPath} {}
impl sealed::SupportedFact for ${fact.rustPath} {
    fn identities(&self) -> (String, String) {
        // No rest pattern: an added field invalidates this generated binding.
        let ${fact.rustPath} { ${fact.fields.map((field, index) => `${field.name}: row_field_${index}`).join(', ')} } = self;
        let mut payload = header(${quoted(fact.name)}, "payload");
        let mut provenance = header(${quoted(fact.name)}, "provenance");
${fieldEncoding('payload')}
${fieldEncoding('provenance')}
        (payload, provenance)
    }
}`;
  }).join('\n\n');
  const pairOrigin = pairs.map((pair, index) => `        (Some(authority::ValueExpression::State { variable: a }), Some(authority::ValueExpression::State { variable: b }))
            if a == ${quoted(pair.payload)} && b == ${quoted(pair.provenance)} => Ok(old_${index}.clone()),`).join('\n');
  const adapter = `// Generated whole-row adapter. Include this as a private application module.
// The separate primitive crate must be imported as sgd_fact_authority.
// Source profile: closed audited Rust Fact types; no arbitrary Eq/Clone callbacks.
use sgd_fact_authority as authority;

mod sealed {
    pub trait SupportedFact: Clone {
        fn identities(&self) -> (String, String);
    }
}

// External generic callers may name this bound but cannot implement its private superclass.
pub(crate) trait BoundFact: sealed::SupportedFact {}

fn part(output: &mut String, bytes: &[u8]) {
    output.push_str(&bytes.len().to_string());
    output.push(':');
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for byte in bytes {
        output.push(char::from(HEX[usize::from(byte >> 4)]));
        output.push(char::from(HEX[usize::from(byte & 15)]));
    }
    output.push(';');
}
fn header(row: &str, flavor: &str) -> String {
    let mut output = String::new();
    part(&mut output, b"sgd-row-v1");
    part(&mut output, row.as_bytes());
    part(&mut output, flavor.as_bytes());
    output
}
fn field(output: &mut String, name: &str, kind: &str, bytes: &[u8]) {
    part(output, name.as_bytes());
    part(output, kind.as_bytes());
    part(output, bytes);
}

${implementations}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
${ownerVisibility}enum WriteEffect {
${sourceActions.map(action => `    ${action},`).join('\n')}
}

#[derive(Debug)]
pub(crate) enum RowError {
    Transition(authority::TransitionError),
    BrokenBinding,
}
impl std::fmt::Display for RowError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Transition(error) => write!(formatter, "{error}"),
            Self::BrokenBinding => formatter.write_str("ROW302: complete rows disagree with the generated payload/provenance binding; regenerate and verify the source binding"),
        }
    }
}
impl std::error::Error for RowError {}

struct RowPair {
    payload: &'static str,
    provenance: &'static str,
    empty_payload: authority::SymbolicValue,
    empty_provenance: authority::SymbolicValue,
}
fn matches<T: sealed::SupportedFact>(row: &Option<T>, snapshot: &authority::Snapshot, pair: &RowPair) -> bool {
    let (payload, provenance) = match row {
        None => (pair.empty_payload.clone(), pair.empty_provenance.clone()),
        Some(row) => {
            let (payload, provenance) = row.identities();
            (authority::SymbolicValue::Data { domain: ${quoted(payload.domain)}.to_owned(), value: payload },
             authority::SymbolicValue::Data { domain: ${quoted(provenance.domain)}.to_owned(), value: provenance })
        }
    };
    snapshot.values.get(pair.payload) == Some(&payload) && snapshot.values.get(pair.provenance) == Some(&provenance)
}
fn lift<T: sealed::SupportedFact>(receipt: &authority::Receipt, pair: &RowPair, incoming: &T, old_0: &Option<T>, old_1: &Option<T>) -> Result<Option<T>, RowError> {
    match (receipt.updates.get(pair.payload), receipt.updates.get(pair.provenance)) {
        (Some(authority::ValueExpression::Literal { value: a }), Some(authority::ValueExpression::Literal { value: b }))
            if a == &pair.empty_payload && b == &pair.empty_provenance => Ok(None),
        (Some(authority::ValueExpression::Input { parameter: a }), Some(authority::ValueExpression::Input { parameter: b }))
            if a == ${quoted(payload.parameter)} && b == ${quoted(provenance.parameter)} => Ok(Some(incoming.clone())),
${pairOrigin}
        _ => Err(RowError::BrokenBinding),
    }
}

// Private state and a sealed concrete Fact bound prohibit arbitrary source equality.
${ownerVisibility}struct FactOwner<T: BoundFact> {
    authority: authority::${input.className},
    stored: Option<T>,
    rejected: Option<T>,
}
impl<T: BoundFact> Default for FactOwner<T> {
    fn default() -> Self { Self::new() }
}
impl<T: BoundFact> FactOwner<T> {
    ${ownerVisibility}fn new() -> Self {
        Self { authority: authority::${input.className}::new(), stored: None, rejected: None }
    }
    ${ownerVisibility}fn stored(&self) -> Option<&T> { self.stored.as_ref() }
    ${ownerVisibility}fn rejected(&self) -> Option<&T> { self.rejected.as_ref() }
    ${ownerVisibility}fn read(&self) -> authority::Snapshot { self.authority.read() }

    ${ownerVisibility}fn write(&mut self, incoming: T) -> Result<WriteEffect, RowError> {
        let stored_pair = RowPair { payload: ${quoted(stored.payload)}, provenance: ${quoted(stored.provenance)}, empty_payload: ${initPayload[0]}, empty_provenance: ${initProvenance[0]} };
        let rejected_pair = RowPair { payload: ${quoted(rejected.payload)}, provenance: ${quoted(rejected.provenance)}, empty_payload: ${initPayload[1]}, empty_provenance: ${initProvenance[1]} };
        let before = self.read();
        if !matches(&self.stored, &before, &stored_pair)
            || !matches(&self.rejected, &before, &rejected_pair) {
            return Err(RowError::BrokenBinding);
        }
        let (incoming_payload, incoming_provenance) = incoming.identities();
        let old_stored = self.stored.clone();
        let old_rejected = self.rejected.clone();
        let pending = self.authority.prepare(${inputArguments}).map_err(RowError::Transition)?;
        let receipt = pending.receipt();
        let next_stored = lift(receipt, &stored_pair, &incoming, &old_stored, &old_rejected)?;
        let next_rejected = lift(receipt, &rejected_pair, &incoming, &old_stored, &old_rejected)?;
        if !matches(&next_stored, &receipt.after, &stored_pair)
            || !matches(&next_rejected, &receipt.after, &rejected_pair) {
            return Err(RowError::BrokenBinding);
        }
        let effect = match receipt.action.as_str() {
${actions}
            _ => return Err(RowError::BrokenBinding),
        };
        // All fallible checks, user-type clones, and encoding finish before this commit.
        pending.commit();
        self.stored = next_stored;
        self.rejected = next_rejected;
        Ok(effect)
    }
}
`;
  const files = generateSymbolicRust({ model, className: input.className, ...(input.internalVisibility === 'private' ? { minimalGuardConditions: true } : {}) }).map(file => {
    if (file.path === 'Cargo.toml' && input.rustCrateMode === 'workspace') return { ...file, content: file.content.replace('\n[workspace]\n', '\n') };
    if (file.path !== 'README.md') return file;
    return { ...file, content: `# Generated whole-row Rust authority

Keep the primitive crate separate. Import its package under the dependency alias \`sgd_fact_authority\`. Include \`adapter.rs\` as a private module in the audited source crate; it resolves the closed Fact paths from the checked binding. It is not a module of the primitive authority crate.

WriteEffect variants preserve the exact source action identity. There is no configurable classification or action rename table. The private application module exposes \`FactOwner<T>::new()\`, \`write(T) -> Result<WriteEffect, RowError>\`, \`stored() -> Option<&T>\`, \`rejected() -> Option<&T>\`, and \`read()\`. Only the analyzed concrete Fact types implement its sealed bound. A write moves the complete owned input row, computes payload/provenance together, prepares the generated primitive transition, lifts complete rows from the receipt origins, and checks the proposed relation before committing. Clones, encoding, validation and errors finish before commit. After commit only audited infallible field moves remain. Safe immutable references cannot mutate the retained closed rows.

Identity encoding is identical to the portable TypeScript target: decimal byte length, colon, lowercase hexadecimal bytes, semicolon for each component. Header components are UTF-8 \`sgd-row-v1\`, Fact name and \`payload\` or \`provenance\`. Each ordered field appends name, kind and exact value bytes: signed two's-complement big-endian i64, big-endian u32, one-byte bool, UTF-8 string, or UTF-8 enum variant. Payload finite u32 classes use their minimum member; provenance retains the original value. The adapter retains complete original rows, never reconstructed rows from normalized identities.

An exhaustive struct pattern detects new fields at native compilation. The source analyzer separately checks equality, codecs, field classification, and the immutable representation closure. Keep that gate mandatory. This per-live-object contract does not establish application-wide coverage, a partition write permission, persistence, restore, reset prevention, or external effects. The application module and generated source remain trusted; safe Rust and the audited no-custom-Drop/no-interior-mutation closure are required.

## Primitive crate reference

${file.content.replaceAll('authority =', 'sgd_fact_authority =').replaceAll('authority::', 'sgd_fact_authority::')}` };
  });
  return [...files, { path: 'adapter.rs', content: adapter }];
}
