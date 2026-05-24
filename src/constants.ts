// src/constants.ts

/** Maximum characters returned in a single tool response before truncation */
export const CHARACTER_LIMIT = 50_000;

/** Default number of results for list operations */
export const DEFAULT_LIMIT = 20;

/** Hard cap on results regardless of user input */
export const MAX_LIMIT = 100;

/** Characters of surrounding context to include in search excerpts */
export const EXCERPT_CONTEXT = 150;

/**
 * Paths/patterns to always exclude when walking the vault.
 * These are Obsidian internals or common dot-directories that
 * contain non-note files (themes, plugins, caches, etc.).
 */
export const VAULT_EXCLUDE_PATTERNS = [
  '**/.obsidian/**',
  '**/.trash/**',
  '**/.git/**',
  '**/node_modules/**',
  '**/*.canvas',   // Obsidian canvas files — not markdown
];

/**
 * Obsidian Tasks plugin checkbox markers → status mapping.
 * The single character inside [ ] determines the task status.
 */
export const TASK_STATUS_MAP: Record<string, import('./types.js').TaskStatus> = {
  ' ': 'open',
  'x': 'done',
  'X': 'done',
  '-': 'cancelled',
  '>': 'forwarded',
  '/': 'in_progress',
  '?': 'scheduled',
};

/**
 * Obsidian Tasks plugin emoji → field mapping.
 * These appear inline in task text.
 */
export const TASK_EMOJI_MAP = {
  '📅': 'dueDate',
  '⏳': 'scheduledDate',
  '✅': 'completedDate',
  '🛫': 'startDate',
} as const;

export const PRIORITY_EMOJI_MAP: Record<string, import('./types.js').TaskPriority> = {
  '🔺': 'highest',
  '⏫': 'high',
  '🔼': 'medium',
  '🔽': 'low',
  '⏬': 'lowest',
};
