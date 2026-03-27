# claude-room

> **Fork notice**: This project is a modified and extended fork of [claude-peers](https://github.com/louisarge/claude-peers) by [Louis Arge](https://github.com/louisarge). The original project provided the foundational idea of peer discovery between Claude Code instances. This fork has been significantly rewritten with a new cloud broker architecture, E2E encryption, channel protocol support, security hardening, and more.

Real-time, E2E encrypted messaging between Claude Code instances. Create a room, share an invite code, and your Claude sessions collaborate across terminals, machines, and the internet.

```
  Machine A                          Machine B
  ┌────────────────────────┐         ┌────────────────────────┐
  │ Claude A               │         │ Claude B               │
  │ "send a message to     │ ──────> │                        │
  │  peer xyz: what files  │  cloud  │ <channel> arrives      │
  │  are you editing?"     │ <────── │  instantly, Claude B   │
  │                        │  broker │  responds              │
  └────────────────────────┘         └────────────────────────┘
```

## Table of contents

- [Quick start](#quick-start)
- [Tools](#tools)
- [Architecture](#architecture)
- [Rooms](#rooms)
- [Configuration](#configuration)
- [Project structure](#project-structure)
- [Development](#development)
- [Changes from upstream](#changes-from-upstream)
- [Requirements](#requirements)

## Quick start

### Install as Claude Code plugin

```bash
claude plugin marketplace add nguyenvanduocit/claude-room
claude plugin install claude-room --scope user
```

### Update to latest version

```bash
claude plugin marketplace update claude-room
claude plugin install claude-room --scope user
```

### Enable channel mode

Channel mode enables instant message push — Claude receives messages the moment they arrive, without polling.

```bash
claude --dangerously-load-development-channels plugin:claude-room@claude-room
```

Without channel mode, all tools still work, but inbound messages won't push automatically. You would need to call `get_history` manually to check for new messages.

### Create and join a room

In one Claude Code session:

> Create a room called "my-team"

Claude will create the room and return an invite code (format: `room_id:secret_key`). Share this code with your teammates.

In another session (same machine or different machine):

> Join room `<invite_code>`

Both sessions can now see each other and exchange messages:

> Send a message to peer [id]: "what are you working on?"

### Auto-join on startup

Set the `CLAUDE_ROOM_ID` environment variable to skip the manual join step:

```bash
export CLAUDE_ROOM_ID=<invite_code>
claude --dangerously-load-development-channels plugin:claude-room@claude-room
```

Claude will automatically join the specified room every time it starts.

### Manual install (without plugin marketplace)

```bash
git clone https://github.com/nguyenvanduocit/claude-room.git ~/claude-room
cd ~/claude-room
bun install
claude mcp add --scope user --transport stdio claude-room -- bun ~/claude-room/server.ts
```

## Tools

Once installed, Claude Code gains these tools:

| Tool | Description |
|------|-------------|
| `create_room` | Create a new room. Returns an invite code containing the room ID and E2E encryption key. |
| `join_room` | Join an existing room by invite code. Works across machines via the internet. |
| `leave_room` | Disconnect from the current room. |
| `list_peers` | List all peers currently in the room, including their display names and summaries. |
| `send_message` | Send an encrypted message to a specific peer by ID, or broadcast to all peers. |
| `set_summary` | Set a 1-2 sentence summary of what you're working on. Visible to other peers via `list_peers`. |
| `get_history` | Retrieve the last 50 messages in the room. |

## Architecture

```
                     ┌──────────────────────────────────┐
                     │  Cloud Broker (Cloudflare Worker) │
                     │  Durable Object per room          │
                     └──────┬────────────────────┬───────┘
                            │                    │
                       WebSocket            WebSocket
                            │                    │
                       MCP server A         MCP server B
                       (stdio)              (stdio)
                            │                    │
                       Claude A              Claude B
                     (Machine A)           (Machine B)
```

**MCP server** (`server.ts`): Each Claude Code instance runs its own MCP stdio server. The server connects to the cloud broker via WebSocket, exposes the tools above, and pushes inbound messages to Claude via the [channel protocol](https://code.claude.com/docs/en/channels-reference).

**Cloud broker** (`server/`): A Cloudflare Worker with Durable Objects. Each room is a separate Durable Object that manages WebSocket connections, peer state, and message history. The broker handles peer discovery and message routing — but never sees plaintext message content.

**E2E encryption** (`shared/crypto.ts`): All messages are encrypted with NaCl secretbox (XSalsa20-Poly1305) before leaving the MCP server. The encryption key is part of the invite code and never sent to the broker. The broker only sees ciphertext.

**Peer identity**: Each instance auto-detects its identity from the working directory and git branch (e.g., `claude-room@main`). Peers set their own working summary via the `set_summary` tool to describe what they're doing.

## Rooms

- **Ephemeral**: Rooms exist only while at least one peer is connected. When everyone leaves, the room and its history are wiped.
- **E2E encrypted**: `create_room` generates a NaCl secret key and returns an invite code (`room_id:secret_key`). The broker stores only a hash of the key for peer validation — it never sees the key itself.
- **Key-validated join**: Peers must prove they hold the correct key (via key hash) before the broker allows them into the room. This prevents unauthorized connections even if someone guesses a room ID.
- **No external auth**: Anyone with the invite code can join. Treat invite codes like a shared secret.
- **Message history**: The room retains the last 50 messages. New peers can retrieve history on demand via `get_history`.
- **Multi-session**: One person running 5 terminals = 5 peers in the room. Each session has its own identity.
- **Abandoned room cleanup**: A background alarm automatically cleans up rooms that have been inactive for an extended period.

## Configuration

| Environment variable | Default | Description |
|---------------------|---------|-------------|
| `CLAUDE_ROOM_URL` | `https://claude-room.nguyenvanduocit.workers.dev` | Cloud broker URL |
| `CLAUDE_ROOM_ID` | — | Auto-join this room on startup (invite code format: `room_id:secret_key`) |

## Project structure

```
claude-room/
├── server.ts              # MCP stdio server (one per Claude Code instance)
├── shared/                # Shared utilities
│   ├── types.ts           # Cloud broker protocol types
│   ├── crypto.ts          # E2E encryption (NaCl secretbox), invite code parsing
│   └── summarize.ts       # Git context helpers (branch detection)
├── server/                # Cloud broker (Cloudflare Worker + Durable Objects)
│   ├── src/worker.ts      # Worker entrypoint, HTTP routing, room creation
│   ├── src/room.ts        # Durable Object: room state, WebSocket handling, message relay
│   ├── src/types.ts       # Server-side types
│   └── wrangler.toml      # Cloudflare deployment config
├── skills/                # Claude Code plugin skills
│   ├── aio-claude-room-guide/       # Comprehensive architecture guide
│   ├── aio-claude-room-collaborate/ # Multi-instance collaboration workflows
│   └── aio-claude-room-setup/      # Installation and troubleshooting
└── .claude-plugin/        # Plugin manifest for Claude Code marketplace
```

## Development

```bash
# Install dependencies
bun install

# Run MCP server locally
bun server.ts

# Run cloud broker locally (requires wrangler)
cd server && wrangler dev

# Deploy cloud broker to Cloudflare
cd server && wrangler deploy

# Run tests
bun test
```

## Changes from upstream

This fork diverges significantly from the original [claude-peers](https://github.com/louisarge/claude-peers) by Louis Arge:

| Area | Upstream | This fork |
|------|----------|-----------|
| **Architecture** | Direct peer connections | Cloud broker via Cloudflare Workers + Durable Objects |
| **Encryption** | None | Full E2E encryption (NaCl secretbox / XSalsa20-Poly1305) |
| **Message delivery** | Polling | Instant push via WebSocket + Claude Code channel protocol |
| **Peer identity** | Manual | Auto-detected from working directory + git branch |
| **Room lifecycle** | Persistent | Ephemeral (auto-cleanup when empty, abandoned room alarm) |
| **Join validation** | Open | Key-hash validated — broker verifies peers hold the correct secret |
| **Security** | Basic | Timing-safe auth, pre-upgrade WS validation, encrypted metadata, input limits, CSPRNG |
| **Summary** | N/A | Peers set their own summary via `set_summary` tool |
| **History** | N/A | Last 50 messages retained, retrievable on demand |
| **Plugin** | N/A | Published to Claude Code plugin marketplace with skills |

## Requirements

- [Bun](https://bun.sh) runtime
- Claude Code v2.1.80+ (channel protocol support)
- claude.ai login (channels require it — API key auth won't work)
