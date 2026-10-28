import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { buildProjectReport, compileProject, writeGenerated } from './compiler.js';
import { generateVisualization, loadAutomaton } from './visualize.js';
import { verifySymbolicErasureFiles } from './symbolic-refinement.js';
import { version } from './version.js';
import { StaleOutputError } from './output-check.js';
import { TlcFailureError } from './tlc-failure.js';
import { checkUpdateStatus, UpdateStatusInputSchema } from './update-status.js';
import { isAbsolute } from 'node:path';
import { buildContractComparison } from './contract-check.js';
import { contractDiagnostic } from './contract-diagnostics.js';

export function createServer(): McpServer {
  const server = new McpServer({ name: 'sgd', version });
  const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });
  const guarded = async (work: () => Promise<unknown>) => {
    try { return text(await work()); }
    catch (error) {
      const diagnostic = error instanceof StaleOutputError || error instanceof TlcFailureError ? error.diagnostic : contractDiagnostic(error);
      return { ...text({ error: error instanceof Error ? error.message : String(error),
        ...(diagnostic === undefined ? {} : { diagnostic }) }), isError: true };
    }
  };
  const paths = { project: z.string().describe('Absolute path to a project JSON file.'), jar: z.string().describe('Absolute path to tla2tools.jar.'), out: z.string().describe('Absolute output directory.') };
  const check = z.boolean().default(false).describe('Check stable generated artifacts and inventory without updating managed files. Incomplete output transactions are reported without repair.');
  const detail = z.enum(['summary', 'full']).default('summary').describe('Return the build summary by default, or the complete automaton IR with full. Inspect also returns the complete IR.');
  const absolutePath = z.string().refine(isAbsolute, 'Supply an absolute path.');
  server.registerTool('sgd_check_contracts', {
    description: 'Compare controlled v3/v4 models with a supplied baseline. Check properties, behavior, and composition; reject unsupported required native obligations. This does not establish acceptance, a CI gate, or native application authority. Check mode retains published logs.',
    inputSchema: z.object({
      project: absolutePath.describe('Absolute path to the candidate contract-system project JSON.'),
      baseline: absolutePath.describe('Absolute path to the supplied baseline contract-system project JSON.'),
      jar: absolutePath.describe('Absolute path to the pinned tla2tools.jar.'),
      out: absolutePath.describe('Absolute path to a separate managed evidence directory.'), check,
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, args => guarded(() => buildContractComparison(args)));
  server.registerTool('sgd_update_status', {
    description: 'Compare the running SGD runtime with stable or alpha release metadata. Report archive metadata without downloading it. This does not inspect installed plugins or the desktop app.',
    inputSchema: UpdateStatusInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, args => guarded(() => checkUpdateStatus(args)));
  server.registerTool('sgd_model', {
    description: 'Run TLC and export the finite automaton. Return a summary, or the complete IR with detail full. Execute only authorized models.',
    inputSchema: { ...paths, detail }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, ({ detail, ...args }) => guarded(async () => {
    const report = await buildProjectReport({ ...args, modelOnly: true });
    return detail === 'full' ? report.automaton : report.summary;
  }));
  server.registerTool('sgd_build', {
    description: 'Run TLC and generate code or checks. V2 domains support TypeScript and Rust; Rust generation requires the pinned Rust formatter. V3 and V4 compile supported equality/copy inputs to TypeScript. V1 generates diagnostics. The default response summarizes graph scope and checks; detail full includes the complete IR.',
    inputSchema: { ...paths, lean: absolutePath.optional().describe('Lean 4.35.0 executable. Required for v2 domain generation.'), check, detail }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, ({ detail, lean, ...args }) => guarded(async () => {
    const report = await buildProjectReport({ ...args, ...(lean === undefined ? {} : { lean }) });
    return detail === 'full' ? report.automaton : report.summary;
  }));
  server.registerTool('sgd_compile', {
    description: 'Compile action-labeled DOT into v1 language-specific diagnostics. Imported DOT is unverified and cannot generate executable authority.',
    inputSchema: { project: paths.project, dot: z.string().describe('Absolute path to action-labeled TLC DOT.'), out: paths.out, check },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, args => guarded(() => compileProject(args)));
  server.registerTool('sgd_inspect', {
    description: 'Read the typed automaton and finite scope. Exact finite IR retains all supported scalar variables; v1 projected IR contains one selected state variable.',
    inputSchema: { ir: z.string().describe('Absolute path to automaton.json.') }, annotations: { readOnlyHint: true },
  }, args => guarded(() => loadAutomaton(args.ir)));
  server.registerTool('sgd_visualize', {
    description: 'Render automata and explicit model containment with Pele. Write offline SVG, HTML, and Mermaid files.',
    inputSchema: { ir: z.array(z.string()).min(1).describe('Absolute paths to automaton JSON files.'), out: paths.out },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, args => guarded(async () => {
    const models = await Promise.all(args.ir.map(loadAutomaton));
    const files = generateVisualization(models);
    await writeGenerated({ out: args.out, files });
    return { out: args.out, files: files.map(file => file.path) };
  }));
  server.registerTool('sgd_refine', {
    description: 'Check a symbolic model erasure under the supported equality/copy grammar. Compare the full projected state, every enabled or disabled input class, and action classification. This checks supplied IR; it does not attest application bindings or original TLC provenance.',
    inputSchema: {
      abstract: z.string().describe('Absolute path to the abstract symbolic-model.json.'),
      concrete: z.string().describe('Absolute path to the concrete symbolic-model.json.'),
      binding: z.string().describe('Absolute path to an erasure binding JSON with variable, input, and action mappings.'),
    }, annotations: { readOnlyHint: true },
  }, args => guarded(() => verifySymbolicErasureFiles(args)));
  return server;
}

export async function serve(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
}
