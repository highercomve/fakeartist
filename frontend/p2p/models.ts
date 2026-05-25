// Port of internal/game/models.go. Types only — the engine and replica
// own the behaviour. Stay byte-compatible with the Go JSON so the React
// components keep working without changes.

export type GameStatus =
  | "LOBBY"
  | "WRITING"
  | "ROUND_ANNOUNCE"
  | "DRAWING"
  | "VOTING"
  | "FAKE_GUESS"
  | "ROUND_SUMMARY"
  | "GAME_OVER";

export type RoundOutcome = "" | "FAKE_WON" | "ARTISTS_WON";

export interface GameConfig {
  words_per_player: number;
  target_score: number;
  strokes_per_artist: number;
  min_players: number;
  turn_duration: number; // seconds; 0 = no limit
}

export interface Player {
  id: string;
  name: string;
  color: string;
  is_admin: boolean;
  connected: boolean;
  has_submitted: boolean;
  score: number;
}

export interface WordCard {
  id: string;
  word?: string; // STRIPPED in broadcast
  author_id: string;
  used: boolean;
}

export interface Point {
  x: number;
  y: number;
}

export interface Stroke {
  player_id: string;
  color: string;
  points: Point[];
}

export interface Round {
  index: number;
  card_id?: string;       // STRIPPED until summary
  fake_id?: string;       // STRIPPED until summary
  turn_order: string[];
  stroke_index: number;
  strokes: Stroke[];
  votes?: Record<string, string>; // STRIPPED until summary
  votes_cast: number;
  fake_guess?: string;
  outcome?: RoundOutcome;
  revealed_word?: string;
}

export interface GameState {
  id: string;
  host_id: string;
  status: GameStatus;
  players: Player[];
  pool: WordCard[];     // sanitized: word stripped
  pool_size: number;
  current_round: Round | null;
  // Archive of finalized rounds (strokes + revealed_word + outcome + votes).
  // Appended on NEXT_ROUND / GAME_OVER so the gallery survives across rounds.
  past_rounds: Round[];
  config: GameConfig;
  winner?: Player | null;
}

export const ColorPalette: string[] = [
  "#E53935",
  "#1E88E5",
  "#43A047",
  "#FB8C00",
  "#8E24AA",
  "#00ACC1",
  "#FDD835",
  "#6D4C41",
  "#EC407A",
  "#212121",
];

// Convenience factory.
export function newGameState(id = ""): GameState {
  return {
    id,
    host_id: "",
    status: "LOBBY",
    players: [],
    pool: [],
    pool_size: 0,
    current_round: null,
    past_rounds: [],
    config: {
      words_per_player: 3,
      target_score: 5,
      strokes_per_artist: 2,
      min_players: 4,
      turn_duration: 0,
    },
    winner: null,
  };
}

// Player role assignment payload, sent host -> peer over DC.
export interface RolePayload {
  is_fake: boolean;
  word?: string; // omitted for fake
}
