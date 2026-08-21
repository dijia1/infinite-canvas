package main

import (
	"log"

	_ "github.com/basketikun/infinite-canvas/ai/providers"
	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/router"
)

func main() {
	if err := config.Load(); err != nil {
		log.Fatal(err)
	}
	log.Fatal(router.New().Run(":" + config.Cfg.Port))
}
