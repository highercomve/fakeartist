package signal

import (
	"encoding/json"
	"testing"
)

func TestEnvelopeRoundTrip(t *testing.T) {
	cases := []Envelope{
		{Type: EnvHello, Role: "host"},
		{Type: EnvSDPOffer, To: "p_abc", SDP: "v=0\r\n..."},
		{Type: EnvSDPAnswer, From: "p_xyz", To: "p_abc", SDP: "v=0\r\n..."},
		{Type: EnvICE, To: "p_abc", Candidate: json.RawMessage(`{"candidate":"foo"}`)},
		{Type: EnvBye},
		{Type: EnvPeerJoined, PlayerID: "p_abc", Name: "Sergio", IsHost: true},
		{Type: EnvPeerLeft, PlayerID: "p_abc"},
		{Type: EnvHostChanged, PlayerID: "p_new"},
		{Type: EnvError, Message: "boom"},
	}
	for _, c := range cases {
		b, err := json.Marshal(c)
		if err != nil {
			t.Fatalf("marshal %s: %v", c.Type, err)
		}
		var got Envelope
		if err := json.Unmarshal(b, &got); err != nil {
			t.Fatalf("unmarshal %s: %v", c.Type, err)
		}
		if got.Type != c.Type {
			t.Fatalf("type mismatch: got %q want %q", got.Type, c.Type)
		}
		if got.From != c.From || got.To != c.To || got.SDP != c.SDP ||
			got.PlayerID != c.PlayerID || got.Name != c.Name || got.IsHost != c.IsHost ||
			got.Message != c.Message || got.Role != c.Role {
			t.Fatalf("field mismatch for %s: %+v vs %+v", c.Type, got, c)
		}
	}
}

func TestEnvelopeRejectsMissingType(t *testing.T) {
	// Unknown type strings should not panic on unmarshal; we test only
	// that the type field round-trips through json without normalization.
	raw := []byte(`{"type":"UNKNOWN_THING","to":"x"}`)
	var got Envelope
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Type != "UNKNOWN_THING" {
		t.Fatalf("got %q", got.Type)
	}
}
