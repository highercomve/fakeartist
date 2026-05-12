# Fake Artist — Implementation Plan

Web port of **"A Fake Artist Goes to New York"** (Oink Games) with a
shared word-pool twist inspired by Papelito.

Sibling project to `../papelito`. Reuses the same Go + React (SSR) +
WebSocket architecture verbatim wherever the gameplay does not differ.

---

## 1. Game Rules (this variant)

Original rules: <https://www.ultraboardgames.com/a-fake-artist-goes-to-new-york/game-rules.php>

Differences from the boxed game:

- **No Question Master.** The word pool replaces the QM.
- **Pre-game writing phase** (mirrors Papelito): each player submits
  `WordsPerPlayer` words into a shared pool.
- **Per round** the server picks one random unused word from the pool
  and one random player as the *fake*.
  - Every non-fake player receives the word.
  - The fake player receives only an `X` marker — no word, no theme.
- **Drawing**: clockwise turn order; each artist draws one continuous
  stroke per turn; two passes total → `2 × N` strokes per round.
- **Voting**: simultaneous private vote, revealed when last vote lands.
- **Caught fake guess**: if the fake gets the most votes they get one
  attempt to type the word. Correct → fake wins the round. Wrong →
  artists win.
- **Not caught**: fake wins the round.
- **Scoring** per round:
  - Fake caught + wrong guess → each artist `+1`
  - Fake caught + correct guess → fake `+2`
  - Fake not caught → fake `+1`
- First player to `TargetScore` (default 5) wins the game.

Min players: 4. Max: 10.

---

## 2. Architecture (mirror Papelito)

Identical layout. Module path: `github.com/sergiom/fakeartist`.

```
fakeartist/
├── cmd/server/main.go          # entrypoint (copy verbatim)
├── Dockerfile                  # copy verbatim
├── docker-compose.yml          # copy verbatim, retag image
├── go.mod / go.sum             # rename module
├── package.json                # rename "name"
├── internal/
│   ├── bundler/                # copy verbatim (esbuild + polyfills)
│   ├── server/                 # copy verbatim (Echo + V8 SSR renderer)
│   ├── storage/                # copy verbatim (json/sqlite/mongo)
│   ├── dao/                    # copy verbatim (generic over GameState)
│   └── game/
│       ├── hub.go              # copy verbatim (Hub, BroadcastRoom, Direct)
│       ├── client.go           # copy verbatim (ws read/write pump)
│       ├── manager.go          # adapt: new default config
│       ├── models.go           # REWRITE for fake-artist state
│       ├── protocol.go         # REWRITE for new commands
│       └── session.go          # REWRITE for fake-artist FSM
└── frontend/
    ├── app.jsx                 # copy + retitle
    └── components/
        ├── App.jsx             # adapt router
        ├── Home.jsx            # copy verbatim
        ├── GameContext.jsx     # adapt: rename localStorage key, new commands
        ├── Lobby.jsx           # REWRITE (no teams)
        ├── WordInput.jsx       # adapt (bare words, no theme)
        ├── RoundAnnounce.jsx   # adapt
        ├── DrawCanvas.jsx      # NEW
        ├── RoleReveal.jsx      # NEW
        ├── Voting.jsx          # NEW
        ├── FakeGuess.jsx       # NEW
        ├── RoundSummary.jsx    # adapt (outcome + scoreboard)
        └── GameOver.jsx        # adapt (single winner)
```

Storage / DAO / hub / WebSocket pumps are domain-agnostic and are
reused without changes.

---

## 3. State Machine

```
LOBBY
  ↓ host: START_GAME
WRITING                      // collect words into Pool
  ↓ all players HasSubmitted
ROUND_ANNOUNCE               // server picks card + fake, DMs roles
  ↓ host: NEXT (or auto-timer)
DRAWING                      // 2*N strokes, clockwise
  ↓ stroke count reached
VOTING                       // private votes; reveal on last
  ↓ all voted
FAKE_GUESS  (only if fake was voted-out)
  ↓ guess submitted
ROUND_SUMMARY                // reveal word + fake + outcome + scores
  ↓ host: NEXT_ROUND
ROUND_ANNOUNCE  | GAME_OVER  // GAME_OVER if winner reached TargetScore
                             //   or pool exhausted
```

---

## 4. Data Model

```go
type GameStatus string

const (
    StatusLobby         GameStatus = "LOBBY"
    StatusWriting       GameStatus = "WRITING"
    StatusRoundAnnounce GameStatus = "ROUND_ANNOUNCE"
    StatusDrawing       GameStatus = "DRAWING"
    StatusVoting        GameStatus = "VOTING"
    StatusFakeGuess     GameStatus = "FAKE_GUESS"
    StatusRoundSummary  GameStatus = "ROUND_SUMMARY"
    StatusGameOver      GameStatus = "GAME_OVER"
)

type GameConfig struct {
    WordsPerPlayer   int  `json:"words_per_player"`     // default 3
    TargetScore      int  `json:"target_score"`         // default 5
    StrokesPerArtist int  `json:"strokes_per_artist"`   // default 2
    MinPlayers       int  `json:"min_players"`          // default 4
    TurnDuration     int  `json:"turn_duration"`        // seconds; 0 = no limit
}

type Player struct {
    ID           string `json:"id"`
    Name         string `json:"name"`
    Color        string `json:"color"`        // hex, random unique from palette
    IsAdmin      bool   `json:"is_admin"`
    Connected    bool   `json:"connected"`
    HasSubmitted bool   `json:"has_submitted"`
    Score        int    `json:"score"`
}

type WordCard struct {
    ID       string `json:"id"`
    Word     string `json:"word,omitempty"`   // STRIPPED in broadcast
    AuthorID string `json:"author_id"`
    Used     bool   `json:"used"`
}

type Stroke struct {
    PlayerID string  `json:"player_id"`
    Color    string  `json:"color"`
    Points   []Point `json:"points"`          // normalized 0..1
}

type Point struct {
    X float64 `json:"x"`
    Y float64 `json:"y"`
}

type RoundOutcome string

const (
    OutcomePending     RoundOutcome = ""
    OutcomeFakeWon     RoundOutcome = "FAKE_WON"
    OutcomeArtistsWon  RoundOutcome = "ARTISTS_WON"
)

type Round struct {
    Index       int               `json:"index"`
    CardID      string            `json:"card_id,omitempty"`   // STRIPPED until summary
    FakeID      string            `json:"fake_id,omitempty"`   // STRIPPED until summary
    TurnOrder   []string          `json:"turn_order"`
    StrokeIndex int               `json:"stroke_index"`        // 0..2N-1
    Strokes     []Stroke          `json:"strokes"`
    Votes       map[string]string `json:"votes"`               // voter → suspect; sanitized in voting
    VotesCast   int               `json:"votes_cast"`          // count only during voting
    FakeGuess   string            `json:"fake_guess,omitempty"`
    Outcome     RoundOutcome      `json:"outcome"`
    RevealedWord string           `json:"revealed_word,omitempty"` // only in summary
}

type GameState struct {
    ID           string     `json:"id"`
    HostID       string     `json:"host_id"`
    Status       GameStatus `json:"status"`
    Players      []*Player  `json:"players"`
    Pool         []WordCard `json:"pool"`                    // sanitized: Word stripped
    PoolSize     int        `json:"pool_size"`               // for UI progress
    CurrentRound *Round     `json:"current_round"`           // sanitized
    Config       GameConfig `json:"config"`
    LastActivity time.Time  `json:"-"`
}
```

---

## 5. Protocol

### Client → Server

| Command            | Payload                            |
|--------------------|------------------------------------|
| `JOIN_GAME`        | `{id?, player_name, room_code}`    |
| `CONFIGURE_GAME`   | `GameConfig`                       |
| `SUBMIT_WORDS`     | `{words: string[]}`                |
| `START_GAME`       | —                                  |
| `START_ROUND`      | — (host advance)                   |
| `SUBMIT_STROKE`    | `{points: Point[]}`                |
| `CAST_VOTE`        | `{suspect_id: string}`             |
| `SUBMIT_FAKE_GUESS`| `{guess: string}`                  |
| `NEXT_ROUND`       | — (host advance from summary)      |
| `END_GAME`         | —                                  |

### Server → Client

| Type             | Channel    | Payload                                                  |
|------------------|------------|----------------------------------------------------------|
| `STATE_UPDATE`   | room cast  | sanitized `GameState`                                    |
| `PLAYER_WELCOME` | direct     | `{id}`                                                   |
| `YOUR_ROLE`      | direct     | artists: `{word, is_fake:false}` / fake: `{is_fake:true}`|
| `STROKE_ADDED`   | room cast  | incremental `{stroke, stroke_index}`                     |
| `ERROR`          | direct     | `{message}`                                              |

---

## 6. Anti-Cheat Mechanism

A single hardened `BroadcastState` path that *never* puts secret state
on the wire. Same model applied here and back-ported into Papelito.

### Threat model

A malicious player opens DevTools and reads the WebSocket payload.
They must not be able to learn:

- The fake's identity before reveal.
- Words still in the pool (in Papelito: words still in the bowl).
- The word currently in play, unless they are an artist this round.
- Who voted for whom before the round ends.

### Mechanism

1. **Single sanitizer in `BroadcastState`.** All outbound state passes
   through `sanitizeForBroadcast(state)` which deep-copies and
   redacts secret fields. No code path may serialize `gs.State` directly.

2. **Server-only fields** carry the `json:"...,omitempty"` tag and are
   *always* zeroed in the sanitized copy:
   - `Pool[].Word` (replaced with `""`)
   - `CurrentRound.CardID`
   - `CurrentRound.FakeID`
   - `CurrentRound.Votes` (replaced with `nil` during `VOTING`;
     populated map only in `ROUND_SUMMARY`)
   - `CurrentRound.FakeGuess` (only in summary)
   - `CurrentRound.RevealedWord` (only in summary)

3. **Secrets travel via `Hub.Direct`** (already in the codebase), never
   via room broadcast:
   - `YOUR_ROLE` on round start, addressed to each player individually.
   - In Papelito: `YOUR_WORD` to active player only (already present).

4. **Vote privacy**:
   - During `VOTING`, the broadcast carries only `VotesCast` (a count).
   - The `Votes` map is only included in `ROUND_SUMMARY`.

5. **Outgoing stroke deltas** (`STROKE_ADDED`) carry only the new
   stroke — never the full secret state, never the fake's identity.

6. **Reveal points are explicit**:
   - `ROUND_SUMMARY` is the only state where word + fake + votes are
     in the broadcast payload.

### Test plan

For each game phase, a unit test asserts that the JSON of the
sanitized state does NOT contain the secret word string, the fake's
player ID, or any other artist's word that should be hidden, and DOES
contain them only in `ROUND_SUMMARY`.

---

## 7. Anti-Cheat Back-port into Papelito

Papelito currently sanitizes only `CurrentWord` while `StatusTurnActive`
is set (`internal/game/session.go:354-356`). The full `Bowl` and
`ActiveBowl` are still serialized in every `STATE_UPDATE`, exposing
every upcoming word to any player who opens DevTools.

### Changes

In `papelito/internal/game/session.go` `BroadcastState`:

- Build `sanitizedState` as a deep copy.
- Replace `sanitizedState.Bowl` with a slice of `Paper` whose `Text`
  field is `""` (keep `ID`, `AuthorID`, `Status` for UI counts).
- Apply the same redaction to `sanitizedState.ActiveBowl`.
- Keep current `CurrentWord` redaction during `StatusTurnActive`.
- Keep current `YOUR_WORD` direct message to the active player.

In `papelito/internal/game/models.go` `Paper`:

- Add `,omitempty` to `Text` so empty strings drop from the wire.

In `frontend/components/*`:

- Already does not display bowl contents to non-active players — no UI
  changes needed.
- Verify nothing on the client reads `paper.text` outside of
  `YOUR_WORD` and `RoundSummary`.

### Reveal at game end

Optionally, in `StatusGameOver` and `StatusRoundSummary`, allow full
words in the broadcast for the post-game recap. To be confirmed before
implementation.

---

## 8. Drawing Mechanics

- HTML5 `<canvas>` driven by **Pointer Events**
  (`pointerdown / pointermove / pointerup / pointercancel`).
  Pointer Events unify mouse, pen, and touch in a single handler —
  no separate `touchstart` path required, and works on iOS/Android.
- Canvas element receives `touch-action: none` (CSS) and
  `event.preventDefault()` in handlers so the browser does not scroll
  or pinch-zoom while drawing — we own all touch gestures.
- Capture the pointer with `setPointerCapture(event.pointerId)` on
  `pointerdown` so a stroke is not lost if the finger drifts off the
  canvas mid-stroke.
- Active player draws locally; on `pointerup` send `SUBMIT_STROKE`.
- Server validates `state.Status == DRAWING && active player`,
  appends to `Strokes`, increments `StrokeIndex`, broadcasts
  `STROKE_ADDED`.
- All clients render strokes from authoritative state — no optimistic
  local-only strokes (prevents desync, supports reconnect).
- Points are normalized to `[0,1]` in **canvas-world** coordinates
  (independent of zoom/pan view transform — see §8b).
- Auto-transition `DRAWING → VOTING` when
  `StrokeIndex == StrokesPerArtist * len(Players)`.

### 8a. Gesture modes (touch)

Two implicit modes, decided by active pointer count:

| Active pointers | Mode    | Behavior                              |
|-----------------|---------|---------------------------------------|
| 1               | DRAW    | Single-touch / mouse / pen drawing.   |
| 2               | NAV     | Pinch-zoom + two-finger pan the view. |
| ≥3              | NAV     | Ignored extra pointers, NAV continues.|

Rules:

- Mode is decided on `pointerdown`. If a second pointer lands while
  in DRAW, the active stroke is **cancelled** (local points dropped,
  no `SUBMIT_STROKE` sent) and the canvas enters NAV. The player
  must lift all fingers and restart to draw.
- Mouse and pen always behave as a single pointer → DRAW.
- Spectators (non-active artists this turn) can still NAV freely
  on their own view; their pointer events never reach the network.

### 8b. View transform (zoom / pan)

The canvas stores strokes in a fixed `[0,1]` **world** space. The
view applies a 2D affine transform `T = translate(tx,ty) · scale(s)`
that is **local to each client** (never sent over the network — every
viewer can zoom/pan independently).

- Pinch (2 pointers move, distance changes):
  - `s *= distance_new / distance_old`
  - Clamp `s ∈ [0.5, 8.0]`.
  - Adjust `(tx, ty)` so the **midpoint** of the two pointers stays
    under the same world point (anchor zoom on gesture center).
- Two-finger pan (2 pointers move, distance ~constant):
  - `(tx, ty) += midpoint_delta`. Falls out naturally from the
    pinch math when scale is unchanged.
- Mouse wheel (desktop): zoom anchored on cursor position.
- Double-tap or "Reset View" button: snap back to `s=1, tx=0, ty=0`.
- Pan bounds: clamp so at least a small margin of the world stays
  visible (prevent getting lost off-canvas).

Coordinate conversions, run on every input point:

```
// client (CSS px relative to canvas) → world (0..1)
world = (client - translate) / (scale * canvasCssSize)

// render strokes
ctx.setTransform(scale * dpr, 0, 0, scale * dpr,
                 translate.x * dpr, translate.y * dpr)
```

`dpr = window.devicePixelRatio` for crisp rendering on retina.

### 8c. UX details

- Show a small zoom indicator (e.g. `120%`) when not at 100%.
- Reset View button visible when `scale != 1 || translate != 0`.
- During the active player's turn, a subtle banner reminds:
  *"One finger to draw — two fingers to zoom and move."*
- On smaller screens the canvas fills available width; aspect ratio
  fixed (e.g. 4:3) so all clients render the same world consistently.

### Per-player color

- Each player gets a stable, **clearly distinct** color, **randomly**
  assigned at game start (lobby → start) from a fixed palette of
  high-contrast hues that are also distinguishable for the common
  red/green color-blindness cases.
- Suggested palette (10 slots, max 10 players):
  `#E53935` red, `#1E88E5` blue, `#43A047` green, `#FB8C00` orange,
  `#8E24AA` purple, `#00ACC1` cyan, `#FDD835` yellow, `#6D4C41` brown,
  `#EC407A` pink, `#212121` black.
- Algorithm: shuffle palette with crypto-strong RNG, pop one per
  player, store on `Player.Color`. Color persists for the whole game
  so vote/scoreboard UI references stay stable.
- New player joining after game start: assign the next unused color.
- Each stroke carries `player_id` + `color` so the canvas renders
  correctly even if a player disconnects.
- UI shows a legend: name chip with the player's color swatch +
  current-turn highlight.

---

## 9. Reconnect

Same pattern as Papelito:

- `localStorage` key `fakeartist_playerId`.
- `JOIN_GAME` with `id` reattaches player by ID.
- Server-side: re-bind client to player + room, resend `STATE_UPDATE`
  and, if the player is mid-round, resend `YOUR_ROLE`.

---

## 10. Build & Run

```bash
go run cmd/server/main.go            # port 6060 (override SERVER_PORT)
docker build -t fakeartist-server .
docker run -p 6060:6060 -v ${PWD}/data:/app/data fakeartist-server
```

Public image (future): `highercomve/fakeartist:latest`.

---

## 11. Work Order

1. Scaffold repo (copy reusable papelito files, rename module).
2. Implement `models.go`, `protocol.go`.
3. Implement `session.go` FSM round-by-round:
   1. Lobby + writing
   2. Round announce + role DM
   3. Drawing turn engine
   4. Voting + tally
   5. Fake guess
   6. Round summary + scoring
   7. Game over
4. Implement sanitizer + sanitizer unit tests.
5. Frontend: Lobby, WordInput, RoundAnnounce, RoleReveal.
6. Frontend: DrawCanvas.
7. Frontend: Voting, FakeGuess, RoundSummary, GameOver.
8. Manual end-to-end test with 4 browser tabs.
9. **Papelito anti-cheat back-port** + sanitizer unit test.
10. Dockerfile / docker-compose verification.
