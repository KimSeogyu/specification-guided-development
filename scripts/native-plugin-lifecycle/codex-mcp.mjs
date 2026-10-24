import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { lstat, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

const startupTimeout = 30_000;
const maxStatusPages = 10;
const textLimit = 64 * 1024;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function requireThat(condition, code, message, details) {
  if (condition) return;
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
}

async function ownedInput(app) {
  const dot = String.raw`digraph NativePluginTransport {
  0 [label="phase = \"Ready\"", style=filled];
  0 -> 0 [label="Wait"];
}
`;
  const expected = {
    version: 1,
    name: 'native-plugin-transport',
    stateVariable: 'phase',
    states: ['Ready'],
    initialStates: ['Ready'],
    transitions: [{ from: 'Ready', event: 'Wait', to: 'Ready' }],
    source: { dotSha256: createHash('sha256').update(dot).digest('hex'), stateCount: 1, edgeCount: 1 },
  };
  const dotFile = path.join(app, 'native-mcp-transport.dot');
  const irFile = path.join(app, 'native-mcp-transport.json');
  const missingFile = path.join(app, 'native-mcp-missing.json');
  await writeFile(dotFile, dot, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  await writeFile(irFile, `${JSON.stringify(expected, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  try {
    await lstat(missingFile);
    requireThat(false, 'CODEX_MCP_MISSING_FIXTURE', 'The negative inspect input must not exist.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { expected, dotFile, irFile, missingFile };
}

function textResult(result, expectError) {
  requireThat(object(result) && Array.isArray(result.content) && result.content.length === 1, 'CODEX_MCP_RESULT_SHAPE', 'The installed SGD inspect tool must return exactly one content block.');
  requireThat(expectError ? result.isError === true : result.isError !== true, 'CODEX_MCP_TOOL_OUTCOME', expectError ? 'The missing-file inspect call must return an application tool error.' : 'The valid inspect call must not return an application tool error.');
  const block = result.content[0];
  requireThat(object(block) && block.type === 'text' && typeof block.text === 'string' && block.text.length > 0 && Buffer.byteLength(block.text) <= textLimit && Object.keys(block).every(key => key === 'type' || key === 'text'), 'CODEX_MCP_RESULT_SHAPE', 'The installed SGD inspect tool returned unsupported content.');
  requireThat(result.structuredContent == null, 'CODEX_MCP_RESULT_SHAPE', 'This bounded inspect profile expects the SGD text response without structuredContent.');
  try { return JSON.parse(block.text); }
  catch { requireThat(false, 'CODEX_MCP_RESULT_JSON', 'The installed SGD inspect tool did not return JSON text.'); }
}

async function statusInventory(request, threadId, deadline) {
  const rows = [];
  const cursors = new Set();
  let cursor;
  for (let page = 0; page < maxStatusPages; page += 1) {
    const remaining = deadline - Date.now();
    requireThat(remaining > 0, 'CODEX_MCP_STARTUP_TIMEOUT', 'The same owned thread did not expose a connected SGD server within 30 seconds.');
    const result = await request('mcpServerStatus/list', { threadId, detail: 'toolsAndAuthOnly', limit: 100, ...(cursor === undefined ? {} : { cursor }) }, remaining);
    requireThat(object(result) && Array.isArray(result.data) && result.data.length <= 100 && result.data.every(object), 'CODEX_MCP_STATUS_SHAPE', 'The native MCP status page has an unsupported shape.');
    rows.push(...result.data);
    if (result.nextCursor == null) return { rows, pages: page + 1 };
    requireThat(typeof result.nextCursor === 'string' && result.nextCursor.length > 0 && result.nextCursor.length <= 4_096 && !cursors.has(result.nextCursor), 'CODEX_MCP_STATUS_CURSOR', 'The native MCP status cursor must be a new bounded nonempty string.');
    cursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  requireThat(false, 'CODEX_MCP_STATUS_PAGE_LIMIT', 'The native MCP inventory exceeded ten status pages.');
}

async function connectedServer(request, threadId, pluginId) {
  const deadline = Date.now() + startupTimeout;
  const observations = [];
  for (;;) {
    const { rows, pages } = await statusInventory(request, threadId, deadline);
    const matches = rows.filter(row => row.pluginId === pluginId);
    requireThat(matches.length === 1, 'CODEX_MCP_PLUGIN_ID', 'Exactly one native MCP server must match the verified installed SGD plugin identity.', { matchingServers: matches.length });
    const server = matches[0];
    requireThat(typeof server.name === 'string' && server.name.length > 0 && server.name.length <= 512, 'CODEX_MCP_SERVER_NAME', 'The installed SGD server must expose a usable native namespace.');
    requireThat(['unknown', 'unsupported', 'notLoggedIn', 'bearerToken', 'oAuth'].includes(server.authStatus), 'CODEX_MCP_AUTH_STATUS', 'The installed SGD server returned an unsupported authentication status.');
    observations.push({ runtimeStatus: server.runtimeStatus, authStatus: server.authStatus, pages });
    if (server.runtimeStatus === 'connected') return { server, observations };
    requireThat(server.runtimeStatus === 'notStarted' || server.runtimeStatus === 'starting', 'CODEX_MCP_CONNECTION', 'The installed SGD server did not reach a supported connected state. Authentication, failed, cancelled, disabled, and unavailable states are not accepted.', { runtimeStatus: server.runtimeStatus, authStatus: server.authStatus });
    requireThat(Date.now() < deadline, 'CODEX_MCP_STARTUP_TIMEOUT', 'The same owned thread did not expose a connected SGD server within 30 seconds.');
    await sleep(Math.min(500, deadline - Date.now()));
  }
}

/** Uses the fresh native app-server's installed-plugin wiring; it never starts a server directly. */
export async function verifyNativeMcp({ request, state, expectedVersion }) {
  const app = await realpath(state.app);
  const fixture = await ownedInput(app);
  const started = await request('thread/start', { cwd: app, runtimeWorkspaceRoots: [app], ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never' });
  const thread = started?.thread;
  requireThat(object(started) && object(thread) && typeof thread.id === 'string' && thread.id.length > 0 && thread.ephemeral === true, 'CODEX_MCP_THREAD', 'The native host must return one owned ephemeral thread.');
  requireThat(started.cwd === app && thread.cwd === app, 'CODEX_MCP_THREAD_CWD', 'Both native thread working directories must equal the owned canonical application path.');
  requireThat(started.approvalPolicy === 'never' && object(started.sandbox) && started.sandbox.type === 'readOnly' && (!Object.hasOwn(started.sandbox, 'networkAccess') || started.sandbox.networkAccess === false), 'CODEX_MCP_THREAD_POLICY', 'The effective native thread policy must be readOnly with approval never and no enabled thread network access.');
  const { server, observations } = await connectedServer(request, thread.id, state.pluginId);
  requireThat(server.httpOrigin == null && server.toolsError == null && object(server.tools), 'CODEX_MCP_TOOLS', 'The installed local stdio server must expose a tool object without a discovery error.');
  requireThat(object(server.serverInfo) && server.serverInfo.name === 'sgd' && server.serverInfo.version === expectedVersion, 'CODEX_MCP_EXECUTED_VERSION', 'The initialized installed SGD server must advertise the requested upgraded executable version.', { expectedVersion, serverInfo: server.serverInfo });
  const matches = Object.values(server.tools).filter(tool => object(tool) && tool.name === 'sgd_inspect');
  requireThat(matches.length === 1, 'CODEX_MCP_INSPECT_TOOL', 'The native installed server must expose exactly one sgd_inspect tool.');
  const tool = matches[0];
  requireThat(object(tool.annotations) && tool.annotations.readOnlyHint === true && object(tool.inputSchema) && tool.inputSchema.type === 'object' && object(tool.inputSchema.properties) && object(tool.inputSchema.properties.ir) && tool.inputSchema.properties.ir.type === 'string' && Array.isArray(tool.inputSchema.required) && tool.inputSchema.required.includes('ir'), 'CODEX_MCP_INSPECT_SCHEMA', 'The installed inspect tool must declare a required string ir input and readOnlyHint true.');
  const invoke = ir => request('mcpServer/tool/call', { threadId: thread.id, server: server.name, tool: tool.name, arguments: { ir } });
  const inspected = textResult(await invoke(fixture.irFile), false);
  requireThat(isDeepStrictEqual(inspected, fixture.expected), 'CODEX_MCP_INSPECT_VALUE', 'The native installed inspect tool must return the complete expected v1 automaton without changing or omitting fields.');
  const missing = textResult(await invoke(fixture.missingFile), true);
  requireThat(object(missing) && typeof missing.error === 'string' && missing.error.trim().length > 0, 'CODEX_MCP_MISSING_ERROR', 'The nonexistent owned input must produce a nonempty application error message.');
  return {
    scope: 'native-installed-plugin-mcp-transport-after-cached-upgrade',
    thread: { id: thread.id, ephemeral: true, cwd: app, approvalPolicy: started.approvalPolicy, sandbox: started.sandbox, ...(started.activePermissionProfile == null ? {} : { activePermissionProfile: started.activePermissionProfile }), modelSelection: 'native host defaults; no model or provider override', model: started.model, modelProvider: started.modelProvider },
    installedServer: { namespace: server.name, pluginId: server.pluginId, runtimeStatus: server.runtimeStatus, authStatus: server.authStatus, serverInfo: server.serverInfo, transport: 'installed plugin local stdio declaration' },
    startup: { timeoutMilliseconds: startupTimeout, sameThreadThroughout: true, observations, maximumPagesPerInventory: maxStatusPages },
    tool: { name: tool.name, readOnlyHint: tool.annotations.readOnlyHint, requiredStringInput: 'ir' },
    input: { scope: 'imported-v1-data-not-TLC-authority', dot: fixture.dotFile, ir: fixture.irFile, dotSha256: fixture.expected.source.dotSha256, stateCount: 1, edgeCount: 1, controlledTlcRun: false, executableAuthority: false },
    validInput: { completeExpectedValueMatched: true, model: fixture.expected },
    missingInput: { path: fixture.missingFile, applicationToolError: true, error: missing.error },
    modelInferenceRequested: false,
    manualMcpOverrides: false,
    limitations: ['This transport check does not verify TLA+ authoring, TLC execution, finite authority, or agent skill use.', 'Thread policy does not prove MCP subprocess filesystem isolation, account-free startup, or blocked startup egress.'],
  };
}
