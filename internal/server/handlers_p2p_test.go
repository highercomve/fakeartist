package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/labstack/echo/v4"

	"github.com/sergiom/fakeartist/internal/signal"
)

// memStore mirrors the helper in internal/rooms but local — keeps the
// server package free of test deps from sibling packages.
type memStore struct {
	mu   sync.Mutex
	data map[string][]byte
}

func (m *memStore) Save(c, k string, v any) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.data == nil {
		m.data = make(map[string][]byte)
	}
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	m.data[c+"/"+k] = b
	return nil
}
func (m *memStore) Load(c, k string, v any) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	b, ok := m.data[c+"/"+k]
	if !ok {
		return errors.New("not found")
	}
	return json.Unmarshal(b, v)
}
func (m *memStore) Delete(c, k string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.data, c+"/"+k)
	return nil
}

// newTestServer wires just enough for the P2P handlers.
func newTestServer(t *testing.T) (*httptest.Server, *Server) {
	t.Helper()
	s := &Server{
		echo: echo.New(),
		cfg:  Config{P2PEnabled: true},
	}
	s.EnableP2P(&memStore{})
	s.echo.POST("/api/rooms", s.handleCreateRoom)
	s.echo.POST("/api/rooms/:code/join", s.handleJoinRoom)
	s.echo.GET("/api/rooms/:code", s.handleLookupRoom)
	s.echo.GET("/api/signal", s.handleSignalWS)
	s.echo.POST("/api/rooms/:id/roles", s.handleDrawRoles)
	s.echo.GET("/api/rooms/:id/reveal/:round", s.handleReveal)
	s.echo.POST("/api/rooms/:id/snap", s.handleSaveSnap)
	s.echo.GET("/api/rooms/:id/snap", s.handleLoadSnap)
	s.echo.POST("/api/rooms/:id/claim-host", s.handleClaimHost)
	hs := httptest.NewServer(s.echo)
	t.Cleanup(hs.Close)
	return hs, s
}

func TestCreateAndLookupRoom(t *testing.T) {
	hs, _ := newTestServer(t)

	body := bytes.NewReader([]byte(`{"player_name":"Sergio"}`))
	resp, err := http.Post(hs.URL+"/api/rooms", "application/json", body)
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status: %d", resp.StatusCode)
	}
	var created createRoomRes
	if err := json.NewDecoder(resp.Body).Decode(&created); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if created.RoomCode == "" || created.RoomID == "" || created.PlayerID == "" || !created.IsHost {
		t.Fatalf("bad create response: %+v", created)
	}

	lookup, err := http.Get(hs.URL + "/api/rooms/" + created.RoomCode)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer lookup.Body.Close()
	var got lookupRoomRes
	json.NewDecoder(lookup.Body).Decode(&got)
	if !got.Exists || got.RoomID != created.RoomID || got.HostID != created.PlayerID {
		t.Fatalf("bad lookup: %+v", got)
	}
}

func TestSignalingSDPRelay(t *testing.T) {
	hs, s := newTestServer(t)

	// Create room (registers host).
	resp, err := http.Post(hs.URL+"/api/rooms", "application/json",
		strings.NewReader(`{"player_name":"Host"}`))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer resp.Body.Close()
	var created createRoomRes
	json.NewDecoder(resp.Body).Decode(&created)

	// Add a guest stub through the manager (POST /rooms only creates
	// the host today; future endpoints will register guests on join).
	guest, err := s.p2p.mgr.RegisterPlayer(created.RoomID, "Guest")
	if err != nil {
		t.Fatalf("register guest: %v", err)
	}

	hostConn := dialSignal(t, hs, created.RoomID, created.PlayerID)
	defer hostConn.Close()
	guestConn := dialSignal(t, hs, created.RoomID, guest.ID)
	defer guestConn.Close()

	// Guest sends an SDP offer addressed to the host.
	offer := signal.Envelope{Type: signal.EnvSDPOffer, To: created.PlayerID, SDP: "v=0\r\ndummy"}
	if err := guestConn.WriteJSON(offer); err != nil {
		t.Fatalf("write offer: %v", err)
	}

	// Read on host until we see SDP_OFFER, skipping PEER_JOINED frames.
	// One single deadline for the whole read sequence keeps gorilla's
	// internal read state consistent.
	deadline := time.Now().Add(3 * time.Second)
	hostConn.SetReadDeadline(deadline)
	var got signal.Envelope
	for {
		if err := hostConn.ReadJSON(&got); err != nil {
			t.Fatalf("read on host: %v", err)
		}
		if got.Type == signal.EnvSDPOffer {
			break
		}
	}
	if got.From != guest.ID {
		t.Fatalf("From not stamped: %q", got.From)
	}
	if got.SDP != "v=0\r\ndummy" {
		t.Fatalf("SDP not relayed: %q", got.SDP)
	}
}

func TestDrawAndReveal(t *testing.T) {
	hs, s := newTestServer(t)

	// Create room (registers host).
	resp, err := http.Post(hs.URL+"/api/rooms", "application/json",
		strings.NewReader(`{"player_name":"Host"}`))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	defer resp.Body.Close()
	var created createRoomRes
	json.NewDecoder(resp.Body).Decode(&created)

	guest, _ := s.p2p.mgr.RegisterPlayer(created.RoomID, "Guest")

	body := map[string]any{
		"player_id":         created.PlayerID,
		"round_index":       0,
		"connected_players": []string{created.PlayerID, guest.ID},
		"pool": []map[string]any{
			{"id": "c1", "word": "tractor", "author_id": created.PlayerID},
			{"id": "c2", "word": "banana", "author_id": guest.ID},
		},
	}
	bb, _ := json.Marshal(body)
	rolesResp, err := http.Post(hs.URL+"/api/rooms/"+created.RoomID+"/roles",
		"application/json", bytes.NewReader(bb))
	if err != nil {
		t.Fatalf("roles: %v", err)
	}
	defer rolesResp.Body.Close()
	if rolesResp.StatusCode != 200 {
		t.Fatalf("roles status: %d", rolesResp.StatusCode)
	}
	var draw struct {
		RoundIndex       int    `json:"round_index"`
		CardID           string `json:"card_id"`
		Assignments      map[string]struct {
			IsFake bool   `json:"is_fake"`
			Word   string `json:"word"`
		} `json:"assignments"`
		FakeIDCommitment string `json:"fake_id_commitment"`
	}
	json.NewDecoder(rolesResp.Body).Decode(&draw)
	if draw.FakeIDCommitment == "" {
		t.Fatal("no commitment")
	}
	if len(draw.Assignments) != 2 {
		t.Fatalf("assignments: %v", draw.Assignments)
	}
	// Exactly one fake.
	fakes := 0
	var fakeID string
	for pid, a := range draw.Assignments {
		if a.IsFake {
			fakes++
			fakeID = pid
		} else if a.Word == "" {
			t.Fatalf("non-fake %s missing word", pid)
		}
	}
	if fakes != 1 {
		t.Fatalf("expected 1 fake, got %d", fakes)
	}

	// Reveal — should expose the word + nonce, and commitment must verify.
	revResp, err := http.Get(hs.URL + "/api/rooms/" + created.RoomID + "/reveal/0")
	if err != nil {
		t.Fatalf("reveal: %v", err)
	}
	defer revResp.Body.Close()
	if revResp.StatusCode != 200 {
		t.Fatalf("reveal status: %d", revResp.StatusCode)
	}
	var rev struct {
		RoundIndex int    `json:"round_index"`
		FakeID     string `json:"fake_id"`
		Word       string `json:"word"`
		Nonce      string `json:"nonce"`
	}
	json.NewDecoder(revResp.Body).Decode(&rev)
	if rev.FakeID != fakeID {
		t.Fatalf("reveal fake mismatch: %s vs %s", rev.FakeID, fakeID)
	}
	if rev.Word == "" || rev.Nonce == "" {
		t.Fatalf("reveal missing word/nonce: %+v", rev)
	}

	// Verify commitment client-side: sha256(fake_id || nonce) == commitment.
	nonceBytes, err := hex.DecodeString(rev.Nonce)
	if err != nil {
		t.Fatalf("nonce hex: %v", err)
	}
	sum := sha256.Sum256(append([]byte(rev.FakeID), nonceBytes...))
	got := hex.EncodeToString(sum[:])
	if got != draw.FakeIDCommitment {
		t.Fatalf("commitment mismatch:\n  computed: %s\n  server:   %s", got, draw.FakeIDCommitment)
	}
}

func TestSnapSaveLoad(t *testing.T) {
	hs, _ := newTestServer(t)
	resp, err := http.Post(hs.URL+"/api/rooms", "application/json",
		strings.NewReader(`{"player_name":"Host"}`))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	defer resp.Body.Close()
	var created createRoomRes
	json.NewDecoder(resp.Body).Decode(&created)

	snap := map[string]any{
		"player_id":            created.PlayerID,
		"version":              1,
		"state":                json.RawMessage(`{"foo":"bar"}`),
		"log_tail_from_index":  0,
		"log_tail":             json.RawMessage(`[]`),
	}
	bb, _ := json.Marshal(snap)
	saveResp, err := http.Post(hs.URL+"/api/rooms/"+created.RoomID+"/snap",
		"application/json", bytes.NewReader(bb))
	if err != nil {
		t.Fatalf("save snap: %v", err)
	}
	defer saveResp.Body.Close()
	if saveResp.StatusCode != 204 {
		t.Fatalf("save status: %d", saveResp.StatusCode)
	}

	loadResp, err := http.Get(hs.URL + "/api/rooms/" + created.RoomID + "/snap")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	defer loadResp.Body.Close()
	var loaded struct {
		Version int             `json:"version"`
		State   json.RawMessage `json:"state"`
	}
	json.NewDecoder(loadResp.Body).Decode(&loaded)
	if loaded.Version != 1 {
		t.Fatalf("version: %d", loaded.Version)
	}
}

func TestClaimHostColdBoot(t *testing.T) {
	hs, s := newTestServer(t)
	resp, err := http.Post(hs.URL+"/api/rooms", "application/json",
		strings.NewReader(`{"player_name":"Host"}`))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	defer resp.Body.Close()
	var created createRoomRes
	json.NewDecoder(resp.Body).Decode(&created)

	// Vacate the host slot (simulate total collapse).
	room, _ := s.p2p.mgr.LookupByID(created.RoomID)
	room.HostID = ""
	room.LastClaim = nil

	guest, _ := s.p2p.mgr.RegisterPlayer(created.RoomID, "Joiner")
	bb, _ := json.Marshal(map[string]any{
		"player_id": guest.ID, "version": 0, "last_stroke_index": 0,
	})
	cresp, err := http.Post(hs.URL+"/api/rooms/"+created.RoomID+"/claim-host",
		"application/json", bytes.NewReader(bb))
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	defer cresp.Body.Close()
	var got claimHostRes
	json.NewDecoder(cresp.Body).Decode(&got)
	if !got.Endorsed || got.HostID != guest.ID {
		t.Fatalf("claim not endorsed: %+v", got)
	}
}

// TestClaimHostDoubleClaim covers T8.3's headline scenario: two
// guests promote themselves after host death; the higher-tuple peer
// wins and the loser receives 409 with the running-best tuple.
func TestClaimHostDoubleClaim(t *testing.T) {
	hs, s := newTestServer(t)
	resp, err := http.Post(hs.URL+"/api/rooms", "application/json",
		strings.NewReader(`{"player_name":"Host"}`))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	defer resp.Body.Close()
	var created createRoomRes
	json.NewDecoder(resp.Body).Decode(&created)

	// Host died: vacate slot.
	room, _ := s.p2p.mgr.LookupByID(created.RoomID)
	room.HostID = ""
	room.LastClaim = nil

	a, _ := s.p2p.mgr.RegisterPlayer(created.RoomID, "Alice")
	b, _ := s.p2p.mgr.RegisterPlayer(created.RoomID, "Bob")

	// Alice claims first with a modest tuple.
	bb1, _ := json.Marshal(map[string]any{
		"player_id": a.ID, "version": 3, "last_stroke_index": 5,
	})
	r1, err := http.Post(hs.URL+"/api/rooms/"+created.RoomID+"/claim-host",
		"application/json", bytes.NewReader(bb1))
	if err != nil {
		t.Fatalf("alice claim: %v", err)
	}
	defer r1.Body.Close()
	if r1.StatusCode != 200 {
		t.Fatalf("alice should win cold boot: status %d", r1.StatusCode)
	}
	var aResp claimHostRes
	json.NewDecoder(r1.Body).Decode(&aResp)
	if !aResp.Endorsed || aResp.HostID != a.ID {
		t.Fatalf("alice expected endorsed: %+v", aResp)
	}

	// Bob races with higher version — wins inside the grace window.
	bb2, _ := json.Marshal(map[string]any{
		"player_id": b.ID, "version": 9, "last_stroke_index": 1,
	})
	r2, err := http.Post(hs.URL+"/api/rooms/"+created.RoomID+"/claim-host",
		"application/json", bytes.NewReader(bb2))
	if err != nil {
		t.Fatalf("bob claim: %v", err)
	}
	defer r2.Body.Close()
	if r2.StatusCode != 200 {
		t.Fatalf("bob should beat alice on version: status %d", r2.StatusCode)
	}
	var bResp claimHostRes
	json.NewDecoder(r2.Body).Decode(&bResp)
	if !bResp.Endorsed || bResp.HostID != b.ID {
		t.Fatalf("bob expected endorsed: %+v", bResp)
	}

	// Alice retries with her stale tuple — rejected (409) and the
	// response surfaces the running-best (bob's tuple).
	r3, err := http.Post(hs.URL+"/api/rooms/"+created.RoomID+"/claim-host",
		"application/json", bytes.NewReader(bb1))
	if err != nil {
		t.Fatalf("alice retry: %v", err)
	}
	defer r3.Body.Close()
	if r3.StatusCode != http.StatusConflict {
		t.Fatalf("stale retry expected 409, got %d", r3.StatusCode)
	}
	var loser claimHostRes
	json.NewDecoder(r3.Body).Decode(&loser)
	if loser.Endorsed {
		t.Fatal("stale retry should not be endorsed")
	}
	if loser.HostID != b.ID || loser.Version != 9 || loser.LastStrokeIndex != 1 {
		t.Fatalf("expected best tuple (bob, 9, 1), got %+v", loser)
	}
}

// TestSignalingRelayForwards covers T9.1: a peer wraps a DC envelope
// in a RELAY frame; the server forwards it untouched to the To peer.
func TestSignalingRelayForwards(t *testing.T) {
	hs, s := newTestServer(t)

	resp, err := http.Post(hs.URL+"/api/rooms", "application/json",
		strings.NewReader(`{"player_name":"Host"}`))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	defer resp.Body.Close()
	var created createRoomRes
	json.NewDecoder(resp.Body).Decode(&created)

	guest, err := s.p2p.mgr.RegisterPlayer(created.RoomID, "Guest")
	if err != nil {
		t.Fatalf("register guest: %v", err)
	}

	hostConn := dialSignal(t, hs, created.RoomID, created.PlayerID)
	defer hostConn.Close()
	guestConn := dialSignal(t, hs, created.RoomID, guest.ID)
	defer guestConn.Close()

	// Guest sends a RELAY-wrapped CMD envelope addressed to the host.
	inner := json.RawMessage(`{"t":"CMD","seq":1,"cmd":{"type":"START_GAME","payload":{}}}`)
	relay := signal.Envelope{Type: signal.EnvRelay, To: created.PlayerID, Envelope: inner}
	if err := guestConn.WriteJSON(relay); err != nil {
		t.Fatalf("write relay: %v", err)
	}

	deadline := time.Now().Add(3 * time.Second)
	hostConn.SetReadDeadline(deadline)
	var got signal.Envelope
	for {
		if err := hostConn.ReadJSON(&got); err != nil {
			t.Fatalf("read on host: %v", err)
		}
		if got.Type == signal.EnvRelay {
			break
		}
	}
	if got.From != guest.ID {
		t.Fatalf("From not stamped: %q", got.From)
	}
	if string(got.Envelope) != string(inner) {
		t.Fatalf("envelope not forwarded verbatim:\n  want: %s\n  got:  %s", string(inner), string(got.Envelope))
	}
}

func dialSignal(t *testing.T, hs *httptest.Server, roomID, playerID string) *websocket.Conn {
	t.Helper()
	u, _ := url.Parse(hs.URL)
	wsURL := "ws://" + u.Host + "/api/signal?room=" + roomID + "&player=" + playerID
	c, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	return c
}

