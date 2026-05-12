package storage

import (
	"database/sql"
	"encoding/json"
	"fmt"

	_ "github.com/glebarez/go-sqlite" // Register sqlite driver
)

type SQLiteDriver struct {
	db *sql.DB
}

func NewSQLiteDriver(path string) (*SQLiteDriver, error) {
	if path == "" {
		path = "./fakeartist.db"
	}

	// Open database (creates file if not exists)
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("failed to open sqlite db: %w", err)
	}

	// Verify connection
	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("failed to ping sqlite db: %w", err)
	}

	// Create table
	// We use a generic 'objects' table if we want a true KV store,
	// OR we assume collection=table name, but SQLite doesn't let us dynamically create tables safely/easily in prep statements.
	// For this specific 'GameDriver' usage, we might be lazy and stick to 'gamestates' table or make it generic.
	// Let's make it generic: collection text, key text, value text.
	query := `CREATE TABLE IF NOT EXISTS store (
		collection TEXT,
		key TEXT,
		value TEXT NOT NULL,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		PRIMARY KEY (collection, key)
	);`
	if _, err := db.Exec(query); err != nil {
		return nil, fmt.Errorf("failed to create table: %w", err)
	}

	return &SQLiteDriver{db: db}, nil
}

func (s *SQLiteDriver) Save(collection, key string, v interface{}) error {
	data, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("failed to marshal data: %w", err)
	}

	// Upsert
	query := `INSERT INTO store (collection, key, value, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
			  ON CONFLICT(collection, key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP;`

	if _, err := s.db.Exec(query, collection, key, string(data)); err != nil {
		return fmt.Errorf("failed to save to sqlite: %w", err)
	}

	return nil
}

func (s *SQLiteDriver) Load(collection, key string, v interface{}) error {
	query := `SELECT value FROM store WHERE collection = ? AND key = ?`

	var data string
	err := s.db.QueryRow(query, collection, key).Scan(&data)
	if err != nil {
		if err == sql.ErrNoRows {
			return fmt.Errorf("record not found: %s/%s", collection, key)
		}
		return fmt.Errorf("failed to load from sqlite: %w", err)
	}

	if err := json.Unmarshal([]byte(data), v); err != nil {
		return fmt.Errorf("failed to unmarshal data: %w", err)
	}

	return nil
}

func (s *SQLiteDriver) Delete(collection, key string) error {
	query := `DELETE FROM store WHERE collection = ? AND key = ?`
	_, err := s.db.Exec(query, collection, key)
	return err
}

func (s *SQLiteDriver) Close() error {
	return s.db.Close()
}
