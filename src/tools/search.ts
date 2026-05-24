// src/tools/search.ts
// Three tools: text search, tag search, frontmatter field search.
// All read-only; results are paginated via `limit`.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  searchText,
  findByTag,
  findByFrontmatter,
} from '../services/vault.js';
import { FolderSchema, LimitSchema } from '../schemas/common.js';

export function registerSearchTools(server: McpServer): void {
  // ── 1. Full-text search ─────────────────────────────────────────────────────
  server.registerTool(
    'obsidian_search',
    {
      title: 'Search Notes',
      description: `Full-text search across all markdown notes in the vault.

Returns a list of matching notes with:
- path: vault-relative path (use with obsidian_read_note)
- title: human-readable note title
- excerpt: ~3 lines of context around the first match
- line: 1-indexed line number of the first match
- matchCount: total matches in the file

Args:
  - query (string): Text or regex pattern to search for
  - regex (boolean, default false): treat query as a regex pattern
  - case_sensitive (boolean, default false): case-sensitive matching
  - folder (string, optional): restrict to a vault sub-folder
  - limit (number, default 20): max results to return

Examples:
  - Find all notes mentioning "Tailscale": query="tailscale"
  - Find open tasks by pattern: query="^- \\\\[ \\\\]", regex=true
  - Search within a project: query="docker swarm", folder="10 - Projects"

Returns empty array if no matches found.`,
      inputSchema: z.object({
        query: z.string().min(1).describe('Search string or regex pattern'),
        regex: z
          .boolean()
          .default(false)
          .describe('If true, treat query as a regex pattern'),
        case_sensitive: z
          .boolean()
          .default(false)
          .describe('If true, perform case-sensitive matching'),
        folder: FolderSchema,
        limit: LimitSchema,
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, regex, case_sensitive, folder, limit }) => {
      try {
        const results = await searchText({
          query,
          regex,
          caseSensitive: case_sensitive,
          folder,
          limit,
        });

        if (results.length === 0) {
          return {
            content: [{ type: 'text', text: `No notes found matching "${query}"` }],
          };
        }

        const structured = { count: results.length, results };
        const text = results
          .map(
            (r, i) =>
              `${i + 1}. **${r.title}** (${r.path})\n` +
              `   Line ${r.line}, ${r.matchCount} match(es)\n` +
              `   > ${r.excerpt.replace(/\n/g, '\n   > ')}`,
          )
          .join('\n\n');

        return {
          content: [{ type: 'text', text: `Found ${results.length} note(s):\n\n${text}` }],
          structuredContent: structured,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  // ── 2. Find by tag ──────────────────────────────────────────────────────────
  server.registerTool(
    'obsidian_find_by_tag',
    {
      title: 'Find Notes by Tag',
      description: `Find all notes that have a specific tag, either in YAML frontmatter or as an inline #tag.

The tag match is case-insensitive. Strip the leading # if present.

Args:
  - tag (string): Tag to search for (e.g. "homelab" or "#homelab")
  - limit (number, default 20): max results

Returns list of notes sorted by last modified (newest first):
  - path, title, tags (all tags on that note), modified

Examples:
  - All notes tagged "backup": tag="backup"
  - All project notes: tag="project"`,
      inputSchema: z.object({
        tag: z.string().min(1).describe('Tag to search for, with or without leading #'),
        limit: LimitSchema,
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ tag, limit }) => {
      try {
        const raw = await findByTag(tag);
        const results = raw
          .sort((a, b) => b.modified.getTime() - a.modified.getTime())
          .slice(0, limit);

        if (results.length === 0) {
          return {
            content: [{ type: 'text', text: `No notes found with tag "${tag}"` }],
          };
        }

        const structured = { count: results.length, results: results.map(metaSummary) };
        const text = results
          .map((n, i) => `${i + 1}. **${n.title}** (${n.path})\n   Tags: ${n.tags.join(', ')}`)
          .join('\n');

        return {
          content: [{ type: 'text', text: `Found ${results.length} note(s) tagged "${tag}":\n\n${text}` }],
          structuredContent: structured,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  // ── 3. Find by frontmatter field ────────────────────────────────────────────
  server.registerTool(
    'obsidian_find_by_frontmatter',
    {
      title: 'Find Notes by Frontmatter Field',
      description: `Find all notes where a YAML frontmatter field equals a specific value.

Useful for querying notes by project_id, status, phase, session_type, or any custom field.

Args:
  - field (string): Frontmatter key name (e.g. "project_id", "status", "phase")
  - value (string): Expected value — string comparison, no type coercion
  - limit (number, default 20): max results

Returns list of matching notes with their full frontmatter included.

Examples:
  - All notes for Homelab project: field="project_id", value="Homelab-2025"
  - All in-progress sessions: field="status", value="in-progress"
  - Notes in phase 7: field="phase", value="7"`,
      inputSchema: z.object({
        field: z.string().min(1).describe('YAML frontmatter field name to match on'),
        value: z.string().describe('Expected field value (string equality)'),
        limit: LimitSchema,
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ field, value, limit }) => {
      try {
        const raw = await findByFrontmatter(field, value);
        const results = raw
          .sort((a, b) => b.modified.getTime() - a.modified.getTime())
          .slice(0, limit);

        if (results.length === 0) {
          return {
            content: [{
              type: 'text',
              text: `No notes found where frontmatter "${field}" = "${value}"`,
            }],
          };
        }

        const structured = { count: results.length, results: results.map(metaSummary) };
        const text = results
          .map((n, i) => {
            const fm = Object.entries(n.frontmatter)
              .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
              .join(', ');
            return `${i + 1}. **${n.title}** (${n.path})\n   Frontmatter: ${fm}`;
          })
          .join('\n\n');

        return {
          content: [{
            type: 'text',
            text: `Found ${results.length} note(s) where ${field}="${value}":\n\n${text}`,
          }],
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

function metaSummary(n: { path: string; title: string; tags: string[]; modified: Date }) {
  return {
    path: n.path,
    title: n.title,
    tags: n.tags,
    modified: n.modified.toISOString(),
  };
}
