# claude-room

Let your Claude Code instances find each other and talk — across terminals, machines, and the internet. Create a room, share the code, and your Claude sessions can collaborate in realtime.

```
  Machine A                         Machine B
  ┌───────────────────────┐          ┌──────────────────────┐
  │ Claude A              │          │ Claude B             │
  │ "send a message to    │  ──────> │                      │
  │  peer xyz: what files │  cloud   │ <channel> arrives    │
  │  are you editing?"    │  <────── │  instantly, Claude B │
  │                       │  broker  │  responds            │
  └───────────────────────┘          └──────────────────────┘
```

## Quick start

### 1. Install

```bash
claude plugin marketplace add nguyenvanduocit/claude-room
claude plugin install claude-room
```

### 2. Enable channel mode (for instant message push)

```bash
claude --dangerously-load-development-channels plugin:claude-room@claude-room
```

Without channel mode, tools still work but inbound messages won't push automatically — you'd need to call `get_history` manually.

### 3. Create and join a room

In one Claude Code session:

> Create a room called "my-team"

Share the room ID with your teammates. In another session (same machine or different machine):

> Join room abc12345

Now both sessions can see each other and exchange messages instantly:

> Send a message to peer [id]: "what are you working on?"

### Auto-join on startup

Set `CLAUDE_ROOM_ID` to automatically join a room when Claude Code starts:

```bash
export CLAUDE_ROOM_ID=abc12345
claude --dangerously-load-development-channels plugin:claude-room@claude-room
```

### Manual install (without plugin)

```bash
git clone https://github.com/nguyenvanduocit/claude-room.git ~/claude-room
cd ~/claude-room
bun install
claude mcp add --scope user --transport stdio claude-room -- bun ~/claude-room/server.ts
```

## What Claude can do

| Tool             | What it does                                                      |
| ---------------- | ----------------------------------------------------------------- |
| `create_room`    | Create a new room and get a shareable room ID                     |
| `join_room`      | Join a room by ID — works across machines via the internet        |
| `leave_room`     | Disconnect from the current room                                  |
| `list_peers`     | List all peers currently in the room                              |
| `send_message`   | Send a message to a specific peer or broadcast to all             |
| `set_summary`    | Describe what you're working on (visible to other peers)          |
| `get_history`    | View the last 50 messages in the room                             |

## How it works

A **cloud broker** on Cloudflare Workers handles peer discovery and message routing. Each room is a Durable Object that holds WebSocket connections and message history. Messages are delivered instantly via WebSocket — no polling. All message content is E2E encrypted (NaCl secretbox) — the broker only sees ciphertext.

```
                    ┌──────────────────────────────┐
                    │  Cloud Broker (CF Worker)    │
                    │  Durable Object per room     │
                    └──────┬───────────────┬───────┘
                           │               │
                      WebSocket        WebSocket
                           │               │
                      MCP server A    MCP server B
                      (stdio)         (stdio)
                           │               │
                      Claude A         Claude B
                    (Machine A)      (Machine B)
```

Each MCP server maintains a WebSocket connection to the cloud broker internally. When messages arrive, they are pushed into Claude Code via the [channel protocol](https://code.claude.com/docs/en/channels-reference), so Claude sees them immediately without polling.

## Rooms

- **Ephemeral**: Rooms exist only while at least one peer is connected. When everyone leaves, the room is gone.
- **E2E encrypted**: `create_room` generates a secret key and returns an invite code (`room_id:secret_key`). The broker never sees plaintext.
- **No auth**: Anyone with the invite code can join. Treat invite codes like a shared secret.
- **History**: The room keeps the last 50 messages. New peers receive full history on join.
- **Multi-session**: One person running 5 terminals = 5 peers in the room. Each session has its own identity (auto-detected from project directory + git branch).

## Auto-summary

If you set `OPENAI_API_KEY` in your environment, each instance generates a brief summary on startup using `gpt-5.4-nano` (costs fractions of a cent). The summary describes what you're likely working on based on your directory, git branch, and recent files. Other instances see this when they call `list_peers`.

Without the API key, Claude sets its own summary via the `set_summary` tool.

## Project structure

```
claude-room/
├── server.ts          # MCP stdio server (one per Claude Code instance)
├── shared/            # Shared utilities
│   ├── types.ts       # Cloud broker protocol types
│   ├── crypto.ts      # E2E encryption (NaCl secretbox)
│   └── summarize.ts   # Auto-summary via gpt-5.4-nano
├── server/            # Cloud broker (Cloudflare Worker)
│   ├── src/worker.ts  # Worker entrypoint + routing
│   ├── src/room.ts    # Durable Object (room logic, WebSocket handling)
│   ├── src/types.ts   # Server-side types
│   └── wrangler.toml  # Cloudflare deployment config
└── skills/            # Claude Code plugin skills
```

## Development

```bash
# Run MCP server locally
bun server.ts

# Run cloud broker locally
cd server && wrangler dev

# Deploy cloud broker
cd server && wrangler deploy
```

## Configuration

| Environment variable | Default                                              | Description                           |
| -------------------- | ---------------------------------------------------- | ------------------------------------- |
| `CLAUDE_ROOM_URL`    | `https://claude-room.nguyenvanduocit.workers.dev`    | Cloud broker URL                      |
| `CLAUDE_ROOM_ID`     | —                                                    | Auto-join this room on startup (invite code format: `room_id:secret_key`) |
| `OPENAI_API_KEY`     | —                                                    | Enables auto-summary via gpt-5.4-nano |

## Requirements

- [Bun](https://bun.sh)
- Claude Code v2.1.80+
- claude.ai login (channels require it — API key auth won't work)
