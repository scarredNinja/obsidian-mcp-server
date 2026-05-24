// src/index.ts
// Single entry point. Transport is selected via TRANSPORT env var:
//   TRANSPORT=stdio (default) — Claude Desktop / local dev
//   TRANSPORT=http            — Swarm container / remote clients

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import fs from 'node:fs';
import { createServer } from './server.js';

const TRANSPORT = process.env['TRANSPORT'] ?? 'stdio';
const PORT = parseInt(process.env['PORT'] ?? '3000', 10);

async function runStdio(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // MCP stdio protocol: all logging must go to stderr, never stdout
  process.stderr.write('obsidian-mcp-server running (stdio)\n');
}

async function runHTTP(): Promise<void> {
  const app = express();
  app.use(express.json());

  // 1. Structured JSON request logging to stdout (scraped by Promtail/Loki)
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      const log = {
        timestamp: new Date().toISOString(),
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: duration,
        ip: req.ip,
        userAgent: req.get('user-agent') ?? '',
      };
      process.stdout.write(JSON.stringify(log) + '\n');
    });
    next();
  });

  // 2. API Key verification middleware
  const verifyApiKey = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const expectedKey = process.env['MCP_API_KEY'];
    if (!expectedKey) {
      return next(); // Safety fallback if not strictly validated
    }

    // Accept key via X-API-Key header, query param, or Authorization Bearer token
    const clientKey =
      req.get('x-api-key') ||
      req.query['apiKey'] ||
      (req.get('authorization')?.startsWith('Bearer ') ? req.get('authorization')?.slice(7) : undefined);

    if (clientKey !== expectedKey) {
      res.status(401).json({ error: 'Unauthorized: Invalid or missing API key' });
      return;
    }
    next();
  };

  // Health check — useful for Swarm healthchecks and Uptime Kuma (unauthenticated)
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      transport: 'http',
      vault: process.env['VAULT_PATH'] ?? '(not set)',
      allowed_folders: process.env['VAULT_ALLOWED_FOLDERS'] ? 'configured' : 'unrestricted',
    });
  });

  // Stateless MCP endpoint — new transport per request. Secure with API key verification.
  app.post('/mcp', verifyApiKey, async (req, res) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode
      enableJsonResponse: true,
    });

    res.on('close', () => {
      void transport.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.listen(PORT, () => {
    process.stderr.write(`obsidian-mcp-server running (http) on port ${PORT}\n`);
    process.stderr.write(`Health: http://localhost:${PORT}/health\n`);
    process.stderr.write(`MCP endpoint: http://localhost:${PORT}/mcp\n`);
  });
}

// ── Bootstrap ──────────────────────────────────────────────────────────────────

function loadSecrets(): void {
  const secretPath = '/run/secrets/mcp_api_key';
  if (fs.existsSync(secretPath)) {
    try {
      process.env['MCP_API_KEY'] = fs.readFileSync(secretPath, 'utf8').trim();
    } catch (err) {
      process.stderr.write(`Warning: Failed to read secret from ${secretPath}: ${String(err)}\n`);
    }
  }
}

function validateEnv(): void {
  // Load secrets from Swarm if available
  loadSecrets();

  if (!process.env['VAULT_PATH']) {
    process.stderr.write(
      'ERROR: VAULT_PATH is not set.\n' +
      'Set it to the absolute path of your Obsidian vault.\n' +
      'Examples:\n' +
      '  Windows: VAULT_PATH=C:\\Users\\DJ\\Documents\\Notes\\Home\n' +
      '  Linux:   VAULT_PATH=/vault\n',
    );
    process.exit(1);
  }

  // Force API Key requirement in HTTP mode for cluster security
  if (TRANSPORT === 'http' && !process.env['MCP_API_KEY']) {
    process.stderr.write('ERROR: MCP_API_KEY environment variable is required in HTTP mode.\n');
    process.exit(1);
  }
}

validateEnv();

if (TRANSPORT === 'http') {
  runHTTP().catch((err: unknown) => {
    process.stderr.write(`Fatal: ${String(err)}\n`);
    process.exit(1);
  });
} else {
  runStdio().catch((err: unknown) => {
    process.stderr.write(`Fatal: ${String(err)}\n`);
    process.exit(1);
  });
}
