package server

// Config carries server-wide knobs sourced from env in cmd/server.
// Keep this struct tiny; cross-cutting feature flags only.
type Config struct {
	// P2PEnabled gates the host-authoritative P2P stack (signaling WS,
	// rooms HTTP API, etc.). Defaults to true since PR 10 (T10.2). The
	// env var still exists so tests can set P2P_ENABLED=false to skip
	// route registration when exercising pure SSR code paths.
	P2PEnabled bool
}
