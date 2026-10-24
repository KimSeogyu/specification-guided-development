import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

const limits = { sample: 48, body: 1024 * 1024, header: 16 * 1024, requests: 8, requestMs: 50_000 };
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const fail = code => Object.assign(new Error(code), { code });

function groupAlive(record) {
  if (record.stopped || !record.child.pid) return false;
  try { process.kill(-record.child.pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function stopGroup(record) {
  if (record.stopPromise) return record.stopPromise;
  record.stopPromise = (async () => {
    if (groupAlive(record)) {
      try { process.kill(-record.child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      for (let attempt = 0; attempt < 10 && groupAlive(record); attempt += 1) await sleep(50);
      if (groupAlive(record)) {
        try { process.kill(-record.child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        for (let attempt = 0; attempt < 20 && groupAlive(record); attempt += 1) await sleep(50);
      }
    }
    if (groupAlive(record)) throw fail('GIT_HTTP_CGI_GROUP_LIVE');
    record.stopped = true;
  })();
  return record.stopPromise;
}

async function drain(record, counters, processes) {
  await stopGroup(record);
  const observed = await Promise.race([record.closed.then(() => true), sleep(2_000).then(() => false)]);
  if (!observed || groupAlive(record)) throw fail('GIT_HTTP_CGI_NOT_DRAINED');
  if (!record.drained) { record.drained = true; counters.cgiStopped += 1; }
  processes.delete(record);
}

function cgiEnvironment(source, root, route, request, bodyLength, port) {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (/^(?:GIT_|HTTP_|REMOTE_|SERVER_|REDIRECT_)/i.test(key) || ['REQUEST_METHOD', 'CONTENT_TYPE', 'CONTENT_LENGTH', 'GATEWAY_INTERFACE', 'PATH_INFO', 'PATH_TRANSLATED', 'QUERY_STRING', 'AUTH_TYPE', 'DOCUMENT_ROOT'].includes(key)) delete env[key];
  }
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1',
    GATEWAY_INTERFACE: 'CGI/1.1', SERVER_PROTOCOL: 'HTTP/1.1', SERVER_NAME: '127.0.0.1', SERVER_PORT: String(port),
    REMOTE_ADDR: '127.0.0.1', REQUEST_METHOD: request.method, PATH_INFO: route.path,
    QUERY_STRING: route.query, CONTENT_LENGTH: String(bodyLength),
  });
  if (request.method === 'POST') env.CONTENT_TYPE = 'application/x-git-upload-pack-request';
  const protocol = request.headers['git-protocol'];
  if (protocol === 'version=1' || protocol === 'version=2') env.GIT_PROTOCOL = protocol;
  return env;
}

function routeFor(request) {
  if (request.method === 'GET' && request.url === '/marketplace.git/info/refs?service=git-upload-pack') return { path: '/marketplace.git/info/refs', query: 'service=git-upload-pack', mime: 'application/x-git-upload-pack-advertisement', upload: false };
  if (request.method === 'POST' && request.url === '/marketplace.git/git-upload-pack' && request.headers['content-type'] === 'application/x-git-upload-pack-request') return { path: '/marketplace.git/git-upload-pack', query: '', mime: 'application/x-git-upload-pack-result', upload: true };
  return null;
}

function bodyFor(request, signal) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let finished = false;
    const chunks = [];
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      request.removeListener('data', data);
      request.removeListener('end', end);
      request.removeListener('aborted', aborted);
      request.removeListener('error', errored);
      signal.removeEventListener('abort', aborted);
      if (error) { request.resume(); reject(error); } else resolve(value);
    };
    const data = chunk => {
      size += chunk.length;
      if (size > limits.body) finish(fail('GIT_HTTP_REQUEST_BODY_LIMIT'));
      else chunks.push(chunk);
    };
    const end = () => finish(null, Buffer.concat(chunks));
    const aborted = () => finish(fail('GIT_HTTP_REQUEST_ABORTED'));
    const errored = () => finish(fail('GIT_HTTP_REQUEST_STREAM'));
    request.on('data', data);
    request.once('end', end);
    request.once('aborted', aborted);
    request.once('error', errored);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

function parseHeaders(buffer, expectedMime) {
  const fields = new Map();
  for (const line of buffer.toString('latin1').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0 || !/^[A-Za-z][A-Za-z0-9-]*$/.test(line.slice(0, colon))) throw fail('GIT_HTTP_CGI_HEADER_INVALID');
    const key = line.slice(0, colon).toLowerCase();
    if (fields.has(key)) throw fail('GIT_HTTP_CGI_HEADER_DUPLICATE');
    fields.set(key, line.slice(colon + 1).trim());
  }
  const status = fields.get('status') ?? '200 OK';
  if (!/^200(?: [\x20-\x7e]+)?$/.test(status)) throw fail(`GIT_HTTP_CGI_STATUS_${/^\d{3}/.exec(status)?.[0] ?? 'INVALID'}`);
  if (fields.get('content-type') !== expectedMime) throw fail('GIT_HTTP_CGI_MIME');
  const allowed = new Set(['status', 'content-type', 'cache-control', 'expires', 'pragma', 'content-length']);
  for (const [key, value] of fields) {
    if (!allowed.has(key) || /[\x00-\x08\x0a-\x1f\x7f]/.test(value)) throw fail('GIT_HTTP_CGI_HEADER_UNSUPPORTED');
    if (key === 'content-length' && !/^\d+$/.test(value)) throw fail('GIT_HTTP_CGI_CONTENT_LENGTH');
  }
  return Object.fromEntries([...fields].filter(([key]) => key !== 'status'));
}

/** Read-only smart Git HTTP. close() must finish before the caller removes its owned tree. */
export async function startGitHttpServer({ httpRoot, bare, env }) {
  if (process.platform === 'win32') throw fail('GIT_HTTP_UNSUPPORTED_PROCESS_GROUPS');
  if (!env || typeof env !== 'object') throw fail('GIT_HTTP_ISOLATED_ENV_REQUIRED');
  const root = await realpath(httpRoot);
  if (await realpath(bare) !== path.join(root, 'marketplace.git')) throw fail('GIT_HTTP_BARE_BOUNDARY');
  const counters = { transport: 'git-http-backend-read-only-smart-http', requests: 0, objectRequests: 0, objectPayloadRequests: 0, uploadPackRequests: 0, successfulRequests: 0, bytesSent: 0, cgiStarted: 0, cgiStopped: 0, cgiFailures: 0, statuses: {}, recent: [], failures: [] };
  const processes = new Set();
  const tasks = new Set();
  let closing = false;
  let port;
  let closePromise;
  const server = createServer((request, response) => {
    const task = handle(request, response).catch(() => { if (!response.destroyed) response.destroy(); });
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
  });
  server.requestTimeout = limits.requestMs;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  server.maxConnections = limits.requests;

  async function handle(request, response) {
    counters.requests += 1;
    const route = routeFor(request);
    const selected = { method: ['GET', 'POST'].includes(request.method) ? request.method : '[other]', path: route?.path ?? '[rejected-route]', status: 0, bytes: 0 };
    let recorded = false;
    const recordResponse = aborted => {
      if (recorded) return;
      recorded = true;
      selected.status = aborted ? 0 : response.statusCode;
      if (aborted) selected.aborted = true;
      counters.statuses[selected.status] = (counters.statuses[selected.status] ?? 0) + 1;
      counters.bytesSent += selected.bytes;
      counters.recent.push({ ...selected });
      if (counters.recent.length > limits.sample) counters.recent.shift();
      if ((aborted || selected.status !== 200) && counters.failures.length < limits.sample) counters.failures.push({ ...selected });
    };
    response.once('finish', () => recordResponse(false));
    response.once('close', () => recordResponse(!response.writableFinished));
    response.on('error', () => {});
    request.on('error', () => {});
    if (closing || tasks.size >= limits.requests) { response.writeHead(503); response.end(); request.resume(); return; }
    if (!route) { response.writeHead(404); response.end(); request.resume(); return; }
    if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') { response.writeHead(415); response.end(); request.resume(); return; }
    if (request.headers['content-length'] && (!/^\d+$/.test(request.headers['content-length']) || Number(request.headers['content-length']) > limits.body)) { response.writeHead(413); response.end(); request.resume(); return; }
    const abort = new AbortController();
    let record;
    const cancel = code => {
      selected.failure ??= code;
      abort.abort();
      if (record) { record.child.stdout.resume(); void stopGroup(record).catch(() => {}); }
    };
    const timer = setTimeout(() => cancel('GIT_HTTP_REQUEST_TIMEOUT'), limits.requestMs);
    response.once('close', () => { if (!response.writableFinished) cancel('GIT_HTTP_CLIENT_CLOSED'); });
    try {
      const body = await bodyFor(request, abort.signal);
      if (closing || abort.signal.aborted) throw fail('GIT_HTTP_CLOSING');
      if (request.method === 'GET' && body.length !== 0) throw fail('GIT_HTTP_GET_BODY');
      const child = spawn('git', ['-c', 'http.receivepack=false', '-c', 'http.uploadpack=true', '-c', 'http.getanyfile=false', '-c', 'http.uploadarchive=false', 'http-backend'], { cwd: root, env: cgiEnvironment(env, root, route, request, body.length, port), detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      record = { child };
      processes.add(record);
      counters.cgiStarted += 1;
      let childError;
      let protocolError;
      let headers;
      let headerBuffer = Buffer.alloc(0);
      let packPrefix = Buffer.alloc(0);
      let packHeaderObserved = false;
      let stderrBytes = 0;
      const protocolFailure = code => { protocolError ??= fail(code); cancel(code); };
      const closed = new Promise(resolve => {
        child.once('error', error => { childError = error.code ?? 'SPAWN_ERROR'; });
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
      record.closed = closed;
      child.stdin.on('error', () => protocolFailure('GIT_HTTP_CGI_INPUT_STREAM'));
      child.stdout.on('error', () => protocolFailure('GIT_HTTP_CGI_OUTPUT_STREAM'));
      child.stderr.on('error', () => protocolFailure('GIT_HTTP_CGI_ERROR_STREAM'));
      child.stderr.on('data', chunk => { stderrBytes += chunk.length; });
      child.stdout.on('data', chunk => {
        try {
          if (protocolError || abort.signal.aborted) return;
          let bodyChunk = chunk;
          if (!headers) {
            headerBuffer = Buffer.concat([headerBuffer, chunk]);
            let delimiter = headerBuffer.indexOf('\r\n\r\n');
            let delimiterBytes = 4;
            if (delimiter < 0) { delimiter = headerBuffer.indexOf('\n\n'); delimiterBytes = 2; }
            if (delimiter < 0) { if (headerBuffer.length > limits.header) throw fail('GIT_HTTP_CGI_HEADER_LIMIT'); return; }
            if (delimiter > limits.header) throw fail('GIT_HTTP_CGI_HEADER_LIMIT');
            headers = parseHeaders(headerBuffer.subarray(0, delimiter), route.mime);
            bodyChunk = headerBuffer.subarray(delimiter + delimiterBytes);
            headerBuffer = Buffer.alloc(0);
            response.writeHead(200, headers);
          }
          if (bodyChunk.length) {
            if (route.upload && !packHeaderObserved) {
              const prefix = Buffer.concat([packPrefix, bodyChunk]);
              packHeaderObserved = prefix.includes(Buffer.from('PACK'));
              packPrefix = prefix.subarray(Math.max(0, prefix.length - 3));
            }
            selected.bytes += bodyChunk.length;
            if (!response.write(bodyChunk)) child.stdout.pause();
          }
        } catch (error) { protocolFailure(error.code ?? 'GIT_HTTP_CGI_RESPONSE'); }
      });
      response.on('drain', () => child.stdout.resume());
      child.stdin.end(body);
      const cancelled = new Promise(resolve => {
        if (abort.signal.aborted) resolve({ code: null, signal: 'REQUEST_ABORTED' });
        else abort.signal.addEventListener('abort', () => resolve({ code: null, signal: 'REQUEST_ABORTED' }), { once: true });
      });
      const result = await Promise.race([closed, cancelled]);
      await drain(record, counters, processes);
      if (stderrBytes) selected.cgiStderrBytes = stderrBytes;
      if (childError) throw fail(`GIT_HTTP_CGI_${childError}`);
      if (protocolError) throw protocolError;
      if (result.code !== 0 || !headers || abort.signal.aborted) throw fail('GIT_HTTP_CGI_FAILED');
      counters.successfulRequests += 1;
      if (route.upload) {
        counters.objectRequests += 1;
        if (packHeaderObserved) counters.objectPayloadRequests += 1;
        counters.uploadPackRequests += 1;
        selected.packHeaderObserved = packHeaderObserved;
      }
      response.end();
    } catch (error) {
      counters.cgiFailures += 1;
      selected.failure ??= error.code ?? 'GIT_HTTP_FAILED';
      if (record) { try { await drain(record, counters, processes); } catch {} }
      if (!response.headersSent && !response.destroyed) { response.writeHead(error.code === 'GIT_HTTP_REQUEST_BODY_LIMIT' ? 413 : 502); response.end(); }
      else if (!response.destroyed) response.destroy();
    } finally { clearTimeout(timer); }
  }

  async function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      const serverClosed = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      await Promise.all([...processes].map(record => drain(record, counters, processes)));
      const drained = await Promise.race([Promise.allSettled([...tasks]).then(() => true), sleep(3_000).then(() => false)]);
      if (!drained || processes.size !== 0) throw fail('GIT_HTTP_CLOSE_NOT_DRAINED');
      await serverClosed;
    })();
    return closePromise;
  }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address !== 'object' || address.address !== '127.0.0.1') { await close(); throw fail('GIT_HTTP_LOOPBACK_REQUIRED'); }
  port = address.port;
  return { server, origin: `http://127.0.0.1:${port}`, counters, snapshot: () => structuredClone(counters), close };
}
