// src/schemas/common.ts
// Reusable Zod fragments — import these into tool files rather than
// repeating the same shape definitions.

import { z } from 'zod';
import { DEFAULT_LIMIT, MAX_LIMIT } from '../constants.js';

export const LimitSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_LIMIT)
  .default(DEFAULT_LIMIT)
  .describe(`Maximum number of results to return (1–${MAX_LIMIT}, default ${DEFAULT_LIMIT})`);

export const FolderSchema = z
  .string()
  .optional()
  .describe(
    'Vault-relative folder path to restrict the operation to (e.g. "10 - Projects"). ' +
    'Omit to search the entire vault.',
  );

export const NotePathSchema = z
  .string()
  .min(1)
  .describe(
    'Vault-relative path to the note, forward-slash separated, with .md extension. ' +
    'Example: "10 - Projects/Session Notes — 2026-05-23 — Foo.md"',
  );
