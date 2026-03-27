// --- Peer ---

export interface PeerInfo {
  id: string;
  display_name: string;
  summary: string;
  project_hint: string;
  connected_at: string;
}

// --- Message History ---

export interface HistoryMessage {
  from_id: string;
  from_name: string;
  text: string;
  sent_at: string;
  to_id?: string; // undefined = broadcast
}

// --- Client → Server ---

export type ClientMessage =
  | { type: "register"; display_name: string; summary: string; project_hint: string }
  | { type: "message"; text: string; to_id?: string }
  | { type: "set_summary"; summary: string };

// --- Server → Client ---

export type ServerMessage =
  | { type: "registered"; peer_id: string; peers: PeerInfo[]; history: HistoryMessage[] }
  | { type: "message"; from_id: string; from_name: string; text: string; sent_at: string; to_id?: string }
  | { type: "peer_joined"; peer: PeerInfo }
  | { type: "peer_left"; peer_id: string; display_name: string }
  | { type: "error"; message: string };

// --- Worker Env ---

export interface Env {
  ROOM: DurableObjectNamespace;
}
