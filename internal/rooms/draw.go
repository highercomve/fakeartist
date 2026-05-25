package rooms

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	mathrand "math/rand"
	"sync"
	"time"
)

// PoolEntry mirrors the host's WordCard for the server-side draw.
// Stored as part of the in-memory Room and persisted alongside reveal
// records (§3.5 reveal endpoint).
type PoolEntry struct {
	ID       string `json:"id"`
	Word     string `json:"word"`
	AuthorID string `json:"author_id"`
	Used     bool   `json:"used"`
}

// RoleAssignment is the per-player slice of the draw response.
type RoleAssignment struct {
	IsFake bool   `json:"is_fake"`
	Word   string `json:"word,omitempty"`
}

// DrawResult is what /roles returns to the host.
type DrawResult struct {
	RoundIndex       int                       `json:"round_index"`
	CardID           string                    `json:"card_id"`
	Assignments      map[string]RoleAssignment `json:"assignments"`
	FakeIDCommitment string                    `json:"fake_id_commitment"`
}

// RoundReveal is what /reveal/:round publishes after the round closes.
// Clients verify sha256(fake_id || nonce) == commitment.
type RoundReveal struct {
	RoundIndex int    `json:"round_index"`
	FakeID     string `json:"fake_id"`
	Word       string `json:"word"`
	Nonce      string `json:"nonce"`
}

// roundSecret holds the server's view of a single round between draw
// and reveal. The fake id + nonce never leave the server until reveal.
type roundSecret struct {
	CardID     string
	Word       string
	FakeID     string
	Nonce      []byte
	Commitment string
}

var (
	ErrPoolExhausted   = errors.New("pool exhausted")
	ErrNotHost         = errors.New("not host")
	ErrUnknownRound    = errors.New("unknown round")
	ErrNoPlayers       = errors.New("no connected players")
)

// drawRng is an injection seam for tests. Defaults to time-seeded.
var drawRng func() *mathrand.Rand = func() *mathrand.Rand {
	return mathrand.New(mathrand.NewSource(time.Now().UnixNano()))
}

// DrawState is mounted onto each Room (lazily) to hold the pool and
// round secrets. Kept as a separate struct to keep models.go free of
// server-only fields.
type DrawState struct {
	mu      sync.Mutex
	pool    []PoolEntry
	secrets map[int]*roundSecret // round_index -> secret
}

func newDrawState() *DrawState {
	return &DrawState{secrets: make(map[int]*roundSecret)}
}

// MergePool adds any pool entries the host has submitted that we don't
// already track. New entries default to Used=false. The first call
// effectively seeds; later calls extend if late words were submitted.
func (d *DrawState) MergePool(entries []PoolEntry) {
	d.mu.Lock()
	defer d.mu.Unlock()
	known := make(map[string]bool, len(d.pool))
	for _, p := range d.pool {
		known[p.ID] = true
	}
	for _, e := range entries {
		if known[e.ID] {
			continue
		}
		d.pool = append(d.pool, PoolEntry{ID: e.ID, Word: e.Word, AuthorID: e.AuthorID})
	}
}

// PickCard chooses an unused entry uniformly, marks it used, and
// returns its id+word. Errors if the pool is empty.
func (d *DrawState) PickCard(rng *mathrand.Rand) (id, word string, err error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	avail := make([]int, 0, len(d.pool))
	for i, p := range d.pool {
		if !p.Used {
			avail = append(avail, i)
		}
	}
	if len(avail) == 0 {
		return "", "", ErrPoolExhausted
	}
	idx := avail[rng.Intn(len(avail))]
	d.pool[idx].Used = true
	return d.pool[idx].ID, d.pool[idx].Word, nil
}

// Draw runs the full role draw for a round. Stores the secret keyed by
// round_index so the matching /reveal/:round call can publish it.
func (m *Manager) Draw(roomID, callerID string, roundIndex int, players []string, pool []PoolEntry) (*DrawResult, error) {
	m.mu.Lock()
	room, ok := m.byID[roomID]
	if !ok {
		m.mu.Unlock()
		return nil, ErrRoomNotFound
	}
	if callerID != room.HostID {
		m.mu.Unlock()
		return nil, ErrNotHost
	}
	if room.Draw == nil {
		room.Draw = newDrawState()
	}
	ds := room.Draw
	m.mu.Unlock()

	if len(players) == 0 {
		return nil, ErrNoPlayers
	}

	ds.MergePool(pool)

	rng := drawRng()
	cardID, word, err := ds.PickCard(rng)
	if err != nil {
		return nil, err
	}

	fakeID := players[rng.Intn(len(players))]
	nonce := make([]byte, 16)
	_, _ = rand.Read(nonce)
	sum := sha256.Sum256(append([]byte(fakeID), nonce...))
	commitment := hex.EncodeToString(sum[:])

	ds.mu.Lock()
	ds.secrets[roundIndex] = &roundSecret{
		CardID:     cardID,
		Word:       word,
		FakeID:     fakeID,
		Nonce:      nonce,
		Commitment: commitment,
	}
	ds.mu.Unlock()

	assignments := make(map[string]RoleAssignment, len(players))
	for _, pid := range players {
		if pid == fakeID {
			assignments[pid] = RoleAssignment{IsFake: true}
		} else {
			assignments[pid] = RoleAssignment{IsFake: false, Word: word}
		}
	}

	return &DrawResult{
		RoundIndex:       roundIndex,
		CardID:           cardID,
		Assignments:      assignments,
		FakeIDCommitment: commitment,
	}, nil
}

// Reveal returns the round secret for a given round_index, including
// the nonce. Errors if the round was never drawn.
func (m *Manager) Reveal(roomID string, roundIndex int) (*RoundReveal, error) {
	m.mu.RLock()
	room, ok := m.byID[roomID]
	m.mu.RUnlock()
	if !ok {
		return nil, ErrRoomNotFound
	}
	if room.Draw == nil {
		return nil, ErrUnknownRound
	}
	room.Draw.mu.Lock()
	defer room.Draw.mu.Unlock()
	sec, ok := room.Draw.secrets[roundIndex]
	if !ok {
		return nil, ErrUnknownRound
	}
	return &RoundReveal{
		RoundIndex: roundIndex,
		FakeID:     sec.FakeID,
		Word:       sec.Word,
		Nonce:      hex.EncodeToString(sec.Nonce),
	}, nil
}

