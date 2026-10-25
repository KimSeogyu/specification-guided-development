import { finalize } from '../generated/typescript/operation.js';
for (const mode of ['ok', 'err']) {
  const payload = { rows: ['earlier-complete', 'technical-prefix'], execution: 'original execution error', ledger: 'terminal uncertain' };
  let calls = 0;
  const result = finalize(payload, evidence => {
    calls++;
    if (evidence !== payload) throw new Error('callback received a replacement payload');
    return mode === 'ok' ? { ok: true, value: 'reported' } : { ok: false, error: 'report write failed' };
  });
  const status = result.status();
  let observed: string;
  let observedValue: string;
  if (status.kind === 'refused') { observed = 'refused'; observedValue = 'disabled'; }
  else if (status.kind === 'completed' && status.observation.kind === 'returned') {
    const outcome = status.observation.outcome;
    observed = outcome.ok ? 'ok' : 'err';
    observedValue = outcome.ok ? outcome.value : outcome.error;
  } else throw new Error('unexpected generated result');
  const state = result.snapshot();
  const actual = result.payload();
  console.log(JSON.stringify({ mode, calls, payloadSame: actual === payload,
    rows: actual.rows, execution: actual.execution, ledger: actual.ledger,
    observed, observedValue, phase: state.values.phase.value,
    resident: state.values.resident.value, revision: state.revision }));
}
