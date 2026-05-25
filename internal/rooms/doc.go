// Package rooms owns the room registry (roomCode -> roomId, host, players)
// and the server-side authority for role assignment and snapshot
// persistence. It does not run the game loop — that lives in the host
// browser. The server treats GameState as an opaque blob for storage
// while parsing minimal fields for role draw eligibility.
package rooms
