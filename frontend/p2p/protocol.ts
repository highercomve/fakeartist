// DC wire protocol. ClientCommand mirrors the legacy server commands
// verbatim so the existing JSX components keep using the same strings.

import type { GameState, Stroke, RolePayload, GameConfig, Point } from "./models";

export type CommandType =
  | "JOIN_GAME"
  | "CONFIGURE_GAME"
  | "SUBMIT_WORDS"
  | "START_GAME"
  | "START_ROUND"
  | "SUBMIT_STROKE"
  | "CAST_VOTE"
  | "SUBMIT_FAKE_GUESS"
  | "NEXT_ROUND"
  | "END_GAME";

export interface JoinGamePayload {
  id?: string;
  player_name: string;
  room_code?: string;
}
export interface SubmitWordsPayload {
  words: string[];
}
export interface SubmitStrokePayload {
  points: Point[];
}
export interface CastVotePayload {
  suspect_id: string;
}
export interface SubmitFakeGuessPayload {
  guess: string;
}

export type ClientCommand =
  | { type: "JOIN_GAME"; payload: JoinGamePayload }
  | { type: "CONFIGURE_GAME"; payload: Partial<GameConfig> }
  | { type: "SUBMIT_WORDS"; payload: SubmitWordsPayload }
  | { type: "START_GAME"; payload?: Record<string, never> }
  | { type: "START_ROUND"; payload?: Record<string, never> }
  | { type: "SUBMIT_STROKE"; payload: SubmitStrokePayload }
  | { type: "CAST_VOTE"; payload: CastVotePayload }
  | { type: "SUBMIT_FAKE_GUESS"; payload: SubmitFakeGuessPayload }
  | { type: "NEXT_ROUND"; payload?: Record<string, never> }
  | { type: "END_GAME"; payload?: Record<string, never> };

// Engine-emitted events, modelled as legacy server messages so the
// existing components decode them unchanged.
export type ServerEvent =
  | { type: "STATE_UPDATE"; payload: GameState }
  | { type: "PLAYER_WELCOME"; payload: { id: string } }
  | { type: "YOUR_ROLE"; payload: RolePayload }
  | { type: "STROKE_ADDED"; payload: { stroke: Stroke; stroke_index: number } }
  | { type: "ERROR"; payload: { message: string } };

// IndexedStroke: stroke with its (round_index, stroke_index) coordinates,
// used in SYNC_RES payloads.
export interface IndexedStrokeFrame {
  round_index: number;
  stroke_index: number;
  stroke: Stroke;
}

// DC envelope, used between guest <-> host. PR 5 extends this with the
// stroke fan-out frames + SYNC handshake; PR 6 adds the role envelope.
export type Envelope =
  | { t: "CMD"; seq: number; cmd: ClientCommand; from?: string }
  | { t: "STATE_UPDATE"; version: number; state: GameState }
  | { t: "STROKE_ADDED"; round_index: number; stroke_index: number; stroke: Stroke }
  | { t: "YOUR_ROLE"; round_index: number; payload: RolePayload }
  | { t: "PLAYER_WELCOME"; payload: { id: string } }
  | { t: "SYNC_REQ"; round_index: number; from_stroke_index: number }
  | { t: "SYNC_RES"; state: GameState; version: number; strokes: IndexedStrokeFrame[] }
  | { t: "ERROR"; message: string };

// RELAY (T9.1): server-relay fallback envelope on the signaling WS.
// The `envelope` field is a DC Envelope JSON-encoded as-is; the server
// forwards by `to` without inspection (plan §10).
export interface RelayFrame {
  type: "RELAY";
  to: string;
  envelope: Envelope;
}
