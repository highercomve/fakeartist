package dao

import (
	"context"

	"github.com/sergiom/fakeartist/internal/game"
	"github.com/sergiom/fakeartist/internal/storage"
)

// GameDAO implements the storage logic using a generic Driver
type GameDAO struct {
	driver storage.Driver
}

func NewGameDAO(driver storage.Driver) *GameDAO {
	return &GameDAO{driver: driver}
}

func (dao *GameDAO) SaveGameState(ctx context.Context, state *game.GameState) error {
	return dao.driver.Save("gamestate", state.ID, state)
}

func (dao *GameDAO) LoadGameState(ctx context.Context, id string) (*game.GameState, error) {
	var state game.GameState
	if err := dao.driver.Load("gamestate", id, &state); err != nil {
		return nil, err
	}
	return &state, nil
}

func (dao *GameDAO) DeleteGameState(ctx context.Context, id string) error {
	return dao.driver.Delete("gamestate", id)
}
