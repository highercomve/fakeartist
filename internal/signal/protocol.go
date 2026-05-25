package signal

import "encoding/json"

// EnvelopeType is the discriminator for inbound and outbound signaling
// messages. Strings match the wire types in PLAN_P2P.md §3.5.
type EnvelopeType string

const (
	// Inbound (client -> server).
	EnvHello     EnvelopeType = "HELLO"
	EnvSDPOffer  EnvelopeType = "SDP_OFFER"
	EnvSDPAnswer EnvelopeType = "SDP_ANSWER"
	EnvICE       EnvelopeType = "ICE"
	EnvBye       EnvelopeType = "BYE"

	// Outbound (server -> client).
	EnvPeerJoined  EnvelopeType = "PEER_JOINED"
	EnvPeerLeft    EnvelopeType = "PEER_LEFT"
	EnvHostChanged EnvelopeType = "HOST_CHANGED"
	EnvError       EnvelopeType = "ERROR"

	// Outbound server-issued role envelope. Sent over the signaling WS
	// to the recipient via Direct routing. Carries the commitment
	// publicly (in the same frame) so the recipient can verify against
	// the reveal endpoint. See plan §8.3 — the host can still see this
	// frame in transit; sealed envelopes are deferred.
	EnvYourRole EnvelopeType = "YOUR_ROLE"

	// EnvRelay is the server-relay fallback frame for hosts/guests
	// behind NATs where ICE fails (plan §10). The payload is the
	// opaque DC envelope JSON; the server forwards it by To without
	// inspecting contents. Re-introduces server bandwidth for the
	// affected peer; full game flow remains host-authoritative.
	EnvRelay EnvelopeType = "RELAY"
)

// RolePayload is the typed body for YOUR_ROLE envelopes. Word is
// omitted for the fake.
type RolePayload struct {
	IsFake     bool   `json:"is_fake"`
	Word       string `json:"word,omitempty"`
	Commitment string `json:"commitment"`
	Round      int    `json:"round"`
}

// Envelope is the raw wire JSON. Fields not used by a given Type stay
// nil/empty. The hub never inspects SDP or ICE payloads; it routes by
// the To field and stamps From server-side so clients can't spoof.
type Envelope struct {
	Type      EnvelopeType    `json:"type"`
	From      string          `json:"from,omitempty"`
	To        string          `json:"to,omitempty"`
	Role      string          `json:"role,omitempty"` // HELLO: "host" | "guest"
	SDP       string          `json:"sdp,omitempty"`
	Candidate json.RawMessage `json:"candidate,omitempty"`
	PlayerID  string          `json:"player_id,omitempty"` // outbound
	Name      string          `json:"name,omitempty"`      // outbound
	IsHost    bool            `json:"is_host,omitempty"`   // outbound
	Message   string          `json:"message,omitempty"`   // ERROR

	// YOUR_ROLE fields. RoundIdx duplicates RolePayload.Round to keep
	// the frame self-describing at the routing layer.
	RoundIdx    int          `json:"round_index,omitempty"`
	RolePayload *RolePayload `json:"payload,omitempty"`

	// RELAY: opaque DC-envelope payload. Server forwards as-is. Use
	// json.RawMessage so we don't accidentally parse and re-serialize
	// game frames the server has no business interpreting.
	Envelope json.RawMessage `json:"envelope,omitempty"`
}

// EncodeEnvelope is a convenience for handlers that need to push JSON
// into the hub's []byte-oriented channels.
func EncodeEnvelope(e Envelope) ([]byte, error) {
	return json.Marshal(e)
}
