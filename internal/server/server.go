package server

import (
	"context"
	"log"
	"net/http"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	"github.com/sergiom/fakeartist/internal/rooms"
	"github.com/sergiom/fakeartist/internal/signal"
)

type Server struct {
	echo     *echo.Echo
	renderer *Renderer
	cfg      Config
	p2p      *p2pDeps // nil unless cfg.P2PEnabled
}

// New constructs the server. The legacy GameManager wiring was removed
// in PR 10 — P2P is the only path. Callers can still pass P2PEnabled=false
// in tests to skip route registration; the runtime default is true.
func New(renderer *Renderer, cfg Config) *Server {
	e := echo.New()
	e.Use(middleware.Logger())
	e.Use(middleware.Recover())
	return &Server{
		echo:     e,
		renderer: renderer,
		cfg:      cfg,
	}
}

// EnableP2P attaches the signaling hub + rooms manager. Must be called
// before Start. Idempotent.
func (s *Server) EnableP2P(store rooms.Storage) {
	if s.p2p != nil {
		return
	}
	hub := signal.NewHub()
	go hub.Run()
	mgr := rooms.NewManager(store)
	if s.cfg.GCIdleTTL > 0 {
		mgr.IdleTTL = s.cfg.GCIdleTTL
	}
	if s.cfg.GCFinishedGrace > 0 {
		mgr.FinishedGrace = s.cfg.GCFinishedGrace
	}
	if s.cfg.GCSweepInterval > 0 {
		mgr.SweepInterval = s.cfg.GCSweepInterval
	}
	// When a room is reaped, close any still-open WS sessions so the
	// hub doesn't carry orphaned per-connection buffers/goroutines.
	// Non-blocking send: if the hub's CloseRoom buffer is full, the
	// next sweep tick will retry — better than stalling the sweeper.
	mgr.OnRoomDeleted = func(roomID string) {
		select {
		case hub.CloseRoom <- roomID:
		default:
			log.Printf("P2P: CloseRoom buffer full, dropped close for %s", roomID)
		}
	}
	s.p2p = &p2pDeps{
		hub: hub,
		mgr: mgr,
	}
	go s.runSignalRouter()
	go mgr.StartGC(context.Background())
	log.Println("P2P: signaling hub started")
}

func (s *Server) Start(port string) error {
	// --- Routes ---

	// Static Assets
	s.echo.Static("/assets", "web/dist")

	// P2P routes — registered when the flag is on (default true post-PR 10).
	if s.cfg.P2PEnabled && s.p2p != nil {
		s.echo.POST("/api/rooms", s.handleCreateRoom)
		s.echo.GET("/api/rooms/:code", s.handleLookupRoom)
		s.echo.POST("/api/rooms/:code/join", s.handleJoinRoom)
		s.echo.GET("/api/signal", s.handleSignalWS)

		// PR 6 — server-side role draw + reveal.
		s.echo.POST("/api/rooms/:id/roles", s.handleDrawRoles)
		s.echo.GET("/api/rooms/:id/reveal/:round", s.handleReveal)

		// PR 7 — checkpoints + cold-boot claim-host.
		s.echo.POST("/api/rooms/:id/snap", s.handleSaveSnap)
		s.echo.GET("/api/rooms/:id/snap", s.handleLoadSnap)
		s.echo.POST("/api/rooms/:id/claim-host", s.handleClaimHost)
	}

	// SSR Handler (Catch All)
	s.echo.GET("/*", func(c echo.Context) error {
		path := c.Request().URL.Path
		// Skip assets or known API paths just in case
		if path == "/favicon.ico" {
			return c.NoContent(http.StatusNotFound)
		}

		// Initial State (Empty for now, or could have Game Config)
		initialState := map[string]any{}

		html, err := s.renderer.Render(path, initialState)
		if err != nil {
			c.Logger().Errorf("SSR Error: %v", err)
			return c.String(http.StatusInternalServerError, err.Error())
		}

		// Render Base Template
		return c.HTML(http.StatusOK, html)
	})

	return s.echo.Start(":" + port)
}
