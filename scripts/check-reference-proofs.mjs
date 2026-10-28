import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const lean = process.env.SGD_LEAN_BINARY;
if (!lean) throw new Error('Set SGD_LEAN_BINARY to Lean 4.35.0');
const root = fileURLToPath(new URL('../', import.meta.url));
const modules = ['Method', 'WholeProgram', 'DevelopmentRefinement', 'AdmittedDevelopment',
  'BoundaryCounterexamples', 'CompilerPipeline', 'SemanticConstraints', 'CompilerLintBridge',
  'GraphLintBridge', 'ModelValidation', 'StructuralLint', 'LanguageProfiles',
  'FiniteConfigurations', 'ProfileComposition', 'LintedDevelopment', 'CertifiedPipeline',
  'RustProfile', 'CheckedTraces', 'GraphDevelopment', 'GraphCheckedTraces',
  'MixedProfiles', 'MixedCheckedTraces', 'MixedGraphDevelopment'];
const directory = await mkdtemp(join(tmpdir(), 'sgd-reference-proofs-'));
let cleanupSafe = true;
try {
  const output = join(directory, 'modules'); await mkdir(output);
  const env = { ...process.env, LEAN_PATH: output };
  delete env.LEAN_SYSROOT;
  const version = spawnSync(lean, ['--version'], { encoding: 'utf8', env, timeout: 10000 });
  if (version.error) throw version.error;
  if (version.status !== 0 || !version.stdout.startsWith('Lean (version 4.35.0,')) throw new Error('Lean 4.35.0 is required');
  for (const name of modules) {
    const checked = spawnSync(lean, ['-o', join(output, `${name}.olean`), join(root, 'proofs/reference', `${name}.lean`)],
      { encoding: 'utf8', env, timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
    if (checked.error || checked.signal) cleanupSafe = false;
    if (checked.error) throw checked.error;
    const text = checked.stdout + checked.stderr;
    if (checked.status !== 0 || /warning:|error:|sorryAx|ofReduceBool/.test(text)) throw new Error(`${name}: ${text}`);
    for (const match of text.matchAll(/depends on axioms:\s*\[([^\]]*)\]/g)) {
      for (const axiom of match[1].split(',').map(value => value.trim())) {
        if (!['propext', 'Quot.sound', 'Classical.choice'].includes(axiom)) throw new Error(`${name}: unexpected axiom ${axiom}`);
      }
    }
    console.log(`${name}: checked`);
  }
} finally {
  if (cleanupSafe) await rm(directory, { recursive: true, force: true });
  else console.error(`Preserved ${directory}: proof process completion is uncertain`);
}
