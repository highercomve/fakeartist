package storage

import (
	"errors"
	"os"
)

// Driver defines the low-level CRUD operations for storage backends
type Driver interface {
	Save(collection, key string, v interface{}) error
	Load(collection, key string, v interface{}) error
	Delete(collection, key string) error
	Close() error // Helper for cleanup
}

// NewDriver creates a storage backend driver instance
func NewDriver(driverName, path string) (Driver, error) {
	var d Driver
	var err error

	switch driverName {
	case "json":
		d, err = NewJSONDriver(path)
	case "sqlite":
		d, err = NewSQLiteDriver(path)
	case "mongo":
		d, err = NewMongoDriver(path)
	default:
		return nil, errors.New("unsupported storage driver: " + driverName)
	}

	if err != nil {
		return nil, err
	}
	return d, nil
}

// Ensure directory exists for file-based storage
func ensureDir(path string) error {
	if _, err := os.Stat(path); os.IsNotExist(err) {
		return os.MkdirAll(path, 0755)
	}
	return nil
}
