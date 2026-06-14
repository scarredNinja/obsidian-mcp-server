// src/client-bridge.ts
// A lightweight stdio-to-HTTP/SSE bridge for the Model Context Protocol.
// Pipes newline-delimited JSON-RPC messages from stdin to the remote HTTP server,
// and writes responses to stdout.

import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';

const URL = process.env['OBSIDIAN_MCP_URL'] || 'https://obsidian-mcp.home.purvishome.com/mcp';
const API_KEY = process.env['OBSIDIAN_MCP_API_KEY'] || 'e821a784396fe3f04bbcd49813267d08';

const LOG_FILE = path.join('C:', 'Users', 'DJ', 'source', 'repos', 'obsidian-mcp-server', 'bridge.log');

let sessionId: string | null = null;

function logDebug(msg: string): void {
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
  } catch {
    // Ignore logging failures
  }
}

// Clean non-ASCII characters to prevent stdout encoding corruption on Windows
function sanitizeJsonString(str: string): string {
  return str.replace(/[^\x00-\x7F]/g, '');
}

logDebug('Bridge initialized');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  logDebug(`Request: ${trimmed}`);

  let parsed: any = null;
  let messageId: string | number | null = null;
  try {
    parsed = JSON.parse(trimmed);
    messageId = parsed.id ?? null;
  } catch (err) {
    logDebug(`Parse error: ${String(err)}`);
    const errResponse = {
      jsonrpc: '2.0',
      error: {
        code: -32700,
        message: `Parse error: ${String(err)}`,
      },
      id: null,
    };
    process.stdout.write(JSON.stringify(errResponse) + '\n');
    return;
  }

  const isNotification = messageId === null || messageId === undefined;

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'x-api-key': API_KEY,
    };

    if (sessionId) {
      headers['mcp-session-id'] = sessionId;
    }

    logDebug(`Sending to ${URL} (Session: ${sessionId ?? 'None'}): ${trimmed}`);

    const res = await fetch(URL, {
      method: 'POST',
      headers,
      body: trimmed,
    });

    const mcpSessionId = res.headers.get('mcp-session-id');
    if (mcpSessionId) {
      sessionId = mcpSessionId;
    }

    if (!res.ok) {
      const errText = await res.text();
      logDebug(`HTTP Error ${res.status}: ${errText}`);
      
      if (res.status === 404 || errText.includes('Session not found')) {
        logDebug('Clearing invalid session ID due to Session not found error');
        sessionId = null;
      }
      
      // Never write responses to stdout for notifications
      if (!isNotification) {
        const errResponse = {
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: `Remote HTTP error ${res.status}: ${errText}`,
          },
          id: messageId,
        };
        process.stdout.write(JSON.stringify(errResponse) + '\n');
      }
      return;
    }

    const text = await res.text();
    logDebug(`Received raw text response (Length: ${text.length})`);

    // Handle empty response bodies (common for notifications like initialized)
    if (!text.trim()) {
      logDebug(`Empty body received`);
      if (!isNotification) {
        const nullResponse = {
          jsonrpc: '2.0',
          result: null,
          id: messageId,
        };
        process.stdout.write(JSON.stringify(nullResponse) + '\n');
      }
      return;
    }

    // Only parse and output if we expect a response
    const json = JSON.parse(text);
    const jsonString = JSON.stringify(json);
    const sanitizedString = sanitizeJsonString(jsonString);

    if (!isNotification) {
      logDebug(`Outputting sanitized JSON: ${sanitizedString.slice(0, 150)}...`);
      process.stdout.write(sanitizedString + '\n');
    } else {
      logDebug(`Received response for notification, ignoring output to stdout`);
    }
  } catch (err) {
    logDebug(`Exception: ${String(err)}`);
    
    // Never write responses to stdout for notifications
    if (!isNotification) {
      const errResponse = {
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: `Local bridge error: ${String(err)}`,
        },
        id: messageId,
      };
      process.stdout.write(JSON.stringify(errResponse) + '\n');
    }
  }
});
