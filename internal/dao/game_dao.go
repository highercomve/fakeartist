// Package dao previously hosted the legacy GameDAO that wrapped a
// storage.Driver with game-specific helpers. Deleted in PR 10 of the
// P2P migration — see PLAN_P2P.md. The host-authoritative engine
// persists checkpoints via internal/rooms which talks to storage.Driver
// directly.
package dao
