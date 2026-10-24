import { isDeepStrictEqual } from 'node:util';
import {
  ContractBindingsSchema, ContractDeclarationsSchema, ContractModelReferencesSchema, NativeContractObligationSchema,
  type ContractClosure, type ContractClosureFinding, type ContractDeclarations, type ContractObligation,
} from './contract-types.js';
import type { SanyExpression, SanyModule, SanySourceSpan } from './sany-xml.js';

export class ContractGraphError extends Error {
  readonly diagnostic: { ruleId: 'TLC311'; kind: 'unsupported-contract-declaration'; detail: string; source: SanySourceSpan | null };
  constructor(detail: string, source: SanySourceSpan | null = null) {
    super(`TLC311: ${detail}`);
    this.name = 'ContractGraphError';
    this.diagnostic = { ruleId: 'TLC311', kind: 'unsupported-contract-declaration', detail, source };
  }
}

const fail = (detail: string, source: SanySourceSpan | null = null): never => { throw new ContractGraphError(detail, source); };

function declarations(input: unknown): ContractDeclarations {
  const parsed = ContractDeclarationsSchema.safeParse(input);
  if (!parsed.success) return fail(`invalid contract declarations: ${parsed.error.issues.slice(0, 6).map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  return parsed.data;
}

/** Decode the strict literal SANY shape used by partition metadata. This establishes no behavior or build provenance. */
export function lowerStructuralContracts(input: { semantic: SanyModule; module: string; operator: string }): ContractDeclarations {
  const module = input.semantic.modules.find(candidate => candidate.name === input.module);
  const definitions = input.semantic.definitions.filter(candidate => candidate.name === input.operator && candidate.source?.module === input.module);
  const definition = definitions[0];
  if (!module || module.unsupported.length || module.members.length !== 1 || definitions.length !== 1 || !definition ||
    module.members[0]?.uid !== definition.uid || definition.arity !== 0 || definition.recursive || definition.level !== 0) {
    return fail('contract metadata requires one zero-argument literal definition and no imports, declarations, assumptions, or helper definitions', definition?.source ?? null);
  }
  const application = (expression: SanyExpression, name: string): readonly SanyExpression[] => {
    const resolved = expression.kind === 'apply' ? input.semantic.symbols.get(expression.operator.uid) : undefined;
    if (expression.kind !== 'apply' || expression.operator.kind !== 'builtin' || expression.operator.name !== name ||
      resolved?.kind !== 'builtin' || resolved.name !== name || expression.level !== 0 || expression.bounded.length || expression.unbounded.length) {
      return fail(`contract metadata permits only literal ${name} constructors here`, expression.source);
    }
    return expression.arguments;
  };
  const text = (expression: SanyExpression | undefined): string => {
    if (expression?.kind !== 'literal' || expression.level !== 0 || expression.value.kind !== 'string') return fail('contract metadata requires literal strings', expression?.source ?? null);
    return expression.value.value;
  };
  const record = (expression: SanyExpression): Map<string, SanyExpression> => {
    const result = new Map<string, SanyExpression>();
    for (const pair of application(expression, '$RcdConstructor')) {
      const args = application(pair, '$Pair');
      const name = text(args[0]); const value = args[1];
      if (args.length !== 2 || !value || result.has(name) || name === '__proto__') return fail('contract metadata record members must be unique supported literal pairs', pair.source);
      result.set(name, value);
    }
    return result;
  };
  const exact = (value: Map<string, SanyExpression>, expected: readonly string[], source: SanySourceSpan | null): void => {
    if (value.size !== expected.length || expected.some(name => !value.has(name))) fail(`contract metadata requires exactly ${expected.join(', ')}`, source);
  };
  const field = (value: Map<string, SanyExpression>, name: string): SanyExpression => value.get(name) ?? fail(`missing contract metadata field ${name}`);
  const names = (expression: SanyExpression): Record<string, string> => Object.fromEntries([...record(expression)].map(([name, value]) => [name, text(value)]));
  const root = record(definition.body);
  exact(root, ['version', 'scope', 'contracts', 'relations', 'native'], definition.source);
  const version = field(root, 'version');
  if (version.kind !== 'literal' || version.level !== 0 || version.value.kind !== 'integer' || version.value.value !== '1') return fail('unsupported contract metadata version', version.source);
  const relations = application(field(root, 'relations'), '$Tuple').map(expression => {
    const relation = record(expression);
    const kind = text(field(relation, 'kind'));
    if (kind !== 'enabled-input-erasure') return fail(`unsupported contract relation kind ${kind}`, expression.source);
    exact(relation, ['id', 'kind', 'upper', 'lower', 'variables', 'inputs', 'actions'], expression.source);
    return { id: text(field(relation, 'id')), kind, upper: text(field(relation, 'upper')), lower: text(field(relation, 'lower')),
      variables: names(field(relation, 'variables')), inputs: names(field(relation, 'inputs')), actions: names(field(relation, 'actions')) };
  });
  const native = application(field(root, 'native'), '$Tuple').map(expression => {
    const obligation = record(expression);
    exact(obligation, ['id', 'kind', 'owner', 'role'], expression.source);
    const kind = text(field(obligation, 'kind'));
    if (!NativeContractObligationSchema.shape.kind.safeParse(kind).success) return fail(`unsupported native contract obligation kind ${kind}`, expression.source);
    return Object.fromEntries([...obligation].map(([name, value]) => [name, text(value)]));
  });
  return declarations({ version: 1, scope: text(field(root, 'scope')),
    contracts: application(field(root, 'contracts'), '$SetEnumerate').map(text).sort(), relations, native });
}

/** Retain baseline requirements and enumerate work. No returned obligation is semantic or native evidence. */
export function checkContractClosure(input: { baseline: unknown; candidate: unknown; models: unknown; bindings: unknown }): ContractClosure {
  const baseline = declarations(input.baseline);
  const candidate = declarations(input.candidate);
  const parsedModels = ContractModelReferencesSchema.safeParse(input.models);
  const parsedBindings = ContractBindingsSchema.safeParse(input.bindings);
  if (!parsedModels.success) return fail(`invalid contract model references: ${parsedModels.error.issues.slice(0, 4).map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  if (!parsedBindings.success) return fail(`invalid native binding selectors: ${parsedBindings.error.issues.slice(0, 4).map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  const findings: ContractClosureFinding[] = [];
  const obligations: ContractObligation[] = [];
  if (candidate.scope !== baseline.scope) findings.push({ kind: 'changed-scope', expected: baseline.scope, actual: candidate.scope });
  for (const contract of baseline.contracts) {
    if (!candidate.contracts.includes(contract)) findings.push({ kind: 'missing-contract', contract });
    obligations.push({ kind: 'baseline-properties', contract }, { kind: 'baseline-behavior', contract });
  }
  for (const contract of candidate.contracts) {
    obligations.push({ kind: 'model-verification', contract });
    if (!Object.hasOwn(parsedModels.data, contract)) findings.push({ kind: 'missing-model-reference', contract });
  }
  for (const contract of Object.keys(parsedModels.data)) if (!candidate.contracts.includes(contract)) findings.push({ kind: 'extra-model-reference', contract });
  const relations = new Map(baseline.relations.map(relation => [relation.id, relation]));
  for (const relation of baseline.relations) {
    const actual = candidate.relations.find(value => value.id === relation.id);
    if (!actual) findings.push({ kind: 'missing-obligation', obligation: 'relation', id: relation.id });
    else if (!isDeepStrictEqual(relation, actual)) findings.push({ kind: 'changed-obligation', obligation: 'relation', id: relation.id });
  }
  for (const relation of candidate.relations) if (!relations.has(relation.id)) relations.set(relation.id, relation);
  for (const relation of relations.values()) obligations.push({ kind: 'enabled-input-erasure', relation });
  const native = new Map(baseline.native.map(obligation => [obligation.id, obligation]));
  for (const required of baseline.native) {
    const actual = candidate.native.find(value => value.id === required.id);
    if (!actual) findings.push({ kind: 'missing-obligation', obligation: 'native', id: required.id });
    else if (!isDeepStrictEqual(required, actual)) findings.push({ kind: 'changed-obligation', obligation: 'native', id: required.id });
  }
  for (const obligation of candidate.native) if (!native.has(obligation.id)) native.set(obligation.id, obligation);
  for (const declaration of native.values()) {
    obligations.push({ kind: 'native', declaration });
    if (!Object.hasOwn(parsedBindings.data.bindings, declaration.id)) findings.push({ kind: 'missing-binding', id: declaration.id, owner: declaration.owner, role: declaration.role });
    else findings.push({ kind: 'unsupported', obligation: 'native', id: declaration.id, detail: `${declaration.kind} has a supplied selector but no native verifier in this profile` });
  }
  for (const id of Object.keys(parsedBindings.data.bindings)) if (!native.has(id)) findings.push({ kind: 'extra-binding', id });
  if (baseline.scope === 'application' || candidate.scope === 'application') {
    obligations.push({ kind: 'application-coverage', scope: 'application' });
    findings.push({ kind: 'unsupported', obligation: 'application-coverage', id: 'application', detail: 'application source, target, and effect closure is not implemented by this declaration profile' });
  }
  return { kind: 'required-contract-obligations', scope: baseline.scope, obligations, findings,
    semanticVerification: 'not-performed', sourceProvenance: 'not-established', independentlySelectedBaseline: 'not-established' };
}
