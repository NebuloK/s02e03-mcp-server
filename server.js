/**
 * S02E03 MCP Server
 * Remote MCP server with memo_write, memo_search, upload, and transcribe tools.
 * Deployed to Render, reachable over HTTPS.
 */

import express from 'express';
import { randomUUID } from 'crypto';
import { mkdir, writeFile, readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN;
const ASSEMBLYAI_KEY = process.env.ASSEMBLYAI_API_KEY;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ── Storage ──────────────────────────────────────────────────────────────────
const memos = new Map();
const authCodes = new Map();      // code → { clientId, redirectUri, expiresAt }
const accessTokens = new Map();   // token → { clientId, expiresAt }
const sessions = new Map();       // sessionId → { res, messageQueue }

const uploadsDir = path.join(process.cwd(), 'uploads');
await mkdir(uploadsDir, { recursive: true });

// ── Express setup ────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Auth helpers ─────────────────────────────────────────────────────────────
function requireBearer(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');

  // Check OAuth access token
  const tokenData = accessTokens.get(token);
  if (tokenData && tokenData.expiresAt > Date.now()) {
    return next();
  }

  // Fallback: static auth token (for testing)
  if (AUTH_TOKEN && token === AUTH_TOKEN) {
    return next();
  }

  res.status(401).json({ error: 'Unauthorized' });
}

// ── OAuth / Discovery endpoints ──────────────────────────────────────────────

// OAuth Protected Resource Metadata (RFC 9728)
app.get('/.well-known/oauth-protected-resource', (req, res) => {
  res.json({
    resource: BASE_URL,
    authorization_servers: [`${BASE_URL}`],
    resource_documentation: `${BASE_URL}/docs`,
    scopes_supported: ['mcp']
  });
});

// OAuth Authorization Server Metadata
app.get('/.well-known/oauth-authorization-server', (req, res) => {
  res.json({
    issuer: BASE_URL,
    authorization_endpoint: `${BASE_URL}/authorize`,
    token_endpoint: `${BASE_URL}/token`,
    token_endpoint_auth_methods_supported: ['none'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    scopes_supported: ['mcp']
  });
});

// Documentation page
app.get('/docs', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'docs.html'));
});

// Authorization page
app.get('/authorize', (req, res) => {
  const { client_id, redirect_uri, state, scope } = req.query;
  res.send(`<!DOCTYPE html>
<html>
<head><title>Authorize MCP Server</title><meta charset="utf-8"></head>
<body style="font-family:sans-serif;max-width:600px;margin:40px auto;padding:0 20px">
  <h1>Authorize Access</h1>
  <p><strong>${escapeHtml(client_id || 'A client')}</strong> is requesting access to your MCP server.</p>
  <p>Scopes: <code>${escapeHtml(scope || 'mcp')}</code></p>
  <form method="POST" action="/authorize">
    <input type="hidden" name="client_id" value="${escapeHtml(client_id || '')}">
    <input type="hidden" name="redirect_uri" value="${escapeHtml(redirect_uri || '')}">
    <input type="hidden" name="state" value="${escapeHtml(state || '')}">
    <button type="submit" style="padding:10px 20px;font-size:16px;cursor:pointer">Allow Access</button>
  </form>
</body>
</html>`);
});

app.post('/authorize', (req, res) => {
  const { client_id, redirect_uri, state } = req.body;
  const code = randomUUID();

  authCodes.set(code, {
    clientId: client_id,
    redirectUri: redirect_uri,
    expiresAt: Date.now() + 10 * 60 * 1000 // 10 minutes
  });

  const redirectUrl = new URL(redirect_uri || `${BASE_URL}/connect/callback`);
  redirectUrl.searchParams.set('code', code);
  if (state) redirectUrl.searchParams.set('state', state);

  res.redirect(redirectUrl.toString());
});

// Token endpoint
app.post('/token', (req, res) => {
  const { grant_type, code, client_id } = req.body;

  if (grant_type !== 'authorization_code') {
    return res.status(400).json({ error: 'unsupported_grant_type' });
  }

  const codeData = authCodes.get(code);
  if (!codeData || codeData.expiresAt < Date.now()) {
    return res.status(400).json({ error: 'invalid_grant' });
  }

  authCodes.delete(code);

  const token = randomUUID();
  accessTokens.set(token, {
    clientId: client_id || codeData.clientId,
    expiresAt: Date.now() + 60 * 60 * 1000 // 1 hour
  });

  res.json({
    access_token: token,
    token_type: 'Bearer',
    expires_in: 3600
  });
});

// ── MCP SSE endpoint ─────────────────────────────────────────────────────────
app.get('/sse', requireBearer, (req, res) => {
  const sessionId = randomUUID();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const session = { id: sessionId, res, messageQueue: [] };
  sessions.set(sessionId, session);

  // Send endpoint event
  res.write(`event: endpoint\ndata: /messages?session_id=${sessionId}\n\n`);

  // Send any queued messages
  for (const msg of session.messageQueue) {
    res.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`);
  }
  session.messageQueue = [];

  req.on('close', () => { sessions.delete(sessionId); });
});

// ── MCP base at /mcp ─────────────────────────────────────────────────────────
app.get('/mcp', requireBearer, (req, res) => {
  res.json({ status: 'ok', endpoint: '/mcp/sse' });
});

app.post('/mcp', requireBearer, (req, res) => {
  res.json({ status: 'ok', endpoint: '/mcp/messages' });
});

// ── MCP SSE alias at /mcp/sse ────────────────────────────────────────────────
app.get('/mcp/sse', requireBearer, (req, res) => {
  const sessionId = randomUUID();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const session = { id: sessionId, res, messageQueue: [] };
  sessions.set(sessionId, session);

  // Send endpoint event
  res.write(`event: endpoint\ndata: /mcp/messages?session_id=${sessionId}\n\n`);

  // Send any queued messages
  for (const msg of session.messageQueue) {
    res.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`);
  }
  session.messageQueue = [];

  req.on('close', () => { sessions.delete(sessionId); });
});

// ── MCP messages endpoint ────────────────────────────────────────────────────
app.get('/messages', requireBearer, (req, res) => {
  res.status(405).json({ error: 'Method Not Allowed. Use POST.' });
});

app.post('/messages', requireBearer, async (req, res) => {
  const sessionId = req.query.session_id;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const message = req.body;
  const response = await handleMcpMessage(message);

  if (response) {
    if (session.res && !session.res.writableEnded) {
      session.res.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
    } else {
      session.messageQueue.push(response);
    }
  }

  res.status(202).send();
});

// ── MCP messages alias at /mcp/messages ─────────────────────────────────────
app.get('/mcp/messages', requireBearer, (req, res) => {
  res.status(405).json({ error: 'Method Not Allowed. Use POST.' });
});

app.post('/mcp/messages', requireBearer, async (req, res) => {
  const sessionId = req.query.session_id;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const message = req.body;
  const response = await handleMcpMessage(message);

  if (response) {
    if (session.res && !session.res.writableEnded) {
      session.res.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
    } else {
      session.messageQueue.push(response);
    }
  }

  res.status(202).send();
});

// ── MCP message handler ──────────────────────────────────────────────────────
async function handleMcpMessage(message) {
  if (!message || typeof message !== 'object') return null;

  // Initialize
  if (message.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 's02e03-mcp-server', version: '1.0.0' }
      }
    };
  }

  // Tools list
  if (message.method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [
          {
            name: 'memo_write',
            description: 'Saves a note. Returns the note id.',
            inputSchema: {
              type: 'object',
              properties: {
                text: { type: 'string', description: 'The note text to save' }
              },
              required: ['text']
            }
          },
          {
            name: 'memo_search',
            description: 'Finds notes matching a query.',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Search query' }
              },
              required: ['query']
            }
          },
          {
            name: 'upload',
            description: 'Uploads a file (base64 content) and returns a public URL.',
            inputSchema: {
              type: 'object',
              properties: {
                filename: { type: 'string', description: 'Original filename' },
                content: { type: 'string', description: 'File content as base64 string' }
              },
              required: ['filename', 'content']
            }
          },
          {
            name: 'transcribe',
            description: 'Transcribes audio from a URL into timestamped segments.',
            inputSchema: {
              type: 'object',
              properties: {
                url: { type: 'string', description: 'URL of the audio file to transcribe' }
              },
              required: ['url']
            }
          }
        ]
      }
    };
  }

  // Tool call
  if (message.method === 'tools/call') {
    const { name, arguments: args } = message.params || {};

    try {
      let result;
      switch (name) {
        case 'memo_write': result = memoWrite(args); break;
        case 'memo_search': result = memoSearch(args); break;
        case 'upload': result = await uploadFile(args); break;
        case 'transcribe': result = await transcribeAudio(args); break;
        default: throw new Error(`Unknown tool: ${name}`);
      }

      return {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          isError: false
        }
      };
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
          isError: true
        }
      };
    }
  }

  return null;
}

// ── Tool implementations ─────────────────────────────────────────────────────
function memoWrite(args) {
  if (!args || !args.text) throw new Error('Missing required field: text');
  const id = randomUUID();
  const note = { id, text: args.text, created_at: new Date().toISOString() };
  memos.set(id, note);
  return { id };
}

function memoSearch(args) {
  if (!args || !args.query) throw new Error('Missing required field: query');
  const query = String(args.query).toLowerCase();
  const notes = [];
  for (const note of memos.values()) {
    if (note.text.toLowerCase().includes(query)) notes.push(note);
  }
  return { notes };
}

async function uploadFile(args) {
  if (!args || !args.filename || !args.content) {
    throw new Error('Missing required fields: filename, content');
  }
  const buffer = Buffer.from(args.content, 'base64');
  const safeName = String(args.filename).replace(/[^a-zA-Z0-9._-]/g, '_');
  const filename = `${randomUUID()}-${safeName}`;
  const filepath = path.join(uploadsDir, filename);
  await writeFile(filepath, buffer);
  const url = `${BASE_URL}/files/${filename}`;
  return { url };
}

async function transcribeAudio(args) {
  if (!args || !args.url) throw new Error('Missing required field: url');
  if (!ASSEMBLYAI_KEY) {
    throw new Error('Transcription service not configured. Set ASSEMBLYAI_API_KEY.');
  }

  // Download audio
  const audioRes = await fetch(args.url);
  if (!audioRes.ok) throw new Error(`Failed to download audio: ${audioRes.status}`);
  const audioBuffer = await audioRes.arrayBuffer();

  // Upload to AssemblyAI
  const uploadRes = await fetch('https://api.assemblyai.com/v2/upload', {
    method: 'POST',
    headers: { 'Authorization': ASSEMBLYAI_KEY },
    body: Buffer.from(audioBuffer)
  });
  if (!uploadRes.ok) throw new Error(`AssemblyAI upload failed: ${uploadRes.status}`);
  const uploadData = await uploadRes.json();

  // Request transcription
  const transcriptRes = await fetch('https://api.assemblyai.com/v2/transcript', {
    method: 'POST',
    headers: { 'Authorization': ASSEMBLYAI_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio_url: uploadData.upload_url })
  });
  if (!transcriptRes.ok) throw new Error(`AssemblyAI transcript request failed: ${transcriptRes.status}`);
  const transcriptData = await transcriptRes.json();

  // Poll for completion
  const transcriptId = transcriptData.id;
  let result;
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const pollRes = await fetch(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
      headers: { 'Authorization': ASSEMBLYAI_KEY }
    });
    result = await pollRes.json();
    if (result.status === 'completed' || result.status === 'error') break;
  }

  if (result.status !== 'completed') {
    throw new Error(`Transcription failed or timed out: ${result.status}`);
  }

  // Build segments (start in seconds)
  const segments = [];
  if (result.utterances) {
    for (const u of result.utterances) {
      segments.push({ start: (u.start || 0) / 1000, text: u.text || '' });
    }
  } else if (result.words) {
    for (const w of result.words) {
      segments.push({ start: (w.start || 0) / 1000, text: w.text || w.word || '' });
    }
  }
  if (segments.length === 0 && result.text) {
    segments.push({ start: 0, text: result.text });
  }

  return { segments };
}

// ── Static file serving ──────────────────────────────────────────────────────
app.use('/files', express.static(uploadsDir));

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', memos: memos.size });
});

// ── HTML escape helper ──────────────────────────────────────────────────────
function escapeHtml(text) {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`MCP server running on ${BASE_URL}`);
  console.log(`Docs: ${BASE_URL}/docs`);
  console.log(`Health: ${BASE_URL}/health`);
});
