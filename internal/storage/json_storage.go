package storage

import (
	"fmt"
	"sync"

	scribble "github.com/nanobox-io/golang-scribble"
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

func (s *JSONDriver) Save(collection, key string, v any) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	err := s.db.Write(collection, key, v)
	if err != nil {
		return fmt.Errorf("failed to save to json: %w", err)
	}
	return nil
}

func (s *JSONDriver) Load(collection, key string, v any) error {
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
