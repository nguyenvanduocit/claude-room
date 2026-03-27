import type { Env } from "./types";

export { Room } from "./room";

function generateRoomId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // GET /health
    if (url.pathname === "/health") {
      return Response.json({ status: "ok" }, { headers: corsHeaders() });
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

      return Response.json(
        { room_id: roomId, ws_url: wsUrl, name: roomName },
        { headers: corsHeaders() }
      );
    }

    // GET /rooms/:room_id/ws — WebSocket upgrade
    const wsMatch = url.pathname.match(/^\/rooms\/([a-z0-9]+)\/ws$/);
    if (wsMatch) {
      const roomId = wsMatch[1];
      const doId = env.ROOM.idFromName(roomId);
      const stub = env.ROOM.get(doId);

      // Forward the WebSocket upgrade request to the DO
      return stub.fetch(new Request("http://room/ws", {
        method: "GET",
        headers: request.headers,
      }));
    }

    // GET /rooms/:room_id/history — message history
    const historyMatch = url.pathname.match(/^\/rooms\/([a-z0-9]+)\/history$/);
    if (historyMatch) {
      const roomId = historyMatch[1];
      const doId = env.ROOM.idFromName(roomId);
      const stub = env.ROOM.get(doId);
      const res = await stub.fetch(new Request("http://room/history"));
      const data = await res.json();
      return Response.json(data, { headers: corsHeaders() });
    }

    // GET /rooms/:room_id — room info
    const infoMatch = url.pathname.match(/^\/rooms\/([a-z0-9]+)$/);
    if (infoMatch) {
      const roomId = infoMatch[1];
      const doId = env.ROOM.idFromName(roomId);
      const stub = env.ROOM.get(doId);
      const res = await stub.fetch(new Request("http://room/info"));
      const data = await res.json();
      return Response.json(data, { headers: corsHeaders() });
    }

    return Response.json(
      { error: "Not found" },
      { status: 404, headers: corsHeaders() }
    );
  },
} satisfies ExportedHandler<Env>;
