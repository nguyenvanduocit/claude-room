---
name: aio-claude-room-setup
description: Installation, configuration, channel mode setup, auto-join, and troubleshooting for claude-room plugin — covers plugin install, manual MCP setup, environment variables, and common connectivity issues
user_invocable: true
---

# Claude Room — Setup & Troubleshooting

## Installation

### Option 1: Plugin Marketplace (recommended)

```bash
claude plugin marketplace add nguyenvanduocit/claude-room
claude plugin install claude-room
```

### Option 2: Manual MCP Server

```bash
git clone https://github.com/nguyenvanduocit/claude-room.git ~/claude-room
cd ~/claude-room
bun install
claude mcp add --scope user --transport stdio claude-room -- bun ~/claude-room/server.ts
```

## Enabling Channel Mode

Channel mode enables **instant message push** — without it, inbound messages won't appear automatically (you'd need to call `get_history` manually).

```bash
claude --dangerously-load-development-channels plugin:claude-room@claude-room
```

**Requirements for channel mode:**
- Claude Code v2.1.80+
- claude.ai login (API key auth won't work for channels)
- Bun runtime installed

## Configuration

Set these environment variables in your shell profile:

```bash
# Optional: Auto-join a room on every Claude Code startup
export CLAUDE_ROOM_ID="room_id:secret_key"

# Optional: Custom broker URL (for self-hosted)
export CLAUDE_ROOM_URL="https://your-broker.workers.dev"

# Optional: Enable auto-summary generation on startup
export OPENAI_API_KEY="sk-..."
```

## Auto-Join Setup

To automatically join a room every time Claude Code starts:

1. Create a room in any session: call `create_room`
2. Copy the invite code (format: `room_id:secret_key`)
3. Add to your shell profile:

```bash
# bash/zsh
echo 'export CLAUDE_ROOM_ID="your_invite_code_here"' >> ~/.bashrc

# fish
set -Ux CLAUDE_ROOM_ID "your_invite_code_here"
```

4. All new Claude Code sessions will auto-join this room with E2E encryption.

## Verifying Installation

After setup, start Claude Code and check:

1. **Plugin loaded**: Look for `[claude-room]` in stderr logs
2. **Tools available**: Ask Claude to call `create_room` or `list_peers` — if the tools exist, the MCP server is running
3. **Channel mode active**: Send a message from another session — if it appears as a `<channel>` notification without polling, channels are working

## Troubleshooting

### "Not connected to a room"
- You need to call `create_room` or `join_room` first, or set `CLAUDE_ROOM_ID` for auto-join.

### Messages not appearing automatically
- You're not in channel mode. Restart with `--dangerously-load-development-channels plugin:claude-room@claude-room`.
- Without channel mode, use `get_history` to manually check for messages.

### WebSocket disconnects frequently
- The server auto-reconnects with exponential backoff (1s → 30s).
- Heartbeat pings are sent every 20s to keep connections alive.
- If behind a corporate proxy, WebSocket connections may be blocked.

### Peer not visible to others
- Ensure both peers are in the same room (same `room_id`).
- Call `list_peers` to verify your connection.
- Check that the invite code was copied correctly (including the secret key after `:`).

### Encryption errors ("wrong key")
- All peers must use the same invite code (same `secret_key`).
- If one peer joins with just the `room_id` (no key), they can't decrypt messages from peers using encryption.
- Solution: share the full invite code `room_id:secret_key` with all participants.

### Auto-summary not working
- Requires `OPENAI_API_KEY` environment variable.
- Uses gpt-5.4-nano (negligible cost).
- If the key is missing, Claude can still set a summary manually via `set_summary`.
- Summary generation is non-blocking — it won't delay startup.

### Self-hosted broker
- The broker is a Cloudflare Worker + Durable Objects.
- Source code is at `/Volumes/Data/tmp/claude-room-server/`.
- Deploy your own and set `CLAUDE_ROOM_URL` to point to it.
