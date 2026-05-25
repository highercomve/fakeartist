// Replica: the read-side view consumed by the React layer. Mirrors
// the legacy GameContext's state shape so existing components don't
// need to change.
//
// PR 5 added gap detection on STROKE_ADDED. When the replica sees an
// out-of-order stroke index, it buffers the future stroke, emits a
// SYNC_REQ via the requestSync hook, and reapplies on SYNC_RES.

import type { GameState, RolePayload, Stroke } from "./models";
import type { Envelope, IndexedStrokeFrame, ServerEvent } from "./protocol";

type Listener<T> = (val: T) => void;

export interface ReplicaSnapshot {
  state: GameState | null;
  myId: string | null;
  myRole: RolePayload | null;
  lastVersion: number;
  lastStrokeIndex: number;
}

export interface ReplicaOptions {
  // Called when the replica detects a stroke gap and wants the host to
  // backfill. Optional — solo / loopback mode won't wire it.
  requestSync?: (roundIndex: number, fromStrokeIndex: number) => void;
}

export class Replica {
  private _state: GameState | null = null;
  private _myId: string | null = null;
  private _myRole: RolePayload | null = null;
  private _lastVersion = 0;
  private _lastStrokeIndex = -1;

  // (round_index, stroke_index) of the next expected stroke. Tracked
  // per-round so a fresh START_ROUND resets the floor cleanly.
  private expectedNext: { round: number; idx: number } | null = null;
  // out-of-order strokes buffered until the gap is filled.
  private pending: { stroke_index: number; stroke: Stroke }[] = [];
  private syncInFlight = false;

  private requestSyncHook?: ReplicaOptions["requestSync"];

  private changeListeners: Listener<ReplicaSnapshot>[] = [];
  private strokeListeners: Listener<{ stroke: Stroke; stroke_index: number }>[] = [];
  private errorListeners: Listener<string>[] = [];

  constructor(opts: ReplicaOptions = {}) {
    this.requestSyncHook = opts.requestSync;
  }

  get snapshot(): ReplicaSnapshot {
    return {
      state: this._state,
      myId: this._myId,
      myRole: this._myRole,
      lastVersion: this._lastVersion,
      lastStrokeIndex: this._lastStrokeIndex,
    };
  }
  get myId(): string | null { return this._myId; }

  onChange(fn: Listener<ReplicaSnapshot>): () => void {
    this.changeListeners.push(fn);
    return () => (this.changeListeners = this.changeListeners.filter((f) => f !== fn));
  }
  onStroke(fn: Listener<{ stroke: Stroke; stroke_index: number }>): () => void {
    this.strokeListeners.push(fn);
    return () => (this.strokeListeners = this.strokeListeners.filter((f) => f !== fn));
  }
  onError(fn: Listener<string>): () => void {
    this.errorListeners.push(fn);
    return () => (this.errorListeners = this.errorListeners.filter((f) => f !== fn));
  }

  apply(evt: ServerEvent): void {
    switch (evt.type) {
      case "STATE_UPDATE":
        this.applyState(evt.payload);
        break;
      case "PLAYER_WELCOME":
        this._myId = evt.payload.id;
        this.notifyChange();
        break;
      case "YOUR_ROLE":
        this._myRole = evt.payload;
        this.notifyChange();
        break;
      case "STROKE_ADDED":
        this.applyStroke(evt.payload.stroke, evt.payload.stroke_index);
        break;
      case "ERROR":
        this.errorListeners.forEach((fn) => fn(evt.payload.message));
        break;
    }
  }

  // applyFrame is the entry point for the guest-side transport when it
  // wants to feed envelope frames (SYNC_RES specifically) into the
  // replica. CMD/SYNC_REQ are ignored.
  //
  // SYNC_RES carries strokes the client is missing; they must always be
  // delivered to listeners regardless of the gap-check floor, since the
  // floor itself was the cause of the resync. We deliver the strokes
  // first, then apply the snapped-forward state.
  applyFrame(env: Envelope): void {
    if (env.t !== "SYNC_RES") return;
    // Establish the round context from the snapshot before delivering
    // strokes so deliverStroke advances expectedNext correctly.
    const round = env.state.current_round?.index ?? this.expectedNext?.round ?? 0;
    if (!this.expectedNext || this.expectedNext.round !== round) {
      this.expectedNext = { round, idx: 0 };
      this.pending = [];
    }
    for (const f of env.strokes) {
      if (f.stroke_index < this.expectedNext.idx) continue;
      this.deliverStroke(f.stroke, f.stroke_index);
      this.expectedNext.idx = f.stroke_index + 1;
    }
    // Drain before applyState so pending entries that bridge the gap
    // get delivered before the snapshot advances the floor past them.
    this.drainPending();
    this.applyState(env.state);
    this.syncInFlight = false;
    this.drainPending();
  }

  private applyState(state: GameState): void {
    this._state = state;
    this._lastVersion += 1;
    if (state.current_round) {
      const r = state.current_round;
      const stateStrokeIdx = r.stroke_index - 1; // next-index convention
      this._lastStrokeIndex = stateStrokeIdx;
      // Reset the gap-detection floor when the round changes or when
      // a snapshot fast-forwards us.
      if (!this.expectedNext || this.expectedNext.round !== r.index) {
        this.expectedNext = { round: r.index, idx: r.stroke_index };
        // pending entries from a stale round are no longer relevant.
        this.pending = this.pending.filter(() => false);
      } else if (r.stroke_index > this.expectedNext.idx) {
        // state snapped forward — accept it as the new floor.
        this.expectedNext.idx = r.stroke_index;
      }
    } else {
      this.expectedNext = null;
      this.pending = [];
    }
    if (state.status === "LOBBY" || state.status === "WRITING") {
      this._myRole = null;
    }
    this.notifyChange();
  }

  // applyStroke takes the "incoming" stroke_index convention from the
  // engine, which is the *next* index (i.e. the count after appending).
  // We normalize to the 0-based applied index for gap detection.
  private applyStroke(stroke: Stroke, nextIdx: number): void {
    const appliedIdx = nextIdx - 1;
    const round = this._state?.current_round?.index ?? this.expectedNext?.round ?? 0;

    if (!this.expectedNext) {
      this.expectedNext = { round, idx: 0 };
    }
    if (round !== this.expectedNext.round) {
      // Strokes for a round we haven't seen state-update for yet. Drop
      // — the state-update will reset the floor and the host will resync.
      return;
    }

    if (appliedIdx < this.expectedNext.idx) {
      // duplicate or stale — ignore.
      return;
    }
    if (appliedIdx === this.expectedNext.idx) {
      this.deliverStroke(stroke, appliedIdx);
      this.expectedNext.idx += 1;
      this.drainPending();
      return;
    }
    // gap: appliedIdx > expectedNext.idx
    this.pending.push({ stroke_index: appliedIdx, stroke });
    this.requestSyncIfNeeded(round, this.expectedNext.idx);
  }

  private drainPending(): void {
    if (!this.expectedNext) return;
    // Sort once; pending is small (usually 0–few).
    this.pending.sort((a, b) => a.stroke_index - b.stroke_index);
    while (this.pending.length > 0 && this.pending[0].stroke_index === this.expectedNext.idx) {
      const next = this.pending.shift()!;
      this.deliverStroke(next.stroke, next.stroke_index);
      this.expectedNext.idx += 1;
    }
    // discard any obsolete entries below the floor
    this.pending = this.pending.filter((p) => p.stroke_index >= this.expectedNext!.idx);
  }

  private deliverStroke(stroke: Stroke, appliedIdx: number): void {
    this._lastStrokeIndex = appliedIdx;
    // Keep the public stroke event shape unchanged (next-index convention).
    this.strokeListeners.forEach((fn) => fn({ stroke, stroke_index: appliedIdx + 1 }));
  }

  private requestSyncIfNeeded(round: number, fromIdx: number): void {
    if (this.syncInFlight) return;
    if (!this.requestSyncHook) return;
    this.syncInFlight = true;
    this.requestSyncHook(round, fromIdx);
  }

  // Public so a reconnecting guest can manually trigger an initial sync.
  requestSync(): void {
    if (!this.requestSyncHook) return;
    const round = this._state?.current_round?.index ?? 0;
    const from = this.expectedNext?.idx ?? 0;
    if (this.syncInFlight) return;
    this.syncInFlight = true;
    this.requestSyncHook(round, from);
  }

  private notifyChange(): void {
    const snap = this.snapshot;
    this.changeListeners.forEach((fn) => fn(snap));
  }
}
