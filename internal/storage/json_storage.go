package storage

import (
	"encoding/json"
	"fmt"
	"sync"

	scribble "github.com/nanobox-io/golang-scribble"
	"github.com/sergiom/fakeartist/internal/game"
)

type JSONDriver struct {
	db *scribble.Driver
	mu sync.Mutex
}

func NewJSONDriver(path string) (*JSONDriver, error) {
	if path == "" {
		path = "./data"
	}
	// Scribble creates the dir automatically
	db, err := scribble.New(path, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create scribble driver: %w", err)
	}

	return &JSONDriver{
		db: db,
	}, nil
}

func (s *JSONDriver) Save(collection, key string, v interface{}) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	err := s.db.Write(collection, key, v)
	if err != nil {
		return fmt.Errorf("failed to save to json: %w", err)
	}
	return nil
}

func (s *JSONDriver) Load(collection, key string, v interface{}) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	err := s.db.Read(collection, key, v)
	if err != nil {
		return fmt.Errorf("failed to load from json: %w", err)
	}
	return nil
}

func (s *JSONDriver) Delete(collection, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	err := s.db.Delete(collection, key)
	if err != nil {
		return fmt.Errorf("failed to delete from json: %w", err)
	}
	return nil
}
func (s *JSONDriver) Close() error {
	return nil
}

// Manual LoadAll for listing? Not strictly required by interface but useful.
func (s *JSONDriver) LoadAllGameStates() ([]*game.GameState, error) {
	// Scribble ReadAll returns []string of json
	records, err := s.db.ReadAll("gamestate")
	if err != nil {
		return nil, err
	}

	var games []*game.GameState
	for _, r := range records {
		var state game.GameState
		if err := json.Unmarshal([]byte(r), &state); err == nil {
			games = append(games, &state)
		}
	}
	return games, nil
}
