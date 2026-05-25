// HostBridge: glues the host's Engine to the PeerHub.
//
// Responsibilities (host-only):
//   - Wire engine.onBroadcast -> peerHub.broadcast as STATE_UPDATE /
//     STROKE_ADDED envelopes (with round_index + version stamped from
//     engine state).
//   - Wire engine.onDirect -> peerHub.send(peerId, ...) translating
//     PLAYER_WELCOME / YOUR_ROLE / ERROR envelopes.
//   - Handle inbound CMD envelopes from guests by calling engine.dispatch
//     with the sender's playerId.
//   - Handle SYNC_REQ from guests by sending a SYNC_RES with the current
//     state + strokes from the requested index (uses StrokeLog if
//     present; falls back to the engine's in-memory round strokes).
//
// The host's *own* commands continue to flow through LoopbackTransport;
// the bridge only services remote peers.

import type { Engine } from "./engine";
import type { PeerHub } from "./peerHub";
import type { StrokeLog } from "./log";
import type { Envelope, IndexedStrokeFrame, ServerEvent } from "./protocol";
import { eventToEnv } from "./transport";

export interface HostBridgeOptions {
  engine: Engine;
  peerHub: PeerHub;
  // Optional persistent log; when present, SYNC_RES is served from disk
  // so a guest reconnecting after the host's in-memory round_index has
  // advanced still gets the right slice.
  log?: StrokeLog;
}

export class HostBridge {
  private engine: Engine;
  private peerHub: PeerHub;
  private log: StrokeLog | undefined;
  private unsub: Array<() => void> = [];

  constructor(opts: HostBridgeOptions) {
    this.engine = opts.engine;
    this.peerHub = opts.peerHub;
    this.log = opts.log;

    this.unsub.push(
      this.engine.onBroadcast((evt) => this.relayBroadcast(evt)),
    );
    this.unsub.push(
      this.engine.onDirect((pid, evt) => this.relayDirect(pid, evt)),
    );

    // Inbound DC frames from any peer feed back into the engine.
    this.unsub.push(
      this.peerHub.onPeerMessage((peerId, data) => this.handlePeerMessage(peerId, data)),
    );
  }

  close(): void {
    this.unsub.forEach((fn) => fn());
    this.unsub = [];
  }

  private relayBroadcast(evt: ServerEvent): void {
    const r = this.engine.state.current_round;
    const env = eventToEnv(evt, {
      version: this.engine.version,
      round_index: r ? r.index : 0,
    });
    if (!env) return;
    // Mirror into the log on the host side so SYNC_RES has something to
    // serve even after an in-memory restart of the round.
    if (this.log) {
      if (evt.type === "STROKE_ADDED" && r) {
        // fire-and-forget; log writes are async but we don't want to
        // serialize the broadcast on them.
        void this.log.appendStroke(r.index, evt.payload.stroke_index - 1, evt.payload.stroke);
      } else if (evt.type === "STATE_UPDATE") {
        void this.log.putState(this.engine.version, evt.payload);
      }
    }
    this.peerHub.broadcast(env);
  }

  private relayDirect(playerId: string, evt: ServerEvent): void {
    const r = this.engine.state.current_round;
    const env = eventToEnv(evt, {
      version: this.engine.version,
      round_index: r ? r.index : 0,
    });
    if (!env) return;
    this.peerHub.send(playerId, env);
  }

  private async handlePeerMessage(peerId: string, data: string): Promise<void> {
    let env: Envelope;
    try {
      env = JSON.parse(data) as Envelope;
    } catch {
      return;
    }
    switch (env.t) {
      case "CMD":
        // Trust the peer's identity from the PeerHub connection — the
        // signaling server already authenticated who owns each peerId.
        this.engine.dispatch(env.cmd, peerId);
        return;
      case "SYNC_REQ":
        await this.serveSyncReq(peerId, env.round_index, env.from_stroke_index);
        return;
      default:
        // STATE/STROKE/ROLE coming from a guest would be a protocol error;
        // drop silently.
        return;
    }
  }

  private async serveSyncReq(peerId: string, roundIndex: number, fromIdx: number): Promise<void> {
    let strokes: IndexedStrokeFrame[] = [];
    if (this.log) {
      const got = await this.log.getStrokesFrom(roundIndex, fromIdx);
      strokes = got.map((s) => ({
        round_index: roundIndex,
        stroke_index: s.stroke_index,
        stroke: s.stroke,
      }));
    } else {
      // fallback: in-memory round only. Sufficient for the current round
      // when no IndexedDB is available (tests, ephemeral host).
      const r = this.engine.state.current_round;
      if (r && r.index === roundIndex) {
        for (let i = fromIdx; i < r.strokes.length; i++) {
          strokes.push({ round_index: roundIndex, stroke_index: i, stroke: r.strokes[i] });
        }
      }
    }
    const res: Envelope = {
      t: "SYNC_RES",
      state: this.engine.state,
      version: this.engine.version,
      strokes,
    };
    this.peerHub.send(peerId, res);
  }
}
