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
  | { type: "register"; display_name: string; summary: string; project_hint: string; key_hash: string }
  | { type: "message"; text: string; to_id?: string }
  | { type: "set_summary"; summary: string }
  | { type: "accept_peer"; pending_peer_id: string }
  | { type: "reject_peer"; pending_peer_id: string };

// --- Server → Client ---

export type ServerMessage =
  | { type: "registered"; peer_id: string; peers: PeerInfo[]; }
  | { type: "message"; from_id: string; from_name: string; text: string; sent_at: string; to_id?: string }
  | { type: "peer_joined"; peer: PeerInfo }
  | { type: "peer_left"; peer_id: string; display_name: string }
  | { type: "validate_peer"; pending_peer_id: string; display_name: string; key_hash: string }
  | { type: "peer_rejected"; reason: string }
  | { type: "error"; message: string };

// --- Worker Env ---

export interface Env {
  ROOM: DurableObjectNamespace;
}
