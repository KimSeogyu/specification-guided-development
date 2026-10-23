import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = path.dirname(fileURLToPath(import.meta.url));
const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  assert(['--plugin', '--view', '--pele'].includes(process.argv[index]), 'Unknown inspection option');
  options.set(process.argv[index], process.argv[index + 1]);
}
const plugin = options.get('--plugin');
const view = options.get('--view');
const pele = options.get('--pele');
assert(plugin && path.isAbsolute(plugin) && pele && path.isAbsolute(pele));
const skill = path.join(plugin, 'skills/specification-guided-development');
const views = {
  skill: [path.join(skill, 'SKILL.md')],
  modeling: [path.join(skill, 'references/modeling.md')],
  partition: [path.join(skill, 'references/partition-fold.md')],
  application: ['src/facts.rs', 'src/lib.rs', 'src/tests.rs', 'ts-check.ts', 'models/fold.json', 'models/row.json', 'models/LedgerRow.tla', 'models/LedgerRow.cfg', 'models/PartitionControl.tla', 'models/PartitionControl.cfg', 'models/PartitionFamilies.tla'].map(file => path.join(app, file)),
  generated: [path.join(app, 'generated/row-binding-plan.json'), path.join(app, 'generated/typescript/README.md'), path.join(app, 'generated/rust/README.md'), path.join(pele, 'structure.mmd')],
};
assert(Object.hasOwn(views, view), 'Unknown inspection view');
for (const file of views[view]) console.log(`\nFILE ${file}\n${await readFile(file, 'utf8')}`);
if (view === 'generated') {
  for (const file of ['index.html', 'structure.svg', 'models.json']) {
    const source = await readFile(path.join(pele, file), 'utf8');
    console.log(`\nFILE ${path.join(pele, file)}\n${source.slice(0, 2500)}\nSOURCE CHECK ${JSON.stringify({ bytes: Buffer.byteLength(source), refusal: source.includes('CloseRefused'), provenance: source.includes('storedProvenance') && source.includes('rejectedProvenance') })}`);
  }
}
console.log(`SGD_HOST_INSPECT_OK ${view}`);
