package service

import (
	"context"
	"log"
	"time"

	"github.com/basketikun/infinite-canvas/repository"
)

const canvasSaveRequestRetention = 24 * time.Hour

func CleanupExpiredCanvasSaveRequests(current time.Time) error {
	return repository.DeleteCanvasSaveRequestsBefore(current.UTC().Add(-canvasSaveRequestRetention).Format(time.RFC3339Nano))
}

func StartCanvasSaveRequestRetention(ctx context.Context) func() {
	if err := CleanupExpiredCanvasSaveRequests(time.Now()); err != nil {
		log.Printf("canvas save request cleanup failed: %v", err)
	}
	stop := make(chan struct{})
	go func() {
		ticker := time.NewTicker(24 * time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-stop:
				return
			case current := <-ticker.C:
				if err := CleanupExpiredCanvasSaveRequests(current); err != nil {
					log.Printf("canvas save request cleanup failed: %v", err)
				}
			}
		}
	}()
	return func() { close(stop) }
}
