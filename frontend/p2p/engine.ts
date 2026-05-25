// Port of internal/game/session.go. Host-authoritative FSM.
//
// Dispatch is single-threaded: every command flows through dispatch()
// and the engine emits state updates / events synchronously. The host
// transport feeds its own commands through the same path (loopback),
// keeping the code path uniform.

import {
  type GameState,
  type Player,
  type Round,
  type WordCard,
  type RolePayload,
  type Stroke,
  newGameState,
  ColorPalette,
} from "./models";
import { sanitize } from "./sanitize";
import type {
  ClientCommand,
  ServerEvent,
  JoinGamePayload,
  SubmitWordsPayload,
  SubmitStrokePayload,
  CastVotePayload,
  SubmitFakeGuessPayload,
} from "./protocol";

// Listener wiring kept intentionally simple. peerHub will subscribe to
// onBroadcast, onDirect, onStroke.
type BroadcastListener = (evt: ServerEvent) => void;
type DirectListener = (playerId: string, evt: ServerEvent) => void;

// RoleDrawer is the host-side bridge to the server's role draw +
// reveal endpoints. Implementations live in engineHttp.ts; the engine
// keeps no fetch coupling so tests can stub it.
export interface DrawResponse {
  card_id: string;
  fake_id_local?: string; // only set by stub drawers; real server hides this
  word_for_self?: string; // word for the requesting player (host); other peers receive theirs via signaling DM
  fake_id_commitment: string;
  // assignments are not directly consumed by the engine — the server
  // DMs each peer via signaling. The engine only needs to know the
  // round commitment + (for solo/test) the chosen secrets.
  assignments?: Record<string, { is_fake: boolean; word?: string }>;
}
export interface RevealResponse {
  fake_id: string;
  word: string;
  nonce: string;
}
export interface RoleDrawer {
  draw(roomId: string, roundIndex: number, players: string[], pool: { id: string; word: string; author_id: string }[]): Promise<DrawResponse>;
  reveal(roomId: string, roundIndex: number): Promise<RevealResponse>;
}

export interface EngineOptions {
  // RNG knob for tests. Defaults to Math.random.
  rng?: () => number;
  // Initial config override; mainly for solo/test mode.
  config?: Partial<GameState["config"]>;
  // Server-backed role drawer. When absent, prepareRound falls back to
  // the local stub (used by /p2p-solo and most unit tests). PR 6 wires
  // a real HTTP drawer in the multi-peer path.
  drawer?: RoleDrawer;
}

export class Engine {
  state: GameState;
  version = 0;
  // Round-scoped private state — never broadcast.
  private privateRoundWord: string | null = null;
  // Per-round commitment from the server (or stubbed locally). Used in
  // tests + by clients via verifyCommitment after reveal.
  private privateRoundCommitment: string | null = null;

  private rng: () => number;
  private drawer: RoleDrawer | undefined;
  private broadcastListeners: BroadcastListener[] = [];
  private directListeners: DirectListener[] = [];

  constructor(roomId: string, opts: EngineOptions = {}) {
    this.state = newGameState(roomId);
    if (opts.config) {
      Object.assign(this.state.config, opts.config);
    }
    this.rng = opts.rng ?? Math.random;
    this.drawer = opts.drawer;
  }

  setDrawer(d: RoleDrawer): void {
    this.drawer = d;
  }

  // Exposed so a client can verify the commitment after reveal arrives.
  get roundCommitment(): string | null {
    return this.privateRoundCommitment;
  }

  onBroadcast(fn: BroadcastListener): () => void {
    this.broadcastListeners.push(fn);
    return () => (this.broadcastListeners = this.broadcastListeners.filter((f) => f !== fn));
  }
  onDirect(fn: DirectListener): () => void {
    this.directListeners.push(fn);
    return () => (this.directListeners = this.directListeners.filter((f) => f !== fn));
  }

  // -- dispatch --

  dispatch(cmd: ClientCommand, fromPlayerId: string): void {
    switch (cmd.type) {
      case "JOIN_GAME": return this.handleJoin(cmd.payload, fromPlayerId);
      case "CONFIGURE_GAME": return this.handleConfigure(cmd.payload, fromPlayerId);
      case "SUBMIT_WORDS": return this.handleSubmitWords(cmd.payload, fromPlayerId);
      case "START_GAME": return this.handleStartGame(fromPlayerId);
      case "START_ROUND": return this.handleStartRound(fromPlayerId);
      case "SUBMIT_STROKE": return this.handleSubmitStroke(cmd.payload, fromPlayerId);
      case "CAST_VOTE": return this.handleCastVote(cmd.payload, fromPlayerId);
      case "SUBMIT_FAKE_GUESS": return this.handleFakeGuess(cmd.payload, fromPlayerId);
      case "NEXT_ROUND": return this.handleNextRound(fromPlayerId);
      case "END_GAME": return this.handleEndGame(fromPlayerId);
    }
  }

  // -- handlers --

  private handleJoin(p: JoinGamePayload, fromPlayerId: string): void {
    let player: Player | undefined;
    const wantedId = p.id || fromPlayerId;
    if (wantedId) {
      player = this.state.players.find((pl) => pl.id === wantedId);
      if (player) {
        player.connected = true;
        if (p.player_name) player.name = p.player_name;
      }
    }
    if (!player) {
      if (this.state.status !== "LOBBY" && this.state.status !== "WRITING") {
        this.emitError(fromPlayerId, "Game already in progress");
        return;
      }
      const newId = wantedId || `player-${Date.now().toString(36)}-${this.randHex(4)}`;
      player = {
        id: newId,
        name: p.player_name,
        color: this.pickColor(),
        is_admin: false,
        connected: true,
        has_submitted: false,
        score: 0,
      };
      this.state.players.push(player);
      if (this.state.players.length === 1) {
        player.is_admin = true;
        this.state.host_id = player.id;
      }
    }

    this.emitDirect(player.id, { type: "PLAYER_WELCOME", payload: { id: player.id } });
    this.broadcastState();

    // resend role on rejoin during an active round
    const r = this.state.current_round;
    const active = ["ROUND_ANNOUNCE", "DRAWING", "VOTING", "FAKE_GUESS"].includes(this.state.status);
    if (r && active && r.turn_order.includes(player.id)) {
      const isFake = player.id === r.fake_id;
      const payload: RolePayload = { is_fake: isFake };
      if (!isFake && this.privateRoundWord) payload.word = this.privateRoundWord;
      this.emitDirect(player.id, { type: "YOUR_ROLE", payload });
    }
  }

  private handleConfigure(p: Partial<GameState["config"]>, fromPlayerId: string): void {
    if (!this.requireHost(fromPlayerId) || this.state.status !== "LOBBY") return;
    if (p.words_per_player && p.words_per_player > 0) this.state.config.words_per_player = p.words_per_player;
    if (p.target_score && p.target_score > 0) this.state.config.target_score = p.target_score;
    if (p.strokes_per_artist && p.strokes_per_artist > 0) this.state.config.strokes_per_artist = p.strokes_per_artist;
    if (p.min_players && p.min_players > 0) this.state.config.min_players = p.min_players;
    if (p.turn_duration !== undefined && p.turn_duration >= 0) this.state.config.turn_duration = p.turn_duration;
    this.broadcastState();
  }

  private handleSubmitWords(p: SubmitWordsPayload, fromPlayerId: string): void {
    if (this.state.status !== "WRITING") return;
    const player = this.findPlayer(fromPlayerId);
    if (!player || player.has_submitted) return;
    for (const raw of p.words) {
      const w = (raw || "").trim();
      if (!w) continue;
      const card: WordCard = {
        id: `card-${Date.now().toString(36)}-${this.randHex(4)}`,
        word: w,
        author_id: player.id,
        used: false,
      };
      this.state.pool.push(card);
    }
    player.has_submitted = true;
    this.broadcastState();
  }

  private handleStartGame(fromPlayerId: string): void {
    if (!this.requireHost(fromPlayerId)) return;
    if (this.state.status !== "LOBBY") return;
    if (this.state.players.length < this.state.config.min_players) {
      this.emitError(fromPlayerId, `Need at least ${this.state.config.min_players} players`);
      return;
    }
    this.state.status = "WRITING";
    this.broadcastState();
  }

  private handleStartRound(fromPlayerId: string): void {
    if (!this.requireHost(fromPlayerId)) return;
    if (this.state.status === "WRITING") {
      if (!this.allSubmitted()) {
        this.emitError(fromPlayerId, "Waiting for all players to submit words");
        return;
      }
      if (this.drawer) {
        // Fire-and-forget: the server draw is async, but the engine
        // dispatch contract is sync. We immediately freeze the FSM in
        // WRITING and let the async draw complete; on success it bumps
        // state to ROUND_ANNOUNCE via prepareRoundServer().
        void this.prepareRoundServer(fromPlayerId);
        return;
      }
      if (!this.prepareRound()) {
        this.emitError(fromPlayerId, "Cannot start round");
        return;
      }
      this.broadcastState();
      return;
    }
    if (this.state.status === "ROUND_ANNOUNCE") {
      this.state.status = "DRAWING";
      this.broadcastState();
    }
  }

  private handleSubmitStroke(p: SubmitStrokePayload, fromPlayerId: string): void {
    if (this.state.status !== "DRAWING") return;
    const r = this.state.current_round;
    if (!r) return;
    if (fromPlayerId !== this.currentTurnPlayerId()) {
      this.emitError(fromPlayerId, "Not your turn");
      return;
    }
    if (!p.points || p.points.length < 2) return;
    const player = this.findPlayer(fromPlayerId);
    if (!player) return;
    const stroke: Stroke = {
      player_id: player.id,
      color: player.color,
      points: p.points,
    };
    r.strokes.push(stroke);
    r.stroke_index += 1;
    // Stroke fan-out: replica relies on this for incremental canvas paint.
    this.emitBroadcast({
      type: "STROKE_ADDED",
      payload: { stroke, stroke_index: r.stroke_index },
    });
    if (r.stroke_index >= this.totalStrokesNeeded()) {
      this.state.status = "VOTING";
    }
    this.broadcastState();
  }

  private handleCastVote(p: CastVotePayload, fromPlayerId: string): void {
    if (this.state.status !== "VOTING") return;
    const r = this.state.current_round;
    if (!r) return;
    if (!r.turn_order.includes(fromPlayerId)) return;
    if (!r.turn_order.includes(p.suspect_id)) return;
    r.votes = r.votes || {};
    r.votes[fromPlayerId] = p.suspect_id;
    r.votes_cast = Object.keys(r.votes).length;
    if (r.votes_cast >= r.turn_order.length) {
      const { caught } = this.tallyVotes();
      if (caught) {
        this.state.status = "FAKE_GUESS";
      } else {
        this.finalizeRound(false, false);
      }
    }
    this.broadcastState();
  }

  private handleFakeGuess(p: SubmitFakeGuessPayload, fromPlayerId: string): void {
    if (this.state.status !== "FAKE_GUESS") return;
    const r = this.state.current_round;
    if (!r || fromPlayerId !== r.fake_id) return;
    const guess = (p.guess || "").trim().toLowerCase();
    const actual = (this.privateRoundWord || "").trim().toLowerCase();
    r.fake_guess = p.guess;
    this.finalizeRound(true, guess !== "" && guess === actual);
    this.broadcastState();
  }

  private handleNextRound(fromPlayerId: string): void {
    if (!this.requireHost(fromPlayerId)) return;
    if (this.state.status !== "ROUND_SUMMARY") return;
    this.archiveCurrentRound();
    if (this.checkGameOver()) {
      this.broadcastState();
      return;
    }
    if (this.drawer) {
      void this.prepareRoundServer(fromPlayerId);
      return;
    }
    if (!this.prepareRound()) {
      this.broadcastState();
      return;
    }
    this.broadcastState();
  }

  private handleEndGame(fromPlayerId: string): void {
    if (!this.requireHost(fromPlayerId)) return;
    if (this.state.status === "ROUND_SUMMARY") this.archiveCurrentRound();
    this.state.status = "GAME_OVER";
    this.assignWinner();
    this.broadcastState();
  }

  // Snapshot current_round into past_rounds. Called when the host advances
  // past ROUND_SUMMARY (next round or end game) so the drawing gallery
  // persists. Idempotent: skips if the round is already archived.
  private archiveCurrentRound(): void {
    const r = this.state.current_round;
    if (!r) return;
    if (this.state.past_rounds.some((p) => p.index === r.index)) return;
    this.state.past_rounds.push({ ...r, strokes: r.strokes.slice() });
  }

  // -- round lifecycle --

  // prepareRoundServer is the PR 6 path: ask the server to draw a card
  // + pick the fake. The engine still owns turn-order generation since
  // it's not secret. Role envelopes are DM-ed by the server over the
  // signaling WS — the engine only emits its own role locally.
  private async prepareRoundServer(fromPlayerId: string): Promise<void> {
    if (!this.drawer) return;
    if (this.state.players.length < this.state.config.min_players) return;

    const players = this.state.players.map((p) => p.id);
    const pool = this.state.pool
      .filter((c) => !c.used)
      .map((c) => ({ id: c.id, word: c.word || "", author_id: c.author_id }));

    const roundIdx = this.state.current_round ? this.state.current_round.index + 1 : 0;

    let res: DrawResponse;
    try {
      res = await this.drawer.draw(this.state.id, roundIdx, players, pool);
    } catch (e) {
      this.emitError(fromPlayerId, `role draw failed: ${(e as Error).message}`);
      return;
    }

    // Mark the picked card as used locally so subsequent rounds skip it.
    const card = this.state.pool.find((c) => c.id === res.card_id);
    if (card) card.used = true;

    const turnOrder = players.slice();
    for (let i = turnOrder.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [turnOrder[i], turnOrder[j]] = [turnOrder[j], turnOrder[i]];
    }

    // The /roles response includes the full assignment map, so the host
    // engine knows fake_id + word from the start. (Per plan §8.3, this
    // is the documented "host knows the fake" leak. Sealed envelopes
    // are deferred to a later phase.) Even so, the per-player role
    // envelopes are still DMed by the server over signaling so guests
    // get them directly without trusting the host's frame.
    let fakeId = "";
    let word = "";
    if (res.assignments) {
      for (const [pid, a] of Object.entries(res.assignments)) {
        if (a.is_fake) fakeId = pid;
        else if (a.word) word = a.word;
      }
    }
    const hostAssignment = res.assignments?.[fromPlayerId];
    if (hostAssignment) {
      this.emitDirect(fromPlayerId, {
        type: "YOUR_ROLE",
        payload: { is_fake: hostAssignment.is_fake, word: hostAssignment.word },
      });
    }
    this.privateRoundWord = word;
    this.privateRoundCommitment = res.fake_id_commitment;

    this.state.current_round = {
      index: roundIdx,
      card_id: res.card_id,
      // fake_id retained host-side for vote tally — sanitize() strips
      // it from broadcasts until ROUND_SUMMARY.
      fake_id: fakeId,
      turn_order: turnOrder,
      stroke_index: 0,
      strokes: [],
      votes: {},
      votes_cast: 0,
    };
    this.state.status = "ROUND_ANNOUNCE";
    this.broadcastState();
  }

  // prepareRound stubs the server role draw (T4.4): the engine picks
  // its own card+fake locally. Used by solo / tests without a drawer.
  private prepareRound(): boolean {
    if (this.state.players.length < this.state.config.min_players) return false;
    const available = this.state.pool.filter((c) => !c.used);
    if (available.length === 0) {
      this.state.status = "GAME_OVER";
      this.assignWinner();
      return false;
    }
    const cardIdx = Math.floor(this.rng() * available.length);
    const card = available[cardIdx];
    // Mutate the pool entry in place — its id matches.
    const poolEntry = this.state.pool.find((c) => c.id === card.id)!;
    poolEntry.used = true;
    const word = card.word || "";

    // shuffle player ids for turn order
    const turnOrder = this.state.players.map((p) => p.id);
    for (let i = turnOrder.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [turnOrder[i], turnOrder[j]] = [turnOrder[j], turnOrder[i]];
    }
    const fakeId = turnOrder[Math.floor(this.rng() * turnOrder.length)];

    const roundIdx = this.state.current_round ? this.state.current_round.index + 1 : 0;
    const round: Round = {
      index: roundIdx,
      card_id: card.id,
      fake_id: fakeId,
      turn_order: turnOrder,
      stroke_index: 0,
      strokes: [],
      votes: {},
      votes_cast: 0,
    };
    this.state.current_round = round;
    this.state.status = "ROUND_ANNOUNCE";
    this.privateRoundWord = word;

    for (const pid of turnOrder) {
      const isFake = pid === fakeId;
      const payload: RolePayload = { is_fake: isFake };
      if (!isFake) payload.word = word;
      this.emitDirect(pid, { type: "YOUR_ROLE", payload });
    }

    // reset has_submitted flag is intentional only at WRITING -> first round?
    // Original Go does not touch it after; we keep that behaviour.
    return true;
  }

  private tallyVotes(): { winnerId: string; caught: boolean } {
    const r = this.state.current_round!;
    const counts = new Map<string, number>();
    for (const suspect of Object.values(r.votes || {})) {
      counts.set(suspect, (counts.get(suspect) || 0) + 1);
    }
    let max = 0;
    let winnerId = "";
    let tied = false;
    for (const [id, n] of counts) {
      if (n > max) {
        max = n;
        winnerId = id;
        tied = false;
      } else if (n === max) {
        tied = true;
      }
    }
    if (tied) return { winnerId: "", caught: false };
    return { winnerId, caught: winnerId === r.fake_id };
  }

  private finalizeRound(fakeCaught: boolean, fakeGuessedRight: boolean): void {
    const r = this.state.current_round!;
    r.revealed_word = this.privateRoundWord || "";
    if (fakeCaught && fakeGuessedRight) {
      r.outcome = "FAKE_WON";
      this.addScore(r.fake_id!, 2);
    } else if (fakeCaught && !fakeGuessedRight) {
      r.outcome = "ARTISTS_WON";
      for (const pid of r.turn_order) {
        if (pid !== r.fake_id) this.addScore(pid, 1);
      }
    } else {
      r.outcome = "FAKE_WON";
      this.addScore(r.fake_id!, 1);
    }
    this.state.status = "ROUND_SUMMARY";
  }

  private checkGameOver(): boolean {
    for (const p of this.state.players) {
      if (p.score >= this.state.config.target_score) {
        this.state.status = "GAME_OVER";
        this.assignWinner();
        return true;
      }
    }
    if (!this.state.pool.some((c) => !c.used)) {
      this.state.status = "GAME_OVER";
      this.assignWinner();
      return true;
    }
    return false;
  }

  private assignWinner(): void {
    let best: Player | null = null;
    for (const p of this.state.players) {
      if (!best || p.score > best.score) best = p;
    }
    this.state.winner = best;
  }

  // -- helpers --

  private requireHost(playerId: string): boolean {
    return playerId === this.state.host_id;
  }
  private findPlayer(id: string): Player | undefined {
    return this.state.players.find((p) => p.id === id);
  }
  private allSubmitted(): boolean {
    return this.state.players.every((p) => p.has_submitted);
  }
  private totalStrokesNeeded(): number {
    const r = this.state.current_round!;
    return this.state.config.strokes_per_artist * r.turn_order.length;
  }
  private currentTurnPlayerId(): string {
    const r = this.state.current_round;
    if (!r || r.turn_order.length === 0) return "";
    return r.turn_order[r.stroke_index % r.turn_order.length];
  }
  private addScore(playerId: string, n: number): void {
    const p = this.findPlayer(playerId);
    if (p) p.score += n;
  }
  private pickColor(): string {
    const used = new Set(this.state.players.map((p) => p.color).filter(Boolean));
    const avail = ColorPalette.filter((c) => !used.has(c));
    if (avail.length === 0) {
      // unlikely (10 players max) — fallback random color
      const n = Math.floor(this.rng() * 0xffffff);
      return `#${n.toString(16).padStart(6, "0")}`;
    }
    return avail[Math.floor(this.rng() * avail.length)];
  }
  private randHex(n: number): string {
    let out = "";
    for (let i = 0; i < n; i++) {
      out += Math.floor(this.rng() * 16).toString(16);
    }
    return out;
  }

  // -- emit --

  private broadcastState(): void {
    this.version += 1;
    const sanitized = sanitize(this.state);
    this.emitBroadcast({ type: "STATE_UPDATE", payload: sanitized });
  }
  private emitBroadcast(evt: ServerEvent): void {
    this.broadcastListeners.forEach((fn) => fn(evt));
  }
  private emitDirect(playerId: string, evt: ServerEvent): void {
    this.directListeners.forEach((fn) => fn(playerId, evt));
  }
  private emitError(playerId: string, message: string): void {
    this.emitDirect(playerId, { type: "ERROR", payload: { message } });
  }
}
