package repository

import (
	"sync"
	"testing"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/internal/testpostgres"
)

func useRepositoryTestDB(t *testing.T, cfg config.Config, skipMigration ...bool) {
	t.Helper()
	if err := closeRepositoryTestDB(); err != nil {
		t.Fatalf("close previous repository database: %v", err)
	}
	previousConfig := config.Cfg
	config.Cfg = cfg
	if len(skipMigration) == 0 || !skipMigration[0] {
		if err := MigrateDatabase(); err != nil {
			t.Fatalf("migrate test schema: %v", err)
		}
	}
	t.Cleanup(func() {
		if err := closeRepositoryTestDB(); err != nil {
			t.Errorf("close repository test database: %v", err)
		}
		config.Cfg = previousConfig
	})
}

func newRepositoryTestConfig(t *testing.T, prefix string) config.Config {
	t.Helper()
	schema, err := testpostgres.NewSchema(prefix)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := schema.Close(); err != nil {
			t.Errorf("drop repository test schema: %v", err)
		}
	})
	return config.Config{DatabaseDSN: schema.DSN}
}

func closeRepositoryTestDB() error {
	var closeErr error
	if db != nil {
		sqlDB, err := db.DB()
		if err != nil {
			closeErr = err
		} else {
			closeErr = sqlDB.Close()
		}
	}
	db = nil
	dbErr = nil
	dbOnce = sync.Once{}
	return closeErr
}
