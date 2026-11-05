# S02E03 MCP Server

Remote MCP server with `memo_write`, `memo_search`, `upload`, and `transcribe` tools.

## Tools

| Tool | Input | Output |
|------|-------|--------|
| `memo_write` | `{ text }` | `{ id }` |
| `memo_search` | `{ query }` | `{ notes: [{ id, text, created_at }] }` |
| `upload` | `{ filename, content (base64) }` | `{ url }` |
| `transcribe` | `{ url }` | `{ segments: [{ start (seconds), text }] }` |

## Local test

```bash
npm install
AUTH_TOKEN=test-token node server.js
# In another terminal:
AUTH_TOKEN=test-token node test-local.mjs
```

## Deploy to Render

1. Push this repo to GitHub
2. Create a new Web Service on Render, connect to the GitHub repo
3. Set environment variables (see `.env.example`)
4. Render provides the public HTTPS URL

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (Render sets this) |
| `BASE_URL` | Yes | Public HTTPS URL of the server |
| `AUTH_TOKEN` | Yes | Static auth token for testing |
| `ASSEMBLYAI_API_KEY` | Yes | For transcription (free at assemblyai.com) |
