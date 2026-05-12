package game

import "time"

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

type RoundOutcome string

const (
	OutcomePending    RoundOutcome = ""
	OutcomeFakeWon    RoundOutcome = "FAKE_WON"
	OutcomeArtistsWon RoundOutcome = "ARTISTS_WON"
)

type GameConfig struct {
	WordsPerPlayer   int `json:"words_per_player"`
	TargetScore      int `json:"target_score"`
	StrokesPerArtist int `json:"strokes_per_artist"`
	MinPlayers       int `json:"min_players"`
	TurnDuration     int `json:"turn_duration"` // seconds; 0 = no limit
}

type Player struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Color        string `json:"color"`
	IsAdmin      bool   `json:"is_admin"`
	Connected    bool   `json:"connected"`
	HasSubmitted bool   `json:"has_submitted"`
	Score        int    `json:"score"`
}

type WordCard struct {
	ID       string `json:"id"`
	Word     string `json:"word,omitempty"` // STRIPPED in broadcast
	AuthorID string `json:"author_id"`
	Used     bool   `json:"used"`
}

type Point struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type Stroke struct {
	PlayerID string  `json:"player_id"`
	Color    string  `json:"color"`
	Points   []Point `json:"points"`
}

type Round struct {
	Index        int               `json:"index"`
	CardID       string            `json:"card_id,omitempty"`       // STRIPPED until summary
	FakeID       string            `json:"fake_id,omitempty"`       // STRIPPED until summary
	TurnOrder    []string          `json:"turn_order"`
	StrokeIndex  int               `json:"stroke_index"`            // 0 .. 2N-1
	Strokes      []Stroke          `json:"strokes"`
	Votes        map[string]string `json:"votes,omitempty"`         // STRIPPED until summary
	VotesCast    int               `json:"votes_cast"`              // count only during voting
	FakeGuess    string            `json:"fake_guess,omitempty"`    // STRIPPED until summary
	Outcome      RoundOutcome      `json:"outcome,omitempty"`
	RevealedWord string            `json:"revealed_word,omitempty"` // only in summary
}

type GameState struct {
	ID           string     `json:"id"`
	HostID       string     `json:"host_id"`
	Status       GameStatus `json:"status"`
	Players      []*Player  `json:"players"`
	Pool         []WordCard `json:"pool"`     // sanitized: Word stripped
	PoolSize     int        `json:"pool_size"`
	CurrentRound *Round     `json:"current_round"`
	Config       GameConfig `json:"config"`
	Winner       *Player    `json:"winner,omitempty"`

	LastActivity time.Time `json:"-"`
}

// ColorPalette is a high-contrast, colorblind-friendlier palette.
// 10 entries to match max player count.
var ColorPalette = []string{
	"#E53935", // red
	"#1E88E5", // blue
	"#43A047", // green
	"#FB8C00", // orange
	"#8E24AA", // purple
	"#00ACC1", // cyan
	"#FDD835", // yellow
	"#6D4C41", // brown
	"#EC407A", // pink
	"#212121", // black
}
