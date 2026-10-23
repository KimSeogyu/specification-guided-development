import type { FiniteValue } from './finite-types.js';
import { type SanyDefinition, type SanyExpression, type SanyModule, type SanySourceSpan } from './sany-xml.js';
import type { ParsedSymbolicConfig, TlcConfigValue } from './symbolic-tlc.js';
import { symbolicModel, type SymbolicExpression, type SymbolicGuard, type SymbolicModel } from './symbolic-types.js';

const conjunctions = new Set(['$ConjList', '\\land']);
const disjunctions = new Set(['$DisjList', '\\lor']);
const permittedBuiltins = new Set(['$ConjList', '\\land', '$DisjList', '\\lor', '=', '/=', '\\in', '\\notin', '=>', '\\equiv', '\\lnot', '~', 'TRUE', 'FALSE', 'BOOLEAN', "'", 'UNCHANGED', '$Tuple', '$SetEnumerate', '$BoundedExists', '[]', '$SquareAct']);
const failure: (message: string, source?: SanySourceSpan | null) => never = (message, source) => {
  throw new Error(`TLC301: ${message}${source ? ` (${source.module}:${source.beginLine}:${source.beginColumn})` : ''}`);
};

/** Substitute by semantic symbol identity, never by textual parameter names. */
function substitute(expression: SanyExpression, values: ReadonlyMap<string, SanyExpression>): SanyExpression {
  if (expression.kind !== 'apply') return expression;
  const replacement = values.get(expression.operator.uid);
  if (expression.operator.kind === 'parameter' && replacement !== undefined) {
    if (expression.arguments.length) return failure('operator-valued parameters are unsupported', expression.source);
    return replacement;
  }
  return { ...expression, arguments: expression.arguments.map(argument => substitute(argument, values)), bounded: expression.bounded.map(bound => ({ ...bound, range: substitute(bound.range, values) })) };
}

export function lowerSymbolicModel(input: { name: string; semantic: SanyModule; config: ParsedSymbolicConfig }): SymbolicModel {
  const semantic = input.semantic;
  const variables = [...semantic.variables].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const variableIds = new Map(variables.map(variable => [variable.uid, variable.name]));
  const root = semantic.modules.find(module => module.name === semantic.root);
  if (!root || root.unsupported.length) return failure('unsupported top-level semantic declarations', root?.source);
  for (const module of semantic.modules) {
    if (!['Naturals', 'Integers', 'Sequences', 'FiniteSets'].includes(module.name) &&
      (module.unsupported.length || module.members.some(member => member.kind === 'unsupported' || member.kind === 'module'))) {
      return failure('top-level assumptions, instances, and proofs are outside the symbolic profile', module.source);
    }
  }
  const definition = (uid: string): SanyDefinition => {
    const symbol = semantic.symbols.get(uid);
    if (symbol?.kind !== 'definition' || symbol.recursive || symbol.parameters.some(parameter => parameter.arity !== 0)) return failure('expected a nonrecursive first-order definition', symbol?.source);
    return symbol;
  };
  const named = (name: string): SanyDefinition => {
    const matches = semantic.definitions.filter(candidate => candidate.name === name);
    if (matches.length !== 1 || !matches[0]) return failure(`configured operator ${name} is not a unique root definition`);
    const result = definition(matches[0].uid);
    if (result.arity !== 0) return failure(`configured operator ${name} must have no parameters`, result.source);
    return result;
  };
  function head(expression: SanyExpression, active: readonly string[] = []): SanyExpression {
    if (expression.kind !== 'apply' || expression.operator.kind !== 'definition') return expression;
    const def = definition(expression.operator.uid);
    if (active.includes(def.uid)) return failure('recursive executable definition', expression.source);
    if (expression.arguments.length !== def.parameters.length) return failure('definition arity mismatch', expression.source);
    return head(substitute(def.body, new Map(def.parameters.map((parameter, index) => {
      const argument = expression.arguments[index];
      if (!argument) return failure('missing semantic argument', expression.source);
      return [parameter.uid, argument];
    }))), [...active, def.uid]);
  }
  function inline(expression: SanyExpression, active: readonly string[] = []): SanyExpression {
    if (expression.kind !== 'apply') return expression;
    if (expression.operator.kind === 'definition') {
      const def = definition(expression.operator.uid);
      if (active.includes(def.uid)) return failure('recursive executable definition', expression.source);
      const args = expression.arguments.map(argument => inline(argument, active));
      if (args.length !== def.parameters.length) return failure('definition arity mismatch', expression.source);
      return inline(substitute(def.body, new Map(def.parameters.map((parameter, index) => {
        const argument = args[index];
        if (!argument) return failure('missing semantic argument', expression.source);
        return [parameter.uid, argument];
      }))), [...active, def.uid]);
    }
    return { ...expression, arguments: expression.arguments.map(argument => inline(argument, active)), bounded: expression.bounded.map(bound => ({ ...bound, range: inline(bound.range, active) })) };
  }
  function closure(expression: SanyExpression, active: readonly string[] = []): void {
    if (expression.kind === 'unsupported') return failure(`unsupported semantic node ${expression.nodeType}`, expression.source);
    if (expression.kind === 'literal') return;
    if (expression.operator.kind === 'builtin' && !permittedBuiltins.has(expression.operator.name)) return failure(`unsupported executable operator ${expression.operator.name}`, expression.source);
    for (const argument of expression.arguments) closure(argument, active);
    for (const bound of expression.bounded) { if (bound.tuple || bound.parameters.some(parameter => parameter.arity !== 0)) return failure('tuple or operator-valued binders are unsupported', expression.source); closure(bound.range, active); }
    if (expression.unbounded.length) return failure('unbounded quantification is unsupported', expression.source);
    if (expression.operator.kind === 'definition') {
      const def = definition(expression.operator.uid);
      if (active.includes(def.uid)) return failure('recursive executable definition', expression.source);
      closure(def.body, [...active, def.uid]);
    }
  }
  function application(expression: SanyExpression, name: string, arity?: number): Extract<SanyExpression, { kind: 'apply' }> {
    const result = head(expression);
    if (result.kind !== 'apply' || result.operator.kind !== 'builtin' || result.operator.name !== name || (arity !== undefined && result.arguments.length !== arity)) return failure(`expected supported ${name} expression`, result.source);
    return result;
  }
  function argument(expression: Extract<SanyExpression, { kind: 'apply' }>, index: number): SanyExpression {
    const result = expression.arguments[index];
    if (!result) return failure('missing executable operand', expression.source);
    return result;
  }
  function zeroDefinition(expression: SanyExpression): SanyDefinition {
    if (expression.kind !== 'apply' || expression.operator.kind !== 'definition' || expression.arguments.length) return failure('Spec must name Init and Next operators', expression.source);
    const result = definition(expression.operator.uid);
    if (result.arity) return failure('Spec Init and Next must have no parameters', result.source);
    return result;
  }
  function unchangedVariables(expression: SanyExpression): string[] {
    const result = head(expression);
    if (result.kind === 'apply' && result.operator.kind === 'variable' && !result.arguments.length) {
      const name = variableIds.get(result.operator.uid);
      if (!name) return failure('variable outside root state', result.source);
      return [name];
    }
    const tuple = application(result, '$Tuple');
    return tuple.arguments.flatMap(unchangedVariables);
  }
  function checkStateTuple(expression: SanyExpression): void {
    const names = unchangedVariables(expression);
    if (names.length !== variables.length || new Set(names).size !== names.length || names.some(name => !variables.some(variable => variable.name === name))) return failure('state tuple must contain every root variable exactly once', expression.source);
  }
  let init: SanyDefinition;
  let next: SanyDefinition;
  if (input.config.behavior.kind === 'init-next') {
    init = named(input.config.behavior.init); next = named(input.config.behavior.next);
  } else {
    const spec = named(input.config.behavior.operator);
    closure(spec.body);
    const body = head(spec.body);
    if (body.kind !== 'apply' || !conjunctions.has(body.operator.name) || body.arguments.length !== 2) return failure('Spec must be exactly Init /\\ [][Next]_vars', body.source);
    const temporalIndex = body.arguments.findIndex(term => { const expanded = head(term); return expanded.kind === 'apply' && expanded.operator.kind === 'builtin' && expanded.operator.name === '[]'; });
    if (temporalIndex < 0) return failure('Spec must contain one always-action wrapper', body.source);
    init = zeroDefinition(argument(body, temporalIndex === 0 ? 1 : 0));
    const always = application(argument(body, temporalIndex), '[]', 1);
    const square = application(argument(always, 0), '$SquareAct', 2);
    next = zeroDefinition(argument(square, 0)); checkStateTuple(argument(square, 1));
  }
  closure(init.body); closure(next.body);
  const quantified = application(next.body, '$BoundedExists', 1);
  const bound = quantified.bounded[0];
  if (quantified.bounded.length !== 1 || !bound || bound.parameters.length !== 1 || !bound.parameters[0]) return failure('Next requires one scalar bounded input parameter', quantified.source);
  const parameter = bound.parameters[0];
  const range = head(bound.range);
  if (range.kind !== 'apply' || range.operator.kind !== 'constant' || range.arguments.length) return failure('input range must name a configured opaque domain', range.source);
  const domain = range.operator.name;
  const domainConfig = input.config.constants[domain];
  if (domainConfig?.kind !== 'set' || domainConfig.values.length < 2 || domainConfig.values.some(value => value.kind !== 'model-value')) return failure('opaque input domain requires at least two configured model values', range.source);
  if (domainConfig.values.some(value => typeof value.value === 'string' && value.value.length > 2 && value.value[1] === '_')) return failure('typed TLC model values cannot represent the untyped runtime data domain', range.source);
  if (new Set(domainConfig.values.map(value => value.value)).size !== domainConfig.values.length) return failure('opaque domain contains duplicate atoms', range.source);
  for (const [name, value] of Object.entries(input.config.constants)) {
    if (name !== domain && (value.kind === 'model-value' || (value.kind === 'set' && value.values.some(item => item.kind === 'model-value')))) return failure('only the input domain may contain configured model values');
  }
  const scalarConstant = (value: TlcConfigValue, source: SanySourceSpan | null): FiniteValue => {
    switch (value.kind) {
      case 'string': return { kind: 'string', value: value.value };
      case 'integer': return { kind: 'integer', value: value.value };
      case 'boolean': return { kind: 'boolean', value: value.value };
      case 'set': case 'model-value': return failure('expected a scalar constant; opaque atoms cannot be literal runtime values', source);
    }
  };
  function value(expression: SanyExpression, allowNext = false): SymbolicExpression {
    const result = head(expression);
    if (result.kind === 'literal') return { kind: 'literal', value: result.value };
    if (result.kind !== 'apply' || result.bounded.length || result.unbounded.length) return failure('unsupported symbolic value expression', result.source);
    if (result.operator.kind === 'variable' && !result.arguments.length) {
      const variable = variableIds.get(result.operator.uid);
      if (!variable) return failure('unknown root variable', result.source);
      return { kind: 'state', variable };
    }
    if (result.operator.kind === 'parameter' && result.operator.uid === parameter.uid && !result.arguments.length) return { kind: 'input' };
    if (result.operator.kind === 'constant' && !result.arguments.length) {
      const configured = input.config.constants[result.operator.name];
      if (!configured) return failure('unassigned constant', result.source);
      return { kind: 'literal', value: scalarConstant(configured, result.source) };
    }
    if (result.operator.kind === 'builtin' && ['TRUE', 'FALSE'].includes(result.operator.name) && !result.arguments.length) return { kind: 'literal', value: { kind: 'boolean', value: result.operator.name === 'TRUE' } };
    if (result.operator.kind === 'builtin' && result.operator.name === "'" && result.arguments.length === 1 && allowNext) {
      const variable = value(argument(result, 0));
      if (variable.kind !== 'state') return failure('prime must refer to one root variable', result.source);
      return { kind: 'next-state', variable: variable.variable };
    }
    return failure(`unsupported value operator ${result.operator.name}`, result.source);
  }
  function guard(expression: SanyExpression, allowNext = false): SymbolicGuard {
    const result = head(expression);
    if (result.kind !== 'apply' || result.operator.kind !== 'builtin' || result.bounded.length || result.unbounded.length) return failure('unsupported symbolic predicate', result.source);
    const args = result.arguments;
    const name = result.operator.name;
    if (['TRUE', 'FALSE'].includes(name) && !args.length) return { kind: 'boolean', value: name === 'TRUE' };
    if (conjunctions.has(name) || disjunctions.has(name)) return { kind: conjunctions.has(name) ? 'and' : 'or', terms: args.map(term => guard(term, allowNext)) };
    if (['\\lnot', '~'].includes(name) && args.length === 1) return { kind: 'not', term: guard(argument(result, 0), allowNext) };
    if (['=>', '\\equiv'].includes(name) && args.length === 2) return { kind: name === '=>' ? 'implies' : 'equivalent', left: guard(argument(result, 0), allowNext), right: guard(argument(result, 1), allowNext) };
    if (['=', '/='].includes(name) && args.length === 2) return { kind: name === '=' ? 'equal' : 'not-equal', left: value(argument(result, 0), allowNext), right: value(argument(result, 1), allowNext) };
    if (['\\in', '\\notin'].includes(name) && args.length === 2) {
      const member = value(argument(result, 0), allowNext);
      const set = head(argument(result, 1));
      let predicate: SymbolicGuard;
      if (set.kind === 'apply' && set.operator.kind === 'constant' && set.operator.name === domain && !set.arguments.length) predicate = { kind: 'in-domain', domain, value: member };
      else {
        let elements: FiniteValue[];
        if (set.kind === 'apply' && set.operator.kind === 'builtin' && set.operator.name === '$SetEnumerate') elements = set.arguments.map(element => {
          const item = value(element);
          if (item.kind !== 'literal') return failure('finite set members must be scalar constants', element.source);
          return item.value;
        });
        else if (set.kind === 'apply' && set.operator.kind === 'constant' && !set.arguments.length) {
          const configured = input.config.constants[set.operator.name];
          if (configured?.kind !== 'set') return failure('expected a configured finite set', set.source);
          elements = configured.values.map(item => scalarConstant(item, set.source));
        } else if (set.kind === 'apply' && set.operator.kind === 'builtin' && set.operator.name === 'BOOLEAN' && !set.arguments.length) elements = [{ kind: 'boolean', value: false }, { kind: 'boolean', value: true }];
        else return failure('unsupported membership domain', set.source);
        if (new Set(elements.map(element => element.kind)).size > 1) return failure('finite literal sets must contain one scalar kind', set.source);
        predicate = { kind: 'member', value: member, elements };
      }
      return name === '\\notin' ? { kind: 'not', term: predicate } : predicate;
    }
    return failure(`unsupported predicate operator ${name}`, result.source);
  }
  const initial = new Map<string, FiniteValue>();
  function initTerms(expression: SanyExpression): void {
    const result = head(expression);
    if (result.kind === 'apply' && conjunctions.has(result.operator.name)) { result.arguments.forEach(initTerms); return; }
    const equal = application(result, '=', 2);
    const left = value(argument(equal, 0));
    const right = value(argument(equal, 1));
    if (left.kind !== 'state' || right.kind !== 'literal' || initial.has(left.variable)) return failure('Init requires one scalar assignment for each variable', result.source);
    initial.set(left.variable, right.value);
  }
  initTerms(inline(init.body));
  function containsUpdate(expression: SanyExpression): boolean {
    return expression.kind === 'apply' && ((expression.operator.kind === 'builtin' && ["'", 'UNCHANGED'].includes(expression.operator.name)) || expression.arguments.some(containsUpdate));
  }
  function alternatives(expression: SanyExpression): SanyExpression[][] {
    if (!containsUpdate(expression)) return [[expression]];
    if (expression.kind === 'apply' && disjunctions.has(expression.operator.name)) return expression.arguments.flatMap(alternatives);
    if (expression.kind === 'apply' && conjunctions.has(expression.operator.name)) {
      let product: SanyExpression[][] = [[]];
      for (const argument of expression.arguments) {
        const choices = alternatives(argument);
        if (product.length * choices.length > 256) return failure('action normalization exceeds 256 cases', expression.source);
        product = product.flatMap(left => choices.map(right => [...left, ...right]));
      }
      return product;
    }
    return [[expression]];
  }
  const branches: SymbolicModel['branches'] = [];
  function actionCall(expression: SanyExpression): void {
    if (expression.kind === 'apply' && expression.operator.kind === 'builtin' && disjunctions.has(expression.operator.name)) { expression.arguments.forEach(actionCall); return; }
    if (expression.kind !== 'apply' || expression.operator.kind !== 'definition') return failure('Next input body must be a disjunction of named action calls', expression.source);
    const action = definition(expression.operator.uid);
    const passed = expression.arguments[0];
    if (action.parameters.length !== 1 || expression.arguments.length !== 1 || !passed || passed.kind !== 'apply' || passed.operator.kind !== 'parameter' || passed.operator.uid !== parameter.uid || passed.arguments.length) return failure('each action must receive the same Next input directly', expression.source);
    const formal = action.parameters[0];
    if (!formal) return failure('missing action input', action.source);
    const body = inline(substitute(action.body, new Map([[formal.uid, passed]])));
    for (const terms of alternatives(body)) {
      const updates = new Map<string, SymbolicExpression>();
      const guards: SymbolicGuard[] = [{ kind: 'in-domain', value: { kind: 'input' }, domain }];
      const assign = (variable: string, expression: SymbolicExpression): void => {
        if (updates.has(variable)) return failure(`multiple next-state constraints for ${variable}`, action.source);
        updates.set(variable, expression);
      };
      for (const term of terms) {
        if (term.kind === 'apply' && term.operator.kind === 'builtin' && term.operator.name === 'UNCHANGED' && term.arguments.length === 1) {
          for (const variable of unchangedVariables(argument(term, 0))) assign(variable, { kind: 'state', variable });
        } else if (term.kind === 'apply' && term.operator.kind === 'builtin' && term.operator.name === '=' && term.arguments.length === 2 && argument(term, 0).kind === 'apply') {
          const left = head(argument(term, 0));
          if (left.kind === 'apply' && left.operator.kind === 'builtin' && left.operator.name === "'") {
            const variable = value(argument(left, 0));
            if (variable.kind !== 'state') return failure('assignment must prime a root variable', left.source);
            assign(variable.variable, value(argument(term, 1)));
          } else guards.push(guard(term));
        } else guards.push(guard(term));
      }
      branches.push({ action: action.name, source: action.source, guard: { kind: 'and', terms: guards }, updates: Object.fromEntries(variables.map(variable => {
        const update = updates.get(variable.name);
        if (!update) return failure(`action ${action.name} leaves ${variable.name}' unconstrained; add an assignment or UNCHANGED`, action.source);
        return [variable.name, update];
      })) });
    }
  }
  actionCall(argument(quantified, 0));
  const invariants = input.config.invariants.map(name => { const def = named(name); closure(def.body); return { name, predicate: guard(inline(def.body)) }; });
  const actionProperties = input.config.properties.map(name => {
    const def = named(name); closure(def.body);
    const always = application(def.body, '[]', 1);
    const square = application(argument(always, 0), '$SquareAct', 2);
    checkStateTuple(argument(square, 1));
    return { kind: 'square-action', name, predicate: guard(inline(argument(square, 0)), true) } satisfies SymbolicModel['actionProperties'][number];
  });
  return symbolicModel({ version: 1, kind: 'symbolic-owned', name: input.name, checkDeadlock: input.config.checkDeadlock, variables: variables.map(variable => variable.name),
    input: { parameter: parameter.name, domain, next: next.name }, initial: Object.fromEntries(variables.map(variable => {
      const assigned = initial.get(variable.name);
      if (!assigned) return failure('Init leaves a variable unconstrained', init.source);
      return [variable.name, assigned];
    })), branches, invariants, actionProperties });
}
