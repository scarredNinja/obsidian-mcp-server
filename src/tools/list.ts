// src/tools/list.ts
// Tools for listing and browsing notes without reading full content.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listAllNotes, getRecentNotes } from '../services/vault.js';
import { FolderSchema, LimitSchema } from '../schemas/common.js';

export function registerListTools(server: McpServer): void {
  // ── 1. List notes ───────────────────────────────────────────────────────────
  server.registerTool(
    'obsidian_list_notes',
    {
      title: 'List Notes',
      description: `List notes in the vault, optionally filtered by folder and/or tag.

Returns note metadata (no body content) sorted alphabetically by path.
Use this for browsing before deciding which note to read.

Args:
  - folder (string, optional): Restrict to a vault-relative sub-folder (e.g. "10 - Projects")
  - tag (string, optional): Only include notes with this tag
  - limit (number, default 20): max results

Returns for each note:
  - path, title, tags, modified (ISO timestamp), size (bytes)

Examples:
  - List all project notes: folder="10 - Projects"
  - List backup-related notes: tag="backup"
  - Full vault index: (no filters, increase limit)`,
      inputSchema: z.object({
        folder: FolderSchema,
        tag: z
          .string()
          .optional()
          .describe('Filter by tag (case-insensitive, with or without leading #)'),
        limit: LimitSchema,
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ folder, tag, limit }) => {
      try {
        let notes = await listAllNotes();

        // Folder filter: match path prefix
        if (folder) {
          const prefix = folder.replace(/\/$/, '') + '/';
          notes = notes.filter((n) => n.path.startsWith(prefix));
        }

        // Tag filter
        if (tag) {
          const normalised = tag.replace(/^#/, '').toLowerCase();
          notes = notes.filter((n) =>
            n.tags.some((t) => t.toLowerCase() === normalised),
          );
        }

        const sorted = notes
          .sort((a, b) => a.path.localeCompare(b.path))
          .slice(0, limit);

        if (sorted.length === 0) {
          return {
            content: [{ type: 'text', text: 'No notes found matching the given filters.' }],
            structuredContent: { count: 0, notes: [] },
          };
        }

        const text = sorted
          .map((n, i) =>
            `${i + 1}. **${n.title}**\n   ${n.path}\n   Modified: ${n.modified.toISOString().split('T')[0]} | Tags: ${n.tags.join(', ') || 'none'}`,
          )
          .join('\n\n');

        const structured = {
          count: sorted.length,
          total_before_limit: notes.length,
          notes: sorted.map((n) => ({
            path: n.path,
            title: n.title,
            tags: n.tags,
            modified: n.modified.toISOString(),
            size: n.size,
          })),
        };

        return {
          content: [{
            type: 'text',
            text: `${sorted.length} note(s)${notes.length > limit ? ` (showing first ${limit} of ${notes.length})` : ''}:\n\n${text}`,
          }],
          structuredContent: structured,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  // ── 2. Get recently modified notes ──────────────────────────────────────────
  server.registerTool(
    'obsidian_get_recent',
    {
      title: 'Get Recent Notes',
      description: `Get the most recently modified notes, sorted newest-first.

Useful for catching up on what changed since the last session,
or for finding a note you edited recently without knowing its path.

Args:
  - limit (number, default 10): number of recent notes to return (max 50)

Returns for each note:
  - path, title, tags, modified (ISO timestamp)

Examples:
  - What did I last edit? (default, top 10)
  - Show last 5 changes: limit=5`,
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe('Number of recent notes to return (1–50, default 10)'),
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false, // result changes as files are modified
        openWorldHint: false,
      },
    },
    async ({ limit }) => {
      try {
        const notes = await getRecentNotes(limit);

        if (notes.length === 0) {
          return { content: [{ type: 'text', text: 'No notes found in vault.' }] };
        }

        const text = notes
          .map((n, i) => {
            const ago = relativeTime(n.modified);
            return `${i + 1}. **${n.title}** — ${ago}\n   ${n.path}`;
          })
          .join('\n\n');

        const structured = {
          count: notes.length,
          notes: notes.map((n) => ({
            path: n.path,
            title: n.title,
            tags: n.tags,
            modified: n.modified.toISOString(),
          })),
        };

        return {
          content: [{ type: 'text', text: `Last ${notes.length} modified note(s):\n\n${text}` }],
          structuredContent: structured,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
      }
    },
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}
