#!/usr/bin/env node
import { buildProject, compileProject, writeGenerated } from './compiler.js';
import { generateVisualization, loadAutomaton } from './visualize.js';
import { serve } from './mcp.js';
import { verifySymbolicErasureFiles } from './symbolic-refinement.js';

const help = `sgd 0.1.0

  build     --project FILE --jar FILE --out DIR [--check]
  model     --project FILE --jar FILE --out DIR
  compile   --project FILE --dot FILE --out DIR [--check]
  inspect   --ir FILE
  visualize --ir FILE [--ir FILE ...] --out DIR
  refine    --abstract FILE --concrete FILE --binding FILE --out DIR [--check]
  mcp

build runs TLC before generation. Project v2 generates finite state authorities.
Project v3 symbolic-owned compiles supported SANY equality/copy actions with data input.
Project v4 adds two or three inputs from disjoint nominal domains.
refine checks state, enabled-input decisions, and observable action erasure.
compile imports DOT for v1 diagnostics only; it cannot generate executable authority.
visualize renders offline Pele SVG and HTML from the same automata.
`;

async function main(args: string[]): Promise<void> {
  const command = args.shift();
  if (!command || command === '--help' || command === '-h') { process.stdout.write(help); return; }
  if (command === '--version') { process.stdout.write('0.1.0\n'); return; }
  if (command === 'mcp') {
    if (args.length) throw new Error('mcp accepts no arguments');
    await serve(); return;
  }
  const flags = new Map<string, string[]>();
  let check = false;
  while (args.length) {
    const key = args.shift();
    if (key === '--check') { check = true; continue; }
    if (!key?.startsWith('--')) throw new Error(`Unexpected argument ${key}`);
    const value = args.shift();
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    flags.set(key, [...(flags.get(key) ?? []), value]);
  }
  const allowed: Record<string, string[]> = {
    build: ['--project', '--jar', '--out'], model: ['--project', '--jar', '--out'],
    compile: ['--project', '--dot', '--out'], inspect: ['--ir'], visualize: ['--ir', '--out'],
    refine: ['--abstract', '--concrete', '--binding', '--out'],
  };
  const keys = allowed[command];
  if (!keys) throw new Error(`Unknown command ${command}`);
  for (const key of flags.keys()) if (!keys.includes(key)) throw new Error(`Unknown option ${key}`);
  if (check && !['build', 'compile', 'refine'].includes(command)) throw new Error('--check is valid only for build, compile, and refine');
  function one(key: string): string {
    const values = flags.get(key);
    const value = values?.[0];
    if (!value || values.length !== 1) throw new Error(`Supply ${key} exactly once`);
    return value;
  }
  let result: unknown;
  switch (command) {
    case 'model': case 'build':
      result = await buildProject({ project: one('--project'), jar: one('--jar'), out: one('--out'), check, modelOnly: command === 'model' }); break;
    case 'compile':
      result = await compileProject({ project: one('--project'), dot: one('--dot'), out: one('--out'), check }); break;
    case 'inspect': result = await loadAutomaton(one('--ir')); break;
    case 'refine': {
      result = await verifySymbolicErasureFiles({ abstract: one('--abstract'), concrete: one('--concrete'), binding: one('--binding') });
      await writeGenerated({ out: one('--out'), files: [{ path: 'refinement.json', content: JSON.stringify(result, null, 2) + '\n' }], check });
      break;
    }
    case 'visualize': {
      const paths = flags.get('--ir');
      if (!paths?.length) throw new Error('Supply --ir at least once');
      const models = await Promise.all(paths.map(loadAutomaton));
      const files = generateVisualization(models);
      await writeGenerated({ out: one('--out'), files });
      result = { out: one('--out'), files: files.map(file => file.path) }; break;
    }
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + '\n');
  process.exitCode = 2;
});
