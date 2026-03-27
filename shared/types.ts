// --- Cloud Broker Protocol ---

export interface CloudPeerInfo {
  id: string;
  display_name: string;
  summary: string;
  project_hint: string;
  connected_at: string;
}

export interface CloudHistoryMessage {
  from_id: string;
  from_name: string;
  text: string;
  sent_at: string;
  to_id?: string;
}

export type CloudClientMessage =
  | { type: "register"; display_name: string; summary: string; project_hint: string; key_hash: string }
  | { type: "message"; text: string; to_id?: string }
  | { type: "set_summary"; summary: string }
  | { type: "accept_peer"; pending_peer_id: string }
  | { type: "reject_peer"; pending_peer_id: string };

export type CloudServerMessage =
  | { type: "registered"; peer_id: string; peers: CloudPeerInfo[] }
  | { type: "message"; from_id: string; from_name: string; text: string; sent_at: string; to_id?: string }
  | { type: "peer_joined"; peer: CloudPeerInfo }
  | { type: "peer_left"; peer_id: string; display_name: string }
  | { type: "validate_peer"; pending_peer_id: string; display_name: string; key_hash: string }
  | { type: "peer_rejected"; reason: string }
  | { type: "error"; message: string };
