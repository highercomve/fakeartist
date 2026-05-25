package rooms

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

func TestDrawHostOnly(t *testing.T) {
	mgr := NewManager(newMemStore())
	room, host, _ := mgr.CreateRoom("Host")

	pool := []PoolEntry{{ID: "c1", Word: "tractor", AuthorID: host.ID}}
	_, err := mgr.Draw(room.ID, "not-host", 0, []string{host.ID}, pool)
	if err == nil {
		t.Fatal("expected ErrNotHost")
	}
	if err.Error() != ErrNotHost.Error() {
		t.Fatalf("unexpected err: %v", err)
	}
}

func TestDrawHappyPath(t *testing.T) {
	mgr := NewManager(newMemStore())
	room, host, _ := mgr.CreateRoom("Host")
	guest, _ := mgr.RegisterPlayer(room.ID, "Guest")

	pool := []PoolEntry{
		{ID: "c1", Word: "tractor", AuthorID: host.ID},
		{ID: "c2", Word: "banana", AuthorID: guest.ID},
	}
	res, err := mgr.Draw(room.ID, host.ID, 0, []string{host.ID, guest.ID}, pool)
	if err != nil {
		t.Fatalf("draw: %v", err)
	}
	if res.CardID != "c1" && res.CardID != "c2" {
		t.Fatalf("unexpected card: %s", res.CardID)
	}
	if len(res.Assignments) != 2 {
		t.Fatalf("assignments: %d", len(res.Assignments))
	}
	fakes := 0
	for _, a := range res.Assignments {
		if a.IsFake {
			fakes++
		} else if a.Word == "" {
			t.Fatal("non-fake missing word")
		}
	}
	if fakes != 1 {
		t.Fatalf("expected 1 fake, got %d", fakes)
	}
	if len(res.FakeIDCommitment) != 64 {
		t.Fatalf("bad commitment: %q", res.FakeIDCommitment)
	}
}

func TestRevealVerifiesCommitment(t *testing.T) {
	mgr := NewManager(newMemStore())
	room, host, _ := mgr.CreateRoom("Host")
	pool := []PoolEntry{{ID: "c1", Word: "frog", AuthorID: host.ID}}
	res, err := mgr.Draw(room.ID, host.ID, 0, []string{host.ID}, pool)
	if err != nil {
		t.Fatalf("draw: %v", err)
	}
	rev, err := mgr.Reveal(room.ID, 0)
	if err != nil {
		t.Fatalf("reveal: %v", err)
	}
	if rev.FakeID != host.ID {
		t.Fatalf("fake should be host (only player): %s", rev.FakeID)
	}
	nonce, err := hex.DecodeString(rev.Nonce)
	if err != nil {
		t.Fatalf("nonce hex: %v", err)
	}
	sum := sha256.Sum256(append([]byte(rev.FakeID), nonce...))
	if hex.EncodeToString(sum[:]) != res.FakeIDCommitment {
		t.Fatal("commitment does not match")
	}
}

func TestDrawPoolExhaustion(t *testing.T) {
	mgr := NewManager(newMemStore())
	room, host, _ := mgr.CreateRoom("Host")
	pool := []PoolEntry{{ID: "c1", Word: "x", AuthorID: host.ID}}
	if _, err := mgr.Draw(room.ID, host.ID, 0, []string{host.ID}, pool); err != nil {
		t.Fatalf("draw 1: %v", err)
	}
	if _, err := mgr.Draw(room.ID, host.ID, 1, []string{host.ID}, nil); err != ErrPoolExhausted {
		t.Fatalf("expected ErrPoolExhausted, got %v", err)
	}
}

func TestClaimHostEndorses(t *testing.T) {
	mgr := NewManager(newMemStore())
	room, host, _ := mgr.CreateRoom("Host")

	// claimant matches existing host — endorsed.
	got, _, _, endorsed, err := mgr.ClaimHost(room.ID, host.ID, 0, 0)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !endorsed || got != host.ID {
		t.Fatalf("self-claim should endorse: %s, %v", got, endorsed)
	}

	// different claimant when host still set — not endorsed.
	other, _ := mgr.RegisterPlayer(room.ID, "Other")
	got, _, _, endorsed, _ = mgr.ClaimHost(room.ID, other.ID, 0, 0)
	if endorsed {
		t.Fatalf("non-self claim should not endorse with host present")
	}
	if got != host.ID {
		t.Fatalf("host id should remain: %s", got)
	}

	// vacate host slot then claim.
	room.HostID = ""
	room.LastClaim = nil
	got, _, _, endorsed, _ = mgr.ClaimHost(room.ID, other.ID, 0, 0)
	if !endorsed || got != other.ID {
		t.Fatalf("cold-boot claim should endorse: %s, %v", got, endorsed)
	}
}

// TestClaimHostArbitratesDoubleClaim verifies the §7 racing-claim
// resolution: two simultaneous claims after host death; only the
// higher tuple wins, and a re-claim by the loser fails.
func TestClaimHostArbitratesDoubleClaim(t *testing.T) {
	mgr := NewManager(newMemStore())
	room, _, _ := mgr.CreateRoom("Host")
	// Host has died: vacate the slot.
	room.HostID = ""
	room.LastClaim = nil

	a, _ := mgr.RegisterPlayer(room.ID, "Alice")
	b, _ := mgr.RegisterPlayer(room.ID, "Bob")

	// Alice claims first with (version=5, idx=3).
	hostID, _, _, endorsed, _ := mgr.ClaimHost(room.ID, a.ID, 5, 3)
	if !endorsed || hostID != a.ID {
		t.Fatalf("alice should win cold-boot: host=%s endorsed=%v", hostID, endorsed)
	}

	// Bob races within the grace window with a higher version. Bob
	// wins; alice gets demoted.
	hostID, ver, idx, endorsed, _ := mgr.ClaimHost(room.ID, b.ID, 7, 1)
	if !endorsed || hostID != b.ID {
		t.Fatalf("bob (higher version) should beat alice: host=%s endorsed=%v", hostID, endorsed)
	}
	if ver != 7 || idx != 1 {
		t.Fatalf("expected (7,1), got (%d,%d)", ver, idx)
	}

	// Alice re-claims with her stale tuple — rejected, current best returned.
	hostID, ver, idx, endorsed, _ = mgr.ClaimHost(room.ID, a.ID, 5, 3)
	if endorsed {
		t.Fatal("stale re-claim should be rejected")
	}
	if hostID != b.ID {
		t.Fatalf("host should remain bob: %s", hostID)
	}
	if ver != 7 || idx != 1 {
		t.Fatalf("loser response should expose best tuple (7,1), got (%d,%d)", ver, idx)
	}
}

// TestClaimHostTieBreakByPlayerID covers the tuple-tie tiebreak:
// equal (version, idx) -> lowest player_id wins.
func TestClaimHostTieBreakByPlayerID(t *testing.T) {
	mgr := NewManager(newMemStore())
	room, _, _ := mgr.CreateRoom("Host")
	room.HostID = ""
	room.LastClaim = nil

	// craft two stubs with deterministic ids (host id minting uses
	// timestamp+rand, so we override directly).
	hi := &PlayerStub{ID: "p_z", Name: "Zoe"}
	lo := &PlayerStub{ID: "p_a", Name: "Ann"}
	room.Players = append(room.Players, hi, lo)

	// Zoe claims first.
	if _, _, _, ok, _ := mgr.ClaimHost(room.ID, hi.ID, 4, 4); !ok {
		t.Fatal("zoe initial claim should pass cold-boot")
	}
	// Ann races with the same tuple — lower id should win.
	host, _, _, ok, _ := mgr.ClaimHost(room.ID, lo.ID, 4, 4)
	if !ok || host != lo.ID {
		t.Fatalf("p_a should win tuple tie over p_z: host=%s ok=%v", host, ok)
	}
}
