import type { PeerInfo, HistoryMessage, ClientMessage, ServerMessage } from "./types";

const MAX_HISTORY = 50;

/**
 * Metadata attached to each WebSocket via serializeAttachment/deserializeAttachment.
 * Survives Durable Object hibernation.
 */
interface WsAttachment {
  peerId: string;
  info: PeerInfo;
}

export class Room implements DurableObject {
  private roomName = "";

  constructor(private state: DurableObjectState, private _env: unknown) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // POST /init — set room name (called once on creation)
    if (request.method === "POST" && url.pathname === "/init") {
      const body = (await request.json()) as { name: string };
      this.roomName = body.name;
      await this.state.storage.put("roomName", body.name);
      return Response.json({ ok: true });
    }

    // GET /ws — WebSocket upgrade
    if (url.pathname === "/ws") {
      const upgradeHeader = request.headers.get("Upgrade");
      if (upgradeHeader !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      // Accept with hibernation API — no tag yet, will be set on register
      this.state.acceptWebSocket(server);

      return new Response(null, { status: 101, webSocket: client });
    }

    // GET /history — message history
    if (url.pathname === "/history") {
      const history = (await this.state.storage.get<HistoryMessage[]>("history")) ?? [];
      return Response.json({ history });
    }

    // GET /info — room info
    if (url.pathname === "/info") {
      if (!this.roomName) {
        this.roomName = (await this.state.storage.get<string>("roomName")) ?? "";
      }
      const peers = this.getActivePeers();
      return Response.json({
        name: this.roomName,
        peer_count: peers.length,
      });
    }

    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") return;

    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.sendTo(ws, { type: "error", message: "Invalid JSON" });
      return;
    }

    try {
      switch (msg.type) {
        case "register":
          await this.handleRegister(ws, msg);
          break;
        case "message":
          await this.handleMessage(ws, msg);
          break;
        case "set_summary":
          this.handleSetSummary(ws, msg);
          break;
        default:
          this.sendTo(ws, { type: "error", message: "Unknown message type" });
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this.sendTo(ws, { type: "error", message: `Internal error: ${errMsg}` });
    }
  }

  webSocketClose(ws: WebSocket): void {
    this.removePeer(ws);
  }

  webSocketError(ws: WebSocket): void {
    this.removePeer(ws);
  }

  // --- Helpers: hibernation-safe peer access ---

  /** Get all registered peers from live WebSockets (survives hibernation). */
  private getActivePeers(): { ws: WebSocket; attachment: WsAttachment }[] {
    const sockets = this.state.getWebSockets();
    const result: { ws: WebSocket; attachment: WsAttachment }[] = [];
    for (const s of sockets) {
      const att = s.deserializeAttachment() as WsAttachment | null;
      if (att?.peerId) {
        result.push({ ws: s, attachment: att });
      }
    }
    return result;
  }

  private findPeerByWs(ws: WebSocket): WsAttachment | null {
    const att = ws.deserializeAttachment() as WsAttachment | null;
    return att?.peerId ? att : null;
  }

  // --- Handlers ---

  private async handleRegister(
    ws: WebSocket,
    msg: { type: "register"; display_name: string; summary: string; project_hint: string }
  ): Promise<void> {
    // Validate display_name is provided and non-empty
    if (!msg.display_name || msg.display_name.trim().length === 0) {
      this.sendTo(ws, { type: "error", message: "display_name is required" });
      return;
    }

    // Check if this WebSocket is already registered
    const existing = ws.deserializeAttachment() as WsAttachment | null;
    if (existing?.peerId) {
      this.sendTo(ws, { type: "error", message: "Already registered" });
      return;
    }

    const peerId = this.generateId();
    const now = new Date().toISOString();

    const info: PeerInfo = {
      id: peerId,
      display_name: msg.display_name,
      summary: msg.summary,
      project_hint: msg.project_hint,
      connected_at: now,
    };

    // Attach metadata to the WebSocket (survives hibernation)
    const attachment: WsAttachment = { peerId, info };
    ws.serializeAttachment(attachment);

    // Get current peers (excluding the new one)
    const activePeers = this.getActivePeers();
    const otherPeerInfos = activePeers
      .filter((p) => p.attachment.peerId !== peerId)
      .map((p) => p.attachment.info);

    // Load history from storage
    const history = (await this.state.storage.get<HistoryMessage[]>("history")) ?? [];

    // Send registration confirmation
    this.sendTo(ws, {
      type: "registered",
      peer_id: peerId,
      peers: otherPeerInfos,
      history: [...history],
    });

    // Notify others that a new peer joined
    this.broadcast({ type: "peer_joined", peer: info }, peerId);
  }

  private async handleMessage(
    ws: WebSocket,
    msg: { type: "message"; text: string; to_id?: string }
  ): Promise<void> {
    const sender = this.findPeerByWs(ws);
    if (!sender) {
      this.sendTo(ws, { type: "error", message: "Not registered" });
      return;
    }

    const now = new Date().toISOString();

    const outgoing: ServerMessage = {
      type: "message",
      from_id: sender.info.id,
      from_name: sender.info.display_name,
      text: msg.text,
      sent_at: now,
      to_id: msg.to_id,
    };

    // Persist to history in storage
    const history = (await this.state.storage.get<HistoryMessage[]>("history")) ?? [];
    history.push({
      from_id: sender.info.id,
      from_name: sender.info.display_name,
      text: msg.text,
      sent_at: now,
      to_id: msg.to_id,
    });
    if (history.length > MAX_HISTORY) {
      history.shift();
    }
    await this.state.storage.put("history", history);

    if (msg.to_id) {
      // Direct message — send to target and echo back to sender
      const activePeers = this.getActivePeers();
      const target = activePeers.find((p) => p.attachment.peerId === msg.to_id);
      if (target) {
        this.sendTo(target.ws, outgoing);
      } else {
        this.sendTo(ws, { type: "error", message: `Peer ${msg.to_id} not found` });
        return;
      }
      // Echo to sender so they see it in history
      this.sendTo(ws, outgoing);
    } else {
      // Broadcast — send to everyone including sender
      this.broadcast(outgoing);
    }
  }

  private handleSetSummary(
    ws: WebSocket,
    msg: { type: "set_summary"; summary: string }
  ): void {
    const att = ws.deserializeAttachment() as WsAttachment | null;
    if (!att?.peerId) {
      this.sendTo(ws, { type: "error", message: "Not registered" });
      return;
    }

    att.info.summary = msg.summary;
    ws.serializeAttachment(att);
  }

  // --- Helpers ---

  private removePeer(ws: WebSocket): void {
    const att = ws.deserializeAttachment() as WsAttachment | null;
    if (!att?.peerId) return;

    this.broadcast(
      {
        type: "peer_left",
        peer_id: att.info.id,
        display_name: att.info.display_name,
      },
      att.peerId
    );

    try {
      ws.close(1000, "Peer left");
    } catch {
      // Already closed
    }
  }

  private broadcast(msg: ServerMessage, excludePeerId?: string): void {
    const data = JSON.stringify(msg);
    const activePeers = this.getActivePeers();
    for (const { ws, attachment } of activePeers) {
      if (attachment.peerId === excludePeerId) continue;
      try {
        ws.send(data);
      } catch {
        // Dead connection, will be cleaned up on close event
      }
    }
  }

  private sendTo(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Connection dead
    }
  }

  private generateId(): string {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let id = "";
    for (let i = 0; i < 8; i++) {
      id += chars[Math.floor(Math.random() * chars.length)];
    }
    return id;
  }
}
