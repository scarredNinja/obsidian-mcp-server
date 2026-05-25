// src/services/write.ts
//
// Write operations for the vault. All writes are gated behind VAULT_WRITE_FOLDERS —
// if that env var is unset, every write call throws immediately.
//
// Callers (tools) never touch `fs` directly; all path resolution and safety
// checks live here alongside the read layer in vault.ts.

import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { getVaultRoot } from './vault.js';

// ─── Config ───────────────────────────────────────────────────────────────────

/**
 * Parse VAULT_WRITE_FOLDERS env var.
 * Returns null when unset (all writes denied), or an array of allowed folder prefixes.
 */
function getWriteFolders(): string[] | null {
  const raw = process.env['VAULT_WRITE_FOLDERS'];
  if (!raw || !raw.trim()) return null;
  return raw
    .split(',')
    .map((f) => f.trim().replace(/^[/\\]+|[/\\]+$/g, '').split('\\').join('/'))
    .filter(Boolean);
}

// ─── Safety checks ────────────────────────────────────────────────────────────

/**
 * Resolve a vault-relative path to an absolute path, enforcing:
 *   1. VAULT_WRITE_FOLDERS allowlist (throws if not configured or path not in list)
 *   2. Path traversal prevention (path must stay inside vault root)
 *   3. Must end with .md
 *
 * Returns { vaultRoot, clean (OS-sep), absolute, normalised (forward-slash) }.
 */
function resolveWritePath(relativePath: string): {
  vaultRoot: string;
  clean: string;
  absolute: string;
  normalised: string;
} {
  // 1. Write folder gate
  const writeFolders = getWriteFolders();
  if (!writeFolders) {
    throw new Error(
      'Write access is not configured. ' +
      'Set VAULT_WRITE_FOLDERS to a comma-separated list of vault folders that allow writes ' +
      '(e.g. "10 - Projects").',
    );
  }

  // 2. Sanitise input path
  const clean = relativePath.replace(/^[/\\]+/, '').split('/').join(path.sep);
  const normalised = clean.split(path.sep).join('/');

  // 3. Must end with .md
  if (!normalised.endsWith('.md')) {
    throw new Error(`Write path must end with .md — got: "${relativePath}"`);
  }

  // 4. Must be inside an allowed write folder
  const inAllowed = writeFolders.some(
    (folder) => normalised === folder || normalised.startsWith(folder + '/'),
  );
  if (!inAllowed) {
    throw new Error(
      `Write access denied: "${normalised}" is not inside any configured write folder. ` +
      `Allowed: ${writeFolders.map((f) => `"${f}"`).join(', ')}`,
    );
  }

  // 5. Traversal check
  const vaultRoot = getVaultRoot();
  const absolute = path.join(vaultRoot, clean);
  if (!absolute.startsWith(vaultRoot + path.sep) && absolute !== vaultRoot) {
    throw new Error(`Path traversal denied: "${relativePath}" resolves outside vault root`);
  }

  return { vaultRoot, clean, absolute, normalised };
}

// ─── Write operations ─────────────────────────────────────────────────────────

export interface CreateNoteResult {
  path: string;
  created: string; // ISO timestamp
  overwritten: boolean;
}

/**
 * Create a new note (or overwrite an existing one if overwrite=true).
 * Serialises frontmatter as a YAML block at the top; body follows after separator.
 */
export async function createNote(
  relativePath: string,
  frontmatter?: Record<string, unknown>,
  body?: string,
  overwrite = false,
): Promise<CreateNoteResult> {
  const { absolute, normalised } = resolveWritePath(relativePath);

  // Check for existing file
  let exists = false;
  try {
    await fs.stat(absolute);
    exists = true;
  } catch {
    // file does not exist — fine
  }

  if (exists && !overwrite) {
    throw new Error(
      `Note already exists: "${normalised}". Pass overwrite=true to replace it.`,
    );
  }

  // Ensure parent directory exists
  await fs.mkdir(path.dirname(absolute), { recursive: true });

  // Build content string
  const content = matter.stringify(body ?? '', frontmatter ?? {});

  await fs.writeFile(absolute, content, 'utf-8');

  const stat = await fs.stat(absolute);
  return {
    path: normalised,
    created: stat.mtime.toISOString(),
    overwritten: exists,
  };
}

export interface AppendResult {
  path: string;
  appendedBytes: number;
}

/**
 * Append content to an existing note.
 * Adds a blank-line separator before the appended block so the content reads cleanly.
 */
export async function appendToNote(
  relativePath: string,
  content: string,
  ensureNewline = true,
): Promise<AppendResult> {
  const { absolute, normalised } = resolveWritePath(relativePath);

  // File must already exist
  let current: string;
  try {
    current = await fs.readFile(absolute, 'utf-8');
  } catch {
    throw new Error(`Note not found: "${normalised}". Use obsidian_create_note to create it first.`);
  }

  // Build the appended block
  const separator = ensureNewline
    ? (current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n')
    : '';

  const toAppend = separator + content;
  const newContent = current + toAppend;

  await fs.writeFile(absolute, newContent, 'utf-8');

  return {
    path: normalised,
    appendedBytes: Buffer.byteLength(toAppend, 'utf-8'),
  };
}

export interface UpdateFrontmatterResult {
  path: string;
  updatedFields: string[];
}

/**
 * Merge key/value pairs into a note's YAML frontmatter without touching the body.
 * Existing keys are overwritten; keys not in `fields` are left untouched.
 */
export async function updateFrontmatter(
  relativePath: string,
  fields: Record<string, unknown>,
): Promise<UpdateFrontmatterResult> {
  const { absolute, normalised } = resolveWritePath(relativePath);

  let raw: string;
  try {
    raw = await fs.readFile(absolute, 'utf-8');
  } catch {
    throw new Error(`Note not found: "${normalised}"`);
  }

  const parsed = matter(raw);
  const mergedFm = { ...parsed.data, ...fields };

  // Re-serialise: gray-matter.stringify(body, frontmatter) produces ---\nfm\n---\nbody
  const newContent = matter.stringify(parsed.content, mergedFm);
  await fs.writeFile(absolute, newContent, 'utf-8');

  return {
    path: normalised,
    updatedFields: Object.keys(fields),
  };
}
