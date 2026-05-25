// src/server.ts
// McpServer factory. Keeps index.ts clean — transport selection lives there,
// server construction and tool registration lives here.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerSearchTools } from './tools/search.js';
import { registerReadTools } from './tools/read.js';
import { registerListTools } from './tools/list.js';
import { registerTaskTools } from './tools/tasks.js';
import { registerWriteTools } from './tools/write.js';

export function createServer(): McpServer {
  const vaultName = process.env['VAULT_NAME'] ?? 'Obsidian Vault';

  const server = new McpServer({
    name: 'obsidian-mcp-server',
    version: '1.1.0',
  });

  // Register all tool groups
  registerSearchTools(server);
  registerReadTools(server);
  registerListTools(server);
  registerTaskTools(server);
  registerWriteTools(server);

  return server;
}
