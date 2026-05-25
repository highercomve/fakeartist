// Signaling WS client. Auto-reconnects on close (unless explicitly
// shut down) with bounded exponential backoff. Emits typed events to
// listeners; no React coupling.

export type SignalRole = "host" | "guest";

export type InboundEnvelope =
  | { type: "PEER_JOINED"; player_id: string; name?: string; is_host?: boolean }
  | { type: "PEER_LEFT"; player_id: string }
  | { type: "HOST_CHANGED"; player_id: string }
  | { type: "SDP_OFFER"; from: string; sdp: string }
  | { type: "SDP_ANSWER"; from: string; sdp: string }
  | { type: "ICE"; from: string; candidate: RTCIceCandidateInit }
  | {
      type: "YOUR_ROLE";
      round_index: number;
      payload: { is_fake: boolean; word?: string; commitment: string; round: number };
    }
  // RELAY (T9.1): inbound DC envelope routed through the signaling WS
  // because the originating peer couldn't establish a DataChannel.
  // `envelope` is the opaque DC payload — caller treats it identically
  // to an inbound DC frame.
  | { type: "RELAY"; from: string; envelope: unknown }
  | { type: "ERROR"; message: string };

export type OutboundEnvelope =
  | { type: "HELLO"; role: SignalRole }
  | { type: "SDP_OFFER"; to: string; sdp: string }
  | { type: "SDP_ANSWER"; to: string; sdp: string }
  | { type: "ICE"; to: string; candidate: RTCIceCandidateInit }
  | { type: "RELAY"; to: string; envelope: unknown }
  | { type: "BYE" };

export type SignalStatus = "connecting" | "open" | "closed" | "reconnecting";

type Listener<T> = (val: T) => void;

export interface SignalingOptions {
  url: string;            // ws(s)://host/api/signal?room=...&player=...
  role: SignalRole;
  // Injectable for tests. Defaults to the browser WebSocket.
  wsFactory?: (url: string) => WebSocket;
  // Reconnect knobs; mostly here so tests can disable backoff.
  reconnect?: boolean;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

export class SignalingClient {
  private ws: WebSocket | null = null;
  private opts: Required<SignalingOptions>;
  private msgListeners: Listener<InboundEnvelope>[] = [];
  private statusListeners: Listener<SignalStatus>[] = [];
  private closed = false;
  private retry = 0;
  private _status: SignalStatus = "connecting";

  constructor(opts: SignalingOptions) {
    this.opts = {
      reconnect: true,
      backoffBaseMs: 500,
      backoffMaxMs: 8_000,
      wsFactory: (u) => new WebSocket(u),
      ...opts,
    };
    this.connect();
  }

  get status(): SignalStatus {
    return this._status;
  }

  onMessage(fn: Listener<InboundEnvelope>): () => void {
    this.msgListeners.push(fn);
    return () => {
      this.msgListeners = this.msgListeners.filter((f) => f !== fn);
    };
  }

  onStatus(fn: Listener<SignalStatus>): () => void {
    this.statusListeners.push(fn);
    return () => {
      this.statusListeners = this.statusListeners.filter((f) => f !== fn);
    };
  }

  send(env: OutboundEnvelope): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(env));
    }
  }

  close(): void {
    this.closed = true;
    if (this.ws) {
      try {
        this.ws.send(JSON.stringify({ type: "BYE" }));
      } catch {
        // ignore — socket may already be torn down
      }
      this.ws.close();
      this.ws = null;
    }
    this.setStatus("closed");
  }

  private connect(): void {
    this.setStatus(this.retry === 0 ? "connecting" : "reconnecting");
    const ws = this.opts.wsFactory(this.opts.url);
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      this.setStatus("open");
      this.send({ type: "HELLO", role: this.opts.role });
    };
    ws.onclose = () => {
      if (this.closed) return;
      this.setStatus("reconnecting");
      const delay = Math.min(
        this.opts.backoffBaseMs * 2 ** this.retry,
        this.opts.backoffMaxMs
      );
      this.retry += 1;
      if (this.opts.reconnect) {
        setTimeout(() => this.connect(), delay);
      } else {
        this.setStatus("closed");
      }
    };
    ws.onerror = () => {
      // The close handler is the recovery path; nothing to do here.
    };
    ws.onmessage = (evt) => {
      try {
        const env = JSON.parse(evt.data as string) as InboundEnvelope;
        this.msgListeners.forEach((fn) => fn(env));
      } catch {
        // malformed frame — drop silently. Server is supposed to be honest.
      }
    };
  }

  private setStatus(s: SignalStatus): void {
    if (this._status === s) return;
    this._status = s;
    this.statusListeners.forEach((fn) => fn(s));
  }
}
