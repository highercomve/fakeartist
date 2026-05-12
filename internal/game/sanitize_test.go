package game

import (
	"encoding/json"
	"strings"
	"testing"
)

func newTestSession() *GameSession {
	gs := &GameSession{State: NewGameState()}
	gs.State.ID = "TEST"
	gs.State.Config = GameConfig{
		WordsPerPlayer:   3,
		TargetScore:      5,
		StrokesPerArtist: 2,
		MinPlayers:       4,
	}
	return gs
}

func addPlayer(gs *GameSession, id, name, color string) {
	gs.State.Players = append(gs.State.Players, &Player{
		ID: id, Name: name, Color: color, Connected: true,
	})
}

func TestSanitize_StripsPoolWords(t *testing.T) {
	gs := newTestSession()
	gs.State.Pool = []WordCard{
		{ID: "c1", Word: "SECRET_BANANA", AuthorID: "p1"},
		{ID: "c2", Word: "SECRET_APPLE", AuthorID: "p2"},
	}

	sanitized := gs.sanitize()
	b, _ := json.Marshal(sanitized)
	out := string(b)

	if strings.Contains(out, "SECRET_BANANA") || strings.Contains(out, "SECRET_APPLE") {
		t.Fatalf("pool words leaked into broadcast: %s", out)
	}
	if !strings.Contains(out, "\"id\":\"c1\"") || !strings.Contains(out, "\"id\":\"c2\"") {
		t.Fatalf("card IDs should be preserved: %s", out)
	}
}

func TestSanitize_HidesFakeAndCardBeforeSummary(t *testing.T) {
	gs := newTestSession()
	addPlayer(gs, "p1", "Alice", "#E53935")
	addPlayer(gs, "p2", "Bob", "#1E88E5")
	gs.State.Pool = []WordCard{{ID: "c1", Word: "BANANA", AuthorID: "p1"}}
	gs.State.CurrentRound = &Round{
		Index:     0,
		CardID:    "c1",
		FakeID:    "p1",
		TurnOrder: []string{"p1", "p2"},
		Votes:     map[string]string{"p1": "p2"},
		FakeGuess: "guess",
		Outcome:   OutcomeArtistsWon,
	}

	for _, status := range []GameStatus{
		StatusRoundAnnounce, StatusDrawing, StatusVoting, StatusFakeGuess,
	} {
		gs.State.Status = status
		sanitized := gs.sanitize()
		b, _ := json.Marshal(sanitized)
		out := string(b)

		if strings.Contains(out, "BANANA") {
			t.Errorf("[%s] revealed word leaked: %s", status, out)
		}
		if strings.Contains(out, "\"fake_id\":\"p1\"") {
			t.Errorf("[%s] fake_id leaked: %s", status, out)
		}
		if strings.Contains(out, "\"card_id\":\"c1\"") {
			t.Errorf("[%s] card_id leaked: %s", status, out)
		}
		if strings.Contains(out, "\"fake_guess\":\"guess\"") {
			t.Errorf("[%s] fake_guess leaked: %s", status, out)
		}
		// Votes map should not appear; only votes_cast count
		if strings.Contains(out, "\"votes\":{") {
			t.Errorf("[%s] votes map leaked: %s", status, out)
		}
	}
}

func TestSanitize_RevealsInSummary(t *testing.T) {
	gs := newTestSession()
	addPlayer(gs, "p1", "Alice", "#E53935")
	addPlayer(gs, "p2", "Bob", "#1E88E5")
	gs.State.Pool = []WordCard{{ID: "c1", Word: "BANANA", AuthorID: "p1", Used: true}}
	gs.State.CurrentRound = &Round{
		Index:        0,
		CardID:       "c1",
		FakeID:       "p1",
		TurnOrder:    []string{"p1", "p2"},
		Votes:        map[string]string{"p1": "p2", "p2": "p1"},
		FakeGuess:    "apple",
		Outcome:      OutcomeArtistsWon,
		RevealedWord: "BANANA",
	}
	gs.State.Status = StatusRoundSummary

	sanitized := gs.sanitize()
	b, _ := json.Marshal(sanitized)
	out := string(b)

	if !strings.Contains(out, "BANANA") {
		t.Errorf("revealed word missing in summary: %s", out)
	}
	if !strings.Contains(out, "\"fake_id\":\"p1\"") {
		t.Errorf("fake_id missing in summary: %s", out)
	}
	if !strings.Contains(out, "\"card_id\":\"c1\"") {
		t.Errorf("card_id missing in summary: %s", out)
	}
	if !strings.Contains(out, "\"outcome\":\"ARTISTS_WON\"") {
		t.Errorf("outcome missing in summary: %s", out)
	}

	// Pool word is still stripped even in summary (we expose via RevealedWord)
	pool := sanitized.Pool
	for _, c := range pool {
		if c.Word != "" {
			t.Errorf("pool[%s].Word should remain stripped: %s", c.ID, c.Word)
		}
	}
}

func TestTallyVotes_StrictMost(t *testing.T) {
	gs := newTestSession()
	addPlayer(gs, "p1", "A", "#1")
	addPlayer(gs, "p2", "B", "#2")
	addPlayer(gs, "p3", "C", "#3")
	addPlayer(gs, "p4", "D", "#4")
	gs.State.CurrentRound = &Round{
		TurnOrder: []string{"p1", "p2", "p3", "p4"},
		FakeID:    "p1",
		Votes: map[string]string{
			"p1": "p2",
			"p2": "p1",
			"p3": "p1",
			"p4": "p1",
		},
	}
	winner, caught := gs.tallyVotes()
	if winner != "p1" || !caught {
		t.Errorf("expected p1 caught, got winner=%s caught=%v", winner, caught)
	}
}

func TestTallyVotes_TieMeansNotCaught(t *testing.T) {
	gs := newTestSession()
	addPlayer(gs, "p1", "A", "#1")
	addPlayer(gs, "p2", "B", "#2")
	addPlayer(gs, "p3", "C", "#3")
	addPlayer(gs, "p4", "D", "#4")
	gs.State.CurrentRound = &Round{
		TurnOrder: []string{"p1", "p2", "p3", "p4"},
		FakeID:    "p1",
		Votes: map[string]string{
			"p1": "p2",
			"p2": "p1",
			"p3": "p2",
			"p4": "p1",
		},
	}
	_, caught := gs.tallyVotes()
	if caught {
		t.Errorf("tie should not catch fake")
	}
}
