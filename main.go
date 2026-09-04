package main

import (
	"context"
	"log"

	_ "github.com/basketikun/infinite-canvas/ai/providers"
	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/basketikun/infinite-canvas/router"
	"github.com/basketikun/infinite-canvas/service"
)

func main() {
	if err := config.Load(); err != nil {
		log.Fatal(err)
	}
	if _, err := repository.PromoteLegacyCanvasTemporaryMedia(); err != nil {
		log.Fatalf("migrate legacy canvas media: %v", err)
	}
	stopImageTasks, err := service.StartImageTaskWorker(context.Background())
	if err != nil {
		log.Fatal(err)
	}
	defer stopImageTasks()
	stopAuditRetention := service.StartOperationLogRetention(context.Background())
	defer stopAuditRetention()
	stopCanvasSaveRetention := service.StartCanvasSaveRequestRetention(context.Background())
	defer stopCanvasSaveRetention()
	stopMediaUploadIntentRetention := service.StartMediaUploadIntentRetention(context.Background())
	defer stopMediaUploadIntentRetention()
	log.Fatal(router.New().Run(":" + config.Cfg.Port))
}
