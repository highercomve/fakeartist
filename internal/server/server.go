package server

import (
	"net/http"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	"github.com/sergiom/fakeartist/internal/game"
)

type Server struct {
	echo     *echo.Echo
	renderer *Renderer
	gm       *game.GameManager
}

func New(gm *game.GameManager, renderer *Renderer) *Server {
	e := echo.New()
	e.Use(middleware.Logger())
	e.Use(middleware.Recover())

	return &Server{
		echo:     e,
		renderer: renderer,
		gm:       gm,
	}
}

func (s *Server) Start(port string) error {
	// --- Routes ---

	// Static Assets
	s.echo.Static("/assets", "web/dist")

	// WebSocket API
	s.echo.GET("/api/ws", func(c echo.Context) error {
		game.ServeWs(s.gm.Hub, c.Response().Writer, c.Request())
		return nil
	})

	// SSR Handler (Catch All)
	s.echo.GET("/*", func(c echo.Context) error {
		path := c.Request().URL.Path
		// Skip assets or known API paths just in case
		if path == "/favicon.ico" {
			return c.NoContent(http.StatusNotFound)
		}

		// Initial State (Empty for now, or could have Game Config)
		initialState := map[string]interface{}{}

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
