package game

import (
	"log"

	"github.com/gorilla/websocket"
)

// Hub maintains the set of active clients and broadcasts messages to the
// clients.
type Hub struct {
	// Registered clients.
	clients map[*Client]bool

	// Map PlayerID -> Client for Unicast
	clientsByPlayerID map[string]*Client

	// Map RoomID -> Set of Clients
	clientsByRoom map[string]map[*Client]bool

	// Inbound messages from the clients.
	Broadcast chan []byte
	Inbound   chan ClientCommand

	// Register requests from the clients.
	Register chan *Client

	// Unregister requests from clients.
	Unregister chan *Client

	// Broadcast to Room
	BroadcastRoom chan RoomBroadcastMessage

	// Direct Message channel
	Direct chan DirectMessage

	// Bind requests (Associate Client with PlayerID)
	BindPlayer chan *Client
	BindRoom   chan *Client

	// Room Control
	CloseRoom chan string
}

type RoomBroadcastMessage struct {
	RoomID  string
	Message []byte
}

func NewHub() *Hub {
	return &Hub{
		Broadcast:         make(chan []byte),
		Inbound:           make(chan ClientCommand),
		Direct:            make(chan DirectMessage),
		BroadcastRoom:     make(chan RoomBroadcastMessage),
		CloseRoom:         make(chan string),
		Register:          make(chan *Client),
		Unregister:        make(chan *Client),
		BindPlayer:        make(chan *Client),
		BindRoom:          make(chan *Client),
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
			log.Println("New Client Registered")

		case client := <-h.BindPlayer:
			if client.PlayerID != "" {
				h.clientsByPlayerID[client.PlayerID] = client
				log.Printf("Bound Client to PlayerID: %s", client.PlayerID)
			}

		case client := <-h.BindRoom:
			if client.RoomID != "" {
				if _, ok := h.clientsByRoom[client.RoomID]; !ok {
					h.clientsByRoom[client.RoomID] = make(map[*Client]bool)
				}
				h.clientsByRoom[client.RoomID][client] = true
				log.Printf("Bound Client to Room: %s", client.RoomID)
			}

		case client := <-h.Unregister:
			if _, ok := h.clients[client]; ok {
				delete(h.clients, client)
				if client.PlayerID != "" {
					delete(h.clientsByPlayerID, client.PlayerID)
				}
				// Remove from Room
				if client.RoomID != "" && h.clientsByRoom[client.RoomID] != nil {
					delete(h.clientsByRoom[client.RoomID], client)
					if len(h.clientsByRoom[client.RoomID]) == 0 {
						delete(h.clientsByRoom, client.RoomID)
					}
				}
				close(client.send)
				log.Println("Client Unregistered")
			}

		// Global Broadcast (Keep for system messages if any)
		case message := <-h.Broadcast:
			for client := range h.clients {
				select {
				case client.send <- message:
				default:
					close(client.send)
					delete(h.clients, client)
					if client.PlayerID != "" {
						delete(h.clientsByPlayerID, client.PlayerID)
					}
					if client.RoomID != "" && h.clientsByRoom[client.RoomID] != nil {
						delete(h.clientsByRoom[client.RoomID], client)
						if len(h.clientsByRoom[client.RoomID]) == 0 {
							delete(h.clientsByRoom, client.RoomID)
						}
					}
				}
			}

		case dm := <-h.Direct:
			if client, ok := h.clientsByPlayerID[dm.PlayerID]; ok {
				select {
				case client.send <- dm.Message:
				default:
					close(client.send)
					delete(h.clients, client)
					delete(h.clientsByPlayerID, dm.PlayerID)
					if client.RoomID != "" && h.clientsByRoom[client.RoomID] != nil {
						delete(h.clientsByRoom[client.RoomID], client)
						if len(h.clientsByRoom[client.RoomID]) == 0 {
							delete(h.clientsByRoom, client.RoomID)
						}
					}
				}
			}

		case rb := <-h.BroadcastRoom:
			if clientsInRoom, ok := h.clientsByRoom[rb.RoomID]; ok {
				for client := range clientsInRoom {
					select {
					case client.send <- rb.Message:
					default:
						close(client.send)
						delete(h.clients, client)
						if client.PlayerID != "" {
							delete(h.clientsByPlayerID, client.PlayerID)
						}
						delete(clientsInRoom, client) // Remove from this room's map
						if len(clientsInRoom) == 0 {
							delete(h.clientsByRoom, rb.RoomID) // Delete room if empty
						}
					}
				}
			}

		case roomID := <-h.CloseRoom:
			if clientsInRoom, ok := h.clientsByRoom[roomID]; ok {
				log.Printf("Closing Room: %s (Disconnecting %d clients)", roomID, len(clientsInRoom))
				for client := range clientsInRoom {
					select {
					case client.send <- websocket.FormatCloseMessage(websocket.CloseNormalClosure, "Game Ended"):
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

type DirectMessage struct {
	PlayerID string
	Message  []byte
}
