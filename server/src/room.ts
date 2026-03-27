import type { PeerInfo, HistoryMessage, ClientMessage, ServerMessage } from "./types";

const MAX_HISTORY = 50;
const ZOOKEEPER_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// --- Input length limits ---
const MAX_DISPLAY_NAME_LENGTH = 256;
const MAX_SUMMARY_LENGTH = 1024;
const MAX_PROJECT_HINT_LENGTH = 512;
const MAX_MESSAGE_LENGTH = 65536; // 64KB

// --- Timing-safe string comparison ---
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  let diff = 0;
  for (let i = 0; i < bufA.length; i++) {
    diff |= bufA[i] ^ bufB[i];
  }
  return diff === 0;
}

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

    // POST /init — set room name and key_hash (called once on creation)
    if (request.method === "POST" && url.pathname === "/init") {
      const body = (await request.json()) as { name: string; key_hash?: string };
      this.roomName = body.name;
      await this.state.storage.put("roomName", body.name);
      await this.state.storage.put("initialized", true);
      if (body.key_hash) {
        await this.state.storage.put("keyHash", body.key_hash);
      }
      return Response.json({ ok: true });
    }

    // GET /ws — WebSocket upgrade (requires valid key_hash)
    if (url.pathname === "/ws") {
      const initialized = await this.state.storage.get<boolean>("initialized");
      const storedHash = await this.state.storage.get<string>("keyHash");
      if (!initialized && !storedHash) {
        return Response.json({ error: "Room does not exist" }, { status: 404 });
      }

      // Authenticate before upgrading
      const keyHash = url.searchParams.get("key_hash");
      if (storedHash && (!keyHash || !timingSafeEqual(keyHash, storedHash))) {
        return Response.json({ error: "Unauthorized" }, { status: 403 });
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

    // POST /history — message history (key_hash in X-Key-Hash header)
    if (url.pathname === "/history" && request.method === "POST") {
      const keyHash = request.headers.get("X-Key-Hash");
      const storedHash = await this.state.storage.get<string>("keyHash");
      if (!keyHash || !storedHash || !timingSafeEqual(keyHash, storedHash)) {
        return Response.json({ error: "Unauthorized" }, { status: 403 });
      }
      const history = (await this.state.storage.get<HistoryMessage[]>("history")) ?? [];
      return Response.json({ history });
    }

    // GET /info?key_hash=... — room info (requires valid key_hash)
    if (url.pathname === "/info") {
      const storedHash = await this.state.storage.get<string>("keyHash");
      if (storedHash) {
        const keyHash = url.searchParams.get("key_hash");
        if (!keyHash || !timingSafeEqual(keyHash, storedHash)) {
          return Response.json({ error: "Unauthorized" }, { status: 403 });
        }
      }
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

  /** Zookeeper alarm — clean up abandoned rooms */
  async alarm(): Promise<void> {
    const activePeers = this.getActivePeers();
    if (activePeers.length === 0) {
      await this.state.storage.deleteAll();
      this.roomName = "";
    } else {
      // Peers still active — reschedule
      await this.state.storage.setAlarm(Date.now() + ZOOKEEPER_INTERVAL_MS);
    }
  }

  webSocketClose(ws: WebSocket): void {
    this.removePeer(ws);
  }

  webSocketError(ws: WebSocket): void {
    this.removePeer(ws);
  }

  // --- Helpers: hibernation-safe peer access ---

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
    msg: { type: "register"; display_name: string; summary: string; project_hint: string; key_hash: string }
  ): Promise<void> {
    if (!msg.display_name || msg.display_name.trim().length === 0) {
      this.sendTo(ws, { type: "error", message: "display_name is required" });
      return;
    }
    if (msg.display_name.length > MAX_DISPLAY_NAME_LENGTH) {
      this.sendTo(ws, { type: "error", message: "display_name too long" });
      return;
    }
    if (msg.summary && msg.summary.length > MAX_SUMMARY_LENGTH) {
      this.sendTo(ws, { type: "error", message: "summary too long" });
      return;
    }
    if (msg.project_hint && msg.project_hint.length > MAX_PROJECT_HINT_LENGTH) {
      this.sendTo(ws, { type: "error", message: "project_hint too long" });
      return;
    }

    if (!msg.key_hash || msg.key_hash.length === 0) {
      this.sendTo(ws, { type: "error", message: "key_hash is required" });
      return;
    }

    const existing = ws.deserializeAttachment() as WsAttachment | null;
    if (existing?.peerId) {
      this.sendTo(ws, { type: "error", message: "Already registered" });
      return;
    }

    const storedHash = await this.state.storage.get<string>("keyHash");

    if (!storedHash) {
      // First peer (room creator) — store key_hash as canonical
      // (normally set during /init, but handle legacy rooms)
      await this.state.storage.put("keyHash", msg.key_hash);
    } else if (!timingSafeEqual(msg.key_hash, storedHash)) {
      // Key doesn't match — reject
      this.sendTo(ws, { type: "peer_rejected", reason: "Invalid key — your secret key does not match this room" });
      try { ws.close(4002, "Key rejected"); } catch {}
      return;
    }

    // Accept peer
    const peerId = this.generateId();
    const now = new Date().toISOString();

    const info: PeerInfo = {
      id: peerId,
      display_name: msg.display_name,
      summary: msg.summary,
      project_hint: msg.project_hint,
      connected_at: now,
    };

    const attachment: WsAttachment = { peerId, info };
    ws.serializeAttachment(attachment);

    const activePeers = this.getActivePeers();
    const otherPeerInfos = activePeers
      .filter((p) => p.attachment.peerId !== peerId)
      .map((p) => p.attachment.info);

    this.sendTo(ws, {
      type: "registered",
      peer_id: peerId,
      peers: otherPeerInfos,
    });

    this.broadcast({ type: "peer_joined", peer: info }, peerId);

    // Schedule zookeeper alarm (resets on each new peer)
    await this.state.storage.setAlarm(Date.now() + ZOOKEEPER_INTERVAL_MS);
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
    if (!msg.text || msg.text.length > MAX_MESSAGE_LENGTH) {
      this.sendTo(ws, { type: "error", message: `Message must be 1-${MAX_MESSAGE_LENGTH} characters` });
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
    if (msg.summary && msg.summary.length > MAX_SUMMARY_LENGTH) {
      this.sendTo(ws, { type: "error", message: "summary too long" });
      return;
    }

    att.info.summary = msg.summary;
    ws.serializeAttachment(att);
  }

  // --- Helpers ---

  private async removePeer(ws: WebSocket): Promise<void> {
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

    // If no active peers remain, wipe all storage
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
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
  }
}
