package storage

import (
	"context"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

type MongoDriver struct {
	client *mongo.Client
	db     *mongo.Database
}

func NewMongoDriver(dsn string) (*MongoDriver, error) {
	if dsn == "" {
		dsn = "mongodb://localhost:27017"
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	client, err := mongo.Connect(ctx, options.Client().ApplyURI(dsn))
	if err != nil {
		return nil, fmt.Errorf("failed to connect to mongo: %w", err)
	}

	// Check connection
	if err := client.Ping(ctx, nil); err != nil {
		return nil, fmt.Errorf("failed to ping mongo: %w", err)
	}

	db := client.Database("fakeartist")

	return &MongoDriver{
		client: client,
		db:     db,
	}, nil
}

func (s *MongoDriver) Save(collection, key string, v interface{}) error {
	// We might need to wrap 'v' to include 'key' if not present, but for now we assume 'v' writes itself.
	// Actually, for Mongo, if we want to query by ID, we need to ensure the ID is set.
	// But 'v' is an interface{}.
	// We can use the 'key' as the '_id' or a separate 'key' field.
	// Let's use 'key' field.

	// Create a wrapper struct or map to save?
	// If we save 'v' directly, we rely on bson tags.
	// But we need to filter by key.
	// Let's trust that the 'key' argument is what we filter on.
	// And we assume the collection exists.

	coll := s.db.Collection(collection)
	filter := bson.M{"id": key} // We standardize on "id" field for our app
	update := bson.M{"$set": v}
	opts := options.Update().SetUpsert(true)

	_, err := coll.UpdateOne(context.Background(), filter, update, opts)
	if err != nil {
		return fmt.Errorf("failed to save to mongo: %w", err)
	}
	return nil
}

func (s *MongoDriver) Load(collection, key string, v interface{}) error {
	coll := s.db.Collection(collection)
	filter := bson.M{"id": key}

	err := coll.FindOne(context.Background(), filter).Decode(v)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return fmt.Errorf("document not found: %s/%s", collection, key)
		}
		return fmt.Errorf("failed to load from mongo: %w", err)
	}
	return nil
}

func (s *MongoDriver) Delete(collection, key string) error {
	coll := s.db.Collection(collection)
	filter := bson.M{"id": key}
	_, err := coll.DeleteOne(context.Background(), filter)
	return err
}

func (s *MongoDriver) Close() error {
	return s.client.Disconnect(context.Background())
}
