import type { Env } from "./types";

export { Room } from "./room";

function generateRoomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // GET /health
    if (url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    // POST /rooms — create a room (accepts optional key_hash to prevent race condition)
    if (request.method === "POST" && url.pathname === "/rooms") {
      const body = (await request.json()) as { name?: string; key_hash?: string };
      const roomName = body.name || "Unnamed Room";
      const roomId = generateRoomId();

      // Create the Durable Object and init it with the room name + key_hash
      const doId = env.ROOM.idFromName(roomId);
      const stub = env.ROOM.get(doId);
      await stub.fetch(new Request("http://room/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: roomName, key_hash: body.key_hash }),
      }));

      const wsUrl = `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}/rooms/${roomId}/ws`;

      return Response.json({ room_id: roomId, ws_url: wsUrl, name: roomName });
    }

    // GET /rooms/:room_id/ws — WebSocket upgrade (forward key_hash for auth)
    const wsMatch = url.pathname.match(/^\/rooms\/([a-z0-9]+)\/ws$/);
    if (wsMatch) {
      const roomId = wsMatch[1];
      const keyHash = url.searchParams.get("key_hash");
      const doId = env.ROOM.idFromName(roomId);
      const stub = env.ROOM.get(doId);

      const wsUrl = keyHash
        ? `http://room/ws?key_hash=${encodeURIComponent(keyHash)}`
        : "http://room/ws";
      return stub.fetch(new Request(wsUrl, {
        method: "GET",
        headers: request.headers,
      }));
    }

    // POST /rooms/:room_id/history — message history (key_hash in X-Key-Hash header)
    const historyMatch = url.pathname.match(/^\/rooms\/([a-z0-9]+)\/history$/);
    if (historyMatch && request.method === "POST") {
      const roomId = historyMatch[1];
      const keyHash = request.headers.get("X-Key-Hash");
      if (!keyHash) {
        return Response.json({ error: "X-Key-Hash header required" }, { status: 401 });
      }

      const doId = env.ROOM.idFromName(roomId);
      const stub = env.ROOM.get(doId);
      return stub.fetch(new Request("http://room/history", {
        method: "POST",
        headers: { "X-Key-Hash": keyHash },
      }));
    }

    // GET /rooms/:room_id — room info (requires key_hash)
    const infoMatch = url.pathname.match(/^\/rooms\/([a-z0-9]+)$/);
    if (infoMatch) {
      const roomId = infoMatch[1];
      const keyHash = url.searchParams.get("key_hash");
      const doId = env.ROOM.idFromName(roomId);
      const stub = env.ROOM.get(doId);
      const infoUrl = keyHash
        ? `http://room/info?key_hash=${encodeURIComponent(keyHash)}`
        : "http://room/info";
      return stub.fetch(new Request(infoUrl));
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
