// src/tools/read.ts
// Tools for reading individual notes, browsing structure, and exploring links.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  readNote,
  getVaultStructure,
  extractWikiLinks,
  findBacklinks,
  truncate,
} from '../services/vault.js';
import { NotePathSchema, LimitSchema } from '../schemas/common.js';

export function registerReadTools(server: McpServer): void {
  // ── 1. Read a single note ───────────────────────────────────────────────────
  server.registerTool(
    'obsidian_read_note',
    {
      title: 'Read Note',
      description: `Read the full content of a note by its vault-relative path.

Returns:
  - path: vault-relative path
  - title: human-readable title
  - frontmatter: parsed YAML fields as an object
  - tags: merged list of all tags
  - modified: ISO timestamp of last modification
  - body: note body (frontmatter stripped)
  - content: full raw content (including frontmatter block)

Args:
  - path (string): Vault-relative path with .md extension, forward-slash separated
  - include_content (boolean, default true): if false, returns metadata only (faster)

The body is truncated at ${50_000} characters if the note is very large.

Examples:
  - Read a session note: path="10 - Projects/Session Notes — 2026-05-23 — Foo.md"
  - Check a runbook: path="Docker Swarm Infrastructure Runbook.md"

Errors:
  - "Note not found" if path does not exist
  - "Path traversal denied" if path escapes vault root`,
      inputSchema: z.object({
        path: NotePathSchema,
        include_content: z
          .boolean()
          .default(true)
          .describe('If false, return metadata only without the note body (faster for large notes)'),
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path: notePath, include_content }) => {
      try {
        const note = await readNote(notePath);
        const structured = {
          path: note.path,
          title: note.title,
          frontmatter: note.frontmatter,
          tags: note.tags,
          modified: note.modified.toISOString(),
          size: note.size,
          ...(include_content ? { body: truncate(note.body) } : {}),
        };

        const lines: string[] = [
          `# ${note.title}`,
          `**Path:** ${note.path}`,
          `**Modified:** ${note.modified.toISOString()}`,
          `**Tags:** ${note.tags.length > 0 ? note.tags.join(', ') : 'none'}`,
        ];

        const fmEntries = Object.entries(note.frontmatter);
        if (fmEntries.length > 0) {
          lines.push('**Frontmatter:**');
          fmEntries.forEach(([k, v]) => lines.push(`  - ${k}: ${JSON.stringify(v)}`));
        }

        if (include_content) {
          lines.push('', '---', '', truncate(note.body));
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: structured,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  // ── 2. Vault structure ──────────────────────────────────────────────────────
  server.registerTool(
    'obsidian_get_structure',
    {
      title: 'Get Vault Structure',
      description: `Browse the folder and file tree of the vault (or a sub-folder).

Returns a hierarchical tree showing folders and .md files.
Useful for orienting in an unfamiliar vault before choosing a path to read.

Args:
  - folder (string, optional): Vault-relative sub-folder to start from. Omit for full vault.
  - max_depth (number, default 3): How many folder levels deep to expand (1–6)

Returns a nested structure of { name, path, type, children? }.

Examples:
  - See top-level vault layout: (no args)
  - Browse a project folder: folder="10 - Projects"
  - Shallow overview: max_depth=1`,
      inputSchema: z.object({
        folder: z
          .string()
          .optional()
          .describe('Vault-relative sub-folder to browse. Omit for the full vault.'),
        max_depth: z
          .number()
          .int()
          .min(1)
          .max(6)
          .default(3)
          .describe('Maximum folder depth to expand (1–6, default 3)'),
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ folder, max_depth }) => {
      try {
        const tree = await getVaultStructure(folder, max_depth);
        const text = renderTree(tree, 0);
        return {
          content: [{ type: 'text', text: text }],
          structuredContent: tree as unknown as Record<string, unknown>,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  // ── 3. Get wikilinks from a note ────────────────────────────────────────────
  server.registerTool(
    'obsidian_get_links',
    {
      title: 'Get Note Links',
      description: `Extract all [[wikilinks]] from a note's body.

Returns an array of links with:
  - target: the note name as written in [[...]]
  - alias (optional): display text from [[target|alias]]

Useful for understanding a note's connections and navigating to related notes.

Args:
  - path (string): Vault-relative path of the note to inspect

Examples:
  - See what a hub note links to: path="01_Homelab_Rebuild_-_Master_Hub.md"`,
      inputSchema: z.object({
        path: NotePathSchema,
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path: notePath }) => {
      try {
        const note = await readNote(notePath);
        const links = extractWikiLinks(note.body);

        if (links.length === 0) {
          return {
            content: [{ type: 'text', text: `No wikilinks found in "${notePath}"` }],
            structuredContent: { count: 0, links: [] },
          };
        }

        const text = links
          .map((l, i) =>
            l.alias
              ? `${i + 1}. [[${l.target}]] (alias: "${l.alias}")`
              : `${i + 1}. [[${l.target}]]`,
          )
          .join('\n');

        return {
          content: [{ type: 'text', text: `${links.length} link(s) in "${note.title}":\n\n${text}` }],
          structuredContent: { count: links.length, links },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  // ── 4. Find backlinks ───────────────────────────────────────────────────────
  server.registerTool(
    'obsidian_find_backlinks',
    {
      title: 'Find Backlinks',
      description: `Find all notes that contain a [[wikilink]] pointing to the given note.

This is the inverse of obsidian_get_links — it answers "what links TO this note?"

Args:
  - note_name (string): Note name or vault-relative path. The .md extension and
    folder prefix are optional — matching is done on the basename only.
  - limit (number, default 20): max results

Returns list of notes that link to the target, sorted by last modified.

Note: This scans all notes in the vault and may be slow for very large vaults.

Examples:
  - Find all notes that link to the master hub: note_name="01_Homelab_Rebuild_-_Master_Hub"`,
      inputSchema: z.object({
        note_name: z
          .string()
          .min(1)
          .describe('Note name (with or without .md, with or without folder prefix)'),
        limit: LimitSchema,
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ note_name, limit }) => {
      try {
        const raw = await findBacklinks(note_name);
        const results = raw
          .sort((a, b) => b.modified.getTime() - a.modified.getTime())
          .slice(0, limit);

        if (results.length === 0) {
          return {
            content: [{ type: 'text', text: `No notes link to "${note_name}"` }],
            structuredContent: { count: 0, results: [] },
          };
        }

        const text = results
          .map((n, i) => `${i + 1}. **${n.title}** (${n.path})`)
          .join('\n');

        return {
          content: [{
            type: 'text',
            text: `${results.length} note(s) link to "${note_name}":\n\n${text}`,
          }],
          structuredContent: {
            count: results.length,
            results: results.map((n) => ({ path: n.path, title: n.title })),
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
      }
    },
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function renderTree(node: { name: string; type: string; path: string; children?: typeof node[] }, depth: number): string {
  const indent = '  '.repeat(depth);
  const icon = node.type === 'folder' ? '📁' : '📄';
  let out = `${indent}${icon} ${node.name}\n`;
  if (node.children) {
    for (const child of node.children) {
      out += renderTree(child, depth + 1);
    }
  }
  return out;
}
