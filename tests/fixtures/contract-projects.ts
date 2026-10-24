import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const contractDeclaration = String.raw`---- MODULE SystemContracts ----
SGDContracts == [version |-> 1, scope |-> "model-composition",
  contracts |-> {"Payload", "Envelope"},
  relations |-> <<[id |-> "PayloadErasure", kind |-> "enabled-input-erasure",
    upper |-> "Payload", lower |-> "Envelope",
    variables |-> [phase |-> "phase", stored |-> "stored", rejected |-> "rejected"],
    inputs |-> [v |-> "v"],
    actions |-> [Insert |-> "Insert", Same |-> "Same", Clash |-> "Clash"]]>>,
  native |-> <<>>]
====
`;

export async function contractProjectFixture() {
  const root = await mkdtemp(join(tmpdir(), 'sgd-contract-check-'));
  try {
    const baseline = join(root, 'baseline');
    const candidate = join(root, 'candidate');
    for (const directory of [baseline, candidate]) {
      await cp(resolve('examples/fact-merge'), join(directory, 'payload'), { recursive: true });
      await cp(resolve('examples/fact-envelope'), join(directory, 'envelope'), { recursive: true });
      await writeFile(join(directory, 'SystemContracts.tla'), contractDeclaration);
      await writeFile(join(directory, 'bindings.json'), JSON.stringify({ version: 1, bindings: {} }));
      await writeFile(join(directory, 'system.json'), JSON.stringify({ version: 1, profile: 'contract-system',
        root: { spec: 'SystemContracts.tla', operator: 'SGDContracts' },
        models: { Payload: { project: 'payload/project.json' }, Envelope: { project: 'envelope/project.json' } },
        bindings: 'bindings.json' }));
    }
    return { root, baseline, candidate, args: { baseline: join(baseline, 'system.json'), project: join(candidate, 'system.json') } };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}
