import { z } from 'zod';
import { RowBindingPlanSchema, RowBindingSchema } from './row-binding-types.js';
import { recordSchema } from './schema-record.js';

const Identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).refine(value => value !== '__proto__');
const CrateName = Identifier.refine(value => !['std', 'core', 'alloc'].includes(value));
const RustPath = z.string().regex(/^crate(?:::[A-Za-z_][A-Za-z0-9_]*)*$/).refine(value => !value.split('::').includes('__proto__'));
const ModulePath = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*$/).refine(value => !value.split('::').includes('__proto__'));
const NonemptyText = z.string().min(1).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const HexDigest = z.string().regex(/^[a-f0-9]{64}$/);
const Registry = z.literal('registry+https://github.com/rust-lang/crates.io-index');
const Scalar = z.enum(['string', 'i64', 'u32']);
const Position = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const RelativePath = z.string().min(1).refine(value => {
  if (/[\\:\x00-\x1f\x7f]/.test(value) || value.startsWith('/')) return false;
  return value.split('/').every(part => part !== '' && part !== '.' && part !== '..' &&
    !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}, 'Expected a portable ordinary relative path');

const PackageId = NonemptyText.refine(value => {
  const marker = value.lastIndexOf('#');
  if (marker < 0 || !/^[A-Za-z0-9][A-Za-z0-9_-]*@[^\s#]+$/.test(value.slice(marker + 1))) return false;
  const origin = value.slice(0, marker);
  if (origin === 'registry+https://github.com/rust-lang/crates.io-index') return true;
  if (!origin.startsWith('path+file:')) return false;
  try {
    const url = new URL(origin.slice('path+'.length));
    return url.protocol === 'file:' && url.href === origin.slice('path+'.length) && !url.search && !url.hash;
  } catch { return false; }
}, 'Expected a canonical local or default-registry Cargo package identity');

const SourceIdentity = z.object({ path: RelativePath, sha256: HexDigest }).strict();
const ResolvedItem = z.object({
  crateId: CrateName, module: ModulePath,
  item: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)?$/).refine(value => !value.split('::').includes('__proto__')),
  file: RelativePath, line: Position, column: Position,
}).strict().superRefine((item, context) => {
  if (item.module.split('::')[0] !== item.crateId) context.addIssue({ code: 'custom', message: 'Resolved module must begin with its canonical crate identity' });
});
const MethodIdentity = ResolvedItem.refine(item => item.item.split('::').length === 2, 'A constructor identity must name Type::method');
const TypeIdentity = ResolvedItem.refine(item => !item.item.includes('::'), 'A type or function identity must name one item');

const IdentityRecipe = z.object({ kind: z.literal('identity'), scalar: Scalar }).strict();
const SymbolRecipe = z.object({ kind: z.literal('ascii-symbol'), constructor: MethodIdentity, errorType: TypeIdentity }).strict();
function recipes<Inner extends z.ZodType>(inner: Inner) {
  return z.discriminatedUnion('kind', [
    IdentityRecipe, SymbolRecipe,
    z.object({ kind: z.literal('tuple-wrap'), constructor: MethodIdentity, inner }).strict(),
  ]);
}
const RecipeLevel1 = recipes(IdentityRecipe);
const RecipeLevel2 = recipes(RecipeLevel1);
const RecipeLevel3 = recipes(RecipeLevel2);
const DecodeRecipe = recipes(RecipeLevel3);
type DecodeRecipe = z.infer<typeof DecodeRecipe>;

const LocalTarget = z.object({
  packageId: PackageId, name: NonemptyText, kind: z.enum(['lib', 'bin', 'test', 'example', 'bench']),
  crateName: CrateName, source: RelativePath, edition: z.enum(['2021', '2024']),
}).strict();
const PackageBase = {
  packageId: PackageId, name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/), version: NonemptyText,
  enabledFeatures: z.array(NonemptyText), declaredFeatures: recordSchema(z.string().min(1), z.array(NonemptyText)),
  targetKinds: z.array(NonemptyText).min(1),
};
const Package = z.discriminatedUnion('origin', [
  z.object({ ...PackageBase, origin: z.literal('local'), source: z.null(), checksum: z.null() }).strict(),
  z.object({ ...PackageBase, origin: z.literal('registry'), source: Registry, checksum: z.string().regex(/^[a-fA-F0-9]{64}$/) }).strict(),
]);
const Dependency = z.object({
  packageId: PackageId, alias: Identifier, dependencyPackageId: PackageId,
  kind: z.enum(['dev', 'build']).nullable(), targetExpression: NonemptyText.nullable(),
}).strict();
const Discovery = z.object({
  scope: z.literal('discovered-targets-only'), view: z.literal('cargo-metadata-unfiltered-default-features'),
  localTargets: z.array(LocalTarget).min(1).max(512), packages: z.array(Package).min(1).max(2048), dependencies: z.array(Dependency),
  trustedBoundary: z.tuple([
    z.literal('trusted Cargo and Rust toolchain; standard library and platform'),
    z.literal('environment and above-root/global Cargo configuration'),
    z.literal('default-registry index and cache integrity; checksums are lock identities only'),
    z.literal('foreign build scripts and procedural macros are inventoried, not executed or analyzed'),
    z.literal('foreign runtime libraries; discovery does not admit their calls or values to codec recipes'),
    z.literal('metadata features are an unfiltered inventory union, not resolver-v2 compiled host/target unit features'),
  ]),
}).strict();

export const CodecRecipeBindingSchema = z.object({
  version: z.literal(1), profile: z.literal('rust-codec-recipe-v1'),
  source: z.object({
    manifest: RelativePath, module: RustPath, fact: RowBindingSchema.shape.source.shape.facts.element,
  }).strict(),
  codec: z.object({ module: RustPath, encode: Identifier, decode: Identifier, wire: RustPath, descriptor: Identifier }).strict(),
}).strict().superRefine((binding, context) => {
  if (new Set([binding.codec.encode, binding.codec.decode, binding.codec.descriptor]).size !== 3) context.addIssue({ code: 'custom', message: 'Codec entrypoints and descriptor must be distinct' });
  if (new Set(binding.source.fact.metadata).size !== binding.source.fact.metadata.length) context.addIssue({ code: 'custom', message: 'Explicit metadata fields must be distinct' });
  if (!RustPath.safeParse(binding.source.fact.rustPath).success) context.addIssue({ code: 'custom', message: 'Fact path must use supported crate:: identifiers' });
});
export type CodecRecipeBinding = z.infer<typeof CodecRecipeBindingSchema>;

const ColumnRecipe = z.object({ column: Identifier, field: Identifier, scalar: Scalar, nullable: z.literal(false), decode: DecodeRecipe }).strict();
const Report = z.object({
  version: z.literal(1), profile: z.literal('rust-codec-recipe-v1'), scope: z.literal('selected-codec-and-native-constructor-closure'), storageAuthority: z.literal(false),
  crateName: CrateName,
  library: z.object({ packageId: PackageId, target: NonemptyText, crateName: CrateName, source: RelativePath }).strict(),
  row: RowBindingPlanSchema.shape.facts.element,
  wire: TypeIdentity,
  entrypoints: z.object({ encode: TypeIdentity, decode: TypeIdentity }).strict(),
  columns: z.array(ColumnRecipe).min(1).max(64), sources: z.array(SourceIdentity).min(1).max(512), binding: SourceIdentity,
  absentInputs: z.array(RelativePath), discovery: Discovery,
}).strict();

function representation(recipe: DecodeRecipe): { scalar: z.infer<typeof Scalar>; depth: number; identities: z.infer<typeof ResolvedItem>[] } {
  switch (recipe.kind) {
    case 'identity': return { scalar: recipe.scalar, depth: 0, identities: [] };
    case 'ascii-symbol': return { scalar: 'string', depth: 1, identities: [recipe.constructor, recipe.errorType] };
    case 'tuple-wrap': {
      const inner = representation(recipe.inner);
      return { scalar: inner.scalar, depth: inner.depth + 1, identities: [recipe.constructor, ...inner.identities] };
    }
  }
}

export const CodecRecipeReportSchema = Report.superRefine((report, context) => {
  const issue = (message: string): void => context.addIssue({ code: 'custom', message });
  const unique = (values: string[], label: string): void => { if (new Set(values).size !== values.length) issue(`${label} must be unique`); };
  unique(report.sources.map(source => source.path), 'Captured source paths');
  unique(report.absentInputs, 'Absent input paths');
  unique(report.columns.map(column => column.column), 'Physical columns');
  unique(report.columns.map(column => column.field), 'Native column fields');
  const sources = new Set(report.sources.map(source => source.path));
  if (report.absentInputs.some(path => sources.has(path))) issue('A captured input cannot also be absent');
  if (!sources.has('Cargo.toml') || !sources.has('Cargo.lock')) issue('Codec source evidence requires the workspace manifest and lock');
  const rowPlan = RowBindingPlanSchema.safeParse({ version: 1, profile: 'rust-whole-row-v1', crateName: report.crateName, sources: report.sources, facts: [report.row] });
  if (!rowPlan.success) issue(`Native row evidence is invalid: ${rowPlan.error.issues.slice(0, 4).map(error => error.message).join('; ')}`);
  if (report.columns.length !== report.row.fields.length || report.row.fields.some(field => !report.columns.some(column => column.field === field.name))) issue('Columns must bijectively preserve every native field');
  for (const column of report.columns) {
    const field = report.row.fields.find(field => field.name === column.field);
    const decoded = representation(column.decode);
    if (!field || field.codec.kind !== column.scalar || decoded.scalar !== column.scalar) issue(`Column ${column.column} must preserve its exact native scalar`);
    if (decoded.depth > 4 || (field && decoded.depth !== field.codec.getters.length)) issue(`Column ${column.column} constructor and getter chains must invert the same bounded representation`);
    const constructors = decoded.identities.filter(identity => identity.item.includes('::'));
    unique(constructors.map(identity => `${identity.module}::${identity.item.split('::')[0]}`), `Column ${column.column} constructor types`);
  }
  const packages = new Map(report.discovery.packages.map(package_ => [package_.packageId, package_]));
  unique(report.discovery.packages.map(package_ => package_.packageId), 'Discovered package identities');
  for (const package_ of report.discovery.packages) {
    if (!package_.packageId.endsWith(`#${package_.name}@${package_.version}`) || (package_.origin === 'local' ? !package_.packageId.startsWith('path+file:') : !package_.packageId.startsWith(`${package_.source}#`))) issue('Cargo package identity must match its origin, name, and version');
    unique(package_.enabledFeatures, 'Enabled package features');
    unique(package_.targetKinds, 'Package target kinds');
    if (package_.origin === 'local' && (package_.enabledFeatures.length !== 0 || Object.keys(package_.declaredFeatures).length !== 0)) issue('Local codec packages cannot claim feature admission');
  }
  unique(report.discovery.localTargets.map(target => JSON.stringify([target.packageId, target.kind, target.name])), 'Local target identities');
  for (const target of report.discovery.localTargets) {
    const package_ = packages.get(target.packageId);
    if (!package_ || package_.origin !== 'local' || !package_.targetKinds.includes(target.kind) || target.crateName !== target.name.replaceAll('-', '_') || !sources.has(target.source)) issue('Local target must resolve to its captured local package, source, and crate name');
  }
  const library = report.discovery.localTargets.find(target => target.kind === 'lib' && target.packageId === report.library.packageId && target.name === report.library.target && target.source === report.library.source && target.crateName === report.library.crateName);
  if (!library || report.crateName !== report.library.crateName) issue('Selected library must match one discovered local Cargo target');
  for (const dependency of report.discovery.dependencies) {
    const owner = packages.get(dependency.packageId);
    if (!owner || !packages.has(dependency.dependencyPackageId)) issue('Every dependency must resolve to discovered package identities');
    if (owner?.origin === 'local' && (dependency.kind === 'build' || dependency.targetExpression !== null)) issue('Local codec dependencies cannot claim build or conditional admission');
  }
  unique(report.discovery.dependencies.map(dependency => JSON.stringify(dependency)), 'Resolved dependency views');
  const identities = [report.wire, report.entrypoints.encode, report.entrypoints.decode, ...report.columns.flatMap(column => representation(column.decode).identities)];
  for (const identity of identities) {
    if (!sources.has(identity.file) || !report.discovery.localTargets.some(target => target.kind === 'lib' && target.crateName === identity.crateId)) issue('Resolved native items must belong to captured sources and discovered local libraries');
  }
  if ([report.wire, report.entrypoints.encode, report.entrypoints.decode].some(identity => identity.crateId !== report.crateName)) issue('Wire and codec entrypoints must belong to the selected library');
  if (report.entrypoints.encode.module !== report.entrypoints.decode.module || report.entrypoints.encode.file !== report.entrypoints.decode.file || report.entrypoints.encode.item === report.entrypoints.decode.item) issue('Codec entrypoints must be distinct functions in the same selected source module');
});
export type CodecRecipeReport = z.infer<typeof CodecRecipeReportSchema>;
