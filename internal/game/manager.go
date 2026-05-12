package game

import (
	"context"
	"encoding/json"
	"log"
	"time"
)

type GameManager struct {
	Hub      *Hub
	Storage  Storage
	Sessions map[string]*GameSession

	UnregisterSession chan string
	quit              chan struct{}
}

type Storage interface {
	SaveGameState(ctx context.Context, state *GameState) error
	LoadGameState(ctx context.Context, id string) (*GameState, error)
	DeleteGameState(ctx context.Context, id string) error
}

type ClientCommand struct {
	Client  *Client
	Message []byte
}

func NewGameManager(store Storage) *GameManager {
	return &GameManager{
		Hub:               NewHub(),
		Storage:           store,
		Sessions:          make(map[string]*GameSession),
		UnregisterSession: make(chan string),
		quit:              make(chan struct{}),
	}
}

func NewGameState() *GameState {
	return &GameState{
		Status:  StatusLobby,
		Players: make([]*Player, 0),
		Pool:    make([]WordCard, 0),
	}
}

func (gm *GameManager) Run() {
	go gm.Hub.Run()

	cleanupTicker := time.NewTicker(1 * time.Minute)
	defer cleanupTicker.Stop()

	for {
		select {
		case cmd := <-gm.Hub.Inbound:
			gm.routeCommand(cmd)

		case sessionID := <-gm.UnregisterSession:
			if session, ok := gm.Sessions[sessionID]; ok {
				log.Printf("Immediate Cleanup: Deleting session %s", sessionID)
				session.Stop()
				delete(gm.Sessions, sessionID)
			}

		case <-cleanupTicker.C:
			gm.cleanupSessions()

		case <-gm.quit:
			return
		}
	}
}

func (gm *GameManager) routeCommand(cmd ClientCommand) {
	roomID := cmd.Client.RoomID

	if roomID == "" {
		var msg IncomingMessage
		if err := json.Unmarshal(cmd.Message, &msg); err == nil {
			if msg.Type == CmdJoinGame {
				var payload JoinGamePayload
				b, _ := json.Marshal(msg.Payload)
				json.Unmarshal(b, &payload)
				roomID = payload.RoomCode
			}
		}
	}

	if roomID == "" {
		log.Println("Command rejected: No RoomID")
		return
	}

	session, exists := gm.Sessions[roomID]
	if !exists {
		log.Printf("Creating New Session: %s", roomID)
		session = NewGameSession(roomID, gm.Hub, gm.Storage, gm.UnregisterSession)
		gm.Sessions[roomID] = session
		go session.Run()
	}

	session.Inbound <- cmd
}

func (gm *GameManager) cleanupSessions() {
	for id, session := range gm.Sessions {
		if time.Since(session.LastActivity) > 10*time.Minute {
			log.Printf("Deleting inactive session: %s", id)
			session.Stop()
			delete(gm.Sessions, id)
			if err := gm.Storage.DeleteGameState(context.Background(), id); err != nil {
				log.Printf("Failed delete storage for session %s: %v", id, err)
			}
			continue
		}
		if session.State.Status == StatusGameOver && time.Since(session.LastActivity) > 1*time.Minute {
			log.Printf("Deleting finished session: %s", id)
			session.Stop()
			delete(gm.Sessions, id)
			if err := gm.Storage.DeleteGameState(context.Background(), id); err != nil {
				log.Printf("Failed delete storage for session %s: %v", id, err)
			}
		}
	}
}
