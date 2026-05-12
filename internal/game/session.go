package game

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math/rand"
	"strings"
	"time"
)

type GameSession struct {
	ID           string
	Hub          *Hub
	State        *GameState
	Storage      Storage
	LastActivity time.Time

	Unregister chan<- string
	Inbound    chan ClientCommand

	rng  *rand.Rand
	quit chan struct{}
}

func NewGameSession(id string, hub *Hub, store Storage, unregister chan<- string) *GameSession {
	gs := &GameSession{
		ID:           id,
		Hub:          hub,
		State:        NewGameState(),
		Storage:      store,
		Unregister:   unregister,
		Inbound:      make(chan ClientCommand),
		quit:         make(chan struct{}),
		LastActivity: time.Now(),
		rng:          rand.New(rand.NewSource(time.Now().UnixNano())),
	}
	gs.State.ID = id
	gs.State.Config = GameConfig{
		WordsPerPlayer:   3,
		TargetScore:      5,
		StrokesPerArtist: 2,
		MinPlayers:       4,
		TurnDuration:     0,
	}
	return gs
}

func (gs *GameSession) Run() {
	for {
		select {
		case cmd := <-gs.Inbound:
			gs.LastActivity = time.Now()
			gs.handleCommand(cmd)
		case <-gs.quit:
			return
		}
	}
}

func (gs *GameSession) Stop() { close(gs.quit) }

// ---------- helpers ----------

func (gs *GameSession) findPlayer(id string) *Player {
	for _, p := range gs.State.Players {
		if p.ID == id {
			return p
		}
	}
	return nil
}

func (gs *GameSession) usedColors() map[string]bool {
	used := make(map[string]bool, len(gs.State.Players))
	for _, p := range gs.State.Players {
		if p.Color != "" {
			used[p.Color] = true
		}
	}
	return used
}

func (gs *GameSession) pickColor() string {
	used := gs.usedColors()
	available := make([]string, 0, len(ColorPalette))
	for _, c := range ColorPalette {
		if !used[c] {
			available = append(available, c)
		}
	}
	if len(available) == 0 {
		// fallback: random hue (>10 players unlikely)
		return fmt.Sprintf("#%06X", gs.rng.Intn(0xFFFFFF))
	}
	return available[gs.rng.Intn(len(available))]
}

func (gs *GameSession) sendError(client *Client, msg string) {
	out := OutgoingMessage{Type: MsgError, Payload: ErrorPayload{Message: msg}}
	b, _ := json.Marshal(out)
	select {
	case client.send <- b:
	default:
	}
}

func (gs *GameSession) sendDirect(playerID string, msg OutgoingMessage) {
	b, _ := json.Marshal(msg)
	gs.Hub.Direct <- DirectMessage{PlayerID: playerID, Message: b}
}

// ---------- broadcast / sanitize ----------

func (gs *GameSession) sanitize() GameState {
	st := *gs.State

	// Pool: always strip Word
	stripped := make([]WordCard, len(st.Pool))
	for i, c := range st.Pool {
		c.Word = ""
		stripped[i] = c
	}
	st.Pool = stripped
	st.PoolSize = len(stripped)

	// Round: redact secret fields except in ROUND_SUMMARY / GAME_OVER
	if st.CurrentRound != nil {
		rcopy := *st.CurrentRound
		// copy strokes slice header is fine (immutable to outsiders)
		if st.Status != StatusRoundSummary && st.Status != StatusGameOver {
			rcopy.CardID = ""
			rcopy.FakeID = ""
			rcopy.RevealedWord = ""
			rcopy.FakeGuess = ""
			rcopy.Votes = nil
			rcopy.Outcome = OutcomePending
		}
		st.CurrentRound = &rcopy
	}

	return st
}

func (gs *GameSession) broadcastState() {
	if gs.Storage != nil && gs.State.ID != "" {
		go func(s GameState) {
			gs.Storage.SaveGameState(context.TODO(), &s)
		}(*gs.State)
	}

	sanitized := gs.sanitize()
	msg := OutgoingMessage{Type: MsgStateUpdate, Payload: sanitized}
	b, _ := json.Marshal(msg)
	gs.Hub.BroadcastRoom <- RoomBroadcastMessage{RoomID: gs.ID, Message: b}
}

func (gs *GameSession) broadcastStroke(stroke Stroke) {
	msg := OutgoingMessage{
		Type: MsgStrokeAdded,
		Payload: StrokeAddedPayload{
			Stroke:      stroke,
			StrokeIndex: gs.State.CurrentRound.StrokeIndex,
		},
	}
	b, _ := json.Marshal(msg)
	gs.Hub.BroadcastRoom <- RoomBroadcastMessage{RoomID: gs.ID, Message: b}
}

// ---------- round lifecycle ----------

func (gs *GameSession) hasFreshCard() bool {
	for _, c := range gs.State.Pool {
		if !c.Used {
			return true
		}
	}
	return false
}

func (gs *GameSession) prepareRound() bool {
	if len(gs.State.Players) < gs.State.Config.MinPlayers {
		return false
	}
	if !gs.hasFreshCard() {
		gs.State.Status = StatusGameOver
		gs.assignWinner()
		return false
	}

	// pick fresh card
	available := make([]int, 0, len(gs.State.Pool))
	for i, c := range gs.State.Pool {
		if !c.Used {
			available = append(available, i)
		}
	}
	cardIdx := available[gs.rng.Intn(len(available))]
	gs.State.Pool[cardIdx].Used = true
	cardID := gs.State.Pool[cardIdx].ID
	word := gs.State.Pool[cardIdx].Word

	// turn order: shuffle player IDs
	turnOrder := make([]string, len(gs.State.Players))
	for i, p := range gs.State.Players {
		turnOrder[i] = p.ID
	}
	gs.rng.Shuffle(len(turnOrder), func(i, j int) {
		turnOrder[i], turnOrder[j] = turnOrder[j], turnOrder[i]
	})

	// pick fake
	fakeIdx := gs.rng.Intn(len(turnOrder))
	fakeID := turnOrder[fakeIdx]

	roundIdx := 0
	if gs.State.CurrentRound != nil {
		roundIdx = gs.State.CurrentRound.Index + 1
	}

	gs.State.CurrentRound = &Round{
		Index:       roundIdx,
		CardID:      cardID,
		FakeID:      fakeID,
		TurnOrder:   turnOrder,
		StrokeIndex: 0,
		Strokes:     make([]Stroke, 0),
		Votes:       make(map[string]string),
	}
	gs.State.Status = StatusRoundAnnounce

	// DM roles
	for _, pid := range turnOrder {
		isFake := pid == fakeID
		payload := YourRolePayload{IsFake: isFake}
		if !isFake {
			payload.Word = word
		}
		gs.sendDirect(pid, OutgoingMessage{Type: MsgYourRole, Payload: payload})
	}
	return true
}

func (gs *GameSession) beginDrawing() {
	if gs.State.Status != StatusRoundAnnounce {
		return
	}
	gs.State.Status = StatusDrawing
}

func (gs *GameSession) totalStrokesNeeded() int {
	return gs.State.Config.StrokesPerArtist * len(gs.State.CurrentRound.TurnOrder)
}

func (gs *GameSession) currentTurnPlayerID() string {
	r := gs.State.CurrentRound
	if r == nil || len(r.TurnOrder) == 0 {
		return ""
	}
	return r.TurnOrder[r.StrokeIndex%len(r.TurnOrder)]
}

func (gs *GameSession) cardWordByID(id string) string {
	for _, c := range gs.State.Pool {
		if c.ID == id {
			return c.Word
		}
	}
	return ""
}

func (gs *GameSession) tallyVotes() (winnerID string, caught bool) {
	r := gs.State.CurrentRound
	counts := make(map[string]int)
	for _, suspect := range r.Votes {
		counts[suspect]++
	}
	max := 0
	tied := false
	for id, n := range counts {
		if n > max {
			max = n
			winnerID = id
			tied = false
		} else if n == max {
			tied = true
		}
	}
	if tied {
		return "", false
	}
	caught = winnerID == r.FakeID
	return winnerID, caught
}

func (gs *GameSession) finalizeRound(fakeCaught, fakeGuessedRight bool) {
	r := gs.State.CurrentRound
	r.RevealedWord = gs.cardWordByID(r.CardID)

	if fakeCaught && fakeGuessedRight {
		r.Outcome = OutcomeFakeWon
		gs.addScore(r.FakeID, 2)
	} else if fakeCaught && !fakeGuessedRight {
		r.Outcome = OutcomeArtistsWon
		for _, pid := range r.TurnOrder {
			if pid != r.FakeID {
				gs.addScore(pid, 1)
			}
		}
	} else {
		// not caught
		r.Outcome = OutcomeFakeWon
		gs.addScore(r.FakeID, 1)
	}
	gs.State.Status = StatusRoundSummary
}

func (gs *GameSession) addScore(playerID string, n int) {
	if p := gs.findPlayer(playerID); p != nil {
		p.Score += n
	}
}

func (gs *GameSession) assignWinner() {
	var best *Player
	for _, p := range gs.State.Players {
		if best == nil || p.Score > best.Score {
			best = p
		}
	}
	gs.State.Winner = best
}

func (gs *GameSession) checkGameOver() bool {
	for _, p := range gs.State.Players {
		if p.Score >= gs.State.Config.TargetScore {
			gs.State.Status = StatusGameOver
			gs.assignWinner()
			return true
		}
	}
	if !gs.hasFreshCard() {
		gs.State.Status = StatusGameOver
		gs.assignWinner()
		return true
	}
	return false
}

// ---------- command handling ----------

func (gs *GameSession) handleCommand(cmd ClientCommand) {
	var msg IncomingMessage
	if err := json.Unmarshal(cmd.Message, &msg); err != nil {
		log.Printf("Invalid JSON: %v", err)
		return
	}

	log.Printf("[%s] cmd=%s from=%s", gs.ID, msg.Type, cmd.Client.PlayerID)

	switch msg.Type {
	case CmdJoinGame:
		gs.handleJoin(cmd, msg)
	case CmdConfigureGame:
		gs.handleConfigure(cmd, msg)
	case CmdSubmitWords:
		gs.handleSubmitWords(cmd, msg)
	case CmdStartGame:
		gs.handleStartGame(cmd)
	case CmdStartRound:
		gs.handleStartRound(cmd)
	case CmdSubmitStroke:
		gs.handleSubmitStroke(cmd, msg)
	case CmdCastVote:
		gs.handleCastVote(cmd, msg)
	case CmdSubmitFakeGuess:
		gs.handleFakeGuess(cmd, msg)
	case CmdNextRound:
		gs.handleNextRound(cmd)
	case CmdEndGame:
		gs.handleEndGame(cmd)
	}
}

func (gs *GameSession) handleJoin(cmd ClientCommand, msg IncomingMessage) {
	var payload JoinGamePayload
	b, _ := json.Marshal(msg.Payload)
	json.Unmarshal(b, &payload)

	var player *Player

	if payload.ID != "" {
		player = gs.findPlayer(payload.ID)
		if player != nil {
			player.Connected = true
			if payload.PlayerName != "" {
				player.Name = payload.PlayerName
			}
		}
	}

	if player == nil {
		if gs.State.Status != StatusLobby && gs.State.Status != StatusWriting {
			gs.sendError(cmd.Client, "Game already in progress")
			return
		}
		newID := payload.ID
		if newID == "" {
			newID = "player-" + time.Now().Format("150405.000000")
		}
		player = &Player{
			ID:        newID,
			Name:      payload.PlayerName,
			Connected: true,
			Color:     gs.pickColor(),
		}
		gs.State.Players = append(gs.State.Players, player)
		if len(gs.State.Players) == 1 {
			player.IsAdmin = true
			gs.State.HostID = player.ID
		}
	}

	cmd.Client.PlayerID = player.ID
	cmd.Client.RoomID = gs.ID
	gs.Hub.BindPlayer <- cmd.Client
	gs.Hub.BindRoom <- cmd.Client

	welcome := OutgoingMessage{Type: MsgPlayerWelcome, Payload: PlayerWelcomePayload{ID: player.ID}}
	wb, _ := json.Marshal(welcome)
	cmd.Client.send <- wb

	gs.broadcastState()

	// If round is active and this player is part of it, resend role
	if r := gs.State.CurrentRound; r != nil &&
		(gs.State.Status == StatusRoundAnnounce ||
			gs.State.Status == StatusDrawing ||
			gs.State.Status == StatusVoting ||
			gs.State.Status == StatusFakeGuess) {
		for _, pid := range r.TurnOrder {
			if pid == player.ID {
				isFake := pid == r.FakeID
				p := YourRolePayload{IsFake: isFake}
				if !isFake {
					p.Word = gs.cardWordByID(r.CardID)
				}
				gs.sendDirect(pid, OutgoingMessage{Type: MsgYourRole, Payload: p})
				break
			}
		}
	}
}

func (gs *GameSession) requireHost(cmd ClientCommand) bool {
	return cmd.Client.PlayerID == gs.State.HostID
}

func (gs *GameSession) handleConfigure(cmd ClientCommand, msg IncomingMessage) {
	if !gs.requireHost(cmd) || gs.State.Status != StatusLobby {
		return
	}
	var p GameConfigPayload
	b, _ := json.Marshal(msg.Payload)
	json.Unmarshal(b, &p)
	if p.WordsPerPlayer > 0 {
		gs.State.Config.WordsPerPlayer = p.WordsPerPlayer
	}
	if p.TargetScore > 0 {
		gs.State.Config.TargetScore = p.TargetScore
	}
	if p.StrokesPerArtist > 0 {
		gs.State.Config.StrokesPerArtist = p.StrokesPerArtist
	}
	if p.MinPlayers > 0 {
		gs.State.Config.MinPlayers = p.MinPlayers
	}
	if p.TurnDuration >= 0 {
		gs.State.Config.TurnDuration = p.TurnDuration
	}
	gs.broadcastState()
}

func (gs *GameSession) handleSubmitWords(cmd ClientCommand, msg IncomingMessage) {
	if gs.State.Status != StatusWriting {
		return
	}
	var p SubmitWordsPayload
	b, _ := json.Marshal(msg.Payload)
	json.Unmarshal(b, &p)

	player := gs.findPlayer(cmd.Client.PlayerID)
	if player == nil || player.HasSubmitted {
		return
	}
	for _, w := range p.Words {
		w = strings.TrimSpace(w)
		if w == "" {
			continue
		}
		gs.State.Pool = append(gs.State.Pool, WordCard{
			ID:       fmt.Sprintf("card-%d-%d", time.Now().UnixNano(), gs.rng.Int63()),
			Word:     w,
			AuthorID: player.ID,
		})
	}
	player.HasSubmitted = true
	gs.broadcastState()
}

func (gs *GameSession) allSubmitted() bool {
	for _, p := range gs.State.Players {
		if !p.HasSubmitted {
			return false
		}
	}
	return true
}

func (gs *GameSession) handleStartGame(cmd ClientCommand) {
	if !gs.requireHost(cmd) {
		return
	}
	if gs.State.Status == StatusLobby {
		if len(gs.State.Players) < gs.State.Config.MinPlayers {
			gs.sendError(cmd.Client, fmt.Sprintf("Need at least %d players", gs.State.Config.MinPlayers))
			return
		}
		gs.State.Status = StatusWriting
		gs.broadcastState()
	}
}

func (gs *GameSession) handleStartRound(cmd ClientCommand) {
	if !gs.requireHost(cmd) {
		return
	}
	switch gs.State.Status {
	case StatusWriting:
		if !gs.allSubmitted() {
			gs.sendError(cmd.Client, "Waiting for all players to submit words")
			return
		}
		if !gs.prepareRound() {
			gs.sendError(cmd.Client, "Cannot start round")
			return
		}
		gs.broadcastState()
	case StatusRoundAnnounce:
		gs.beginDrawing()
		gs.broadcastState()
	}
}

func (gs *GameSession) handleSubmitStroke(cmd ClientCommand, msg IncomingMessage) {
	if gs.State.Status != StatusDrawing {
		return
	}
	r := gs.State.CurrentRound
	if r == nil {
		return
	}
	if cmd.Client.PlayerID != gs.currentTurnPlayerID() {
		gs.sendError(cmd.Client, "Not your turn")
		return
	}
	var p SubmitStrokePayload
	b, _ := json.Marshal(msg.Payload)
	json.Unmarshal(b, &p)
	if len(p.Points) < 2 {
		return
	}

	player := gs.findPlayer(cmd.Client.PlayerID)
	if player == nil {
		return
	}
	stroke := Stroke{
		PlayerID: player.ID,
		Color:    player.Color,
		Points:   p.Points,
	}
	r.Strokes = append(r.Strokes, stroke)
	r.StrokeIndex++

	gs.broadcastStroke(stroke)

	if r.StrokeIndex >= gs.totalStrokesNeeded() {
		gs.State.Status = StatusVoting
	}
	gs.broadcastState()
}

func (gs *GameSession) handleCastVote(cmd ClientCommand, msg IncomingMessage) {
	if gs.State.Status != StatusVoting {
		return
	}
	r := gs.State.CurrentRound
	if r == nil {
		return
	}
	// voter must be in round
	voterID := cmd.Client.PlayerID
	inRound := false
	for _, pid := range r.TurnOrder {
		if pid == voterID {
			inRound = true
			break
		}
	}
	if !inRound {
		return
	}

	var p CastVotePayload
	b, _ := json.Marshal(msg.Payload)
	json.Unmarshal(b, &p)

	// suspect must be in round
	suspectValid := false
	for _, pid := range r.TurnOrder {
		if pid == p.SuspectID {
			suspectValid = true
			break
		}
	}
	if !suspectValid {
		return
	}

	r.Votes[voterID] = p.SuspectID
	r.VotesCast = len(r.Votes)

	if r.VotesCast >= len(r.TurnOrder) {
		_, caught := gs.tallyVotes()
		if caught {
			gs.State.Status = StatusFakeGuess
		} else {
			gs.finalizeRound(false, false)
		}
	}
	gs.broadcastState()
}

func (gs *GameSession) handleFakeGuess(cmd ClientCommand, msg IncomingMessage) {
	if gs.State.Status != StatusFakeGuess {
		return
	}
	r := gs.State.CurrentRound
	if r == nil || cmd.Client.PlayerID != r.FakeID {
		return
	}
	var p SubmitFakeGuessPayload
	b, _ := json.Marshal(msg.Payload)
	json.Unmarshal(b, &p)

	guess := strings.TrimSpace(strings.ToLower(p.Guess))
	actual := strings.TrimSpace(strings.ToLower(gs.cardWordByID(r.CardID)))
	r.FakeGuess = p.Guess

	gs.finalizeRound(true, guess != "" && guess == actual)
	gs.broadcastState()
}

func (gs *GameSession) handleNextRound(cmd ClientCommand) {
	if !gs.requireHost(cmd) {
		return
	}
	if gs.State.Status != StatusRoundSummary {
		return
	}
	if gs.checkGameOver() {
		gs.broadcastState()
		return
	}
	if !gs.prepareRound() {
		gs.broadcastState()
		return
	}
	gs.broadcastState()
}

func (gs *GameSession) handleEndGame(cmd ClientCommand) {
	if !gs.requireHost(cmd) {
		return
	}
	gs.State.Status = StatusGameOver
	gs.assignWinner()
	gs.broadcastState()

	go func() {
		time.Sleep(100 * time.Millisecond)
		gs.Hub.CloseRoom <- gs.ID
		gs.Unregister <- gs.ID
	}()
}
