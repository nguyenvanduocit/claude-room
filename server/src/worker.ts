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

    // POST /rooms — create a room
    if (request.method === "POST" && url.pathname === "/rooms") {
      const body = (await request.json()) as { name?: string };
      const roomName = body.name || "Unnamed Room";
      const roomId = generateRoomId();

      // Create the Durable Object and init it with the room name
      const doId = env.ROOM.idFromName(roomId);
      const stub = env.ROOM.get(doId);
      await stub.fetch(new Request("http://room/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: roomName }),
      }));

      const wsUrl = `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}/rooms/${roomId}/ws`;

      return Response.json({ room_id: roomId, ws_url: wsUrl, name: roomName });
    }

    // GET /rooms/:room_id/ws — WebSocket upgrade
    const wsMatch = url.pathname.match(/^\/rooms\/([a-z0-9]+)\/ws$/);
    if (wsMatch) {
      const roomId = wsMatch[1];
      const doId = env.ROOM.idFromName(roomId);
      const stub = env.ROOM.get(doId);

      return stub.fetch(new Request("http://room/ws", {
        method: "GET",
        headers: request.headers,
      }));
    }

    // GET /rooms/:room_id/history?key_hash=... — message history (requires key_hash)
    const historyMatch = url.pathname.match(/^\/rooms\/([a-z0-9]+)\/history$/);
    if (historyMatch) {
      const roomId = historyMatch[1];
      const keyHash = url.searchParams.get("key_hash");
      if (!keyHash) {
        return Response.json({ error: "key_hash query parameter required" }, { status: 401 });
      }

      const doId = env.ROOM.idFromName(roomId);
      const stub = env.ROOM.get(doId);
      return stub.fetch(new Request(`http://room/history?key_hash=${encodeURIComponent(keyHash)}`));
    }

    // GET /rooms/:room_id — room info
    const infoMatch = url.pathname.match(/^\/rooms\/([a-z0-9]+)$/);
    if (infoMatch) {
      const roomId = infoMatch[1];
      const doId = env.ROOM.idFromName(roomId);
      const stub = env.ROOM.get(doId);
      const res = await stub.fetch(new Request("http://room/info"));
      const data = await res.json();
      return Response.json(data);
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
