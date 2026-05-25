// src/services/vault.ts
//
// All filesystem access goes through this module. Tools never touch `fs` directly —
// this keeps the access layer testable and the cross-platform path logic in one place.

import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import glob from 'fast-glob';
import {
  Note,
  NoteMetadata,
  WikiLink,
  VaultNode,
} from '../types.js';
import {
  VAULT_EXCLUDE_PATTERNS,
  EXCERPT_CONTEXT,
  CHARACTER_LIMIT,
} from '../constants.js';

// ─── Config ──────────────────────────────────────────────────────────────────

/**
 * Resolved absolute path to the vault root.
 * Set via VAULT_PATH env var; defaults to current working directory.
 * Docker deployments mount the vault volume to VAULT_PATH (e.g. /vault).
 * Windows stdio deployments set VAULT_PATH=C:\Users\DJ\Documents\Notes\Home
 */
export function getVaultRoot(): string {
  const raw = process.env['VAULT_PATH'];
  if (!raw) {
    throw new Error(
      'VAULT_PATH environment variable is not set. ' +
      'Set it to the absolute path of your Obsidian vault.',
    );
  }
  return path.resolve(raw);
}

/**
 * Parse the VAULT_ALLOWED_FOLDERS env var if defined.
 * Expects comma-separated relative folder paths.
 */
export function getAllowedFolders(): string[] | null {
  const raw = process.env['VAULT_ALLOWED_FOLDERS'];
  if (!raw) return null;
  return raw
    .split(',')
    .map((f) => f.trim().replace(/^[/\\]+|[/\\]+$/g, '').split('\\').join('/'))
    .filter(Boolean);
}

/**
 * Verify if a vault-relative path is inside the allowed folders.
 */
export function isPathAllowed(relativePath: string): boolean {
  const allowed = getAllowedFolders();
  if (!allowed) return true;

  const cleanPath = relativePath.replace(/^[/\\]+|[/\\]+$/g, '').split('\\').join('/');
  if (!cleanPath) return false;

  return allowed.some((folder) => {
    return cleanPath === folder || cleanPath.startsWith(folder + '/');
  });
}

/**
 * Throw an error if a vault-relative path is not inside the allowed folders.
 */
export function assertPathAllowed(relativePath: string): void {
  if (!isPathAllowed(relativePath)) {
    throw new Error(`Access denied: "${relativePath}" is not inside any allowed folder`);
  }
}

/**
 * Verify if a folder/file should be visible in getVaultStructure.
 * A node is visible if it is inside an allowed folder, or is a parent of an allowed folder.
 */
export function isStructureNodeVisible(relativePath: string): boolean {
  const allowed = getAllowedFolders();
  if (!allowed) return true;

  const cleanPath = relativePath.replace(/^[/\\]+|[/\\]+$/g, '').split('\\').join('/');
  if (!cleanPath || cleanPath === '/' || cleanPath === '.') return true;

  return allowed.some((folder) => {
    return cleanPath === folder || cleanPath.startsWith(folder + '/') || folder.startsWith(cleanPath + '/');
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Normalise a vault-relative path to forward slashes (cross-platform display) */
function normalisePath(p: string): string {
  return p.split(path.sep).join('/');
}

/** Derive a human-readable title from the file path and parsed frontmatter */
function deriveTitle(filePath: string, frontmatter: Record<string, unknown>): string {
  if (typeof frontmatter['title'] === 'string' && frontmatter['title'].trim()) {
    return frontmatter['title'].trim();
  }
  return path.basename(filePath, '.md');
}

/** Extract tags from frontmatter + inline #tag occurrences in body */
function extractTags(frontmatter: Record<string, unknown>, body: string): string[] {
  const tags = new Set<string>();

  // Frontmatter: tags can be a string, array of strings, or space-separated string
  const fm = frontmatter['tags'];
  if (Array.isArray(fm)) {
    fm.forEach((t) => { if (typeof t === 'string') tags.add(t.replace(/^#/, '')); });
  } else if (typeof fm === 'string') {
    fm.split(/[\s,]+/).filter(Boolean).forEach((t) => tags.add(t.replace(/^#/, '')));
  }

  // Inline #tags — match #word but skip URLs and code blocks naively
  const inlineTagRe = /(?:^|[\s(])#([a-zA-Z][a-zA-Z0-9_/-]*)/gm;
  let m: RegExpExecArray | null;
  while ((m = inlineTagRe.exec(body)) !== null) {
    if (m[1]) tags.add(m[1]);
  }

  return [...tags].sort();
}

// ─── Core read operations ─────────────────────────────────────────────────────

/** Read a single note by its vault-relative path. Throws if not found. */
export async function readNote(relativePath: string): Promise<Note> {
  const vaultRoot = getVaultRoot();
  // Sanitise: strip leading slash, normalise to OS sep
  const clean = relativePath.replace(/^[/\\]+/, '').split('/').join(path.sep);
  const absolute = path.join(vaultRoot, clean);

  // Enforce allowed folders check
  assertPathAllowed(normalisePath(clean));

  // Prevent path traversal outside vault root
  if (!absolute.startsWith(vaultRoot + path.sep) && absolute !== vaultRoot) {
    throw new Error(`Path traversal denied: "${relativePath}" resolves outside vault root`);
  }

  let raw: string;
  try {
    raw = await fs.readFile(absolute, 'utf-8');
  } catch {
    throw new Error(`Note not found: "${relativePath}"`);
  }

  const stat = await fs.stat(absolute);
  const parsed = matter(raw);
  const frontmatter = parsed.data as Record<string, unknown>;
  const body = parsed.content;

  return {
    path: normalisePath(clean),
    title: deriveTitle(clean, frontmatter),
    frontmatter,
    tags: extractTags(frontmatter, body),
    modified: stat.mtime,
    size: stat.size,
    content: raw,
    body,
  };
}

/** List all markdown notes in the vault. Returns metadata only (no body). */
export async function listAllNotes(): Promise<NoteMetadata[]> {
  const vaultRoot = getVaultRoot();

  let files = await glob('**/*.md', {
    cwd: vaultRoot,
    ignore: VAULT_EXCLUDE_PATTERNS,
    absolute: false,
  });

  const allowed = getAllowedFolders();
  if (allowed) {
    files = files.filter((f) => isPathAllowed(f));
  }

  const notes = await Promise.all(
    files.map(async (relativePath): Promise<NoteMetadata> => {
      const absolute = path.join(vaultRoot, relativePath);
      const raw = await fs.readFile(absolute, 'utf-8');
      const stat = await fs.stat(absolute);
      const parsed = matter(raw);
      const frontmatter = parsed.data as Record<string, unknown>;

      return {
        path: normalisePath(relativePath),
        title: deriveTitle(relativePath, frontmatter),
        frontmatter,
        tags: extractTags(frontmatter, parsed.content),
        modified: stat.mtime,
        size: stat.size,
      };
    }),
  );

  return notes;
}

// ─── Search ───────────────────────────────────────────────────────────────────

export interface TextSearchOptions {
  query: string;
  /** If true, treat query as a regex pattern */
  regex?: boolean;
  /** If true, match case-sensitively */
  caseSensitive?: boolean;
  /** Restrict search to notes under this vault-relative folder */
  folder?: string;
  limit?: number;
}

export interface TextSearchResult {
  path: string;
  title: string;
  excerpt: string;
  line: number;
  matchCount: number;
}

export async function searchText(opts: TextSearchOptions): Promise<TextSearchResult[]> {
  const vaultRoot = getVaultRoot();
  const { query, regex = false, caseSensitive = false, folder, limit = 20 } = opts;

  if (folder) {
    assertPathAllowed(folder);
  }

  const pattern = folder
    ? `${folder.replace(/\/$/, '')}/**/*.md`
    : '**/*.md';

  let files = await glob(pattern, {
    cwd: vaultRoot,
    ignore: VAULT_EXCLUDE_PATTERNS,
    absolute: false,
  });

  const allowed = getAllowedFolders();
  if (allowed) {
    files = files.filter((f) => isPathAllowed(f));
  }

  let re: RegExp;
  try {
    const flags = caseSensitive ? 'g' : 'gi';
    re = regex ? new RegExp(query, flags) : new RegExp(escapeRegex(query), flags);
  } catch {
    throw new Error(`Invalid regex pattern: "${query}"`);
  }

  const results: TextSearchResult[] = [];

  for (const relativePath of files) {
    if (results.length >= limit) break;

    const absolute = path.join(vaultRoot, relativePath);
    let raw: string;
    try {
      raw = await fs.readFile(absolute, 'utf-8');
    } catch {
      continue;
    }

    const parsed = matter(raw);
    const frontmatter = parsed.data as Record<string, unknown>;
    const lines = raw.split('\n');

    let matchCount = 0;
    let firstMatchLine = -1;
    let excerpt = '';

    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      if (re.test(lines[i] ?? '')) {
        matchCount++;
        if (firstMatchLine === -1) {
          firstMatchLine = i + 1; // 1-indexed
          const start = Math.max(0, i - 1);
          const end = Math.min(lines.length - 1, i + 2);
          const ctx = lines.slice(start, end + 1).join('\n');
          excerpt = ctx.length > EXCERPT_CONTEXT * 2
            ? ctx.slice(0, EXCERPT_CONTEXT * 2) + '…'
            : ctx;
        }
      }
    }

    if (matchCount > 0) {
      results.push({
        path: normalisePath(relativePath),
        title: deriveTitle(relativePath, frontmatter),
        excerpt,
        line: firstMatchLine,
        matchCount,
      });
    }
  }

  return results;
}

// ─── Frontmatter / tag filtering ─────────────────────────────────────────────

/** Find notes where frontmatter[field] equals value (string equality) */
export async function findByFrontmatter(
  field: string,
  value: string,
): Promise<NoteMetadata[]> {
  const all = await listAllNotes();
  return all.filter((n) => {
    const v = n.frontmatter[field];
    if (Array.isArray(v)) {
      return v.some((item) => String(item) === value);
    }
    return String(v ?? '') === value;
  });
}

/** Find notes that include a specific tag */
export async function findByTag(tag: string): Promise<NoteMetadata[]> {
  const normalised = tag.replace(/^#/, '').toLowerCase();
  const all = await listAllNotes();
  return all.filter((n) =>
    n.tags.some((t) => t.toLowerCase() === normalised),
  );
}

// ─── Recent notes ─────────────────────────────────────────────────────────────

export async function getRecentNotes(limit: number): Promise<NoteMetadata[]> {
  const all = await listAllNotes();
  return all
    .sort((a, b) => b.modified.getTime() - a.modified.getTime())
    .slice(0, limit);
}

// ─── Vault structure ──────────────────────────────────────────────────────────

export async function getVaultStructure(
  subfolder?: string,
  maxDepth = 3,
): Promise<VaultNode> {
  if (subfolder) {
    assertPathAllowed(subfolder);
  }

  const vaultRoot = getVaultRoot();
  const startPath = subfolder
    ? path.join(vaultRoot, subfolder.split('/').join(path.sep))
    : vaultRoot;

  async function walk(dir: string, depth: number): Promise<VaultNode> {
    const name = path.basename(dir);
    const relative = normalisePath(path.relative(vaultRoot, dir));
    const node: VaultNode = {
      name,
      path: relative || '/',
      type: 'folder',
      children: [],
    };

    if (depth <= 0) return node;

    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return node;
    }

    for (const entry of entries) {
      // Skip hidden directories (includes .obsidian, .git, etc.)
      if (entry.name.startsWith('.')) continue;
      if (entry.name === 'node_modules') continue;

      const childPath = path.join(dir, entry.name);
      const childRelative = normalisePath(path.relative(vaultRoot, childPath));

      // Filter children by allowed visibility
      if (!isStructureNodeVisible(childRelative)) continue;

      if (entry.isDirectory()) {
        const child = await walk(childPath, depth - 1);
        node.children?.push(child);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        node.children?.push({
          name: entry.name,
          path: normalisePath(path.relative(vaultRoot, childPath)),
          type: 'file',
        });
      }
    }

    // Sort: folders first, then files, both alphabetically
    node.children?.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return node;
  }

  return walk(startPath, maxDepth);
}

// ─── Wikilinks ────────────────────────────────────────────────────────────────

/** Extract all [[wikilinks]] from a note's body */
export function extractWikiLinks(body: string): WikiLink[] {
  const re = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g;
  const links: WikiLink[] = [];
  let m: RegExpExecArray | null;

  while ((m = re.exec(body)) !== null) {
    if (m[1]) {
      links.push({
        target: m[1].trim(),
        ...(m[2] ? { alias: m[2].trim() } : {}),
      });
    }
  }

  return links;
}

/** Find all notes that contain a [[wikilink]] to the given note name */
export async function findBacklinks(noteName: string): Promise<NoteMetadata[]> {
  const target = path.basename(noteName, '.md').toLowerCase();
  const all = await listAllNotes();

  const results = await Promise.all(
    all.map(async (meta): Promise<NoteMetadata | null> => {
      try {
        const note = await readNote(meta.path);
        
        // Fast-path: if the target note name is not even a substring in the body, skip parsing
        if (!note.body.toLowerCase().includes(target)) {
          return null;
        }

        const links = extractWikiLinks(note.body);
        if (links.some((l) => l.target.toLowerCase() === target)) {
          return meta;
        }
      } catch {
        // Safe fallback for unreadable/locked notes
      }
      return null;
    })
  );

  return results.filter((meta): meta is NoteMetadata => meta !== null);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Truncate a string to CHARACTER_LIMIT with a clear suffix */
export function truncate(s: string): string {
  if (s.length <= CHARACTER_LIMIT) return s;
  return s.slice(0, CHARACTER_LIMIT) + `\n\n[… truncated at ${CHARACTER_LIMIT} chars]`;
}
