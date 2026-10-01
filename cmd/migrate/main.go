package main

import (
	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/repository"
	"log"
)

func main() {
	if err := config.Load(); err != nil {
		log.Fatal("migration configuration is invalid")
	}
	if err := repository.MigrateDatabase(); err != nil {
		log.Fatal("database migration failed; check app schema and migration compatibility")
	}
	if _, err := repository.PromoteLegacyCanvasTemporaryMedia(); err != nil {
		log.Fatal("legacy media compatibility migration failed")
	}
}
