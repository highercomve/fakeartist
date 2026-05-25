import { describe, it, expect, vi } from "vitest";
import { Engine } from "./engine";
import { HostBridge } from "./hostBridge";
import type { Envelope } from "./protocol";

// FakePeerHub: just enough surface for the bridge to talk to.
class FakePeerHub {
  broadcasted: unknown[] = [];
  direct: Array<{ peerId: string; env: unknown }> = [];
  msgListeners: Array<(peerId: string, data: string) => void> = [];

  broadcast(env: unknown) { this.broadcasted.push(env); }
  send(peerId: string, env: unknown) { this.direct.push({ peerId, env }); }
  onPeerMessage(fn: (peerId: string, data: string) => void): () => void {
    this.msgListeners.push(fn);
    return () => { this.msgListeners = this.msgListeners.filter((f) => f !== fn); };
  }

  // helper: simulate inbound
  recv(peerId: string, env: Envelope) {
    this.msgListeners.forEach((fn) => fn(peerId, JSON.stringify(env)));
  }
}

describe("HostBridge", () => {
  it("relays engine broadcasts to peerHub.broadcast", () => {
    const e = new Engine("r", { config: { min_players: 1 } });
    const hub = new FakePeerHub();
    new HostBridge({ engine: e, peerHub: hub as any });

    e.dispatch({ type: "JOIN_GAME", payload: { id: "p1", player_name: "Host" } }, "p1");
    // STATE_UPDATE was broadcast at least once.
    const stateUpdates = hub.broadcasted.filter((env: any) => env.t === "STATE_UPDATE");
    expect(stateUpdates.length).toBeGreaterThanOrEqual(1);
  });

  it("relays direct events (PLAYER_WELCOME) to the right peer", () => {
    const e = new Engine("r", { config: { min_players: 1 } });
    const hub = new FakePeerHub();
    new HostBridge({ engine: e, peerHub: hub as any });

    e.dispatch({ type: "JOIN_GAME", payload: { id: "p1", player_name: "Host" } }, "p1");
    const welcome = hub.direct.find((d: any) => (d.env as any).t === "PLAYER_WELCOME");
    expect(welcome).toBeTruthy();
    expect(welcome!.peerId).toBe("p1");
  });

  it("dispatches inbound CMD envelopes to the engine", () => {
    const e = new Engine("r", { config: { min_players: 2 } });
    const hub = new FakePeerHub();
    new HostBridge({ engine: e, peerHub: hub as any });

    // Bootstrap host
    e.dispatch({ type: "JOIN_GAME", payload: { id: "host", player_name: "Host" } }, "host");
    // Guest joins via DC
    hub.recv("p2", { t: "CMD", seq: 1, cmd: { type: "JOIN_GAME", payload: { id: "p2", player_name: "Guest" } } });
    expect(e.state.players.find((p) => p.id === "p2")).toBeTruthy();
  });

  it("serves SYNC_RES from in-memory strokes when no log is set", async () => {
    const e = new Engine("r", { rng: () => 0.1, config: { min_players: 2, strokes_per_artist: 2 } });
    const hub = new FakePeerHub();
    new HostBridge({ engine: e, peerHub: hub as any });

    e.dispatch({ type: "JOIN_GAME", payload: { id: "host", player_name: "Host" } }, "host");
    e.dispatch({ type: "JOIN_GAME", payload: { id: "p2", player_name: "Guest" } }, "p2");
    e.dispatch({ type: "START_GAME", payload: {} }, "host");
    e.dispatch({ type: "SUBMIT_WORDS", payload: { words: ["dog"] } }, "host");
    e.dispatch({ type: "SUBMIT_WORDS", payload: { words: ["cat"] } }, "p2");
    e.dispatch({ type: "START_ROUND", payload: {} }, "host");
    e.dispatch({ type: "START_ROUND", payload: {} }, "host"); // -> DRAWING

    const r = e.state.current_round!;
    const turnPlayer = r.turn_order[0];
    e.dispatch({ type: "SUBMIT_STROKE", payload: { points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] } }, turnPlayer);

    // Clear capture, request sync from index 0.
    hub.direct.length = 0;
    hub.recv("p2", { t: "SYNC_REQ", round_index: r.index, from_stroke_index: 0 });

    // wait one microtask tick for the async handler
    await new Promise((r) => setTimeout(r, 0));

    const sync = hub.direct.find((d: any) => (d.env as any).t === "SYNC_RES");
    expect(sync).toBeTruthy();
    expect((sync!.env as any).strokes).toHaveLength(1);
  });
});
