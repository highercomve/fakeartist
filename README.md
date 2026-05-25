# Fake Artist 🎨

A real-time multiplayer port of **"A Fake Artist Goes to New York"** (Oink Games),
built with **Go** and **React**, with a shared word-pool twist inspired by
[Papelito](../papelito).

## 🎮 Game Overview

Each player submits a few words at the start of the game. Every round the
server picks one random word from the shared pool and one random **fake
artist**. All other players see the word; the fake sees only an `X`.

Players take turns drawing one continuous stroke on a shared canvas. After
two clockwise passes, everyone votes for who they think the fake is.

- If the fake gets the most votes, they get one chance to **guess** the word.
  Correct → fake wins the round. Wrong → artists win.
- If the fake isn't caught, they win the round.

First player to the configured target score wins the game.

### Key Features

- **Host-authoritative P2P** over WebRTC DataChannels (host SFU model)
- **Multi-room** support via short room codes
- **Touch-friendly drawing**: 1 finger draws, 2 fingers pinch-zoom and pan
- **Per-player random color** from a high-contrast palette
- **Session persistence**: rejoin after refresh / disconnect via stroke log + checkpoint
- **Host failover**: when the host disappears, peers elect a new host
  deterministically and resume the game from the last broadcast state
- **Server-relay fallback**: peers behind strict NATs that cannot
  establish a DC fall back to the signaling WS for game traffic
- **Anti-cheat**: pool words and the fake's identity never appear in the
  broadcast state — they travel only via server-DM (sealed envelopes
  are a deferred follow-up; see `PLAN_P2P.md` §8.3)

## 🛠 Tech Stack

- **Backend**: Go (Echo + Gorilla WebSocket) for signaling, room registry,
  role draw, checkpoints; pluggable JSON / SQLite / Mongo storage
- **Frontend**: React 18 SSR-rendered by Go via V8Go; bundled by ESBuild;
  `frontend/p2p/` is TypeScript (engine, replica, peer hub, transport)
- **Styling**: Bootstrap 5

## 🚀 Run

```bash
go run cmd/server/main.go
```

Then open <http://localhost:6060>.

### Environment

| Variable         | Default                        | Notes                                              |
|------------------|--------------------------------|----------------------------------------------------|
| `SERVER_PORT`    | `6060`                         |                                                    |
| `STORAGE_DRIVER` | `json`                         | `json`, `sqlite`, `mongo`                          |
| `STORAGE_PATH`   | _(driver default)_             |                                                    |
| `P2P_ENABLED`    | `true`                         | Set `false` to skip P2P route registration in tests |

Snapshot retention is hardcoded to 24h (see `internal/rooms/manager.go`).
The client uses Google's public STUN server (`stun.l.google.com:19302`).
Self-hosted **coturn** is a future optimization — peers behind strict
NATs currently fall back to the signaling WS as a relay.

## 🐳 Docker

```bash
docker build -t fakeartist-server .
docker run -p 6060:6060 -v ${PWD}/data:/app/data fakeartist-server
```

## 📦 Layout

```
cmd/server          entrypoint
internal/bundler    esbuild wrapper
internal/server     Echo + V8 SSR + P2P HTTP handlers
internal/signal     WebRTC signaling hub + envelope router
internal/rooms      room registry, role draw, checkpoint persistence
internal/storage    json / sqlite / mongo drivers
frontend            React components + SSR entry
frontend/p2p        TypeScript: engine, replica, peerHub, transport,
                    log, checkpoint, election, crypto
```

## 📄 License

[MIT](LICENSE)
