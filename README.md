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

- **Real-time multiplayer** over WebSockets
- **Multi-room** support via short room codes
- **Touch-friendly drawing**: 1 finger draws, 2 fingers pinch-zoom and pan
- **Per-player random color** from a high-contrast palette
- **Session persistence**: rejoin after refresh / disconnect
- **Anti-cheat**: pool words and the fake's identity never appear in the
  broadcast state — they travel only over per-player direct messages

## 🛠 Tech Stack

- **Backend**: Go (Echo + Gorilla WebSocket); pluggable JSON / SQLite / Mongo storage
- **Frontend**: React 18 SSR-rendered by Go via V8Go; bundled by ESBuild
- **Styling**: Bootstrap 5

## 🚀 Run

```bash
go run cmd/server/main.go
```

Then open <http://localhost:6060>.

## 🐳 Docker

```bash
docker build -t fakeartist-server .
docker run -p 6060:6060 -v ${PWD}/data:/app/data fakeartist-server
```

## 📦 Layout

```
cmd/server          entrypoint
internal/bundler    esbuild wrapper
internal/server     Echo + V8 SSR
internal/storage    json / sqlite / mongo drivers
internal/dao        generic state save/load
internal/game       hub, client, models, protocol, session
frontend            React components + SSR entry
```

## 📄 License

[MIT](LICENSE)
