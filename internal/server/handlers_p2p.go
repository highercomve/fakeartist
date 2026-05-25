package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/labstack/echo/v4"

	"github.com/sergiom/fakeartist/internal/rooms"
	"github.com/sergiom/fakeartist/internal/signal"
)

// p2pDeps bundles the long-lived state the P2P handlers need. We keep
// it private to the server package to avoid leaking the signaling hub
// into other modules.
type p2pDeps struct {
	hub  *signal.Hub
	mgr  *rooms.Manager
}

// createRoomReq is the body of POST /api/rooms.
type createRoomReq struct {
	PlayerName string `json:"player_name"`
}

type createRoomRes struct {
	RoomCode string `json:"room_code"`
	RoomID   string `json:"room_id"`
	PlayerID string `json:"player_id"`
	IsHost   bool   `json:"is_host"`
}

func (s *Server) handleCreateRoom(c echo.Context) error {
	var req createRoomReq
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid body")
	}
	if req.PlayerName == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "player_name required")
	}
	room, host, err := s.p2p.mgr.CreateRoom(req.PlayerName)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.JSON(http.StatusOK, createRoomRes{
		RoomCode: room.Code,
		RoomID:   room.ID,
		PlayerID: host.ID,
		IsHost:   true,
	})
}

// joinRoomReq / joinRoomRes power POST /api/rooms/:code/join. This
// endpoint is documented in the plan's PR 5 work (T5.5), but we ship
// it now so the PR 3 debug page can register a second player without
// reaching into internals. Behaviour is intentionally minimal.
type joinRoomReq struct {
	PlayerName string `json:"player_name"`
}
type joinRoomRes struct {
	RoomID   string `json:"room_id"`
	HostID   string `json:"host_id"`
	PlayerID string `json:"player_id"`
}

func (s *Server) handleJoinRoom(c echo.Context) error {
	var req joinRoomReq
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid body")
	}
	if req.PlayerName == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "player_name required")
	}
	room, err := s.p2p.mgr.LookupByCode(c.Param("code"))
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "room not found")
	}
	stub, err := s.p2p.mgr.RegisterPlayer(room.ID, req.PlayerName)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.JSON(http.StatusOK, joinRoomRes{
		RoomID:   room.ID,
		HostID:   room.HostID,
		PlayerID: stub.ID,
	})
}

type lookupRoomRes struct {
	RoomID          string `json:"room_id"`
	HostID          string `json:"host_id"`
	Exists          bool   `json:"exists"`
	Started         bool   `json:"started"`
	SnapshotVersion int    `json:"snapshot_version"`
}

func (s *Server) handleLookupRoom(c echo.Context) error {
	code := c.Param("code")
	room, err := s.p2p.mgr.LookupByCode(code)
	if err != nil {
		return c.JSON(http.StatusOK, lookupRoomRes{Exists: false})
	}
	return c.JSON(http.StatusOK, lookupRoomRes{
		RoomID:          room.ID,
		HostID:          room.HostID,
		Exists:          true,
		Started:         room.Started,
		SnapshotVersion: room.SnapshotVersion,
	})
}

// handleSignalWS upgrades a connection for /api/signal?room=...&player=...
// and pumps messages between the client and the signaling hub.
func (s *Server) handleSignalWS(c echo.Context) error {
	roomID := c.QueryParam("room")
	playerID := c.QueryParam("player")
	if roomID == "" || playerID == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "room and player required")
	}
	room, err := s.p2p.mgr.LookupByID(roomID)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "room not found")
	}
	// validate player is in the roster (registered via POST /rooms or
	// joined via a future endpoint — for now require either is-host or
	// matches an existing stub).
	known := false
	var name string
	var isHost bool
	for _, p := range room.Players {
		if p.ID == playerID {
			known = true
			name = p.Name
			isHost = p.ID == room.HostID
			break
		}
	}
	if !known {
		return echo.NewHTTPError(http.StatusForbidden, "unknown player")
	}

	if _, err := signal.ServeWs(s.p2p.hub, c.Response().Writer, c.Request(), playerID, roomID); err != nil {
		return err
	}
	// announce join to the rest of the room
	joinEnv := signal.Envelope{
		Type:     signal.EnvPeerJoined,
		PlayerID: playerID,
		Name:     name,
		IsHost:   isHost,
	}
	if b, err := json.Marshal(joinEnv); err == nil {
		s.p2p.hub.BroadcastRoom <- signal.RoomBroadcastMessage{RoomID: roomID, Message: b}
	}
	return nil
}

// rolesReq is the body of POST /api/rooms/:id/roles. The host submits
// the connected player list + the current pool (server merges on first
// sight; subsequent calls extend with any late words).
type rolesReq struct {
	PlayerID         string             `json:"player_id"`
	RoundIndex       int                `json:"round_index"`
	ConnectedPlayers []string           `json:"connected_players"`
	Pool             []rooms.PoolEntry  `json:"pool"`
}

func (s *Server) handleDrawRoles(c echo.Context) error {
	var req rolesReq
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid body")
	}
	roomID := c.Param("id")
	res, err := s.p2p.mgr.Draw(roomID, req.PlayerID, req.RoundIndex, req.ConnectedPlayers, req.Pool)
	if err != nil {
		switch {
		case errors.Is(err, rooms.ErrRoomNotFound):
			return echo.NewHTTPError(http.StatusNotFound, err.Error())
		case errors.Is(err, rooms.ErrNotHost):
			return echo.NewHTTPError(http.StatusForbidden, err.Error())
		case errors.Is(err, rooms.ErrPoolExhausted):
			return echo.NewHTTPError(http.StatusConflict, err.Error())
		case errors.Is(err, rooms.ErrNoPlayers):
			return echo.NewHTTPError(http.StatusBadRequest, err.Error())
		default:
			return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
		}
	}
	// DM each assignment to the right player over the signaling WS.
	// Host receives its own assignment too. The envelope is intentionally
	// minimal — the host can read it (see §8.3 leak); sealed envelopes
	// come later.
	for pid, a := range res.Assignments {
		env := signal.Envelope{
			Type:     signal.EnvYourRole,
			To:       pid,
			RoundIdx: res.RoundIndex,
			RolePayload: &signal.RolePayload{
				IsFake:     a.IsFake,
				Word:       a.Word,
				Commitment: res.FakeIDCommitment,
				Round:      res.RoundIndex,
			},
		}
		_ = s.p2p.hub.RouteByPlayer(roomID, pid, env)
	}
	return c.JSON(http.StatusOK, res)
}

func (s *Server) handleReveal(c echo.Context) error {
	roomID := c.Param("id")
	roundStr := c.Param("round")
	round, err := strconv.Atoi(roundStr)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "round must be int")
	}
	rev, err := s.p2p.mgr.Reveal(roomID, round)
	if err != nil {
		switch {
		case errors.Is(err, rooms.ErrRoomNotFound), errors.Is(err, rooms.ErrUnknownRound):
			return echo.NewHTTPError(http.StatusNotFound, err.Error())
		default:
			return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
		}
	}
	return c.JSON(http.StatusOK, rev)
}

// snapReq mirrors plan §3.5: host pushes full sanitized state + log tail.
type snapReq struct {
	PlayerID         string          `json:"player_id"`
	Version          int             `json:"version"`
	State            json.RawMessage `json:"state"`
	LogTailFromIndex int             `json:"log_tail_from_index"`
	LogTail          json.RawMessage `json:"log_tail"`
}

func (s *Server) handleSaveSnap(c echo.Context) error {
	var req snapReq
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid body")
	}
	roomID := c.Param("id")
	room, err := s.p2p.mgr.LookupByID(roomID)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, err.Error())
	}
	if req.PlayerID != room.HostID {
		return echo.NewHTTPError(http.StatusForbidden, "not host")
	}
	cp := rooms.Checkpoint{
		Version:          req.Version,
		State:            req.State,
		LogTailFromIndex: req.LogTailFromIndex,
		LogTail:          req.LogTail,
	}
	if err := s.p2p.mgr.SaveCheckpoint(context.Background(), roomID, cp); err != nil {
		return echo.NewHTTPError(http.StatusConflict, err.Error())
	}
	return c.NoContent(http.StatusNoContent)
}

func (s *Server) handleLoadSnap(c echo.Context) error {
	roomID := c.Param("id")
	cp, err := s.p2p.mgr.LoadCheckpoint(context.Background(), roomID)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, err.Error())
	}
	return c.JSON(http.StatusOK, cp)
}

// claimHostReq carries the (version, last_stroke_index) tuple the
// server uses to arbitrate racing claims (plan §7).
type claimHostReq struct {
	PlayerID        string `json:"player_id"`
	Version         int    `json:"version"`
	LastStrokeIndex int    `json:"last_stroke_index"`
}
type claimHostRes struct {
	Endorsed        bool   `json:"endorsed"`
	HostID          string `json:"host_id"`
	Version         int    `json:"version"`
	LastStrokeIndex int    `json:"last_stroke_index"`
}

func (s *Server) handleClaimHost(c echo.Context) error {
	var req claimHostReq
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid body")
	}
	roomID := c.Param("id")
	hostID, ver, lastIdx, endorsed, err := s.p2p.mgr.ClaimHost(roomID, req.PlayerID, req.Version, req.LastStrokeIndex)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, err.Error())
	}
	if endorsed {
		// Notify the room so any other clients refresh their host view.
		env := signal.Envelope{Type: signal.EnvHostChanged, PlayerID: hostID}
		if b, err := json.Marshal(env); err == nil {
			s.p2p.hub.BroadcastRoom <- signal.RoomBroadcastMessage{RoomID: roomID, Message: b}
		}
		return c.JSON(http.StatusOK, claimHostRes{Endorsed: true, HostID: hostID, Version: ver, LastStrokeIndex: lastIdx})
	}
	// Loser path: surface the running-best tuple so the client can
	// demote with full context (plan §7.2 step 6 — 409 + best tuple).
	return c.JSON(http.StatusConflict, claimHostRes{Endorsed: false, HostID: hostID, Version: ver, LastStrokeIndex: lastIdx})
}

// p2pRouter is the per-message dispatcher for inbound signaling
// envelopes. It runs in its own goroutine so the hub loop stays
// snappy. The router validates the From stamp and rewrites To-routed
// envelopes via RouteByPlayer.
func (s *Server) runSignalRouter() {
	for in := range s.p2p.hub.Inbound {
		var env signal.Envelope
		if err := json.Unmarshal(in.Message, &env); err != nil {
			continue
		}
		// stamp From server-side; clients can't spoof at this layer.
		env.From = in.Client.PlayerID

		switch env.Type {
		case signal.EnvSDPOffer, signal.EnvSDPAnswer, signal.EnvICE:
			if env.To == "" {
				continue
			}
			_ = s.p2p.hub.RouteByPlayer(in.Client.RoomID, env.To, env)
		case signal.EnvRelay:
			// T9.1: server-relay fallback. Forward the opaque DC
			// envelope to env.To. Server stays dumb — no inspection.
			if env.To == "" {
				continue
			}
			_ = s.p2p.hub.RouteByPlayer(in.Client.RoomID, env.To, env)
		case signal.EnvBye:
			leaveEnv := signal.Envelope{Type: signal.EnvPeerLeft, PlayerID: in.Client.PlayerID}
			if b, err := json.Marshal(leaveEnv); err == nil {
				s.p2p.hub.BroadcastRoom <- signal.RoomBroadcastMessage{RoomID: in.Client.RoomID, Message: b}
			}
		case signal.EnvHello:
			// HELLO is purely a presence ping — bind is already done at
			// upgrade time. Nothing to do here; existing PEER_JOINED
			// broadcast suffices.
		default:
			// unknown frame: drop silently. Server stays dumb.
		}
	}
}
