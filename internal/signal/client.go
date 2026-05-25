package signal

import (
	"log"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = (pongWait * 9) / 10
	maxMessageSize = 8 * 1024 // SDP frames are larger than legacy game commands
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin: func(r *http.Request) bool {
		return true // party game on LAN; revisit when we ship
	},
}

// Client is the per-WS goroutine bridge. PlayerID and RoomID are set
// by the HTTP handler before Register/BindPlayer/BindRoom are pushed
// to the hub.
type Client struct {
	hub  *Hub
	conn *websocket.Conn
	send chan []byte

	PlayerID string
	RoomID   string
}

func (c *Client) readPump() {
	defer func() {
		c.hub.Unregister <- c
		c.conn.Close()
	}()
	c.conn.SetReadLimit(maxMessageSize)
	c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})
	for {
		_, message, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("signal: read error: %v", err)
			}
			break
		}
		c.hub.Inbound <- Inbound{Client: c, Message: message}
	}
}

func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()
	for {
		select {
		case message, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			w, err := c.conn.NextWriter(websocket.TextMessage)
			if err != nil {
				return
			}
			w.Write(message)
			if err := w.Close(); err != nil {
				return
			}
		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// ServeWs upgrades the HTTP connection and starts the pumps. The caller
// must have already validated room/player IDs and set them on the client
// before this returns (we do that by constructing the Client before
// upgrading, then handing it back to the handler).
func ServeWs(hub *Hub, w http.ResponseWriter, r *http.Request, playerID, roomID string) (*Client, error) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return nil, err
	}
	client := &Client{
		hub:      hub,
		conn:     conn,
		send:     make(chan []byte, 64),
		PlayerID: playerID,
		RoomID:   roomID,
	}
	hub.Register <- client
	hub.BindPlayer <- client
	hub.BindRoom <- client
	go client.writePump()
	go client.readPump()
	return client, nil
}
