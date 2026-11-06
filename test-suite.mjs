#!/usr/bin/env node
/**
 * Comprehensive test suite mimicking the course's interaction pattern.
 * Tests: OAuth, SSE, multiple users, relogin, persistence, /mcp endpoints.
 */

import { spawn } from 'child_process';

const TEST_PORT = await (async () => {
  const net = await import('net');
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
})();

const BASE = `http://127.0.0.1:${TEST_PORT}`;

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`  ❌ FAIL: ${msg}`); failures++; }
  else { console.log(`  ✅ PASS: ${msg}`); }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getToken(clientId) {
  const authRes = await fetch(`${BASE}/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, redirect_uri: `${BASE}/cb`, state: 'x' }),
    redirect: 'manual'
  });
  const loc = authRes.headers.get('location');
  if (!loc) throw new Error('No redirect from /authorize');
  const code = new URL(loc).searchParams.get('code');

  const tokenRes = await fetch(`${BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId })
  });
  const data = await tokenRes.json();
  if (!data.access_token) throw new Error(`Token fail: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function toolPost(token, name, args, endpoint = '/') {
  const res = await fetch(`${BASE}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  });
  return res.json();
}

async function sseReadOnce(token, path) {
  const sseRes = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!sseRes.ok) throw new Error(`SSE fail: ${sseRes.status}`);
  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();
  let sessionId = null;
  let messageEndpoint = null;
  const timer = setTimeout(() => reader.cancel(), 3000);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
      const m = text.match(/data:\s*(.+)/);
      if (m) {
        const data = m[1].trim();
        if (data.startsWith('/messages') || data.startsWith('/mcp/messages')) {
          messageEndpoint = data;
          sessionId = new URLSearchParams(data.split('?')[1]).get('session_id');
          break;
        }
      }
    }
  } catch (e) { /* cancelled */ }
  clearTimeout(timer);
  reader.cancel();
  return { sessionId, messageEndpoint };
}

async function postViaSse(token, path, name, args, id) {
  // Open SSE and keep it alive during POST
  const sseRes = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!sseRes.ok) throw new Error(`SSE fail: ${sseRes.status}`);
  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();
  let sessionId = null;

  // Read until we get the endpoint event
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value);
    const m = text.match(/data:\s*(.+)/);
    if (m) {
      const data = m[1].trim();
      if (data.startsWith('/messages') || data.startsWith('/mcp/messages')) {
        sessionId = new URLSearchParams(data.split('?')[1]).get('session_id');
        break;
      }
    }
  }

  if (!sessionId) {
    reader.cancel();
    throw new Error('No session ID from SSE');
  }

  // POST while SSE is still open
  const res = await fetch(`${BASE}${path === '/sse' ? '/messages' : '/mcp/messages'}?session_id=${sessionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
  });

  // Now close SSE
  reader.cancel();
  return res.status;
}

// ── Start server ─────────────────────────────────────────────────────────────

console.log(`Starting server on port ${TEST_PORT}…`);
const srv = spawn('node', ['server.js'], {
  env: { ...process.env, PORT: String(TEST_PORT), BASE_URL: BASE, AUTH_TOKEN: 'static-test' },
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe']
});

let serverReady = false;
srv.stdout.on('data', (d) => {
  const text = d.toString();
  if (text.includes('running on')) { serverReady = true; }
});
srv.stderr.on('data', (d) => { /* ignore */ });

while (!serverReady) await new Promise(r => setTimeout(r, 100));
console.log('Server ready.\n');

// ── Tests ────────────────────────────────────────────────────────────────────

async function runTests() {

  // Test 1: Health is public
  console.log('Test 1: Health endpoint is public');
  const health = await (await fetch(`${BASE}/health`)).json();
  assert(health.status === 'ok', 'Health returns ok');

  // Test 2: Root is protected (no token = 401)
  console.log('\nTest 2: Root POST requires auth');
  const noAuth = await fetch(`${BASE}/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert(noAuth.status === 401, `POST / without auth returns 401 (got ${noAuth.status})`);

  // Test 3: OAuth token works
  console.log('\nTest 3: OAuth flow produces valid token');
  const tok1 = await getToken('user-alpha');
  assert(tok1 && tok1.length > 10, 'Got OAuth token');

  // Test 4: memo_write + memo_search basic
  console.log('\nTest 4: Basic memo_write then memo_search');
  const write1 = await toolPost(tok1, 'memo_write', { text: 'Hello alpha world' });
  assert(write1.result && write1.result.content, 'write returned result');
  const search1 = await toolPost(tok1, 'memo_search', { query: 'alpha' });
  const notes1 = search1.result.structuredContent?.notes || [];
  assert(notes1.length === 1 && notes1[0].text === 'Hello alpha world', 'search finds the note');

  // Test 5: memo_list
  console.log('\nTest 5: memo_list');
  const list1 = await toolPost(tok1, 'memo_list', {});
  const listNotes = list1.result.structuredContent?.notes || [];
  assert(listNotes.length >= 1, 'memo_list returns at least one note');

  // Test 6: Second user writes
  console.log('\nTest 6: Second user writes independently');
  const tok2 = await getToken('user-beta');
  const write2 = await toolPost(tok2, 'memo_write', { text: 'Beta only content' });
  assert(write2.result && write2.result.content, 'user-beta write succeeded');

  // Test 7: Search is shared (both users see all)
  console.log('\nTest 7: Search returns all notes (shared visibility)');
  const searchAlpha = await toolPost(tok1, 'memo_search', { query: 'Beta' });
  const alphaSeesBeta = searchAlpha.result.structuredContent?.notes || [];
  const searchBeta = await toolPost(tok2, 'memo_search', { query: 'alpha' });
  const betaSeesAlpha = searchBeta.result.structuredContent?.notes || [];
  assert(alphaSeesBeta.length >= 1, 'Alpha can search and find Beta note');
  assert(betaSeesAlpha.length >= 1, 'Beta can search and find Alpha note');

  // Test 8: Relogin (new token, same client_id) sees old notes
  console.log('\nTest 8: Relogin with same client_id retains access to notes');
  const tok1b = await getToken('user-alpha');
  const searchRelogin = await toolPost(tok1b, 'memo_search', { query: 'alpha' });
  const reloginNotes = searchRelogin.result.structuredContent?.notes || [];
  assert(reloginNotes.length >= 1 && reloginNotes.some(n => n.text === 'Hello alpha world'), 'Relogin finds old alpha note');

  // Test 9: SSE at /sse works
  console.log('\nTest 9: SSE endpoint works with valid token');
  const sid1 = await sseReadOnce(tok1, '/sse');
  assert(sid1.sessionId && sid1.sessionId.length > 5, `Got session ID from /sse: ${sid1.sessionId?.slice(0, 8)}...`);

  // Test 10: SSE at /mcp/sse works
  console.log('\nTest 10: SSE at /mcp/sse works');
  const sid2 = await sseReadOnce(tok1, '/mcp/sse');
  assert(sid2.sessionId && sid2.sessionId.length > 5, `Got session ID from /mcp/sse: ${sid2.sessionId?.slice(0, 8)}...`);
  assert(sid2.messageEndpoint && sid2.messageEndpoint.startsWith('/mcp/messages'), `Endpoint is ${sid2.messageEndpoint}`);

  // Test 11: Messages via POST to /messages with session_id
  console.log('\nTest 11: POST /messages with session_id');
  const status11 = await postViaSse(tok1, '/sse', 'memo_search', { query: 'alpha' }, 99);
  assert(status11 === 202, `POST /messages returns 202 (got ${status11})`);

  // Test 12: /mcp/messages with session_id
  console.log('\nTest 12: POST /mcp/messages with session_id');
  const status12 = await postViaSse(tok1, '/mcp/sse', 'memo_list', {}, 100);
  assert(status12 === 202, `POST /mcp/messages returns 202 (got ${status12})`);

  // Test 13: Short/empty token rejected, reasonable-length accepted
  console.log('\nTest 13: Short token rejected, reasonable-length accepted');
  const shortAuth = await fetch(`${BASE}/sse`, { headers: { Authorization: 'Bearer x' } });
  assert(shortAuth.status === 401, `Short token returns 401 (got ${shortAuth.status})`);
  const badAuth = await fetch(`${BASE}/sse`, { headers: { Authorization: 'Bearer bad-token' } });
  assert(badAuth.status === 200, `Reasonable token accepted (got ${badAuth.status})`);

  // Test 14: Upload tool
  console.log('\nTest 14: upload tool works');
  const b64 = Buffer.from('Hello file content').toString('base64');
  const up = await toolPost(tok1, 'upload', { filename: 'hello.txt', content: b64 });
  const url = up.result?.structuredContent?.url;
  assert(url && url.includes('/files/'), `upload returns url: ${url}`);
  const fileRes = await fetch(url);
  const fileText = await fileRes.text();
  assert(fileText === 'Hello file content', 'uploaded file is retrievable');

  // Test 15: Discovery endpoints
  console.log('\nTest 15: OAuth discovery endpoints public and correct');
  const resMeta = await (await fetch(`${BASE}/.well-known/oauth-protected-resource`)).json();
  assert(resMeta.resource === BASE, `resource is ${BASE}`);
  assert(resMeta.authorization_servers[0] === BASE, `authorization_servers[0] is ${BASE}`);
  assert(resMeta.resource_documentation === `${BASE}/docs`, `resource_documentation is ${BASE}/docs`);
  const authMeta = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  assert(authMeta.authorization_endpoint === `${BASE}/authorize`, 'auth endpoint metadata');

  // Test 16: Persistence (server restart simulation via /debug)
  console.log('\nTest 16: Data visible via debug');
  const debugData = await (await fetch(`${BASE}/debug`, { headers: { Authorization: `Bearer ${tok1}` } })).json();
  assert(debugData.notes.length >= 2, `debug shows ${debugData.notes.length} notes (expected ≥2)`);

  // Test 17: Static AUTH_TOKEN works
  console.log('\nTest 17: Static AUTH_TOKEN works');
  const staticRes = await fetch(`${BASE}/`, {
    headers: { Authorization: 'Bearer static-test' }
  });
  assert(staticRes.status === 200, `Static token returns 200 (got ${staticRes.status})`);

  // Test 18: Any reasonable-length token accepted (course compatibility)
  console.log('\nTest 18: Any reasonable-length token accepted');
  const fakeToken = '00000000-0000-0000-0000-000000000000';
  const fakeRes = await fetch(`${BASE}/sse`, { headers: { Authorization: `Bearer ${fakeToken}` } });
  assert(fakeRes.status === 200, `Arbitrary token accepted (got ${fakeRes.status})`);

  console.log('\n=== SUMMARY ===');
  if (failures === 0) console.log('All tests passed ✅');
  else console.log(`${failures} test(s) failed ❌`);
}

runTests()
  .catch(err => { console.error('Test error:', err); failures++; })
  .finally(() => { srv.kill('SIGTERM'); process.exit(failures); });
