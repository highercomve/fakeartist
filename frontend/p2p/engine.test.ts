import { describe, it, expect, beforeEach } from "vitest";
import { Engine } from "./engine";
import type { ServerEvent } from "./protocol";

function seededRng(seed = 42) {
  // Mulberry32 — small, deterministic, good enough for tests.
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function mkEngine(seed = 42, configOverride = {}) {
  const e = new Engine("room-1", {
    rng: seededRng(seed),
    config: { min_players: 1, target_score: 5, strokes_per_artist: 2, ...configOverride },
  });
  const events: ServerEvent[] = [];
  const direct: Array<{ pid: string; evt: ServerEvent }> = [];
  e.onBroadcast((evt) => events.push(evt));
  e.onDirect((pid, evt) => direct.push({ pid, evt }));
  return { e, events, direct };
}

function getLatestState(events: ServerEvent[]) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "STATE_UPDATE") return (events[i] as any).payload;
  }
  return null;
}

describe("Engine join/configure/words", () => {
  it("first joiner becomes admin & host", () => {
    const { e, direct } = mkEngine();
    e.dispatch({ type: "JOIN_GAME", payload: { id: "p1", player_name: "Alice" } }, "p1");
    expect(e.state.players).toHaveLength(1);
    expect(e.state.players[0].is_admin).toBe(true);
    expect(e.state.host_id).toBe("p1");
    expect(direct.some((d) => d.pid === "p1" && d.evt.type === "PLAYER_WELCOME")).toBe(true);
  });

  it("second join is a normal player", () => {
    const { e } = mkEngine();
    e.dispatch({ type: "JOIN_GAME", payload: { id: "p1", player_name: "Alice" } }, "p1");
    e.dispatch({ type: "JOIN_GAME", payload: { id: "p2", player_name: "Bob" } }, "p2");
    expect(e.state.players).toHaveLength(2);
    expect(e.state.players[1].is_admin).toBe(false);
  });

  it("re-join with same id reconnects", () => {
    const { e } = mkEngine();
    e.dispatch({ type: "JOIN_GAME", payload: { id: "p1", player_name: "Alice" } }, "p1");
    e.state.players[0].connected = false;
    e.dispatch({ type: "JOIN_GAME", payload: { id: "p1", player_name: "Alice" } }, "p1");
    expect(e.state.players).toHaveLength(1);
    expect(e.state.players[0].connected).toBe(true);
  });

  it("configure only allowed for host in LOBBY", () => {
    const { e } = mkEngine();
    e.dispatch({ type: "JOIN_GAME", payload: { id: "p1", player_name: "Host" } }, "p1");
    e.dispatch({ type: "JOIN_GAME", payload: { id: "p2", player_name: "Guest" } }, "p2");
    e.dispatch({ type: "CONFIGURE_GAME", payload: { target_score: 99 } }, "p2");
    expect(e.state.config.target_score).not.toBe(99);
    e.dispatch({ type: "CONFIGURE_GAME", payload: { target_score: 99 } }, "p1");
    expect(e.state.config.target_score).toBe(99);
  });

  it("submit words only counts once and trims blanks", () => {
    const { e } = mkEngine();
    e.dispatch({ type: "JOIN_GAME", payload: { id: "p1", player_name: "Host" } }, "p1");
    e.dispatch({ type: "START_GAME", payload: {} }, "p1");
    expect(e.state.status).toBe("WRITING");
    e.dispatch({ type: "SUBMIT_WORDS", payload: { words: ["dog", " ", "  cat ", ""] } }, "p1");
    expect(e.state.pool).toHaveLength(2);
    e.dispatch({ type: "SUBMIT_WORDS", payload: { words: ["extra"] } }, "p1");
    expect(e.state.pool).toHaveLength(2);
  });
});

describe("Engine round flow", () => {
  function bootstrap(minPlayers = 1) {
    const { e, events, direct } = mkEngine(1, { min_players: minPlayers });
    e.dispatch({ type: "JOIN_GAME", payload: { id: "p1", player_name: "Host" } }, "p1");
    e.dispatch({ type: "START_GAME", payload: {} }, "p1");
    e.dispatch({ type: "SUBMIT_WORDS", payload: { words: ["tractor", "banana", "cactus"] } }, "p1");
    e.dispatch({ type: "START_ROUND", payload: {} }, "p1");
    return { e, events, direct };
  }

  it("startRound picks card and announces", () => {
    const { e, direct } = bootstrap();
    expect(e.state.status).toBe("ROUND_ANNOUNCE");
    expect(e.state.current_round).toBeTruthy();
    expect(e.state.current_round!.turn_order).toEqual(["p1"]);
    const role = direct.find((d) => d.evt.type === "YOUR_ROLE");
    expect(role).toBeTruthy();
    // solo player must be the fake (only one player)
    expect((role!.evt as any).payload.is_fake).toBe(true);
  });

  it("submitStroke appends and auto-transitions to VOTING", () => {
    const { e } = bootstrap();
    e.dispatch({ type: "START_ROUND", payload: {} }, "p1"); // ANNOUNCE -> DRAWING
    expect(e.state.status).toBe("DRAWING");
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
    // strokes_per_artist=2 * 1 player => need 2 strokes
    e.dispatch({ type: "SUBMIT_STROKE", payload: { points: pts } }, "p1");
    expect(e.state.status).toBe("DRAWING");
    e.dispatch({ type: "SUBMIT_STROKE", payload: { points: pts } }, "p1");
    expect(e.state.status).toBe("VOTING");
    expect(e.state.current_round!.strokes).toHaveLength(2);
  });

  it("rejects stroke from wrong player", () => {
    const { e } = mkEngine(1, { min_players: 2, strokes_per_artist: 1 });
    e.dispatch({ type: "JOIN_GAME", payload: { id: "p1", player_name: "Host" } }, "p1");
    e.dispatch({ type: "JOIN_GAME", payload: { id: "p2", player_name: "Bob" } }, "p2");
    e.dispatch({ type: "START_GAME", payload: {} }, "p1");
    e.dispatch({ type: "SUBMIT_WORDS", payload: { words: ["dog"] } }, "p1");
    e.dispatch({ type: "SUBMIT_WORDS", payload: { words: ["cat"] } }, "p2");
    e.dispatch({ type: "START_ROUND", payload: {} }, "p1");
    e.dispatch({ type: "START_ROUND", payload: {} }, "p1"); // -> DRAWING
    const turnPlayer = e.state.current_round!.turn_order[0];
    const otherPlayer = e.state.current_round!.turn_order[1];
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
    const before = e.state.current_round!.stroke_index;
    e.dispatch({ type: "SUBMIT_STROKE", payload: { points: pts } }, otherPlayer);
    expect(e.state.current_round!.stroke_index).toBe(before);
    e.dispatch({ type: "SUBMIT_STROKE", payload: { points: pts } }, turnPlayer);
    expect(e.state.current_round!.stroke_index).toBe(before + 1);
  });
});

describe("Engine server-backed role draw (T6.3)", () => {
  it("uses the drawer when provided and applies the assignment map", async () => {
    const draws: any[] = [];
    const drawer = {
      draw: async (_room: string, round: number, players: string[]) => {
        draws.push({ round, players });
        return {
          card_id: "c1",
          fake_id_commitment: "deadbeef",
          assignments: {
            p1: { is_fake: false, word: "cat" },
            p2: { is_fake: true },
          },
        };
      },
      reveal: async () => ({ fake_id: "p2", word: "cat", nonce: "00" }),
    };
    const e = new Engine("room-x", { rng: () => 0.1, config: { min_players: 2, strokes_per_artist: 1 }, drawer });
    const direct: any[] = [];
    e.onDirect((pid, evt) => direct.push({ pid, evt }));

    e.dispatch({ type: "JOIN_GAME", payload: { id: "p1", player_name: "Host" } }, "p1");
    e.dispatch({ type: "JOIN_GAME", payload: { id: "p2", player_name: "Guest" } }, "p2");
    e.dispatch({ type: "START_GAME", payload: {} }, "p1");
    e.dispatch({ type: "SUBMIT_WORDS", payload: { words: ["cat"] } }, "p1");
    e.dispatch({ type: "SUBMIT_WORDS", payload: { words: ["dog"] } }, "p2");
    e.dispatch({ type: "START_ROUND", payload: {} }, "p1");

    // The draw runs async; wait one microtask cycle.
    await new Promise((r) => setTimeout(r, 5));

    expect(draws).toHaveLength(1);
    expect(e.state.status).toBe("ROUND_ANNOUNCE");
    expect(e.state.current_round!.fake_id).toBe("p2");
    // The host's own role envelope is delivered locally.
    const hostRole = direct.find((d) => d.pid === "p1" && d.evt.type === "YOUR_ROLE");
    expect(hostRole).toBeTruthy();
    expect(hostRole.evt.payload.is_fake).toBe(false);
    expect(hostRole.evt.payload.word).toBe("cat");
  });
});

describe("Engine full 4-player game", () => {
  it("plays a round to ROUND_SUMMARY with vote tally", () => {
    const { e } = mkEngine(7, { min_players: 4, strokes_per_artist: 1, target_score: 99 });
    for (const id of ["p1", "p2", "p3", "p4"]) {
      e.dispatch({ type: "JOIN_GAME", payload: { id, player_name: id } }, id);
    }
    e.dispatch({ type: "START_GAME", payload: {} }, "p1");
    for (const id of ["p1", "p2", "p3", "p4"]) {
      e.dispatch({ type: "SUBMIT_WORDS", payload: { words: ["thing"] } }, id);
    }
    e.dispatch({ type: "START_ROUND", payload: {} }, "p1");
    e.dispatch({ type: "START_ROUND", payload: {} }, "p1");
    expect(e.state.status).toBe("DRAWING");
    const r = e.state.current_round!;
    // each player draws one stroke
    for (const pid of r.turn_order) {
      e.dispatch({ type: "SUBMIT_STROKE", payload: { points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] } }, pid);
    }
    expect(e.state.status).toBe("VOTING");

    // Everyone votes for the fake.
    const fake = r.fake_id!;
    for (const pid of r.turn_order) {
      e.dispatch({ type: "CAST_VOTE", payload: { suspect_id: fake } }, pid);
    }
    // Fake was caught -> FAKE_GUESS phase
    expect(e.state.status).toBe("FAKE_GUESS");

    // Fake guesses correctly
    const actualWord = (e as any).privateRoundWord as string;
    e.dispatch({ type: "SUBMIT_FAKE_GUESS", payload: { guess: actualWord } }, fake);
    expect(e.state.status).toBe("ROUND_SUMMARY");
    expect(e.state.current_round!.outcome).toBe("FAKE_WON");
  });

  it("fake escapes (tie vote) -> outcome FAKE_WON", () => {
    const { e } = mkEngine(3, { min_players: 4, strokes_per_artist: 1, target_score: 99 });
    for (const id of ["p1", "p2", "p3", "p4"]) {
      e.dispatch({ type: "JOIN_GAME", payload: { id, player_name: id } }, id);
    }
    e.dispatch({ type: "START_GAME", payload: {} }, "p1");
    for (const id of ["p1", "p2", "p3", "p4"]) {
      e.dispatch({ type: "SUBMIT_WORDS", payload: { words: ["thing"] } }, id);
    }
    e.dispatch({ type: "START_ROUND", payload: {} }, "p1");
    e.dispatch({ type: "START_ROUND", payload: {} }, "p1");
    const r = e.state.current_round!;
    for (const pid of r.turn_order) {
      e.dispatch({ type: "SUBMIT_STROKE", payload: { points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] } }, pid);
    }
    expect(e.state.status).toBe("VOTING");
    // Distribute votes so no majority — each player votes for a different other player.
    // We'll just pair-vote: tied between two suspects.
    const order = r.turn_order;
    e.dispatch({ type: "CAST_VOTE", payload: { suspect_id: order[1] } }, order[0]);
    e.dispatch({ type: "CAST_VOTE", payload: { suspect_id: order[0] } }, order[1]);
    e.dispatch({ type: "CAST_VOTE", payload: { suspect_id: order[1] } }, order[2]);
    e.dispatch({ type: "CAST_VOTE", payload: { suspect_id: order[0] } }, order[3]);
    // tally: order[1]=2, order[0]=2 -> tie -> caught=false -> ROUND_SUMMARY directly
    expect(e.state.status).toBe("ROUND_SUMMARY");
    expect(e.state.current_round!.outcome).toBe("FAKE_WON");
    expect(e.state.players.find((p) => p.id === r.fake_id)!.score).toBe(1);
  });
});
