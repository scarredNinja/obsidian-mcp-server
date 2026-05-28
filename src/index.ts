// src/index.ts
// Single entry point. Transport is selected via TRANSPORT env var:
//   TRANSPORT=stdio (default) — Claude Desktop / local dev
//   TRANSPORT=http            — Swarm container / remote clients

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import fs from 'node:fs';
import { randomUUID, createHmac } from 'node:crypto';
import path from 'node:path';
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
  
  // Parse JSON bodies and capture raw body for secure GitHub webhook signature checks
  app.use(express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    }
  }));

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
      write_folders: process.env['VAULT_WRITE_FOLDERS'] ?? 'disabled',
    });
  });

  // Global stateful Streamable HTTP server transport
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
  });
  await server.connect(transport);

  // Stateful MCP endpoint — delegates all GET/POST requests to the global transport.
  app.post('/mcp', verifyApiKey, async (req, res) => {
    await transport.handleRequest(req, res, req.body);
  });

  // Webhook endpoint for Git push events
  app.post('/webhook', (req: express.Request & { rawBody?: Buffer }, res: express.Response) => {
    // 1. Verify GitHub Webhook Secret if configured
    const webhookSecret = process.env['GITHUB_WEBHOOK_SECRET'];
    if (webhookSecret) {
      const signature = req.get('x-hub-signature-256');
      if (!signature) {
        res.status(401).json({ error: 'Missing x-hub-signature-256 header' });
        return;
      }
      
      if (!req.rawBody) {
        res.status(400).json({ error: 'Missing raw body for signature verification' });
        return;
      }
      
      const hmac = createHmac('sha256', webhookSecret);
      const digest = 'sha256=' + hmac.update(req.rawBody).digest('hex');
      
      if (signature !== digest) {
        res.status(401).json({ error: 'Invalid webhook signature' });
        return;
      }
    }

    // 2. Write trigger file to vault
    const vaultPath = process.env['VAULT_PATH'];
    if (!vaultPath) {
      res.status(500).json({ error: 'VAULT_PATH not configured' });
      return;
    }

    const triggerFile = path.join(vaultPath, '.sync-trigger.json');

    try {
      const triggerData = {
        event: 'push',
        timestamp: new Date().toISOString(),
        repository: req.body?.repository?.full_name ?? 'unknown',
        ref: req.body?.ref ?? 'unknown',
        after: req.body?.after ?? 'unknown'
      };
      
      fs.writeFileSync(triggerFile, JSON.stringify(triggerData, null, 2), 'utf8');
      
      const log = {
        timestamp: new Date().toISOString(),
        message: 'Webhook trigger file written successfully',
        repository: triggerData.repository,
        ref: triggerData.ref
      };
      process.stdout.write(JSON.stringify(log) + '\n');
      
      res.status(200).json({ status: 'triggered' });
    } catch (err) {
      process.stderr.write(`Error writing trigger file: ${String(err)}\n`);
      res.status(500).json({ error: `Failed to write trigger file: ${String(err)}` });
    }
  });

  app.listen(PORT, () => {
    process.stderr.write(`obsidian-mcp-server running (http) on port ${PORT}\n`);
    process.stderr.write(`Health: http://localhost:${PORT}/health\n`);
    process.stderr.write(`MCP endpoint: http://localhost:${PORT}/mcp\n`);
    const writeFolders = process.env['VAULT_WRITE_FOLDERS'];
    const writeMsg = !writeFolders
      ? 'Write access: disabled (VAULT_WRITE_FOLDERS not set)'
      : writeFolders.trim() === '*'
        ? 'Write access: all folders (*)'
        : `Write access enabled for: ${writeFolders}`;
    process.stderr.write(writeMsg + '\n');
  });
}

// ── Bootstrap ──────────────────────────────────────────────────────────────────

function loadSecrets(): void {
  const mcpSecretPath = '/run/secrets/mcp_api_key';
  if (fs.existsSync(mcpSecretPath)) {
    try {
      process.env['MCP_API_KEY'] = fs.readFileSync(mcpSecretPath, 'utf8').trim();
    } catch (err) {
      process.stderr.write(`Warning: Failed to read secret from ${mcpSecretPath}: ${String(err)}\n`);
    }
  }

  const webhookSecretPath = '/run/secrets/github_webhook_secret';
  if (fs.existsSync(webhookSecretPath)) {
    try {
      process.env['GITHUB_WEBHOOK_SECRET'] = fs.readFileSync(webhookSecretPath, 'utf8').trim();
    } catch (err) {
      process.stderr.write(`Warning: Failed to read secret from ${webhookSecretPath}: ${String(err)}\n`);
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
