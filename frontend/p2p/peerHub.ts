// PeerHub: a thin RTCPeerConnection orchestrator for the star topology.
// One PC per remote peer. Each PC carries exactly one ordered+reliable
// RTCDataChannel labeled "game". The host creates the channels (it has
// the offer side); guests accept them in ondatachannel.
//
// Signaling is injected: PeerHub does not own the WS. The caller wires
// SignalingClient.onMessage into addRemoteOffer / addRemoteAnswer /
// addRemoteIce, and forwards local SDP/ICE via the provided send() hook.

export interface PeerHubSendHook {
  sendOffer(to: string, sdp: string): void;
  sendAnswer(to: string, sdp: string): void;
  sendIce(to: string, c: RTCIceCandidateInit): void;
}

export interface PeerHubOptions {
  selfId: string;
  iceServers?: RTCIceServer[];
  send: PeerHubSendHook;
  // Injectable for tests so we can run under jsdom without real WebRTC.
  pcFactory?: (cfg: RTCConfiguration) => RTCPeerConnection;
}

type PeerOpenHandler = (peerId: string, dc: RTCDataChannel) => void;
type PeerCloseHandler = (peerId: string) => void;
type PeerMessageHandler = (peerId: string, data: string) => void;

interface PeerEntry {
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  // Buffer ICE candidates that arrive before the remote description is
  // set. Required because answer-side ondatachannel may receive ICE
  // before SDP_ANSWER's setRemoteDescription completes.
  pendingIce: RTCIceCandidateInit[];
  remoteSet: boolean;
}

export class PeerHub {
  private opts: Required<PeerHubOptions>;
  private peers = new Map<string, PeerEntry>();
  private onOpen: PeerOpenHandler[] = [];
  private onClose: PeerCloseHandler[] = [];
  private onMessage: PeerMessageHandler[] = [];

  constructor(opts: PeerHubOptions) {
    this.opts = {
      iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
      pcFactory: (cfg) => new RTCPeerConnection(cfg),
      ...opts,
    };
  }

  onPeerOpen(fn: PeerOpenHandler): () => void {
    this.onOpen.push(fn);
    return () => (this.onOpen = this.onOpen.filter((f) => f !== fn));
  }
  onPeerClose(fn: PeerCloseHandler): () => void {
    this.onClose.push(fn);
    return () => (this.onClose = this.onClose.filter((f) => f !== fn));
  }
  onPeerMessage(fn: PeerMessageHandler): () => void {
    this.onMessage.push(fn);
    return () => (this.onMessage = this.onMessage.filter((f) => f !== fn));
  }

  // connectTo: caller (host) initiates a new PC and channel toward peer.
  async connectTo(peerId: string): Promise<void> {
    const entry = this.ensurePeer(peerId, /*createChannel*/ true);
    const offer = await entry.pc.createOffer();
    await entry.pc.setLocalDescription(offer);
    this.opts.send.sendOffer(peerId, offer.sdp || "");
  }

  // acceptOffer: caller (guest) received an SDP_OFFER from peer.
  async acceptOffer(peerId: string, sdp: string): Promise<void> {
    const entry = this.ensurePeer(peerId, /*createChannel*/ false);
    await entry.pc.setRemoteDescription({ type: "offer", sdp });
    entry.remoteSet = true;
    await this.drainIce(entry);
    const answer = await entry.pc.createAnswer();
    await entry.pc.setLocalDescription(answer);
    this.opts.send.sendAnswer(peerId, answer.sdp || "");
  }

  // addRemoteAnswer: offerer's side, post-handshake completion.
  async addRemoteAnswer(peerId: string, sdp: string): Promise<void> {
    const entry = this.peers.get(peerId);
    if (!entry) return;
    await entry.pc.setRemoteDescription({ type: "answer", sdp });
    entry.remoteSet = true;
    await this.drainIce(entry);
  }

  async addRemoteIce(peerId: string, c: RTCIceCandidateInit): Promise<void> {
    const entry = this.ensurePeer(peerId, false);
    if (!entry.remoteSet) {
      entry.pendingIce.push(c);
      return;
    }
    try {
      await entry.pc.addIceCandidate(c);
    } catch {
      // benign: a peer can race a candidate after close
    }
  }

  send(peerId: string, env: unknown): void {
    const entry = this.peers.get(peerId);
    if (!entry || !entry.dc || entry.dc.readyState !== "open") return;
    entry.dc.send(JSON.stringify(env));
  }

  broadcast(env: unknown): void {
    const data = JSON.stringify(env);
    for (const [, entry] of this.peers) {
      if (entry.dc && entry.dc.readyState === "open") {
        entry.dc.send(data);
      }
    }
  }

  closePeer(peerId: string): void {
    const entry = this.peers.get(peerId);
    if (!entry) return;
    try {
      entry.dc?.close();
      entry.pc.close();
    } catch {
      // ignore
    }
    this.peers.delete(peerId);
    this.onClose.forEach((fn) => fn(peerId));
  }

  async close(): Promise<void> {
    for (const id of Array.from(this.peers.keys())) {
      this.closePeer(id);
    }
  }

  // -- internals --

  private ensurePeer(peerId: string, createChannel: boolean): PeerEntry {
    const existing = this.peers.get(peerId);
    if (existing) return existing;

    const pc = this.opts.pcFactory({ iceServers: this.opts.iceServers });
    const entry: PeerEntry = { pc, dc: null, pendingIce: [], remoteSet: false };
    this.peers.set(peerId, entry);

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.opts.send.sendIce(peerId, e.candidate.toJSON());
      }
    };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === "failed" || st === "closed" || st === "disconnected") {
        this.closePeer(peerId);
      }
    };

    if (createChannel) {
      const dc = pc.createDataChannel("game", { ordered: true });
      this.wireChannel(peerId, entry, dc);
    } else {
      pc.ondatachannel = (e) => {
        this.wireChannel(peerId, entry, e.channel);
      };
    }
    return entry;
  }

  private wireChannel(peerId: string, entry: PeerEntry, dc: RTCDataChannel): void {
    entry.dc = dc;
    dc.onopen = () => {
      this.onOpen.forEach((fn) => fn(peerId, dc));
    };
    dc.onclose = () => {
      this.onClose.forEach((fn) => fn(peerId));
    };
    dc.onmessage = (e) => {
      const data = typeof e.data === "string" ? e.data : "";
      this.onMessage.forEach((fn) => fn(peerId, data));
    };
  }

  private async drainIce(entry: PeerEntry): Promise<void> {
    while (entry.pendingIce.length > 0) {
      const c = entry.pendingIce.shift()!;
      try {
        await entry.pc.addIceCandidate(c);
      } catch {
        // best-effort
      }
    }
  }
}
