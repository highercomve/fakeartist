import { describe, it, expect } from "vitest";
import { sanitize } from "./sanitize";
import type { GameState } from "./models";
import { newGameState } from "./models";

function mkState(status: GameState["status"]): GameState {
  const s = newGameState("room-1");
  s.status = status;
  s.pool = [
    { id: "c1", word: "tractor", author_id: "p1", used: true },
    { id: "c2", word: "banana", author_id: "p2", used: false },
  ];
  s.current_round = {
    index: 0,
    card_id: "c1",
    fake_id: "p2",
    turn_order: ["p1", "p2", "p3"],
    stroke_index: 4,
    strokes: [],
    votes: { p1: "p2", p2: "p1", p3: "p2" },
    votes_cast: 3,
    fake_guess: "tractor",
    outcome: "ARTISTS_WON",
    revealed_word: "tractor",
  };
  return s;
}

describe("sanitize", () => {
  it("strips all pool word fields regardless of status", () => {
    const s = sanitize(mkState("DRAWING"));
    s.pool.forEach((c) => expect(c.word).toBeUndefined());
    expect(s.pool_size).toBe(2);
  });

  it("redacts round secrets during DRAWING", () => {
    const r = sanitize(mkState("DRAWING")).current_round!;
    expect(r.card_id).toBeUndefined();
    expect(r.fake_id).toBeUndefined();
    expect(r.revealed_word).toBeUndefined();
    expect(r.fake_guess).toBeUndefined();
    expect(r.votes).toBeUndefined();
    expect(r.outcome).toBe("");
  });

  it("redacts during VOTING", () => {
    const r = sanitize(mkState("VOTING")).current_round!;
    expect(r.votes).toBeUndefined();
    expect(r.fake_id).toBeUndefined();
  });

  it("reveals secrets in ROUND_SUMMARY", () => {
    const r = sanitize(mkState("ROUND_SUMMARY")).current_round!;
    expect(r.card_id).toBe("c1");
    expect(r.fake_id).toBe("p2");
    expect(r.revealed_word).toBe("tractor");
    expect(r.fake_guess).toBe("tractor");
    expect(r.votes).toEqual({ p1: "p2", p2: "p1", p3: "p2" });
    expect(r.outcome).toBe("ARTISTS_WON");
  });

  it("reveals secrets in GAME_OVER", () => {
    const r = sanitize(mkState("GAME_OVER")).current_round!;
    expect(r.fake_id).toBe("p2");
  });

  it("does not mutate the input", () => {
    const before = mkState("DRAWING");
    const snap = JSON.stringify(before);
    sanitize(before);
    expect(JSON.stringify(before)).toBe(snap);
  });

  it("handles null current_round", () => {
    const s = newGameState("room-1");
    s.status = "LOBBY";
    expect(() => sanitize(s)).not.toThrow();
  });
});
