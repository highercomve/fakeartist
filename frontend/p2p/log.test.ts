import { describe, it, expect } from "vitest";
import "fake-indexeddb/auto";
import { StrokeLog } from "./log";
import type { Stroke, GameState } from "./models";
import { newGameState } from "./models";

function mkStroke(playerId: string, n = 2): Stroke {
  const points = [];
  for (let i = 0; i < n; i++) points.push({ x: i, y: i });
  return { player_id: playerId, color: "#000", points };
}

describe("StrokeLog", () => {

  it("appends and reads back strokes for a round", async () => {
    const log = new StrokeLog({ roomId: "room-a" });
    await log.appendStroke(0, 0, mkStroke("p1"));
    await log.appendStroke(0, 1, mkStroke("p2"));
    await log.appendStroke(0, 2, mkStroke("p3"));
    const got = await log.getStrokesFrom(0, 0);
    expect(got).toHaveLength(3);
    expect(got.map((s) => s.stroke_index)).toEqual([0, 1, 2]);
    expect(got[0].stroke.player_id).toBe("p1");
  });

  it("getStrokesFrom respects the lower bound", async () => {
    const log = new StrokeLog({ roomId: "room-b" });
    for (let i = 0; i < 5; i++) await log.appendStroke(0, i, mkStroke("p1"));
    const got = await log.getStrokesFrom(0, 2);
    expect(got.map((s) => s.stroke_index)).toEqual([2, 3, 4]);
  });

  it("isolates strokes per round", async () => {
    const log = new StrokeLog({ roomId: "room-c" });
    await log.appendStroke(0, 0, mkStroke("p1"));
    await log.appendStroke(1, 0, mkStroke("p2"));
    const r0 = await log.getStrokesFrom(0, 0);
    const r1 = await log.getStrokesFrom(1, 0);
    expect(r0).toHaveLength(1);
    expect(r1).toHaveLength(1);
    expect(r0[0].stroke.player_id).toBe("p1");
    expect(r1[0].stroke.player_id).toBe("p2");
  });

  it("isolates strokes per room", async () => {
    const a = new StrokeLog({ roomId: "room-d" });
    const b = new StrokeLog({ roomId: "room-e" });
    await a.appendStroke(0, 0, mkStroke("p1"));
    await b.appendStroke(0, 0, mkStroke("p2"));
    const ga = await a.getStrokesFrom(0, 0);
    const gb = await b.getStrokesFrom(0, 0);
    expect(ga[0].stroke.player_id).toBe("p1");
    expect(gb[0].stroke.player_id).toBe("p2");
  });

  it("tracks meta on stroke append", async () => {
    const log = new StrokeLog({ roomId: "room-f" });
    await log.appendStroke(0, 0, mkStroke("p1"));
    await log.appendStroke(0, 1, mkStroke("p1"));
    await log.appendStroke(0, 2, mkStroke("p1"));
    const meta = await log.getMeta();
    expect(meta?.last_round_index).toBe(0);
    expect(meta?.last_stroke_index).toBe(2);
  });

  it("resets stroke_index across rounds in meta", async () => {
    const log = new StrokeLog({ roomId: "room-g" });
    await log.appendStroke(0, 0, mkStroke("p1"));
    await log.appendStroke(0, 1, mkStroke("p1"));
    await log.appendStroke(1, 0, mkStroke("p1"));
    const meta = await log.getMeta();
    expect(meta?.last_round_index).toBe(1);
    expect(meta?.last_stroke_index).toBe(0);
  });

  it("persists and reads back state snapshot", async () => {
    const log = new StrokeLog({ roomId: "room-h" });
    const st: GameState = newGameState("room-h");
    st.status = "DRAWING";
    await log.putState(7, st);
    const got = await log.getState();
    expect(got?.version).toBe(7);
    expect(got?.state.id).toBe("room-h");
    const meta = await log.getMeta();
    expect(meta?.last_state_version).toBe(7);
  });

  it("clearRoom drops all data", async () => {
    const log = new StrokeLog({ roomId: "room-i" });
    await log.appendStroke(0, 0, mkStroke("p1"));
    await log.putState(1, newGameState("room-i"));
    await log.clearRoom();
    const got = await log.getStrokesFrom(0, 0);
    const meta = await log.getMeta();
    const st = await log.getState();
    expect(got).toHaveLength(0);
    expect(meta).toBeNull();
    expect(st).toBeNull();
  });

  it("handles stroke_index > 9 numeric ordering", async () => {
    const log = new StrokeLog({ roomId: "room-j" });
    for (let i = 0; i < 12; i++) await log.appendStroke(0, i, mkStroke("p1"));
    const got = await log.getStrokesFrom(0, 0);
    expect(got.map((s) => s.stroke_index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });
});
