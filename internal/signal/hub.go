package signal

import (
	"encoding/json"
	"log"

	"github.com/gorilla/websocket"
)

// Hub is the signaling fan-out for per-room WebRTC negotiation. It maps
// clients by (roomID, playerID) and routes envelopes either to one peer
// (Direct / RouteByPlayer) or to all peers in a room (BroadcastRoom).
//
// Unlike the legacy game hub, this one carries no game semantics.
type Hub struct {
	clients           map[*Client]bool
	clientsByPlayerID map[string]*Client
	clientsByRoom     map[string]map[*Client]bool

	Broadcast     chan []byte
	Inbound       chan Inbound
	Direct        chan DirectMessage
	BroadcastRoom chan RoomBroadcastMessage

	Register   chan *Client
	Unregister chan *Client
	BindPlayer chan *Client
	BindRoom   chan *Client

	CloseRoom chan string
}

// Inbound carries a raw frame received from a client. Hub callers
// (the room manager / http layer) decode the envelope to decide how
// to route. The hub itself stays dumb.
type Inbound struct {
	Client  *Client
	Message []byte
}

type RoomBroadcastMessage struct {
	RoomID  string
	Message []byte
}

type DirectMessage struct {
	PlayerID string
	Message  []byte
}

func NewHub() *Hub {
	return &Hub{
		Broadcast:         make(chan []byte, 16),
		Inbound:           make(chan Inbound, 64),
		Direct:            make(chan DirectMessage, 64),
		BroadcastRoom:     make(chan RoomBroadcastMessage, 64),
		CloseRoom:         make(chan string, 4),
		Register:          make(chan *Client, 4),
		Unregister:        make(chan *Client, 4),
		BindPlayer:        make(chan *Client, 4),
		BindRoom:          make(chan *Client, 4),
		clients:           make(map[*Client]bool),
		clientsByPlayerID: make(map[string]*Client),
		clientsByRoom:     make(map[string]map[*Client]bool),
	}
}

func (h *Hub) Run() {
	for {
		select {
		case client := <-h.Register:
			h.clients[client] = true

		case client := <-h.BindPlayer:
			if client.PlayerID != "" {
				h.clientsByPlayerID[client.PlayerID] = client
			}

		case client := <-h.BindRoom:
			if client.RoomID != "" {
				if _, ok := h.clientsByRoom[client.RoomID]; !ok {
					h.clientsByRoom[client.RoomID] = make(map[*Client]bool)
				}
				h.clientsByRoom[client.RoomID][client] = true
			}

		case client := <-h.Unregister:
			h.dropClient(client)

		case message := <-h.Broadcast:
			for client := range h.clients {
				h.trySend(client, message)
			}

		case dm := <-h.Direct:
			if client, ok := h.clientsByPlayerID[dm.PlayerID]; ok {
				h.trySend(client, dm.Message)
			}

		case rb := <-h.BroadcastRoom:
			if clientsInRoom, ok := h.clientsByRoom[rb.RoomID]; ok {
				for client := range clientsInRoom {
					h.trySend(client, rb.Message)
				}
			}

		case roomID := <-h.CloseRoom:
			if clientsInRoom, ok := h.clientsByRoom[roomID]; ok {
				log.Printf("signal: closing room %s (%d clients)", roomID, len(clientsInRoom))
				for client := range clientsInRoom {
					select {
					case client.send <- websocket.FormatCloseMessage(websocket.CloseNormalClosure, "room closed"):
					default:
					}
					close(client.send)
					delete(h.clients, client)
					if client.PlayerID != "" {
						delete(h.clientsByPlayerID, client.PlayerID)
					}
				}
				delete(h.clientsByRoom, roomID)
			}
		}
	}
}

// RouteByPlayer encodes the envelope and routes it to the named player
// inside the given room. Implemented in terms of the Direct channel so
// callers from goroutines outside the hub loop don't race the map.
//
// We don't actually enforce roomID at the hub level today — the player
// map is global. A future hardening pass can add a (room, player) tuple
// lookup; for now the server-side handler already validated that the
// sender is in the same room.
func (h *Hub) RouteByPlayer(_ string, toPlayerID string, env Envelope) error {
	b, err := json.Marshal(env)
	if err != nil {
		return err
	}
	h.Direct <- DirectMessage{PlayerID: toPlayerID, Message: b}
	return nil
}

func (h *Hub) trySend(client *Client, msg []byte) {
	select {
	case client.send <- msg:
	default:
		h.dropClient(client)
	}
}

func (h *Hub) dropClient(client *Client) {
	if _, ok := h.clients[client]; !ok {
		return
	}
	delete(h.clients, client)
	if client.PlayerID != "" {
		if h.clientsByPlayerID[client.PlayerID] == client {
			delete(h.clientsByPlayerID, client.PlayerID)
		}
	}
	if client.RoomID != "" && h.clientsByRoom[client.RoomID] != nil {
		delete(h.clientsByRoom[client.RoomID], client)
		if len(h.clientsByRoom[client.RoomID]) == 0 {
			delete(h.clientsByRoom, client.RoomID)
		}
	}
	// safe close — guard against double close
	defer func() { _ = recover() }()
	close(client.send)
}
