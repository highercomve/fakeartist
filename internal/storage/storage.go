package storage

import "errors"

// Driver defines the low-level CRUD operations for storage backends
type Driver interface {
	Save(collection, key string, v any) error
	Load(collection, key string, v any) error
	Delete(collection, key string) error
	Close() error
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
