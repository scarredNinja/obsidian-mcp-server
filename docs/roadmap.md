# Architectural Review & Phase 2 Roadmap: `obsidian-mcp-server`

This document outlines key engineering considerations, performance optimizations, and feature expansions to transition the `obsidian-mcp-server` from a read-only query tool to a highly collaborative homelab assistant.

---

## 🔍 Codebase Evaluation

The Phase 1 codebase is exceptionally clean, utilizing strongly-typed schemas (Zod) and a modular structure. However, as the server shifts into a **production-grade Docker Swarm deployment** and services multiple AI clients, three key architectural gaps should be addressed.

### 1. The Performance Gap: Caching on Stateless HTTP
* **The Issue:** Because the server operates stateless HTTP handlers (`StreamableHTTPServerTransport`), every single call to `obsidian_list_notes`, `obsidian_search`, or `obsidian_get_tasks` runs `fast-glob` and executes a full disk read (`fs.readFile`) of **every markdown file** to parse frontmatter via `gray-matter`.
* **The Impact:** For vaults larger than 1,000 notes, this creates noticeable request latency (1–3 seconds) and spikes CPU utilization in the Swarm container on every tool call.
* **The Solution:** Implement a **stateless-aware metadata cache** inside `src/services/vault.ts`. Since the Node process itself remains long-lived in memory, we can store parsed metadata and only re-read a file if its on-disk `mtime` (modification time) has changed.

```typescript
interface CacheEntry {
  mtime: number;
  metadata: NoteMetadata;
}

// In-memory cache pinned to the long-running vault service
const metadataCache = new Map<string, CacheEntry>();
```

---

## 🚀 Recommended Phase 2 Mutation Tools (`src/tools/write.ts`)

To make the AI agent a true co-pilot, it needs the ability to write to the vault. We propose registering the following tools under a new group, utilizing a `dry_run: boolean` flag so the model shows you the exact diff before applying it.

### 1. `obsidian_create_note`
* **Purpose:** Create a new note from scratch.
* **Input Schema:**
  * `path` (string, vault-relative)
  * `content` (string, note body)
  * `frontmatter` (object, optional YAML variables)
  * `overwrite` (boolean, default false)
* **Behavior:** Prevents accidental overwriting of existing notes unless explicitly forced.

### 2. `obsidian_append_to_note`
* **Purpose:** Append checklist items, logs, or comments to the end of a note.
* **Input Schema:**
  * `path` (string)
  * `content` (string)
  * `create_if_missing` (boolean, default false)
* **Use Case:** Critical for automated session logging, tracking backup verification outputs, or closing out task checklists at the end of a session.

### 3. `obsidian_update_frontmatter`
* **Purpose:** Update frontmatter variables (e.g. changing `status` from `planned` to `active`).
* **Input Schema:**
  * `path` (string)
  * `updates` (object mapping string keys to values)
* **Behavior:** Parses the existing frontmatter, merges the updates, and cleanly rewrites the YAML block, leaving the main markdown body completely untouched.

---

## 💡 Specialized "Co-Pilot" Features to Consider

Beyond simple write/read tools, two specialized tools will significantly enhance the developer experience:

### 1. `obsidian_toggle_task` (Smart Checklists)
* **Purpose:** Toggle a task checklist item directly in a note without rewriting the entire file.
* **Input Schema:**
  * `path` (string)
  * `line` (number, 1-indexed line from task parser)
  * `status` (`'open' | 'done' | 'cancelled' | 'in_progress'`)
* **Behavior:** Instead of the AI trying to read the whole file, replace lines in memory, and rewrite it (which is expensive and error-prone), the server handles the regex replacement on the specific line directly. It can automatically append completion tags (e.g. `✅ yyyy-mm-dd`) if marked complete.

### 2. `obsidian_git_sync` (Instant Commit/Push)
* **Purpose:** Trigger a Git synchronization of the notes vault.
* **Behavior:** Executes a local `git commit -am "MCP Auto-sync"` followed by `git push` on `dev-node-01`. This ensures that any notes updated by the AI are instantly pushed back to your central Synology Git repository.
