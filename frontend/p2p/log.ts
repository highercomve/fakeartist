// IndexedDB-backed stroke log + small meta/state stores. Both host and
// guest keep a copy; the host uses it as the source for SYNC_RES and
// checkpoints, the guest uses it as a local cache + gap-detection floor.
//
// Schema (see PLAN_P2P.md §6.2):
//   db: fakeartist
//     store: log   key: `${roomId}/${roundIndex}/${strokeIndex}`
//                  value: { player_id, color, points, ts }
//     store: meta  key: roomId
//                  value: { last_round_index, last_stroke_index, last_state_version }
//     store: state key: roomId
//                  value: { version, state }

import type { GameState, Stroke } from "./models";

export interface IndexedStroke {
  player_id: string;
  color: string;
  points: { x: number; y: number }[];
  ts: number;
}

export interface LogMeta {
  last_round_index: number;
  last_stroke_index: number;
  last_state_version: number;
}

export interface LogState {
  version: number;
  state: GameState;
}

const DB_NAME = "fakeartist";
const DB_VERSION = 1;
const STORE_LOG = "log";
const STORE_META = "meta";
const STORE_STATE = "state";

// idb factory injected so tests can supply fake-indexeddb's `indexedDB`.
export interface StrokeLogOptions {
  roomId: string;
  idbFactory?: IDBFactory;
}

export class StrokeLog {
  private roomId: string;
  private idb: IDBFactory;
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(opts: StrokeLogOptions) {
    this.roomId = opts.roomId;
    this.idb = opts.idbFactory ?? (globalThis.indexedDB as IDBFactory);
  }

  private openDb(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const req = this.idb.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_LOG)) db.createObjectStore(STORE_LOG);
        if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
        if (!db.objectStoreNames.contains(STORE_STATE)) db.createObjectStore(STORE_STATE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.dbPromise;
  }

  private strokeKey(roundIndex: number, strokeIndex: number): string {
    return `${this.roomId}/${roundIndex}/${strokeIndex}`;
  }

  async appendStroke(roundIndex: number, strokeIndex: number, stroke: Stroke): Promise<void> {
    const db = await this.openDb();
    const entry: IndexedStroke = {
      player_id: stroke.player_id,
      color: stroke.color,
      points: stroke.points,
      ts: Date.now(),
    };
    await tx(db, [STORE_LOG, STORE_META], "readwrite", (t) => {
      t.objectStore(STORE_LOG).put(entry, this.strokeKey(roundIndex, strokeIndex));
      // also update meta so reconnect sees the floor.
      const metaStore = t.objectStore(STORE_META);
      const getReq = metaStore.get(this.roomId);
      getReq.onsuccess = () => {
        const prev = (getReq.result as LogMeta | undefined) ?? {
          last_round_index: roundIndex,
          last_stroke_index: -1,
          last_state_version: 0,
        };
        const next: LogMeta = {
          last_round_index: Math.max(prev.last_round_index, roundIndex),
          // stroke index resets per round; trust the latest write within the
          // round and let the round-rollover branch handle resets.
          last_stroke_index:
            roundIndex > prev.last_round_index ? strokeIndex : Math.max(prev.last_stroke_index, strokeIndex),
          last_state_version: prev.last_state_version,
        };
        metaStore.put(next, this.roomId);
      };
    });
  }

  async getStrokesFrom(roundIndex: number, fromStrokeIndex: number): Promise<{ stroke_index: number; stroke: Stroke }[]> {
    const db = await this.openDb();
    const out: { stroke_index: number; stroke: Stroke }[] = [];
    const prefix = `${this.roomId}/${roundIndex}/`;
    await tx(db, [STORE_LOG], "readonly", (t) => {
      const store = t.objectStore(STORE_LOG);
      // IDBKeyRange.lowerBound on string keys works lexicographically.
      const lower = `${prefix}${fromStrokeIndex}`;
      const upper = `${prefix}￿`;
      const range = IDBKeyRange.bound(lower, upper, false, false);
      const req = store.openCursor(range);
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        const key = cursor.key as string;
        const idxStr = key.slice(prefix.length);
        const idx = Number(idxStr);
        // string-sort can interleave "10" before "2"; guard with the
        // numeric floor and a final sort on the way out.
        if (idx >= fromStrokeIndex) {
          const v = cursor.value as IndexedStroke;
          out.push({
            stroke_index: idx,
            stroke: { player_id: v.player_id, color: v.color, points: v.points },
          });
        }
        cursor.continue();
      };
    });
    out.sort((a, b) => a.stroke_index - b.stroke_index);
    return out;
  }

  async getMeta(): Promise<LogMeta | null> {
    const db = await this.openDb();
    return await new Promise((resolve, reject) => {
      const t = db.transaction([STORE_META], "readonly");
      const req = t.objectStore(STORE_META).get(this.roomId);
      req.onsuccess = () => resolve((req.result as LogMeta | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async putState(version: number, state: GameState): Promise<void> {
    const db = await this.openDb();
    await tx(db, [STORE_STATE, STORE_META], "readwrite", (t) => {
      const entry: LogState = { version, state };
      t.objectStore(STORE_STATE).put(entry, this.roomId);
      const metaStore = t.objectStore(STORE_META);
      const getReq = metaStore.get(this.roomId);
      getReq.onsuccess = () => {
        const prev = (getReq.result as LogMeta | undefined) ?? {
          last_round_index: state.current_round?.index ?? -1,
          last_stroke_index: -1,
          last_state_version: 0,
        };
        const next: LogMeta = {
          last_round_index: state.current_round?.index ?? prev.last_round_index,
          last_stroke_index: prev.last_stroke_index,
          last_state_version: Math.max(prev.last_state_version, version),
        };
        metaStore.put(next, this.roomId);
      };
    });
  }

  async getState(): Promise<LogState | null> {
    const db = await this.openDb();
    return await new Promise((resolve, reject) => {
      const t = db.transaction([STORE_STATE], "readonly");
      const req = t.objectStore(STORE_STATE).get(this.roomId);
      req.onsuccess = () => resolve((req.result as LogState | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  // Drop everything for this room — used on game-over cleanup or reset.
  async clearRoom(): Promise<void> {
    const db = await this.openDb();
    await tx(db, [STORE_LOG, STORE_META, STORE_STATE], "readwrite", (t) => {
      // log entries are scoped by key prefix; walk and delete.
      const store = t.objectStore(STORE_LOG);
      const prefix = `${this.roomId}/`;
      const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
      const req = store.openCursor(range);
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return;
        c.delete();
        c.continue();
      };
      t.objectStore(STORE_META).delete(this.roomId);
      t.objectStore(STORE_STATE).delete(this.roomId);
    });
  }
}

// tx is a small promise wrapper that resolves on transaction complete.
function tx(
  db: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  body: (t: IDBTransaction) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
    body(t);
  });
}
