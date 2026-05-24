// src/tools/tasks.ts
// Extract tasks using Obsidian Tasks plugin syntax.
// Supports: status checkboxes, emoji date fields, emoji priorities, inline tags.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listAllNotes, readNote } from '../services/vault.js';
import { FolderSchema, LimitSchema } from '../schemas/common.js';
import {
  TASK_STATUS_MAP,
  TASK_EMOJI_MAP,
  PRIORITY_EMOJI_MAP,
} from '../constants.js';
import { Task, TaskStatus, TaskPriority } from '../types.js';

// ── Parser ────────────────────────────────────────────────────────────────────

const TASK_LINE_RE = /^[-*] \[(.)\] (.+)$/;
const INLINE_TAG_RE = /(?:^|\s)#([a-zA-Z][a-zA-Z0-9_/-]*)/g;
const DATE_RE = /(\d{4}-\d{2}-\d{2})/;

function parseTaskLine(line: string, lineNumber: number, notePath: string): Task | null {
  const match = TASK_LINE_RE.exec(line.trim());
  if (!match) return null;

  const [, marker, rawText] = match;
  const status: TaskStatus = TASK_STATUS_MAP[marker ?? ' '] ?? 'open';

  let text = rawText ?? '';
  const task: Task = { text, status, notePath, lineNumber, tags: [] };

  // Extract emoji date fields — consume them from the text
  for (const [emoji, field] of Object.entries(TASK_EMOJI_MAP)) {
    const idx = text.indexOf(emoji);
    if (idx !== -1) {
      const after = text.slice(idx + emoji.length).trim();
      const dateMatch = DATE_RE.exec(after);
      if (dateMatch?.[1]) {
        (task as unknown as Record<string, unknown>)[field] = dateMatch[1];
        text = text.replace(emoji + (dateMatch[1] ? ` ${dateMatch[1]}` : ''), '').trim();
      }
    }
  }

  // Extract priority emojis
  for (const [emoji, priority] of Object.entries(PRIORITY_EMOJI_MAP)) {
    if (text.includes(emoji)) {
      task.priority = priority as TaskPriority;
      text = text.replace(emoji, '').trim();
    }
  }

  // Extract inline tags
  let tagMatch: RegExpExecArray | null;
  const tagRe = new RegExp(INLINE_TAG_RE.source, 'g');
  while ((tagMatch = tagRe.exec(text)) !== null) {
    if (tagMatch[1]) task.tags.push(tagMatch[1]);
  }

  task.text = text.trim();
  return task;
}

async function extractTasksFromNotes(opts: {
  folder?: string;
  status?: TaskStatus;
  tag?: string;
  limit: number;
}): Promise<Task[]> {
  const { folder, status, tag, limit } = opts;

  let notes = await listAllNotes();

  if (folder) {
    const prefix = folder.replace(/\/$/, '') + '/';
    notes = notes.filter((n) => n.path.startsWith(prefix));
  }

  const tasks: Task[] = [];

  for (const meta of notes) {
    if (tasks.length >= limit * 3) break; // over-fetch before filtering

    const note = await readNote(meta.path);
    const lines = note.body.split('\n');

    lines.forEach((line, idx) => {
      const task = parseTaskLine(line, idx + 1, meta.path);
      if (!task) return;
      if (status && task.status !== status) return;
      if (tag) {
        const norm = tag.replace(/^#/, '').toLowerCase();
        if (!task.tags.some((t) => t.toLowerCase() === norm)) return;
      }
      tasks.push(task);
    });
  }

  return tasks.slice(0, limit);
}

// ── Tool registration ─────────────────────────────────────────────────────────

export function registerTaskTools(server: McpServer): void {
  server.registerTool(
    'obsidian_get_tasks',
    {
      title: 'Get Tasks',
      description: `Extract tasks from vault notes using Obsidian Tasks plugin format.

Parses task lines like:
  - [ ] Open task
  - [x] Done task ✅ 2026-05-20
  - [-] Cancelled task
  - [/] In-progress task
  - [>] Forwarded task
  - [ ] Task with due date 📅 2026-06-01
  - [ ] High priority task ⏫
  - [ ] Tagged task #homelab #backup

Supported emoji fields: 📅 due, ⏳ scheduled, ✅ completed, 🛫 start
Priority emojis: 🔺 highest, ⏫ high, 🔼 medium, 🔽 low, ⏬ lowest

Args:
  - status ('open'|'done'|'cancelled'|'forwarded'|'in_progress'|'scheduled'|optional):
      Filter by task status. Omit for all statuses.
  - folder (string, optional): Restrict to a vault sub-folder
  - tag (string, optional): Only tasks with this inline tag
  - limit (number, default 50): max results

Returns for each task:
  - text: cleaned task text (emojis stripped)
  - status: parsed status
  - notePath: which note it came from
  - lineNumber: 1-indexed line in that note
  - dueDate, scheduledDate, completedDate, startDate (when present)
  - priority (when present)
  - tags: inline tags from task text

Examples:
  - All open tasks: status="open"
  - Homelab open tasks: status="open", folder="10 - Projects"
  - All tasks tagged backup: tag="backup"
  - Everything due soon (sort/filter yourself): status="open"`,
      inputSchema: z.object({
        status: z
          .enum(['open', 'done', 'cancelled', 'forwarded', 'in_progress', 'scheduled'])
          .optional()
          .describe('Filter by task status. Omit to return all statuses.'),
        folder: FolderSchema,
        tag: z.string().optional().describe('Filter by inline tag (e.g. "backup")'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(50)
          .describe('Maximum tasks to return (1–200, default 50)'),
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ status, folder, tag, limit }) => {
      try {
        const tasks = await extractTasksFromNotes({ folder, status, tag, limit });

        if (tasks.length === 0) {
          return {
            content: [{ type: 'text', text: 'No tasks found matching the given filters.' }],
            structuredContent: { count: 0, tasks: [] },
          };
        }

        const text = tasks
          .map((t, i) => {
            const statusIcon = statusToIcon(t.status);
            const due = t.dueDate ? ` 📅 ${t.dueDate}` : '';
            const pri = t.priority ? ` [${t.priority}]` : '';
            return (
              `${i + 1}. ${statusIcon} ${t.text}${due}${pri}\n` +
              `   From: ${t.notePath}:${t.lineNumber}`
            );
          })
          .join('\n\n');

        return {
          content: [{ type: 'text', text: `${tasks.length} task(s):\n\n${text}` }],
          structuredContent: { count: tasks.length, tasks },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
      }
    },
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function statusToIcon(status: TaskStatus): string {
  const map: Record<TaskStatus, string> = {
    open: '☐',
    done: '✅',
    cancelled: '~~',
    forwarded: '→',
    in_progress: '⏳',
    scheduled: '?',
  };
  return map[status] ?? '☐';
}
