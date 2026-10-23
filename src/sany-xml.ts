import { SaxesParser } from 'saxes';

export interface SanySourceSpan {
  module: string;
  beginLine: number;
  beginColumn: number;
  endLine: number;
  endColumn: number;
}

/** Retained only for unsupported semantic nodes; it cannot authorize execution. */
export interface SanyXmlElement {
  name: string;
  text: string;
  children: readonly SanyXmlElement[];
}

interface Metadata {
  source: SanySourceSpan | null;
  level: number | null;
}

export interface SanySymbolRef {
  uid: string;
  name: string;
  kind: SanySymbol['kind'];
}

export interface SanyFormalParameter extends Metadata {
  kind: 'parameter';
  uid: string;
  name: string;
  arity: number;
}

export interface SanyDeclaration extends Metadata {
  kind: 'constant' | 'variable';
  uid: string;
  name: string;
  arity: number;
}

export interface SanyDefinition extends Metadata {
  kind: 'definition';
  uid: string;
  name: string;
  arity: number;
  parameters: readonly SanyFormalParameter[];
  recursive: boolean;
  body: SanyExpression;
}

export interface SanyBuiltin extends Metadata {
  kind: 'builtin';
  uid: string;
  name: string;
  arity: number;
  parameters: readonly SanyFormalParameter[];
}

export interface SanyUnsupportedExpression extends Metadata {
  kind: 'unsupported';
  nodeType: string;
  raw: SanyXmlElement;
}

export interface SanyModuleInfo extends Metadata {
  kind: 'module';
  uid: string;
  name: string;
  members: readonly SanySymbolRef[];
  unsupported: readonly SanyUnsupportedExpression[];
}

export interface SanyUnsupportedSymbol extends Metadata {
  kind: 'unsupported';
  uid: string;
  name: string;
  nodeType: string;
  raw: SanyXmlElement;
}

export type SanySymbol = SanyFormalParameter | SanyDeclaration | SanyDefinition | SanyBuiltin | SanyModuleInfo | SanyUnsupportedSymbol;

export interface SanyBound {
  parameters: readonly SanyFormalParameter[];
  tuple: boolean;
  range: SanyExpression;
}

export type SanyExpression =
  | (Metadata & { kind: 'literal'; value: { kind: 'string'; value: string } | { kind: 'integer'; value: string } })
  | (Metadata & {
    kind: 'apply'; operator: SanySymbolRef; arguments: readonly SanyExpression[];
    bounded: readonly SanyBound[]; unbounded: readonly SanyFormalParameter[];
  })
  | SanyUnsupportedExpression;

export interface SanyModule {
  root: string;
  modules: readonly SanyModuleInfo[];
  symbols: ReadonlyMap<string, SanySymbol>;
  variables: readonly SanyDeclaration[];
  constants: readonly SanyDeclaration[];
  definitions: readonly SanyDefinition[];
}

interface XmlElement { name: string; text: string; children: XmlElement[] }
const maximumBytes = 16 * 1024 * 1024;
const maximumDepth = 256;
const maximumElements = 200_000;
const metadataNames = ['location', 'level'];
const fail: (message: string) => never = message => { throw new Error(`TLC203: invalid pinned SANY XML: ${message}`); };

function xmlTree(xml: string): XmlElement {
  if (Buffer.byteLength(xml, 'utf8') > maximumBytes) fail('document exceeds 16 MiB');
  const parser = new SaxesParser({ xmlns: false });
  const stack: XmlElement[] = [];
  const roots: XmlElement[] = [];
  let elements = 0;
  parser.on('error', error => fail(error.message));
  parser.on('doctype', () => fail('DOCTYPE and entity declarations are forbidden'));
  parser.on('processinginstruction', () => fail('processing instructions are forbidden'));
  parser.on('comment', () => fail('comments are not part of the pinned exporter format'));
  parser.on('cdata', () => fail('CDATA is not part of the pinned exporter format'));
  parser.on('xmldecl', declaration => {
    if (declaration.version !== '1.0' || (declaration.encoding !== undefined && declaration.encoding.toUpperCase() !== 'UTF-8')) {
      fail('unsupported XML declaration');
    }
  });
  parser.on('opentag', tag => {
    if (++elements > maximumElements) fail('too many elements');
    if (stack.length >= maximumDepth) fail('element nesting exceeds 256');
    if (Object.keys(tag.attributes).length > 0 || tag.name.includes(':')) fail(`attributes or namespaces on ${tag.name}`);
    const node: XmlElement = { name: tag.name, text: '', children: [] };
    const parent = stack.at(-1);
    if (parent === undefined) roots.push(node); else parent.children.push(node);
    stack.push(node);
  });
  parser.on('text', text => {
    const current = stack.at(-1);
    if (current === undefined) { if (text.trim()) fail('text outside root'); }
    else current.text += text;
  });
  parser.on('closetag', () => { stack.pop(); });
  parser.write(xml).close();
  const root = roots[0];
  if (roots.length !== 1 || root === undefined || root.name !== 'modules') fail('expected one modules root');
  return root;
}

function structure(node: XmlElement, allowed: readonly string[]): void {
  if (node.text.trim()) fail(`unexpected text in ${node.name}`);
  for (const child of node.children) if (!allowed.includes(child.name)) fail(`unexpected ${child.name} in ${node.name}`);
}

function one(node: XmlElement, name: string, required = true): XmlElement | undefined {
  const children = node.children.filter(child => child.name === name);
  if (children.length > 1 || (required && children.length !== 1)) fail(`expected ${required ? 'one' : 'at most one'} ${name} in ${node.name}`);
  return children[0];
}

function required(node: XmlElement, name: string): XmlElement {
  const child = one(node, name);
  if (child === undefined) return fail(`missing ${name}`);
  return child;
}

function leaf(node: XmlElement): string {
  if (node.children.length) fail(`unexpected children in ${node.name}`);
  return node.text;
}

function text(node: XmlElement, name: string): string { return leaf(required(node, name)); }
function integer(value: string, context: string, minimum = 0): number {
  if (!/^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/.test(value)) fail(`invalid integer for ${context}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) fail(`out-of-range integer for ${context}`);
  return parsed;
}
function uid(node: XmlElement): string {
  const value = text(node, 'UID');
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) fail('invalid symbol UID');
  return value;
}
function metadata(node: XmlElement): Metadata {
  const levelNode = one(node, 'level', false);
  const level = levelNode === undefined ? null : integer(leaf(levelNode), 'level');
  if (level !== null && level > 3) fail('unsupported expression level');
  const location = one(node, 'location', false);
  if (location === undefined) return { source: null, level };
  structure(location, ['column', 'line', 'filename']);
  const coordinates = (name: string): [number, number] => {
    const part = required(location, name);
    structure(part, ['begin', 'end']);
    return [integer(text(part, 'begin'), name), integer(text(part, 'end'), name)];
  };
  const [beginLine, endLine] = coordinates('line');
  const [beginColumn, endColumn] = coordinates('column');
  const module = text(location, 'filename');
  if (!module || endLine < beginLine || (beginLine === endLine && endColumn < beginColumn)) fail('invalid source span');
  return { level, source: { module, beginLine, beginColumn, endLine, endColumn } };
}

/** Parse only the semantic format emitted by the pinned exporter; this does not establish SANY success or TLC verification. */
export function parseSanyXml(xml: string): SanyModule {
  const root = xmlTree(xml);
  structure(root, ['context', 'RootModule', 'ModuleNodeRef']);
  const rootName = text(root, 'RootModule');
  if (!rootName) fail('empty root module name');
  const context = required(root, 'context');
  structure(context, ['entry']);
  const rawSymbols = new Map<string, XmlElement>();
  for (const entry of context.children) {
    if (entry.text.trim()) fail('unexpected text in context entry');
    const id = uid(entry);
    const definitions = entry.children.filter(child => child.name !== 'UID');
    const definition = definitions[0];
    if (definitions.length !== 1 || definition === undefined || definition.name.endsWith('Ref')) fail('entry requires one symbol definition');
    if (rawSymbols.has(id)) fail('duplicate symbol UID');
    rawSymbols.set(id, definition);
  }
  const referenceId = (reference: XmlElement): string => {
    structure(reference, ['UID']);
    const id = uid(reference);
    const target = rawSymbols.get(id);
    if (target === undefined) fail(`missing symbol reference ${id}`);
    if (reference.name !== `${target.name}Ref`) fail(`reference kind ${reference.name} does not match ${target.name}`);
    return id;
  };
  const visitReferences = (node: XmlElement): void => {
    if (node.name.endsWith('Ref')) referenceId(node);
    for (const child of node.children) visitReferences(child);
  };
  visitReferences(root);
  const symbols = new Map<string, SanySymbol>();
  const symbolKind = (node: XmlElement): SanySymbol['kind'] => {
    switch (node.name) {
      case 'FormalParamNode': return 'parameter';
      case 'UserDefinedOpKind': return 'definition';
      case 'BuiltInKind': return 'builtin';
      case 'ModuleNode': return 'module';
      case 'OpDeclNode': {
        const kind = text(node, 'kind');
        if (kind === '2') return 'constant';
        if (kind === '3') return 'variable';
        return 'unsupported';
      }
      default: return 'unsupported';
    }
  };
  const reference = (node: XmlElement): SanySymbolRef => {
    const id = referenceId(node);
    const target = rawSymbols.get(id);
    if (target === undefined) return fail('missing reference after validation');
    const nameNode = one(target, 'uniquename', false);
    return { uid: id, name: nameNode === undefined ? target.name : leaf(nameNode), kind: symbolKind(target) };
  };
  const formal = (node: XmlElement): SanyFormalParameter => {
    if (node.name !== 'FormalParamNodeRef') fail('expected a formal-parameter reference');
    const symbol = parseSymbol(referenceId(node));
    if (symbol.kind !== 'parameter') return fail('reference is not a formal parameter');
    return symbol;
  };
  const parameters = (node: XmlElement, variadic = false): readonly SanyFormalParameter[] => {
    const params = one(node, 'params', !variadic);
    if (params === undefined) return [];
    structure(params, ['leibnizparam']);
    const result = params.children.map(parameter => {
      structure(parameter, ['FormalParamNodeRef', 'leibniz']);
      const marker = one(parameter, 'leibniz', false);
      if (marker !== undefined && leaf(marker) !== '') fail('invalid leibniz marker');
      return formal(required(parameter, 'FormalParamNodeRef'));
    });
    if (new Set(result.map(parameter => parameter.uid)).size !== result.length) fail('duplicate formal parameter');
    return result;
  };
  const unsupported = (node: XmlElement): SanyUnsupportedExpression => ({ kind: 'unsupported', nodeType: node.name, raw: node, ...metadata(node) });
  const expression = (node: XmlElement): SanyExpression => {
    const meta = metadata(node);
    switch (node.name) {
      case 'StringNode':
        structure(node, [...metadataNames, 'StringValue']);
        return { kind: 'literal', value: { kind: 'string', value: text(node, 'StringValue') }, ...meta };
      case 'NumeralNode': {
        structure(node, [...metadataNames, 'IntValue']);
        const value = text(node, 'IntValue');
        if (!/^(?:0|[1-9][0-9]*)$/.test(value)) fail('invalid exact integer literal');
        return { kind: 'literal', value: { kind: 'integer', value }, ...meta };
      }
      case 'OpApplNode': {
        structure(node, [...metadataNames, 'operator', 'operands', 'boundSymbols']);
        const operatorNode = required(node, 'operator');
        if (operatorNode.text.trim() || operatorNode.children.length !== 1) fail('operator requires one symbol reference');
        const operatorRef = operatorNode.children[0];
        if (operatorRef === undefined || !operatorRef.name.endsWith('Ref')) fail('operator requires one symbol reference');
        const operator = reference(operatorRef);
        if (operator.kind === 'module' || operator.kind === 'unsupported') return unsupported(node);
        const operands = required(node, 'operands');
        if (operands.text.trim()) fail('unexpected text in operands');
        const args = operands.children.map(expression);
        const rawOperator = rawSymbols.get(operator.uid);
        if (rawOperator === undefined) return fail('missing operator');
        const arity = integer(text(rawOperator, 'arity'), 'operator arity', -1);
        if (arity !== -1 && arity !== args.length) fail('application arity does not match operator');
        const bounds = one(node, 'boundSymbols', false);
        const bounded: SanyBound[] = [];
        const unbounded: SanyFormalParameter[] = [];
        const binderIds = new Set<string>();
        if (bounds !== undefined) {
          structure(bounds, ['bound', 'unbound']);
          for (const bound of bounds.children) {
            if (bound.text.trim()) fail('unexpected text in binder');
            const formalNodes = bound.children.filter(child => child.name === 'FormalParamNodeRef');
            const params = formalNodes.map(formal);
            if (!params.length) fail('binder has no formal parameters');
            for (const param of params) {
              if (binderIds.has(param.uid)) fail('duplicate quantified parameter');
              binderIds.add(param.uid);
            }
            if (bound.name === 'unbound') {
              structure(bound, ['FormalParamNodeRef']);
              unbounded.push(...params);
            } else {
              const tuple = one(bound, 'tuple', false);
              if (tuple !== undefined && leaf(tuple) !== '') fail('invalid tuple marker');
              const ranges = bound.children.filter(child => child.name !== 'FormalParamNodeRef' && child.name !== 'tuple');
              const range = ranges[0];
              if (ranges.length !== 1 || range === undefined) fail('bounded binder requires one range');
              // The exporter writes parameters, an optional tuple marker, then the range.
              if (bound.children.at(-1) !== range || formalNodes.some((child, index) => bound.children[index] !== child)) fail('invalid binder child order');
              bounded.push({ parameters: params, tuple: tuple !== undefined, range: expression(range) });
            }
          }
        }
        return { kind: 'apply', operator, arguments: args, bounded, unbounded, ...meta };
      }
      default: return unsupported(node);
    }
  };
  const parseSymbol = (id: string): SanySymbol => {
    const cached = symbols.get(id);
    if (cached !== undefined) return cached;
    const node = rawSymbols.get(id);
    if (node === undefined) return fail('missing symbol');
    const meta = metadata(node);
    const kind = symbolKind(node);
    const nameNode = one(node, 'uniquename', false);
    if (kind !== 'unsupported' && nameNode === undefined) fail(`missing uniquename in ${node.name}`);
    const name = nameNode === undefined ? node.name : leaf(nameNode);
    if (!name) fail('empty symbol name');
    let result: SanySymbol;
    switch (kind) {
      case 'constant': case 'variable':
        structure(node, [...metadataNames, 'uniquename', 'arity', 'kind']);
        result = { kind, uid: id, name, arity: integer(text(node, 'arity'), 'declaration arity'), ...meta };
        break;
      case 'parameter':
        structure(node, [...metadataNames, 'uniquename', 'arity']);
        result = { kind, uid: id, name, arity: integer(text(node, 'arity'), 'parameter arity'), ...meta };
        break;
      case 'definition': case 'builtin': {
        structure(node, [...metadataNames, 'uniquename', 'arity', 'params', ...(kind === 'definition' ? ['body', 'recursive'] : [])]);
        const arity = integer(text(node, 'arity'), 'definition arity', kind === 'builtin' ? -1 : 0);
        const params = parameters(node, kind === 'builtin' && arity === -1);
        if (arity !== -1 && params.length !== arity) fail('definition parameter count differs from arity');
        if (kind === 'builtin') result = { kind, uid: id, name, arity, parameters: params, ...meta };
        else {
          const body = required(node, 'body');
          if (body.text.trim() || body.children.length !== 1) fail('definition requires one expression body');
          const bodyNode = body.children[0];
          if (bodyNode === undefined) return fail('missing definition body');
          const recursive = one(node, 'recursive', false);
          if (recursive !== undefined && leaf(recursive) !== '') fail('invalid recursive marker');
          result = { kind, uid: id, name, arity, parameters: params, recursive: recursive !== undefined, body: expression(bodyNode), ...meta };
        }
        break;
      }
      case 'module': {
        if (node.text.trim()) fail('unexpected module text');
        const members: SanySymbolRef[] = [];
        const others: SanyUnsupportedExpression[] = [];
        for (const child of node.children) {
          if (metadataNames.includes(child.name) || child.name === 'uniquename') continue;
          if (child.name.endsWith('Ref')) members.push(reference(child)); else others.push(unsupported(child));
        }
        if (new Set(members.map(member => member.uid)).size !== members.length) fail('duplicate module member');
        const namedMembers = members.filter(member => member.kind !== 'unsupported');
        if (new Set(namedMembers.map(member => member.name)).size !== namedMembers.length) fail('duplicate module member name');
        result = { kind, uid: id, name, members, unsupported: others, ...meta };
        break;
      }
      case 'unsupported': result = { kind, uid: id, name, nodeType: node.name, raw: node, ...meta }; break;
      default: { const exhaustive: never = kind; return exhaustive; }
    }
    symbols.set(id, result);
    return result;
  };
  for (const id of rawSymbols.keys()) parseSymbol(id);
  const modules = root.children.filter(child => child.name === 'ModuleNodeRef').map(node => {
    const symbol = parseSymbol(referenceId(node));
    if (symbol.kind !== 'module') return fail('external module reference is not a module');
    return symbol;
  });
  if (!modules.length || new Set(modules.map(module => module.uid)).size !== modules.length || new Set(modules.map(module => module.name)).size !== modules.length) fail('missing or duplicate external module');
  if ([...symbols.values()].filter(symbol => symbol.kind === 'module').length !== modules.length) fail('unlisted module in symbol context');
  const selected = modules.filter(module => module.name === rootName);
  const rootModule = selected[0];
  if (selected.length !== 1 || rootModule === undefined) return fail('root module does not resolve uniquely');
  const variables: SanyDeclaration[] = [];
  const constants: SanyDeclaration[] = [];
  const definitions: SanyDefinition[] = [];
  for (const member of rootModule.members) {
    const symbol = symbols.get(member.uid);
    if (symbol === undefined) return fail('missing root member');
    if (symbol.kind === 'variable') variables.push(symbol);
    if (symbol.kind === 'constant') constants.push(symbol);
    if (symbol.kind === 'definition') definitions.push(symbol);
  }
  return { root: rootName, modules, symbols, variables, constants, definitions };
}
