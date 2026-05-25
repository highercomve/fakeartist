import type { GameState } from "./models";

// Port of session.go::sanitize. Strips pool words always, and round
// secrets unless we're in ROUND_SUMMARY or GAME_OVER. Returns a new
// object; the input is not mutated.
export function sanitize(state: GameState): GameState {
  const pool = state.pool.map((c) => ({ ...c, word: undefined }));
  const out: GameState = {
    ...state,
    pool,
    pool_size: pool.length,
  };
  if (state.current_round) {
    const r = { ...state.current_round };
    if (state.status !== "ROUND_SUMMARY" && state.status !== "GAME_OVER") {
      r.card_id = undefined;
      r.fake_id = undefined;
      r.revealed_word = undefined;
      r.fake_guess = undefined;
      r.votes = undefined;
      r.outcome = "";
    }
    out.current_round = r;
  }
  return out;
}
