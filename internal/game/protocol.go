package game

type CommandType string

const (
	CmdJoinGame        CommandType = "JOIN_GAME"
	CmdConfigureGame   CommandType = "CONFIGURE_GAME"
	CmdSubmitWords     CommandType = "SUBMIT_WORDS"
	CmdStartGame       CommandType = "START_GAME"
	CmdStartRound      CommandType = "START_ROUND"
	CmdSubmitStroke    CommandType = "SUBMIT_STROKE"
	CmdCastVote        CommandType = "CAST_VOTE"
	CmdSubmitFakeGuess CommandType = "SUBMIT_FAKE_GUESS"
	CmdNextRound       CommandType = "NEXT_ROUND"
	CmdEndGame         CommandType = "END_GAME"
)

type IncomingMessage struct {
	Type    CommandType `json:"type"`
	Payload interface{} `json:"payload"`
}

type JoinGamePayload struct {
	ID         string `json:"id"`
	PlayerName string `json:"player_name"`
	RoomCode   string `json:"room_code"`
}

type GameConfigPayload struct {
	WordsPerPlayer   int `json:"words_per_player"`
	TargetScore      int `json:"target_score"`
	StrokesPerArtist int `json:"strokes_per_artist"`
	MinPlayers       int `json:"min_players"`
	TurnDuration     int `json:"turn_duration"`
}

type SubmitWordsPayload struct {
	Words []string `json:"words"`
}

type SubmitStrokePayload struct {
	Points []Point `json:"points"`
}

type CastVotePayload struct {
	SuspectID string `json:"suspect_id"`
}

type SubmitFakeGuessPayload struct {
	Guess string `json:"guess"`
}

// Outgoing
type OutgoingMessageType string

const (
	MsgStateUpdate   OutgoingMessageType = "STATE_UPDATE"
	MsgPlayerWelcome OutgoingMessageType = "PLAYER_WELCOME"
	MsgYourRole      OutgoingMessageType = "YOUR_ROLE"
	MsgStrokeAdded   OutgoingMessageType = "STROKE_ADDED"
	MsgError         OutgoingMessageType = "ERROR"
)

type OutgoingMessage struct {
	Type    OutgoingMessageType `json:"type"`
	Payload interface{}         `json:"payload"`
}

type PlayerWelcomePayload struct {
	ID string `json:"id"`
}

type YourRolePayload struct {
	IsFake bool   `json:"is_fake"`
	Word   string `json:"word,omitempty"` // omitted for fake
}

type StrokeAddedPayload struct {
	Stroke      Stroke `json:"stroke"`
	StrokeIndex int    `json:"stroke_index"`
}

type ErrorPayload struct {
	Message string `json:"message"`
}
