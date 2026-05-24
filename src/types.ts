// src/types.ts
// All data structures flowing through the MCP server.
// Keep this file as the single source of truth for shapes.

export interface NoteMetadata {
  /** Path relative to vault root, always forward-slash separated */
  path: string;
  /** Human-readable title: frontmatter `title` field, or filename without extension */
  title: string;
  /** Parsed YAML frontmatter — values are unknown until the caller narrows them */
  frontmatter: Record<string, unknown>;
  /** Merged tags from frontmatter `tags` array and inline #tags in body */
  tags: string[];
  modified: Date;
  /** File size in bytes */
  size: number;
}

export interface Note extends NoteMetadata {
  /** Raw file content including frontmatter block */
  content: string;
  /** Content with frontmatter stripped */
  body: string;
}

export interface SearchResult {
  path: string;
  title: string;
  /** Surrounding text context around the match */
  excerpt: string;
  /** 1-indexed line number of the first match */
  line: number;
  /** Total number of matches in the file */
  matchCount: number;
}

export type TaskStatus =
  | 'open'        // - [ ]
  | 'done'        // - [x]
  | 'cancelled'   // - [-]
  | 'forwarded'   // - [>]
  | 'in_progress' // - [/]
  | 'scheduled';  // - [?]

export type TaskPriority = 'highest' | 'high' | 'medium' | 'low' | 'lowest';

export interface Task {
  text: string;
  status: TaskStatus;
  dueDate?: string;        // ISO date string YYYY-MM-DD
  scheduledDate?: string;
  completedDate?: string;
  startDate?: string;
  priority?: TaskPriority;
  notePath: string;
  lineNumber: number;
  /** Tags embedded in the task text */
  tags: string[];
}

export interface VaultNode {
  name: string;
  /** Path relative to vault root */
  path: string;
  type: 'file' | 'folder';
  children?: VaultNode[];
}

export interface WikiLink {
  /** The target note name as written in [[...]] */
  target: string;
  /** Optional display alias [[target|alias]] */
  alias?: string;
}
