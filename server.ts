#!/usr/bin/env bun
/**
 * claude-room MCP server (cloud broker edition)
 *
 * Spawned by Claude Code as a stdio MCP server (one per instance).
 * Connects to a cloud broker via WebSocket for peer discovery and messaging.
 * Declares claude/channel capability to push inbound messages immediately.
 *
 * Usage:
 *   claude --dangerously-load-development-channels server:claude-room
 *
 * With .mcp.json:
 *   { "claude-room": { "command": "bun", "args": ["./server.ts"] } }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  CloudPeerInfo,
  CloudHistoryMessage,
  CloudClientMessage,
  CloudServerMessage,
} from "./shared/types.ts";
import {
  getGitBranch,
} from "./shared/summarize.ts";
import { encrypt, decrypt, generateSecretKey, parseInviteCode, hashKey } from "./shared/crypto.ts";

// --- Configuration ---

const CLOUD_BROKER_URL = process.env.CLAUDE_ROOM_URL ?? "https://claude-room.nguyenvanduocit.workers.dev";
const AUTO_JOIN_ROOM = process.env.CLAUDE_ROOM_ID ?? "";

// --- Utility ---

function log(msg: string) {
  // MCP stdio servers must only use stderr for logging (stdout is the MCP protocol)
  console.error(`[claude-room] ${msg}`);
}

async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0) {
      return text.trim();
    }
  } catch {
    // not a git repo
  }
  return null;
}

// --- State ---

let myId: string | null = null;
let myCwd = process.cwd();
let myGitRoot: string | null = null;
let currentSummary = "";
let myDisplayName = "";

let ws: WebSocket | null = null;
let roomId: string | null = null;
let connectedPeers: Map<string, CloudPeerInfo> = new Map();
let reconnectDelay = 1000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let secretKey: string = ""; // E2E encryption key for current room

// --- WebSocket connection manager ---

async function connectToRoom(targetRoomId: string) {
  // Close existing connection if any
  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  roomId = targetRoomId;
  reconnectDelay = 1000;

  const baseWsUrl = `${CLOUD_BROKER_URL.replace("https", "wss").replace("http", "ws")}/rooms/${targetRoomId}/ws`;
  // Pass key_hash on WebSocket URL for pre-upgrade authentication
  const keyHashForWs = secretKey ? await hashKey(secretKey) : "";
  const wsUrl = keyHashForWs ? `${baseWsUrl}?key_hash=${encodeURIComponent(keyHashForWs)}` : baseWsUrl;
  log(`Connecting to room ${targetRoomId} at ${baseWsUrl}`);

  const socket = new WebSocket(wsUrl);

  socket.onopen = async () => {
    log(`WebSocket connected to room ${targetRoomId}`);
    reconnectDelay = 1000; // reset backoff on successful connect

    const keyHash = await hashKey(secretKey);
    const projectHint = (myGitRoot ?? myCwd).split("/").pop() ?? "unknown";
    const registerMsg: CloudClientMessage = {
      type: "register",
      display_name: secretKey ? encrypt(myDisplayName, secretKey) : myDisplayName,
      summary: secretKey ? encrypt(currentSummary, secretKey) : currentSummary,
      project_hint: secretKey ? encrypt(projectHint, secretKey) : projectHint,
      key_hash: keyHash,
    };
    socket.send(JSON.stringify(registerMsg));

    // Keep connection alive with periodic pings
    heartbeatTimer = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.ping();
      }
    }, 20000);
  };

  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(String(event.data)) as CloudServerMessage;
      handleServerMessage(msg);
    } catch (e) {
      log(`Failed to parse WebSocket message: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  socket.onclose = () => {
    log("WebSocket closed");
    ws = null;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    // Auto-reconnect with exponential backoff if we still want to be in this room
    if (roomId) {
      const delay = Math.min(reconnectDelay, 30000);
      log(`Reconnecting in ${delay}ms...`);
      reconnectTimer = setTimeout(async () => {
        if (roomId) {
          reconnectDelay = Math.min(reconnectDelay * 2, 30000);
          await connectToRoom(roomId);
        }
      }, delay);
    }
  };

  socket.onerror = (err) => {
    log(`WebSocket error: ${err}`);
    // onclose will fire after this
  };

  ws = socket;
}

function decryptPeerInfo(peer: CloudPeerInfo): CloudPeerInfo {
  if (!secretKey) return peer;
  try {
    return {
      ...peer,
      display_name: decrypt(peer.display_name, secretKey),
      summary: peer.summary ? decrypt(peer.summary, secretKey) : "",
      project_hint: peer.project_hint ? decrypt(peer.project_hint, secretKey) : "",
    };
  } catch {
    return peer; // fallback if decryption fails (e.g. legacy unencrypted peer)
  }
}

function handleServerMessage(msg: CloudServerMessage) {
  switch (msg.type) {
    case "registered": {
      myId = msg.peer_id;
      connectedPeers.clear();
      for (const peer of msg.peers) {
        connectedPeers.set(peer.id, decryptPeerInfo(peer));
      }
      log(`Registered as peer ${myId} with ${msg.peers.length} peer(s)`);
      break;
    }

    case "message": {
      // Decrypt message text if we have a secret key
      let decryptedText = msg.text;
      if (secretKey) {
        try {
          decryptedText = decrypt(msg.text, secretKey);
        } catch {
          decryptedText = "[encrypted message — wrong key]";
        }
      }

      // Skip channel notification for own messages (broker echoes them back)
      if (msg.from_id === myId) {
        log(`Echo (self): ${decryptedText.slice(0, 80)}`);
        break;
      }

      // Push as channel notification
      const sender = connectedPeers.get(msg.from_id);
      mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: decryptedText,
          meta: {
            from_id: msg.from_id,
            from_name: msg.from_name,
            from_summary: sender?.summary ?? "",
            from_project: sender?.project_hint ?? "",
            sent_at: msg.sent_at,
          },
        },
      }).catch((e) => log(`Channel notification error: ${e}`));

      log(`Message from ${msg.from_name} (${msg.from_id}): ${decryptedText.slice(0, 80)}`);
      break;
    }

    case "peer_joined": {
      const decryptedPeer = decryptPeerInfo(msg.peer);
      connectedPeers.set(msg.peer.id, decryptedPeer);
      log(`Peer joined: ${decryptedPeer.display_name} (${msg.peer.id})`);
      break;
    }

    case "peer_left": {
      connectedPeers.delete(msg.peer_id);
      log(`Peer left: ${msg.display_name} (${msg.peer_id})`);
      break;
    }

    case "peer_rejected": {
      log(`Join rejected: ${msg.reason}`);
      // Clear room state since we were rejected
      roomId = null;
      myId = null;
      secretKey = "";
      connectedPeers.clear();
      break;
    }

    case "error": {
      log(`Server error: ${msg.message}`);
      break;
    }
  }
}

// --- MCP Server ---

const mcp = new Server(
  { name: "claude-room", version: "0.3.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `You are connected to the claude-room network. You can create or join rooms to collaborate with other Claude Code instances across machines. All messages are E2E encrypted — the cloud broker only sees ciphertext.

IMPORTANT: When you receive a <channel source="claude-room" ...> message, RESPOND IMMEDIATELY. Do not wait until your current task is finished. Pause what you are doing, reply to the message using send_message, then resume your work. Treat incoming peer messages like a coworker tapping you on the shoulder — answer right away, even if you're in the middle of something.

Read the from_id, from_name, and from_summary attributes to understand who sent the message. Reply by calling send_message with their from_id.

Available tools:
- create_room: Create a new room and auto-join it. Requires room_name and your display_name. Returns an invite code with encryption key.
- join_room: Join an existing room by invite code (room_id:secret_key). Requires your display_name.
- leave_room: Disconnect from the current room
- list_peers: List other Claude Code instances in the current room
- send_message: Send a message to a specific peer or broadcast to all
- set_summary: Set a 1-2 sentence summary of what you're working on (visible to other peers)
- get_history: Get message history for the current room

When you create or join a room, always provide a meaningful display_name so other peers know who you are. After joining, call set_summary to describe what you're working on.`,
  }
);

// --- Tool definitions ---

const TOOLS = [
  {
    name: "create_room",
    description:
      "Create a new room on the cloud broker and auto-join it. Returns an invite code (room_id:secret_key) with E2E encryption key that others can use to join.",
    inputSchema: {
      type: "object" as const,
      properties: {
        room_name: {
          type: "string" as const,
          description: "A human-readable name for the room",
        },
        display_name: {
          type: "string" as const,
          description: "Your display name visible to other peers (e.g., your name or role)",
        },
      },
      required: ["room_name", "display_name"],
    },
  },
  {
    name: "join_room",
    description:
      "Join an existing room by its invite code (room_id:secret_key). The secret key enables E2E encryption. Connects via WebSocket for real-time messaging.",
    inputSchema: {
      type: "object" as const,
      properties: {
        invite_code: {
          type: "string" as const,
          description: "The invite code to join (format: room_id:secret_key). A plain room_id also works but without encryption.",
        },
        display_name: {
          type: "string" as const,
          description: "Your display name visible to other peers (e.g., your name or role)",
        },
      },
      required: ["invite_code", "display_name"],
    },
  },
  {
    name: "leave_room",
    description:
      "Leave the current room, disconnecting from WebSocket.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "list_peers",
    description:
      "List other Claude Code instances connected to the current room.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "send_message",
    description:
      "Send a message to a specific peer by ID, or broadcast to all peers in the room if no to_id is provided.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to_id: {
          type: "string" as const,
          description: "The peer ID to send to (omit to broadcast to all peers)",
        },
        message: {
          type: "string" as const,
          description: "The message to send",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "set_summary",
    description:
      "Set a brief summary (1-2 sentences) of what you are currently working on. This is visible to other peers in the room.",
    inputSchema: {
      type: "object" as const,
      properties: {
        summary: {
          type: "string" as const,
          description: "A 1-2 sentence summary of your current work",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "get_history",
    description:
      "Get the message history for the current room.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
];

// --- Tool handlers ---

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  switch (name) {
    case "create_room": {
      const { room_name, display_name } = args as { room_name: string; display_name: string };
      myDisplayName = display_name;
      try {
        // Generate E2E encryption key before creation to prevent race condition
        secretKey = generateSecretKey();
        const creationKeyHash = await hashKey(secretKey);

        const res = await fetch(`${CLOUD_BROKER_URL}/rooms`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: room_name, key_hash: creationKeyHash }),
        });
        if (!res.ok) {
          const err = await res.text();
          return {
            content: [{ type: "text" as const, text: `Failed to create room: ${res.status} ${err}` }],
            isError: true,
          };
        }
        const data = await res.json() as { room_id: string; ws_url: string; name: string };
        const inviteCode = `${data.room_id}:${secretKey}`;

        await connectToRoom(data.room_id);

        // Wait briefly for registration to complete
        await new Promise((r) => setTimeout(r, 1000));

        return {
          content: [{
            type: "text" as const,
            text: `Room created and joined with E2E encryption!\nInvite code: ${inviteCode}\nName: ${data.name}\nShare this invite code with other Claude Code instances so they can join. The invite code includes the encryption key — the broker never sees it.`,
          }],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error creating room: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    }

    case "join_room": {
      const { invite_code, display_name } = args as { invite_code: string; display_name: string };
      myDisplayName = display_name;
      let parsed: { roomId: string; secretKey: string };
      try {
        parsed = parseInviteCode(invite_code);
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }],
          isError: true,
        };
      }
      secretKey = parsed.secretKey;
      const targetRoom = parsed.roomId;
      try {
        await connectToRoom(targetRoom);

        // Wait briefly for registration
        await new Promise((r) => setTimeout(r, 1000));

        if (myId) {
          return {
            content: [{ type: "text" as const, text: `Joined room ${targetRoom} as peer ${myId} (E2E encrypted)` }],
          };
        }
        if (!roomId) {
          // We were rejected
          return {
            content: [{ type: "text" as const, text: `Failed to join room ${targetRoom} — key validation failed or room does not exist` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: `Failed to connect to room ${targetRoom} — connection could not be established` }],
          isError: true,
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error joining room: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    }

    case "leave_room": {
      if (!roomId) {
        return {
          content: [{ type: "text" as const, text: "Not currently in a room." }],
        };
      }
      const leftRoom = roomId;
      roomId = null;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws) {
        try { ws.close(); } catch {}
        ws = null;
      }
      myId = null;
      secretKey = "";
      connectedPeers.clear();
      return {
        content: [{ type: "text" as const, text: `Left room ${leftRoom}` }],
      };
    }

    case "list_peers": {
      if (!roomId) {
        return {
          content: [{ type: "text" as const, text: "Not in a room. Use create_room or join_room first." }],
          isError: true,
        };
      }

      const peers = Array.from(connectedPeers.values()).filter((p) => p.id !== myId);
      if (peers.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No other peers in room ${roomId}.` }],
        };
      }

      const lines = peers.map((p) => {
        const parts = [
          `ID: ${p.id}`,
          `Name: ${p.display_name}`,
        ];
        if (p.project_hint) parts.push(`Project: ${p.project_hint}`);
        if (p.summary) parts.push(`Summary: ${p.summary}`);
        parts.push(`Connected: ${p.connected_at}`);
        return parts.join("\n  ");
      });

      return {
        content: [{
          type: "text" as const,
          text: `Found ${peers.length} peer(s) in room ${roomId}:\n\n${lines.join("\n\n")}`,
        }],
      };
    }

    case "send_message": {
      const { to_id, message } = args as { to_id?: string; message: string };
      if (!roomId || !ws || ws.readyState !== WebSocket.OPEN) {
        return {
          content: [{ type: "text" as const, text: "Not connected to a room. Use create_room or join_room first." }],
          isError: true,
        };
      }

      const sendText = secretKey ? encrypt(message, secretKey) : message;
      const sendMsg: CloudClientMessage = {
        type: "message",
        text: sendText,
        ...(to_id ? { to_id } : {}),
      };
      ws.send(JSON.stringify(sendMsg));

      return {
        content: [{
          type: "text" as const,
          text: to_id ? `Message sent to peer ${to_id}` : `Message broadcast to all peers in room`,
        }],
      };
    }

    case "set_summary": {
      const { summary } = args as { summary: string };
      currentSummary = summary;

      if (ws && ws.readyState === WebSocket.OPEN) {
        const encSummary = secretKey ? encrypt(summary, secretKey) : summary;
        const msg: CloudClientMessage = { type: "set_summary", summary: encSummary };
        ws.send(JSON.stringify(msg));
      }

      return {
        content: [{ type: "text" as const, text: `Summary updated: "${summary}"` }],
      };
    }

    case "get_history": {
      if (!roomId) {
        return {
          content: [{ type: "text" as const, text: "Not in a room. Use create_room or join_room first." }],
          isError: true,
        };
      }

      try {
        const keyHash = await hashKey(secretKey);
        const res = await fetch(`${CLOUD_BROKER_URL}/rooms/${roomId}/history`, {
          method: "POST",
          headers: { "X-Key-Hash": keyHash },
        });
        if (!res.ok) {
          return {
            content: [{ type: "text" as const, text: `Failed to fetch history: ${res.status}` }],
            isError: true,
          };
        }
        const data = await res.json() as { history: CloudHistoryMessage[] };

        if (data.history.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No message history." }],
          };
        }

        // Decrypt messages client-side
        const decrypted = data.history.map((m) => {
          if (secretKey) {
            try {
              return { ...m, text: decrypt(m.text, secretKey) };
            } catch {
              return { ...m, text: "[encrypted message — wrong key]" };
            }
          }
          return m;
        });

        const lines = decrypted.map(
          (m) => `[${m.sent_at}] ${m.from_name} (${m.from_id})${m.to_id ? ` -> ${m.to_id}` : ""}:\n${m.text}`
        );

        return {
          content: [{
            type: "text" as const,
            text: `${decrypted.length} message(s) in history:\n\n${lines.join("\n\n---\n\n")}`,
          }],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error fetching history: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// --- Startup ---

async function main() {
  // 1. Gather context
  myCwd = process.cwd();
  myGitRoot = await getGitRoot(myCwd);
  const branch = await getGitBranch(myCwd);

  const cwdBasename = myCwd.split("/").pop() ?? myCwd;
  myDisplayName = branch ? `${cwdBasename}@${branch}` : cwdBasename;

  log(`CWD: ${myCwd}`);
  log(`Git root: ${myGitRoot ?? "(none)"}`);
  log(`Display name: ${myDisplayName}`);

  // 2. Connect MCP over stdio
  await mcp.connect(new StdioServerTransport());
  log("MCP connected");

  // 4. Auto-join room if configured
  if (AUTO_JOIN_ROOM) {
    const parsed = parseInviteCode(AUTO_JOIN_ROOM);
    secretKey = parsed.secretKey;
    log(`Auto-joining room: ${parsed.roomId}${parsed.secretKey ? " (E2E encrypted)" : ""}`);
    await connectToRoom(parsed.roomId);
  }

  // 5. Clean up on exit
  const cleanup = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    roomId = null; // prevent reconnect
    if (ws) {
      try { ws.close(); } catch {}
      ws = null;
    }
    log("Cleaned up");
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((e) => {
  log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
