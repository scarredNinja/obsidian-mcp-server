# obsidian-mcp-server

An MCP server for Obsidian vaults. Exposes read tools for searching, reading, listing, and navigating notes — including full Obsidian Tasks plugin support.

Works with any Obsidian vault. Designed for two transports:
- **stdio** — Claude Desktop (local, Windows/macOS/Linux)
- **HTTP** — Docker Swarm (remote, production)

## Tools

| Tool | Description |
|------|-------------|
| `obsidian_search` | Full-text / regex search across all notes |
| `obsidian_find_by_tag` | Find notes by tag |
| `obsidian_find_by_frontmatter` | Find notes where a frontmatter field = value |
| `obsidian_read_note` | Read full note content and metadata |
| `obsidian_get_structure` | Browse vault folder tree |
| `obsidian_get_links` | Get wikilinks from a note |
| `obsidian_find_backlinks` | Find notes that link to a given note |
| `obsidian_list_notes` | List notes with folder/tag filters |
| `obsidian_get_recent` | Get recently modified notes |
| `obsidian_get_tasks` | Extract tasks (Obsidian Tasks plugin format) |

## Quick start (stdio / Claude Desktop)

### 1. Install

```bash
git clone https://github.com/yourname/obsidian-mcp-server
cd obsidian-mcp-server
npm install
npm run build
```

### 2. Configure Claude Desktop

Edit `%APPDATA%\Claude\claude_desktop_config.json` (Windows) or
`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "node",
      "args": ["C:/path/to/obsidian-mcp-server/dist/index.js"],
      "env": {
        "VAULT_PATH": "C:/Users/DJ/Documents/Notes/Home",
        "VAULT_NAME": "Home Vault"
      }
    }
  }
}
```

Restart Claude Desktop. The vault tools will appear in the tools list.

---

## Docker Swarm deployment (HTTP transport)

### Swarm stack (stack-obsidian-mcp.yml)

```yaml
version: "3.9"

services:
  obsidian-mcp:
    image: your-registry/obsidian-mcp-server:latest
    environment:
      TRANSPORT: http
      PORT: "3000"
      VAULT_PATH: /vault
      VAULT_NAME: Home Vault
    volumes:
      # Mount your vault — read-only is sufficient for Phase 1
      - /path/to/vault:/vault:ro
    ports:
      - target: 3000
        published: 3001
        mode: host
    networks:
      - traefik-public
    deploy:
      replicas: 1
      placement:
        constraints:
          - node.role == manager
      labels:
        - traefik.enable=true
        - traefik.http.routers.obsidian-mcp.rule=Host(`obsidian-mcp.home.yourdomain.com`)
        - traefik.http.routers.obsidian-mcp.entrypoints=websecure
        - traefik.http.routers.obsidian-mcp.tls=true
        - traefik.http.routers.obsidian-mcp.middlewares=internal-only@file
        - traefik.http.services.obsidian-mcp.loadbalancer.server.port=3000

networks:
  traefik-public:
    external: true
```

### Vault access in Swarm

The vault needs to be accessible to the container. Options:
- **NFS mount**: Mount the Synology or a NFS share to `/vault` on the Swarm node
- **Obsidian Git sync**: Push vault to a private git repo, pull into a volume on schedule
- **SMB/CIFS**: Mount Windows share from your PC (works but adds latency)

NFS is recommended given your existing NAS setup.

---

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VAULT_PATH` | Yes | — | Absolute path to vault root |
| `VAULT_NAME` | No | `Obsidian Vault` | Display name for this vault |
| `TRANSPORT` | No | `stdio` | `stdio` or `http` |
| `PORT` | No | `3000` | HTTP port (when TRANSPORT=http) |

---

## Development

```bash
npm install
npm run dev          # TypeScript watch mode
# In another terminal:
VAULT_PATH=/path/to/vault npm start

# Test with MCP Inspector:
VAULT_PATH=/path/to/vault npm run inspector
```

## Adding mutation tools (Phase 2)

When you're ready for write operations, add tools to `src/tools/write.ts`:
- `obsidian_create_note` — create a note from a template
- `obsidian_update_frontmatter` — patch frontmatter fields
- `obsidian_append_to_note` — append content to an existing note

Each should have a `dry_run` parameter and require explicit confirmation in the description.
