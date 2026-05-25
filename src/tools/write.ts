// src/tools/write.ts
// Three write tools: create, append, frontmatter patch.
//
// All writes are gated by VAULT_WRITE_FOLDERS — if the env var is unset or the
// target path is outside the allowed folders, the tool returns an error.
// No note deletion or rename in this module.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { NotePathSchema } from '../schemas/common.js';
import {
  createNote,
  appendToNote,
  updateFrontmatter,
} from '../services/write.js';

export function registerWriteTools(server: McpServer): void {

  // ── 1. Create note ─────────────────────────────────────────────────────────
  server.registerTool(
    'obsidian_create_note',
    {
      title: 'Create Note',
      description: `Create a new markdown note in the vault.

Writes a YAML frontmatter block (if provided) followed by the note body.
The target path must be inside a write-allowed folder (configured via VAULT_WRITE_FOLDERS).

Args:
  - path (string): Vault-relative path with .md extension (e.g. "10 - Projects/My Note.md")
  - frontmatter (object, optional): Key/value pairs written as YAML frontmatter
  - body (string, optional): Markdown body text
  - overwrite (boolean, default false): Replace the note if it already exists

Returns:
  - path: vault-relative path of the created note
  - created: ISO timestamp
  - overwritten: true if an existing note was replaced

Errors:
  - "Note already exists" if overwrite=false and the file is present
  - "Write access denied" if the path is outside VAULT_WRITE_FOLDERS
  - "Write access is not configured" if VAULT_WRITE_FOLDERS is unset

Examples:
  - Create a session note: path="10 - Projects/Session Notes — 2026-06-01 — My Task.md",
    frontmatter={tags:["session-note","homelab"], project_id:"Homelab-2025"}
  - Quick scratch note: path="10 - Projects/Scratch.md", body="## TODO\\n- [ ] First task"`,
      inputSchema: z.object({
        path: NotePathSchema,
        frontmatter: z
          .record(z.unknown())
          .optional()
          .describe('YAML frontmatter fields as a key/value object'),
        body: z
          .string()
          .optional()
          .describe('Markdown body of the note (plain text, no frontmatter block)'),
        overwrite: z
          .boolean()
          .default(false)
          .describe('If true, replace the note if it already exists'),
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ path: notePath, frontmatter, body, overwrite }) => {
      try {
        const result = await createNote(notePath, frontmatter, body, overwrite);
        const action = result.overwritten ? 'Overwrote' : 'Created';
        return {
          content: [{
            type: 'text',
            text: `${action} note at "${result.path}" (${result.created})`,
          }],
          structuredContent: { ...result },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  // ── 2. Append to note ──────────────────────────────────────────────────────
  server.registerTool(
    'obsidian_append_to_note',
    {
      title: 'Append to Note',
      description: `Append content to the end of an existing note.

Adds a blank-line separator before the appended block so the content reads cleanly
in Obsidian. Does not touch the frontmatter or existing body.

Args:
  - path (string): Vault-relative path of the note to append to
  - content (string): Markdown text to append
  - ensure_newline (boolean, default true): Add a blank line before the appended content

Returns:
  - path: vault-relative path
  - appendedBytes: number of bytes appended

Errors:
  - "Note not found" if the note does not exist (use obsidian_create_note first)
  - "Write access denied" if path is outside VAULT_WRITE_FOLDERS

Examples:
  - Add a post-session note: path="10 - Projects/Session Notes — 2026-06-01 — My Task.md",
    content="## Post-session\\n- Deployed stack\\n- Verified service 1/1"
  - Append a task: path="10 - Projects/Backlog.md", content="- [ ] Fix Pi-hole wildcard DNS"`,
      inputSchema: z.object({
        path: NotePathSchema,
        content: z
          .string()
          .min(1)
          .describe('Markdown content to append to the end of the note'),
        ensure_newline: z
          .boolean()
          .default(true)
          .describe('If true, ensure a blank line separates existing content from the appended block'),
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ path: notePath, content, ensure_newline }) => {
      try {
        const result = await appendToNote(notePath, content, ensure_newline);
        return {
          content: [{
            type: 'text',
            text: `Appended ${result.appendedBytes} bytes to "${result.path}"`,
          }],
          structuredContent: { ...result },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  // ── 3. Update frontmatter ──────────────────────────────────────────────────
  server.registerTool(
    'obsidian_update_frontmatter',
    {
      title: 'Update Frontmatter',
      description: `Patch YAML frontmatter fields in an existing note without touching the body.

Merges the provided fields into the existing frontmatter (shallow merge).
Keys you supply overwrite existing values; keys you omit are left unchanged.
Use this to update status, tags, dates, or any custom field.

Args:
  - path (string): Vault-relative path of the note to update
  - fields (object): Key/value pairs to set in frontmatter (string, number, array, or boolean values)

Returns:
  - path: vault-relative path
  - updatedFields: list of field names that were written

Errors:
  - "Note not found" if the note does not exist
  - "Write access denied" if path is outside VAULT_WRITE_FOLDERS

Examples:
  - Mark a service note as verified:
    path="10 - Projects/Service - obsidian-mcp-server.md",
    fields={service_status:"running", last_updated:"2026-06-01"}
  - Add tags to a session note:
    path="10 - Projects/Session Notes — 2026-06-01 — Foo.md",
    fields={tags:["session-note","homelab","completed"]}`,
      inputSchema: z.object({
        path: NotePathSchema,
        fields: z
          .record(z.unknown())
          .describe('Frontmatter key/value pairs to set. Existing keys are overwritten; others are preserved.'),
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path: notePath, fields }) => {
      try {
        const result = await updateFrontmatter(notePath, fields);
        return {
          content: [{
            type: 'text',
            text: `Updated frontmatter in "${result.path}": ${result.updatedFields.join(', ')}`,
          }],
          structuredContent: { ...result },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
      }
    },
  );
}
