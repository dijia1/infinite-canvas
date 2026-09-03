package repository

import (
	"sync"
	"testing"

	"github.com/basketikun/infinite-canvas/config"
)

func useRepositoryTestDB(t *testing.T, cfg config.Config) {
	t.Helper()
	previousConfig := config.Cfg
	config.Cfg = cfg
	db = nil
	dbErr = nil
	dbOnce = sync.Once{}
	t.Cleanup(func() {
		config.Cfg = previousConfig
		db = nil
		dbErr = nil
		dbOnce = sync.Once{}
	})
}
