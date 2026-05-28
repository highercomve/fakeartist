package rooms

import (
	"context"
	"encoding/json"
	"errors"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// memStore is an in-memory Storage stub for tests.
type memStore struct {
	mu   sync.Mutex
	data map[string][]byte
}

func newMemStore() *memStore { return &memStore{data: make(map[string][]byte)} }

func (m *memStore) Save(collection, key string, v any) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	m.data[collection+"/"+key] = b
	return nil
}
func (m *memStore) Load(collection, key string, v any) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	b, ok := m.data[collection+"/"+key]
	if !ok {
		return errors.New("not found")
	}
	return json.Unmarshal(b, v)
}
func (m *memStore) Delete(collection, key string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.data, collection+"/"+key)
	return nil
}

func TestCreateLookupRegisterSaveLoad(t *testing.T) {
	store := newMemStore()
	mgr := NewManager(store)

	room, host, err := mgr.CreateRoom("Sergio")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if host.ID != room.HostID {
		t.Fatalf("host id mismatch")
	}
	if !host.IsHost {
		t.Fatalf("creator should be host")
	}
	if len(room.Code) != roomCodeLength {
		t.Fatalf("code len: %d", len(room.Code))
	}

	got, err := mgr.LookupByCode(room.Code)
	if err != nil {
		t.Fatalf("lookup: %v", err)
	}
	if got.ID != room.ID {
		t.Fatalf("lookup id mismatch")
	}

	stub, err := mgr.RegisterPlayer(room.ID, "Alice")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	if stub.ID == host.ID {
		t.Fatalf("new player should get fresh id")
	}
	if len(got.Players) != 2 {
		t.Fatalf("expected 2 players, got %d", len(got.Players))
	}

	cp := Checkpoint{
		Version:          1,
		State:            json.RawMessage(`{"foo":"bar"}`),
		LogTailFromIndex: 0,
		LogTail:          json.RawMessage(`[]`),
	}
	if err := mgr.SaveCheckpoint(context.Background(), room.ID, cp); err != nil {
		t.Fatalf("save checkpoint: %v", err)
	}
	loaded, err := mgr.LoadCheckpoint(context.Background(), room.ID)
	if err != nil {
		t.Fatalf("load checkpoint: %v", err)
	}
	if loaded.Version != 1 {
		t.Fatalf("version: %d", loaded.Version)
	}
	if string(loaded.State) != `{"foo":"bar"}` {
		t.Fatalf("state mismatch: %s", string(loaded.State))
	}
}

func TestCheckpointRejectsStale(t *testing.T) {
	mgr := NewManager(newMemStore())
	room, _, _ := mgr.CreateRoom("Sergio")

	for _, v := range []int{1, 2, 5} {
		if err := mgr.SaveCheckpoint(context.Background(), room.ID,
			Checkpoint{Version: v, State: json.RawMessage(`{}`), LogTail: json.RawMessage(`[]`)}); err != nil {
			t.Fatalf("save v%d: %v", v, err)
		}
	}
	// stale should fail
	if err := mgr.SaveCheckpoint(context.Background(), room.ID,
		Checkpoint{Version: 4, State: json.RawMessage(`{}`), LogTail: json.RawMessage(`[]`)}); err == nil {
		t.Fatal("expected stale checkpoint to fail")
	}
}

func TestUpdateHost(t *testing.T) {
	mgr := NewManager(newMemStore())
	room, _, _ := mgr.CreateRoom("Sergio")
	alice, _ := mgr.RegisterPlayer(room.ID, "Alice")

	if err := mgr.UpdateHost(room.ID, alice.ID); err != nil {
		t.Fatalf("update host: %v", err)
	}
	got, _ := mgr.LookupByID(room.ID)
	if got.HostID != alice.ID {
		t.Fatalf("host not updated: %s", got.HostID)
	}
	for _, p := range got.Players {
		if p.ID == alice.ID && !p.IsHost {
			t.Fatalf("alice should be flagged is_host")
		}
		if p.ID != alice.ID && p.IsHost {
			t.Fatalf("non-alice should not be host: %s", p.ID)
		}
	}
}

func TestLookupMissing(t *testing.T) {
	mgr := NewManager(newMemStore())
	if _, err := mgr.LookupByCode("ZZZZ"); !errors.Is(err, ErrRoomNotFound) {
		t.Fatalf("want ErrRoomNotFound, got %v", err)
	}
}

func TestSweepOnce(t *testing.T) {
	store := newMemStore()
	mgr := NewManager(store)
	mgr.IdleTTL = 10 * time.Minute
	mgr.FinishedGrace = 1 * time.Minute

	// Three rooms: fresh, idle, finished-with-grace-elapsed.
	fresh, _, _ := mgr.CreateRoom("fresh")
	idle, _, _ := mgr.CreateRoom("idle")
	done, _, _ := mgr.CreateRoom("done")

	// Drop a checkpoint on each so we can prove storage is wiped too.
	for _, r := range []*Room{fresh, idle, done} {
		if err := mgr.SaveCheckpoint(context.Background(), r.ID,
			Checkpoint{Version: 1, State: json.RawMessage(`{}`), LogTail: json.RawMessage(`[]`)}); err != nil {
			t.Fatalf("save checkpoint: %v", err)
		}
	}

	now := time.Now().UTC()
	// fresh: just touched → keep.
	mgr.byID[fresh.ID].UpdatedAt = now.Add(-30 * time.Second)
	// idle: past IdleTTL → evict.
	mgr.byID[idle.ID].UpdatedAt = now.Add(-15 * time.Minute)
	// done: well inside IdleTTL but finished + past FinishedGrace → evict.
	mgr.byID[done.ID].UpdatedAt = now.Add(-2 * time.Minute)
	doneAt := now.Add(-2 * time.Minute)
	mgr.byID[done.ID].FinishedAt = &doneAt

	deleted := mgr.SweepOnce(now)
	if len(deleted) != 2 {
		t.Fatalf("expected 2 evictions, got %d (%v)", len(deleted), deleted)
	}

	if _, err := mgr.LookupByID(fresh.ID); err != nil {
		t.Fatalf("fresh room evicted: %v", err)
	}
	if _, err := mgr.LookupByID(idle.ID); !errors.Is(err, ErrRoomNotFound) {
		t.Fatalf("idle room should be gone, got %v", err)
	}
	if _, err := mgr.LookupByID(done.ID); !errors.Is(err, ErrRoomNotFound) {
		t.Fatalf("finished room should be gone, got %v", err)
	}

	// byCode must also be cleared.
	if _, err := mgr.LookupByCode(idle.Code); !errors.Is(err, ErrRoomNotFound) {
		t.Fatalf("idle code should be unmapped, got %v", err)
	}

	// Storage cleanup: evicted rooms have no checkpoint, fresh still does.
	if _, err := mgr.LoadCheckpoint(context.Background(), fresh.ID); err != nil {
		t.Fatalf("fresh checkpoint should survive: %v", err)
	}
	if _, err := mgr.LoadCheckpoint(context.Background(), idle.ID); err == nil {
		t.Fatal("idle checkpoint should be deleted from storage")
	}
	if _, err := mgr.LoadCheckpoint(context.Background(), done.ID); err == nil {
		t.Fatal("finished checkpoint should be deleted from storage")
	}
}

// TestSweepReleasesMemory proves the swept Room is actually reclaimed
// by the runtime — not just unlinked from the manager's maps. We pin a
// finalizer to the Room pointer; if the sweep leaves a dangling
// reference anywhere, the finalizer never runs and the test fails.
func TestSweepReleasesMemory(t *testing.T) {
	mgr := NewManager(newMemStore())
	mgr.IdleTTL = 1 * time.Millisecond

	var finalized atomic.Bool
	func() {
		room, _, err := mgr.CreateRoom("ephemeral")
		if err != nil {
			t.Fatalf("create: %v", err)
		}
		// Backdate so the sweep predicate fires.
		mgr.byID[room.ID].UpdatedAt = time.Now().UTC().Add(-1 * time.Hour)
		runtime.SetFinalizer(room, func(*Room) { finalized.Store(true) })
		// Drop the local pointer before sweeping — only the manager's
		// internal map should be holding the Room at this point.
	}()

	deleted := mgr.SweepOnce(time.Now().UTC())
	if len(deleted) != 1 {
		t.Fatalf("expected 1 eviction, got %d", len(deleted))
	}

	// Force GC twice — the first pass queues the finalizer, the second
	// gives it time to run. We poll because finalizers are async.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		runtime.GC()
		runtime.GC()
		if finalized.Load() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("Room finalizer did not run — sweep left a dangling reference")
}

func TestSetFinished(t *testing.T) {
	mgr := NewManager(newMemStore())
	room, _, _ := mgr.CreateRoom("Sergio")

	if err := mgr.SetFinished(room.ID, true); err != nil {
		t.Fatalf("set finished: %v", err)
	}
	got, _ := mgr.LookupByID(room.ID)
	if got.FinishedAt == nil {
		t.Fatal("FinishedAt should be set")
	}

	// Play-again: clear and re-check.
	if err := mgr.SetFinished(room.ID, false); err != nil {
		t.Fatalf("clear finished: %v", err)
	}
	got, _ = mgr.LookupByID(room.ID)
	if got.FinishedAt != nil {
		t.Fatal("FinishedAt should be cleared")
	}

	if err := mgr.SetFinished("does-not-exist", true); !errors.Is(err, ErrRoomNotFound) {
		t.Fatalf("want ErrRoomNotFound, got %v", err)
	}
}
