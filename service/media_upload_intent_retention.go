package service

import (
	"context"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/basketikun/infinite-canvas/repository"
)

// CleanupExpiredMediaUploadIntents removes unfinished expired uploads and the
// objects reserved for them. Completed rows are retained briefly for duplicate
// completion retries, then removed without touching their media objects.
func CleanupExpiredMediaUploadIntents(current time.Time) error {
	store, err := newImageStore()
	if err != nil {
		return err
	}
	return cleanupExpiredMediaUploadIntents(context.Background(), current, store)
}

func cleanupExpiredMediaUploadIntents(ctx context.Context, current time.Time, store imageStore) error {
	var failures []error
	after := ""
	for {
		items, err := repository.ListMediaUploadCleanupCandidates(current, after)
		if err != nil {
			return err
		}
		if len(items) == 0 {
			break
		}
		for _, item := range items {
			after = item.ID
			deleteCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
			err := cleanupMediaUploadIntent(deleteCtx, store, item.ID, current)
			cancel()
			if err != nil {
				failures = append(failures, fmt.Errorf("upload cleanup intent %s: %w", item.ID, err))
			}
		}
	}
	return errors.Join(failures...)
}

func StartMediaUploadIntentRetention(ctx context.Context) func() {
	if err := CleanupExpiredMediaUploadIntents(time.Now()); err != nil {
		log.Printf("media upload intent cleanup failed: %v", err)
	}
	stop := make(chan struct{})
	go func() {
		ticker := time.NewTicker(time.Minute)
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
