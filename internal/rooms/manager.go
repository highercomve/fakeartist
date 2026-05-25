package rooms

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"sync"
	"time"
)

// Storage is the persistence surface the Manager needs. It matches a
// subset of the existing storage.Driver — collections-and-keys.
type Storage interface {
	Save(collection, key string, v any) error
	Load(collection, key string, v any) error
	Delete(collection, key string) error
}

const (
	checkpointsCollection = "p2p_checkpoints"

	roomCodeLength    = 4
	roomCodeAttempts  = 50
	roomCodeAlphabet  = "ABCDEFGHIJKLMNPQRSTUVWXYZ23456789" // no I/O/0/1 to reduce typo confusion
)

// ErrRoomCodeExhausted is returned when we fail to mint a unique 4-char
// code after roomCodeAttempts tries. Should be effectively unreachable
// for any reasonable concurrent room count (~10^6 distinct codes).
var ErrRoomCodeExhausted = errors.New("could not generate unique room code")

// ErrRoomNotFound is returned by LookupByCode / LoadCheckpoint when no
// matching entry exists.
var ErrRoomNotFound = errors.New("room not found")

// Manager owns the in-memory room registry. Persistence (snapshots) is
// delegated to Storage. The in-memory map is the source of truth for
// short-lived metadata (code -> id, host, players); a server restart
// drops live rooms but checkpoints survive in storage.
type Manager struct {
	mu      sync.RWMutex
	store   Storage
	byID    map[string]*Room
	byCode  map[string]string // code -> id
}

func NewManager(store Storage) *Manager {
	return &Manager{
		store:  store,
		byID:   make(map[string]*Room),
		byCode: make(map[string]string),
	}
}

// CreateRoom mints a unique code + room id and registers the creator
// as the host. The returned room is a copy safe for the caller to
// inspect; the manager retains the canonical pointer internally.
func (m *Manager) CreateRoom(hostName string) (*Room, *PlayerStub, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	code, err := m.mintCodeLocked()
	if err != nil {
		return nil, nil, err
	}

	now := time.Now().UTC()
	roomID := newID("r")
	hostID := newID("p")

	host := &PlayerStub{
		ID:        hostID,
		Name:      hostName,
		IsHost:    true,
		Connected: false, // becomes true on WS hello
	}
	room := &Room{
		ID:        roomID,
		Code:      code,
		HostID:    hostID,
		Players:   []*PlayerStub{host},
		CreatedAt: now,
		UpdatedAt: now,
	}
	m.byID[roomID] = room
	m.byCode[code] = roomID
	return room, host, nil
}

// LookupByCode returns the room (and a fresh slice of players) for a
// 4-char user-facing code.
func (m *Manager) LookupByCode(code string) (*Room, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	id, ok := m.byCode[code]
	if !ok {
		return nil, ErrRoomNotFound
	}
	room, ok := m.byID[id]
	if !ok {
		return nil, ErrRoomNotFound
	}
	return room, nil
}

// LookupByID is the internal sibling used by WS / role / snapshot handlers.
func (m *Manager) LookupByID(id string) (*Room, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	room, ok := m.byID[id]
	if !ok {
		return nil, ErrRoomNotFound
	}
	return room, nil
}

// RegisterPlayer either adds a new player to the room or updates an
// existing one's name (idempotent on player_id). Returns the canonical
// PlayerStub.
func (m *Manager) RegisterPlayer(roomID, playerName string) (*PlayerStub, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	room, ok := m.byID[roomID]
	if !ok {
		return nil, ErrRoomNotFound
	}
	for _, p := range room.Players {
		if p.Name == playerName && playerName != "" {
			// Re-attach by name (legacy WS path does the same).
			return p, nil
		}
	}
	stub := &PlayerStub{
		ID:        newID("p"),
		Name:      playerName,
		IsHost:    false,
		Connected: false,
	}
	room.Players = append(room.Players, stub)
	room.UpdatedAt = time.Now().UTC()
	return stub, nil
}

// UpdateHost replaces the host pointer. The server endorses host claims
// during failover; callers must pre-validate the (version, last_index)
// arbitration.
func (m *Manager) UpdateHost(roomID, newHostID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	room, ok := m.byID[roomID]
	if !ok {
		return ErrRoomNotFound
	}
	room.HostID = newHostID
	for _, p := range room.Players {
		p.IsHost = p.ID == newHostID
	}
	room.UpdatedAt = time.Now().UTC()
	return nil
}

// SaveCheckpoint persists a host snapshot. Versions must monotonically
// increase; older snapshots are rejected to protect against late writes
// from a deposed host.
func (m *Manager) SaveCheckpoint(_ context.Context, roomID string, cp Checkpoint) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	room, ok := m.byID[roomID]
	if !ok {
		return ErrRoomNotFound
	}
	if cp.Version <= room.SnapshotVersion {
		return fmt.Errorf("stale checkpoint v%d <= current v%d", cp.Version, room.SnapshotVersion)
	}
	cp.UpdatedAt = time.Now().UTC()
	if err := m.store.Save(checkpointsCollection, roomID, &cp); err != nil {
		return err
	}
	room.SnapshotVersion = cp.Version
	room.Started = true
	room.UpdatedAt = cp.UpdatedAt
	return nil
}

// LoadCheckpoint returns the most recent snapshot for a room, if any.
func (m *Manager) LoadCheckpoint(_ context.Context, roomID string) (*Checkpoint, error) {
	var cp Checkpoint
	if err := m.store.Load(checkpointsCollection, roomID, &cp); err != nil {
		return nil, err
	}
	return &cp, nil
}

// claimGraceWindow is the §7 arbitration window: after the first claim
// arrives we keep its (version, lastStrokeIndex) tuple as the running
// best for this long so racing claimants can lose deterministically.
const claimGraceWindow = 2 * time.Second

// ClaimHost arbitrates a host-promotion request per plan §7. Endorsement
// rules, in order:
//   1. If there's no current host (cold boot or deposed host) and no
//      racing claim within the grace window beats this one, endorse.
//   2. If the claimant matches the current host, endorse (idempotent).
//   3. Otherwise reject with the current best (host_id, version, last_index).
//
// The (version, lastStrokeIndex) tuple is compared lexicographically;
// player_id is the final tiebreak (lowest wins). The running "best"
// claim within the grace window lives on Room.lastClaim so a slower
// arrival with a worse tuple cannot overtake a freshly endorsed peer.
func (m *Manager) ClaimHost(roomID, playerID string, version, lastStrokeIndex int) (string, int, int, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	room, ok := m.byID[roomID]
	if !ok {
		return "", 0, 0, false, ErrRoomNotFound
	}

	// Idempotent re-claim by current host — always endorse.
	if room.HostID == playerID && playerID != "" {
		room.UpdatedAt = time.Now().UTC()
		return playerID, version, lastStrokeIndex, true, nil
	}

	// If host is set and the grace window has lapsed, hold the line.
	now := time.Now().UTC()
	if room.HostID != "" {
		if room.LastClaim == nil || now.Sub(room.LastClaim.At) > claimGraceWindow {
			return room.HostID, room.LastClaim.bestVersionOr(room.SnapshotVersion), room.LastClaim.bestStrokeIndexOr(0), false, nil
		}
		// Within grace: allow a strictly better tuple to displace.
		best := room.LastClaim
		if !tupleBeats(version, lastStrokeIndex, playerID, best.Version, best.LastStrokeIndex, best.PlayerID) {
			return room.HostID, best.Version, best.LastStrokeIndex, false, nil
		}
	}

	// Endorse: update best-seen + assign host.
	room.HostID = playerID
	for _, p := range room.Players {
		p.IsHost = p.ID == playerID
	}
	room.LastClaim = &ClaimRecord{
		PlayerID:        playerID,
		Version:         version,
		LastStrokeIndex: lastStrokeIndex,
		At:              now,
	}
	room.UpdatedAt = now
	return playerID, version, lastStrokeIndex, true, nil
}

// tupleBeats returns true iff (vA, sA, pA) > (vB, sB, pB) under the
// (version desc, lastStrokeIndex desc, playerID asc) ordering used by
// both the client election (election.ts) and the server arbitrator.
func tupleBeats(vA, sA int, pA string, vB, sB int, pB string) bool {
	if vA != vB {
		return vA > vB
	}
	if sA != sB {
		return sA > sB
	}
	// player_id asc means smaller string wins.
	return pA < pB
}

// DeleteRoom removes a room from the registry and (best effort) drops
// its checkpoint. Used by the cleanup pass.
func (m *Manager) DeleteRoom(roomID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if room, ok := m.byID[roomID]; ok {
		delete(m.byCode, room.Code)
		delete(m.byID, roomID)
	}
	_ = m.store.Delete(checkpointsCollection, roomID)
}

// ---- helpers ----

func (m *Manager) mintCodeLocked() (string, error) {
	for range roomCodeAttempts {
		code := randomCode(roomCodeLength)
		if _, taken := m.byCode[code]; !taken {
			return code, nil
		}
	}
	return "", ErrRoomCodeExhausted
}

func randomCode(n int) string {
	buf := make([]byte, n)
	max := big.NewInt(int64(len(roomCodeAlphabet)))
	for i := range n {
		idx, _ := rand.Int(rand.Reader, max)
		buf[i] = roomCodeAlphabet[idx.Int64()]
	}
	return string(buf)
}

// newID returns a short-ish opaque id. We use timestamp_ns + 6 random
// hex chars for now; PR 5+ may swap in a real ULID library.
func newID(prefix string) string {
	var b [6]byte
	_, _ = rand.Read(b[:])
	return fmt.Sprintf("%s_%d_%x", prefix, time.Now().UnixNano(), b)
}

// AsJSON is a small helper for handlers that need to write back the
// public room view to clients.
func (r *Room) AsJSON() ([]byte, error) {
	return json.Marshal(r)
}
