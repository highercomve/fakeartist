import { describe, it, expect } from "vitest";
import { Replica } from "./replica";
import { newGameState } from "./models";
import type { ServerEvent } from "./protocol";

describe("Replica", () => {
  it("captures my id on PLAYER_WELCOME", () => {
    const r = new Replica();
    r.apply({ type: "PLAYER_WELCOME", payload: { id: "p_me" } });
    expect(r.snapshot.myId).toBe("p_me");
  });

  it("stores role on YOUR_ROLE and clears on LOBBY transition", () => {
    const r = new Replica();
    r.apply({ type: "YOUR_ROLE", payload: { is_fake: false, word: "dog" } });
    expect(r.snapshot.myRole?.word).toBe("dog");
    const st = newGameState("x");
    st.status = "LOBBY";
    r.apply({ type: "STATE_UPDATE", payload: st });
    expect(r.snapshot.myRole).toBeNull();
  });

  it("relays stroke events", () => {
    const r = new Replica();
    let captured: any = null;
    r.onStroke((p) => (captured = p));
    r.apply({
      type: "STROKE_ADDED",
      payload: {
        stroke: { player_id: "p1", color: "#fff", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
        stroke_index: 1,
      },
    });
    expect(captured.stroke.player_id).toBe("p1");
    expect(r.snapshot.lastStrokeIndex).toBe(0);
  });

  it("applies a sequence of events monotonically", () => {
    const r = new Replica();
    const stream: ServerEvent[] = [
      { type: "PLAYER_WELCOME", payload: { id: "p1" } },
      { type: "STATE_UPDATE", payload: { ...newGameState("x"), status: "DRAWING" } },
      { type: "STATE_UPDATE", payload: { ...newGameState("x"), status: "VOTING" } },
    ];
    stream.forEach((e) => r.apply(e));
    expect(r.snapshot.state?.status).toBe("VOTING");
    expect(r.snapshot.lastVersion).toBe(2);
  });

  it("relays errors", () => {
    const r = new Replica();
    let msg = "";
    r.onError((m) => (msg = m));
    r.apply({ type: "ERROR", payload: { message: "boom" } });
    expect(msg).toBe("boom");
  });
});

describe("Replica gap detection", () => {
  function mkRoundState(roundIdx = 0, strokeIdx = 0) {
    const st = newGameState("x");
    st.status = "DRAWING";
    st.current_round = {
      index: roundIdx,
      turn_order: ["p1", "p2"],
      stroke_index: strokeIdx,
      strokes: [],
      votes_cast: 0,
    };
    return st;
  }
  const mkStrokeEvt = (idx: number) => ({
    type: "STROKE_ADDED" as const,
    payload: {
      stroke: { player_id: "p1", color: "#fff", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
      stroke_index: idx,
    },
  });

  it("delivers strokes in order when no gap", () => {
    const r = new Replica();
    r.apply({ type: "STATE_UPDATE", payload: mkRoundState(0, 0) });
    const got: number[] = [];
    r.onStroke((p) => got.push(p.stroke_index));
    r.apply(mkStrokeEvt(1));
    r.apply(mkStrokeEvt(2));
    r.apply(mkStrokeEvt(3));
    expect(got).toEqual([1, 2, 3]);
  });

  it("buffers out-of-order strokes and emits a sync request", () => {
    const requests: Array<{ round: number; idx: number }> = [];
    const r = new Replica({ requestSync: (round, idx) => requests.push({ round, idx }) });
    r.apply({ type: "STATE_UPDATE", payload: mkRoundState(0, 0) });
    const got: number[] = [];
    r.onStroke((p) => got.push(p.stroke_index));
    // skip index 0 (applied=0), receive index 1 (applied=1)
    r.apply(mkStrokeEvt(2));
    r.apply(mkStrokeEvt(3));
    expect(got).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0].round).toBe(0);
    expect(requests[0].idx).toBe(0);
  });

  it("drains pending after SYNC_RES fills the gap", () => {
    const r = new Replica({ requestSync: () => {} });
    r.apply({ type: "STATE_UPDATE", payload: mkRoundState(0, 0) });
    const got: number[] = [];
    r.onStroke((p) => got.push(p.stroke_index));
    // gap: receive index 2 (applied=1)
    r.apply(mkStrokeEvt(3));
    // sync delivers strokes 0 and 1 (applied)
    r.applyFrame({
      t: "SYNC_RES",
      state: mkRoundState(0, 3),
      version: 1,
      strokes: [
        { round_index: 0, stroke_index: 0, stroke: { player_id: "p1", color: "#fff", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] } },
        { round_index: 0, stroke_index: 1, stroke: { player_id: "p2", color: "#fff", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] } },
      ],
    });
    expect(got).toContain(1); // stroke at applied=0 emitted as next-idx=1
    expect(got).toContain(2);
    expect(got).toContain(3); // pending drained
  });

  it("ignores stale (duplicate) strokes below the floor", () => {
    const r = new Replica();
    r.apply({ type: "STATE_UPDATE", payload: mkRoundState(0, 0) });
    const got: number[] = [];
    r.onStroke((p) => got.push(p.stroke_index));
    r.apply(mkStrokeEvt(1));
    r.apply(mkStrokeEvt(1)); // duplicate
    expect(got).toEqual([1]);
  });

  it("resets gap floor on a new round", () => {
    const r = new Replica();
    r.apply({ type: "STATE_UPDATE", payload: mkRoundState(0, 0) });
    r.apply(mkStrokeEvt(1));
    r.apply({ type: "STATE_UPDATE", payload: mkRoundState(1, 0) });
    const got: number[] = [];
    r.onStroke((p) => got.push(p.stroke_index));
    r.apply(mkStrokeEvt(1));
    expect(got).toEqual([1]);
  });
});
