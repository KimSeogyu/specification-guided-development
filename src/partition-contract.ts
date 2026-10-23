import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { sha256 } from './dot.js';
import { runControlledTlc } from './finite-tlc.js';
import { PartitionContractSchema, type PartitionContract } from './partition-types.js';
import type { SanyExpression, SanyModule } from './sany-xml.js';

const fail: (message: string) => never = message => { throw new Error(`TLC306: ${message}`); };

/** Literal metadata is normative input, not a proof about arbitrary collections. */
export function lowerPartitionContract(input: { semantic: SanyModule; module: string; operator: string }): PartitionContract {
  const module = input.semantic.modules.find(candidate => candidate.name === input.module);
  const definition = input.semantic.definitions.find(candidate => candidate.name === input.operator && candidate.source?.module === input.module);
  if (!module || module.unsupported.length || module.members.length !== 1 || !definition || module.members[0]?.uid !== definition.uid ||
    definition.arity !== 0 || definition.recursive || definition.level !== 0) return fail('family metadata requires one zero-argument literal definition and no imports, declarations, assumptions, or helper definitions');
  const application = (expression: SanyExpression, name: string): readonly SanyExpression[] => {
    if (expression.kind !== 'apply' || expression.operator.kind !== 'builtin' || expression.operator.name !== name ||
      input.semantic.symbols.get(expression.operator.uid)?.kind !== 'builtin' || expression.level !== 0 || expression.bounded.length || expression.unbounded.length) return fail(`family metadata permits only literal ${name} constructors here`);
    return expression.arguments;
  };
  const text = (expression: SanyExpression | undefined): string => {
    if (expression?.kind !== 'literal' || expression.level !== 0 || expression.value.kind !== 'string') return fail('family metadata requires literal strings');
    return expression.value.value;
  };
  const record = (expression: SanyExpression): Map<string, SanyExpression> => {
    const result = new Map<string, SanyExpression>();
    for (const pair of application(expression, '$RcdConstructor')) {
      const args = application(pair, '$Pair');
      const name = text(args[0]); const value = args[1];
      if (args.length !== 2 || !value || result.has(name)) return fail('family metadata record members must be unique literal pairs');
      result.set(name, value);
    }
    return result;
  };
  const members = (value: Map<string, SanyExpression>, expected: string[]): void => {
    if (value.size !== expected.length || expected.some(name => !value.has(name))) return fail(`family metadata requires exactly ${expected.join(', ')}`);
  };
  const root = record(definition.body);
  members(root, ['version', 'calendar', 'families']);
  const version = root.get('version'); const familyExpression = root.get('families');
  if (version?.kind !== 'literal' || version.value.kind !== 'integer' || version.value.value !== '1' || !familyExpression) return fail('unsupported family metadata version');
  const families = [...record(familyExpression)].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([name, expression]) => {
    const family = record(expression);
    members(family, ['key', 'symbol', 'time', 'datasets']);
    const key = family.get('key'); const datasets = family.get('datasets');
    if (!key || !datasets) return fail('family metadata is incomplete');
    return { name, key: application(key, '$Tuple').map(text), symbol: text(family.get('symbol')), time: text(family.get('time')),
      datasets: application(datasets, '$SetEnumerate').map(text).sort() };
  });
  const parsed = PartitionContractSchema.safeParse({ version: 1, calendar: text(root.get('calendar')), families });
  if (!parsed.success) return fail(`unsupported family contract: ${parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  return parsed.data;
}

export async function readPartitionContract(input: { spec: string; operator: string; jar: string }) {
  const spec = resolve(input.spec);
  const name = basename(spec, '.tla');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || basename(spec) !== `${name}.tla`) return fail('family metadata must use an identifier .tla filename');
  const original = async (): Promise<Buffer> => {
    if (!(await lstat(spec)).isFile()) return fail('family metadata must be a regular original file');
    return readFile(spec);
  };
  const bytes = await original();
  const directory = await mkdtemp(join(tmpdir(), 'sgd-partition-contract-'));
  const wrapper = name === 'SgdPartitionMetadata' ? 'SgdPartitionMetadataWrapper' : 'SgdPartitionMetadata';
  try {
    await writeFile(join(directory, `${name}.tla`), bytes, { mode: 0o400 });
    await writeFile(join(directory, `${wrapper}.tla`), `---- MODULE ${wrapper} ----\nEXTENDS ${name}\nVARIABLE sgdMetadataClock\nSgdMetadataInit == sgdMetadataClock = FALSE\nSgdMetadataNext == sgdMetadataClock' = ~sgdMetadataClock\nSgdMetadataSpec == SgdMetadataInit /\\ [][SgdMetadataNext]_sgdMetadataClock\n====\n`);
    const config = join(directory, `${wrapper}.cfg`);
    await writeFile(config, 'SPECIFICATION SgdMetadataSpec\nCHECK_DEADLOCK FALSE\n');
    const run = await runControlledTlc({ spec: join(directory, `${wrapper}.tla`), config, jar: input.jar }, 'finite-owned-v1');
    if (run.evidence.standardModules.length || run.evidence.moduleClosure.length !== 2) return fail('family metadata imports are unsupported');
    const contract = lowerPartitionContract({ semantic: run.semantic, module: name, operator: input.operator });
    const recheck = async (): Promise<void> => {
      if (!bytes.equals(await original())) return fail('family metadata changed during verification');
    };
    await recheck();
    return { contract, xml: run.xml, log: run.log, evidence: run.evidence, source: { path: spec, sha256: sha256(bytes) }, recheck };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
