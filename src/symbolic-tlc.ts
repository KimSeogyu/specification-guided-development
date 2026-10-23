import { createHash } from 'node:crypto';
import { runControlledTlc, type ControlledTlcEvidence, type ControlledTlcInput, type ParsedSymbolicConfig } from './finite-tlc.js';

export { parseSymbolicConfig, type ParsedSymbolicConfig, type TlcConfigScalar, type TlcConfigValue } from './finite-tlc.js';

export interface SymbolicTlcEvidence extends ControlledTlcEvidence {
  kind: 'tlc-symbolic-completed';
  profile: 'symbolic-owned-v1';
  extractor: 'SANY-XML-v1';
  xmlSha256: string;
}

/** TLC verifies the configured finite instance. XML supports separate symbolic lowering; it is not an unbounded invariant proof. */
export async function runSymbolicTlc(input: ControlledTlcInput): Promise<{
  dot: string; xml: string; log: string; config: ParsedSymbolicConfig; evidence: SymbolicTlcEvidence;
}> {
  const result = await runControlledTlc(input, 'symbolic-owned-v1');
  return { dot: result.dot, xml: result.xml, log: result.log, config: result.config, evidence: {
    kind: 'tlc-symbolic-completed', profile: 'symbolic-owned-v1', extractor: 'SANY-XML-v1',
    xmlSha256: createHash('sha256').update(result.xml).digest('hex'), ...result.evidence,
  } };
}
