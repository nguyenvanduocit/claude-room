// Unique ID for each Claude Code instance (generated on registration)
export type PeerId = string;

export interface Peer {
  id: PeerId;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  registered_at: string; // ISO timestamp
  last_seen: string; // ISO timestamp
}

export interface Message {
  id: number;
  from_id: PeerId;
  to_id: PeerId;
  text: string;
  sent_at: string; // ISO timestamp
  delivered: boolean;
}

// --- Broker API types ---

export interface RegisterRequest {
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
}

export interface RegisterResponse {
  id: PeerId;
}

export interface HeartbeatRequest {
  id: PeerId;
}

export interface SetSummaryRequest {
  id: PeerId;
  summary: string;
}

export interface ListPeersRequest {
  scope: "machine" | "directory" | "repo";
  // The requesting peer's context (used for filtering)
  cwd: string;
  git_root: string | null;
  exclude_id?: PeerId;
}

export interface SendMessageRequest {
  from_id: PeerId;
  to_id: PeerId;
  text: string;
}

export interface PollMessagesRequest {
  id: PeerId;
}

export interface PollMessagesResponse {
  messages: Message[];
}

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
  | { type: "register"; display_name: string; summary: string; project_hint: string }
  | { type: "message"; text: string; to_id?: string }
  | { type: "set_summary"; summary: string };

export type CloudServerMessage =
  | { type: "registered"; peer_id: string; peers: CloudPeerInfo[]; history: CloudHistoryMessage[] }
  | { type: "message"; from_id: string; from_name: string; text: string; sent_at: string; to_id?: string }
  | { type: "peer_joined"; peer: CloudPeerInfo }
  | { type: "peer_left"; peer_id: string; display_name: string }
  | { type: "error"; message: string };
