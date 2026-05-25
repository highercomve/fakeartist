import { describe, it, expect, vi } from "vitest";
import { Engine } from "./engine";
import { CheckpointDispatcher } from "./checkpoint";

function mkFetch(captured: any[]) {
  return vi.fn(async (_url: string, init: any) => {
    captured.push({ body: JSON.parse(init.body) });
    return { ok: true, status: 204 } as any;
  });
}

describe("CheckpointDispatcher", () => {
  it("flushes on phase transitions", async () => {
    const e = new Engine("r1", { config: { min_players: 1 } });
    const captured: any[] = [];
    const cp = new CheckpointDispatcher({
      roomId: "r1", hostId: "p1", engine: e, fetch: mkFetch(captured) as any,
    });
    cp.start();
    // First STATE_UPDATE establishes the baseline status (no flush).
    e.dispatch({ type: "JOIN_GAME", payload: { id: "p1", player_name: "H" } }, "p1");
    // LOBBY -> WRITING is a phase transition.
    e.dispatch({ type: "START_GAME", payload: {} }, "p1");
    await new Promise((r) => setTimeout(r, 10));
    expect(captured.length).toBeGreaterThanOrEqual(1);
    expect(captured[captured.length - 1].body.state.status).toBe("WRITING");
    cp.close();
  });

  it("flushes every N strokes", async () => {
    const e = new Engine("r2", { rng: () => 0.1, config: { min_players: 1, strokes_per_artist: 20 } });
    const captured: any[] = [];
    const cp = new CheckpointDispatcher({
      roomId: "r2", hostId: "p1", engine: e, strokeThreshold: 3,
      fetch: mkFetch(captured) as any,
    });
    cp.start();
    e.dispatch({ type: "JOIN_GAME", payload: { id: "p1", player_name: "H" } }, "p1");
    e.dispatch({ type: "START_GAME", payload: {} }, "p1");
    e.dispatch({ type: "SUBMIT_WORDS", payload: { words: ["dog"] } }, "p1");
    e.dispatch({ type: "START_ROUND", payload: {} }, "p1");
    e.dispatch({ type: "START_ROUND", payload: {} }, "p1");
    captured.length = 0;
    // 3 strokes should trigger one stroke-threshold flush in addition
    // to per-state-update transitions (we don't change phase).
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
    e.dispatch({ type: "SUBMIT_STROKE", payload: { points: pts } }, "p1");
    e.dispatch({ type: "SUBMIT_STROKE", payload: { points: pts } }, "p1");
    e.dispatch({ type: "SUBMIT_STROKE", payload: { points: pts } }, "p1");
    await new Promise((r) => setTimeout(r, 20));
    expect(captured.length).toBeGreaterThanOrEqual(1);
    cp.close();
  });

  it("respects 30s time-based flush", async () => {
    const e = new Engine("r3", { config: { min_players: 1 } });
    const captured: any[] = [];
    let nowVal = 1_000;
    const cp = new CheckpointDispatcher({
      roomId: "r3", hostId: "p1", engine: e, timeMs: 30_000,
      now: () => nowVal,
      fetch: mkFetch(captured) as any,
    });
    cp.start();
    e.dispatch({ type: "JOIN_GAME", payload: { id: "p1", player_name: "H" } }, "p1");
    captured.length = 0;
    // Advance clock past threshold while version is unchanged from
    // the last flush; should not flush.
    nowVal = 100_000;
    await cp.maybeFlushByTime();
    // Engine version > lastFlushedVersion (no prior flush), so first
    // call WILL flush.
    expect(captured.length).toBeGreaterThanOrEqual(1);
    captured.length = 0;
    // Second call with no further version bump and clock not yet 30s
    // past the just-recorded lastFlushAt: should not flush.
    nowVal = 100_500;
    await cp.maybeFlushByTime();
    expect(captured.length).toBe(0);
    cp.close();
  });
});
