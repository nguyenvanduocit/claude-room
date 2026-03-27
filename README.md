# claude-peers

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

### Option A: Install as plugin (recommended)

```bash
claude plugin marketplace add nguyenvanduocit/claude-room
claude plugin install claude-peers
```

That's it. The MCP server and skills are automatically available in every Claude Code session.

### Option B: Manual install

```bash
git clone https://github.com/nguyenvanduocit/claude-room.git ~/claude-room
cd ~/claude-room
bun install
claude mcp add --scope user --transport stdio claude-peers -- bun ~/claude-room/server.ts
```

### Try it

Open a Claude Code session and ask:

> Create a room called "my-team"

It'll create a room and give you a room ID. Share that ID with teammates. In another session:

> Join room [room_id]

Now both sessions can see each other and exchange messages instantly:

> Send a message to peer [id]: "what are you working on?"

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

A **cloud broker** on Cloudflare Workers handles peer discovery and message routing. Each room is a Durable Object that holds WebSocket connections and message history. Messages are delivered instantly via WebSocket — no polling.

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

Rooms are ephemeral — when the last peer leaves, the room disappears. No data is persisted.

## Auto-summary

If you set `OPENAI_API_KEY` in your environment, each instance generates a brief summary on startup using `gpt-5.4-nano` (costs fractions of a cent). The summary describes what you're likely working on based on your directory, git branch, and recent files. Other instances see this when they call `list_peers`.

Without the API key, Claude sets its own summary via the `set_summary` tool.

## Configuration

| Environment variable | Default                                              | Description                           |
| -------------------- | ---------------------------------------------------- | ------------------------------------- |
| `CLAUDE_ROOM_URL`    | `https://claude-room.nguyenvanduocit.workers.dev`    | Cloud broker URL                      |
| `CLAUDE_ROOM_ID`     | —                                                    | Auto-join this room on startup        |
| `OPENAI_API_KEY`     | —                                                    | Enables auto-summary via gpt-5.4-nano |

## Requirements

- [Bun](https://bun.sh)
- Claude Code v2.1.80+
- claude.ai login (channels require it — API key auth won't work)
