package service

import (
	"context"
	"log"
	"time"

	"github.com/basketikun/infinite-canvas/repository"
)

const completedMediaUploadIntentRetention = 24 * time.Hour

// CleanupExpiredMediaUploadIntents removes unfinished expired uploads and the
// objects reserved for them. Completed rows are retained briefly for duplicate
// completion retries, then removed without touching their media objects.
func CleanupExpiredMediaUploadIntents(current time.Time) error {
	items, err := repository.ListExpiredUncompletedMediaUploadIntents(current.UTC().Format(time.RFC3339Nano))
	if err != nil {
		return err
	}
	store, err := newImageStore()
	if err != nil {
		return err
	}
	for _, item := range items {
		if err := deleteImageObject(context.Background(), store, item.ObjectKey); err != nil {
			return err
		}
		if err := repository.DeleteMediaUploadIntent(item.ID); err != nil {
			return err
		}
	}
	return repository.DeleteCompletedMediaUploadIntentsBefore(current.UTC().Add(-completedMediaUploadIntentRetention).Format(time.RFC3339Nano))
}

func StartMediaUploadIntentRetention(ctx context.Context) func() {
	if err := CleanupExpiredMediaUploadIntents(time.Now()); err != nil {
		log.Printf("media upload intent cleanup failed: %v", err)
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
				if err := CleanupExpiredMediaUploadIntents(current); err != nil {
					log.Printf("media upload intent cleanup failed: %v", err)
				}
			}
		}
	}()
	return func() { close(stop) }
}
