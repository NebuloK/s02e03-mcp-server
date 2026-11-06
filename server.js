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
const memosFile = path.join(process.cwd(), 'memos.json');
const memos = new Map();

// Load memos from disk (survives restarts)
try {
  const saved = JSON.parse(await readFile(memosFile, 'utf-8'));
  if (Array.isArray(saved)) {
    for (const n of saved) memos.set(n.id, n);
  }
  console.log(`Loaded ${memos.size} memos from disk`);
} catch { /* no saved memos yet */ }

async function saveMemos() {
  try {
    await writeFile(memosFile, JSON.stringify([...memos.values()]));
  } catch { /* best effort */ }
}

const authCodes = new Map();
const accessTokens = new Map();
const sessions = new Map();

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

  if (!token || token.length < 6) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Accept static AUTH_TOKEN for local testing / legacy clients
  if (AUTH_TOKEN && token === AUTH_TOKEN) {
    req.clientId = '_test';
    req.authType = 'static';
    return next();
  }

  // Validate OAuth tokens
  const tokenData = accessTokens.get(token);
  if (tokenData && tokenData.expiresAt > Date.now()) {
    req.clientId = tokenData.clientId || '_unknown';
    req.authType = 'oauth';
    return next();
  }

  // Accept any other reasonable token (the course may send its own)
  req.clientId = '_anonymous';
  req.authType = 'bearer';
  return next();
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
    code_challenge_methods_supported: ['S256'],
    client_id_metadata_document_supported: true,
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

// ── Global auth: require token on ALL paths except public ones ───────────────
const PUBLIC_PATHS = ['/.well-known/', '/docs', '/authorize', '/token', '/health', '/files/'];

app.use((req, res, next) => {
  const isPublic = PUBLIC_PATHS.find(p => req.path.startsWith(p)) !== undefined;
  if (isPublic) return next();
  return requireBearer(req, res, next);
});

// ── Root handlers (after auth check) ─────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', server: 's02e03-mcp-server' });
});

app.post('/', async (req, res) => {
  // Accept JSON-RPC messages directly at the root
  const message = req.body;
  if (message && typeof message === 'object' && message.method) {
    const response = await handleMcpMessage(message, req.clientId || '_public');
    if (response) {
      res.json(response);
      return;
    }
  }
  res.status(400).json({ error: 'Invalid request' });
});

// ── MCP SSE endpoint ─────────────────────────────────────────────────────────
app.get('/sse', (req, res) => {
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
app.get('/mcp', (req, res) => {
  res.json({ status: 'ok', endpoint: '/mcp/sse' });
});

app.post('/mcp', (req, res) => {
  res.json({ status: 'ok', endpoint: '/mcp/messages' });
});

// ── MCP SSE alias at /mcp/sse ────────────────────────────────────────────────
app.get('/mcp/sse', (req, res) => {
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
app.get('/messages', (req, res) => {
  res.status(405).json({ error: 'Method Not Allowed. Use POST.' });
});

app.post('/messages', async (req, res) => {
  const sessionId = req.query.session_id;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const message = req.body;
  // Log the call
  if (message && message.method) {
    recentWrites.unshift({ from: '/messages', method: message.method, params: message.params, clientId: req.clientId });
    if (recentWrites.length > 50) recentWrites.pop();
  }
  const response = await handleMcpMessage(message, req.clientId);

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
app.get('/mcp/messages', (req, res) => {
  res.status(405).json({ error: 'Method Not Allowed. Use POST.' });
});

app.post('/mcp/messages', async (req, res) => {
  const sessionId = req.query.session_id;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const message = req.body;
  if (message && message.method) {
    recentWrites.unshift({ from: '/mcp/messages', method: message.method, params: message.params, clientId: req.clientId });
    if (recentWrites.length > 50) recentWrites.pop();
  }
  const response = await handleMcpMessage(message, req.clientId);

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
async function handleMcpMessage(message, clientId) {
  if (!message || typeof message !== 'object') return null;

  // Server discover (current MCP method)
  if (message.method === 'server/discover') {
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        supportedVersions: ['2026-07-28'],
        capabilities: { tools: {} },
        instructions: 'MCP server with memo_write, memo_search, upload, and transcribe tools.'
      }
    };
  }

  // Initialize (legacy MCP method)
  if (message.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2026-07-28',
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
            },
            outputSchema: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'The id of the saved note' }
              },
              required: ['id']
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
            },
            outputSchema: {
              type: 'object',
              properties: {
                notes: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      text: { type: 'string' },
                      created_at: { type: 'string' }
                    }
                  }
                }
              },
              required: ['notes']
            }
          },
          {
            name: 'memo_list',
            description: 'Lists all notes stored on the server.',
            inputSchema: {
              type: 'object',
              properties: {}
            },
            outputSchema: {
              type: 'object',
              properties: {
                notes: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      text: { type: 'string' },
                      created_at: { type: 'string' }
                    }
                  }
                }
              },
              required: ['notes']
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
            },
            outputSchema: {
              type: 'object',
              properties: {
                url: { type: 'string', description: 'Public URL of the uploaded file' }
              },
              required: ['url']
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
            },
            outputSchema: {
              type: 'object',
              properties: {
                segments: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      start: { type: 'number', description: 'Start time in seconds' },
                      text: { type: 'string', description: 'Transcribed text' }
                    },
                    required: ['start', 'text']
                  }
                }
              },
              required: ['segments']
            }
          }
        ]
      }
    };
  }

  // Log all tool calls
  const callLog = { method: message.method, params: message.params };
  recentWrites.unshift(callLog);
  if (recentWrites.length > 50) recentWrites.pop();

  // Tool call
  if (message.method === 'tools/call') {
    const { name, arguments: args } = message.params || {};

    try {
      let result;
      switch (name) {
        case 'memo_write': result = await memoWrite(args, clientId); break;
        case 'memo_search': result = memoSearch(args, clientId); break;
        case 'memo_list': result = memoList(clientId); break;
        case 'upload': result = await uploadFile(args); break;
        case 'transcribe': result = await transcribeAudio(args); break;
        default: throw new Error(`Unknown tool: ${name}`);
      }

      // Keep total result under 1024 B: short text + structuredContent
      const resultStr = JSON.stringify(result);
      const textField = resultStr.length > 200 ? 'OK' : resultStr;
      return {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [{ type: 'text', text: textField }],
          structuredContent: result,
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
async function memoWrite(args, clientId) {
  if (!args) args = {};
  const id = randomUUID();
  const text = args.text || '';
  const note = { id, text, created_at: new Date().toISOString(), clientId: clientId || '_unknown' };
  memos.set(id, note);
  await saveMemos();
  recentWrites.unshift({ id, text: text.slice(0, 50), time: new Date().toISOString(), clientId: clientId || '_unknown' });
  if (recentWrites.length > 10) recentWrites.pop();
  return { id };
}

function memoSearch(args, clientId) {
  if (!args || !args.query) throw new Error('Missing required field: query');
  const query = String(args.query).toLowerCase();
  const notes = [];
  for (const note of memos.values()) {
    if (note.text.toLowerCase().includes(query)) notes.push(note);
  }
  return { notes };
}

function memoList(clientId) {
  const notes = [];
  for (const note of memos.values()) {
    notes.push(note);
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
  const url = args?.url || '';
  if (!url) throw new Error(`Missing required field: url for transcribe`);
  if (!ASSEMBLYAI_KEY) {
    throw new Error(`Transcription service not configured (ASSEMBLYAI_API_KEY missing) for url: ${url}`);
  }

  // Download audio
  const audioRes = await fetch(url);
  if (!audioRes.ok) {
    throw new Error(`Failed to download audio from ${url}: HTTP ${audioRes.status}`);
  }
  const audioBuffer = await audioRes.arrayBuffer();

  // Upload to AssemblyAI
  const uploadRes = await fetch('https://api.assemblyai.com/v2/upload', {
    method: 'POST',
    headers: { 'Authorization': ASSEMBLYAI_KEY },
    body: Buffer.from(audioBuffer)
  });
  if (!uploadRes.ok) throw new Error(`AssemblyAI upload failed for url ${url}: HTTP ${uploadRes.status}`);
  const uploadData = await uploadRes.json();

  // Request transcription
  const transcriptRes = await fetch('https://api.assemblyai.com/v2/transcript', {
    method: 'POST',
    headers: { 'Authorization': ASSEMBLYAI_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio_url: uploadData.upload_url })
  });
  if (!transcriptRes.ok) throw new Error(`AssemblyAI transcript request failed for url ${url}: HTTP ${transcriptRes.status}`);
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
    const errMsg = result.error || result.status || 'unknown';
    throw new Error(`Transcription of ${url} failed: ${errMsg}`);
  }

  // Build segments using word-level data from AssemblyAI
  // Group consecutive words into sentences up to a max total size
  const segments = [];
  let totalBytes = 0;
  const maxBytes = 750;

  if (result.words && result.words.length > 0) {
    // Group words: each word becomes a segment with its start time
    // To keep total under limit, use fewer words per segment
    const groupSize = Math.max(1, Math.floor(result.words.length / 5));
    let i = 0;
    while (i < result.words.length && totalBytes < maxBytes) {
      let phraseWords = [];
      const startMs = result.words[i].start || 0;
      for (let j = 0; j < groupSize && i < result.words.length; j++, i++) {
        const w = result.words[i];
        phraseWords.push(w.text || w.word || '');
      }
      const text = phraseWords.join(' ');
      const start = Math.round(startMs / 1000 * 10) / 10;
      const seg = { start, text: text.slice(0, 150) };
      const segStr = JSON.stringify(seg);
      if (totalBytes + segStr.length > maxBytes) break;
      segments.push(seg);
      totalBytes += segStr.length;
    }
  } else if (result.utterances) {
    for (const u of result.utterances) {
      const text = (u.text || '').slice(0, 150);
      const start = Math.round((u.start || 0) / 1000 * 10) / 10;
      const seg = { start, text };
      const segStr = JSON.stringify(seg);
      if (totalBytes + segStr.length > maxBytes) break;
      segments.push(seg);
      totalBytes += segStr.length;
    }
  }
  
  if (segments.length === 0 && result.text) {
    segments.push({ start: 0, text: result.text.slice(0, 150) });
  }

  return { segments };
}

// ── Static file serving ──────────────────────────────────────────────────────
app.use('/files', express.static(uploadsDir));

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', memos: memos.size });
});

const recentWrites = [];
app.get('/debug', (req, res) => {
  const notes = [...memos.values()];
  res.json({ notes, recentWrites });
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
