package main

import (
	"context"
	"log"
	"time"

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
	log.Print("waiting for database before application initialization")
	databaseContext, cancelDatabaseWait := context.WithTimeout(context.Background(), 60*time.Second)
	databaseErr := repository.WaitForDatabase(databaseContext, config.Cfg.DatabaseDSN)
	cancelDatabaseWait()
	if databaseErr != nil {
		log.Fatal(databaseErr)
	}
	if _, err := repository.PromoteLegacyCanvasTemporaryMedia(); err != nil {
		log.Fatalf("migrate legacy canvas media: %v", err)
	}
	if err := service.InitializeApplicationRBAC(context.Background(), config.Cfg.AppRBACInitialAdminUIDs); err != nil {
		log.Fatal(err)
	}
	stopImageTasks, err := service.StartImageTaskWorker(context.Background())
	if err != nil {
		log.Fatal(err)
	}
	defer stopImageTasks()
	stopVideoTasks, err := service.StartVideoTaskWorker(context.Background())
	if err != nil {
		log.Fatal(err)
	}
	defer stopVideoTasks()
	stopWorkflowScheduler, err := service.StartWorkflowScheduler(context.Background())
	if err != nil {
		log.Fatal(err)
	}
	defer stopWorkflowScheduler()
	stopAuditRetention := service.StartOperationLogRetention(context.Background())
	defer stopAuditRetention()
	stopCanvasSaveRetention := service.StartCanvasSaveRequestRetention(context.Background())
	defer stopCanvasSaveRetention()
	stopMediaUploadIntentRetention := service.StartMediaUploadIntentRetention(context.Background())
	defer stopMediaUploadIntentRetention()
	stopCanvasMediaRetention := service.StartCanvasMediaRetention(context.Background())
	defer stopCanvasMediaRetention()
	log.Fatal(router.New().Run(":" + config.Cfg.Port))
}
