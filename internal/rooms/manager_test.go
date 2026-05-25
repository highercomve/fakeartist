package rooms

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
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
