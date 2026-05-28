package rooms

import (
	"encoding/json"
	"time"
)

// PlayerStub is the minimal player record the server needs for role
// draw eligibility and naming. The full Player struct still lives in
// internal/game for the legacy WS path.
type PlayerStub struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Color     string `json:"color"`
	IsHost    bool   `json:"is_host"`
	Connected bool   `json:"connected"`
	Score     int    `json:"score"`
}

// Room is the server-side metadata for a P2P room. The host browser
// owns the live GameState; the server only sees opaque snapshots and
// the player roster.
type Room struct {
	ID              string         `json:"id"`
	Code            string         `json:"code"`
	HostID          string         `json:"host_id"`
	Players         []*PlayerStub  `json:"players"`
	Started         bool           `json:"started"`
	SnapshotVersion int            `json:"snapshot_version"`
	CreatedAt       time.Time      `json:"created_at"`
	UpdatedAt       time.Time      `json:"updated_at"`

	// FinishedAt, when non-nil, marks the room as game-over. The GC
	// sweep uses it to apply a short grace window (FinishedGrace) on
	// top of the idle predicate so completed rooms get reaped sooner
	// than merely-idle ones.
	FinishedAt *time.Time `json:"finished_at,omitempty"`

	// Draw holds the server-side pool + round secrets used by the role
	// assignment endpoints (PR 6). nil until the host first calls /roles.
	// Not serialized — secrets must never leak through Room JSON.
	Draw *DrawState `json:"-"`

	// LastClaim is the in-flight failover claim record. Kept in-memory
	// only — see Manager.ClaimHost for the arbitration window semantics.
	LastClaim *ClaimRecord `json:"-"`
}

// ClaimRecord captures the running-best host-promotion claim during the
// grace window. A slower claim with a worse (version, lastStrokeIndex,
// playerID) tuple cannot displace an already-endorsed peer.
type ClaimRecord struct {
	PlayerID        string
	Version         int
	LastStrokeIndex int
	At              time.Time
}

// bestVersionOr / bestStrokeIndexOr are tiny helpers so the rejection
// path can report a sane "current best" tuple even when LastClaim is
// nil (e.g. cold-boot endorsement with no prior arbitration).
func (c *ClaimRecord) bestVersionOr(fallback int) int {
	if c == nil {
		return fallback
	}
	return c.Version
}
func (c *ClaimRecord) bestStrokeIndexOr(fallback int) int {
	if c == nil {
		return fallback
	}
	return c.LastStrokeIndex
}

// Checkpoint wraps the host's serialized GameState plus a stroke log
// tail, as defined in PLAN_P2P.md §3.6. Snapshots are sanitized at the
// host before POSTing.
type Checkpoint struct {
	Version          int             `json:"version"`
	State            json.RawMessage `json:"state"`
	LogTailFromIndex int             `json:"log_tail_from_index"`
	LogTail          json.RawMessage `json:"log_tail"`
	UpdatedAt       time.Time       `json:"updated_at"`
}
