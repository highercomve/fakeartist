// Transport abstraction. The React layer / Replica consumes events
// only via Transport.onEvent so it can stay ignorant of whether the
// host is local (LoopbackTransport) or remote (RTCTransport).

import type { Engine } from "./engine";
import type { ClientCommand, Envelope, ServerEvent } from "./protocol";

export type TransportStatus = "connecting" | "open" | "closed" | "reconnecting";

type Unsubscribe = () => void;

export interface Transport {
  send(cmd: ClientCommand): void;
  onEvent(handler: (evt: ServerEvent) => void): Unsubscribe;
  close(): Promise<void>;
  status: TransportStatus;
}

// LoopbackTransport: host-local; commands go straight into the engine
// and events come back out synchronously. This is the only Transport
// used by the host browser — its UI is driven by the same Replica
// that guests use.
export interface LoopbackOptions {
  engine: Engine;
  selfPlayerId: string;
}

export class LoopbackTransport implements Transport {
  status: TransportStatus = "open";
  private engine: Engine;
  private selfId: string;
  private listeners: Array<(evt: ServerEvent) => void> = [];
  private unsub: Array<() => void> = [];

  constructor(opts: LoopbackOptions) {
    this.engine = opts.engine;
    this.selfId = opts.selfPlayerId;

    // Broadcast events: every listener gets them.
    this.unsub.push(
      this.engine.onBroadcast((evt) => this.listeners.forEach((fn) => fn(evt)))
    );
    // Direct events: deliver only when the target matches selfId.
    this.unsub.push(
      this.engine.onDirect((pid, evt) => {
        if (pid === this.selfId) {
          this.listeners.forEach((fn) => fn(evt));
        }
      })
    );
  }

  send(cmd: ClientCommand): void {
    this.engine.dispatch(cmd, this.selfId);
  }

  onEvent(handler: (evt: ServerEvent) => void): Unsubscribe {
    this.listeners.push(handler);
    return () => {
      this.listeners = this.listeners.filter((f) => f !== handler);
    };
  }

  async close(): Promise<void> {
    this.unsub.forEach((fn) => fn());
    this.unsub = [];
    this.listeners = [];
    this.status = "closed";
  }
}

// RTCTransport: guest-side transport. Wraps a single RTCDataChannel to
// the host. Commands are serialized as CMD envelopes; inbound STATE /
// STROKE / ROLE / WELCOME / ERROR frames are translated back to the
// canonical ServerEvent shape so the replica is transport-agnostic.
//
// The transport is *not* responsible for opening the DC — the caller
// hands in a channel that's either already open or will open. We hook
// onopen/onclose/onmessage and track status accordingly.

export interface RTCTransportOptions {
  channel: RTCDataChannel;
  // Optional outgoing-sequence base. Defaults to 0. Used so a reconnect
  // can resume sequence numbers without colliding with the host's view.
  seqStart?: number;
  // Called for non-event frames the caller might want to peek at (e.g.
  // SYNC_RES on the replica). Returns false to swallow, true to also
  // emit a translated ServerEvent if applicable.
  onFrame?: (env: Envelope) => void;
}

export class RTCTransport implements Transport {
  status: TransportStatus;
  private dc: RTCDataChannel;
  private listeners: Array<(evt: ServerEvent) => void> = [];
  private seq: number;
  private onFrame?: (env: Envelope) => void;

  constructor(opts: RTCTransportOptions) {
    this.dc = opts.channel;
    this.seq = opts.seqStart ?? 0;
    this.onFrame = opts.onFrame;
    this.status = this.dc.readyState === "open" ? "open" : "connecting";

    this.dc.onopen = () => {
      this.status = "open";
    };
    this.dc.onclose = () => {
      this.status = "closed";
    };
    this.dc.onmessage = (e) => {
      const raw = typeof e.data === "string" ? e.data : "";
      let env: Envelope;
      try {
        env = JSON.parse(raw) as Envelope;
      } catch {
        return;
      }
      this.handleFrame(env);
    };
  }

  send(cmd: ClientCommand): void {
    if (this.dc.readyState !== "open") return;
    this.seq += 1;
    const env: Envelope = { t: "CMD", seq: this.seq, cmd };
    this.dc.send(JSON.stringify(env));
  }

  onEvent(handler: (evt: ServerEvent) => void): () => void {
    this.listeners.push(handler);
    return () => {
      this.listeners = this.listeners.filter((f) => f !== handler);
    };
  }

  async close(): Promise<void> {
    try {
      this.dc.close();
    } catch {
      // already closed
    }
    this.listeners = [];
    this.status = "closed";
  }

  // Public so the host-side (peerHub bridge) can push an event into the
  // local replica through the same translation path as remote frames.
  handleFrame(env: Envelope): void {
    if (this.onFrame) this.onFrame(env);
    const evt = envToEvent(env);
    if (evt) this.listeners.forEach((fn) => fn(evt));
  }
}

// RelayTransport (T9.2): server-relay fallback for guests whose ICE
// failed. Wraps the signaling WS — outbound CMDs are sent as RELAY
// frames addressed to the host; inbound RELAY frames whose payload is
// a DC envelope are translated back via envToEvent.
//
// Same Transport interface, so the React layer / Replica don't care
// which underlying transport is in play.
//
// The caller owns the signaling client and routes inbound RELAY frames
// to handleRelayIn(); we don't own the WS lifecycle.

export interface RelayTransportOptions {
  // Sender hook: wraps the outbound envelope in a RELAY frame and
  // forwards via the signaling WS. The provider injects this so we
  // don't have to know the SignalingClient API here.
  sendRelay: (env: Envelope) => void;
  seqStart?: number;
}

export class RelayTransport implements Transport {
  status: TransportStatus = "open";
  private listeners: Array<(evt: ServerEvent) => void> = [];
  private seq: number;
  private sendRelay: (env: Envelope) => void;

  constructor(opts: RelayTransportOptions) {
    this.seq = opts.seqStart ?? 0;
    this.sendRelay = opts.sendRelay;
  }

  send(cmd: ClientCommand): void {
    this.seq += 1;
    const env: Envelope = { t: "CMD", seq: this.seq, cmd };
    this.sendRelay(env);
  }

  onEvent(handler: (evt: ServerEvent) => void): () => void {
    this.listeners.push(handler);
    return () => {
      this.listeners = this.listeners.filter((f) => f !== handler);
    };
  }

  async close(): Promise<void> {
    this.listeners = [];
    this.status = "closed";
  }

  // handleRelayIn: caller forwards the inner envelope from an inbound
  // RELAY frame here. Mirrors RTCTransport.handleFrame.
  handleRelayIn(env: Envelope): void {
    const evt = envToEvent(env);
    if (evt) this.listeners.forEach((fn) => fn(evt));
  }
}

// envToEvent: translate a DC envelope into the canonical ServerEvent
// the replica consumes. Returns null for transport-only frames (CMD,
// SYNC_REQ, SYNC_RES — those are handled by hooks rather than state).
export function envToEvent(env: Envelope): ServerEvent | null {
  switch (env.t) {
    case "STATE_UPDATE":
      return { type: "STATE_UPDATE", payload: env.state };
    case "STROKE_ADDED":
      return {
        type: "STROKE_ADDED",
        payload: { stroke: env.stroke, stroke_index: env.stroke_index },
      };
    case "YOUR_ROLE":
      return { type: "YOUR_ROLE", payload: env.payload };
    case "PLAYER_WELCOME":
      return { type: "PLAYER_WELCOME", payload: env.payload };
    case "ERROR":
      return { type: "ERROR", payload: { message: env.message } };
    default:
      return null;
  }
}

// eventToEnv: inverse — wrap a ServerEvent in a DC envelope. Used by
// the host bridge that fans engine events out through the peerHub.
export function eventToEnv(evt: ServerEvent, ctx: { version?: number; round_index?: number } = {}): Envelope | null {
  switch (evt.type) {
    case "STATE_UPDATE":
      return { t: "STATE_UPDATE", version: ctx.version ?? 0, state: evt.payload };
    case "STROKE_ADDED":
      return {
        t: "STROKE_ADDED",
        round_index: ctx.round_index ?? 0,
        stroke_index: evt.payload.stroke_index,
        stroke: evt.payload.stroke,
      };
    case "YOUR_ROLE":
      return { t: "YOUR_ROLE", round_index: ctx.round_index ?? 0, payload: evt.payload };
    case "PLAYER_WELCOME":
      return { t: "PLAYER_WELCOME", payload: evt.payload };
    case "ERROR":
      return { t: "ERROR", message: evt.payload.message };
  }
  return null;
}
