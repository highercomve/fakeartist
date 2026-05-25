import { describe, it, expect } from "vitest";
import { Engine } from "./engine";
import { LoopbackTransport, RTCTransport, RelayTransport, envToEvent, eventToEnv } from "./transport";
import type { ClientCommand, Envelope, ServerEvent } from "./protocol";
import { newGameState } from "./models";

describe("LoopbackTransport", () => {
  it("delivers broadcast events", () => {
    const e = new Engine("room-1", { config: { min_players: 1 } });
    const t = new LoopbackTransport({ engine: e, selfPlayerId: "p1" });
    const events: ServerEvent[] = [];
    t.onEvent((evt) => events.push(evt));
    t.send({ type: "JOIN_GAME", payload: { id: "p1", player_name: "Host" } });
    // STATE_UPDATE always fires; PLAYER_WELCOME is direct.
    expect(events.some((e) => e.type === "STATE_UPDATE")).toBe(true);
    expect(events.some((e) => e.type === "PLAYER_WELCOME")).toBe(true);
  });

  it("filters direct events by player id", () => {
    const e = new Engine("room-1", { config: { min_players: 2 } });
    const tA = new LoopbackTransport({ engine: e, selfPlayerId: "pA" });
    const tB = new LoopbackTransport({ engine: e, selfPlayerId: "pB" });
    const aEvents: ServerEvent[] = [];
    const bEvents: ServerEvent[] = [];
    tA.onEvent((evt) => aEvents.push(evt));
    tB.onEvent((evt) => bEvents.push(evt));

    tA.send({ type: "JOIN_GAME", payload: { id: "pA", player_name: "A" } });
    expect(aEvents.some((e) => e.type === "PLAYER_WELCOME")).toBe(true);
    expect(bEvents.some((e) => e.type === "PLAYER_WELCOME")).toBe(false);
  });

  it("closes cleanly", async () => {
    const e = new Engine("room-1", { config: { min_players: 1 } });
    const t = new LoopbackTransport({ engine: e, selfPlayerId: "p1" });
    await t.close();
    expect(t.status).toBe("closed");
  });
});

// Fake RTCDataChannel just enough for RTCTransport's needs.
class FakeDC {
  readyState: "connecting" | "open" | "closed" = "open";
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  send(s: string) { this.sent.push(s); }
  close() { this.readyState = "closed"; this.onclose?.(); }
  // helper for tests
  fakeRecv(env: Envelope) { this.onmessage?.({ data: JSON.stringify(env) }); }
}

describe("RTCTransport", () => {
  it("serializes outgoing commands as CMD envelopes with monotonic seq", () => {
    const dc = new FakeDC();
    const t = new RTCTransport({ channel: dc as unknown as RTCDataChannel });
    const cmd: ClientCommand = { type: "START_GAME", payload: {} };
    t.send(cmd);
    t.send(cmd);
    expect(dc.sent).toHaveLength(2);
    const env1 = JSON.parse(dc.sent[0]) as Envelope;
    const env2 = JSON.parse(dc.sent[1]) as Envelope;
    expect(env1.t).toBe("CMD");
    expect(env2.t).toBe("CMD");
    expect((env1 as any).seq).toBe(1);
    expect((env2 as any).seq).toBe(2);
  });

  it("translates STATE_UPDATE envelopes into ServerEvents", () => {
    const dc = new FakeDC();
    const t = new RTCTransport({ channel: dc as unknown as RTCDataChannel });
    const events: ServerEvent[] = [];
    t.onEvent((e) => events.push(e));
    const st = newGameState("room-x");
    dc.fakeRecv({ t: "STATE_UPDATE", version: 1, state: st });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("STATE_UPDATE");
    expect((events[0] as any).payload.id).toBe("room-x");
  });

  it("translates STROKE_ADDED and YOUR_ROLE", () => {
    const dc = new FakeDC();
    const t = new RTCTransport({ channel: dc as unknown as RTCDataChannel });
    const events: ServerEvent[] = [];
    t.onEvent((e) => events.push(e));
    dc.fakeRecv({
      t: "STROKE_ADDED",
      round_index: 0,
      stroke_index: 0,
      stroke: { player_id: "p1", color: "#000", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
    });
    dc.fakeRecv({ t: "YOUR_ROLE", round_index: 0, payload: { is_fake: false, word: "cat" } });
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("STROKE_ADDED");
    expect((events[0] as any).payload.stroke_index).toBe(0);
    expect(events[1].type).toBe("YOUR_ROLE");
    expect((events[1] as any).payload.word).toBe("cat");
  });

  it("invokes onFrame for transport-only frames like SYNC_RES", () => {
    const dc = new FakeDC();
    const frames: Envelope[] = [];
    const t = new RTCTransport({
      channel: dc as unknown as RTCDataChannel,
      onFrame: (env) => frames.push(env),
    });
    dc.fakeRecv({ t: "SYNC_RES", state: newGameState("r"), version: 5, strokes: [] });
    expect(frames).toHaveLength(1);
    expect(frames[0].t).toBe("SYNC_RES");
  });

  it("drops malformed JSON silently", () => {
    const dc = new FakeDC();
    const t = new RTCTransport({ channel: dc as unknown as RTCDataChannel });
    const events: ServerEvent[] = [];
    t.onEvent((e) => events.push(e));
    dc.onmessage?.({ data: "not-json" });
    expect(events).toHaveLength(0);
  });

  it("closes cleanly", async () => {
    const dc = new FakeDC();
    const t = new RTCTransport({ channel: dc as unknown as RTCDataChannel });
    await t.close();
    expect(t.status).toBe("closed");
    expect(dc.readyState).toBe("closed");
  });
});

describe("RelayTransport (T9.2)", () => {
  it("wraps outbound commands and delivers inbound DC envelopes as events", () => {
    const sent: Envelope[] = [];
    const t = new RelayTransport({ sendRelay: (env) => sent.push(env) });
    const events: ServerEvent[] = [];
    t.onEvent((e) => events.push(e));

    t.send({ type: "START_GAME", payload: {} });
    expect(sent).toHaveLength(1);
    expect(sent[0].t).toBe("CMD");
    expect((sent[0] as any).seq).toBe(1);

    const st = newGameState("rid");
    t.handleRelayIn({ t: "STATE_UPDATE", version: 1, state: st });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("STATE_UPDATE");
    expect((events[0] as any).payload.id).toBe("rid");
  });

  it("close clears listeners and flips status", async () => {
    const t = new RelayTransport({ sendRelay: () => {} });
    await t.close();
    expect(t.status).toBe("closed");
  });
});

describe("envToEvent / eventToEnv", () => {
  it("round-trips STATE_UPDATE", () => {
    const st = newGameState("r");
    const env = eventToEnv({ type: "STATE_UPDATE", payload: st }, { version: 3 });
    expect(env?.t).toBe("STATE_UPDATE");
    const evt = envToEvent(env!);
    expect(evt?.type).toBe("STATE_UPDATE");
  });

  it("returns null for transport-only frames", () => {
    expect(envToEvent({ t: "CMD", seq: 1, cmd: { type: "START_GAME", payload: {} } })).toBeNull();
    expect(envToEvent({ t: "SYNC_REQ", round_index: 0, from_stroke_index: 0 })).toBeNull();
  });
});
