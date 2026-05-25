// CheckpointDispatcher: host-only. Subscribes to engine state changes
// and flushes a snapshot to POST /api/rooms/:id/snap whenever any of:
//   - strokes_since_flush >= 16
//   - a phase transition happens (status string changes)
//   - 30s have elapsed since the last flush and version has advanced
// (See PLAN_P2P.md §6.4.)
//
// Failures retry with exponential backoff (capped at 5 attempts). Never
// blocks the game loop — all flushes are fire-and-forget.

import type { Engine } from "./engine";
import type { StrokeLog } from "./log";
import { sanitize } from "./sanitize";
import type { GameState } from "./models";

export interface CheckpointOptions {
  roomId: string;
  hostId: string;
  engine: Engine;
  log?: StrokeLog;
  fetch?: typeof fetch;
  // Override for tests; defaults from §6.4.
  strokeThreshold?: number;
  timeMs?: number;
  // Clock injection for tests.
  now?: () => number;
}

const LOG_TAIL_SIZE = 64;

export class CheckpointDispatcher {
  private opts: Required<Omit<CheckpointOptions, "log">> & { log?: StrokeLog };
  private strokesSinceFlush = 0;
  private lastStatus: string | null = null;
  private lastFlushAt = 0;
  private lastFlushedVersion = -1;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubBroadcast: (() => void) | null = null;
  private flushing = false;
  private pending = false;

  constructor(opts: CheckpointOptions) {
    this.opts = {
      strokeThreshold: 16,
      timeMs: 30_000,
      fetch: globalThis.fetch ? globalThis.fetch.bind(globalThis) : (async () => ({ ok: true, status: 204 } as Response)),
      now: () => Date.now(),
      ...opts,
    } as any;
    this.opts.log = opts.log;
  }

  start(): void {
    if (this.unsubBroadcast) return;
    this.unsubBroadcast = this.opts.engine.onBroadcast((evt) => this.observe(evt));
    this.timer = setInterval(() => this.maybeFlushByTime(), Math.min(this.opts.timeMs, 5_000));
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.unsubBroadcast) this.unsubBroadcast();
    this.unsubBroadcast = null;
  }

  // Public so tests can drive without spinning the engine.
  async maybeFlushByTime(): Promise<void> {
    if (this.flushing) return;
    if (this.opts.engine.version === this.lastFlushedVersion) return;
    if (this.opts.now() - this.lastFlushAt < this.opts.timeMs) return;
    await this.flush();
  }

  private observe(evt: { type: string; payload: any }): void {
    if (evt.type === "STROKE_ADDED") {
      this.strokesSinceFlush += 1;
      if (this.strokesSinceFlush >= this.opts.strokeThreshold) void this.flush();
      return;
    }
    if (evt.type === "STATE_UPDATE") {
      const status = (evt.payload as GameState).status;
      if (this.lastStatus !== null && status !== this.lastStatus) {
        void this.flush();
      }
      this.lastStatus = status;
    }
  }

  private async flush(): Promise<void> {
    if (this.flushing) {
      this.pending = true;
      return;
    }
    this.flushing = true;
    try {
      const state = sanitize(this.opts.engine.state);
      const version = this.opts.engine.version;
      // Always emit a log tail blob, even if empty — schema-stable.
      let logTail: { round_index: number; stroke_index: number; stroke: unknown }[] = [];
      let logTailFromIndex = 0;
      if (this.opts.log && state.current_round) {
        const rIdx = state.current_round.index;
        const all = await this.opts.log.getStrokesFrom(rIdx, 0);
        const slice = all.slice(-LOG_TAIL_SIZE);
        logTailFromIndex = slice.length > 0 ? slice[0].stroke_index : 0;
        logTail = slice.map((s) => ({ round_index: rIdx, stroke_index: s.stroke_index, stroke: s.stroke }));
      }
      const body = {
        player_id: this.opts.hostId,
        version,
        state,
        log_tail_from_index: logTailFromIndex,
        log_tail: logTail,
      };
      await this.postWithBackoff(body);
      this.lastFlushedVersion = version;
      this.lastFlushAt = this.opts.now();
      this.strokesSinceFlush = 0;
    } finally {
      this.flushing = false;
      if (this.pending) {
        this.pending = false;
        await this.flush();
      }
    }
  }

  private async postWithBackoff(body: unknown): Promise<void> {
    let delay = 250;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await this.opts.fetch(`/api/rooms/${this.opts.roomId}/snap`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (res.ok || res.status === 204) return;
        // 409 (stale) is terminal — host got demoted between flushes.
        if (res.status === 409) return;
      } catch {
        // network — fall through to backoff
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 4000);
    }
  }
}
