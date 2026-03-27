import type { PeerInfo, HistoryMessage, ClientMessage, ServerMessage } from "./types";

const MAX_HISTORY = 50;
const VALIDATION_TIMEOUT_MS = 10_000; // 10 seconds to validate a pending peer

/**
 * Metadata attached to each WebSocket via serializeAttachment/deserializeAttachment.
 * Survives Durable Object hibernation.
 */
interface WsAttachment {
  peerId: string;
  info: PeerInfo;
  status: "active" | "pending";
  keyHash?: string; // only set during pending validation
}

export class Room implements DurableObject {
  private roomName = "";

  constructor(private state: DurableObjectState, private _env: unknown) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // POST /init — set room name (called once on creation, marks room as initialized)
    if (request.method === "POST" && url.pathname === "/init") {
      const body = (await request.json()) as { name: string };
      this.roomName = body.name;
      await this.state.storage.put("roomName", body.name);
      await this.state.storage.put("initialized", true);
      return Response.json({ ok: true });
    }

    // GET /ws — WebSocket upgrade
    if (url.pathname === "/ws") {
      // Only allow joining initialized rooms
      const initialized = await this.state.storage.get<boolean>("initialized");
      if (!initialized) {
        return Response.json({ error: "Room does not exist" }, { status: 404 });
      }

      const upgradeHeader = request.headers.get("Upgrade");
      if (upgradeHeader !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

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
        case "accept_peer":
          this.handleAcceptPeer(ws, msg);
          break;
        case "reject_peer":
          this.handleRejectPeer(ws, msg);
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

  /** Get all registered (active, non-pending) peers from live WebSockets. */
  private getActivePeers(): { ws: WebSocket; attachment: WsAttachment }[] {
    const sockets = this.state.getWebSockets();
    const result: { ws: WebSocket; attachment: WsAttachment }[] = [];
    for (const s of sockets) {
      const att = s.deserializeAttachment() as WsAttachment | null;
      if (att?.peerId && att.status === "active") {
        result.push({ ws: s, attachment: att });
      }
    }
    return result;
  }

  private findPeerByWs(ws: WebSocket): WsAttachment | null {
    const att = ws.deserializeAttachment() as WsAttachment | null;
    return att?.peerId && att.status === "active" ? att : null;
  }

  /** Find a pending peer's WebSocket by peer ID. */
  private findPendingWs(pendingPeerId: string): { ws: WebSocket; attachment: WsAttachment } | null {
    const sockets = this.state.getWebSockets();
    for (const s of sockets) {
      const att = s.deserializeAttachment() as WsAttachment | null;
      if (att?.peerId === pendingPeerId && att.status === "pending") {
        return { ws: s, attachment: att };
      }
    }
    return null;
  }

  // --- Handlers ---

  private async handleRegister(
    ws: WebSocket,
    msg: { type: "register"; display_name: string; summary: string; project_hint: string; key_hash: string }
  ): Promise<void> {
    // Validate display_name
    if (!msg.display_name || msg.display_name.trim().length === 0) {
      this.sendTo(ws, { type: "error", message: "display_name is required" });
      return;
    }

    // Validate key_hash
    if (!msg.key_hash || msg.key_hash.length === 0) {
      this.sendTo(ws, { type: "error", message: "key_hash is required — unencrypted rooms are not supported" });
      return;
    }

    // Check if already registered
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

    const activePeers = this.getActivePeers();

    if (activePeers.length === 0) {
      // First peer — auto-accept (room creator)
      const attachment: WsAttachment = { peerId, info, status: "active" };
      ws.serializeAttachment(attachment);

      this.sendTo(ws, {
        type: "registered",
        peer_id: peerId,
        peers: [],
      });
    } else {
      // Not the first peer — put in pending state and ask existing peers to validate
      const attachment: WsAttachment = { peerId, info, status: "pending", keyHash: msg.key_hash };
      ws.serializeAttachment(attachment);

      // Send validate_peer to all active peers
      this.broadcast({
        type: "validate_peer",
        pending_peer_id: peerId,
        display_name: msg.display_name,
        key_hash: msg.key_hash,
      });

      // Set a timeout — if not validated in time, reject
      setTimeout(() => {
        const stillPending = this.findPendingWs(peerId);
        if (!stillPending) return;

        this.sendTo(stillPending.ws, { type: "peer_rejected", reason: "Validation timed out — no peer accepted your key" });
        try {
          stillPending.ws.close(4001, "Validation timeout");
        } catch {
          // already closed
        }
      }, VALIDATION_TIMEOUT_MS);
    }
  }

  private handleAcceptPeer(
    ws: WebSocket,
    msg: { type: "accept_peer"; pending_peer_id: string }
  ): void {
    // Only active peers can accept
    const acceptor = this.findPeerByWs(ws);
    if (!acceptor) {
      this.sendTo(ws, { type: "error", message: "Not registered" });
      return;
    }

    const pending = this.findPendingWs(msg.pending_peer_id);
    if (!pending) return; // already accepted or gone

    // Promote to active
    pending.attachment.status = "active";
    delete pending.attachment.keyHash;
    pending.ws.serializeAttachment(pending.attachment);

    // Get current active peers (excluding the newly promoted one)
    const activePeers = this.getActivePeers();
    const otherPeerInfos = activePeers
      .filter((p) => p.attachment.peerId !== pending.attachment.peerId)
      .map((p) => p.attachment.info);

    // Send registration confirmation to the accepted peer
    this.sendTo(pending.ws, {
      type: "registered",
      peer_id: pending.attachment.peerId,
      peers: otherPeerInfos,
    });

    // Notify others that a new peer joined
    this.broadcast({ type: "peer_joined", peer: pending.attachment.info }, pending.attachment.peerId);
  }

  private handleRejectPeer(
    ws: WebSocket,
    msg: { type: "reject_peer"; pending_peer_id: string }
  ): void {
    // Only active peers can reject
    const rejector = this.findPeerByWs(ws);
    if (!rejector) {
      this.sendTo(ws, { type: "error", message: "Not registered" });
      return;
    }

    const pending = this.findPendingWs(msg.pending_peer_id);
    if (!pending) return; // already accepted or gone

    // Immediate rejection — close the pending peer
    this.sendTo(pending.ws, { type: "peer_rejected", reason: "Key validation failed — your secret key does not match" });
    try {
      pending.ws.close(4002, "Key rejected");
    } catch {
      // already closed
    }
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

    // Persist to history
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
      // Direct message
      const activePeers = this.getActivePeers();
      const target = activePeers.find((p) => p.attachment.peerId === msg.to_id);
      if (target) {
        this.sendTo(target.ws, outgoing);
      } else {
        this.sendTo(ws, { type: "error", message: `Peer ${msg.to_id} not found` });
        return;
      }
      this.sendTo(ws, outgoing);
    } else {
      // Broadcast
      this.broadcast(outgoing);
    }
  }

  private handleSetSummary(
    ws: WebSocket,
    msg: { type: "set_summary"; summary: string }
  ): void {
    const att = ws.deserializeAttachment() as WsAttachment | null;
    if (!att?.peerId || att.status !== "active") {
      this.sendTo(ws, { type: "error", message: "Not registered" });
      return;
    }

    att.info.summary = msg.summary;
    ws.serializeAttachment(att);
  }

  // --- Helpers ---

  private async removePeer(ws: WebSocket): Promise<void> {
    const att = ws.deserializeAttachment() as WsAttachment | null;
    if (!att?.peerId) return;

    // Only broadcast peer_left for active peers
    if (att.status === "active") {
      this.broadcast(
        {
          type: "peer_left",
          peer_id: att.info.id,
          display_name: att.info.display_name,
        },
        att.peerId
      );
    }

    try {
      ws.close(1000, "Peer left");
    } catch {
      // Already closed
    }

    // If no active peers remain, wipe all storage (room ceases to exist)
    const remaining = this.getActivePeers().filter((p) => p.attachment.peerId !== att.peerId);
    if (remaining.length === 0) {
      await this.state.storage.deleteAll();
      this.roomName = "";
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
        // Dead connection
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
