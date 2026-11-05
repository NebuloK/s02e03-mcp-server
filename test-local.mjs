#!/usr/bin/env node
/**
 * Quick local test for the MCP server.
 * Runs the basic MCP flow: initialize → tools/list → memo_write → memo_search.
 */

const BASE = process.env.BASE || 'http://localhost:3000';
const TOKEN = process.env.AUTH_TOKEN || 'test-token';

async function test() {
  console.log('Testing MCP server at', BASE);

  // 1. Connect to SSE
  const sseRes = await fetch(`${BASE}/sse`, {
    headers: { Authorization: `Bearer ${TOKEN}` }
  });
  if (!sseRes.ok) throw new Error(`SSE failed: ${sseRes.status}`);
  console.log('✅ SSE connected');

  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();
  let sessionId = null;

  // Read SSE events
  const readPromise = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
      const match = text.match(/data:\s*(.+)/);
      if (match) {
        const data = match[1].trim();
        if (data.startsWith('/messages')) {
          sessionId = new URLSearchParams(data.split('?')[1]).get('session_id');
          console.log('✅ Session ID:', sessionId);
        } else {
          try {
            const msg = JSON.parse(data);
            console.log('📨 MCP Response:', JSON.stringify(msg, null, 2));
          } catch {
            console.log('📨 Raw:', data);
          }
        }
      }
    }
  })();

  // Wait for session ID
  await new Promise(r => setTimeout(r, 500));

  if (!sessionId) {
    console.error('❌ Failed to get session ID');
    process.exit(1);
  }

  const post = async (method, params, id) => {
    const body = { jsonrpc: '2.0', id, method, params };
    const res = await fetch(`${BASE}/messages?session_id=${sessionId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) console.error('POST failed:', res.status);
  };

  // 2. Initialize
  await post('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } }, 1);
  await new Promise(r => setTimeout(r, 300));

  // 3. List tools
  await post('tools/list', {}, 2);
  await new Promise(r => setTimeout(r, 300));

  // 4. Write a note
  await post('tools/call', { name: 'memo_write', arguments: { text: 'Hello from test!' } }, 3);
  await new Promise(r => setTimeout(r, 300));

  // 5. Search notes
  await post('tools/call', { name: 'memo_search', arguments: { query: 'Hello' } }, 4);
  await new Promise(r => setTimeout(r, 300));

  // 6. Upload a file
  const content = Buffer.from('Hello, world!').toString('base64');
  await post('tools/call', { name: 'upload', arguments: { filename: 'test.txt', content } }, 5);
  await new Promise(r => setTimeout(r, 300));

  console.log('\n✅ All tests sent. Check responses above.');
  reader.cancel();
}

test().catch(err => {
  console.error('❌ Test failed:', err.message);
  process.exit(1);
});
