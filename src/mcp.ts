import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { buildProject, compileProject, writeGenerated } from './compiler.js';
import { generateVisualization, loadAutomaton } from './visualize.js';

export function createServer(): McpServer {
  const server = new McpServer({ name: 'sgd', version: '0.1.0' });
  const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });
  const guarded = async (work: () => Promise<unknown>) => {
    try { return text(await work()); }
    catch (error) { return { ...text({ error: error instanceof Error ? error.message : String(error) }), isError: true }; }
  };
  const paths = { project: z.string().describe('Absolute path to a project JSON file.'), jar: z.string().describe('Absolute path to tla2tools.jar.'), out: z.string().describe('Absolute output directory.') };
  server.registerTool('sgd_model', {
    description: 'Run TLC to completion and export the finite automaton. Execute only models the user authorized.',
    inputSchema: paths, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, args => guarded(() => buildProject({ ...args, modelOnly: true })));
  server.registerTool('sgd_build', {
    description: 'Run TLC and generate TypeScript and Rust linters after the finite model check succeeds.',
    inputSchema: paths, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, args => guarded(() => buildProject(args)));
  server.registerTool('sgd_compile', {
    description: 'Compile action-labeled DOT into language-specific linters. A DOT import remains unverified.',
    inputSchema: { project: paths.project, dot: z.string().describe('Absolute path to action-labeled TLC DOT.'), out: paths.out },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, args => guarded(() => compileProject(args)));
  server.registerTool('sgd_inspect', {
    description: 'Read projected states, actions, edges, and finite graph scope from an automaton JSON file.',
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
  return server;
}

export async function serve(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
}
