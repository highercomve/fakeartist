// Host failover election. Pure function — no I/O, no time.
//
// Each guest holds its own local view of the room: how far state has
// advanced (snapshot version, last stroke index) and the set of peers
// it currently considers connected. The winner is the candidate with
// the freshest replica; ties resolved by lowest player_id so every peer
// independently picks the same survivor.
//
// Tuple per plan §7: (version desc, last_stroke_index desc, player_id asc).
// `null` is returned only when no candidates are available — caller
// should keep waiting for the grace window in that case.

export interface ElectionCandidate {
  playerId: string;
  version: number;
  lastStrokeIndex: number;
}

export interface LocalView {
  selfId: string;
  // self's own (version, last_stroke_index) from the replica.
  selfVersion: number;
  selfLastStrokeIndex: number;
  // playerIds the local signaling client currently sees connected.
  // Should include selfId. The deposed host should NOT be in this list.
  connected: string[];
  // Optional per-peer (version, last_stroke_index) overrides. When a
  // peer is not present here we fall back to selfVersion/selfLastStrokeIndex=0
  // — i.e. we know they're alive but not how far they got. This is the
  // common case since peers don't gossip their floor today.
  peers?: Record<string, { version: number; lastStrokeIndex: number }>;
}

export function elect(view: LocalView): string | null {
  if (view.connected.length === 0) return null;

  const candidates: ElectionCandidate[] = [];
  for (const pid of view.connected) {
    if (pid === view.selfId) {
      candidates.push({
        playerId: pid,
        version: view.selfVersion,
        lastStrokeIndex: view.selfLastStrokeIndex,
      });
      continue;
    }
    const p = view.peers?.[pid];
    candidates.push({
      playerId: pid,
      version: p?.version ?? 0,
      lastStrokeIndex: p?.lastStrokeIndex ?? 0,
    });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.version !== b.version) return b.version - a.version;
    if (a.lastStrokeIndex !== b.lastStrokeIndex) return b.lastStrokeIndex - a.lastStrokeIndex;
    // ULID/timestamp-prefixed ids are lexicographically comparable.
    if (a.playerId < b.playerId) return -1;
    if (a.playerId > b.playerId) return 1;
    return 0;
  });
  return candidates[0].playerId;
}
