import { type RowBinding, type RowBindingPlan } from '../row-binding-types.js';
import { validateWholeRowBinding } from '../row-binding.js';
import { type SymbolicModelV2 } from '../symbolic-types.js';
import type { GeneratedFile } from '../types.js';
import { generateSymbolicTypeScript } from './symbolic-typescript.js';

export interface RowTypeScriptInput {
  model: SymbolicModelV2;
  className: string;
  plan: RowBindingPlan;
  binding: RowBinding;
}
/** Compiler-internal composition hook. Private row registries never leave machine.ts. */
export interface PrivateRowTypeScriptExtension {
  imports: string;
  declarations: string;
  fact: (fact: RowBindingPlan['facts'][number], index: number) => string;
}
const quoted = (value: string): string => JSON.stringify(value);

export function encodeRowIdentity(input: {
  fact: RowBindingPlan['facts'][number]; flavor: 'payload' | 'provenance'; values: Readonly<Record<string, unknown>>;
}): string {
  const encoder = new TextEncoder();
  const part = (bytes: Uint8Array): string => `${bytes.length}:${Buffer.from(bytes).toString('hex')};`;
  let result = part(encoder.encode('sgd-row-v1')) + part(encoder.encode(input.fact.name)) + part(encoder.encode(input.flavor));
  if (Object.keys(input.values).length !== input.fact.fields.length || Object.keys(input.values).some(name => !input.fact.fields.some(field => field.name === name))) throw new Error('ROW303: row fields do not match the checked schema');
  for (const field of input.fact.fields) {
    const value = input.values[field.name];
    let bytes: Uint8Array;
    switch (field.codec.kind) {
      case 'i64': {
        if (typeof value !== 'bigint' || value < -9223372036854775808n || value > 9223372036854775807n) throw new Error(`ROW303: ${field.name} requires i64 bigint`);
        bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigInt64(0, value, false); break;
      }
      case 'u32': {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 4294967295) throw new Error(`ROW303: ${field.name} requires u32`);
        const quotient = input.flavor === 'payload' ? field.classes?.find(values => values.includes(value)) : undefined;
        bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, quotient ? Math.min(...quotient) : value, false); break;
      }
      case 'bool': if (typeof value !== 'boolean') throw new Error(`ROW303: ${field.name} requires bool`); bytes = new Uint8Array([value ? 1 : 0]); break;
      case 'string':
        if (typeof value !== 'string' || [...value].some(character => { const code = character.codePointAt(0); return code !== undefined && code >= 0xd800 && code <= 0xdfff; })) throw new Error(`ROW303: ${field.name} requires Unicode string`);
        bytes = encoder.encode(value); break;
      case 'enum': if (typeof value !== 'string' || !field.codec.variants.includes(value)) throw new Error(`ROW303: ${field.name} requires an admitted enum variant`); bytes = encoder.encode(value); break;
    }
    if (field[input.flavor]) result += part(encoder.encode(field.name)) + part(encoder.encode(field.codec.kind)) + part(bytes);
  }
  return result;
}

/** Portable DTOs match the audited Rust schema. They do not claim TypeScript source-AST binding. */
export function generateRowTypeScript(input: RowTypeScriptInput): GeneratedFile[] {
  return generateRowTypeScriptSource(input);
}

export function generatePrivateRowTypeScript(input: RowTypeScriptInput, extension: PrivateRowTypeScriptExtension): GeneratedFile[] {
  return generateRowTypeScriptSource(input, extension);
}

function generateRowTypeScriptSource(input: RowTypeScriptInput, extension?: PrivateRowTypeScriptExtension): GeneratedFile[] {
  const { model, plan, binding } = validateWholeRowBinding(input);
  const stored = binding.model.pairs.find(pair => pair.name === 'stored');
  const rejected = binding.model.pairs.find(pair => pair.name === 'rejected');
  const payload = model.inputs.find(parameter => parameter.parameter === binding.model.payloadInput);
  const provenance = model.inputs.find(parameter => parameter.parameter === binding.model.provenanceInput);
  if (!stored || !rejected || !payload || !provenance || model.inputs.length !== 2) throw new Error('ROW301: bind stored/rejected pairs and exactly two payload/provenance inputs');
  const initial = (variable: string): string => {
    const value = model.initial[variable];
    if (!value) throw new Error(`ROW301: pair variable ${variable} is absent from Init`);
    return JSON.stringify(value);
  };
  const primitive = input.className;
  const sourceActions = [...new Set(model.branches.map(branch => branch.action))].sort();
  const scalarType = (field: RowBindingPlan['facts'][number]['fields'][number]): string => {
    switch (field.codec.kind) {
      case 'i64': return 'bigint';
      case 'u32': return 'number';
      case 'bool': return 'boolean';
      case 'string': return 'string';
      case 'enum': return field.codec.variants.map(quoted).join(' | ');
    }
  };
  const rowDefinitions = plan.facts.map((fact, factIndex) => {
    const type = `${fact.name}Row`;
    const identityType = `${fact.name}Identity`;
    const identityMap = `rows${factIndex}`;
    const fields = fact.fields.map(field => `  readonly ${quoted(field.name)}: ${scalarType(field)};`).join('\n');
    const parseFields = fact.fields.map((field, index) => {
      const key = `field${index}`;
      let check: string;
      switch (field.codec.kind) {
        case 'i64': check = `typeof ${key} !== 'bigint' || ${key} < -9223372036854775808n || ${key} > 9223372036854775807n`; break;
        case 'u32': check = `typeof ${key} !== 'number' || !Number.isInteger(${key}) || ${key} < 0 || ${key} > 4294967295`; break;
        case 'bool': check = `typeof ${key} !== 'boolean'`; break;
        case 'string': check = `typeof ${key} !== 'string' || !unicode(${key})`; break;
        case 'enum': check = field.codec.variants.map(variant => `${key} !== ${quoted(variant)}`).join(' && '); break;
      }
      return `  const ${key}: unknown = descriptor(input, ${quoted(field.name)});
  if (${check}) throw new TypeError(${quoted(`ROW303: ${fact.name}.${field.name} requires ${field.codec.kind}`)});`;
    }).join('\n');
    const encoding = (flavor: 'payload' | 'provenance'): string => fact.fields.filter(field => field[flavor]).map(field => {
      const member = `row[${quoted(field.name)}]`;
      let bytes: string;
      switch (field.codec.kind) {
        case 'i64': bytes = `integer64(${member})`; break;
        case 'u32': {
          const classes = flavor === 'payload' ? field.classes : undefined;
          const normalized = classes?.length ? classes.reduceRight((tail, values) => `(${values.map(value => `${member} === ${value}`).join(' || ')} ? ${Math.min(...values)} : ${tail})`, member) : member;
          bytes = `integer32(${normalized})`; break;
        }
        case 'bool': bytes = `new Uint8Array([${member} ? 1 : 0])`; break;
        case 'string': case 'enum': bytes = `utf8.encode(${member})`; break;
      }
      return `  ${flavor} += part(utf8.encode(${quoted(field.name)})) + part(utf8.encode(${quoted(field.codec.kind)})) + part(${bytes});`;
    }).join('\n');
    const inputArguments = model.inputs.map(parameter => parameter.parameter === payload.parameter ? 'incoming.payload' : 'incoming.provenance').join(', ');
    const ownerExport = extension === undefined ? 'export ' : '';
    return `export interface ${type} {
  readonly [rowBrand]: ${quoted(fact.name)};
${fields}
}
interface ${identityType} { readonly row: ${type}; readonly payload: string; readonly provenance: string }
const ${identityMap} = new WeakMap<object, ${identityType}>();
function identify${fact.name}(row: ${type}): ${identityType} {
  let payload = header(${quoted(fact.name)}, 'payload');
  let provenance = header(${quoted(fact.name)}, 'provenance');
${encoding('payload')}
${encoding('provenance')}
  return Object.freeze({ row, payload, provenance });
}
/** Parse and copy the complete row before it can enter a live owner. Accessors are refused. */
export function create${fact.name}Row(input: unknown): ${type} {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new TypeError('ROW303: expected a complete data object');
  const keys = Reflect.ownKeys(input);
  if (keys.length !== ${fact.fields.length} || keys.some(key => typeof key !== 'string' || !${JSON.stringify(fact.fields.map(field => field.name))}.includes(key))) throw new TypeError('ROW303: row fields do not match the checked schema');
${parseFields}
  const row: ${type} = Object.freeze<${type}>({ [rowBrand]: ${quoted(fact.name)}, ${fact.fields.map((field, index) => `${quoted(field.name)}: field${index}`).join(', ')} });
  ${identityMap}.set(row, identify${fact.name}(row));
  return row;
}
${ownerExport}interface ${fact.name}Observation {
  readonly stored: ${type} | null;
  readonly rejected: ${type} | null;
  readonly state: PrimitiveSnapshot;
}
${ownerExport}type ${fact.name}WriteResult =
  | { readonly ok: true; readonly effect: WriteEffect; readonly receipt: PrimitiveReceipt }
  | { readonly ok: false; readonly reason: 'invalid-row' | 'broken-binding' | PrimitiveRejection['reason']; readonly state: PrimitiveSnapshot };
${ownerExport}interface ${fact.name}Owner {
  readonly read: () => ${fact.name}Observation;
  readonly write: (row: ${type}) => ${fact.name}WriteResult;
}
/** The authenticated token binds payload and provenance from the same complete immutable DTO. */
${ownerExport}function create${fact.name}Owner(): ${fact.name}Owner {
  const authority = createPrimitiveAuthority();
  let stored: ${identityType} | null = null;
  let rejected: ${identityType} | null = null;
  const read = Object.freeze((): ${fact.name}Observation => Object.freeze({ stored: stored?.row ?? null, rejected: rejected?.row ?? null, state: authority.read() }));
  const reject = (reason: 'invalid-row' | 'broken-binding'): ${fact.name}WriteResult => Object.freeze({ ok: false, reason, state: authority.read() });
  const write = Object.freeze((row: ${type}): ${fact.name}WriteResult => {
    if (typeof row !== 'object' || row === null) return reject('invalid-row');
    const incoming = ${identityMap}.get(row);
    if (incoming === undefined) return reject('invalid-row');
    const before = authority.read();
    if (!matches(stored, before, ${quoted(stored.payload)}, ${quoted(stored.provenance)}, ${initial(stored.payload)}, ${initial(stored.provenance)}) || !matches(rejected, before, ${quoted(rejected.payload)}, ${quoted(rejected.provenance)}, ${initial(rejected.payload)}, ${initial(rejected.provenance)})) return reject('broken-binding');
    const pending = authority.prepare(${inputArguments});
    if (!pending.ok) return pending;
    const nextStored = lift(pending.receipt, ${quoted(stored.payload)}, ${quoted(stored.provenance)}, incoming, stored, rejected, ${initial(stored.payload)}, ${initial(stored.provenance)});
    const nextRejected = lift(pending.receipt, ${quoted(rejected.payload)}, ${quoted(rejected.provenance)}, incoming, stored, rejected, ${initial(rejected.payload)}, ${initial(rejected.provenance)});
    if (!nextStored.ok || !nextRejected.ok) return reject('broken-binding');
    if (!matches(nextStored.row, pending.receipt.after, ${quoted(stored.payload)}, ${quoted(stored.provenance)}, ${initial(stored.payload)}, ${initial(stored.provenance)}) || !matches(nextRejected.row, pending.receipt.after, ${quoted(rejected.payload)}, ${quoted(rejected.provenance)}, ${initial(rejected.payload)}, ${initial(rejected.provenance)})) return reject('broken-binding');
    const effect = pending.receipt.action;
    if (!isSourceAction(effect)) return reject('broken-binding');
    // Authenticated frozen rows and primitive identities run no application code here.
    const committed = pending.commit();
    if (!committed.ok) return committed;
    stored = nextStored.row;
    rejected = nextRejected.row;
    return Object.freeze({ ok: true, effect, receipt: pending.receipt });
  });
  return Object.freeze({ read, write });
}${extension === undefined ? '' : '\n' + extension.fact(fact, factIndex)}
`;
  }).join('\n');
  const source = `// Generated portable closed DTO authority from an audited Rust whole-row schema.
// It does not prove TypeScript application source coverage or persistence.
import { create${primitive} as createPrimitiveAuthority, type ${primitive}Value as PrimitiveValue, type ${primitive}Expression as PrimitiveExpression, type ${primitive}Snapshot as PrimitiveSnapshot, type ${primitive}Receipt as PrimitiveReceipt, type ${primitive}Rejection as PrimitiveRejection } from './primitive.js';
${extension === undefined ? '' : extension.imports + '\n'}const rowBrand: unique symbol = Symbol('sgd-row');
const utf8 = new TextEncoder();
${extension === undefined ? 'export ' : ''}type WriteEffect = ${sourceActions.map(quoted).join(' | ')};
function isSourceAction(value: string): value is WriteEffect { return ${sourceActions.map(action => `value === ${quoted(action)}`).join(' || ')}; }
interface Identity { readonly payload: string; readonly provenance: string }
function unicode(value: string): boolean {
  for (const character of value) { const code = character.codePointAt(0); if (code !== undefined && code >= 0xd800 && code <= 0xdfff) return false; }
  return true;
}
function descriptor(input: object, name: string): unknown {
  const value = Object.getOwnPropertyDescriptor(input, name);
  if (!value || !('value' in value)) throw new TypeError('ROW303: row accessors are outside the checked DTO profile');
  return value.value;
}
function part(bytes: Uint8Array): string { return bytes.length.toString() + ':' + [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('') + ';'; }
function header(row: string, flavor: string): string { return part(utf8.encode('sgd-row-v1')) + part(utf8.encode(row)) + part(utf8.encode(flavor)); }
function integer64(value: bigint): Uint8Array { const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigInt64(0, value, false); return bytes; }
function integer32(value: number): Uint8Array { const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, value, false); return bytes; }
function same(left: PrimitiveValue | undefined, right: PrimitiveValue): boolean { return left !== undefined && left.kind === right.kind && left.value === right.value && (left.kind !== 'data' || right.kind === 'data' && left.domain === right.domain); }
function valueAt(snapshot: PrimitiveSnapshot, variable: string): PrimitiveValue | undefined {
  switch (variable) {
${model.variables.map(variable => `    case ${quoted(variable)}: return snapshot.values[${quoted(variable)}];`).join('\n')}
    default: return undefined;
  }
}
function matches(row: Identity | null, snapshot: PrimitiveSnapshot, payload: string, provenance: string, emptyPayload: PrimitiveValue, emptyProvenance: PrimitiveValue): boolean {
  const payloadValue: PrimitiveValue = row === null ? emptyPayload : { kind: 'data', domain: ${quoted(payload.domain)}, value: row.payload };
  const provenanceValue: PrimitiveValue = row === null ? emptyProvenance : { kind: 'data', domain: ${quoted(provenance.domain)}, value: row.provenance };
  return same(valueAt(snapshot, payload), payloadValue) && same(valueAt(snapshot, provenance), provenanceValue);
}
function lift<T extends Identity>(receipt: PrimitiveReceipt, payload: string, provenance: string, incoming: T, oldStored: T | null, oldRejected: T | null, emptyPayload: PrimitiveValue, emptyProvenance: PrimitiveValue): { readonly ok: true; readonly row: T | null } | { readonly ok: false } {
  const a: PrimitiveExpression | undefined = receipt.updates[payload];
  const b: PrimitiveExpression | undefined = receipt.updates[provenance];
  if (a?.kind === 'literal' && b?.kind === 'literal' && same(a.value, emptyPayload) && same(b.value, emptyProvenance)) return { ok: true, row: null };
  if (a?.kind === 'input' && b?.kind === 'input' && a.parameter === ${quoted(payload.parameter)} && b.parameter === ${quoted(provenance.parameter)}) return { ok: true, row: incoming };
  if (a?.kind === 'state' && b?.kind === 'state' && a.variable === ${quoted(stored.payload)} && b.variable === ${quoted(stored.provenance)}) return { ok: true, row: oldStored };
  if (a?.kind === 'state' && b?.kind === 'state' && a.variable === ${quoted(rejected.payload)} && b.variable === ${quoted(rejected.provenance)}) return { ok: true, row: oldRejected };
  return { ok: false };
}
${extension === undefined ? '' : extension.declarations + '\n'}${rowDefinitions}`;
  const generated = generateSymbolicTypeScript({ model, className: primitive });
  const files = generated.filter(file => file.path !== 'machine.ts' && file.path !== 'README.md').map(file => file.path === 'tsconfig.json' ? { ...file, content: file.content.replace('"machine.ts"', '"machine.ts", "primitive.ts"') } : file);
  const primitiveFile = generated.find(file => file.path === 'machine.ts');
  if (!primitiveFile) throw new Error('ROW301: primitive TypeScript authority was not generated');
  return [...files, { path: 'primitive.ts', content: primitiveFile.content }, { path: 'machine.ts', content: source }, { path: 'README.md', content: `# Generated whole-row TypeScript authority\n\nThis portable closed DTO profile derives from the audited Rust source schema, not a TypeScript source binding. For each Fact, call \`create<Fact>Row(data)\` with every raw field (i64 uses bigint), then call \`create<Fact>Owner().write(row)\`. Write results preserve the exact source action ID in \`effect\`; no configurable classifier or action rename table is accepted. Tokens are frozen, authenticated per Fact type and carry payload/provenance from the same complete row. Forged, cloned and cross-type objects are rejected before authority preparation. \`read()\` exposes only frozen row tokens and copied primitive state. Mutating inputs after token construction has no effect.\n\nIdentity encoding: each component is its decimal byte length, colon, lowercase hexadecimal bytes and semicolon. Header components are UTF-8 \`sgd-row-v1\`, Fact name and \`payload\` or \`provenance\`. Ordered fields append field name, kind and value components. Values are signed two's-complement big-endian i64, big-endian u32, one-byte bool (0/1), UTF-8 string or UTF-8 enum variant. Payload finite u32 classes use their minimum member; provenance retains the raw value. No hash or lossy number conversion defines row equality.\n\nAll row checks finish before consuming the private primitive preparation. Model origins select whole incoming or retained rows. Mixed payload/provenance origins reject without changing state. This covers one live owner in a trusted realm; application source coverage, partition permission, persistence, aliases to external mutable state and reset prevention require separate contracts.\n` }];
}
